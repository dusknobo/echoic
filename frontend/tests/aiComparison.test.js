import test from 'node:test'
import assert from 'node:assert/strict'
import { comparisonAudioRange, comparisonTargets, referenceTokens } from '../src/lib/aiComparison.js'

const sentence = (text, tokens = referenceTokens(text), offset = 10) => ({
  text, start: offset, end: offset + tokens.length,
  words: tokens.map((word, index) => ({ word, start: offset + index, end: offset + index + 0.5 })),
})
const target = (text, source, occurrence = 0) => comparisonTargets(text, source)[occurrence]
const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-9, actual + ' != ' + expected)

test('reference tokens normalize Unicode punctuation, preserve contractions, hyphens and digits', () => {
  assert.deepEqual(referenceTokens('“Don’t,” well‑known; Iʼm Ａ2!'), ["don't", 'well-known', "i'm", 'a2'])
  assert.deepEqual(referenceTokens(null), [])
})

test('repeated words list every explicit occurrence with unique keys and contextual labels', () => {
  const matches = comparisonTargets('GO!', { text: 'Go, go home and go now.' })
  assert.deepEqual(matches.map(({ startIndex, endIndex }) => [startIndex, endIndex]), [[0, 0], [1, 1], [4, 4]])
  assert.equal(new Set(matches.map(item => item.key)).size, 3)
  assert(matches.every((item, index) => item.label.includes('第' + (index + 1) + '处')))
  assert(matches[0].label.includes('【Go】 go home'))
  assert(matches[2].label.includes('【go】 now'))
})

test('phrases match contiguous reference tokens including overlapping repeated phrases', () => {
  const matches = comparisonTargets('go go', 'Go go go home.')
  assert.deepEqual(matches.map(item => [item.startIndex, item.endIndex]), [[0, 1], [1, 2]])
  assert.deepEqual(comparisonTargets('go home', 'go quickly home'), [])
  assert.deepEqual(comparisonTargets('absent', 'go home'), [])
  assert.deepEqual(comparisonTargets('...', 'go home'), [])
})

test('case, punctuation and contractions retain the exact word index', () => {
  const source = sentence('I don’t know a well-known A2 teacher.')
  assert.equal(target("DON'T,", source).startIndex, 1)
  assert.equal(target('well‑known', source).startIndex, 4)
  assert.equal(target('A2 teacher!', source).endIndex, 6)
})

test('original audio uses absolute sentence offsets and small word padding', () => {
  const source = sentence('hello brave world')
  const range = comparisonAudioRange(target('brave', source), source, source.words)
  close(range.start, 10.965)
  close(range.end, 11.535)
})

test('recording audio uses relative timestamps and explicit duration bounds', () => {
  const source = sentence('hello brave world')
  const words = source.words.map(word => ({ ...word, start: word.start - 10, end: word.end - 10 }))
  const range = comparisonAudioRange(target('brave', source), source, words, { start: 0, end: 3 })
  close(range.start, 0.965)
  close(range.end, 1.535)
  assert.deepEqual(comparisonAudioRange(target('brave', source), source, words, { duration: 3 }), range)
  assert.equal(comparisonAudioRange(target('brave', source), source, words), null)
})

test('a complete repeated-word sequence maps the selected occurrence rather than the first word', () => {
  const source = sentence('go go home')
  const first = comparisonAudioRange(target('go', source, 0), source, source.words)
  const second = comparisonAudioRange(target('go', source, 1), source, source.words)
  assert.equal(first.start, 10)
  close(second.start, 10.965)
  close(second.end, 11.535)
})

test('missing reference words and reduced repeated-word mappings are rejected', () => {
  const source = sentence('go go home')
  const reduced = source.words.filter((_, index) => index !== 1)
  assert.equal(comparisonAudioRange(target('go', source, 0), source, reduced), null)
  assert.equal(comparisonAudioRange(target('go', source, 1), source, reduced), null)
  assert.equal(comparisonAudioRange(target('home', source), source, reduced), null)
})

test('extra repeated timed tokens make the full mapping ambiguous', () => {
  const source = sentence('a go home', ['a', 'go', 'go', 'home'])
  assert.equal(comparisonAudioRange(target('go', source), source, source.words), null)
  assert.equal(comparisonAudioRange(target('home', source), source, source.words), null)
})

test('a phrase cannot span inserted spoken words, while punctuation-only entries are harmless', () => {
  const source = sentence('go home', ['go', 'quickly', 'home'])
  assert.equal(comparisonAudioRange(target('go home', source), source, source.words), null)
  const punctuated = sentence('go home', ['go,', ',', 'home.'])
  const range = comparisonAudioRange(target('go home', punctuated), punctuated, punctuated.words)
  assert.equal(range.start, 10)
  close(range.end, 12.6)
})

test('phrases use wider padding but remain inside neighboring words and audio bounds', () => {
  const source = sentence('one two three four')
  source.words[0].end = 10.99
  source.words[3].start = 12.53
  const range = comparisonAudioRange(target('two three', source), source, source.words)
  assert.deepEqual(range, { start: 10.99, end: 12.53 })
  const all = comparisonAudioRange(target('one two three four', source), source, source.words, { start: 10, end: 13.5 })
  assert.deepEqual(all, { start: 10, end: 13.5 })
})

test('missing, non-numeric, reversed, zero-length and out-of-bounds target times never become estimates', () => {
  const source = sentence('hello world')
  for (const invalid of [
    { start: undefined, end: 10.5 }, { start: '10', end: 10.5 }, { start: NaN, end: 10.5 },
    { start: 10.5, end: 10 }, { start: 10, end: 10 }, { start: 9.9, end: 10.5 }, { start: 10, end: 12.1 },
  ]) {
    const words = [{ ...source.words[0], ...invalid }, source.words[1]]
    assert.equal(comparisonAudioRange(target('hello', source), source, words), null)
  }
  assert.equal(comparisonAudioRange(target('hello', source), source, [], { duration: 20 }), null)
})

test('out-of-order and overlapping target timings are rejected', () => {
  const source = sentence('hello world')
  const words = [{ word: 'hello', start: 11, end: 11.5 }, { word: 'world', start: 10, end: 10.5 }]
  assert.equal(comparisonAudioRange(target('hello world', source), source, words), null)
  const overlap = [{ ...source.words[0], end: 11.2 }, source.words[1]]
  assert.equal(comparisonAudioRange(target('hello world', source), source, overlap), null)
  assert.equal(comparisonAudioRange(target('world', source), source, overlap), null)
})

test('invalid bounds, stale targets, merged word timings and unknown word entries are rejected', () => {
  const source = sentence('hello world')
  const selected = target('hello', source)
  for (const bounds of [{ start: -1, end: 12 }, { start: 10, end: 10 }, { start: 10, end: Infinity }]) {
    assert.equal(comparisonAudioRange(selected, source, source.words, bounds), null)
  }
  assert.equal(comparisonAudioRange({ ...selected, text: 'world' }, source, source.words), null)
  assert.equal(comparisonAudioRange({ ...selected, endIndex: 2 }, source, source.words), null)
  assert.equal(comparisonAudioRange({ ...selected, startIndex: 0.5 }, source, source.words), null)
  assert.equal(comparisonAudioRange(selected, source, [{ word: 'hello world', start: 10, end: 12 }]), null)
  assert.equal(comparisonAudioRange(selected, source, [{ start: 10, end: 10.5 }, source.words[1]]), null)
})
