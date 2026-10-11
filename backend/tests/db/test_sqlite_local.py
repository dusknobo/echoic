from datetime import datetime

from sqlalchemy import inspect, text
from sqlalchemy.orm import Session

from app.db import create_database_engine, initialize_local_database
from app.models import AudioFile, ListeningMarker, PracticeRecord


def test_local_sqlite_initialization_preserves_json_records_and_enforces_foreign_keys(tmp_path):
    url = f"sqlite:///{(tmp_path / 'data' / 'echoic.db').as_posix()}"
    engine = create_database_engine(url)
    initialize_local_database(engine)
    assert set(inspect(engine).get_table_names()) >= {
        "audio_files", "collections", "practice_records", "oral_attempts", "listening_markers"
    }
    with Session(engine) as db:
        assert db.execute(text("PRAGMA foreign_keys")).scalar() == 1
        audio = AudioFile(
            title="Local lesson", source_type="upload", file_path="audio/local.mp3",
            sentences=[{"text": "Hello", "start": 0.0, "end": 1.0}],
        )
        db.add(audio)
        db.flush()
        audio_id = audio.id
        db.add(ListeningMarker(audio_file_id=audio_id, time=0.75, note="Review"))
        db.commit()
    engine.dispose()

    reopened = create_database_engine(url)
    initialize_local_database(reopened)
    try:
        with Session(reopened) as db:
            assert db.get(AudioFile, audio_id).sentences[0]["text"] == "Hello"
            assert db.query(ListeningMarker).one().time == 0.75
            db.delete(db.get(AudioFile, audio_id))
            db.commit()
            assert db.query(ListeningMarker).count() == 0
    finally:
        reopened.dispose()


def test_sqlite_streak_uses_dates_instead_of_raw_date_strings(tmp_path):
    from fastapi.testclient import TestClient
    from app.db import get_db
    from app.main import app

    engine = create_database_engine(f"sqlite:///{(tmp_path / 'stats.db').as_posix()}")
    initialize_local_database(engine)
    with Session(engine) as db:
        audio = AudioFile(title="Stats", source_type="upload", file_path="audio/stats.mp3")
        db.add(audio)
        db.flush()
        db.add(PracticeRecord(
            audio_file_id=audio.id, sentence_index=0, sentence_text="Hello",
            recording_path="recordings/stats.webm", created_at=datetime.utcnow(),
            accuracy_score=90, fluency_score=80, completeness_score=100,
        ))
        db.commit()

    def override_db():
        with Session(engine) as db:
            yield db

    app.dependency_overrides[get_db] = override_db
    try:
        with TestClient(app) as client:
            response = client.get("/api/stats/summary")
        assert response.status_code == 200
        assert response.json()["streak"] == 1
        assert response.json()["today"]["count"] == 1
    finally:
        app.dependency_overrides.clear()
        engine.dispose()


def test_local_initialization_upgrades_old_marker_table_without_deleting_data(tmp_path):
    import pytest
    from sqlalchemy.exc import IntegrityError

    engine = create_database_engine(f"sqlite:///{(tmp_path / 'old.db').as_posix()}")
    with engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE listening_markers (id INTEGER PRIMARY KEY, "
            "audio_file_id INTEGER NOT NULL, time FLOAT NOT NULL, "
            "note VARCHAR(2000) NOT NULL, created_at DATETIME NOT NULL)"
        )
        connection.exec_driver_sql(
            "INSERT INTO listening_markers VALUES (1, 1, 3.5, 'Keep me', '2026-10-11 01:00:00')"
        )
    initialize_local_database(engine)
    initialize_local_database(engine)
    try:
        with Session(engine) as db:
            old = db.get(ListeningMarker, 1)
            assert old.note == "Keep me"
            assert old.time == 3.5
            assert old.client_id is None
            db.add(AudioFile(id=1, title="Old", source_type="upload", file_path="old.mp3"))
            db.commit()
            db.add(ListeningMarker(audio_file_id=1, time=4, client_id="retry-id"))
            db.commit()
            db.add(ListeningMarker(audio_file_id=1, time=5, client_id="retry-id"))
            with pytest.raises(IntegrityError):
                db.flush()
            db.rollback()
    finally:
        engine.dispose()
