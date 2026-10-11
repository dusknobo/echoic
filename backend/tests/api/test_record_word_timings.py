"""Recorded word playback uses local alignment with fake model and audio I/O."""
import asyncio
from contextlib import contextmanager
import threading

from fastapi.testclient import TestClient
import httpx
import pytest
from sqlalchemy.orm import Session
from sqlalchemy.pool import StaticPool

from app.db import Base, create_database_engine, get_db
from app.main import app
from app.models.audio_file import AudioFile
from app.models.practice_record import PracticeRecord
from app.models.record_word_alignment import RecordWordAlignment
from app.schemas.audio import WordTimestamp
from app.schemas.practice import WordScore
from app.services.factory import get_alignment_service, get_scoring_service
from app.services.scoring.base import ScoringResult


@contextmanager
def client_for(session):
    app.dependency_overrides[get_db] = lambda: session
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


@pytest.fixture
def fk_db():
    engine = create_database_engine("sqlite:///:memory:", poolclass=StaticPool)
    Base.metadata.create_all(engine)
    with Session(engine) as session:
        yield session, engine
    engine.dispose()


def seed(session):
    audio = AudioFile(title="Word playback", source_type="upload", storage_backend="local",
                      file_path="synthetic/source.wav", sentences=[])
    session.add(audio)
    session.flush()
    record = PracticeRecord(audio_file_id=audio.id, sentence_index=0, sentence_text="Turn it on.",
        storage_backend="local", recording_path="synthetic/recording.webm")
    session.add(record)
    session.flush()
    return record


def install_local_mocks(monkeypatch, words=None, duration=2.0):
    calls, deleted = [], []

    class Storage:
        def get_absolute_path(self, key):
            return "/synthetic/recording.webm"
        def delete(self, key):
            deleted.append(key)

    class Alignment:
        def align(self, path, reference):
            calls.append((path, reference, threading.get_ident()))
            return words if words is not None else [WordTimestamp(word="Turn", start=.1, end=.5),
                WordTimestamp(word="it", start=.6, end=.8), WordTimestamp(word="on", start=.9, end=1.2)]

    alignment = Alignment()
    monkeypatch.setattr("app.api.routes.practice.get_storage_service", lambda _backend: Storage())
    monkeypatch.setattr("app.api.routes.practice.get_alignment_service", lambda: alignment)
    monkeypatch.setattr("app.api.routes.practice.read_recording_duration", lambda path: duration)
    return alignment, calls, deleted


def test_word_timings_do_not_require_scoring_and_cache_survives_reload(db, monkeypatch):
    record = seed(db)
    record_id = record.id
    _alignment, calls, _deleted = install_local_mocks(monkeypatch)
    with client_for(db) as client:
        first = client.get(f"/api/practice/record/{record_id}/word-timings")
        assert first.status_code == 200, first.text
        body = first.json()
        assert body == {"record_id": record_id, "source": "local_alignment", "duration": 2.0,
            "words": [{"word": "Turn", "start": .1, "end": .5}, {"word": "it", "start": .6, "end": .8},
                      {"word": "on", "start": .9, "end": 1.2}]}
    assert len(calls) == 1
    assert db.get(PracticeRecord, record_id).accuracy_score is None
    assert db.get(RecordWordAlignment, record_id).duration == 2.0
    db.expunge_all()
    def forbidden(*args, **kwargs):
        pytest.fail("cached playback must not load a model or read audio again")
    monkeypatch.setattr("app.api.routes.practice.get_alignment_service", forbidden)
    monkeypatch.setattr("app.api.routes.practice.read_recording_duration", forbidden)
    with client_for(db) as client:
        restored = client.get(f"/api/practice/record/{record_id}/word-timings")
        assert restored.status_code == 200 and restored.json() == body
        assert client.get("/api/practice/record/999999/word-timings").status_code == 404


def test_invalid_or_empty_alignment_does_not_invent_timestamps(db, monkeypatch):
    record = seed(db)
    invalid = [{"word": "bad", "start": -1, "end": .5}, {"word": "zero", "start": 0, "end": 0},
        {"word": "nan", "start": float("nan"), "end": .5}, {"word": "past-end", "start": 1, "end": 3},
        {"word": "missing", "start": None, "end": 1}]
    _alignment, calls, _deleted = install_local_mocks(monkeypatch, invalid)
    with client_for(db) as client:
        response = client.get(f"/api/practice/record/{record.id}/word-timings")
        assert response.status_code == 200, response.text
        assert response.json()["words"] == []
        assert response.json()["duration"] == 2
        assert client.get(f"/api/practice/record/{record.id}/word-timings").json()["words"] == []
    assert len(calls) == 1
    assert db.get(RecordWordAlignment, record.id).words == []


def test_existing_score_alignment_cache_only_needs_duration(db, monkeypatch):
    record = seed(db)
    db.add(RecordWordAlignment(record_id=record.id, words=[{"word": "Turn", "start": .1, "end": .5}], duration=None))
    db.flush()
    _alignment, calls, _deleted = install_local_mocks(monkeypatch, duration=1.7)
    with client_for(db) as client:
        response = client.get(f"/api/practice/record/{record.id}/word-timings")
        assert response.status_code == 200, response.text
        assert response.json()["duration"] == 1.7
        assert response.json()["words"] == [{"word": "Turn", "start": .1, "end": .5}]
    assert calls == []
    assert db.get(RecordWordAlignment, record.id).duration == 1.7


