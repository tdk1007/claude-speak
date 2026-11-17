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
#
# Works without GitHub (for locked-down networks) when the offline zip is used: it carries
# the Kokoro model files in models\kokoro\, and without uv this uses a Python 3.10-3.13
# already on the PC (the py launcher or python.exe). Python packages still come from PyPI
# (PyTorch from download.pytorch.org) and the cloned voice's model from Hugging Face;
# if that fails, Kokoro still works.
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

# uv installs the right Python by itself. Its installer and its Pythons come from GitHub,
# so on a network without GitHub fall back to a Python already on the PC.
$uv = (Get-Command uv -ErrorAction SilentlyContinue).Source
if (-not $uv -and (Test-Path "$env:USERPROFILE\.local\bin\uv.exe")) { $uv = "$env:USERPROFILE\.local\bin\uv.exe" }
if (-not $uv) {
  Step 'Installing uv (Python installer, from astral.sh)'
  $env:UV_NO_MODIFY_PATH = '1'
  try { Invoke-RestMethod -TimeoutSec 60 https://astral.sh/uv/install.ps1 | Invoke-Expression } catch { }
  $uv = "$env:USERPROFILE\.local\bin\uv.exe"
  if (-not (Test-Path $uv)) { Write-Output '  could not install uv; using a Python already on this PC'; $uv = $null }
}

function System-Python {  # a Python 3.10-3.13: the py launcher first, then python.exe on the PATH
  foreach ($v in '3.12', '3.11', '3.13', '3.10') {
    if (Get-Command py -ErrorAction SilentlyContinue) {
      $exe = & py "-$v" -c 'import sys; print(sys.executable)' 2>$null
      if (-not $LASTEXITCODE -and $exe) { return $exe.Trim() }
    }
  }
  $exe = (Get-Command python -ErrorAction SilentlyContinue).Source
  if ($exe -and $exe -notlike '*WindowsApps*') {  # WindowsApps\python.exe is only the Store's install prompt
    & $exe -c 'import sys; sys.exit(0 if (3, 10) <= sys.version_info[:2] < (3, 14) else 1)' 2>$null
    if (-not $LASTEXITCODE) { return $exe }
  }
  return $null
}

function Make-Venv($dir, $version) {
  if (Test-Path "$dir\Scripts\python.exe") { return }
  if ($uv) {
    & $uv venv -q --allow-existing --python $version $dir 2>$null; if (-not $LASTEXITCODE) { return }
    & $uv venv -q --allow-existing --python '>=3.10,<3.14' $dir 2>$null; if (-not $LASTEXITCODE) { return }
  }
  $py = System-Python
  if (-not $py) { throw 'needs Python 3.10 to 3.13 (from python.org), or uv' }
  Write-Output "  using $py"
  Run $py -m venv $dir
}

function Pip-In($dir) {  # Pip-In <venv> <pip arguments...>
  $rest = $args
  if ($uv) { $env:VIRTUAL_ENV = $dir; Run $uv pip install -q @rest }
  else { Run "$dir\Scripts\python.exe" -m pip install -q --disable-pip-version-check @rest }
}

# ---- Kokoro -----------------------------------------------------------------
Step 'Kokoro voice: Python environment'
Make-Venv "$Data\kokoro\.venv" '3.12'
Pip-In "$Data\kokoro\.venv" 'kokoro-onnx==0.6.1' 'soundfile>=0.12'

Step 'Kokoro voice: model files (~340 MB)'
New-Item -ItemType Directory -Force -Path "$Data\kokoro\models" | Out-Null
$models = @{
  'kokoro-v1.0.onnx' = '7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5'
  'voices-v1.0.bin'  = 'bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d'
}
foreach ($name in $models.Keys) {
  $f = "$Data\kokoro\models\$name"
  if ((Test-Path $f) -and (Get-FileHash $f -Algorithm SHA256).Hash -eq $models[$name]) { Write-Output "  $name already here"; continue }
  if (Test-Path "$Here\models\kokoro\$name") {  # the offline zip
    Copy-Item -Force "$Here\models\kokoro\$name" $f; Write-Output "  $name copied from the package"
  } else {
    Invoke-WebRequest "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/$name" -OutFile "$f.part"
    Move-Item -Force "$f.part" $f
  }
  if ((Get-FileHash $f -Algorithm SHA256).Hash -ne $models[$name]) { throw "$name checksum mismatch: delete it and run again" }
}

# Kokoro works from here on, whatever happens to the cloned voice.
function Installed($clone) {
  "{`"platform`":`"windows`",`"kokoro`":true,`"clone`":`"$clone`",`"version`":1}" | Set-Content -Encoding ascii "$Data\installed.json"
}
Installed 'none'

# ---- Cloned voice (needs an NVIDIA GPU) --------------------------------------
$clone = 'none'
$gpu = $null
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { $gpu = (& nvidia-smi --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1) }
if (-not $KokoroOnly -and $gpu) {
 try {
  Step "Cloned voice: Python environment (F5-TTS on $gpu)"
  Make-Venv "$Data\clone\.venv" '3.11'
  # CUDA 12.8 wheels: the only ones with kernels for RTX 50-series (Blackwell) cards; they also run on older cards.
  Pip-In "$Data\clone\.venv" 'torch==2.8.0+cu128' 'torchaudio==2.8.0+cu128' --index-url https://download.pytorch.org/whl/cu128
  Pip-In "$Data\clone\.venv" 'f5-tts==1.1.22' 'soundfile>=0.12'
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
  if ($LASTEXITCODE) { throw 'the test line failed' }
  $clone = 'f5-tts'
  Installed $clone
 } catch {
  Write-Output "The cloned voice did not install ($_). Often a network that blocks huggingface.co, PyPI or download.pytorch.org. Kokoro will be the voice; run setup again to retry."
 }
} elseif (-not $KokoroOnly) {
  Write-Output 'No NVIDIA GPU found: the cloned voice needs one, so Kokoro will be the voice.'
}

Step "Done. Voices installed in $Data (cloned voice: $clone)"
