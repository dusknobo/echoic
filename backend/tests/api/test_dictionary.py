from fastapi import FastAPI
from fastapi.testclient import TestClient
import pytest

from app.api.routes.dictionary import router
from app.services.english_dictionary import DictionaryUnavailable


@pytest.fixture
def client():
    app = FastAPI()
    app.include_router(router, prefix="/api/dictionary")
    with TestClient(app) as client:
        yield client


def test_dictionary_response_has_english_definition(client):
    response = client.get("/api/dictionary/en/the")
    assert response.status_code == 200
    entry = response.json()
    assert entry["word"] == "the"
    assert entry["meanings"][0]["definitions"][0]["definition"]


def test_dictionary_rejects_invalid_query(client):
    response = client.get("/api/dictionary/en/two%20words")
    assert response.status_code == 422
    assert response.json()["detail"]["code"] == "invalid_word"


def test_missing_entry_has_specific_not_found_status(client, monkeypatch):
    monkeypatch.setattr("app.api.routes.dictionary.dictionary.lookup", lambda _word: None)
    response = client.get("/api/dictionary/en/notaword")
    assert response.status_code == 404
    assert response.json()["detail"]["code"] == "word_not_found"


def test_missing_corpus_has_retryable_service_status(client, monkeypatch):
    def unavailable(_word):
        raise DictionaryUnavailable("Missing corpus")
    monkeypatch.setattr("app.api.routes.dictionary.dictionary.lookup", unavailable)
    response = client.get("/api/dictionary/en/spring")
    assert response.status_code == 503
    assert response.json()["detail"]["code"] == "dictionary_unavailable"
