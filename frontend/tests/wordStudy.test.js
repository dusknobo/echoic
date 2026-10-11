import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeStudyWord, wordAudioRange } from '../src/lib/wordStudy.js'

const sentence = (tokens, durations = []) => ({
  start: 10, end: 15,
  words: tokens.map((word, i) => ({ word, start: durations[i]?.[0] ?? 10 + i, end: durations[i]?.[1] ?? 10.5 + i })),
})

test('lookup normalization keeps contractions and hyphens, removes surrounding punctuation', () => {
  assert.equal(normalizeStudyWord('“Don’t,”'), "don't")
  assert.equal(normalizeStudyWord('(Well‑known!)'), 'well-known')
  assert.equal(normalizeStudyWord('...'), '')
})

test('case and punctuation do not prevent an exact word clip', () => {
  const range = wordAudioRange([{ text: 'HELLO,' }, { text: 'world!' }], 1, sentence(['Hello', 'world.']))
  assert.equal(range.sourceIndex, 1)
  assert.equal(range.start, 10.965)
  assert.equal(range.end, 11.535)
})

test('scored word lists can skip punctuation and still retain sentence order', () => {
  const source = sentence(['Hello', ',', 'brave', 'world'])
  const range = wordAudioRange([{ text: 'hello' }, { text: 'world' }], 1, source)
  assert.equal(range.sourceIndex, 3)
})

test('repeated tokens map to their own occurrence when the sequence is complete', () => {
  const source = sentence(['go', 'go', 'home'])
  const words = [{ text: 'go' }, { text: 'go' }, { text: 'home' }]
  assert.equal(wordAudioRange(words, 0, source).sourceIndex, 0)
  assert.equal(wordAudioRange(words, 1, source).sourceIndex, 1)
})

test('ambiguous repeated tokens fall back instead of guessing a different occurrence', () => {
  assert.equal(wordAudioRange([{ text: 'go' }], 0, sentence(['go', 'go'])), null)
  assert.equal(wordAudioRange([{ text: 'a' }, { text: 'go' }, { text: 'b' }], 1, sentence(['a', 'go', 'go', 'b'])), null)
})

test('word clips reject missing, reversed and outside-sentence timestamps', () => {
  const source = sentence(['hello'])
  source.words[0].start = NaN
  assert.equal(wordAudioRange([{ text: 'hello' }], 0, source), null)
  source.words[0] = { word: 'hello', start: 11, end: 10 }
  assert.equal(wordAudioRange([{ text: 'hello' }], 0, source), null)
  source.words[0] = { word: 'hello', start: 9, end: 10.5 }
  assert.equal(wordAudioRange([{ text: 'hello' }], 0, source), null)
})

test('padding stays inside the sentence and adjacent word boundaries', () => {
  const source = sentence(['hello', 'world'], [[10, 10.5], [10.51, 15]])
  assert.deepEqual(wordAudioRange([{ text: 'hello' }, { text: 'world' }], 0, source), { start: 10, end: 10.51, sourceIndex: 0 })
  assert.deepEqual(wordAudioRange([{ text: 'hello' }, { text: 'world' }], 1, source), { start: 10.5, end: 15, sourceIndex: 1 })
})

test('reordered, invalid-index and unmatched words never choose arbitrary audio', () => {
  const source = sentence(['a', 'b'])
  assert.equal(wordAudioRange([{ text: 'b' }, { text: 'a' }], 0, source), null)
  assert.equal(wordAudioRange([{ text: 'a' }], 2, source), null)
  assert.equal(wordAudioRange([{ text: 'unmatched' }], 0, source), null)
})
