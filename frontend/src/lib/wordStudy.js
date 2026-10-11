/** Normalize an English lookup token while preserving contractions and hyphenated words. */
export function normalizeStudyWord(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[‐‑‒–—]/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
}

function textOf(word) { return typeof word === 'string' ? word : word?.text ?? word?.word ?? '' }

/**
 * Match by sentence order in both directions. A repeated word is safe only when
 * both passes identify the same occurrence; otherwise prefer standalone speech.
 */
export function wordAudioRange(words, index, sentence, padding = 0.035) {
  if (!Array.isArray(words) || !Number.isInteger(index) || index < 0 || index >= words.length) return null
  const source = sentence?.words
  if (!Array.isArray(source) || !source.length) return null
  const start = sentence.start, end = sentence.end
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) return null
  const targets = words.map(word => normalizeStudyWord(textOf(word)))
  if (!targets[index]) return null
  const tokens = source.map(word => normalizeStudyWord(textOf(word)))
  const forward = [], backward = []
  let cursor = 0
  for (let i = 0; i < targets.length; i++) {
    if (!targets[i]) continue
    let match = cursor
    while (match < tokens.length && tokens[match] !== targets[i]) match++
    if (match < tokens.length) { forward[i] = match; cursor = match + 1 }
  }
  cursor = tokens.length - 1
  for (let i = targets.length - 1; i >= 0; i--) {
    if (!targets[i]) continue
    let match = cursor
    while (match >= 0 && tokens[match] !== targets[i]) match--
    if (match >= 0) { backward[i] = match; cursor = match - 1 }
  }
  const sourceIndex = forward[index]
  if (sourceIndex === undefined || sourceIndex !== backward[index]) return null
  const word = source[sourceIndex]
  if (!Number.isFinite(word.start) || !Number.isFinite(word.end)
    || word.start < start - 0.02 || word.end > end + 0.02 || word.end <= word.start) return null
  const margin = Number.isFinite(padding) ? Math.max(0, Math.min(padding, 0.1)) : 0.035
  let clipStart = Math.max(start, word.start - margin)
  let clipEnd = Math.min(end, word.end + margin)
  const previousEnd = source[sourceIndex - 1]?.end
  const nextStart = source[sourceIndex + 1]?.start
  if (Number.isFinite(previousEnd) && previousEnd <= word.start) clipStart = Math.max(clipStart, previousEnd)
  if (Number.isFinite(nextStart) && nextStart >= word.end) clipEnd = Math.min(clipEnd, nextStart)
  if (clipEnd <= clipStart) return null
  return { start: clipStart, end: clipEnd, sourceIndex }
}
