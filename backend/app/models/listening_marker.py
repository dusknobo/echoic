from datetime import datetime

from sqlalchemy import CheckConstraint, DateTime, Float, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class ListeningMarker(Base):
    __tablename__ = "listening_markers"
    __table_args__ = (
        CheckConstraint("time >= 0 AND time <= 604800", name="ck_listening_marker_time"),
        Index("ix_listening_markers_audio_time", "audio_file_id", "time"),
        UniqueConstraint("audio_file_id", "client_id", name="uq_listening_markers_audio_client"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    audio_file_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("audio_files.id", ondelete="CASCADE"), nullable=False
    )
    client_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    time: Mapped[float] = mapped_column(Float, nullable=False)
    note: Mapped[str] = mapped_column(String(2000), default="", nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, nullable=False)
