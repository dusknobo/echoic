from pathlib import Path
from uuid import uuid4

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session
from sqlalchemy.exc import IntegrityError
from starlette.concurrency import run_in_threadpool

from app.config import settings
from app.db import get_db
from app.models.audio_file import AudioFile
from app.models.practice_record import PracticeRecord
from app.models.record_word_alignment import RecordWordAlignment
from app.schemas.practice import PracticeRecordResponse, RecordWordTimingsResponse
from app.schemas.audio import WordTimestamp
from app.services.alignment.base import AlignmentService
from app.services.factory import get_alignment_service, get_scoring_service, get_storage_service
from app.services.scoring.base import ScoringService
from app.services.storage.base import StorageService
from app.services.record_word_alignment import model_lock, normalize_words, read_recording_duration, valid_duration

router = APIRouter()
_alignment_running: set[int] = set()


def _aligned_words(path, reference_text, alignment=None):
    with model_lock:
        service = alignment if alignment is not None else get_alignment_service()
        return service.align(path, reference_text)


def _timing_response(record_id, words, duration):
    return {"record_id": record_id, "source": "local_alignment",
            "words": normalize_words(words, duration), "duration": duration}


def _put_alignment_cache(db, record_id, words, duration=None):
    cache = db.get(RecordWordAlignment, record_id)
    if cache is None:
        cache = RecordWordAlignment(record_id=record_id, words=words, duration=duration)
        db.add(cache)
    else:
        cache.words = words
        if duration is not None:
            cache.duration = duration
    return cache


def _live_record(db, record_id):
    # Re-read after model work; a different tab may have deleted the recording.
    db.expire_all()
    record = db.get(PracticeRecord, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="录音已删除，定位结果未保存。")
    return record


def _recording_key(filename: str) -> str:
    suffix = Path(filename).suffix
    return f"recordings/{uuid4().hex}{suffix}"


def _sentence_text(audio_file: AudioFile, sentence_index: int) -> str:
    sentences = audio_file.sentences or []
    if sentence_index < 0 or sentence_index >= len(sentences):
        raise HTTPException(status_code=404, detail="sentence not found")

    text = str(sentences[sentence_index].get("text", "")).strip()
    if not text:
        raise HTTPException(status_code=404, detail="sentence not found")
    return text


@router.post("/{audio_file_id}/sentence/{sentence_index}/save", response_model=PracticeRecordResponse)
async def save_recording(
    audio_file_id: int,
    sentence_index: int,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    storage: StorageService = Depends(get_storage_service),
):
    """Save recording without scoring. Returns record with null scores."""
    audio_file = db.get(AudioFile, audio_file_id)
    if audio_file is None:
        raise HTTPException(status_code=404, detail="audio file not found")

    sentence_text = _sentence_text(audio_file, sentence_index)
    key = _recording_key(file.filename or "recording.bin")
    storage.save(await file.read(), key)

    record = PracticeRecord(
        audio_file_id=audio_file.id,
        sentence_index=sentence_index,
        sentence_text=sentence_text,
        storage_backend=settings.storage.backend,
        recording_path=key,
    )
    db.add(record)
    db.flush()
    db.refresh(record)
    return record


@router.post("/record/{record_id}/score", response_model=PracticeRecordResponse)
async def score_recording(
    record_id: int,
    db: Session = Depends(get_db),
    alignment: AlignmentService = Depends(get_alignment_service),
    scoring: ScoringService = Depends(get_scoring_service),
):
    """Run local scoring, reusing/preserving alignment for phrase playback."""
    record = db.get(PracticeRecord, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="record not found")
    if record_id in _alignment_running:
        raise HTTPException(status_code=409, detail="该录音正在定位或评分，请稍后重试。")
    _alignment_running.add(record_id)
    try:
        storage = get_storage_service(record.storage_backend)
        recording_path = storage.get_absolute_path(record.recording_path)
        reference_text = record.sentence_text
        cache = db.get(RecordWordAlignment, record_id)
        if cache is None:
            raw_words = await run_in_threadpool(_aligned_words, recording_path, reference_text, alignment)
            words = normalize_words(raw_words)
            duration = None
        else:
            duration = valid_duration(cache.duration)
            words = normalize_words(cache.words, duration)
        aligned_words = [WordTimestamp(**word) for word in words]
        result = await run_in_threadpool(scoring.score, recording_path, reference_text, aligned_words)
        record = _live_record(db, record_id)
        record.accuracy_score = result.accuracy_score
        record.fluency_score = result.fluency_score
        record.completeness_score = result.completeness_score
        record.word_scores = [ws.model_dump() for ws in result.word_scores]
        _put_alignment_cache(db, record_id, words, duration)
        db.commit()
        db.refresh(record)
        return record
    except HTTPException:
        raise
    except IntegrityError:
        db.rollback()
        if db.get(PracticeRecord, record_id) is None:
            raise HTTPException(status_code=404, detail="录音已删除，评分结果未保存。") from None
        raise HTTPException(status_code=409, detail="录音定位缓存已更新，请重试评分。") from None
    except Exception:
        db.rollback()
        raise HTTPException(status_code=503, detail="本地录音评分失败，请检查录音并稍后重试。") from None
    finally:
        _alignment_running.discard(record_id)


