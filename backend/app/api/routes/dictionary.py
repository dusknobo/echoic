from fastapi import APIRouter, HTTPException
from app.schemas.dictionary import DictionaryEntry
from app.services.english_dictionary import DictionaryUnavailable, dictionary

router = APIRouter()


@router.get("/en/{word}", response_model=DictionaryEntry)
def english_definition(word: str):
    try:
        entry = dictionary.lookup(word)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail={"code": "invalid_word", "message": str(exc)}) from exc
    except DictionaryUnavailable as exc:
        raise HTTPException(status_code=503, detail={"code": "dictionary_unavailable", "message": str(exc)}) from exc
    if entry is None:
        raise HTTPException(status_code=404, detail={"code": "word_not_found", "word": word})
    return entry