def test_local_scoring_populates_alignment_cache_then_reuses_it(db, monkeypatch):
    record = seed(db)
    alignment, calls, _deleted = install_local_mocks(monkeypatch)
    scored = []
    class Scoring:
        def score(self, path, text, words):
            scored.append((path, text, words))
            return ScoringResult(accuracy_score=80, fluency_score=85, completeness_score=100,
                word_scores=[WordScore(word="Turn", accuracy_score=80, expected_phonemes="t", actual_phonemes="t")])
    app.dependency_overrides[get_alignment_service] = lambda: alignment
    app.dependency_overrides[get_scoring_service] = lambda: Scoring()
    with client_for(db) as client:
        response = client.post(f"/api/practice/record/{record.id}/score")
        assert response.status_code == 200, response.text
        assert db.get(RecordWordAlignment, record.id) is not None
        assert client.get(f"/api/practice/record/{record.id}/word-timings").status_code == 200
        assert client.post(f"/api/practice/record/{record.id}/score").status_code == 200
    assert len(calls) == 1 and len(scored) == 2
    assert all(isinstance(word, WordTimestamp) for word in scored[1][2])


@pytest.mark.parametrize("stage", ["duration", "alignment"])
def test_errors_are_sanitized_and_failed_request_can_retry(fk_db, monkeypatch, stage):
    db, _engine = fk_db
    record = seed(db)
    db.commit()
    alignment, _calls, _deleted = install_local_mocks(monkeypatch)
    def broken(*args, **kwargs):
        raise RuntimeError("PRIVATE_PATH SECRET_TOKEN raw ffmpeg stderr")
    if stage == "duration":
        monkeypatch.setattr("app.api.routes.practice.read_recording_duration", broken)
    else:
        monkeypatch.setattr(alignment, "align", broken)
    with client_for(db) as client:
        response = client.get(f"/api/practice/record/{record.id}/word-timings")
        assert response.status_code == 503
        assert "PRIVATE_PATH" not in response.text and "SECRET_TOKEN" not in response.text
        assert db.get(RecordWordAlignment, record.id) is None
        install_local_mocks(monkeypatch)
        assert client.get(f"/api/practice/record/{record.id}/word-timings").status_code == 200


async def test_alignment_runs_in_threadpool_and_duplicate_get_does_not_run_model_twice(db, monkeypatch):
    record = seed(db)
    alignment, calls, _deleted = install_local_mocks(monkeypatch)
    started, release = threading.Event(), threading.Event()
    def blocking(path, reference):
        calls.append((path, reference, threading.get_ident()))
        started.set()
        assert release.wait(3)
        return [WordTimestamp(word="Turn", start=.1, end=.4)]
    monkeypatch.setattr(alignment, "align", blocking)
    app.dependency_overrides[get_db] = lambda: db
    task = None
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver") as client:
            task = asyncio.create_task(client.get(f"/api/practice/record/{record.id}/word-timings"))
            assert await asyncio.to_thread(started.wait, 2)
            duplicate = await client.get(f"/api/practice/record/{record.id}/word-timings")
            assert duplicate.status_code == 409
            assert len(calls) == 1 and calls[0][2] != threading.get_ident()
            release.set()
            assert (await task).status_code == 200
    finally:
        release.set()
        if task is not None:
            await task
        app.dependency_overrides.clear()


def test_record_deleted_during_alignment_cannot_create_orphan_cache(fk_db, monkeypatch):
    db, engine = fk_db
    record = seed(db)
    record_id = record.id
    db.commit()
    alignment, _calls, _deleted = install_local_mocks(monkeypatch)
    def delete_while_aligning(path, reference):
        with Session(engine) as other_session:
            other_session.delete(other_session.get(PracticeRecord, record_id))
            other_session.commit()
        return [WordTimestamp(word="Turn", start=.1, end=.4)]
    monkeypatch.setattr(alignment, "align", delete_while_aligning)
    with client_for(db) as client:
        response = client.get(f"/api/practice/record/{record_id}/word-timings")
        assert response.status_code == 404, response.text
    assert db.get(RecordWordAlignment, record_id) is None
    assert db.get(PracticeRecord, record_id) is None


def test_delete_record_cascades_cache_and_preserves_other_record(fk_db, monkeypatch):
    db, _engine = fk_db
    record, other = seed(db), seed(db)
    record_id, other_id = record.id, other.id
    _alignment, _calls, deleted = install_local_mocks(monkeypatch)
    with client_for(db) as client:
        for target in (record_id, other_id):
            assert client.get(f"/api/practice/record/{target}/word-timings").status_code == 200
        assert client.delete(f"/api/practice/record/{record_id}").status_code == 204
        assert client.get(f"/api/practice/record/{record_id}/word-timings").status_code == 404
    db.expire_all()
    assert db.get(RecordWordAlignment, record_id) is None
    assert db.get(RecordWordAlignment, other_id) is not None
    assert deleted == ["synthetic/recording.webm"]
