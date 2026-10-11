from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker

from app.db import create_database_engine, get_db, initialize_local_database
from app.main import app
from app.models import AudioFile, ListeningMarker


@pytest.fixture
def marker_app(tmp_path, monkeypatch):
    database_engine = create_database_engine(f"sqlite:///{(tmp_path / 'echoic.db').as_posix()}")
    initialize_local_database(database_engine)
    sessions = sessionmaker(bind=database_engine)

    def override_db():
        with sessions() as db:
            try:
                yield db
                db.commit()
            except Exception:
                db.rollback()
                raise

    monkeypatch.setattr(
        "app.api.routes.audio.get_storage_service",
        lambda _backend: SimpleNamespace(delete=lambda _key: None),
    )
    app.dependency_overrides[get_db] = override_db
    try:
        with TestClient(app) as client:
            yield client, sessions
    finally:
        app.dependency_overrides.clear()
        database_engine.dispose()


def _audio(sessions, title="Lesson"):
    with sessions() as db:
        audio = AudioFile(
            title=title, source_type="upload", file_path=f"audio/{title}.mp3", sentences=[]
        )
        db.add(audio)
        db.commit()
        return audio.id


def test_marker_crud_is_persistent_sorted_and_scoped_to_audio(marker_app):
    client, sessions = marker_app
    audio_id = _audio(sessions)
    other_audio_id = _audio(sessions, "Other")

    later = client.post(f"/api/audio/{audio_id}/markers", json={"time": 21.125})
    earlier = client.post(f"/api/audio/{audio_id}/markers", json={"time": 3.5, "note": "没听清"})
    assert later.status_code == 201
    assert earlier.status_code == 201
    assert later.json()["note"] == ""
    assert earlier.json()["created_at"]
    marker_id = earlier.json()["id"]

    markers = client.get(f"/api/audio/{audio_id}/markers")
    assert markers.status_code == 200
    assert [marker["time"] for marker in markers.json()] == [3.5, 21.125]
    assert client.get(f"/api/audio/{other_audio_id}/markers").json() == []

    patched = client.patch(
        f"/api/audio/{audio_id}/markers/{marker_id}", json={"note": "回听这一处"}
    )
    assert patched.status_code == 200
    assert patched.json()["note"] == "回听这一处"
    with sessions() as db:
        assert db.get(ListeningMarker, marker_id).note == "回听这一处"

    assert client.patch(
        f"/api/audio/{other_audio_id}/markers/{marker_id}", json={"note": "Wrong"}
    ).status_code == 404
    assert client.delete(
        f"/api/audio/{other_audio_id}/markers/{marker_id}"
    ).status_code == 404

    deleted = client.delete(f"/api/audio/{audio_id}/markers/{marker_id}")
    assert deleted.status_code == 204
    assert deleted.content == b""
    assert len(client.get(f"/api/audio/{audio_id}/markers").json()) == 1
    assert client.delete(f"/api/audio/{audio_id}/markers/{marker_id}").status_code == 404


@pytest.mark.parametrize("time", [-0.1, 604801, "NaN", "Infinity", "-Infinity"])
def test_invalid_marker_times_are_rejected(marker_app, time):
    client, sessions = marker_app
    audio_id = _audio(sessions)
    response = client.post(f"/api/audio/{audio_id}/markers", json={"time": time})
    assert response.status_code == 422
    assert client.get(f"/api/audio/{audio_id}/markers").json() == []


def test_marker_validates_note_and_audio_existence(marker_app):
    client, sessions = marker_app
    audio_id = _audio(sessions)
    assert client.post(
        f"/api/audio/{audio_id}/markers", json={"time": 0, "note": "x" * 2001}
    ).status_code == 422
    assert client.get("/api/audio/99999/markers").status_code == 404
    assert client.post("/api/audio/99999/markers", json={"time": 0}).status_code == 404
    assert client.patch("/api/audio/99999/markers/1", json={"note": ""}).status_code == 404
    assert client.delete("/api/audio/99999/markers/1").status_code == 404


def test_deleting_audio_cascades_markers(marker_app):
    client, sessions = marker_app
    audio_id = _audio(sessions)
    other_audio_id = _audio(sessions, "Other")
    created = client.post(f"/api/audio/{audio_id}/markers", json={"time": 10})
    keep = client.post(f"/api/audio/{other_audio_id}/markers", json={"time": 12})
    assert client.delete(f"/api/audio/{audio_id}").status_code == 204
    with sessions() as db:
        assert db.get(ListeningMarker, created.json()["id"]) is None
        assert db.get(ListeningMarker, keep.json()["id"]) is not None


def test_retry_after_lost_response_keeps_the_original_marker(marker_app):
    client, sessions = marker_app
    audio_id = _audio(sessions)
    other_audio_id = _audio(sessions, "Other")
    payload = {"time": 15.25, "note": "Review", "client_id": "06635452-2500-47a9-b283-eb056e55f529"}
    first = client.post(f"/api/audio/{audio_id}/markers", json=payload)
    assert first.status_code == 201
    # The first response can be lost in transit. Retrying the same captured
    # keystroke must return its persisted marker rather than creating a second.
    retry = client.post(f"/api/audio/{audio_id}/markers", json=payload)
    assert retry.status_code == 201
    assert retry.json() == first.json()
    assert retry.json()["client_id"] == payload["client_id"]
    assert len(client.get(f"/api/audio/{audio_id}/markers").json()) == 1
    # Client IDs are scoped to each audio file.
    other = client.post(f"/api/audio/{other_audio_id}/markers", json=payload)
    assert other.status_code == 201
    assert other.json()["id"] != first.json()["id"]


def test_omitting_client_id_still_allows_separate_keystrokes_at_same_time(marker_app):
    client, sessions = marker_app
    audio_id = _audio(sessions)
    first = client.post(f"/api/audio/{audio_id}/markers", json={"time": 15})
    second = client.post(f"/api/audio/{audio_id}/markers", json={"time": 15})
    assert first.status_code == second.status_code == 201
    assert first.json()["id"] != second.json()["id"]


@pytest.mark.parametrize("client_id", ["", "x" * 65])
def test_client_id_is_bounded(marker_app, client_id):
    client, sessions = marker_app
    audio_id = _audio(sessions)
    assert client.post(
        f"/api/audio/{audio_id}/markers", json={"time": 1, "client_id": client_id}
    ).status_code == 422


def test_concurrent_retries_save_only_one_marker(marker_app):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    client, sessions = marker_app
    audio_id = _audio(sessions)
    ready = Barrier(2)

    def send_retry():
        ready.wait(timeout=5)
        return client.post(
            f"/api/audio/{audio_id}/markers",
            json={"time": 8.25, "client_id": "simultaneous-retry"},
        )

    with ThreadPoolExecutor(max_workers=2) as executor:
        responses = list(executor.map(lambda _: send_retry(), range(2)))
    assert [response.status_code for response in responses] == [201, 201]
    assert responses[0].json()["id"] == responses[1].json()["id"]
    assert len(client.get(f"/api/audio/{audio_id}/markers").json()) == 1
