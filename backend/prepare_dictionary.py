"""Download the open WordNet 3.0 corpus once, for offline word definitions."""
from hashlib import sha256
from pathlib import Path
import urllib.request
from zipfile import ZipFile

URL = "https://raw.githubusercontent.com/nltk/nltk_data/gh-pages/packages/corpora/wordnet.zip"
SHA256 = "cbda5ea6eef7f36a97a43d4a75f85e07fccbb4f23657d27b4ccbc93e2646ab59"
TARGET = Path(__file__).resolve().parent.parent / ".runtime" / "nltk_data" / "corpora" / "wordnet.zip"


def prepare():
    TARGET.parent.mkdir(parents=True, exist_ok=True)
    if TARGET.is_file() and sha256(TARGET.read_bytes()).hexdigest() == SHA256:
        with ZipFile(TARGET) as archive:
            TARGET.with_name("WORDNET-LICENSE.txt").write_bytes(archive.read("wordnet/LICENSE"))
        print("WordNet 3.0 is ready for offline lookup.")
        return
    partial = TARGET.with_suffix(".zip.part")
    try:
        with urllib.request.urlopen(URL, timeout=60) as source, partial.open("wb") as output:
            while chunk := source.read(1024 * 1024):
                output.write(chunk)
        if sha256(partial.read_bytes()).hexdigest() != SHA256:
            raise RuntimeError("WordNet download checksum did not match; original corpus was preserved.")
        partial.replace(TARGET)
    finally:
        partial.unlink(missing_ok=True)
    with ZipFile(TARGET) as archive:
        TARGET.with_name("WORDNET-LICENSE.txt").write_bytes(archive.read("wordnet/LICENSE"))
    print("Downloaded WordNet 3.0. Word definitions now work offline.")


if __name__ == "__main__":
    prepare()
