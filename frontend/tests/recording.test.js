import test from 'node:test'
import assert from 'node:assert/strict'
import {
  supportedRecorderOptions, recordingFilename, recordingAvailabilityError,
  recordingErrorMessage, recordingInterruptionMessage, createRecordingSession,
} from '../src/lib/recording.js'

const flush = async () => { await Promise.resolve(); await Promise.resolve() }
function deferred() {
  let resolve
  const promise = new Promise(yes => { resolve = yes })
  return { promise, resolve }
}
class Target {
  constructor() { this.listeners = new Map() }
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set())
    this.listeners.get(name).add(handler)
  }
  removeEventListener(name, handler) { this.listeners.get(name)?.delete(handler) }
  emit(name) { for (const handler of [...this.listeners.get(name) || []]) handler() }
  listenerCount() { return [...this.listeners.values()].reduce((sum, set) => sum + set.size, 0) }
}
function setup({ mime = 'audio/webm;codecs=opus', acquire, constructorError, startError } = {}) {
  const track = Object.assign(new Target(), { stops: 0, stop() { this.stops++ } })
  const stream = { getTracks: () => [track] }
  const document = Object.assign(new Target(), { hidden: false })
  const recorders = []
  const constraints = []
  class Recorder {
    static isTypeSupported(type) { return type === mime }
    constructor(received, options) {
      if (constructorError) throw constructorError
      assert.equal(received, stream)
      this.mimeType = options?.mimeType || mime
      this.state = 'inactive'
      this.stops = 0
      recorders.push(this)
    }
    start(timeslice) {
      if (startError) throw startError
      this.timeslice = timeslice
      this.state = 'recording'
    }
    pause() { this.state = 'paused' }
    resume() { this.state = 'recording' }
    stop() {
      this.stops++
      this.state = 'inactive'
      queueMicrotask(() => {
        this.ondataavailable?.({ data: new Blob(['captured sound'], { type: this.mimeType }) })
        this.onstop?.()
      })
    }
  }
  const environment = {
    isSecureContext: true, MediaRecorder: Recorder, document,
    navigator: { mediaDevices: { getUserMedia: options => {
      constraints.push(options)
      return acquire ? acquire(stream) : Promise.resolve(stream)
    } } },
  }
  const completed = [], errors = [], interruptions = []
  let starts = 0, visualizationCleanups = 0
  const capture = createRecordingSession({
    environment, onStart: () => starts++,
    onComplete: blob => completed.push(blob),
    onError: error => errors.push(error),
    onInterrupt: reason => interruptions.push(reason),
    onStream: () => () => visualizationCleanups++,
  })
  return {
    capture, environment, stream, track, document, recorders, constraints, completed, errors, interruptions,
    starts: () => starts, visualizationCleanups: () => visualizationCleanups,
  }
}

test('selects supported WebM Opus first, MP4 fallback, or native browser defaults', () => {
  assert.deepEqual(supportedRecorderOptions({ isTypeSupported: () => true }), { mimeType: 'audio/webm;codecs=opus' })
  assert.deepEqual(supportedRecorderOptions({ isTypeSupported: type => type === 'audio/mp4' }), { mimeType: 'audio/mp4' })
  assert.deepEqual(supportedRecorderOptions({ isTypeSupported: type => type === 'audio/ogg;codecs=opus' }), { mimeType: 'audio/ogg;codecs=opus' })
  assert.equal(supportedRecorderOptions({ isTypeSupported: () => false }), undefined)
  assert.equal(supportedRecorderOptions({}), undefined)
})

test('filenames follow actual container MIME without disguising unknown bytes', () => {
  for (const [mime, expected] of [
    ['audio/webm;codecs=opus', 'webm'], ['audio/mp4', 'm4a'], ['video/mp4', 'mp4'],
    ['audio/ogg;codecs=opus', 'ogg'], ['audio/wav', 'wav'], ['audio/mpeg', 'mp3'], ['', 'bin'],
  ]) assert.equal(recordingFilename({ type: mime }, 'oral_recording'), 'oral_recording.' + expected)
})

