from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class ListeningMarkerCreate(BaseModel):
    # Audio duration is not stored upstream. Do not guess it from spoken text.
    time: float = Field(ge=0, le=604800, allow_inf_nan=False)
    note: str = Field(default="", max_length=2000)
    client_id: str | None = Field(default=None, min_length=1, max_length=64)


class ListeningMarkerUpdate(BaseModel):
    note: str = Field(max_length=2000)


class ListeningMarkerResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    time: float
    note: str
    created_at: datetime
    client_id: str | None = None
