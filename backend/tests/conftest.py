import pytest
import os
import json
import subprocess
from pathlib import Path
from sqlalchemy import create_engine
from sqlalchemy.pool import StaticPool
from sqlalchemy.orm import sessionmaker
from app.db import Base
import app.models  # noqa: F401


@pytest.fixture(scope="session")
def db_engine():
    engine = create_engine(
        "sqlite:///:memory:",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    yield engine
    engine.dispose()


@pytest.fixture
def db(db_engine):
    connection = db_engine.connect()
    transaction = connection.begin()
    Session = sessionmaker(bind=connection)
    session = Session()
    try:
        yield session
    finally:
        session.close()
        transaction.rollback()
        connection.close()


@pytest.fixture
def tmp_storage(tmp_path):
    return tmp_path / "storage"


def _mp4_cases():
    cases = [("aac.m4a", "audio/mp4", False),
             ("fragmented.m4a", "audio/mp4;codecs=mp4a.40.2", True),
             ("aac.mp4", "video/mp4", False)]
    capture_dir = os.environ.get("ECHOIC_QA_CAPTURE_DIR")
    if capture_dir:
        for name in ("practice", "background", "device-ended", "oral"):
            path = Path(capture_dir).resolve() / f"{name}.m4a"
            if not path.is_file():
                raise RuntimeError(f"Required native WebKit capture is missing: {path}")
            cases.append((str(path), "audio/mp4", False))
    return cases


@pytest.fixture(scope="session", params=_mp4_cases(), ids=lambda case: Path(case[0]).name)
def mp4_recording(request, tmp_path_factory):
    """Real AAC, including fragmented MP4; optionally native browser artifacts.

    FFmpeg is a required gate, not a silently skipped compatibility test.
    These tones test media plumbing, not speech or pronunciation accuracy.
    """
    filename, mime, fragmented = request.param
    source = Path(filename)
    if not source.is_absolute():
        source = tmp_path_factory.mktemp("mp4") / filename
        subprocess.run([
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "sine=frequency=240:sample_rate=44100:duration=1.5",
            "-c:a", "aac", "-movflags", "frag_keyframe+empty_moov+default_base_moof" if fragmented else "+faststart",
            str(source),
        ], check=True, capture_output=True, timeout=30)
    data = source.read_bytes()
    assert data[4:8] == b"ftyp"
    probe = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries", "stream=codec_name", "-of", "json", str(source),
    ], check=True, capture_output=True, text=True, timeout=30)
    assert json.loads(probe.stdout)["streams"][0]["codec_name"] == "aac"
    if fragmented:
        assert b"moof" in data
    return source.name, data, mime
