# /// script
# dependencies = ["faster-whisper", "numpy", "nvidia-cublas-cu12", "nvidia-cudnn-cu12==9.*"]
# ///
"""Long-running local Whisper for Discord voice messages (owner request 2026-10-13: keep it loaded).
Unix socket at $XDG_RUNTIME_DIR/omp-whisper.sock. Request: one line with an audio file path.
Reply: one JSON line {"text": ..., "device": ...} or {"error": ...}. Nothing leaves the rig.
"""
import ctypes
import glob
import json
import os
import site
import socket
import subprocess

import numpy as np

for pat in ("nvidia/cublas/lib/libcublas*.so*", "nvidia/cudnn/lib/libcudnn*.so*"):
    for d in site.getsitepackages():
        for f in sorted(glob.glob(os.path.join(d, pat))):
            try:
                ctypes.CDLL(f, mode=ctypes.RTLD_GLOBAL)
            except OSError:
                pass

from faster_whisper import WhisperModel  # noqa: E402

try:
    model, device = WhisperModel("small", device="cuda", compute_type="float16"), "cuda"
    list(model.transcribe(np.zeros(16000, np.float32))[0])  # warm up CUDA kernels
except Exception:
    model, device = WhisperModel("small", device="cpu", compute_type="int8"), "cpu"

path = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "omp-whisper.sock")
if os.path.exists(path):
    os.unlink(path)
srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
srv.bind(path)
os.chmod(path, 0o600)
srv.listen(4)
print(f"ready device={device} socket={path}", flush=True)

while True:
    conn, _ = srv.accept()
    with conn:
        try:
            audio_path = conn.makefile().readline().strip()
            pcm = subprocess.run(["ffmpeg", "-loglevel", "error", "-i", audio_path, "-f", "s16le", "-ac", "1", "-ar", "16000", "-"],
                                 check=True, capture_output=True, timeout=60).stdout
            audio = np.frombuffer(pcm, np.int16).astype(np.float32) / 32768
            segs, _ = model.transcribe(audio, vad_filter=True)
            reply = {"text": " ".join(s.text.strip() for s in segs).strip(), "device": device}
        except Exception as e:  # report the class only
            reply = {"error": type(e).__name__}
        conn.sendall((json.dumps(reply) + "\n").encode())
