"""Kokoro voice service (macOS and Windows, CPU). Fast stock voices.

POST /tts {"text", "out", "voice", "speed"}. Model files come from setup:
<data>/kokoro/models/kokoro-v1.0.onnx and voices-v1.0.bin (--model names that folder).

Run: <venv python> -I server.py --port 47711 --root <tmp> --model <models folder>
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import args, lower_priority, serve  # noqa: E402

opts = args()
lower_priority()

import soundfile as sf  # noqa: E402
from kokoro_onnx import Kokoro  # noqa: E402

kokoro = Kokoro(os.path.join(opts.model, "kokoro-v1.0.onnx"), os.path.join(opts.model, "voices-v1.0.bin"))


def synth(req, out):
    audio, rate = kokoro.create(
        req["text"], voice=req.get("voice", "am_michael"), speed=float(req.get("speed", 1.1)), lang=req.get("lang", "en-us")
    )
    sf.write(out, audio, rate)


serve(opts, synth)
