import struct
import subprocess
import wave
from pathlib import Path

import pytest
from app.services import record_word_alignment as service


def write_wav(path, seconds=1.5):
    with wave.open(str(path), "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(struct.pack("<h", 0) * int(seconds * 16000))


def test_normalize_drops_invalid_ranges_without_guessing_or_clamping():
    words = [{"word": " valid ", "start": .1, "end": .4}, {"word": "negative", "start": -.1, "end": .3},
        {"word": "zero", "start": .2, "end": .2}, {"word": "missing", "end": .3},
        {"word": "nan", "start": float("nan"), "end": .3}, {"word": "inf", "start": 0, "end": float("inf")},
        {"word": "outside", "start": .5, "end": 4}, {"word": "", "start": 0, "end": .4},
        {"word": "bool", "start": True, "end": 2}]
    assert service.normalize_words(words, 2) == [{"word": "valid", "start": .1, "end": .4}]
    assert service.normalize_words(None) == []


@pytest.mark.parametrize("value", [None, 0, -1, True, float("nan"), float("inf"), "bad"])
def test_invalid_duration(value):
    assert service.valid_duration(value) is None


def test_pcm_wav_duration_counts_all_samples_and_trailing_silence(tmp_path, monkeypatch):
    path = tmp_path / "trailing-silence.wav"
    write_wav(path, 1.5)
    def forbidden(*args, **kwargs):
        pytest.fail("valid PCM WAV duration should not require ffmpeg")
    monkeypatch.setattr(service.subprocess, "run", forbidden)
    assert service.read_recording_duration(path) == 1.5


def test_webm_duration_decodes_sample_counts_and_cleans_temporary_file(tmp_path, monkeypatch):
    path = tmp_path / "browser.webm"
    path.write_bytes(b"not-a-wav-container")
    calls = []
    def decode(args, **kwargs):
        calls.append((args, kwargs))
        write_wav(args[-1], 1.75)
    monkeypatch.setattr(service.subprocess, "run", decode)
    assert service.read_recording_duration(path) == 1.75
    args, kwargs = calls[0]
    assert args[args.index("-i") + 1] == str(path)
    assert args[args.index("-c:a") + 1] == "pcm_s16le"
    assert kwargs["timeout"] == 120 and kwargs["capture_output"] is True
    assert kwargs["creationflags"] == getattr(subprocess, "CREATE_NO_WINDOW", 0)
    assert not Path(args[-1]).exists()


def test_failed_decode_cleans_temporary_file(tmp_path, monkeypatch):
    path = tmp_path / "bad.webm"
    path.write_bytes(b"not a wave")
    paths = []
    def decode(args, **kwargs):
        paths.append(args[-1])
        raise subprocess.CalledProcessError(1, args, stderr=b"private decoder output")
    monkeypatch.setattr(service.subprocess, "run", decode)
    with pytest.raises(subprocess.CalledProcessError):
        service.read_recording_duration(path)
    assert not Path(paths[0]).exists()
