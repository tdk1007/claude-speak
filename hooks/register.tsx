import { atom, read, update } from 'claude-code'
import type { EngineInterface, HookStream, ProcessSpawnChunk, ProcessSpawnResult, Register } from 'claude-code'

import {
  homeProbe, hostFrom, join, micWatcher, mkdir, osOf, PORTS, removeClips, serviceArgv, setupCommand,
  startDetached, windowsPlayer, WINDOWS_SAY,
} from './platform'
import type { Host, ServiceName } from './platform'
import { forSpeech, toChunks } from './speech-text'

// Reads Claude's answers aloud with local voices, on macOS and Windows:
//   clone:  the bundled cloned voice (voice/), Chatterbox Turbo on a Mac's GPU, F5-TTS on an NVIDIA GPU
//   kokoro: stock Kokoro voices on the CPU, any machine
//   system: the computer's own voice, needs no setup
// Setup ("Set up voices" / `/speak setup`) runs setup/setup-<os> for the system it finds.
// While it reads, a watcher stops it the moment an app starts using the mic (dictation).
// Settings live in $.store (shared across sessions); "Conversation mode" is Settings.enabled.

type Engine = 'clone' | 'kokoro' | 'system'
const ENGINES: readonly string[] = ['clone', 'kokoro', 'system']

type Settings = {
  enabled: boolean
  voiceEngine: Engine
  kokoroVoice: string // af_heart, am_michael, bf_emma, ...
  kokoroSpeed: number
  systemVoice: string // the system voice's exact name; '' for the default
  maxChars: number // longer answers are cut at a sentence and end "The rest is on screen."
  stopOnMic: boolean // stop reading when an app starts using the mic
  sample: string // a WAV to clone instead of the bundled voice ('' = bundled)
  player: 'engine' | 'powershell' // Windows: who plays clips
}

const DEFAULTS: Settings = {
  enabled: false,
  voiceEngine: 'clone',
  kokoroVoice: 'am_michael',
  kokoroSpeed: 1.1,
  systemVoice: '',
  maxChars: 1500,
  stopOnMic: true,
  sample: '',
  player: 'powershell',
}

// Module variables reset on reload; that only loses the in-flight playback.
let generation = 0
let playing: AbortController | undefined
let player: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | undefined
let mic: HookStream<ProcessSpawnChunk, ProcessSpawnResult> | undefined
let hostCache: Host | undefined
// Set once this copy starts a reading itself: then there is nothing of an older copy's to resume.
let spokeHere = false
const instance = Math.random().toString(36).slice(2, 8)

// Session values the band draws from; they survive a reload.
const lastAnswer = atom({ plugin: 'speak', key: 'lastAnswer' } as const, '')
const isSpeaking = atom({ plugin: 'speak', key: 'isSpeaking' } as const, false)
const isConversation = atom({ plugin: 'speak', key: 'isConversation' } as const, false)
// What is being read, until it finishes or the person cuts it off. A reload of
// this mod (each edit) kills playback in flight; the new copy picks it up.
const pendingSpeech = atom({ plugin: 'speak', key: 'pendingSpeech' } as const, '')
// When the last main-thread turn ended, and when a reading last started (ms).
const turnEndedAt = atom({ plugin: 'speak', key: 'turnEndedAt' } as const, 0)
const readStartedAt = atom({ plugin: 'speak', key: 'readStartedAt' } as const, 0)
// Which voice the Voice button shows.
const currentEngine = atom({ plugin: 'speak', key: 'currentEngine' } as const, 'clone')
// What setup found: '' unknown, 'none' not set up, 'kokoro' Kokoro only, else the clone engine's name.
const installed = atom({ plugin: 'speak', key: 'installed' } as const, '')
// Setup's latest step while it runs; '' when not running.
const setupStep = atom({ plugin: 'speak', key: 'setupStep' } as const, '')

// Bump to push new defaults over what earlier versions stored.
const SETTINGS_VERSION = 5

async function settings($: EngineInterface): Promise<Settings> {
  const saved = ((await $.store.get('settings')) ?? {}) as Partial<Settings> & { v?: number; voiceEngine?: string }
  if (saved.v !== SETTINGS_VERSION) {
    const engine = ENGINES.includes(saved.voiceEngine ?? '') ? (saved.voiceEngine as Engine) : 'clone' // 'edge' is gone
    const next = { ...DEFAULTS, ...saved, voiceEngine: engine, systemVoice: '', v: SETTINGS_VERSION }
    await $.store.set('settings', next)
    return next
  }
  return { ...DEFAULTS, ...saved }
}

