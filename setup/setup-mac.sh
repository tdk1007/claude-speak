#!/bin/bash
# Installs the speak mod's local voices on a Mac. Safe to run again.
#
#   Kokoro (any Mac):           stock voices, CPU, ~400 MB
#   Cloned voice (Apple chip):  Chatterbox Turbo via MLX on the GPU, ~3 GB download
#
# Everything goes in ~/.local/share/claude-speak. The mod runs this for you
# (the "Set up voices" button or /speak setup); you can also run it in Terminal:
#   bash setup/setup-mac.sh            # Kokoro + cloned voice when the Mac can run it
#   bash setup/setup-mac.sh --kokoro   # Kokoro only
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$HOME/.local/share/claude-speak"
KOKORO_ONLY=0
[ "${1:-}" = "--kokoro" ] && KOKORO_ONLY=1
mkdir -p "$DATA"
export HF_HUB_DISABLE_PROGRESS_BARS=1 TQDM_DISABLE=1 TRANSFORMERS_VERBOSITY=error

step() { printf '\n==> %s\n' "$*"; }

# uv installs the right Python by itself, so nothing else has to be on the Mac first.
UV="$(command -v uv || true)"
[ -z "$UV" ] && [ -x "$HOME/.local/bin/uv" ] && UV="$HOME/.local/bin/uv"
if [ -z "$UV" ]; then
  step "Installing uv (Python installer, from astral.sh)"
  curl -LsSf https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh
  UV="$HOME/.local/bin/uv"
fi

# ---- Kokoro ----------------------------------------------------------------
step "Kokoro voice: Python environment"
"$UV" venv -q --allow-existing --python 3.12 "$DATA/kokoro/.venv"
VIRTUAL_ENV="$DATA/kokoro/.venv" "$UV" pip install -q "kokoro-onnx==0.6.1" "soundfile>=0.12"

step "Kokoro voice: model files (~340 MB)"
mkdir -p "$DATA/kokoro/models"
fetch() { # name sha256
  local f="$DATA/kokoro/models/$1"
  if [ -f "$f" ] && [ "$(shasum -a 256 "$f" | cut -d' ' -f1)" = "$2" ]; then echo "  $1 already here"; return; fi
  local old="$HOME/.local/share/kokoro-tts/models/$1" # an earlier install of this mod
  if [ -f "$old" ]; then cp "$old" "$f"; else
    curl -fL --progress-bar -o "$f.part" "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/$1"
    mv "$f.part" "$f"
  fi
  [ "$(shasum -a 256 "$f" | cut -d' ' -f1)" = "$2" ] || { echo "  $1: checksum mismatch, delete it and run again"; exit 1; }
}
fetch kokoro-v1.0.onnx 7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5
fetch voices-v1.0.bin bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d

CLONE=none
# ---- Cloned voice (Apple chip only: MLX runs on the Apple GPU) --------------
if [ "$KOKORO_ONLY" = 0 ] && [ "$(uname -m)" = arm64 ]; then
  step "Cloned voice: Python environment (MLX)"
  "$UV" venv -q --allow-existing --python 3.11 "$DATA/clone/.venv"
  VIRTUAL_ENV="$DATA/clone/.venv" "$UV" pip install -q "mlx-audio==0.6.4" "soundfile>=0.12" "setuptools<81"
  step "Cloned voice: downloading the model and saying a test line (~3 GB the first time)"
  mkdir -p "$DATA/tmp"
  "$DATA/clone/.venv/bin/python" -I - "$HERE/voice/ref.wav" "$DATA/tmp/setup-test.wav" <<'PY'
import sys, numpy as np, soundfile as sf
from mlx_audio.tts.utils import load_model
m = load_model("mlx-community/chatterbox-turbo-fp16")
parts = list(m.generate("Setup is done. This is the cloned voice.", ref_audio=sys.argv[1]))
sf.write(sys.argv[2], np.concatenate([np.array(p.audio) for p in parts]), parts[0].sample_rate)
print("  test line written")
PY
  CLONE=mlx-chatterbox-turbo
elif [ "$KOKORO_ONLY" = 0 ]; then
  echo "This Mac has an Intel chip: the cloned voice needs Apple silicon, so Kokoro will be the voice."
fi

printf '{"platform":"mac","kokoro":true,"clone":"%s","version":1}\n' "$CLONE" > "$DATA/installed.json"
step "Done. Voices installed in $DATA (cloned voice: $CLONE)"
