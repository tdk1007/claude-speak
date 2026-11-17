const CHUNK = 320 // chars per synthesized clip: first audio starts fast, rest pipelines

// Markdown → something pleasant to hear.
export function forSpeech(md: string, maxChars: number): string {
  let t = md
    .replace(/```[\s\S]*?```/g, ' (code block on screen.) ')
    .replace(/^\s*\|.*\|\s*$/gm, '') // tables
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links → their text
    .replace(/https?:\/\/\S+/g, 'a link')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^#{1,6}\s+(.*)$/gm, '$1.')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)\1/g, '$2')
    .replace(/(\/[\w.~-]+){2,}\/([\w.-]+)/g, '$2') // long paths → file name
    .replace(/[·•→—–]/g, ', ')
    .replace(/\.\.+/g, '.')
    .replace(/\s*\n\s*\n\s*/g, '. ')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/([.!?:])\s*\./g, '$1')
    .trim()
  if (t.length > maxChars) {
    const cut = t.slice(0, maxChars)
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '))
    t = (end > maxChars / 3 ? cut.slice(0, end + 1) : cut) + ' The rest is on screen.'
  }
  return t
}

// Split at sentence ends into clips of about `size` characters (the first half that, unless shortFirst is false).
export function toChunks(text: string, size = CHUNK, shortFirst = true): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [text]
  const out: string[] = []
  let cur = ''
  for (const s of sentences) {
    // First clip short so speech starts quickly.
    const limit = out.length === 0 && shortFirst ? size / 2 : size
    if (cur && (cur + s).length > limit) {
      out.push(cur.trim())
      cur = ''
    }
    cur += s
  }
  if (cur.trim()) out.push(cur.trim())
  return out.filter(c => /\w/.test(c))
}
