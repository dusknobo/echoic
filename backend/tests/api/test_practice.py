from contextlib import contextmanager
from datetime import datetime, timedelta
from pathlib import Path
import mimetypes

import pytest

from fastapi.testclient import TestClient

from app.db import get_db
from app.main import app
from app.models.audio_file import AudioFile
from app.models.practice_record import PracticeRecord
from app.schemas.audio import WordTimestamp
from app.schemas.practice import WordScore
from app.services.factory import get_alignment_service, get_scoring_service, get_storage_service
from app.services.scoring.base import ScoringResult
from app.config import StorageConfig
from app.services.storage.local import LocalStorageService
from app.services.record_word_alignment import read_recording_duration


class MockStorageService:
    def __init__(self):
        self.saved = []

    def save(self, data: bytes, key: str) -> str:
        self.saved.append((key, data))
        return key

    def load(self, key: str) -> bytes:
        return b""

    def delete(self, key: str) -> None:
        return None

    def get_absolute_path(self, key: str) -> str:
        return f"/tmp/{key}"


class MockAlignmentService:
    def __init__(self):
        self.calls = []

    def align(self, audio_path: str, reference_text: str) -> list[WordTimestamp]:
        self.calls.append((audio_path, reference_text))
        return [WordTimestamp(word="hello", start=0.0, end=0.5)]


class MockScoringService:
    def __init__(self):
        self.calls = []

    def score(self, recording_path: str, reference_text: str, aligned_words: list[WordTimestamp]) -> ScoringResult:
        self.calls.append((recording_path, reference_text, aligned_words))
        return ScoringResult(
            accuracy_score=91.0,
            fluency_score=82.0,
            completeness_score=100.0,
            word_scores=[WordScore(word="hello", accuracy_score=91.0, expected_phonemes="hɛloʊ", actual_phonemes="hɛloʊ", phoneme_scores=[90.0])],
        )


@contextmanager
def _client(db, storage, alignment, scoring, *, commit_requests=False):
    def override_db():
        yield db
        if commit_requests:
            db.commit()

    app.dependency_overrides[get_db] = override_db
    app.dependency_overrides[get_storage_service] = lambda: storage
    app.dependency_overrides[get_alignment_service] = lambda: alignment
    app.dependency_overrides[get_scoring_service] = lambda: scoring
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.clear()


def _seed_audio_file(db) -> AudioFile:
    audio_file = AudioFile(
        title="Lesson",
        source_type="upload",
        storage_backend="local",
        file_path="audio/lesson.mp3",
        sentences=[
            {"index": 0, "text": "hello world", "start": 0.0, "end": 1.0, "words": []},
            {"index": 1, "text": "second sentence", "start": 1.0, "end": 2.0, "words": []},
        ],
    )
    db.add(audio_file)
    db.flush()
    return audio_file


def test_save_then_score_recording_persists_record(db, monkeypatch):
    audio_file = _seed_audio_file(db)
    storage = MockStorageService()
    alignment = MockAlignmentService()
    scoring = MockScoringService()
    monkeypatch.setattr("app.api.routes.practice.get_storage_service", lambda _backend: storage)

    with _client(db, storage, alignment, scoring) as client:
        response = client.post(
            f"/api/practice/{audio_file.id}/sentence/0/save",
            files={"file": ("attempt.webm", b"recording-bytes", "audio/webm")},
        )
        assert response.status_code == 200
        saved = response.json()
        assert saved["accuracy_score"] is None
        assert saved["word_scores"] is None
        assert alignment.calls == []
        response = client.post(f"/api/practice/record/{saved['id']}/score")

    assert response.status_code == 200
    body = response.json()
    assert body["audio_file_id"] == audio_file.id
    assert body["sentence_index"] == 0
    assert body["sentence_text"] == "hello world"
    assert body["accuracy_score"] == 91.0
    assert body["fluency_score"] == 82.0
    assert body["completeness_score"] == 100.0
    assert body["word_scores"][0]["word"] == "hello"

    assert storage.saved[0][1] == b"recording-bytes"
    stored_key = storage.saved[0][0]
    assert alignment.calls == [(f"/tmp/{stored_key}", "hello world")]
    assert scoring.calls[0][0] == f"/tmp/{stored_key}"
    assert scoring.calls[0][1] == "hello world"

    record = db.get(PracticeRecord, body["id"])
    assert record.recording_path == stored_key
    assert record.word_scores == [{"word": "hello", "accuracy_score": 91.0, "expected_phonemes": "hɛloʊ", "actual_phonemes": "hɛloʊ", "phoneme_scores": [90.0]}]


