"""Import a downloaded series and transcribe without blocking Echoic's web server."""
from __future__ import annotations
import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / "backend"))
# All required models were prepared during installation.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
from local_runtime import configure
configure()

from sqlalchemy import select
from app.db import SessionLocal
from app.models.audio_file import AudioFile
from app.models.collection import Collection
from app.services.factory import get_asr_service, get_storage_service

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--collection", required=True)
    args = parser.parse_args()
    manifest = args.manifest.resolve()
    source = json.loads(manifest.read_text(encoding="utf-8"))
    entries = source["episodes"]
    if not entries or any(e["status"] != "ready" for e in entries):
        raise RuntimeError("The complete, validated audio download is required")
    bvid = source["bvid"]
    state_path = PROJECT / ".runtime" / "imports" / f"{bvid}.json"
    state_path.parent.mkdir(parents=True, exist_ok=True)
    # An OS lock prevents simultaneous runs from creating duplicate imports.
    lock = state_path.with_suffix(".lock").open("a+b")
    lock.seek(0)
    lock.write(b"1")
    lock.flush()
    lock.seek(0)
    if os.name == "nt":
        import msvcrt
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    else:
        import fcntl
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    previous = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else {}
    rows = {r["page"]: r for r in previous.get("episodes", [])}
    state = {"bvid": bvid, "collection_name": args.collection, "status": "importing", "started_at": time.time()}

    def save_state():
        state["episodes"] = sorted(rows.values(), key=lambda row: row["page"])
        state["completed"] = sum(row.get("status") == "ready" for row in rows.values())
        state["updated_at"] = time.time()
        temporary = state_path.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(state_path)

    with SessionLocal.begin() as db:
        collection = db.scalars(select(Collection).where(Collection.name == args.collection)).first()
        if collection is None:
            collection = Collection(name=args.collection)
            db.add(collection)
            db.flush()
        collection_id = collection.id
    state["collection_id"] = collection_id
    storage = get_storage_service()
    # Reverse creation order makes episode 01 appear first in the existing newest-first UI.
    for entry in reversed(entries):
        page = entry["page"]
        origin = manifest.parent / entry["file"]
        if not origin.is_file() or origin.stat().st_size != entry["bytes"]:
            raise RuntimeError(f"Source file missing or changed: {origin.name}")
        key = f'audio/bilibili/{bvid}/{page:02d}-{entry["cid"]}.m4a'
        target = Path(storage.get_absolute_path(key))
        target.parent.mkdir(parents=True, exist_ok=True)
        with SessionLocal() as db:
            old = rows.get(page)
            if old and old.get("audio_id") and db.get(AudioFile, old["audio_id"]) is None:
                rows[page]["status"] = "deleted"
                continue
        if not target.exists() or target.stat().st_size != origin.stat().st_size:
            temporary = target.with_suffix(".copying")
            shutil.copy2(origin, temporary)
            temporary.replace(target)
        with SessionLocal.begin() as db:
            audio = db.scalars(select(AudioFile).where(AudioFile.file_path == key)).first()
            if audio is None:
                audio = AudioFile(title=Path(entry["file"]).stem, source_type="upload",
                    storage_backend="local", language="en", collection_id=collection_id,
                    file_path=key, sentences=[])
                db.add(audio)
                db.flush()
            rows[page] = {"page": page, "title": audio.title, "audio_id": audio.id,
                "source_url": entry["source_url"], "duration_seconds": entry["duration_seconds"],
                "file_path": key, "status": "ready" if audio.sentences else "pending",
                "sentences": len(audio.sentences or [])}
        save_state()
    print(f'Imported {len(rows)} files into collection {collection_id}; web listening is available.', flush=True)

    asr = get_asr_service()
    started = time.monotonic()
    # Prioritize the linked episode, then work in episode order.
    order = sorted(rows, key=lambda page: (page != 4, page))
    for page in order:
        row = rows[page]
        with SessionLocal() as db:
            audio = db.get(AudioFile, row["audio_id"])
            if audio is None:
                row["status"] = "deleted"
                save_state()
                continue
            if audio.sentences:
                row.update(status="ready", sentences=len(audio.sentences))
                save_state()
                continue
            key = audio.file_path
        try:
            row["status"] = "transcribing"
            state.update(status="transcribing", current_page=page)
            save_state()
            print(f'[{page:02d}/51] transcribing {row["title"]}', flush=True)
            before = time.monotonic()
            sentences = [s.model_dump() for s in asr.transcribe(storage.get_absolute_path(key))]
            if not sentences:
                raise RuntimeError("Speech recognition returned no sentences")
            # No database connection or write lock is held during recognition.
            with SessionLocal.begin() as db:
                audio = db.get(AudioFile, row["audio_id"])
                if audio is None:
                    row["status"] = "deleted"
                elif audio.sentences:
                    row.update(status="ready", sentences=len(audio.sentences))
                else:
                    audio.sentences = sentences
                    row.update(status="ready", sentences=len(sentences),
                               elapsed_seconds=round(time.monotonic()-before, 2))
            save_state()
            print(f'[{page:02d}/51] {row["status"]}: {row.get("sentences", 0)} sentences, '
                  f'{row.get("elapsed_seconds", 0):.1f}s; complete {state["completed"]}/51', flush=True)
        except Exception as exc:
            row.update(status="failed", error=f"{type(exc).__name__}: {exc}")
            save_state()
            print(f'[{page:02d}/51] FAILED: {row["error"]}', flush=True)
    failed = [row for row in rows.values() if row["status"] == "failed"]
    state.update(status="failed" if failed else "complete", current_page=None,
                 elapsed_seconds=round(time.monotonic()-started, 2))
    save_state()
    print(f'Finished: {state["completed"]}/51 transcribed; failed {len(failed)}; '
          f'{sum(row.get("sentences",0) for row in rows.values())} sentences.', flush=True)
    if failed:
        raise SystemExit(1)

if __name__ == "__main__":
    main()