test('insecure origins receive actionable HTTPS guidance before requesting permission', async () => {
  const s = setup()
  s.environment.isSecureContext = false
  await s.capture.start()
  assert.equal(s.constraints.length, 0)
  assert.equal(s.errors[0].code, 'insecure-context')
  assert.match(recordingErrorMessage(s.errors[0]), /HTTPS/)
  assert.equal(recordingAvailabilityError({ isSecureContext: true }).code, 'microphone-unavailable')
  assert.equal(recordingAvailabilityError({ navigator: { mediaDevices: { getUserMedia() {} } } }).code, 'recorder-unavailable')
})

test('permission, missing device and busy-device errors have distinct retry guidance', () => {
  assert.match(recordingErrorMessage({ name: 'NotAllowedError' }), /权限/)
  assert.match(recordingErrorMessage({ name: 'NotFoundError' }), /没有找到/)
  assert.match(recordingErrorMessage({ name: 'NotReadableError' }), /通话|占用/)
  const translated = recordingErrorMessage({ name: 'NotReadableError' }, key => 'translated:' + key)
  assert.equal(translated, 'translated:recording.microphoneBusy')
})

test('duplicate start while requesting permission acquires one unconstrained microphone', async () => {
  const request = deferred()
  const s = setup({ acquire: () => request.promise })
  const first = s.capture.start()
  await s.capture.start()
  assert.equal(s.constraints.length, 1)
  assert.deepEqual(s.constraints[0], { audio: true })
  request.resolve(s.stream)
  await first
  assert.equal(s.starts(), 1)
  assert.equal(s.recorders[0].timeslice, 1000)
  s.capture.cancel()
  await flush()
})

test('cancelling during permission wait stops the late stream without callbacks or recorder', async () => {
  const request = deferred()
  const s = setup({ acquire: () => request.promise })
  const first = s.capture.start()
  s.capture.cancel()
  request.resolve(s.stream)
  await first
  assert.equal(s.track.stops, 1)
  assert.equal(s.starts(), 0)
  assert.equal(s.recorders.length, 0)
  assert.deepEqual(s.completed, [])
  assert.deepEqual(s.errors, [])
})

test('constructor and start failures release acquired tracks and visualization', async () => {
  for (const failure of ['constructorError', 'startError']) {
    const s = setup({ [failure]: new Error('device failure') })
    await s.capture.start()
    assert.equal(s.track.stops, 1)
    assert.equal(s.errors.length, 1)
    assert.equal(s.document.listenerCount(), 0)
    assert.equal(s.track.listenerCount(), 0)
    assert.equal(s.visualizationCleanups(), failure === 'startError' ? 1 : 0)
  }
})

test('finish preserves MP4 chunks, supports pause/resume, and releases all capture resources', async () => {
  const s = setup({ mime: 'audio/mp4' })
  await s.capture.start()
  assert.equal(s.capture.pause(), true)
  assert.equal(s.capture.pause(), false)
  assert.equal(s.capture.resume(), true)
  assert.equal(s.capture.stop(), true)
  assert.equal(s.capture.stop(), false)
  await flush()
  assert.equal(s.completed.length, 1)
  assert.equal(s.completed[0].type, 'audio/mp4')
  assert.equal(await s.completed[0].text(), 'captured sound')
  assert.equal(recordingFilename(s.completed[0]), 'recording.m4a')
  assert.equal(s.track.stops, 1)
  assert.equal(s.visualizationCleanups(), 1)
  assert.equal(s.document.listenerCount(), 0)
  assert.equal(s.track.listenerCount(), 0)
})

