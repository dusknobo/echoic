from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db import get_db
from app.models.audio_file import AudioFile
from app.models.listening_marker import ListeningMarker
from app.schemas.listening_marker import (
    ListeningMarkerCreate,
    ListeningMarkerResponse,
    ListeningMarkerUpdate,
)

router = APIRouter()


def _require_audio(db: Session, audio_file_id: int) -> None:
    if db.get(AudioFile, audio_file_id) is None:
        raise HTTPException(status_code=404, detail="audio file not found")


def _require_marker(db: Session, audio_file_id: int, marker_id: int) -> ListeningMarker:
    _require_audio(db, audio_file_id)
    marker = db.query(ListeningMarker).filter(
        ListeningMarker.id == marker_id,
        ListeningMarker.audio_file_id == audio_file_id,
    ).one_or_none()
    if marker is None:
        raise HTTPException(status_code=404, detail="listening marker not found")
    return marker


@router.get("/{audio_file_id}/markers", response_model=list[ListeningMarkerResponse])
def list_markers(audio_file_id: int, db: Session = Depends(get_db)):
    _require_audio(db, audio_file_id)
    return db.query(ListeningMarker).filter(
        ListeningMarker.audio_file_id == audio_file_id
    ).order_by(ListeningMarker.time, ListeningMarker.id).all()


@router.post("/{audio_file_id}/markers", response_model=ListeningMarkerResponse, status_code=201)
def create_marker(
    audio_file_id: int,
    payload: ListeningMarkerCreate,
    db: Session = Depends(get_db),
):
    _require_audio(db, audio_file_id)
    def saved_marker():
        if payload.client_id is None:
            return None
        return db.query(ListeningMarker).filter(
            ListeningMarker.audio_file_id == audio_file_id,
            ListeningMarker.client_id == payload.client_id,
        ).one_or_none()

    if (existing := saved_marker()) is not None:
        return existing
    marker = ListeningMarker(audio_file_id=audio_file_id, **payload.model_dump())
    db.add(marker)
    try:
        db.flush()
    except IntegrityError:
        # A concurrent retry may have saved the same client ID first.
        db.rollback()
        existing = saved_marker()
        if existing is None:
            raise
        return existing
    db.refresh(marker)
    return marker


@router.patch("/{audio_file_id}/markers/{marker_id}", response_model=ListeningMarkerResponse)
def update_marker(
    audio_file_id: int,
    marker_id: int,
    payload: ListeningMarkerUpdate,
    db: Session = Depends(get_db),
):
    marker = _require_marker(db, audio_file_id, marker_id)
    marker.note = payload.note
    db.flush()
    db.refresh(marker)
    return marker


@router.delete("/{audio_file_id}/markers/{marker_id}", status_code=204)
def delete_marker(audio_file_id: int, marker_id: int, db: Session = Depends(get_db)):
    marker = _require_marker(db, audio_file_id, marker_id)
    db.delete(marker)
    db.flush()
    return Response(status_code=204)
