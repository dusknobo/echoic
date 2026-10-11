import test from 'node:test'
import assert from 'node:assert/strict'
import { getSegmentBlob } from '../src/lib/audioSegment.js'

const buffer = { numberOfChannels: 1, sampleRate: 10, length: 20, getChannelData: () => new Float32Array(20).fill(0.1) }
function installAudio(t, fetcher) {
  const originalFetch = globalThis.fetch
  const originalContext = globalThis.AudioContext
  globalThis.fetch = fetcher
  globalThis.AudioContext = class {
    async decodeAudioData() { return buffer }
    async close() {}
  }
  t.after(() => { globalThis.fetch = originalFetch; globalThis.AudioContext = originalContext })
}
function response() { return { ok: true, arrayBuffer: async () => new ArrayBuffer(4) } }

test('concurrent sentence and word clips share one audio download and decode', async t => {
  let calls = 0
  installAudio(t, async () => { calls++; return response() })
  const cache = { current: null }
  const [sentence, word] = await Promise.all([getSegmentBlob('/a', 0, 2, cache), getSegmentBlob('/a', 0.5, 1, cache)])
  assert.equal(calls, 1)
  assert.equal(sentence.size, 84)
  assert.equal(word.size, 54)
})

test('a late previous audio download cannot replace the cache for a new route', async t => {
  let resolvePrevious
  const calls = []
  installAudio(t, url => {
    calls.push(url)
    return url === '/a' ? new Promise(resolve => { resolvePrevious = resolve }) : Promise.resolve(response())
  })
  const cache = { current: null }
  const previous = getSegmentBlob('/a', 0, 1, cache)
  await getSegmentBlob('/b', 0, 1, cache)
  resolvePrevious(response())
  await previous
  await getSegmentBlob('/b', 0.5, 1, cache)
  assert.deepEqual(calls, ['/a', '/b'])
  assert.equal(cache.current.url, '/b')
})

test('a failed audio fetch can be retried and invalid clip ranges are rejected', async t => {
  let attempts = 0
  installAudio(t, async () => ++attempts === 1 ? { ok: false } : response())
  const cache = { current: null }
  await assert.rejects(getSegmentBlob('/a', 0, 1, cache), /unavailable/)
  assert.equal(cache.current, null)
  await getSegmentBlob('/a', 0, 1, cache)
  assert.equal(attempts, 2)
  await assert.rejects(getSegmentBlob('/a', 2, 1, cache), /Invalid/)
  await assert.rejects(getSegmentBlob('/a', 3, 4, cache), /Empty/)
})
