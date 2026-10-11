from datetime import datetime
from sqlalchemy import DateTime, Float, ForeignKey, Integer, JSON
from sqlalchemy.orm import Mapped, mapped_column
from app.db import Base


class RecordWordAlignment(Base):
    __tablename__ = "record_word_alignments"

    record_id: Mapped[int] = mapped_column(Integer, ForeignKey("practice_records.id", ondelete="CASCADE"), primary_key=True, autoincrement=False)
    words: Mapped[list] = mapped_column(JSON)
    # Scoring can cache aligned words before audio duration has been measured.
    duration: Mapped[float | None] = mapped_column(Float, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
