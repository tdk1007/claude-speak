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
#
# Works without GitHub (for locked-down networks) when the offline zip is used:
# it carries the Kokoro model files in models/kokoro/, and without uv this uses
# a Python 3.10-3.13 already on the Mac. Python packages still come from PyPI,
# and the cloned voice's model from Hugging Face; if that fails, Kokoro still works.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
DATA="$HOME/.local/share/claude-speak"
KOKORO_ONLY=0
[ "${1:-}" = "--kokoro" ] && KOKORO_ONLY=1
mkdir -p "$DATA/tmp"
export HF_HUB_DISABLE_PROGRESS_BARS=1 TQDM_DISABLE=1 TRANSFORMERS_VERBOSITY=error

step() { printf '\n==> %s\n' "$*"; }
RANGE=">=3.10,<3.14"

# uv installs the right Python by itself. Its installer and its Pythons come from
# GitHub, so on a network without GitHub fall back to a Python already here.
UV="$(command -v uv || true)"
[ -z "$UV" ] && [ -x "$HOME/.local/bin/uv" ] && UV="$HOME/.local/bin/uv"
if [ -z "$UV" ]; then
  step "Installing uv (Python installer, from astral.sh)"
  if curl -LsSf --max-time 60 https://astral.sh/uv/install.sh | env UV_NO_MODIFY_PATH=1 sh && [ -x "$HOME/.local/bin/uv" ]; then
    UV="$HOME/.local/bin/uv"
  else
    echo "  could not install uv; using a Python already on this Mac"
    UV=""
  fi
fi

system_python() { # the newest Python 3.10-3.13 on the PATH or in the usual places
  local p c
  for p in python3.12 python3.11 python3.13 python3.10 python3 \
           /opt/homebrew/bin/python3 /usr/local/bin/python3 /Library/Frameworks/Python.framework/Versions/Current/bin/python3; do
    c="$(command -v "$p" 2>/dev/null)" || continue
    "$c" -c 'import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] < (3, 14) else 1)' 2>/dev/null && { echo "$c"; return 0; }
  done
  return 1
}

make_venv() { # dir preferred-version
  if [ -x "$1/bin/python" ]; then return 0; fi
  if [ -n "$UV" ]; then
    "$UV" venv -q --allow-existing --python "$2" "$1" 2>/dev/null && return 0
    "$UV" venv -q --allow-existing --python "$RANGE" "$1" 2>/dev/null && return 0
  fi
  local py
  py="$(system_python)" || { echo "  needs Python 3.10 to 3.13 (from python.org or Homebrew), or uv"; return 1; }
  echo "  using $py"
  "$py" -m venv "$1"
}

pip_in() { # dir packages...
  local dir="$1"; shift
  if [ -n "$UV" ]; then VIRTUAL_ENV="$dir" "$UV" pip install -q "$@"
  else "$dir/bin/python" -m pip install -q --disable-pip-version-check "$@"; fi
}

# ---- Kokoro ----------------------------------------------------------------
step "Kokoro voice: Python environment"
make_venv "$DATA/kokoro/.venv" 3.12
pip_in "$DATA/kokoro/.venv" "kokoro-onnx==0.6.1" "soundfile>=0.12"

step "Kokoro voice: model files (~340 MB)"
mkdir -p "$DATA/kokoro/models"
fetch() { # name sha256
  local f="$DATA/kokoro/models/$1" src
  if [ -f "$f" ] && [ "$(shasum -a 256 "$f" | cut -d' ' -f1)" = "$2" ]; then echo "  $1 already here"; return; fi
  for src in "$HERE/models/kokoro/$1" "$HOME/.local/share/kokoro-tts/models/$1"; do # the offline zip; an earlier install
    if [ -f "$src" ]; then cp "$src" "$f"; echo "  $1 copied from $(dirname "$src")"; break; fi
  done
  if [ ! -f "$f" ]; then
    curl -fL --progress-bar -o "$f.part" "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/$1"
    mv "$f.part" "$f"
  fi
  [ "$(shasum -a 256 "$f" | cut -d' ' -f1)" = "$2" ] || { echo "  $1: checksum mismatch, delete it and run again"; exit 1; }
}
fetch kokoro-v1.0.onnx 7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5
fetch voices-v1.0.bin bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d

# Kokoro works from here on, whatever happens to the cloned voice.
installed() { printf '{"platform":"mac","kokoro":true,"clone":"%s","version":1}\n' "$1" > "$DATA/installed.json"; }
CLONE=none
installed none

# ---- Cloned voice (Apple chip only: MLX runs on the Apple GPU) --------------
clone_setup() {
  step "Cloned voice: Python environment (MLX)"
  make_venv "$DATA/clone/.venv" 3.11 || return 1
  pip_in "$DATA/clone/.venv" "mlx-audio==0.6.4" "soundfile>=0.12" "setuptools<81" || return 1
  step "Cloned voice: downloading the model and saying a test line (~3 GB the first time)"
  "$DATA/clone/.venv/bin/python" -I - "$HERE/voice/ref.wav" "$DATA/tmp/setup-test.wav" <<'PY'
import sys, numpy as np, soundfile as sf
from mlx_audio.tts.utils import load_model
m = load_model("mlx-community/chatterbox-turbo-fp16")
parts = list(m.generate("Setup is done. This is the cloned voice.", ref_audio=sys.argv[1]))
sf.write(sys.argv[2], np.concatenate([np.array(p.audio) for p in parts]), parts[0].sample_rate)
print("  test line written")
PY
}

if [ "$KOKORO_ONLY" = 0 ] && [ "$(uname -m)" = arm64 ]; then
  if clone_setup; then CLONE=mlx-chatterbox-turbo; installed "$CLONE"
  else echo "The cloned voice did not install (often a network that blocks huggingface.co or PyPI). Kokoro will be the voice; run setup again to retry."; fi
elif [ "$KOKORO_ONLY" = 0 ]; then
  echo "This Mac has an Intel chip: the cloned voice needs Apple silicon, so Kokoro will be the voice."
fi

step "Done. Voices installed in $DATA (cloned voice: $CLONE)"