@router.get("/record/{record_id}/word-timings", response_model=RecordWordTimingsResponse)
async def recording_word_timings(record_id: int, db: Session = Depends(get_db)):
    """On-demand local alignment, independent of scores and paid AI services."""
    record = db.get(PracticeRecord, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="record not found")
    cache = db.get(RecordWordAlignment, record_id)
    duration = valid_duration(cache.duration) if cache is not None else None
    if cache is not None and duration is not None:
        return _timing_response(record_id, cache.words, duration)
    if record_id in _alignment_running:
        raise HTTPException(status_code=409, detail="该录音正在定位或评分，请稍后重试。")
    _alignment_running.add(record_id)
    try:
        storage = get_storage_service(record.storage_backend)
        recording_path = storage.get_absolute_path(record.recording_path)
        reference_text = record.sentence_text
        duration = await run_in_threadpool(read_recording_duration, recording_path)
        if valid_duration(duration) is None:
            raise ValueError("No valid recording duration")
        if cache is None:
            raw_words = await run_in_threadpool(_aligned_words, recording_path, reference_text)
        else:
            # Scores may already have cached word spans without decoded duration.
            raw_words = cache.words
        words = normalize_words(raw_words, duration)
        _live_record(db, record_id)
        _put_alignment_cache(db, record_id, words, duration)
        db.commit()
        return _timing_response(record_id, words, duration)
    except HTTPException:
        raise
    except IntegrityError:
        db.rollback()
        if db.get(PracticeRecord, record_id) is None:
            raise HTTPException(status_code=404, detail="录音已删除，定位结果未保存。") from None
        cache = db.get(RecordWordAlignment, record_id)
        if cache is not None and valid_duration(cache.duration) is not None:
            return _timing_response(record_id, cache.words, cache.duration)
        raise HTTPException(status_code=409, detail="录音定位缓存已更新，请稍后重试。") from None
    except Exception:
        db.rollback()
        raise HTTPException(status_code=503, detail="无法完成本地录音词定位，请检查录音并稍后重试。") from None
    finally:
        _alignment_running.discard(record_id)


@router.get("/record/{record_id}/stream")
async def stream_recording(record_id: int, db: Session = Depends(get_db)):
    record = db.get(PracticeRecord, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="record not found")
    storage = get_storage_service(record.storage_backend)
    path = storage.get_absolute_path(record.recording_path)
    # Host MIME databases can label .m4a as LATM instead of its MP4 container.
    media_type = "audio/mp4" if Path(path).suffix.lower() == ".m4a" else None
    return FileResponse(path, media_type=media_type)


@router.delete("/record/{record_id}", status_code=204)
async def delete_recording(record_id: int, db: Session = Depends(get_db)):
    record = db.get(PracticeRecord, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="record not found")
    storage = get_storage_service(record.storage_backend)
    try:
        storage.delete(record.recording_path)
    except Exception:
        pass
    db.delete(record)
    db.commit()


@router.get("/{audio_file_id}/sentence/{sentence_index}/history", response_model=list[PracticeRecordResponse])
async def get_sentence_history(
    audio_file_id: int,
    sentence_index: int,
    db: Session = Depends(get_db),
):
    return (
        db.query(PracticeRecord)
        .filter(
            PracticeRecord.audio_file_id == audio_file_id,
            PracticeRecord.sentence_index == sentence_index,
        )
        .order_by(PracticeRecord.created_at.desc())
        .all()
    )
