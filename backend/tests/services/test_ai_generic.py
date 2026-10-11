import base64
import io
import json
import wave

import httpx
import pytest

from app.services.ai_assessment import generic


def test_feedback_sanitizes_scores_and_evidence():
    result = generic.parse_feedback(json.dumps({"feedback": "Feedback", "accuracy_score": "NaN", "overall_score": 120,
        "words": [{"word": "on", "accuracy_score": -2}],
        "connected_speech": [{"text": "turn it", "evidence": "measured", "suggestion": "connect consonant and vowel"}]}), "openai", "audio-model")
    assert result["accuracy_score"] is None
    assert result["overall_score"] == 100
    assert result["words"][0]["accuracy_score"] == 0
    assert result["connected_speech"][0]["evidence"] == "uncertain"
    assert result["kind"] == "feedback" and result["limitations"]


def test_text_fallback_does_not_invent_scores():
    result = generic.parse_feedback("Could not hear the ending clearly.", "local", "audio-model")
    assert result["overall_score"] is None and not result["words"]
    assert "ending" in result["feedback"]


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["openai", "gemini", "qwen", "local"])
async def test_actual_audio_is_sent_for_every_generic_provider(monkeypatch, provider):
    captured = []
    model_text = json.dumps({"feedback": "Practice linking.", "overall_score": 71})
    def handle(request):
        captured.append(request)
        if provider == "qwen":
            event = {"choices": [{"delta": {"content": model_text}}]}
            return httpx.Response(200, text="data: " + json.dumps(event) + "\n\ndata: [DONE]\n\n", headers={"Content-Type": "text/event-stream"})
        if provider == "gemini":
            return httpx.Response(200, json={"steps": [{"type": "thought", "content": [{"type": "text", "text": "hidden"}]}, {"type": "model_output", "content": [{"type": "text", "text": model_text}]}]})
        return httpx.Response(200, json={"choices": [{"message": {"content": model_text}}]})
    original = httpx.AsyncClient
    monkeypatch.setattr(generic.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(handle), **kwargs))
    wav = b"RIFFsynthetic-audio-data"
    result = await generic.analyze_audio(provider, {"endpoint": "https://example.invalid/v1", "model": "audio-model", "api_key": "synthetic-test-credential"}, wav, "Turn it on.")
    assert result["overall_score"] == 71 and result["kind"] == "feedback"
    payload = json.loads(captured[0].content)
    assert payload["model"] == "audio-model"
    if provider == "gemini":
        assert captured[0].url.path.endswith("/interactions")
        assert base64.b64decode(payload["input"][1]["data"]) == wav
        assert captured[0].headers["x-goog-api-key"] == "synthetic-test-credential"
    else:
        encoded = payload["messages"][0]["content"][1]["input_audio"]["data"]
        assert base64.b64decode(encoded.split(",")[-1]) == wav
        assert "Turn it on." in payload["messages"][0]["content"][0]["text"]


@pytest.mark.asyncio
async def test_rate_limit_not_retried_and_upstream_body_not_exposed(monkeypatch):
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(429, text="synthetic-test-credential upstream private body")
    original = httpx.AsyncClient
    monkeypatch.setattr(generic.httpx, "AsyncClient", lambda **kwargs: original(transport=httpx.MockTransport(handle), **kwargs))
    with pytest.raises(generic.AnalysisError) as error:
        await generic.analyze_audio("openai", {"endpoint": "https://example.invalid/v1", "model": "audio-model", "api_key": "synthetic-test-credential"}, b"wav", "text")
    assert len(calls) == 1 and "synthetic-test-credential" not in str(error.value)


def test_conversion_validates_and_generates_16k_mono_wav(tmp_path):
    path = tmp_path / "recording.wav"
    with wave.open(str(path), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(48000)
        output.writeframes(b"\0" * 48000 * 4)
    pcm, wav = generic.prepare_audio(str(path))
    assert len(pcm) == 32000
    with wave.open(io.BytesIO(wav), "rb") as audio:
        assert (audio.getnchannels(), audio.getsampwidth(), audio.getframerate()) == (1, 2, 16000)
    with pytest.raises(generic.AnalysisError):
        generic.prepare_audio(str(tmp_path / "missing.wav"))


def test_conversion_does_not_silently_truncate_long_recording(tmp_path):
    path = tmp_path / "long.wav"
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\0" * 61 * 32000)
    with pytest.raises(generic.AnalysisError, match="60"):
        generic.prepare_audio(str(path))
