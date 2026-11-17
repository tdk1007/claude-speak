// Mac vs Windows: everything the mod runs on the host, built per system.
// The system is read off the mod's own folder ($.plugin.root): a drive letter
// or a backslash means Windows. Pure functions, so tests can check both.

export type OS = 'mac' | 'windows'

export function osOf(pluginRoot: string): OS {
  return /^[A-Za-z]:[\\/]/.test(pluginRoot) || pluginRoot.includes('\\') ? 'windows' : 'mac'
}

export type Host = {
  os: OS
  root: string // the mod's folder
  data: string // where setup put the voices
  tmp: string // clips and logs
}

export function join(os: OS, ...parts: string[]): string {
  const sep = os === 'windows' ? '\\' : '/'
  return parts.map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, '') : p.replace(/^[\\/]+|[\\/]+$/g, ''))).join(sep)
}

// The command that prints the folder the data lives under.
export function homeProbe(os: OS): string[] {
  return os === 'windows'
    ? ['powershell', '-NoProfile', '-Command', "[Environment]::GetFolderPath('LocalApplicationData')"]
    : ['/bin/sh', '-c', 'printf %s "$HOME"']
}

export function hostFrom(os: OS, root: string, probed: string): Host {
  const base = probed.trim()
  if (os === 'windows') {
    const data = join(os, base, 'claude-speak')
    return { os, root, data, tmp: join(os, data, 'tmp') }
  }
  return { os, root, data: join(os, base, '.local', 'share', 'claude-speak'), tmp: '/tmp/claude-speak' }
}

export function python(h: Host, venv: 'kokoro' | 'clone'): string {
  return h.os === 'windows'
    ? join(h.os, h.data, venv, '.venv', 'Scripts', 'python.exe')
    : join(h.os, h.data, venv, '.venv', 'bin', 'python')
}

const ps = (file: string, ...args: string[]) => ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args]

export type ServiceName = 'kokoro' | 'clone'
export const PORTS: Record<ServiceName, number> = { kokoro: 47711, clone: 47712 }

// The service's own command line. `sample` replaces the bundled voice sample.
export function serviceArgv(h: Host, name: ServiceName, sample?: string): string[] {
  const common = ['--port', String(PORTS[name]), '--root', h.tmp, '--idle', h.os === 'windows' ? '900' : '3600']
  if (name === 'kokoro') {
    return [python(h, 'kokoro'), '-I', join(h.os, h.root, 'services', 'kokoro', 'server.py'), ...common, '--model', join(h.os, h.data, 'kokoro', 'models')]
  }
  // Mac: Chatterbox Turbo takes a ~10 s sample. Windows: F5 takes a ~6 s sample plus its transcript (.txt beside it).
  const file = h.os === 'windows' ? 'server_windows.py' : 'server_mac.py'
  const ref = sample || join(h.os, h.root, 'voice', h.os === 'windows' ? 'ref-short.wav' : 'ref.wav')
  return [python(h, 'clone'), '-I', join(h.os, h.root, 'services', 'clone', file), ...common, '--ref', ref]
}

// Starts a command in the background, detached, its output in `log`.
export function startDetached(h: Host, argv: string[], log: string): string[] {
  if (h.os === 'windows') {
    // Start-Process joins -ArgumentList without quoting, so each argument is quoted here.
    const q = (s: string) => `'${s.replace(/'/g, "''")}'`
    const args = argv.slice(1).map(a => `"${a}"`).join(' ')
    return ['powershell', '-NoProfile', '-Command',
      `Start-Process -FilePath ${q(argv[0]!)} -ArgumentList ${q(args)} -WindowStyle Hidden -RedirectStandardOutput ${q(log)} -RedirectStandardError ${q(log + '.err')}`]
  }
  return ['/bin/sh', '-c', 'log="$1"; shift; nohup "$@" >"$log" 2>&1 &', 'sh', log, ...argv]
}

export function mkdir(h: Host, dir: string): string[] {
  return h.os === 'windows'
    ? ['powershell', '-NoProfile', '-Command', `New-Item -ItemType Directory -Force -Path '${dir.replace(/'/g, "''")}' | Out-Null`]
    : ['mkdir', '-p', dir]
}

// Deletes this reading's clips (and the Windows player's marker files).
export function removeClips(h: Host, prefix: string): string[] {
  return h.os === 'windows'
    ? ['powershell', '-NoProfile', '-Command', `Remove-Item -Force -ErrorAction SilentlyContinue '${join(h.os, h.tmp, prefix).replace(/'/g, "''")}*'`]
    : ['/bin/sh', '-c', 'rm -f "$1"*', 'sh', join(h.os, h.tmp, prefix)]
}

export function micWatcher(h: Host): string[] {
  return h.os === 'windows'
    ? ps(join(h.os, h.root, 'services', 'mic', 'mic_watch_win.ps1'))
    : [python(h, 'kokoro'), '-I', join(h.os, h.root, 'services', 'mic', 'mic_watch_mac.py')]
}

export function windowsPlayer(h: Host, clips: string[]): string[] {
  return ps(join(h.os, h.root, 'services', 'play', 'play_win.ps1'), ...clips)
}

export function setupCommand(h: Host): string[] {
  return h.os === 'windows'
    ? ps(join(h.os, h.root, 'setup', 'setup-windows.ps1'))
    : ['/bin/bash', join(h.os, h.root, 'setup', 'setup-mac.sh')]
}

// Windows' own voice, for when the engine's speech is missing; the text rides in SPEAK_TEXT.
export const WINDOWS_SAY = ['powershell', '-NoProfile', '-Command',
  'Add-Type -AssemblyName System.Speech; (New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak($env:SPEAK_TEXT)']
