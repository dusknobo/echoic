"""Project-local Windows runtime: SQLite, models, FFmpeg and eSpeak."""
import os
import shutil
import sys
import tempfile
from pathlib import Path

PROJECT = Path(__file__).resolve().parent.parent
BACKEND = PROJECT / "backend"
RUNTIME = PROJECT / ".runtime"


def configure():
    os.chdir(BACKEND)
    # Keep IPA symbols and Chinese paths readable in redirected Windows logs.
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    RUNTIME.mkdir(exist_ok=True)
    defaults = {
        "DATABASE_URL": "sqlite:///" + (RUNTIME / "echoic.db").as_posix(),
        "STORAGE__LOCAL_DIR": str(RUNTIME / "storage"),
        "HF_HOME": str(RUNTIME / "models" / "huggingface"),
        "TORCH_HOME": str(RUNTIME / "models" / "torch"),
        "HF_HUB_DISABLE_XET": "1",
        "HF_HUB_DISABLE_SYMLINKS_WARNING": "1",
        "OMP_NUM_THREADS": "4",
        "ASR__WHISPERX__DEVICE": "cpu",
        "ASR__WHISPERX__COMPUTE_TYPE": "int8",
        "ALIGNMENT__WAV2VEC2__DEVICE": "cpu",
        "SCORING__PHONEME__DEVICE": "cpu",
    }
    for key, value in defaults.items():
        os.environ.setdefault(key, value)

    import imageio_ffmpeg
    bin_dir = RUNTIME / "bin"
    bin_dir.mkdir(exist_ok=True)
    source = Path(imageio_ffmpeg.get_ffmpeg_exe())
    target = bin_dir / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    if not target.exists() or target.stat().st_size != source.stat().st_size:
        shutil.copy2(source, target)
    os.environ["PATH"] = str(bin_dir) + os.pathsep + os.environ.get("PATH", "")

    import espeakng_loader
    from phonemizer.backend.espeak.wrapper import EspeakWrapper
    EspeakWrapper.set_library(espeakng_loader.get_library_path())
    data_path = Path(espeakng_loader.get_data_path())
    if os.name == "nt" and not str(data_path).isascii():
        # eSpeak's Windows C file API cannot open this UTF-8 Chinese path.
        # The small dictionary cache is disposable and recreated if Temp is cleared.
        cached_data = Path(tempfile.gettempdir()) / "Echoic-native" / "espeak-0.2.4" / "espeak-ng-data"
        shutil.copytree(data_path, cached_data, dirs_exist_ok=True)
        data_path = cached_data
    EspeakWrapper.set_data_path(str(data_path))
