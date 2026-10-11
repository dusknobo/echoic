import test from 'node:test'
import assert from 'node:assert/strict'
import { bindListeningShortcuts, readMarkerTime, sentenceAtTime, wordAtTime, formatListeningTime, reconcileMarkers } from '../src/lib/listening.js'

class EventSurface {
  listeners = new Map()
  addEventListener(type, fn, capture) { this.listeners.set(type, { fn, capture }) }
  removeEventListener(type, fn) { if (this.listeners.get(type)?.fn === fn) this.listeners.delete(type) }
  send(type, overrides = {}) {
    const event = {
      code: 'Space', target: { closest: () => null }, repeat: false,
      prevented: false, stopped: false,
      preventDefault() { this.prevented = true },
      stopPropagation() { this.stopped = true },
      ...overrides,
    }
    this.listeners.get(type)?.fn(event)
    return event
  }
}

function setup() {
  const surface = new EventSurface()
  const calls = { mark: 0, toggle: 0 }
  const unbind = bindListeningShortcuts(surface, {
    mark() { calls.mark++ }, togglePlayback() { calls.toggle++ },
  })
  return { surface, calls, unbind }
}

test('Space, M and semicolon mark once each without toggling playback', () => {
  const { surface, calls } = setup()
  for (const code of ['Space', 'KeyM', 'Semicolon']) {
    const event = surface.send('keydown', { code })
    assert.equal(event.prevented, true)
    assert.equal(event.stopped, true)
    surface.send('keyup', { code })
  }
  assert.deepEqual(calls, { mark: 3, toggle: 0 })
})

test('holding a key cannot create repeated markers; next press can', () => {
  const { surface, calls } = setup()
  surface.send('keydown')
  surface.send('keydown', { repeat: true })
  surface.send('keydown')
  assert.equal(calls.mark, 1)
  surface.send('keyup')
  surface.send('keydown')
  assert.equal(calls.mark, 2)
})

test('P alone toggles playback and ignores auto repeat', () => {
  const { surface, calls } = setup()
  surface.send('keydown', { code: 'KeyP' })
  surface.send('keydown', { code: 'KeyP', repeat: true })
  assert.deepEqual(calls, { mark: 0, toggle: 1 })
})

test('typing, contenteditable, IME and modifier keys retain their normal behavior', () => {
  const { surface, calls } = setup()
  const cases = [
    { target: { closest: () => ({ tagName: 'INPUT' }) } },
    { target: { isContentEditable: true } },
    { isComposing: true }, { keyCode: 229 },
    { ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true },
  ]
  for (const overrides of cases) {
    const event = surface.send('keydown', overrides)
    assert.equal(event.prevented, false)
  }
  assert.deepEqual(calls, { mark: 0, toggle: 0 })
})

test('Space keydown and keyup are captured to prevent focused button activation', () => {
  const { surface, calls } = setup()
  const button = { tagName: 'BUTTON', closest: () => null }
  assert.equal(surface.listeners.get('keydown').capture, true)
  assert.equal(surface.listeners.get('keyup').capture, true)
  surface.send('keydown', { target: button })
  const up = surface.send('keyup', { target: button })
  assert.equal(up.prevented, true)
  assert.equal(up.stopped, true)
  assert.deepEqual(calls, { mark: 1, toggle: 0 })
})

test('blur releases held keys and unmount removes all listeners', () => {
  const { surface, calls, unbind } = setup()
  surface.send('keydown')
  surface.send('blur')
  surface.send('keydown')
  assert.equal(calls.mark, 2)
  unbind()
  assert.equal(surface.listeners.size, 0)
})

test('timestamp capture reads the player without seeking, loading, playing or pausing', () => {
  let timestamp = 12.34567
  const player = new Proxy({}, {
    get(_, property) {
      if (property === 'readyState') return 4
      if (property === 'currentTime') return timestamp
      throw new Error(`Unexpected media access: ${String(property)}`)
    },
    set() { throw new Error('Capturing a marker must never mutate the media player') },
  })
  assert.equal(readMarkerTime(player), 12.346)
  timestamp = 13.2
  assert.equal(readMarkerTime(player), 13.2)
  assert.equal(readMarkerTime(null), null)
  assert.equal(readMarkerTime({ readyState: 0, currentTime: 0 }), null)
})

test('marker time opens its sentence, using the preceding sentence in a gap', () => {
  const sentences = [{ index: 0, start: 1, end: 3 }, { index: 1, start: 4, end: 6 }]
  assert.equal(sentenceAtTime(sentences, 4.5).index, 1)
  assert.equal(sentenceAtTime(sentences, 3.5).index, 0)
  assert.equal(sentenceAtTime(sentences, 0).index, 0)
  assert.equal(sentenceAtTime([], 3), null)
  assert.equal(formatListeningTime(59.99), '1:00.0')
  assert.equal(formatListeningTime(61.23), '1:01.2')
})

test('refresh reconciles a committed POST with its pending UUID after the response was lost', () => {
  const pending = [
    { localId: 'committed-uuid', time: 12.34, note: '', status: 'error' },
    { localId: 'still-offline-uuid', time: 12.34, note: 'keep this', status: 'error' },
  ]
  const remote = [{ id: 42, client_id: 'committed-uuid', time: 12.34, note: '' }]
  const result = reconcileMarkers(pending, remote)
  assert.equal(result.length, 2)
  assert.equal(result.filter(marker => marker.id === 42).length, 1)
  assert.equal(result[0].localId, 'committed-uuid')
  assert.equal(result[0].status, 'saved')
  const remainingQueue = result.filter(marker => marker.status !== 'saved')
  assert.deepEqual(remainingQueue, [pending[1]])
  assert.deepEqual(reconcileMarkers(result, remote), result)
})

