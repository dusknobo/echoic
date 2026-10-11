"""Download public, unencrypted Bilibili multipart audio for local listening."""
from __future__ import annotations
import argparse
import csv
import json
import os
import re
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
import requests

API = "https://api.bilibili.com"
_LOCAL = threading.local()
_PRINT_LOCK = threading.Lock()

def session():
    if not hasattr(_LOCAL, "session"):
        client = requests.Session()
        client.trust_env = False  # Keep public requests independent of Windows system proxy settings.
        client.headers.update({"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/"})
        _LOCAL.session = client
    return _LOCAL.session

def api(endpoint, **params):
    response = session().get(API + endpoint, params=params, timeout=(15, 40))
    response.raise_for_status()
    payload = response.json()
    if payload.get("code") != 0:
        raise RuntimeError(f"Bilibili API code {payload.get('code')}: {payload.get('message')}")
    return payload["data"]

def log(message):
    with _PRINT_LOCK:
        print(message, flush=True)

def filename(page):
    title = re.sub(r"^\d+-\s*", "", page["part"])
    title = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", title).rstrip(" .")[:180]
    return f'{page["page"]:02d} - {title}.m4a'

def validate(path, expected_duration, ffmpeg):
    result = subprocess.run(
        [str(ffmpeg), "-hide_banner", "-nostdin", "-i", str(path), "-map", "0:a:0", "-f", "null", "-"],
        capture_output=True, timeout=120,
    )
    diagnostic = result.stderr.decode("utf-8", errors="replace")
    if result.returncode:
        raise RuntimeError("Audio decode failed: " + diagnostic[-600:])
    match = re.search(r"Duration: (\d+):(\d+):([\d.]+)", diagnostic)
    if not match:
        raise RuntimeError("Audio has no readable duration")
    h, m, s = match.groups()
    actual = int(h) * 3600 + int(m) * 60 + float(s)
    if abs(actual - expected_duration) > 3:
        raise RuntimeError(f"Unexpected audio duration: {actual:.2f} vs {expected_duration}")
    return round(actual, 3)

def transfer(url, partial):
    offset = partial.stat().st_size if partial.exists() else 0
    headers = {"Range": f"bytes={offset}-"} if offset else {}
    with session().get(url, headers=headers, stream=True, timeout=(20, 60)) as response:
        if response.status_code == 416 and offset:
            return  # Full .part left by an interruption: the decoder will validate it.
        response.raise_for_status()
        mode = "ab" if offset and response.status_code == 206 else "wb"
        if mode == "wb":
            offset = 0
        content_range = response.headers.get("Content-Range", "")
        if response.status_code == 206:
            match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", content_range)
            if not match or int(match[1]) != offset:
                raise RuntimeError("Unexpected HTTP range response")
            expected_size = int(match[3])
        else:
            length = response.headers.get("Content-Length")
            expected_size = int(length) if length else None
        with partial.open(mode) as output:
            for chunk in response.iter_content(256 * 1024):
                if chunk:
                    output.write(chunk)
        if expected_size is not None and partial.stat().st_size != expected_size:
            raise RuntimeError("Incomplete audio download")

def download(page, bvid, output, ffmpeg):
    target = output / filename(page)
    record = {
        "page": page["page"], "cid": page["cid"], "title": page["part"],
        "duration_seconds": page["duration"], "file": target.name,
        "source_url": f"https://www.bilibili.com/video/{bvid}/?p={page['page']}",
    }
    try:
        if target.exists():
            record.update(status="ready", actual_duration=validate(target, page["duration"], ffmpeg), bytes=target.stat().st_size)
            log(f'[{page["page"]:02d}] verified existing: {target.name}')
            return record
        partial = target.with_suffix(".m4a.part")
        last_error = None
        for attempt in range(3):
            try:
                data = api("/x/player/playurl", bvid=bvid, cid=page["cid"], fnval=16, qn=16, fourk=0)
                tracks = (data.get("dash") or {}).get("audio") or []
                if not tracks:
                    raise RuntimeError("No public audio track available; login or unsupported format may be required")
                # Prefer the highest-bitrate ordinary AAC stream; no transcoding is needed.
                tracks = [track for track in tracks if track.get("codecs", "").startswith("mp4a")]
                track = max(tracks, key=lambda item: item.get("bandwidth", 0))
                urls = [track.get("baseUrl") or track.get("base_url")]
                urls += track.get("backupUrl") or track.get("backup_url") or []
                for url in filter(None, urls):
                    try:
                        transfer(url.replace("http://", "https://", 1), partial)
                        actual_duration = validate(partial, page["duration"], ffmpeg)
                        partial.replace(target)
                        record.update(status="ready", actual_duration=actual_duration, bytes=target.stat().st_size,
                                      audio_format="AAC / M4A", bitrate=track.get("bandwidth"))
                        log(f'[{page["page"]:02d}/51] saved {target.stat().st_size / 1048576:.1f} MiB: {target.name}')
                        return record
                    except Exception as exc:
                        last_error = exc
                raise last_error or RuntimeError("No usable public audio URL")
            except Exception as exc:
                last_error = exc
                if attempt < 2:
                    time.sleep(2 * (attempt + 1))
        raise last_error or RuntimeError("Download failed")
    except Exception as exc:
        # Do not persist signed media URLs or credentials in the manifest.
        record.update(status="failed", error=type(exc).__name__ + ": " + str(exc).split(" for url:")[0][:250])
        log(f'[{page["page"]:02d}] FAILED: {record["error"]}')
        return record

def write_manifest(output, info, rows):
    doc = {"bvid": info["bvid"], "title": info["title"],
           "source_url": f'https://www.bilibili.com/video/{info["bvid"]}/',
           "total_episodes": len(info["pages"]), "total_duration_seconds": sum(p["duration"] for p in info["pages"]),
           "downloaded_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "episodes": sorted(rows, key=lambda row: row["page"])}
    temporary = output / "manifest.json.tmp"
    temporary.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(output / "manifest.json")
    with (output / "episodes.csv").open("w", encoding="utf-8-sig", newline="") as handle:
        fields = ["page", "title", "duration_seconds", "actual_duration", "file", "source_url", "status", "bytes"]
        writer = csv.DictWriter(handle, fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(doc["episodes"])

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bvid", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--pages", nargs="*", type=int)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    info = api("/x/web-interface/view", bvid=args.bvid)
    (args.output / "series-info.json").write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    pages = [p for p in info["pages"] if not args.pages or p["page"] in args.pages]
    ffmpeg = Path(__file__).resolve().parents[1] / ".runtime" / "bin" / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    rows = []
    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 3))) as pool:
        futures = [pool.submit(download, page, args.bvid, args.output, ffmpeg) for page in pages]
        for future in as_completed(futures):
            rows.append(future.result())
            write_manifest(args.output, info, rows)
    failed = [row for row in rows if row["status"] != "ready"]
    log(f'Complete: {len(rows)-len(failed)}/{len(rows)} episodes, {sum(row.get("bytes",0) for row in rows)/1048576:.1f} MiB.')
    if failed:
        raise SystemExit(1)

if __name__ == "__main__":
    main()
