from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

from app.services.english_dictionary import DictionaryUnavailable, EnglishDictionary, normalize_word


@pytest.mark.parametrize(("raw", "expected"), [
    (" Spring, ", "spring"), ("DON’T", "don't"), ("“Hello!”", "hello"),
    ("mother-in-law", "mother-in-law"), ("Ｓｐｒｉｎｇ", "spring"),
])
def test_normalize_transcript_words(raw, expected):
    assert normalize_word(raw) == expected


@pytest.mark.parametrize("raw", ["", "   ", "123", "two words", "a/b", "../foo", "中文", "a" * 65])
def test_reject_non_words_and_paths(raw):
    with pytest.raises(ValueError):
        normalize_word(raw)


def test_common_function_words_and_contractions_do_not_require_wordnet(tmp_path):
    dictionary = EnglishDictionary(tmp_path / "missing")
    assert dictionary.lookup("The,")["meanings"][0]["partOfSpeech"] == "article"
    contraction = dictionary.lookup("DON’T")
    assert contraction["source"] == "Echoic usage notes"
    assert "do not" in contraction["meanings"][0]["definitions"][0]["definition"]
    assert dictionary.lookup("i")["word"] == "I"


def test_missing_dictionary_is_unavailable_instead_of_not_found(tmp_path):
    dictionary = EnglishDictionary(tmp_path / "missing")
    with pytest.raises(DictionaryUnavailable, match="missing"):
        dictionary.lookup("spring")


@pytest.fixture(scope="module")
def local_dictionary():
    dictionary = EnglishDictionary()
    if not (dictionary.data_dir / "corpora" / "wordnet.zip").exists():
        pytest.skip("Optional local corpus; run python prepare_dictionary.py for integration lookup checks")
    return dictionary


@pytest.mark.parametrize(("query", "canonical"), [("dogs", "dog"), ("bought", "buy"), ("seasons", "season"), ("children's", "child")])
def test_real_wordnet_inflections(local_dictionary, query, canonical):
    entry = local_dictionary.lookup(query)
    assert entry["word"] == canonical
    assert entry["query"] == query
    assert entry["source"] == "Princeton WordNet 3.0"
    assert all(meaning["definitions"] for meaning in entry["meanings"])


def test_real_wordnet_unknown_word_returns_no_entry(local_dictionary):
    assert local_dictionary.lookup("qzxqzxqzx") is None


def test_real_wordnet_keeps_definitions_examples_and_synonyms(local_dictionary):
    entry = local_dictionary.lookup("spring")
    noun = next(meaning for meaning in entry["meanings"] if meaning["partOfSpeech"] == "noun")
    assert any("season" in sense["definition"] for sense in noun["definitions"])
    assert any(sense["examples"] for meaning in entry["meanings"] for sense in meaning["definitions"])
    assert any(sense["synonyms"] for meaning in entry["meanings"] for sense in meaning["definitions"])


def test_concurrent_reader_requests_return_correct_words(local_dictionary):
    # Reader data-file cursors are shared by NLTK; simultaneous API requests must
    # not cross-read byte offsets or corrupt the lazily initialized corpus.
    words = ["winter", "walked", "children", "books", "quickly", "green"] * 3
    with ThreadPoolExecutor(max_workers=6) as executor:
        entries = list(executor.map(local_dictionary.lookup, words))
    assert [entry["query"] for entry in entries] == words
    assert all(entry["meanings"] for entry in entries)
