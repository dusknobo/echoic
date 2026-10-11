import json
import os
from contextlib import contextmanager

import pytest
from fastapi.testclient import TestClient

from app.db import get_db
from app.main import app
from app.models.audio_file import AudioFile
from app.models.practice_record import PracticeRecord
from app.services.ai_assessment.settings import AISettingsStore, ConfigError, get_ai_settings_store


@contextmanager
def client_for(db, tmp_path):
    store = AISettingsStore(tmp_path / "ai-settings.json")
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[get_ai_settings_store] = lambda: store
    try:
        with TestClient(app, base_url="http://127.0.0.1") as client:
            yield client, store
    finally:
        app.dependency_overrides.clear()


def seed_record(db):
    audio = AudioFile(title="AI test", source_type="upload", storage_backend="local", file_path="audio/test.wav", sentences=[])
    db.add(audio)
    db.flush()
    record = PracticeRecord(audio_file_id=audio.id, sentence_index=0, sentence_text="Turn it on.", storage_backend="local", recording_path="recordings/test.wav", accuracy_score=81)
    db.add(record)
    db.flush()
    return record


def test_settings_all_providers_and_secret_roundtrip(db, tmp_path):
    with client_for(db, tmp_path) as (client, store):
        initial = client.get("/api/ai/settings").json()
        assert initial["enabled"] is False
        assert set(initial["providers"]) == {"tencent", "azure", "iflytek", "openai", "gemini", "qwen", "local"}
        response = client.put("/api/ai/settings", json={"providers": {"qwen": {"api_key": "synthetic-test-credential"}}})
        assert response.status_code == 200
        assert "synthetic-test-credential" not in response.text
        assert response.json()["providers"]["qwen"]["api_key_set"]
        assert store.load()["providers"]["qwen"]["api_key"] == "synthetic-test-credential"
        if os.name == "nt":
            assert "synthetic-test-credential" not in store.path.read_text(encoding="utf-8")
            assert "dpapi:" in store.path.read_text(encoding="utf-8")
        client.put("/api/ai/settings", json={"providers": {"qwen": {"api_key": "", "model": "other-audio-model"}}})
        assert store.load()["providers"]["qwen"]["api_key"] == "synthetic-test-credential"
        client.put("/api/ai/settings", json={"providers": {"qwen": {"clear_secrets": ["api_key"]}}})
        assert store.load()["providers"]["qwen"]["api_key"] == ""
        assert not client.get("/api/ai/settings").json()["providers"]["qwen"]["configured"]


def test_bad_settings_and_cross_origin_never_echo_credentials(db, tmp_path):
    with client_for(db, tmp_path) as (client, store):
        response = client.put("/api/ai/settings", json={"providers": {"openai": {"api_key": "synthetic-test-credential", "endpoint": "https://example.org/?key=synthetic-test-credential"}}})
        assert response.status_code == 400
        assert "synthetic-test-credential" not in response.text
        assert not store.path.exists()
        response = client.put("/api/ai/settings", json={"enabled": True}, headers={"Origin": "https://untrusted.invalid"})
        assert response.status_code == 403
        assert not store.path.exists()
        response = client.put("/api/ai/settings", json={"enabled": True}, headers={"Host": "rebinding.invalid", "Origin": "http://rebinding.invalid"})
        assert response.status_code == 403
        assert not store.path.exists()
        response = client.put("/api/ai/settings", content="enabled=true", headers={"Content-Type": "application/x-www-form-urlencoded"})
        assert response.status_code == 415


