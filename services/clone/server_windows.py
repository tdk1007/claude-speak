"""Cloned-voice service for Windows with an NVIDIA GPU: F5-TTS v1 on CUDA.

Chosen over Chatterbox for Windows because it is light enough to run beside a
VR game: ~0.8 GB of VRAM, and --steps 16 halves the work of the default 32.
Runs at below-normal CPU priority and quits after 15 idle minutes (the mod
passes --idle). Copies the voice in --ref, whose words must be in --ref-text.
POST /tts {"text", "out"}.

Run: <venv python> -I server_windows.py --port 47712 --root <tmp> --ref voice/ref-short.wav
     [--ref-text "<transcript>"] [--steps 16]   (default transcript: ref-short.txt)
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from common import args, lower_priority, serve  # noqa: E402

opts = args()
lower_priority()

import torch  # noqa: E402

torch.set_num_threads(2)  # the GPU does the work; leave the CPU to the game

from f5_tts.api import F5TTS  # noqa: E402

# The words spoken in --ref: --ref-text, else the .txt beside the WAV.
if not opts.ref_text:
    with open(os.path.splitext(opts.ref)[0] + ".txt", encoding="utf-8") as f:
        opts.ref_text = f.read().strip()

tts = F5TTS(model=opts.model or "F5TTS_v1_Base")


def say(text, out):
    tts.infer(
        ref_file=opts.ref, ref_text=opts.ref_text, gen_text=text, file_wave=out,
        nfe_step=opts.steps, remove_silence=False, show_info=lambda *a, **k: None,
    )


say("Warming up.", os.path.join(opts.root, "warmup.wav"))  # loads the kernels and caches the reference


def synth(req, out):
    say(req["text"], out)


serve(opts, synth)
