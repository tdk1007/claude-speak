import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'speak',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80 },
} as const

test('the band toggles conversation mode and saves it', async ($, on) => {
  const store: Record<string, unknown> = {}
  on('command.register', () => ({ value: { command: 'speak' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', (_, e) => ({ value: store[e.key] }))
  on('store.set', (_, e) => {
    store[e.key] = e.value
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('clock.sleep', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/Users/sam', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', () => ({ value: '' }))
  on('fs.write', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface } as any)
    expect((await ui.find({ type: 'Button', key: 'read' })) !== undefined).toBe(true)
    const before = (await ui.find({ type: 'Button', key: 'conversation' })) as any
    const wasOn = String(before?.props?.label ?? before?.text).includes('ON')
    await ui.press({ key: 'conversation' } as any)
    expect((store.settings as { enabled: boolean }).enabled).toBe(!wasOn)
    const after = (await ui.find({ type: 'Button', key: 'conversation' })) as any
    expect(String(after?.props?.label ?? after?.text).includes('ON')).toBe(!wasOn)
    await ui.unmount()
  }
})

test('before setup the band offers it instead of the voice switch', async ($, on) => {
  on('command.register', () => ({ value: { command: 'speak' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }))
  on('clock.sleep', () => ({ value: undefined }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '/Users/sam', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('fs.read', () => ({ value: '' }))
  on('fs.write', () => ({ value: undefined }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  let setup: unknown
  // Setup is checked in the background after session.start.
  for (let i = 0; i < 50 && !setup; i++) {
    await new Promise(r => (globalThis as any).setTimeout(r, 20))
    setup = await ui.find({ type: 'Button', key: 'setup' })
  }
  expect(setup !== undefined).toBe(true)
  expect((await ui.find({ type: 'Button', key: 'voice' })) === undefined).toBe(true)
  await ui.unmount()
})
