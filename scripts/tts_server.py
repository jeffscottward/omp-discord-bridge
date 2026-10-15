"""Local Kokoro text-to-speech for Discord replies (owner request 2026-10-13: every reply gets audio).
Runs with ~/Github/tools/kokoro-tts/.venv (onnxruntime-gpu + CUDA 13 wheels), fp32 model on the GPU,
voice af_heart. Unix socket $XDG_RUNTIME_DIR/omp-tts.sock.
Request: one JSON line {"text": ..., "out": "/path/file.ogg"}. Reply: {"ok": true, "seconds": n} or {"error": ...}.
"""
import ctypes, glob, json, os, site, socket, subprocess

for pat in ("nvidia/cu13/lib/lib*.so*", "nvidia/*/lib/lib*.so*"):
    for d in site.getsitepackages():
        for f in sorted(glob.glob(os.path.join(d, pat))):
            try:
                ctypes.CDLL(f, mode=ctypes.RTLD_GLOBAL)
            except OSError:
                pass

import numpy as np  # noqa: E402
import onnxruntime as ort  # noqa: E402
from kokoro_onnx import Kokoro  # noqa: E402

MODEL_DIR = os.path.expanduser("~/Github/tools/kokoro-tts")
sess = ort.InferenceSession(os.path.join(MODEL_DIR, "kokoro-v1.0.onnx"), providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
tts = Kokoro.from_session(sess, os.path.join(MODEL_DIR, "voices-v1.0.bin"))
tts.create("Ready.", voice="af_heart", speed=1.0, lang="en-us")  # warm up

path = os.path.join(os.environ.get("XDG_RUNTIME_DIR", "/tmp"), "omp-tts.sock")
if os.path.exists(path):
    os.unlink(path)
srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
srv.bind(path)
os.chmod(path, 0o600)
srv.listen(4)
print(f"ready provider={sess.get_providers()[0]} socket={path}", flush=True)

while True:
    conn, _ = srv.accept()
    with conn:
        try:
            req = json.loads(conn.makefile().readline())
            samples, rate = tts.create(req["text"][:8000], voice="af_heart", speed=1.05, lang="en-us")
            pcm = (np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes()
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-f", "s16le", "-ar", str(rate), "-ac", "1", "-i", "-",
                            "-c:a", "libopus", "-b:a", "32k", req["out"]], input=pcm, check=True, timeout=60)
            reply = {"ok": True, "seconds": round(len(samples) / rate, 1)}
        except Exception as e:  # class only
            reply = {"error": type(e).__name__}
        conn.sendall((json.dumps(reply) + "\n").encode())