test('loading a marker list preserves a concurrent successful POST missing from the older GET response', () => {
  const previous = [{ id: 43, localId: 'posted-during-get', client_id: 'posted-during-get', time: 15, status: 'saved' }]
  const remote = [{ id: 42, client_id: null, time: 12.34, note: '' }]
  const result = reconcileMarkers(previous, remote)
  assert.deepEqual(result.map(marker => marker.id), [43, 42])
  assert.equal(result.every(marker => marker.status === 'saved'), true)
})


test('word lookup returns the exact word, original sentence and original word index', () => {
  const sentence = { index: 2, words: [
    { word: 'Hello', start: 1, end: 1.4 },
    { word: 'world.', start: 1.5, end: 2 },
  ] }
  assert.deepEqual(wordAtTime([sentence], 1.8), {
    word: 'world.', start: 1.5, end: 2, wordIndex: 1, sentence, match: 'exact',
  })
  assert.equal(wordAtTime([sentence], 1.8).sentence, sentence)
})

test('shared word boundaries belong to the following word', () => {
  const sentence = { words: [
    { word: 'one', start: 1, end: 2 },
    { word: 'two', start: 2, end: 3 },
  ] }
  assert.equal(wordAtTime([sentence], 1).word, 'one')
  assert.equal(wordAtTime([sentence], 2).word, 'two')
  assert.equal(wordAtTime([sentence], 2).match, 'exact')
  assert.equal(wordAtTime([sentence], 3).match, 'nearby')
})

test('a nearby boundary within 0.75 seconds is available, but long silence has no word', () => {
  const sentence = { words: [
    { word: 'before', start: 2, end: 3 },
    { word: 'after', start: 6, end: 7 },
  ] }
  assert.equal(wordAtTime([sentence], 1.25).word, 'before')
  assert.equal(wordAtTime([sentence], 1.25).match, 'nearby')
  assert.equal(wordAtTime([sentence], 3.75).word, 'before')
  assert.equal(wordAtTime([sentence], 1.249), null)
  assert.equal(wordAtTime([sentence], 3.751), null)
  assert.equal(wordAtTime([sentence], 4.5), null)
  assert.equal(wordAtTime([sentence], 5.4).word, 'after')
  assert.equal(wordAtTime([sentence], 7.751), null)
})

test('equally near words choose the preceding word even when input is unsorted', () => {
  const sentences = [
    { words: [{ word: 'next', start: 3, end: 4 }] },
    { words: [{ word: 'previous', start: 1, end: 2 }] },
  ]
  assert.equal(wordAtTime(sentences, 2.5).word, 'previous')
  assert.equal(wordAtTime(sentences, 2.5).match, 'nearby')
})

test('an exact hit wins over a nearby word encountered earlier', () => {
  const sentences = [{ words: [
    { word: 'earlier', start: 0, end: 1 },
    { word: 'exact', start: 1.2, end: 2 },
  ] }]
  assert.equal(wordAtTime(sentences, 1.3).word, 'exact')
  assert.equal(wordAtTime(sentences, 1.3).match, 'exact')
})

test('repeated words remain separate by their timestamps', () => {
  const sentence = { words: [
    { word: 'very', start: 1, end: 1.4 },
    { word: 'very', start: 1.5, end: 1.9 },
  ] }
  assert.equal(wordAtTime([sentence], 1.2).wordIndex, 0)
  assert.equal(wordAtTime([sentence], 1.7).wordIndex, 1)
  assert.equal(wordAtTime([sentence], 1.7).start, 1.5)
})

test('missing ASR words and invalid marker times have no word match', () => {
  for (const sentences of [null, undefined, [], [{ text: 'No alignment yet' }], [null], [{ words: [] }]]) {
    assert.equal(wordAtTime(sentences, 1), null)
  }
  const sentences = [{ words: [{ word: 'valid', start: 0, end: 1 }] }]
  for (const time of [NaN, Infinity, -Infinity, -0.1, undefined, null, '0.5']) {
    assert.equal(wordAtTime(sentences, time), null)
  }
})

test('invalid and zero-length words are skipped without changing valid word indices', () => {
  const sentence = { words: [
    null,
    { word: '', start: 0, end: 1 },
    { word: '  ', start: 0, end: 1 },
    { word: 123, start: 0, end: 1 },
    { word: 'negative', start: -1, end: 1 },
    { word: 'zero', start: 0, end: 0 },
    { word: 'backwards', start: 1, end: 0 },
    { word: 'infinite', start: 0, end: Infinity },
    { word: 'nan', start: NaN, end: 1 },
    { word: 'string time', start: '0', end: 1 },
    { word: 'valid', start: 2, end: 3 },
  ] }
  assert.equal(wordAtTime([sentence], 0.5), null)
  assert.equal(wordAtTime([sentence], 2.5).wordIndex, 10)
  assert.equal(wordAtTime([sentence], 2.5).word, 'valid')
})

test('word time labels preserve short word boundaries and carry rounded minutes', () => {
  assert.equal(formatListeningTime(3.02, 2), '0:03.02')
  assert.equal(formatListeningTime(3.04, 2), '0:03.04')
  assert.equal(formatListeningTime(59.999, 2), '1:00.00')
  assert.equal(formatListeningTime(3.04), '0:03.0')
})
