"""Validate local recording timestamps and measure decoded recording duration."""
import math
import os
import subprocess
import tempfile
import threading
import wave


# The cached alignment service holds one mutable model/device instance. Only
# local alignment work takes this lock; request handlers remain asynchronous.
model_lock = threading.Lock()


def valid_duration(value):
    if isinstance(value, bool):
        return None
    try:
        value = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return value if math.isfinite(value) and value > 0 else None


def normalize_words(words, duration=None):
    if not isinstance(words, (list, tuple)):
        return []
    duration = valid_duration(duration)
    result = []
    for item in words:
        if hasattr(item, "model_dump"):
            item = item.model_dump()
        if not isinstance(item, dict):
            continue
        word = item.get("word")
        start, end = item.get("start"), item.get("end")
        if not isinstance(word, str) or not word.strip() or isinstance(start, bool) or isinstance(end, bool):
            continue
        try:
            start, end = float(start), float(end)
        except (TypeError, ValueError, OverflowError):
            continue
        if not math.isfinite(start) or not math.isfinite(end) or start < 0 or end <= start:
            continue
        if duration is not None and end > duration + 0.000001:
            continue
        result.append({"word": word.strip(), "start": start, "end": end})
    return result


def _wav_duration(path):
    with wave.open(str(path), "rb") as audio:
        value = audio.getnframes() / audio.getframerate()
    duration = valid_duration(value)
    if duration is None:
        raise ValueError("Recording has no measurable duration")
    return duration


def read_recording_duration(path):
    """Use sample counts, not the last aligned word or container display time."""
    try:
        return _wav_duration(path)
    except (wave.Error, EOFError):
        pass
    # Browser WebM/Opus recordings can have no duration in container metadata.
    # Decode to a temporary PCM file and count samples, including trailing silence.
    temporary = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    temporary.close()
    try:
        subprocess.run(["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
                        "-i", str(path), "-vn", "-ac", "1", "-ar", "16000",
                        "-c:a", "pcm_s16le", temporary.name],
                       check=True, capture_output=True, timeout=120,
                       creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return _wav_duration(temporary.name)
    finally:
        try:
            os.unlink(temporary.name)
        except OSError:
            pass
