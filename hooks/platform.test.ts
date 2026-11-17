import { expect, test } from 'claude-code/testing'
import { hostFrom, micWatcher, osOf, serviceArgv, setupCommand, startDetached } from './platform'

test('the system is read off the mod folder', async () => {
  expect(osOf('/Users/sam/.claude/plugins/cache/speak')).toBe('mac')
  expect(osOf('C:\\Users\\Sam\\.claude\\plugins\\cache\\speak')).toBe('windows')
  expect(osOf('D:/plugins/speak')).toBe('windows')
})

test('Mac commands use the Mac services and setup', async () => {
  const h = hostFrom('mac', '/p/speak', '/Users/sam\n')
  expect(h.data).toBe('/Users/sam/.local/share/claude-speak')
  const clone = serviceArgv(h, 'clone')
  expect(clone[0]).toBe('/Users/sam/.local/share/claude-speak/clone/.venv/bin/python')
  expect(clone.includes('/p/speak/services/clone/server_mac.py')).toBe(true)
  expect(clone.includes('/p/speak/voice/ref.wav')).toBe(true)
  expect(setupCommand(h)).toEqual(['/bin/bash', '/p/speak/setup/setup-mac.sh'])
  expect(micWatcher(h).at(-1)).toBe('/p/speak/services/mic/mic_watch_mac.py')
})

test('Windows commands use F5, PowerShell and quoted paths', async () => {
  const h = hostFrom('windows', 'C:\\Users\\Sam Lee\\speak', 'C:\\Users\\Sam Lee\\AppData\\Local\r\n')
  expect(h.data).toBe('C:\\Users\\Sam Lee\\AppData\\Local\\claude-speak')
  expect(h.tmp).toBe('C:\\Users\\Sam Lee\\AppData\\Local\\claude-speak\\tmp')
  const clone = serviceArgv(h, 'clone')
  expect(clone[0]).toBe('C:\\Users\\Sam Lee\\AppData\\Local\\claude-speak\\clone\\.venv\\Scripts\\python.exe')
  expect(clone.includes('C:\\Users\\Sam Lee\\speak\\services\\clone\\server_windows.py')).toBe(true)
  expect(clone.includes('C:\\Users\\Sam Lee\\speak\\voice\\ref-short.wav')).toBe(true)
  expect(clone[clone.indexOf('--idle') + 1]).toBe('900')
  expect(setupCommand(h).at(-1)).toBe('C:\\Users\\Sam Lee\\speak\\setup\\setup-windows.ps1')
  const start = startDetached(h, clone, 'C:\\t\\clone.log').at(-1)!
  expect(start.includes('"C:\\Users\\Sam Lee\\speak\\services\\clone\\server_windows.py"')).toBe(true)
  expect(start.includes('-WindowStyle Hidden')).toBe(true)
})