def test_submit_recording_returns_404_for_unknown_audio_file(db):
    with _client(db, MockStorageService(), MockAlignmentService(), MockScoringService()) as client:
        response = client.post(
            "/api/practice/9999/sentence/0/save",
            files={"file": ("attempt.webm", b"recording-bytes", "audio/webm")},
        )

    assert response.status_code == 404
    assert response.json()["detail"] == "audio file not found"


def test_history_returns_records_in_reverse_chronological_order(db):
    audio_file = _seed_audio_file(db)
    older = PracticeRecord(
        audio_file_id=audio_file.id,
        sentence_index=0,
        sentence_text="hello world",
        storage_backend="local",
        recording_path="recordings/older.webm",
        accuracy_score=80.0,
        fluency_score=75.0,
        completeness_score=90.0,
        word_scores=[{"word": "hello", "accuracy_score": 80.0, "expected_phonemes": "hɛloʊ", "actual_phonemes": "hɛloʊ"}],
        created_at=datetime.utcnow(),
    )
    newer = PracticeRecord(
        audio_file_id=audio_file.id,
        sentence_index=0,
        sentence_text="hello world",
        storage_backend="local",
        recording_path="recordings/newer.webm",
        accuracy_score=92.0,
        fluency_score=88.0,
        completeness_score=100.0,
        word_scores=[{"word": "hello", "accuracy_score": 92.0, "expected_phonemes": "hɛloʊ", "actual_phonemes": "hɛloʊ"}],
        created_at=datetime.utcnow() + timedelta(seconds=5),
    )
    other_sentence = PracticeRecord(
        audio_file_id=audio_file.id,
        sentence_index=1,
        sentence_text="second sentence",
        storage_backend="local",
        recording_path="recordings/other.webm",
        accuracy_score=70.0,
        fluency_score=70.0,
        completeness_score=70.0,
        word_scores=[],
    )
    db.add_all([older, newer, other_sentence])
    db.flush()

    with _client(db, MockStorageService(), MockAlignmentService(), MockScoringService()) as client:
        response = client.get(f"/api/practice/{audio_file.id}/sentence/0/history")

    assert response.status_code == 200
    assert [item["accuracy_score"] for item in response.json()] == [92.0, 80.0]


class DecodingScoringService(MockScoringService):
    """Real media decode at the model boundary, deterministic model output."""
    def score(self, recording_path, reference_text, aligned_words, **_kwargs):
        assert read_recording_duration(recording_path) > 0.1
        return super().score(recording_path, reference_text, aligned_words)


