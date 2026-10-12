// Preserve the real browser recording format through playback and upload.
const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus']

export function supportedRecorderOptions(Recorder = globalThis.MediaRecorder) {
  if (typeof Recorder?.isTypeSupported !== 'function') return undefined
  const mimeType = MIME_CANDIDATES.find(type => Recorder.isTypeSupported(type))
  return mimeType ? { mimeType } : undefined
}

export function recordingFilename(blob, basename = 'recording') {
  const mime = (blob?.type || '').split(';')[0].trim().toLowerCase()
  const extension = {
    'audio/webm': 'webm', 'video/webm': 'webm',
    'audio/mp4': 'm4a', 'video/mp4': 'mp4', 'audio/x-m4a': 'm4a',
    'audio/ogg': 'ogg', 'application/ogg': 'ogg',
    'audio/wav': 'wav', 'audio/wave': 'wav', 'audio/x-wav': 'wav',
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/aac': 'aac',
  }[mime] || 'bin'
  return `${basename}.${extension}`
}

function recordingError(code) { return Object.assign(new Error(code), { code }) }

export function recordingAvailabilityError(environment = globalThis) {
  if (environment.isSecureContext === false) return recordingError('insecure-context')
  if (!environment.navigator?.mediaDevices?.getUserMedia) return recordingError('microphone-unavailable')
  if (typeof environment.MediaRecorder !== 'function') return recordingError('recorder-unavailable')
  return null
}

export function recordingErrorMessage(error, t = (_key, options) => options.defaultValue) {
  const kind = typeof error?.code === 'string' && error.code ? error.code : error?.name
  const messages = {
    'insecure-context': ['recording.httpsRequired', '手机录音需要 HTTPS。请使用安全网址打开；局域网 HTTP 地址无法申请麦克风权限。'],
    'microphone-unavailable': ['recording.microphoneUnavailable', '当前浏览器无法访问麦克风，请使用最新版 Chrome、Edge 或 Safari 打开安全网址。'],
    'recorder-unavailable': ['recording.recorderUnavailable', '当前浏览器不支持录音，请使用最新版 Chrome、Edge 或 Safari。'],
    NotAllowedError: ['recording.permissionDenied', '麦克风权限被拒绝，请在浏览器的网站设置和手机系统设置中允许麦克风后重试。'],
    PermissionDeniedError: ['recording.permissionDenied', '麦克风权限被拒绝，请在浏览器的网站设置和手机系统设置中允许麦克风后重试。'],
    NotFoundError: ['recording.noMicrophone', '没有找到可用麦克风，请检查设备连接和系统麦克风设置。'],
    DevicesNotFoundError: ['recording.noMicrophone', '没有找到可用麦克风，请检查设备连接和系统麦克风设置。'],
    NotReadableError: ['recording.microphoneBusy', '无法读取麦克风，可能正被通话或其他应用占用。请关闭占用后重试。'],
    TrackStartError: ['recording.microphoneBusy', '无法读取麦克风，可能正被通话或其他应用占用。请关闭占用后重试。'],
    SecurityError: ['recording.microphoneBlocked', '浏览器或系统禁止访问麦克风，请检查权限并使用 HTTPS 网址。'],
    'empty-recording': ['recording.empty', '没有录到音频，请确认麦克风可用后重新录音。'],
  }
  const [key, defaultValue] = messages[kind] || ['recording.failed', '录音失败，请检查麦克风权限和设备后重试。']
  return t(key, { defaultValue })
}

export function recordingInterruptionMessage(reason, t = (_key, options) => options.defaultValue) {
  const messages = {
    background: ['recording.backgroundInterrupted', '页面进入后台，录音已结束。已录到的部分会保留，请回放检查后再提交。'],
    'device-ended': ['recording.deviceInterrupted', '麦克风连接已中断，录音已结束。已录到的部分会保留，请回放检查后再提交。'],
    'recorder-error': ['recording.captureInterrupted', '录音被浏览器或系统中断。已录到的部分会保留，请回放检查后再提交。'],
  }
  const [key, defaultValue] = messages[reason] || messages['recorder-error']
  return t(key, { defaultValue })
}

function stopTracks(stream) {
  stream?.getTracks().forEach(track => { try { track.stop() } catch { /* Already detached. */ } })
}

/** One capture owns its permission request, tracks, callbacks and cleanup. */
export function createRecordingSession({
  onStart = () => {}, onComplete = () => {}, onError = () => {},
  onInterrupt = () => {}, onStream = () => {}, environment = globalThis,
} = {}) {
  let cancelled = false
  let settled = false
  let requested = false
  let started = false
  let finishing = false
  let interrupted = false
  let stream = null
  let recorder = null
  let releaseVisualization = null
  const chunks = []
  const removers = []

  function detach() { removers.splice(0).forEach(remove => remove()) }
  function cleanup() {
    detach()
    try { releaseVisualization?.() } catch { /* Drawing is optional. */ }
    releaseVisualization = null
    stopTracks(stream)
    stream = null
  }
  function complete() {
    if (settled) return
    settled = true
    const type = chunks.find(chunk => chunk.type)?.type || recorder?.mimeType || ''
    const blob = new Blob(chunks, { type })
    cleanup()
    if (cancelled) return
    if (!blob.size) onError(recordingError('empty-recording'))
    else onComplete(blob)
  }
  function stop(reason) {
    if (cancelled || settled || finishing || !started) return false
    finishing = true
    detach()
    if (reason && !interrupted) { interrupted = true; onInterrupt(reason) }
    try {
      if (recorder.state !== 'inactive') recorder.stop()
      cleanup()
      // Errors can queue dataavailable then stop; wait for the final chunk.
    } catch { complete() }
    return true
  }
  function listen(target, name, handler) {
    target?.addEventListener?.(name, handler)
    removers.push(() => target?.removeEventListener?.(name, handler))
  }
  async function start() {
    if (requested || cancelled || settled) return
    requested = true
    try {
      const unavailable = recordingAvailabilityError(environment)
      if (unavailable) throw unavailable
      const acquired = await environment.navigator.mediaDevices.getUserMedia({ audio: true })
      if (cancelled) { stopTracks(acquired); return }
      stream = acquired
      recorder = new environment.MediaRecorder(stream, supportedRecorderOptions(environment.MediaRecorder))
      recorder.ondataavailable = event => { if (!settled && event.data?.size) chunks.push(event.data) }
      recorder.onstop = complete
      recorder.onerror = () => stop('recorder-error')
      listen(environment.document, 'visibilitychange', () => {
        if (environment.document.hidden) stop('background')
      })
      stream.getTracks().forEach(track => listen(track, 'ended', () => stop('device-ended')))
      // Web Audio visualization is optional; recording must work without it.
      try { releaseVisualization = onStream(stream) } catch { releaseVisualization = null }
      recorder.start(1000)
      started = true
      onStart()
      if (environment.document?.hidden) stop('background')
    } catch (error) {
      settled = true
      cleanup()
      if (!cancelled) onError(error)
    }
  }
  function cancel() {
    if (cancelled) return
    cancelled = true
    detach()
    try { if (recorder && recorder.state !== 'inactive') recorder.stop() } catch { /* Discard. */ }
    cleanup()
  }
  function changeState(action, expected) {
    if (cancelled || settled || finishing || !started || recorder?.state !== expected) return false
    try { recorder[action](); return true } catch { stop('recorder-error'); return false }
  }
  return {
    start, stop, cancel,
    pause: () => changeState('pause', 'recording'),
    resume: () => changeState('resume', 'paused'),
  }
}
