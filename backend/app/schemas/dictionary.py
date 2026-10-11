from pydantic import BaseModel


class WordDefinition(BaseModel):
    definition: str
    examples: list[str]
    synonyms: list[str]


class WordMeaning(BaseModel):
    partOfSpeech: str
    definitions: list[WordDefinition]


class DictionaryEntry(BaseModel):
    word: str
    query: str
    source: str
    meanings: list[WordMeaning]