@pytest.fixture
def media_db(tmp_path):
    # Real request commits/rollbacks without the outer transaction of `db`.
    from sqlalchemy import create_engine
    from sqlalchemy.orm import Session
    from app.db import Base
    engine = create_engine(f"sqlite:///{tmp_path / 'media.sqlite'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    try:
        with Session(engine) as session:
            yield session
    finally:
        engine.dispose()


def _assert_media_stream(client, url, data):
    response = client.get(url)
    assert response.status_code == 200
    assert response.content == data
    assert response.headers["content-type"].split(";")[0] in {"audio/mp4", "audio/x-m4a", "video/mp4"}
    # Safari media loading/seeking may request byte ranges.
    response = client.get(url, headers={"Range": "bytes=0-31"})
    assert response.status_code == 206
    assert response.content == data[:32]
    assert response.headers["content-range"] == f"bytes 0-31/{len(data)}"


@pytest.fixture
def misleading_m4a_mime(monkeypatch):
    # Reproduce macOS/host MIME databases on every CI platform. MP4 containers
    # must not inherit the distinct LATM transport type from an extension guess.
    mimetypes.init()
    monkeypatch.setitem(mimetypes.types_map, ".m4a", "audio/mp4a-latm")


@pytest.mark.media
@pytest.mark.usefixtures("misleading_m4a_mime")
def test_mp4_save_stream_score_failure_and_retry(media_db, tmp_storage, monkeypatch, mp4_recording):
    db = media_db
    audio_file = _seed_audio_file(db)
    storage = LocalStorageService(StorageConfig(local_dir=str(tmp_storage)))
    alignment = MockAlignmentService()
    scoring = DecodingScoringService()
    monkeypatch.setattr("app.api.routes.practice.get_storage_service", lambda _backend: storage)
    filename, data, mime = mp4_recording
    with _client(db, storage, alignment, scoring, commit_requests=True) as client:
        response = client.post(f"/api/practice/{audio_file.id}/sentence/0/save", files={"file": mp4_recording})
        assert response.status_code == 200
        saved = response.json()
        record = db.get(PracticeRecord, saved["id"])
        key = record.recording_path
        assert Path(key).suffix == Path(filename).suffix
        assert storage.load(key) == data
        assert saved["accuracy_score"] is None and not scoring.calls and not alignment.calls
        _assert_media_stream(client, f"/api/practice/record/{record.id}/stream", data)
        real_score = scoring.score
        def unavailable(*args, **kwargs):
            raise RuntimeError("Model unavailable")
        monkeypatch.setattr(scoring, "score", unavailable)
        response = client.post(f"/api/practice/record/{record.id}/score")
        assert response.status_code == 503
        db.refresh(record)
        assert record.accuracy_score is None
        _assert_media_stream(client, f"/api/practice/record/{record.id}/stream", data)
        monkeypatch.setattr(scoring, "score", real_score)
        response = client.post(f"/api/practice/record/{record.id}/score")
        assert response.status_code == 200
        assert response.json()["accuracy_score"] == 91
        history = client.get(f"/api/practice/{audio_file.id}/sentence/0/history").json()
        assert [item["id"] for item in history] == [saved["id"]]
        assert history[0]["accuracy_score"] == 91
    assert scoring.calls[0][0] == storage.get_absolute_path(key)
    assert storage.load(key) == data
    assert len(list(tmp_storage.rglob("*.*"))) == 1


@pytest.mark.media
@pytest.mark.usefixtures("misleading_m4a_mime")
def test_mp4_oral_upload_decode_score_and_stream(media_db, tmp_storage, monkeypatch, mp4_recording):
    db = media_db
    from app.services.factory import get_llm_service
    from app.models.oral_attempt import OralAttempt
    storage = LocalStorageService(StorageConfig(local_dir=str(tmp_storage)))
    alignment = MockAlignmentService()
    scoring = DecodingScoringService()
    monkeypatch.setattr("app.api.routes.oral.get_storage_service", lambda _backend: storage)
    monkeypatch.setattr("app.api.routes.oral.get_alignment_service", lambda _language: alignment)
    monkeypatch.setattr("app.api.routes.oral.get_asr_service", lambda _language: None)
    with _client(db, storage, alignment, scoring, commit_requests=True) as client:
        # read_aloud does not use ASR/LLM; never instantiate a paid provider.
        app.dependency_overrides[get_llm_service] = lambda: None
        response = client.post("/api/oral/attempts", files={"file": mp4_recording}, data={
            "question_type": "read_aloud", "question_language": "en",
            "question_prompt": "Read this", "question_reference": "hello world",
        })
        assert response.status_code == 200
        result = response.json()
        assert result["accuracy_score"] == 91
        attempt = db.get(OralAttempt, result["id"])
        assert Path(attempt.recording_path).suffix == Path(mp4_recording[0]).suffix
        assert scoring.calls[0][0] == storage.get_absolute_path(attempt.recording_path)
        _assert_media_stream(client, f"/api/oral/attempts/{attempt.id}/stream", mp4_recording[1])
