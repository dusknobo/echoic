import { normalizeStudyWord } from './wordStudy.js'

function punctuation(value) {
  return typeof value === 'string' ? value.normalize('NFKC')
    .replace(/[’‘ʼ]/g, "'").replace(/[‐‑‒–—]/g, '-') : ''
}

function displayTokens(value) {
  return punctuation(value).match(/[a-z0-9]+(?:['-][a-z0-9]+)*/gi) || []
}

/** English token indices keep contractions and hyphenated words together. */
export function referenceTokens(text) {
  return displayTokens(text).map(normalizeStudyWord)
}

function sentenceText(sentence) {
  return typeof sentence === 'string' ? sentence : sentence?.text
}

/** Return every exact, contiguous occurrence; callers must choose repeated matches. */
export function comparisonTargets(text, sentence) {
  const query = referenceTokens(text)
  const display = displayTokens(sentenceText(sentence))
  const reference = display.map(normalizeStudyWord)
  if (!query.length || query.length > reference.length) return []
  const matches = []
  for (let startIndex = 0; startIndex <= reference.length - query.length; startIndex++) {
    if (!query.every((token, offset) => token === reference[startIndex + offset])) continue
    const endIndex = startIndex + query.length - 1
    const before = display.slice(Math.max(0, startIndex - 3), startIndex).join(' ')
    const selected = display.slice(startIndex, endIndex + 1).join(' ')
    const after = display.slice(endIndex + 1, endIndex + 4).join(' ')
    const context = [startIndex > 3 ? '…' : '', before, '【' + selected + '】', after, endIndex + 4 < display.length ? '…' : ''].filter(Boolean).join(' ')
    matches.push({ key: startIndex + ':' + endIndex + ':' + query.join(' '),
      startIndex, endIndex, text: selected, label: '第' + (matches.length + 1) + '处 · ' + context })
  }
  return matches
}

function timedEntries(words) {
  if (!Array.isArray(words) || !words.length) return null
  const entries = []
  for (const word of words) {
    const text = typeof word === 'string' ? word : word?.word ?? word?.text
    if (typeof text !== 'string') return null
    const tokens = referenceTokens(text)
    if (!tokens.length) {
      // Punctuation-only ASR entries have no word index. Unknown spoken words do.
      if (/\p{L}|\p{N}/u.test(text)) return null
      continue
    }
    // One timestamp cannot locate individual words within a merged token.
    if (tokens.length !== 1) return null
    entries.push({ token: tokens[0], start: word?.start, end: word?.end })
  }
  return entries.length ? entries : null
}

function uniqueMapping(reference, entries) {
  const forward = [], backward = []
  let cursor = 0
  for (const token of reference) {
    while (cursor < entries.length && entries[cursor].token !== token) cursor++
    if (cursor === entries.length) return null
    forward.push(cursor++)
  }
  cursor = entries.length - 1
  for (let index = reference.length - 1; index >= 0; index--) {
    while (cursor >= 0 && entries[cursor].token !== reference[index]) cursor--
    if (cursor < 0) return null
    backward[index] = cursor--
  }
  return forward.every((index, offset) => index === backward[offset]) ? forward : null
}

/**
 * Return a safe clip in the coordinate system of timedWords. Original timestamps
 * are absolute (bounds=sentence.start/end); recording timestamps are relative
 * (bounds={start:0,end:duration}, or {duration}). endIndex is inclusive.
 * Never estimate missing word positions from the total audio duration.
 */
export function comparisonAudioRange(target, sentence, timedWords = sentence?.words, bounds) {
  const reference = referenceTokens(sentenceText(sentence))
  const startIndex = target?.startIndex, endIndex = target?.endIndex
  if (!reference.length || !Number.isInteger(startIndex) || !Number.isInteger(endIndex)
    || startIndex < 0 || endIndex < startIndex || endIndex >= reference.length) return null
  const selected = referenceTokens(target.text)
  if (selected.length !== endIndex - startIndex + 1
    || !selected.every((token, offset) => token === reference[startIndex + offset])) return null

  const lower = bounds?.start ?? (bounds?.duration !== undefined ? 0 : sentence?.start)
  const upper = bounds?.end ?? bounds?.duration ?? sentence?.end
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || lower < 0 || upper <= lower) return null
  const entries = timedEntries(timedWords)
  if (!entries) return null
  const mapping = uniqueMapping(reference, entries)
  if (!mapping) return null
  const firstIndex = mapping[startIndex], lastIndex = mapping[endIndex]
  if (lastIndex - firstIndex !== endIndex - startIndex) return null
  const clipWords = entries.slice(firstIndex, lastIndex + 1)
  for (let index = 0; index < clipWords.length; index++) {
    const word = clipWords[index]
    if (!Number.isFinite(word.start) || !Number.isFinite(word.end) || word.end <= word.start
      || word.start < lower || word.end > upper
      || (index > 0 && word.start < clipWords[index - 1].end)) return null
  }
  const first = clipWords[0], last = clipWords[clipWords.length - 1]
  const padding = startIndex === endIndex ? 0.035 : 0.1
  let start = Math.max(lower, first.start - padding)
  let end = Math.min(upper, last.end + padding)
  const previous = entries[firstIndex - 1], next = entries[lastIndex + 1]
  if (previous) {
    if (Number.isFinite(previous.end)) {
      if (previous.end > first.start) return null
      start = Math.max(start, previous.end)
    } else start = first.start
  }
  if (next) {
    if (Number.isFinite(next.start)) {
      if (next.start < last.end) return null
      end = Math.min(end, next.start)
    } else end = last.end
  }
  return end > start ? { start, end } : null
}
