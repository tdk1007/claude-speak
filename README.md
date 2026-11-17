# speak: Claude reads its answers aloud

A Claude Code mod that reads Claude's replies out loud with voices that run on your own computer, on **macOS and Windows**. Nothing is sent to a speech service.

Three buttons sit above the prompt:

- **🔊 Read last** reads Claude's last reply. While it talks it becomes **■ Stop**.
- **🎙 Voice: Clone / Kokoro** switches between the bundled cloned voice and the stock Kokoro voice.
- **🗣 Conversation: ON / off** reads every new reply as soon as it finishes.

It **stops talking the moment you start dictating**: as soon as any app starts using the microphone (Claude's own dictation, macOS dictation, Windows Win+H, Wispr Flow, Superwhisper and so on), the reading stops. Apps that were already using the mic when the reading began, such as a call or Discord voice chat, are ignored.

## Install

At the prompt of a terminal session:

```
/plugin install speak --marketplace tdk1007/claude-speak
```

Answer `y` to add the marketplace, then pick the user scope. From a shell: `claude plugin install speak --marketplace tdk1007/claude-speak`. In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `tdk1007/claude-speak`, then **Add plugin**.

Then click **⚙ Set up voices** above the prompt (or type `/speak setup`). The mod detects whether you are on a Mac or Windows and installs the right voices:

| | Mac | Windows |
|---|---|---|
| Kokoro (stock voices, CPU) | any Mac | any PC |
| Cloned voice | Apple silicon (M1 or later): Chatterbox Turbo on the GPU via MLX | NVIDIA GPU: F5-TTS v1 on CUDA, light enough to run beside a game (~0.8 GB VRAM) |
| Download, first run | ~3.5 GB | ~4 GB (PyTorch with CUDA plus the model) |
| Installed to | `~/.local/share/claude-speak` | `%USERPROFILE%\.local\share\claude-speak` |

Setup installs [uv](https://docs.astral.sh/uv/) if it is missing, and uv fetches its own Python, so nothing else needs to be on the computer first. On a computer that can't run the cloned voice, setup installs Kokoro only and the mod uses that. Before setup, or if a voice fails to start, the mod falls back to the computer's own system voice.

You can also run setup yourself: `bash setup/setup-mac.sh` on a Mac, or `powershell -NoProfile -ExecutionPolicy Bypass -File setup\setup-windows.ps1` on Windows.

## Install without GitHub (offline zip)

For a machine that can't reach GitHub, use `speak-<version>-offline.zip`. It holds the whole mod plus the Kokoro model files, which normally download from GitHub.

1. Unzip it somewhere it can stay, for example `~/claude-plugins/speak` (Mac) or `%USERPROFILE%\claude-plugins\speak` (Windows). The folder that holds `README.md` is the one to use.
2. In a terminal: `claude plugin marketplace add ~/claude-plugins/speak`, then `claude plugin install speak@claude-speak`. Or put the folder's path in the `CLAUDE_CODE_PLUGIN_DIRS` setting (`:`-separated on a Mac, `;` on Windows).
3. Start a new session and click **⚙ Set up voices**.

Without GitHub, setup can't install uv, so it uses a Python 3.10 to 3.13 that's already on the machine (python.org or Homebrew; on Windows the `py` launcher). Python packages still come from PyPI, PyTorch from download.pytorch.org, and the cloned voice's model from huggingface.co. If those are blocked too, setup still finishes with Kokoro, and the cloned voice can be retried later with `/speak setup`.

## Commands

`/speak` shows status. Also: `on` · `off` · `stop` · `test` · `setup` · `engine clone|kokoro|system` · `kvoice am_michael` (Kokoro voice) · `sysvoice <name>` · `sample <wav>` · `mic on|off` · `max <chars>` · `player powershell|engine` (Windows).

## Use your own voice

The bundled voice in `voice/` is synthetic. It was generated, not recorded from a person. To clone a different voice, record about 10 seconds of clear speech as a WAV and run `/speak sample /path/to/voice.wav`. On Windows, F5-TTS also needs the exact words spoken in a `.txt` file next to the WAV (`voice.txt` for `voice.wav`). `/speak sample default` goes back to the bundled voice. Only clone voices you have the right to use.

## How it works

- `hooks/`: the mod (a Claude Code hooks module). `platform.ts` reads the system off the mod's own folder and builds every command for Mac or Windows.
- `services/`: small Python services on `127.0.0.1` (Kokoro on port 47711, the cloned voice on 47712). They start on the first reading, make the next clip while the current one plays, and quit after an idle hour (15 minutes on Windows) to give the memory back. On Windows they run at below-normal CPU priority.
- `services/mic/`: the microphone watchers. On a Mac it uses Core Audio's per-app list (macOS 14.2+; older versions watch the input device). On Windows it reads the same registry list as the taskbar's mic icon.
- Logs: `/tmp/claude-speak/` on a Mac, `%USERPROFILE%\.local\share\claude-speak\tmp` on Windows (`events.log`, `kokoro.log`, `clone.log`). Setup writes `setup.log` to the install folder.

## Licenses

The mod is MIT licensed. The voice models it downloads have their own licenses: Kokoro (Apache 2.0), Chatterbox Turbo (MIT), and F5-TTS, whose pretrained weights are **CC BY-NC 4.0 (non-commercial use only)**.
