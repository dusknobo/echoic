"""Small, local English word WAVs; eSpeak state stays in a short-lived process."""
from collections import OrderedDict
import ctypes
import io
import logging
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import wave

logger = logging.getLogger(__name__)
_WORD = re.compile(r"[a-z]+(?:['-][a-z]+)*", re.ASCII)
_MAX_WAV_BYTES = 2 * 1024 * 1024
_CACHE_ENTRIES = 128
_CACHE_BYTES = 16 * 1024 * 1024
_cache: OrderedDict[str, bytes] = OrderedDict()
_cache_bytes = 0
_cache_lock = threading.Lock()
_slots = threading.BoundedSemaphore(2)
_assets_lock = threading.Lock()
_assets: tuple[str, str] | None = None


class WordSpeechUnavailable(RuntimeError):
    pass


class WordSpeechBusy(WordSpeechUnavailable):
    pass


def normalize_word(word: str) -> str:
    word = word.strip().replace("’", "'").lower()
    if not 1 <= len(word) <= 64 or _WORD.fullmatch(word) is None:
        raise ValueError("Enter one English word (up to 64 characters).")
    return word


def _speech_assets() -> tuple[str, str]:
    global _assets
    with _assets_lock:
        if _assets is None:
            import espeakng_loader
            library = espeakng_loader.get_library_path()
            data = Path(espeakng_loader.get_data_path())
            if os.name == "nt" and not str(data).isascii():
                # Match local_runtime's ASCII cache for eSpeak's C file API.
                cached = Path(tempfile.gettempdir()) / "Echoic-native" / "espeak-0.2.4" / "espeak-ng-data"
                if not (cached / "phondata").is_file() or not (cached / "en_dict").is_file():
                    shutil.copytree(data, cached, dirs_exist_ok=True)
                data = cached
            _assets = library, str(data)
        return _assets


def _validate_wav(data: bytes) -> None:
    if len(data) > _MAX_WAV_BYTES:
        raise WordSpeechUnavailable("Word audio exceeded the size limit.")
    try:
        with wave.open(io.BytesIO(data), "rb") as wav:
            if wav.getnchannels() != 1 or wav.getsampwidth() != 2:
                raise ValueError("invalid audio format")
            if not 8000 <= wav.getframerate() <= 48000 or not 0 < wav.getnframes() <= wav.getframerate() * 30:
                raise ValueError("invalid audio duration")
            if len(wav.readframes(wav.getnframes())) != wav.getnframes() * 2:
                raise ValueError("truncated audio")
    except (EOFError, ValueError, wave.Error) as exc:
        raise WordSpeechUnavailable("The local speech engine returned invalid audio.") from exc


def _render_word(word: str) -> bytes:
    library, data_path = _speech_assets()
    command = [sys.executable, "-X", "utf8", str(Path(__file__).resolve()), "--worker", word, library, data_path]
    try:
        completed = subprocess.run(
            command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            timeout=12, check=False,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise WordSpeechUnavailable("Local English pronunciation is temporarily unavailable.") from exc
    if completed.returncode != 0:
        # Do not expose platform paths or subprocess diagnostics to the browser.
        logger.warning("Local word speech exited with code %s", completed.returncode)
        raise WordSpeechUnavailable("Local English pronunciation is temporarily unavailable.")
    _validate_wav(completed.stdout)
    return completed.stdout


def english_word_wav(word: str) -> bytes:
    """Normalize one word and return a bounded, cached mono PCM WAV."""
    global _cache_bytes
    word = normalize_word(word)
    with _cache_lock:
        if word in _cache:
            _cache.move_to_end(word)
            return _cache[word]
    if not _slots.acquire(timeout=0.25):
        raise WordSpeechBusy("Local pronunciation is busy; please retry.")
    try:
        # Another request may have rendered it while this one waited.
        with _cache_lock:
            if word in _cache:
                _cache.move_to_end(word)
                return _cache[word]
        try:
            audio = _render_word(word)
        except WordSpeechUnavailable:
            raise
        except (ImportError, OSError, RuntimeError) as exc:
            raise WordSpeechUnavailable("Local English pronunciation is temporarily unavailable.") from exc
        with _cache_lock:
            previous = _cache.pop(word, None)
            if previous is not None:
                _cache_bytes -= len(previous)
            _cache[word] = audio
            _cache_bytes += len(audio)
            while len(_cache) > _CACHE_ENTRIES or _cache_bytes > _CACHE_BYTES:
                _, evicted = _cache.popitem(last=False)
                _cache_bytes -= len(evicted)
        return audio
    finally:
        _slots.release()


def _synthesize_in_process(word: str, library: str, data_path: str) -> bytes:
    """Worker only: never load this global-state C engine in the web process."""
    engine = ctypes.CDLL(library)
    engine.espeak_Initialize.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
    engine.espeak_Initialize.restype = ctypes.c_int
    # AUDIO_OUTPUT_SYNCHRONOUS returns PCM via the callback before Synth returns.
    rate = engine.espeak_Initialize(2, 0, data_path.encode("utf-8"), 0x8000)
    if rate <= 0:
        raise RuntimeError("Cannot initialize eSpeak data")
    chunks = []
    byte_count = 0
    overflow = False
    callback_type = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(ctypes.c_short), ctypes.c_int, ctypes.c_void_p)

    @callback_type
    def receive(samples, count, events):
        nonlocal byte_count, overflow
        if count < 0 or count * 2 + byte_count > _MAX_WAV_BYTES:
            overflow = True
            return 1
        if samples and count:
            chunks.append(ctypes.string_at(samples, count * 2))
            byte_count += count * 2
        return 0

    try:
        engine.espeak_SetSynthCallback.argtypes = [callback_type]
        engine.espeak_SetSynthCallback(receive)
        engine.espeak_SetVoiceByName.argtypes = [ctypes.c_char_p]
        if engine.espeak_SetVoiceByName(b"en-us") != 0:
            raise RuntimeError("English voice unavailable")
        engine.espeak_SetParameter.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int]
        engine.espeak_SetParameter(1, 155, 0)  # espeakRATE, words per minute.
        engine.espeak_Synth.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint, ctypes.c_int,
                                      ctypes.c_uint, ctypes.c_uint, ctypes.POINTER(ctypes.c_uint), ctypes.c_void_p]
        text = normalize_word(word).encode("utf-8") + b"\0"
        if engine.espeak_Synth(text, len(text), 0, 1, 0, 1, None, None) != 0:
            raise RuntimeError("English synthesis failed")
    finally:
        engine.espeak_Terminate()
    if overflow:
        raise WordSpeechUnavailable("Word audio exceeded the size limit.")
    result = io.BytesIO()
    with wave.open(result, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(b"".join(chunks))
    audio = result.getvalue()
    _validate_wav(audio)
    return audio


if __name__ == "__main__":
    if len(sys.argv) != 5 or sys.argv[1] != "--worker":
        raise SystemExit(2)
    sys.stdout.buffer.write(_synthesize_in_process(sys.argv[2], sys.argv[3], sys.argv[4]))