test('MP4 codec MIME and fragmented byte order survive empty and final data events', async () => {
  const s = setup({ mime: 'audio/mp4' })
  await s.capture.start()
  const recorder = s.recorders[0]
  const mime = 'audio/mp4;codecs=mp4a.40.2'
  // Container initialization + media fragments; empty events must not pick a MIME.
  recorder.ondataavailable({ data: new Blob([], { type: 'audio/webm' }) })
  recorder.ondataavailable({ data: new Blob([new Uint8Array([0, 1, 2])], { type: mime }) })
  recorder.ondataavailable({ data: new Blob([new Uint8Array([3, 4])]) })
  recorder.onstop()
  recorder.onstop()
  assert.equal(s.completed.length, 1)
  assert.equal(s.completed[0].type, mime)
  assert.deepEqual([...new Uint8Array(await s.completed[0].arrayBuffer())], [0, 1, 2, 3, 4])
  assert.equal(recordingFilename(s.completed[0]), 'recording.m4a')
})

test('untyped MP4 chunks use the native recorder MIME including codec parameters', async () => {
  const s = setup({ mime: 'audio/mp4' })
  await s.capture.start()
  const recorder = s.recorders[0]
  recorder.mimeType = 'audio/mp4;codecs=mp4a.40.2'
  recorder.ondataavailable({ data: new Blob(['untyped container bytes']) })
  recorder.onstop()
  assert.equal(s.completed[0].type, recorder.mimeType)
  assert.equal(recordingFilename(s.completed[0], 'oral_recording'), 'oral_recording.m4a')
})

test('backgrounding or losing microphone finishes partial audio and reports the reason once', async () => {
  for (const reason of ['background', 'device-ended']) {
    const s = setup()
    await s.capture.start()
    if (reason === 'background') {
      s.document.hidden = true
      s.document.emit('visibilitychange')
      s.document.emit('visibilitychange')
    } else { s.track.emit('ended'); s.track.emit('ended') }
    await flush()
    assert.deepEqual(s.interruptions, [reason])
    assert.equal(s.recorders[0].stops, 1)
    assert.equal(s.completed.length, 1)
    assert.match(recordingInterruptionMessage(reason), /保留/)
  }
})

test('recorder errors retain final chunks rather than manufacturing a score', async () => {
  const s = setup()
  await s.capture.start()
  s.recorders[0].onerror({ error: new Error('interrupted') })
  await flush()
  assert.deepEqual(s.interruptions, ['recorder-error'])
  assert.equal(s.completed.length, 1)
  assert.equal(s.errors.length, 0)
})

test('browser error with inactive recorder waits for queued final data and stop', async () => {
  const s = setup()
  await s.capture.start()
  const recorder = s.recorders[0]
  recorder.state = 'inactive'
  recorder.onerror({})
  assert.equal(s.completed.length, 0)
  recorder.ondataavailable({ data: new Blob(['last chunk'], { type: 'audio/ogg' }) })
  recorder.onstop()
  assert.equal(await s.completed[0].text(), 'last chunk')
  assert.equal(s.completed[0].type, 'audio/ogg')
})

test('explicit cancel discards final asynchronous chunks and cleans up immediately', async () => {
  const s = setup()
  await s.capture.start()
  s.capture.cancel()
  assert.equal(s.track.stops, 1)
  await flush()
  assert.equal(s.completed.length, 0)
  assert.equal(s.errors.length, 0)
  assert.equal(s.document.listenerCount(), 0)
})

test('a recording without bytes reports an error instead of a usable recording', async () => {
  const s = setup()
  await s.capture.start()
  s.recorders[0].onstop()
  assert.equal(s.completed.length, 0)
  assert.equal(s.errors[0].code, 'empty-recording')
})

test('real DOMException numeric legacy codes do not hide actionable microphone names', () => {
  for (const [name, expectedKey, guidance] of [
    ['NotFoundError', 'recording.noMicrophone', /没有找到/],
    ['SecurityError', 'recording.microphoneBlocked', /禁止|HTTPS/],
    ['NotAllowedError', 'recording.permissionDenied', /权限/],
  ]) {
    const error = new DOMException('capture blocked', name)
    assert.equal(typeof error.code, 'number')
    assert.equal(recordingErrorMessage(error, key => key), expectedKey)
    assert.match(recordingErrorMessage(error), guidance)
  }
  assert.equal(recordingErrorMessage({ code: 'insecure-context', name: 'Error' }, key => key), 'recording.httpsRequired')
})
