"""Cloned-voice service for Apple Silicon Macs: Chatterbox Turbo on the GPU via MLX.

Copies the voice in --ref (a ~10 s WAV). About 0.35 s of work per second of
speech on an M1 Max, ~6 s to start, ~3 GB of memory while loaded.
POST /tts {"text", "out"}.

Run: <venv python> -I server_mac.py --port 47712 --root <tmp> --ref voice/ref.wav
     [--model mlx-community/chatterbox-turbo-fp16]
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import args, serve  # noqa: E402

opts = args()

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from mlx_audio.tts.utils import load_model  # noqa: E402

model = load_model(opts.model or "mlx-community/chatterbox-turbo-fp16")
list(model.generate("Warming up.", ref_audio=opts.ref))  # the first clip on the GPU is slow; pay it now


def synth(req, out):
    parts = list(model.generate(req["text"], ref_audio=opts.ref))
    sf.write(out, np.concatenate([np.array(p.audio) for p in parts]), parts[0].sample_rate)


serve(opts, synth)
