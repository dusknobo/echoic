from datetime import datetime
from typing import Literal
from pydantic import BaseModel, ConfigDict
from app.schemas.audio import WordTimestamp


class WordScore(BaseModel):
    word: str
    accuracy_score: float
    expected_phonemes: str
    actual_phonemes: str
    phoneme_scores: list[float] = []  # per-phoneme score for each char in expected_phonemes (stress markers excluded)


class PracticeRecordResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    audio_file_id: int
    sentence_index: int
    sentence_text: str
    accuracy_score: float | None
    fluency_score: float | None
    completeness_score: float | None
    word_scores: list[WordScore] | None
    created_at: datetime


class HeatmapEntry(BaseModel):
    date: str  # YYYY-MM-DD
    count: int
    avg_score: float | None


class RecordWordTimingsResponse(BaseModel):
    record_id: int
    source: Literal["local_alignment"] = "local_alignment"
    words: list[WordTimestamp]
    duration: float
