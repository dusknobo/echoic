import io
import struct
import subprocess
import wave
from unittest.mock import Mock

from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from app.services import word_speech as service
from app.api.routes import word_speech as route


def wav_bytes(samples=2205):
    result = io.BytesIO()
    with wave.open(result, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(22050)
        wav.writeframes(struct.pack("<h", 1000) * samples)
    return result.getvalue()


@pytest.fixture(autouse=True)
def empty_cache():
    with service._cache_lock:
        service._cache.clear()
        service._cache_bytes = 0
    yield
    with service._cache_lock:
        service._cache.clear()
        service._cache_bytes = 0


@pytest.mark.parametrize("word, expected", [(" Hello ", "hello"), ("don't", "don't"), ("well-known", "well-known"), ("I’m", "i'm")])
def test_normalize_single_words(word, expected):
    assert service.normalize_word(word) == expected


@pytest.mark.parametrize("word", ["", "hello world", "../word", "a" * 65, "a1", "中文", "<audio>", "--hello"])
def test_reject_non_words(word):
    with pytest.raises(ValueError):
        service.normalize_word(word)


def test_cache_and_eviction(monkeypatch):
    render = Mock(return_value=wav_bytes())
    monkeypatch.setattr(service, "_render_word", render)
    monkeypatch.setattr(service, "_CACHE_ENTRIES", 2)
    assert service.english_word_wav("Hello") == service.english_word_wav("hello")
    assert render.call_count == 1
    service.english_word_wav("world")
    service.english_word_wav("hello")  # Keep hello as the most recently used entry.
    service.english_word_wav("again")
    assert list(service._cache) == ["hello", "again"]
    assert service._cache_bytes == sum(map(len, service._cache.values()))


def test_cache_byte_limit(monkeypatch):
    audio = wav_bytes()
    monkeypatch.setattr(service, "_render_word", lambda word: audio)
    monkeypatch.setattr(service, "_CACHE_BYTES", len(audio) * 2 - 1)
    service.english_word_wav("one")
    service.english_word_wav("two")
    assert list(service._cache) == ["two"]
    assert service._cache_bytes == len(audio)


def test_busy_engine_does_not_start_subprocess(monkeypatch):
    slots = Mock()
    slots.acquire.return_value = False
    render = Mock()
    monkeypatch.setattr(service, "_slots", slots)
    monkeypatch.setattr(service, "_render_word", render)
    with pytest.raises(service.WordSpeechBusy):
        service.english_word_wav("hello")
    render.assert_not_called()
    slots.release.assert_not_called()


def test_failure_releases_slot_and_is_not_cached(monkeypatch):
    slots = Mock()
    slots.acquire.return_value = True
    monkeypatch.setattr(service, "_slots", slots)
    monkeypatch.setattr(service, "_render_word", Mock(side_effect=service.WordSpeechUnavailable("unavailable")))
    with pytest.raises(service.WordSpeechUnavailable):
        service.english_word_wav("hello")
    slots.release.assert_called_once()
    assert not service._cache


def test_subprocess_uses_argument_list_and_timeout(monkeypatch):
    monkeypatch.setattr(service, "_speech_assets", lambda: ("library", "data"))
    run = Mock(return_value=subprocess.CompletedProcess([], 0, wav_bytes(), b""))
    monkeypatch.setattr(service.subprocess, "run", run)
    assert service._render_word("don't") == wav_bytes()
    args, kwargs = run.call_args
    assert isinstance(args[0], list)
    assert args[0][-3:] == ["don't", "library", "data"]
    assert kwargs["timeout"] == 12
    assert kwargs.get("shell", False) is False


def test_subprocess_timeout_becomes_service_error(monkeypatch):
    monkeypatch.setattr(service, "_speech_assets", lambda: ("library", "data"))
    monkeypatch.setattr(service.subprocess, "run", Mock(side_effect=subprocess.TimeoutExpired("speech", 12)))
    with pytest.raises(service.WordSpeechUnavailable):
        service._render_word("hello")


@pytest.mark.parametrize("data", [b"not a wav", wav_bytes()[:-2]])
def test_rejects_invalid_worker_audio(data):
    with pytest.raises(service.WordSpeechUnavailable):
        service._validate_wav(data)


def test_http_contract(monkeypatch):
    app = FastAPI()
    app.include_router(route.router, prefix="/api/word-speech")
    client = TestClient(app)
    monkeypatch.setattr(route, "english_word_wav", lambda word: wav_bytes())
    result = client.get("/api/word-speech/en/hello")
    assert result.status_code == 200
    assert result.headers["content-type"] == "audio/wav"
    assert result.content == wav_bytes()
    assert "max-age" in result.headers["cache-control"]


def test_http_errors(monkeypatch):
    app = FastAPI()
    app.include_router(route.router, prefix="/api/word-speech")
    client = TestClient(app)
    monkeypatch.setattr(route, "english_word_wav", Mock(side_effect=ValueError("one word")))
    assert client.get("/api/word-speech/en/hello").status_code == 400
    monkeypatch.setattr(route, "english_word_wav", Mock(side_effect=service.WordSpeechBusy("busy")))
    response = client.get("/api/word-speech/en/hello")
    assert response.status_code == 503
    assert response.headers["retry-after"] == "1"
    monkeypatch.setattr(route, "english_word_wav", Mock(side_effect=service.WordSpeechUnavailable("unavailable")))
    assert client.get("/api/word-speech/en/hello").status_code == 503


def test_real_local_english_speech():
    pytest.importorskip("espeakng_loader")
    audio = service.english_word_wav("hello")
    service._validate_wav(audio)
    with wave.open(io.BytesIO(audio), "rb") as wav:
        pcm = wav.readframes(wav.getnframes())
        assert wav.getnframes() / wav.getframerate() > 0.1
        assert max(abs(v) for (v,) in struct.iter_unpack("<h", pcm)) > 100