async function save($: EngineInterface, patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await settings($)), ...patch }
  await $.store.set('settings', next)
  await update($, isConversation, () => next.enabled)
  await update($, currentEngine, () => next.voiceEngine)
  return next
}

async function host($: EngineInterface): Promise<Host> {
  if (hostCache) return hostCache
  const os = osOf($.plugin.root)
  const r = await $.process.run(homeProbe(os), { timeoutMs: 15_000 })
  hostCache = hostFrom(os, $.plugin.root, r.stdout)
  await $.process.run(mkdir(hostCache, hostCache.tmp)).catch(() => {})
  return hostCache
}

// Reads <data>/installed.json, which setup writes last.
async function checkInstalled($: EngineInterface): Promise<string> {
  const h = await host($)
  const raw = await $.fs.read(join(h.os, h.data, 'installed.json')).catch(() => '')
  let found = 'none'
  try {
    const j = JSON.parse(String(raw)) as { kokoro?: boolean; clone?: string }
    if (j.kokoro) found = j.clone && j.clone !== 'none' ? j.clone : 'kokoro'
  } catch {}
  await update($, installed, () => found)
  return found
}

// Everything Claude wrote since the person last spoke, as the transcript
// shows it (the turn's answer alone is only its final text block).
const MID_TURN = 'The user sent a new message while you were working'

async function lastReply($: EngineInterface): Promise<string> {
  const messages = await $.session.messages().catch(() => [])
  const parts: string[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'user') {
      const isPrompt = !m.toolResults?.length && m.text.trim() !== ''
      if (isPrompt || m.text.includes(MID_TURN)) break
      continue
    }
    if (m.text.trim()) parts.unshift(m.text.trim())
  }
  return parts.join('\n\n')
}

// A line in <tmp>/events.log (last 400 lines kept), for seeing why a reading did or did not start.
async function note($: EngineInterface, line: string) {
  try {
    const h = await host($)
    const file = join(h.os, h.tmp, 'events.log')
    const old = String(await $.fs.read(file).catch(() => ''))
    const stamp = new Date().toISOString().slice(11, 19)
    await $.fs.write(file, [...old.split('\n').filter(Boolean).slice(-399), `${stamp} ${instance} ${line}`].join('\n') + '\n')
  } catch {}
}

// The person's stop: also forgets what was left to read.
async function cancel($: EngineInterface) {
  await update($, pendingSpeech, () => '')
  await stop($)
}

async function stop($: EngineInterface) {
  generation++
  playing?.abort()
  playing = undefined
  void player?.return(undefined as never).catch(() => {})
  player = undefined
  stopMicWatch()
  await update($, isSpeaking, () => false)
}

function stopMicWatch() {
  void mic?.return(undefined as never).catch(() => {})
  mic = undefined
}

// While reading: stop as soon as an app starts using the microphone (dictation
// in Claude, the system's dictation, Wispr Flow...). Apps already recording when
// the reading starts (a call, voice chat) are ignored by the watcher.
async function watchMic($: EngineInterface, h: Host, s: Settings, mine: number) {
  if (!s.stopOnMic || mic) return
  if (h.os === 'mac' && !(await $.fs.exists(micWatcher(h)[0]!).catch(() => false))) return // needs setup's Python
  const stream = $.process.spawn({ argv: micWatcher(h) })
  mic = stream
  void (async () => {
    try {
      for await (const { stream: pipe, text } of stream) {
        const hit = pipe === 'stdout' && text.split('\n').find(l => l.startsWith('mic '))
        if (hit) {
          if (mic === stream) mic = undefined
          if (mine === generation) {
            await note($, `stopped: ${hit.trim()}`)
            await cancel($)
          }
          break
        }
      }
    } catch (err) {
      await note($, `mic watcher failed: ${String(err).slice(0, 160)}`)
    }
  })()
}

