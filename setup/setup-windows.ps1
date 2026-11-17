# Installs the speak mod's local voices on Windows. Safe to run again.
#
#   Kokoro (any PC):            stock voices, CPU, ~400 MB
#   Cloned voice (NVIDIA GPU):  F5-TTS v1 on CUDA, light enough to run beside a VR game
#                               (~0.8 GB VRAM), ~3 GB download with PyTorch
#
# Everything goes in %USERPROFILE%\.local\share\claude-speak, Python included. Not AppData:
# the Claude desktop app is a Store app, and what it (or this script, started from it) writes
# under AppData lands in a private copy that a plain terminal never sees. The mod runs this for you
# (the "Set up voices" button or /speak setup); you can also run it yourself:
#   powershell -NoProfile -ExecutionPolicy Bypass -File setup\setup-windows.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File setup\setup-windows.ps1 -KokoroOnly
param([switch]$KokoroOnly)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is many times faster without its progress bar
$env:HF_HUB_DISABLE_PROGRESS_BARS = '1'; $env:TQDM_DISABLE = '1'; $env:TRANSFORMERS_VERBOSITY = 'error'

$Here = Split-Path -Parent $PSScriptRoot
$Data = Join-Path $env:USERPROFILE '.local\share\claude-speak'
New-Item -ItemType Directory -Force -Path $Data, "$Data\tmp" | Out-Null
# uv keeps its Pythons and cache under AppData by default; keep them here too (see above).
$env:UV_PYTHON_INSTALL_DIR = "$Data\python"
$env:UV_CACHE_DIR = "$Data\uv-cache"
function Step($m) { Write-Output ""; Write-Output "==> $m" }
function Run { & $args[0] $args[1..($args.Count - 1)]; if ($LASTEXITCODE) { throw "failed: $($args -join ' ')" } }

# uv installs the right Python by itself, so nothing else has to be on the PC first.
$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if (-not $uv -and (Test-Path "$env:USERPROFILE\.local\bin\uv.exe")) { $uv = "$env:USERPROFILE\.local\bin\uv.exe" }
if (-not $uv) {
  Step 'Installing uv (Python installer, from astral.sh)'
  $env:UV_NO_MODIFY_PATH = '1'
  Invoke-RestMethod https://astral.sh/uv/install.ps1 | Invoke-Expression
  $uv = "$env:USERPROFILE\.local\bin\uv.exe"
}

# ---- Kokoro -----------------------------------------------------------------
Step 'Kokoro voice: Python environment'
Run $uv venv -q --allow-existing --python 3.12 "$Data\kokoro\.venv"
$env:VIRTUAL_ENV = "$Data\kokoro\.venv"
Run $uv pip install -q 'kokoro-onnx==0.6.1' 'soundfile>=0.12'

Step 'Kokoro voice: model files (~340 MB)'
New-Item -ItemType Directory -Force -Path "$Data\kokoro\models" | Out-Null
$models = @{
  'kokoro-v1.0.onnx' = '7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5'
  'voices-v1.0.bin'  = 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d'
}
foreach ($name in $models.Keys) {
  $f = "$Data\kokoro\models\$name"
  if ((Test-Path $f) -and (Get-FileHash $f -Algorithm SHA256).Hash -eq $models[$name]) { Write-Output "  $name already here"; continue }
  Invoke-WebRequest "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/$name" -OutFile "$f.part"
  Move-Item -Force "$f.part" $f
  if ((Get-FileHash $f -Algorithm SHA256).Hash -ne $models[$name]) { throw "$name checksum mismatch: delete it and run again" }
}

# ---- Cloned voice (needs an NVIDIA GPU) --------------------------------------
$clone = 'none'
$gpu = $null
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { $gpu = (& nvidia-smi --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1) }
if (-not $KokoroOnly -and $gpu) {
  Step "Cloned voice: Python environment (F5-TTS on $gpu)"
  Run $uv venv -q --allow-existing --python 3.11 "$Data\clone\.venv"
  $env:VIRTUAL_ENV = "$Data\clone\.venv"
  # CUDA 12.8 wheels: the only ones with kernels for RTX 50-series (Blackwell) cards; they also run on older cards.
  Run $uv pip install -q 'torch==2.8.0+cu128' 'torchaudio==2.8.0+cu128' --index-url https://download.pytorch.org/whl/cu128
  Run $uv pip install -q 'f5-tts==1.1.22' 'soundfile>=0.12'
  Step 'Cloned voice: downloading the model and saying a test line'
  $py = "$Data\clone\.venv\Scripts\python.exe"
  $test = @'
import sys
from f5_tts.api import F5TTS
ref = sys.argv[1]
text = open(ref[:-4] + ".txt", encoding="utf-8").read().strip()
F5TTS(model="F5TTS_v1_Base").infer(ref_file=ref, ref_text=text, gen_text="Setup is done. This is the cloned voice.",
    file_wave=sys.argv[2], nfe_step=16, remove_silence=False)
print("  test line written")
'@
  $test | & $py -I - "$Here\voice\ref-short.wav" "$Data\tmp\setup-test.wav"
  if ($LASTEXITCODE) { throw 'the cloned voice did not run; Kokoro still works' }
  $clone = 'f5-tts'
} elseif (-not $KokoroOnly) {
  Write-Output 'No NVIDIA GPU found: the cloned voice needs one, so Kokoro will be the voice.'
}

"{`"platform`":`"windows`",`"kokoro`":true,`"clone`":`"$clone`",`"version`":1}" | Set-Content -Encoding ascii "$Data\installed.json"
Step "Done. Voices installed in $Data (cloned voice: $clone)"
