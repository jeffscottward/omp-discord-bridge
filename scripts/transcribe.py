# /// script
# dependencies = ["faster-whisper", "numpy", "nvidia-cublas-cu12", "nvidia-cudnn-cu12==9.*"]
# ///
"""Local speech-to-text for Discord voice messages (owner request 2026-10-13). Nothing leaves the rig.
Usage: uv run scripts/transcribe.py <audio file>  -> transcript on stdout.
Decodes with ffmpeg to 16 kHz mono first (faster-whisper's own PyAV decode breaks on some builds).
"""
import subprocess
import sys

import ctypes
import glob
import os

import numpy as np

# Preload the pip-installed CUDA libs so CTranslate2 finds them (no system CUDA toolkit needed).
for pat in ("nvidia/cublas/lib/libcublas*.so*", "nvidia/cudnn/lib/libcudnn*.so*"):
    for d in __import__("site").getsitepackages():
        for f in sorted(glob.glob(os.path.join(d, pat))):
            try:
                ctypes.CDLL(f, mode=ctypes.RTLD_GLOBAL)
            except OSError:
                pass

from faster_whisper import WhisperModel

pcm = subprocess.run(
    ["ffmpeg", "-loglevel", "error", "-i", sys.argv[1], "-f", "s16le", "-ac", "1", "-ar", "16000", "-"],
    check=True, capture_output=True,
).stdout
audio = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768
try:  # GPU first (owner request 2026-10-13); CPU if CUDA is unavailable or busy
    model = WhisperModel("small", device="cuda", compute_type="float16")
    segments, _ = model.transcribe(audio, vad_filter=True)
    segments = list(segments)
    device = "cuda"
except Exception:
    model = WhisperModel("small", device="cpu", compute_type="int8")
    segments, _ = model.transcribe(audio, vad_filter=True)
    device = "cpu"
print(f"device={device}", file=sys.stderr)
print(" ".join(s.text.strip() for s in segments).strip())
