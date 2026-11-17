import { expect, test } from 'claude-code/testing'
import { forSpeech, toChunks } from './speech-text'

test('markdown is cleaned for speech', async () => {
  const md = '## Done\n\nI fixed **the bug** in `src/app/main.ts` — see [the docs](https://x.y).\n\n```bash\nnpm test\n```\n\n| a | b |\n|---|---|\n\n- one\n- two'
  const t = forSpeech(md, 1500)
  expect(t.includes('**')).toBe(false)
  expect(t.includes('```')).toBe(false)
  expect(t.includes('https')).toBe(false)
  expect(t.includes('the docs')).toBe(true)
  expect(t.includes('main.ts')).toBe(true)
  expect(t.includes('code block on screen')).toBe(true)
})

test('long answers are cut and chunked', async () => {
  const t = forSpeech('This is a sentence. '.repeat(200), 500)
  expect(t.endsWith('The rest is on screen.')).toBe(true)
  const chunks = toChunks(t)
  expect(chunks.length > 1).toBe(true)
  expect(chunks.every(c => c.length <= 340)).toBe(true)
})
