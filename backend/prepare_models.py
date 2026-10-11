"""Download and validate all models needed for English shadowing."""
from local_runtime import configure
configure()

from app.services.factory import get_asr_service, get_alignment_service, get_scoring_service

print("Loading English transcription model...", flush=True)
get_asr_service()
print("Loading word-alignment model...", flush=True)
get_alignment_service()
print("Loading pronunciation model...", flush=True)
scorer = get_scoring_service()
if not scorer._load_model():
    raise RuntimeError("Pronunciation model could not be downloaded/loaded")
ipa = scorer.phonemize_words(["Hello", "weather"])
if not ipa or ipa == ["hello", "weather"]:
    raise RuntimeError("eSpeak did not return phonetic symbols")
print("Ready: English transcription, alignment, phoneme scoring and eSpeak.", flush=True)