def test_validation_is_local_and_does_not_require_enabled(db, tmp_path, monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("offline config validation must not call external services")
    monkeypatch.setattr("app.api.routes.ai.analyze_audio", forbidden)
    with client_for(db, tmp_path) as (client, _store):
        assert not client.post("/api/ai/providers/tencent/validate").json()["valid"]
        assert client.post("/api/ai/providers/local/validate").json()["valid"]
        assert client.post("/api/ai/providers/missing/validate").status_code == 404
        assert client.post("/api/ai/records/123/analyze", json={"mode": "feedback"}).status_code == 409


def test_analysis_persists_separately_from_local_score(db, tmp_path, monkeypatch):
    record = seed_record(db)
    calls = []
    monkeypatch.setattr("app.api.routes.ai.prepare_audio", lambda path: (b"pcm", b"RIFFtestwav"))
    class Storage:
        def get_absolute_path(self, key):
            return "/tmp/recording.wav"
    monkeypatch.setattr("app.api.routes.ai.get_storage_service", lambda _backend: Storage())
    async def fake(provider, config, wav, reference):
        calls.append((provider, wav, reference))
        return {"provider": provider, "kind": "feedback", "overall_score": 76, "accuracy_score": None,
            "feedback": "Practice turn it as a connected phrase.", "words": [], "connected_speech": [], "limitations": ["Reference score"]}
    monkeypatch.setattr("app.api.routes.ai.analyze_audio", fake)
    with client_for(db, tmp_path) as (client, store):
        store.update({"enabled": True, "providers": {"qwen": {"api_key": "synthetic-test-credential"}}})
        response = client.post(f"/api/ai/records/{record.id}/analyze", json={"mode": "feedback"})
        assert response.status_code == 200, response.text
        result = response.json()
        assert result["record_id"] == record.id and result["provider"] == "qwen"
        assert result["kind"] == "feedback"
        assert "synthetic-test-credential" not in response.text
        history = client.get(f"/api/ai/records/{record.id}/analyses").json()
        assert len(history) == 1 and history[0]["id"] == result["id"]
        assert client.get("/api/ai/records/999999/analyses").status_code == 404
    assert calls == [("qwen", b"RIFFtestwav", "Turn it on.")]
    assert db.get(PracticeRecord, record.id).accuracy_score == 81


def test_disabled_unconfigured_and_errors_do_not_fallback(db, tmp_path, monkeypatch):
    record = seed_record(db)
    def forbidden(*args, **kwargs):
        pytest.fail("unconfigured request must not read/upload audio")
    monkeypatch.setattr("app.api.routes.ai.prepare_audio", forbidden)
    with client_for(db, tmp_path) as (client, store):
        assert client.post(f"/api/ai/records/{record.id}/analyze", json={"mode": "assessment"}).status_code == 409
        store.update({"enabled": True})
        assert client.post(f"/api/ai/records/{record.id}/analyze", json={"mode": "assessment"}).status_code == 409
        assert client.post(f"/api/ai/records/{record.id}/analyze", json={"mode": "feedback", "provider": "tencent"}).status_code == 400

# New analysis defaults are tested independently from real provider adapters.
ALL_PROVIDERS = ("tencent", "azure", "iflytek", "openai", "gemini", "qwen", "local")
FAKE_PROVIDER_FIELDS = {
    "tencent": {"app_id": "123456", "secret_id": "synthetic-id", "secret_key": "synthetic-secret"},
    "azure": {"api_key": "synthetic-key"},
    "iflytek": {"app_id": "synthetic-app", "api_key": "synthetic-key", "api_secret": "synthetic-secret"},
    "openai": {"api_key": "synthetic-key"},
    "gemini": {"api_key": "synthetic-key"},
    "qwen": {"api_key": "synthetic-key"},
    "local": {},
}


def install_analysis_mocks(monkeypatch):
    calls, deleted = [], []

    class Storage:
        def get_absolute_path(self, key):
            return "/synthetic/recording.wav"

        def delete(self, key):
            deleted.append(key)

    monkeypatch.setattr("app.api.routes.ai.prepare_audio", lambda path: (b"synthetic-pcm", b"RIFF-synthetic-wav"))
    monkeypatch.setattr("app.api.routes.ai.get_storage_service", lambda _backend: Storage())
    monkeypatch.setattr("app.api.routes.practice.get_storage_service", lambda _backend: Storage())

    async def fake_generic(provider, config, audio, reference):
        calls.append((provider, "feedback", audio, reference))
        return {"provider": provider, "kind": "feedback", "overall_score": 77,
                "feedback": "Synthetic feedback", "words": [], "connected_speech": [], "limitations": []}

    async def fake_dedicated(provider, config, audio, reference):
        calls.append((provider, "assessment", audio, reference))
        return {"provider": provider, "kind": "assessment", "accuracy_score": 84,
                "feedback": "Synthetic assessment", "words": [], "connected_speech": [], "limitations": []}

    monkeypatch.setattr("app.api.routes.ai.analyze_audio", fake_generic)
    monkeypatch.setattr("app.services.ai_assessment.dedicated.assess", fake_dedicated)
    return calls, deleted


@pytest.mark.parametrize("provider", ALL_PROVIDERS)
def test_empty_analysis_request_uses_selected_default_and_actual_provider_kind(db, tmp_path, monkeypatch, provider):
    record = seed_record(db)
    calls, _deleted = install_analysis_mocks(monkeypatch)
    with client_for(db, tmp_path) as (client, store):
        saved = client.put("/api/ai/settings", json={"enabled": True, "analysis_provider": provider,
            "providers": {provider: FAKE_PROVIDER_FIELDS[provider]}})
        assert saved.status_code == 200, saved.text
        assert saved.json()["analysis_provider"] == provider
        assert store.load()["analysis_provider"] == provider
        assert client.get("/api/ai/settings").json()["analysis_provider"] == provider
        response = client.post(f"/api/ai/records/{record.id}/analyze", json={})
        assert response.status_code == 200, response.text
        dedicated = provider in {"tencent", "azure", "iflytek"}
        kind = "assessment" if dedicated else "feedback"
        audio = b"synthetic-pcm" if dedicated else b"RIFF-synthetic-wav"
        assert response.json()["provider"] == provider
        assert response.json()["kind"] == kind
        assert response.json()["record_id"] == record.id
    assert calls == [(provider, kind, audio, "Turn it on.")]
    assert db.get(PracticeRecord, record.id).accuracy_score == 81


@pytest.mark.parametrize("previous_feedback", ["local", "gemini"])
def test_legacy_settings_load_migrates_default_to_existing_feedback_without_writing(db, tmp_path, previous_feedback):
    path = tmp_path / "ai-settings.json"
    legacy = {"enabled": True, "assessment_provider": "azure", "feedback_provider": previous_feedback,
              "providers": {}}
    original = json.dumps(legacy).encode("utf-8")
    path.write_bytes(original)
    with client_for(db, tmp_path) as (client, store):
        assert store.load()["analysis_provider"] == previous_feedback
        assert client.get("/api/ai/settings").json()["analysis_provider"] == previous_feedback
    assert path.read_bytes() == original  # A read must not overwrite old user settings.


def test_legacy_settings_empty_request_uses_previous_feedback_service(db, tmp_path, monkeypatch):
    record = seed_record(db)
    calls, _deleted = install_analysis_mocks(monkeypatch)
    path = tmp_path / "ai-settings.json"
    path.write_text(json.dumps({"enabled": True, "assessment_provider": "tencent",
                              "feedback_provider": "local", "providers": {}}), encoding="utf-8")
    with client_for(db, tmp_path) as (client, _store):
        response = client.post(f"/api/ai/records/{record.id}/analyze", json={})
        assert response.status_code == 200, response.text
        assert response.json()["provider"] == "local"
        assert response.json()["kind"] == "feedback"
    assert calls[0][:2] == ("local", "feedback")


@pytest.mark.parametrize("body, expected_provider, expected_kind", [
    ({"mode": "assessment"}, "azure", "assessment"),
    ({"mode": "feedback"}, "qwen", "feedback"),
    ({"provider": "iflytek"}, "iflytek", "assessment"),
    ({"provider": "gemini"}, "gemini", "feedback"),
    ({"mode": "assessment", "provider": "tencent"}, "tencent", "assessment"),
    ({"mode": "feedback", "provider": "openai"}, "openai", "feedback"),
])
def test_explicit_legacy_mode_or_provider_overrides_new_default(db, tmp_path, monkeypatch, body, expected_provider, expected_kind):
    record = seed_record(db)
    calls, _deleted = install_analysis_mocks(monkeypatch)
    with client_for(db, tmp_path) as (client, store):
        store.update({"enabled": True, "analysis_provider": "local", "assessment_provider": "azure",
                      "feedback_provider": "qwen", "providers": FAKE_PROVIDER_FIELDS})
        response = client.post(f"/api/ai/records/{record.id}/analyze", json=body)
        assert response.status_code == 200, response.text
        assert response.json()["provider"] == expected_provider
        assert response.json()["kind"] == expected_kind
    assert calls[0][:2] == (expected_provider, expected_kind)


def test_invalid_default_service_is_rejected_without_changing_saved_settings(db, tmp_path):
    with client_for(db, tmp_path) as (client, store):
        store.update({"analysis_provider": "local"})
        before = store.path.read_bytes()
        response = client.put("/api/ai/settings", json={"analysis_provider": "unknown-provider"})
        assert response.status_code == 400
        assert store.path.read_bytes() == before
        assert client.get("/api/ai/settings").json()["analysis_provider"] == "local"


def test_saved_analysis_can_be_reloaded_by_record_in_new_client_without_reanalysis(db, tmp_path, monkeypatch):
    record = seed_record(db)
    other = seed_record(db)
    record_id, other_id = record.id, other.id
    calls, _deleted = install_analysis_mocks(monkeypatch)
    with client_for(db, tmp_path) as (client, store):
        store.update({"enabled": True, "analysis_provider": "local"})
        created = client.post(f"/api/ai/records/{record_id}/analyze", json={})
        assert created.status_code == 200, created.text
        saved = created.json()
    db.expunge_all()
    with client_for(db, tmp_path) as (client, _store):
        response = client.get(f"/api/ai/records/{record_id}/analyses")
        assert response.status_code == 200
        restored = response.json()
        assert len(restored) == 1 and restored[0] == saved
        assert client.get(f"/api/ai/records/{other_id}/analyses").json() == []
    assert len(calls) == 1
    assert db.get(PracticeRecord, record_id).accuracy_score == 81


def test_deleting_record_cascades_its_analyses_and_preserves_other_records(tmp_path, monkeypatch):
    # Production enables SQLite foreign keys. Use an isolated FK-on database here;
    # the general session fixture intentionally has no SQLite FK setup.
    from sqlalchemy import create_engine, event
    from sqlalchemy.orm import Session
    from sqlalchemy.pool import StaticPool
    from app.db import Base
    from app.models.ai_record_analysis import AIRecordAnalysis

    engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False}, poolclass=StaticPool)

    @event.listens_for(engine, "connect")
    def enable_foreign_keys(connection, _record):
        connection.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    calls, deleted = install_analysis_mocks(monkeypatch)
    try:
        with Session(engine) as session:
            record, other = seed_record(session), seed_record(session)
            record_id, other_id = record.id, other.id
            with client_for(session, tmp_path) as (client, store):
                store.update({"enabled": True, "analysis_provider": "local"})
                for target in (record_id, record_id, other_id):
                    response = client.post(f"/api/ai/records/{target}/analyze", json={})
                    assert response.status_code == 200, response.text
                assert session.query(AIRecordAnalysis).filter_by(record_id=record_id).count() == 2
                response = client.delete(f"/api/practice/record/{record_id}")
                assert response.status_code == 204, response.text
                session.expire_all()
                assert session.get(PracticeRecord, record_id) is None
                assert session.query(AIRecordAnalysis).filter_by(record_id=record_id).count() == 0
                assert session.get(PracticeRecord, other_id) is not None
                assert session.query(AIRecordAnalysis).filter_by(record_id=other_id).count() == 1
                assert client.get(f"/api/ai/records/{record_id}/analyses").status_code == 404
                assert len(client.get(f"/api/ai/records/{other_id}/analyses").json()) == 1
            assert len(calls) == 3 and deleted == ["recordings/test.wav"]
    finally:
        engine.dispose()
