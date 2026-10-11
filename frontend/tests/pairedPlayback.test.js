import test from 'node:test'
import assert from 'node:assert/strict'
import { createPairedPlayback } from '../src/lib/pairedPlayback.js'

class Player {
  constructor(duration = 5) { this.duration = duration; this.time = 2; this.playing = false; this.plays = 0; this.pauses = 0; this.rate = 1; this.nextPlay = null }
  getDuration() { return this.duration }
  setPlaybackRate(rate) { this.rate = rate }
  seekTo(position) { this.time = position * this.duration }
  pause() { this.playing = false; this.pauses++ }
  play() {
    this.plays++
    this.playing = true
    return this.nextPlay ? this.nextPlay() : Promise.resolve()
  }
}

function setup(options = {}) {
  const original = new Player(3)
  const recording = new Player(6)
  const phases = []
  const errors = []
  const controller = createPairedPlayback({
    getPlayers: () => [original, recording],
    onPhaseChange: phase => phases.push(phase),
    onError: error => errors.push(error),
    ...options,
  })
  return { controller, original, recording, phases, errors }
}
const flush = async () => { await Promise.resolve(); await Promise.resolve() }
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('starts both from zero at the same rate, pauses both and resumes their positions', async () => {
  const { controller, original, recording } = setup()
  controller.setRate(0.75)
  controller.toggle()
  assert.equal(controller.getPhase(), 'playing')
  assert.equal(original.time, 0)
  assert.equal(recording.time, 0)
  assert.equal(original.rate, 0.75)
  assert.equal(recording.rate, 0.75)
  original.time = 1
  recording.time = 1
  controller.toggle()
  assert.equal(controller.getPhase(), 'paused')
  assert.equal(original.playing, false)
  assert.equal(recording.playing, false)
  controller.toggle()
  assert.equal(original.time, 1)
  assert.equal(recording.time, 1)
  assert.equal(original.plays, 2)
  assert.equal(recording.plays, 2)
  await flush()
})

test('consumes original finish, leaves long recording running, and never resumes the finished track', async () => {
  const { controller, original, recording } = setup()
  controller.toggle()
  original.playing = false
  assert.equal(controller.finish(original), true)
  assert.equal(controller.getPhase(), 'playing')
  assert.equal(recording.playing, true)
  controller.toggle()
  controller.toggle()
  assert.equal(original.plays, 1)
  assert.equal(recording.plays, 2)
  assert.equal(controller.finish(recording), true)
  assert.equal(controller.getPhase(), null)
  assert.equal(controller.finish(original), false)
  await flush()
})

test('supports the recording finishing first and clears only when both end', () => {
  const { controller, original, recording } = setup()
  controller.toggle()
  assert.equal(controller.finish(recording), true)
  assert.equal(controller.getPhase(), 'playing')
  assert.equal(original.playing, true)
  assert.equal(controller.finish(original), true)
  assert.equal(controller.getPhase(), null)
})

test('does not start before both waveforms have usable duration', () => {
  const { controller, original, recording } = setup()
  recording.duration = 0
  controller.toggle()
  assert.equal(controller.getPhase(), null)
  assert.equal(original.plays, 0)
  assert.equal(recording.plays, 0)
})

test('speed changes update both active players, including while paused', () => {
  const { controller, original, recording } = setup()
  controller.toggle()
  controller.toggle()
  controller.setRate(1.25)
  assert.equal(original.rate, 1.25)
  assert.equal(recording.rate, 1.25)
})

test('one rejected play stops both and safely consumes the error', async () => {
  const { controller, original, recording, errors } = setup()
  recording.nextPlay = () => Promise.reject(new Error('Autoplay blocked'))
  controller.toggle()
  await flush()
  assert.equal(controller.getPhase(), null)
  assert.equal(original.playing, false)
  assert.equal(recording.playing, false)
  assert.equal(errors.length, 1)
})

test('synchronous play failure does not start the other track', () => {
  const { controller, original, recording, errors } = setup()
  original.nextPlay = () => { throw new Error('Destroyed player') }
  controller.toggle()
  assert.equal(recording.plays, 0)
  assert.equal(controller.getPhase(), null)
  assert.equal(errors.length, 1)
})

test('late play resolution after stop cannot leave an isolated audio track', async () => {
  const { controller, original, recording } = setup()
  const late = deferred()
  original.nextPlay = () => late.promise.then(() => { original.playing = true })
  controller.toggle()
  controller.stop()
  late.resolve()
  await flush()
  await flush()
  assert.equal(original.playing, false)
  assert.equal(recording.playing, false)
  assert.equal(controller.getPhase(), null)
})

test('late failure from a cancelled run does not cancel a newly started pair', async () => {
  const { controller, original, recording, errors } = setup()
  const late = deferred()
  original.nextPlay = () => late.promise
  controller.toggle()
  controller.stop()
  original.nextPlay = null
  controller.toggle()
  late.reject(new Error('Old cancelled play'))
  await flush()
  assert.equal(controller.getPhase(), 'playing')
  assert.equal(original.playing, true)
  assert.equal(recording.playing, true)
  assert.equal(errors.length, 0)
})

test('late pair resolution respects a newly started standalone or A/B player', async () => {
  let externallyWanted = null
  const { controller, original, recording } = setup({
    shouldPauseStalePlayer: player => player !== externallyWanted,
  })
  const late = deferred()
  original.nextPlay = () => late.promise.then(() => { original.playing = true })
  controller.toggle()
  controller.stop()
  externallyWanted = original
  original.nextPlay = null
  original.play()
  late.resolve()
  await flush()
  await flush()
  assert.equal(original.playing, true)
  assert.equal(recording.playing, false)
})

test('late play resolution while paused remains paused', async () => {
  const { controller, original, recording } = setup()
  const late = deferred()
  recording.nextPlay = () => late.promise.then(() => { recording.playing = true })
  controller.toggle()
  controller.toggle()
  late.resolve()
  await flush()
  await flush()
  assert.equal(controller.getPhase(), 'paused')
  assert.equal(original.playing, false)
  assert.equal(recording.playing, false)
})
