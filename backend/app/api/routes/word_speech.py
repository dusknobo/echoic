from fastapi import APIRouter, HTTPException, Response

from app.services.word_speech import WordSpeechBusy, WordSpeechUnavailable, english_word_wav

router = APIRouter()


@router.get("/en/{word}", responses={200: {"content": {"audio/wav": {}}}})
def pronounce_english_word(word: str):
    """Speak one English word locally, without cloud TTS or installed OS voices."""
    try:
        audio = english_word_wav(word)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except WordSpeechBusy as exc:
        raise HTTPException(status_code=503, detail=str(exc), headers={"Retry-After": "1"}) from exc
    except WordSpeechUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return Response(audio, media_type="audio/wav", headers={
        "Cache-Control": "private, max-age=604800",
        "X-Content-Type-Options": "nosniff",
    })
