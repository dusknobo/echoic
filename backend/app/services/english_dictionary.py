"""Offline English definitions from Princeton WordNet and local usage notes.

Lookup never downloads data. Run ``python prepare_dictionary.py`` once during setup.
NLTK readers retain mutable file cursors, so reads and lazy initialization share a lock.
"""
from functools import lru_cache
import json
import os
from pathlib import Path
import re
from threading import RLock
import unicodedata
from zipfile import BadZipFile


class DictionaryUnavailable(RuntimeError):
    pass


def normalize_word(word: str) -> str:
    word = unicodedata.normalize("NFKC", word).replace("’", "'").replace("‘", "'")
    word = word.strip().strip(".,!?;:\"'()[]{}<>“”‘’").lower()
    if len(word) > 64 or not re.fullmatch(r"[a-z]+(?:['-][a-z]+)*", word):
        raise ValueError("Enter one English word, up to 64 characters.")
    return word


class EnglishDictionary:
    def __init__(self, data_dir: Path | None = None):
        self.data_dir = data_dir or Path(os.environ.get(
            "ECHOIC_NLTK_DATA", Path(__file__).resolve().parents[3] / ".runtime" / "nltk_data"
        ))
        self._lock = RLock()
        self._reader = None
        self._usage = json.loads(Path(__file__).with_name("word_usage.json").read_text(encoding="utf-8"))

    def _load_reader(self):
        if self._reader is not None:
            return self._reader
        if not ((self.data_dir / "corpora" / "wordnet.zip").is_file()
                or (self.data_dir / "corpora" / "wordnet" / "index.noun").is_file()):
            raise DictionaryUnavailable("Local WordNet data is missing. Run backend/prepare_dictionary.py.")
        try:
            import nltk.data
            # WordNet's own reader also refers to this shared loader internally.
            directory = str(self.data_dir.resolve())
            if directory not in nltk.data.path:
                nltk.data.path.insert(0, directory)
            from nltk.corpus import wordnet
            wordnet.ensure_loaded()
            self._reader = wordnet
        except (ImportError, LookupError, OSError, ValueError, BadZipFile) as exc:
            raise DictionaryUnavailable("Local English dictionary could not be loaded.") from exc
        return self._reader

    def lookup(self, word: str) -> dict | None:
        query = normalize_word(word)
        with self._lock:
            return self._lookup(query)

    @lru_cache(maxsize=2048)
    def _lookup(self, query: str) -> dict | None:
        usage = self._usage.get(query)
        if usage:
            return {
                "query": query, "word": usage.get("word", query),
                "source": "Echoic usage notes",
                "meanings": [{
                    "partOfSpeech": usage["partOfSpeech"],
                    "definitions": [{"definition": usage["definition"],
                                     "examples": usage.get("examples", []), "synonyms": []}],
                }],
            }
        reader = self._load_reader()
        grouped = {}
        forms = []
        pos_labels = {"n": "noun", "v": "verb", "a": "adjective", "s": "adjective", "r": "adverb"}
        try:
            lookup_query = query
            synsets = reader.synsets(lookup_query)
            # WordNet handles noun/verb inflections and irregular exception lists.
            if not synsets and query.endswith("'s"):
                lookup_query = query[:-2]
                synsets = reader.synsets(lookup_query)
            for pos in ("n", "v", "a", "r"):
                form = reader.morphy(lookup_query, pos)
                if form and form not in forms:
                    forms.append(form)
            for synset in synsets:
                label = pos_labels[synset.pos()]
                definitions = grouped.setdefault(label, [])
                if len(definitions) >= 6:
                    continue
                definition = synset.definition()
                if any(item["definition"] == definition for item in definitions):
                    continue
                synonyms = []
                for lemma in synset.lemma_names():
                    lemma = lemma.replace("_", " ")
                    if lemma.lower() not in {query, *forms} and lemma not in synonyms:
                        synonyms.append(lemma)
                definitions.append({"definition": definition,
                                    "examples": synset.examples()[:2], "synonyms": synonyms[:6]})
        except (LookupError, OSError, ValueError, BadZipFile) as exc:
            raise DictionaryUnavailable("Local English dictionary could not be read.") from exc
        if not grouped:
            return None
        return {
            "query": query, "word": query if query in forms else (forms[0] if forms else query),
            "source": "Princeton WordNet 3.0",
            "meanings": [{"partOfSpeech": pos, "definitions": definitions}
                         for pos, definitions in grouped.items()],
        }


dictionary = EnglishDictionary()
