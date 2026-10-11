"""Exercise the real native transcription, alignment and scoring pipeline."""
from pathlib import Path
import json
import requests
requests = requests.Session()
requests.trust_env = False

ROOT = Path(__file__).resolve().parents[1]
BASE = "http://127.0.0.1:18765"
fixture = ROOT / ".runtime" / "qa" / "reference.wav"
with fixture.open("rb") as audio:
    response = requests.post(BASE + "/api/audio/upload",
        files={"file": ("Echoic-demo.wav", audio, "audio/wav")}, timeout=240)
response.raise_for_status()
item = response.json()
print("Transcription:", item["id"], [(s["index"], s["text"]) for s in item["sentences"]], flush=True)
assert item["sentences"], item
(ROOT / ".runtime" / "qa" / "audio.json").write_text(json.dumps(item, ensure_ascii=False, indent=2), encoding="utf-8")
# Cut one actual sentence from the reference to exercise the full scoring path.
import soundfile as sf
samples, rate = sf.read(fixture)
sentence = item["sentences"][0]
cut = ROOT / ".runtime" / "qa" / "sentence.wav"
sf.write(cut, samples[int(sentence["start"] * rate):int(sentence["end"] * rate)], rate)
with cut.open("rb") as audio:
    response = requests.post(BASE + f'/api/practice/{item["id"]}/sentence/0/save',
        files={"file": ("sentence.wav", audio, "audio/wav")}, timeout=30)
response.raise_for_status()
record = response.json()
print("Recording saved:", record["id"], flush=True)
response = requests.post(BASE + f'/api/practice/record/{record["id"]}/score', timeout=300)
response.raise_for_status()
result = response.json()
(ROOT / ".runtime" / "qa" / "score.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
assert result["accuracy_score"] > 0, result
assert result["word_scores"] and any(w.get("phoneme_scores") for w in result["word_scores"]), result
print("Scoring:", {k: result[k] for k in ("accuracy_score", "fluency_score", "completeness_score")}, flush=True)