// The local voices run as small services on 127.0.0.1, started on the first
// request, kept loaded between clips, quitting after an idle hour (15 min on Windows).
async function serviceUp($: EngineInterface, name: ServiceName): Promise<boolean> {
  const r = await $.http.fetch(`http://127.0.0.1:${PORTS[name]}/health`).catch(() => undefined)
  return !!r?.ok
}

async function ensureService($: EngineInterface, name: ServiceName, s: Settings, onSlowStart: () => void): Promise<boolean> {
  if (await serviceUp($, name)) return true
  const h = await host($)
  const argv = serviceArgv(h, name, s.sample || undefined)
  if (!(await $.fs.exists(argv[0]!).catch(() => false))) return false // not set up
  const log = join(h.os, h.tmp, `${name}.log`)
  // A second copy cannot bind the port and exits, so a race here is harmless.
  const r = await $.process.run(startDetached(h, argv, log), { timeoutMs: 15_000 }).catch(() => undefined)
  if (!r || r.exitCode !== 0) return false
  const waitMs = name === 'clone' ? 120_000 : 20_000
  for (let waited = 0; waited < waitMs; waited += 250) {
    if (waited === 3_000) onSlowStart()
    await $.clock.sleep(250)
    if (await serviceUp($, name)) return true
  }
  return false
}

async function serviceSynth($: EngineInterface, name: ServiceName, body: object, file: string): Promise<boolean> {
  const r = await $.http
    .fetch(`http://127.0.0.1:${PORTS[name]}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, out: file }),
    })
    .catch(() => undefined)
  return !!r?.ok
}

async function speak($: EngineInterface, text: string) {
  spokeHere = true
  await note($, `speak ${text.length}ch`)
  await update($, readStartedAt, () => Date.now())
  await update($, pendingSpeech, () => text)
  await speakNow($, text)
  // Reached only when the reading ran its course or was replaced.
  if ((await read($, pendingSpeech)) === text) await update($, pendingSpeech, () => '')
}

async function speakNow($: EngineInterface, text: string) {
  const s = await settings($)
  await stop($)
  const mine = generation
  const chunks = toChunks(text)
  if (chunks.length === 0) return
  const h = await host($)
  await update($, isSpeaking, () => true)
  void watchMic($, h, s, mine)
  try {
    if (s.voiceEngine === 'system') return void (await speakSystem($, h, s, chunks, mine))
    const setup = (await read($, installed)) || (await checkInstalled($))
    if (setup === 'none') {
      $.ui.toast('speak: voices not set up yet; using the system voice. Click "Set up voices" or run /speak setup.')
      return void (await speakSystem($, h, s, chunks, mine))
    }
    if (s.voiceEngine === 'clone' && setup !== 'kokoro') {
      const up = await ensureService($, 'clone', s, () => $.ui.toast('speak: starting the cloned voice…'))
      if (mine !== generation) return
      if (up) return void (await play($, h, s, chunks, mine, (t, f) => serviceSynth($, 'clone', { text: t }, f)))
      $.ui.toast(`speak: the cloned voice did not start; using Kokoro. See ${join(h.os, h.tmp, 'clone.log')}`)
    }
    if (!(await ensureService($, 'kokoro', s, () => {}))) {
      $.ui.toast(`speak: Kokoro did not start; using the system voice. See ${join(h.os, h.tmp, 'kokoro.log')}`)
      return void (await speakSystem($, h, s, chunks, mine))
    }
    if (mine !== generation) return
    await play($, h, s, chunks, mine, (t, f) => serviceSynth($, 'kokoro', { text: t, voice: s.kokoroVoice, speed: s.kokoroSpeed }, f))
  } finally {
    if (mine === generation) {
      stopMicWatch()
      await update($, isSpeaking, () => false)
    }
  }
}

// The computer's own voice, a clip at a time so Stop takes effect between clips.
async function speakSystem($: EngineInterface, h: Host, s: Settings, chunks: string[], mine: number) {
  for (const chunk of chunks) {
    if (mine !== generation) return
    const opts = s.systemVoice ? { voice: s.systemVoice } : undefined
    const ok = await $.audio.speak(chunk, opts).then(() => true, () => $.audio.speak(chunk).then(() => true, () => false))
    if (!ok && h.os === 'windows') await $.process.run(WINDOWS_SAY, { env: { SPEAK_TEXT: chunk }, timeoutMs: 120_000 }).catch(() => {})
  }
}

async function play(
  $: EngineInterface,
  h: Host,
  s: Settings,
  chunks: string[],
  mine: number,
  synthOne: (text: string, file: string) => Promise<boolean>,
) {
  const prefix = `${instance}-${mine}-`
  const file = (i: number) => join(h.os, h.tmp, `${prefix}${i}.wav`)
  await $.process.run(mkdir(h, h.tmp)).catch(() => {})

  // Make every clip in order, one at a time (the services take one request at
  // a time), running ahead of playback so the next clip is usually ready.
  const ready: Promise<boolean>[] = []
  let chain: Promise<boolean> = Promise.resolve(true)
  for (let i = 0; i < chunks.length; i++) {
    chain = chain.then(() => (mine === generation ? synthOne(chunks[i]!, file(i)) : false))
    ready.push(chain)
  }

  if (h.os === 'windows' && s.player === 'powershell') await playWindows($, h, chunks, mine, ready, file)
  else await playEngine($, chunks, mine, ready, file)
  await $.process.run(removeClips(h, prefix)).catch(() => {})
}

// The engine's own player (Mac, and Windows with /speak player engine).
async function playEngine($: EngineInterface, chunks: string[], mine: number, ready: Promise<boolean>[], file: (i: number) => string) {
  for (let i = 0; i < chunks.length; i++) {
    const ok = await ready[i]!
    if (mine !== generation) return
    if (!ok) {
      // The voice gave up on this clip: say it with the system voice rather than going silent.
      await $.audio.speak(chunks[i]!).catch(() => {})
      continue
    }
    const { base64 } = (await $.fs.read(file(i), { as: 'bytes' })) as { base64: string }
    if (mine !== generation) return
    playing = new AbortController()
    try {
      await $.audio.play({ base64, mime: 'audio/wav' }, { signal: playing.signal })
    } catch (err) {
      if (mine !== generation) return
      $.ui.toast(`speak: could not play audio (${String(err).slice(0, 120)})`)
      return
    }
  }
}

// Windows: one PowerShell player for the whole reading, told each clip is
// ready by a marker file, so clips follow each other with no start-up gap.
async function playWindows(
  $: EngineInterface, h: Host, chunks: string[], mine: number, ready: Promise<boolean>[], file: (i: number) => string,
) {
  const stream = $.process.spawn({ argv: windowsPlayer(h, chunks.map((_, i) => file(i))) })
  player = stream
  ready.forEach((p, i) => void p.then(ok => (mine === generation ? $.fs.write(file(i) + (ok ? '.ready' : '.skip'), '') : undefined)).catch(() => {}))
  try {
    for await (const _ of stream) if (mine !== generation) break
  } catch (err) {
    if (mine === generation) $.ui.toast(`speak: could not play audio (${String(err).slice(0, 120)})`)
  }
  if (player === stream) player = undefined
}

// Runs setup for this system, showing its steps above the prompt.
async function runSetup($: EngineInterface) {
  if (await read($, setupStep)) return $.ui.toast('speak: setup is already running.')
  const h = await host($)
  await update($, setupStep, () => 'starting…')
  const lines: string[] = []
  let code: number | null = null
  try {
    const stream = $.process.spawn({ argv: setupCommand(h) })
    for await (const { text } of stream) {
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue
        lines.push(line)
        if (line.startsWith('==> ')) await update($, setupStep, () => line.slice(4))
      }
    }
    code = (await stream.result).code
  } catch (err) {
    lines.push(String(err))
  }
  await $.fs.write(join(h.os, h.data, 'setup.log'), lines.join('\n') + '\n').catch(() => {})
  await update($, setupStep, () => '')
  const found = await checkInstalled($)
  if (code === 0 && found !== 'none') {
    $.ui.toast(found === 'kokoro' ? 'speak: Kokoro is ready (this computer cannot run the cloned voice).' : 'speak: voices are ready.')
    void speak($, 'Setup is done. I will read my answers out loud.')
  } else {
    $.ui.toast(`speak: setup failed. See ${join(h.os, h.data, 'setup.log')}`)
  }
}

// After a load: finish a reading the old copy was cut off from.
async function resumeAfterReload($: EngineInterface) {
  for (let waited = 0; waited <= 6_000; waited += 250) {
    if (spokeHere) return
    const left = await read($, pendingSpeech)
    if (left) {
      await note($, `session.start (load) resuming ${left.length}ch after ${waited}ms`)
      return void speak($, left).catch(err => note($, `resume failed: ${String(err).slice(0, 200)}`))
    }
    await $.clock.sleep(250)
  }
  if (spokeHere) return
  const ended = await read($, turnEndedAt)
  const readAt = await read($, readStartedAt)
  const s = await settings($)
  const fresh = ended > 0 && Date.now() - ended < 30_000 && readAt < ended
  if (!s.enabled || !fresh) return
  const text = forSpeech(await lastReply($), s.maxChars)
  if (text) void speak($, text).catch(err => note($, `catch-up failed: ${String(err).slice(0, 200)}`))
}

const HELP =
  'Commands: /speak on · off · stop · test · setup · engine clone|kokoro|system · kvoice <name> · sysvoice <name> · ' +
  'sample <wav>|default · mic on|off · max <chars> · player engine|powershell (Windows)'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'speak', description: 'Read answers aloud: /speak on|off|stop|test|setup|engine|mic' })
    const s = await settings($)
    await update($, isConversation, () => s.enabled)
    await update($, currentEngine, () => s.voiceEngine)
    const started = await next(e)
    void checkInstalled($).catch(() => {})
    void resumeAfterReload($).catch(() => {})
    return started
  })

  on('command.run', { command: 'speak' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')
    switch (verb.toLowerCase()) {
      case '':
      case 'status': {
        const s = await settings($)
        const h = await host($)
        const found = await checkInstalled($)
        const voice = s.voiceEngine === 'system' ? s.systemVoice || 'default' : s.voiceEngine === 'kokoro' ? s.kokoroVoice : s.sample || 'bundled'
        return {
          text: `speak is ${s.enabled ? 'ON' : 'OFF'} · ${h.os} · voices: ${found === 'none' ? 'not set up (/speak setup)' : found} · ` +
            `engine ${s.voiceEngine} (${voice}) · stop on mic ${s.stopOnMic ? 'on' : 'off'} · max ${s.maxChars} chars\n${HELP}`,
        }
      }
      case 'on':
        await save($, { enabled: true })
        return { text: 'speak: ON. Answers will be read aloud.' }
      case 'off':
        await save($, { enabled: false })
        await cancel($)
        return { text: 'speak: OFF.' }
      case 'stop':
      case 'shh':
        await cancel($)
        return { text: 'speak: stopped.' }
      case 'setup':
        void runSetup($)
        return { text: `speak: setting up voices for ${(await host($)).os === 'windows' ? 'Windows' : 'Mac'}. Progress shows above the prompt; the first run downloads a few GB.` }
      case 'kvoice':
        if (!arg) return { text: 'Usage: /speak kvoice af_heart   (am_michael, af_bella, bf_emma, bm_george, ...)' }
        await save($, { kokoroVoice: arg, voiceEngine: 'kokoro' })
        void speak($, 'This is my new voice.')
        return { text: `speak: Kokoro voice set to ${arg}.` }
      case 'engine':
        if (!ENGINES.includes(arg)) return { text: 'Usage: /speak engine clone   (or kokoro, system)' }
        await save($, { voiceEngine: arg as Engine })
        return { text: `speak: engine set to ${arg}.` }
      case 'sysvoice':
        if (!arg) return { text: 'Usage: /speak sysvoice Samantha   (a voice the system lists; "default" for its default)' }
        await save($, { systemVoice: arg === 'default' ? '' : arg, voiceEngine: 'system' })
        void speak($, 'This is the system voice.')
        return { text: `speak: system voice set to ${arg}.` }
      case 'sample': {
        if (!arg) return { text: 'Usage: /speak sample /path/to/voice.wav   (about 10 s of clear speech; Windows also needs the words in voice.txt beside it) · /speak sample default' }
        const sample = arg === 'default' ? '' : arg.replace(/^["']|["']$/g, '')
        if (sample && !(await $.fs.exists(sample).catch(() => false))) return { text: `speak: no file at ${sample}` }
        await save($, { sample, voiceEngine: 'clone' })
        // The service loads its sample at start: quit it, and the next reading starts it with the new one.
        await $.http.fetch(`http://127.0.0.1:${PORTS.clone}/quit`, { method: 'POST' }).catch(() => {})
        return { text: `speak: cloning ${sample || 'the bundled voice'} from the next reading on.` }
      }
      case 'mic':
        if (arg !== 'on' && arg !== 'off') return { text: 'Usage: /speak mic on|off   (stop reading when an app starts using the microphone)' }
        await save($, { stopOnMic: arg === 'on' })
        return { text: `speak: stop on mic ${arg}.` }
      case 'player':
        if (arg !== 'engine' && arg !== 'powershell') return { text: 'Usage: /speak player powershell|engine   (Windows: who plays the clips)' }
        await save($, { player: arg })
        return { text: `speak: player set to ${arg}.` }
      case 'max': {
        const n = Number(arg)
        if (!Number.isFinite(n) || n < 100) return { text: 'Usage: /speak max 1500   (characters, at least 100)' }
        await save($, { maxChars: Math.round(n) })
        return { text: `speak: will read up to ${Math.round(n)} characters per answer.` }
      }
      case 'test':
        void speak($, 'Hi. This is Claude, reading my answers out loud.')
        return { text: 'speak: playing a test line.' }
      default:
        return { text: `speak: unknown option "${verb}". ${HELP}` }
    }
  })

  // A new prompt cuts off whatever is still being read.
  on('prompt.submit', async ($, e, next) => {
    void cancel($).catch(() => {})
    return next(e)
  })

  // The band above the prompt: read the last answer (or stop), pick the voice,
  // toggle conversation mode; offers setup until the voices are installed.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const speaking = await read($, isSpeaking)
    const conversation = await read($, isConversation)
    const voiceEngine = (await read($, currentEngine)) as Engine
    const setup = await read($, installed)
    const step = await read($, setupStep)

    return (
      <Box flexDirection="row" gap={1}>
        {speaking ? (
          <Button key="stop" label="■ Stop" onPress={() => cancel($)} />
        ) : (
          <Button
            key="read"
            label="🔊 Read last"
            onPress={async () => {
              const text = (await lastReply($)) || (await read($, lastAnswer))
              if (!text) return $.ui.toast('Nothing to read yet.')
              const s = await settings($)
              void speak($, forSpeech(text, s.maxChars))
            }}
          />
        )}
        {step ? (
          <Text key="setup" dimColor>{`setting up voices: ${step}`}</Text>
        ) : setup === 'none' ? (
          <Button key="setup" label="⚙ Set up voices" onPress={() => void runSetup($)} />
        ) : (
          <Button
            key="voice"
            label={`🎙 Voice: ${voiceEngine === 'clone' ? 'Clone' : voiceEngine === 'kokoro' ? 'Kokoro' : 'System'}`}
            onPress={async () => {
              // Flip between the cloned voice and Kokoro (the system voice stays on /speak engine).
              const s = await save($, { voiceEngine: voiceEngine === 'clone' ? 'kokoro' : 'clone' })
              $.ui.toast(s.voiceEngine === 'clone' ? 'Voice: the cloned voice (slower to start).' : 'Voice: Kokoro (fast).')
            }}
          />
        )}
        <Button
          key="conversation"
          label={conversation ? '🗣 Conversation: ON' : '🗣 Conversation: off'}
          onPress={async () => {
            const s = await save($, { enabled: !conversation })
            if (!s.enabled) await cancel($)
            $.ui.toast(s.enabled ? 'Conversation mode on: answers will be read aloud.' : 'Conversation mode off.')
          }}
        />
        {conversation && <Text dimColor>reading every answer aloud</Text>}
      </Box>
    )
  })

  on('turn.complete', async ($, e, next) => {
    // First thing, before anything slow: a reload may cut this copy off any moment now.
    if (!e.agentId && e.reason === 'answer') await update($, turnEndedAt, () => Date.now())
    const result = await next(e)
    if (e.agentId || e.reason !== 'answer' || !e.answer.trim()) return result
    await update($, lastAnswer, () => e.answer)
    const s = await settings($)
    if (s.enabled) {
      const text = forSpeech((await lastReply($)) || e.answer, s.maxChars)
      // Saved before this hook returns: a reload right after the turn (each
      // edit of this mod) then finds it and reads it.
      await update($, pendingSpeech, () => text)
      void speak($, text).catch(err => note($, `speak failed: ${String(err).slice(0, 200)}`))
    }
    return result
  })
}
