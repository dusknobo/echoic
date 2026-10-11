import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import WaveSurfer from 'wavesurfer.js'
import { practiceApi } from '@/api'
import { createPairedPlayback } from '@/lib/pairedPlayback'

/** Recording, A/B comparison, simultaneous playback, history and scoring. */
export function usePracticeRecorder({ audioFileId, selectedSentence, origWsRef, playbackRate = 1 }) {
  const { t } = useTranslation()
  const [recPhase, setRecPhase] = useState('idle')
  const [recError, setRecError] = useState(null)
  const [userPlaying, setUserPlaying] = useState(false)
  const [userReady, setUserReady] = useState(false)
  const [currentRecordId, setCurrentRecordId] = useState(null)
  const [history, setHistory] = useState([])
  const [result, setResult] = useState(null)
  const [abPhase, setAbPhaseState] = useState(null)
  const [simultaneousPhase, setSimultaneousPhase] = useState(null)

  const recBlobRef = useRef(null)
  const recChunksRef = useRef([])
  const recStreamRef = useRef(null)
  const mediaRecorderRef = useRef(null)
  const abandonRef = useRef(false)
  const userWsRef = useRef(null)
  const userContainerRef = useRef(null)
  const liveCanvasRef = useRef(null)
  const analyserRef = useRef(null)
  const animFrameRef = useRef(null)
  const abPhaseRef = useRef(null)
  const userReadyRef = useRef(false)
  const playbackRateRef = useRef(playbackRate)
  const playbackRevisionRef = useRef(0)
  const recordingRevisionRef = useRef(0)
  const standaloneRef = useRef(null)
  const pairedRef = useRef(null)
  const tRef = useRef(t)
  tRef.current = t
  playbackRateRef.current = playbackRate

  function setAbPhase(next) {
    const value = typeof next === 'function' ? next(abPhaseRef.current) : next
    abPhaseRef.current = value
    setAbPhaseState(value)
  }

  function safePause(player) {
    try { player?.pause() } catch { /* The player may have been destroyed during a sentence change. */ }
  }

  function isExternallyWanted(player) {
    if (standaloneRef.current === player) return true
    return (abPhaseRef.current === 'A' && origWsRef.current === player)
      || (abPhaseRef.current === 'B' && userWsRef.current === player)
  }

  function playbackFailed() {
    setRecError(tRef.current('practice.playbackFailed', { defaultValue: '音频播放失败，请重试。' }))
  }

  if (!pairedRef.current) {
    pairedRef.current = createPairedPlayback({
      getPlayers: () => [origWsRef.current, userWsRef.current],
      onPhaseChange: setSimultaneousPhase,
      onError: playbackFailed,
      shouldPauseStalePlayer: player => !isExternallyWanted(player),
    })
  }

  function stopComparisons() {
    playbackRevisionRef.current++
    standaloneRef.current = null
    setAbPhase(null)
    pairedRef.current.stop()
    safePause(origWsRef.current)
    safePause(userWsRef.current)
  }

  function playSafely(player) {
    if (!player) return
    const operation = playbackRevisionRef.current
    const pauseIfUnwanted = () => {
      if (!isExternallyWanted(player) && !pairedRef.current.wantsToPlay(player)) safePause(player)
    }
    const failed = () => {
      if (operation !== playbackRevisionRef.current) { pauseIfUnwanted(); return }
      stopComparisons()
      playbackFailed()
    }
    try {
      Promise.resolve(player.play()).then(() => {
        if (operation !== playbackRevisionRef.current) pauseIfUnwanted()
      }, failed)
    } catch { failed() }
  }

  function stopComparisonPlayback() {
    if (pairedRef.current.getPhase() || abPhaseRef.current) stopComparisons()
  }

  function stopSimultaneousPlayback() {
    if (pairedRef.current.getPhase()) pairedRef.current.stop()
  }

  function toggleSimultaneousPlayback() {
    if (!userReadyRef.current || !origWsRef.current?.getDuration()) return
    if (!pairedRef.current.getPhase()) {
      stopComparisons()
      setRecError(null)
      pairedRef.current.setRate(playbackRateRef.current)
    }
    pairedRef.current.toggle()
  }

  // These finish handlers intentionally read refs: the original player subscribes once.
  function handleSimultaneousOriginalFinish() {
    return pairedRef.current.finish(origWsRef.current)
  }

  function handleABOriginalFinish() {
    if (abPhaseRef.current !== 'A') return false
    if (!userReadyRef.current || !userWsRef.current) { stopComparisons(); return true }
    setAbPhase('B')
    userWsRef.current.seekTo(0)
    userWsRef.current.setPlaybackRate(playbackRateRef.current)
    playSafely(userWsRef.current)
    return true
  }

  function toggleOriginalPlayback() {
    if (pairedRef.current.getPhase()) { pairedRef.current.toggle(); return }
    if (abPhaseRef.current) { stopComparisons(); return }
    const ws = origWsRef.current
    if (!ws) return
    playbackRevisionRef.current++
    if (ws.isPlaying()) {
      standaloneRef.current = null
      safePause(ws)
    } else {
      safePause(userWsRef.current)
      standaloneRef.current = ws
      ws.setPlaybackRate(playbackRateRef.current)
      playSafely(ws)
    }
  }

  function toggleUserPlayback() {
    const ws = userWsRef.current
    if (!userReadyRef.current || !ws) return
    const wasPlaying = ws.isPlaying()
    stopComparisons()
    if (!wasPlaying) {
      standaloneRef.current = ws
      ws.setPlaybackRate(playbackRateRef.current)
      playSafely(ws)
    }
  }

  useEffect(() => {
    pairedRef.current.setRate(playbackRate)
    userWsRef.current?.setPlaybackRate(playbackRate)
  }, [playbackRate])

  // Recreate the recording waveform after recording, history selection or scoring.
  useEffect(() => {
    if (recPhase !== 'recorded' || !recBlobRef.current || !userContainerRef.current) return
    userReadyRef.current = false
    setUserReady(false)
    const ws = WaveSurfer.create({
      container: userContainerRef.current,
      waveColor: '#fda4af', progressColor: '#f43f5e', cursorColor: 'transparent',
      height: 52, barWidth: 2, barGap: 1, barRadius: 3,
    })
    userWsRef.current = ws
    ws.on('ready', () => {
      if (userWsRef.current !== ws) return
      ws.setPlaybackRate(playbackRateRef.current)
      userReadyRef.current = true
      setUserReady(true)
    })
    ws.on('play', () => setUserPlaying(true))
    ws.on('pause', () => setUserPlaying(false))
    ws.on('interaction', () => {
      // A manual seek leaves comparison mode rather than silently desynchronizing it.
      stopComparisonPlayback()
    })
    ws.on('finish', () => {
      setUserPlaying(false)
      if (pairedRef.current.finish(ws)) return
      if (abPhaseRef.current === 'B') { playbackRevisionRef.current++; setAbPhase(null) }
      if (standaloneRef.current === ws) standaloneRef.current = null
    })
    ws.on('error', () => {
      if (userWsRef.current !== ws) return
      userReadyRef.current = false
      setUserReady(false)
      stopComparisons()
      playbackFailed()
    })
    Promise.resolve(ws.loadBlob(recBlobRef.current)).catch(() => {
      if (userWsRef.current === ws) playbackFailed()
    })
    return () => {
      stopComparisons()
      userReadyRef.current = false
      setUserReady(false)
      setUserPlaying(false)
      ws.destroy()
      if (userWsRef.current === ws) userWsRef.current = null
    }
  }, [recPhase])

  useEffect(() => () => {
    recordingRevisionRef.current++
    playbackRevisionRef.current++
    standaloneRef.current = null
    abPhaseRef.current = null
    pairedRef.current.stop()
    safePause(origWsRef.current)
    safePause(userWsRef.current)
    recStreamRef.current?.getTracks().forEach(track => track.stop())
    if (animFrameRef.current) cancelAnimationFrame(animFrameRef.current)
    analyserRef.current?.audioCtx.close().catch(() => {})
  }, [])

  const drawLive = useCallback(() => {
    animFrameRef.current = requestAnimationFrame(drawLive)
    const canvas = liveCanvasRef.current
    const ref = analyserRef.current
    if (!canvas || !ref) return
    const { analyser } = ref
    const data = new Uint8Array(analyser.fftSize)
    analyser.getByteTimeDomainData(data)
    const ctx = canvas.getContext('2d')
    const { width: w, height: h } = canvas
    ctx.clearRect(0, 0, w, h)
    const barW = 2, gap = 1, step = barW + gap
    const numBars = Math.floor(w / step)
    const sampleStep = Math.floor(data.length / numBars)
    const cy = h / 2
    for (let i = 0; i < numBars; i++) {
      const v = Math.abs((data[i * sampleStep] ?? 128) - 128) / 128
      const barH = Math.max(2, v * h)
      ctx.fillStyle = `rgba(253, 164, 175, ${0.4 + 0.6 * v})`
      ctx.fillRect(i * step, cy - barH / 2, barW, barH)
    }
  }, [])

  function stopLiveViz() {
    if (animFrameRef.current) { cancelAnimationFrame(animFrameRef.current); animFrameRef.current = null }
    if (analyserRef.current) { analyserRef.current.audioCtx.close().catch(() => {}); analyserRef.current = null }
    const canvas = liveCanvasRef.current
    if (canvas) canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height)
  }

  function resetRec() {
    recordingRevisionRef.current++
    stopComparisons()
    userReadyRef.current = false
    setUserReady(false)
    stopLiveViz()
    const mr = mediaRecorderRef.current
    if (mr && (mr.state === 'recording' || mr.state === 'paused')) {
      abandonRef.current = true
      mr.stop()
    }
    recBlobRef.current = null
    recChunksRef.current = []
    recStreamRef.current?.getTracks().forEach(track => track.stop())
    recStreamRef.current = null
    setRecError(null)
    setRecPhase('idle')
  }

  function resetForSentence() {
    resetRec()
    setResult(null)
    setCurrentRecordId(null)
    setHistory([])
  }

  async function startRecording() {
    if (!selectedSentence) return
    resetRec()
    const operation = recordingRevisionRef.current
    setCurrentRecordId(null)
    setResult(null)
    if (!navigator.mediaDevices?.getUserMedia) {
      setRecError(t('practice.micNotSupported'))
      return
    }
    let stream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { sampleRate: { ideal: 16000 }, channelCount: { ideal: 1 } },
      })
    } catch (err) {
      if (operation !== recordingRevisionRef.current) return
      setRecError((err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')
        ? t('practice.micPermissionDenied') : t('practice.micError'))
      return
    }
    if (operation !== recordingRevisionRef.current) {
      stream.getTracks().forEach(track => track.stop())
      return
    }
    recStreamRef.current = stream
    const audioCtx = new AudioContext()
    const source = audioCtx.createMediaStreamSource(stream)
    const analyser = audioCtx.createAnalyser()
    analyser.fftSize = 128
    source.connect(analyser)
    analyserRef.current = { analyser, audioCtx }
    animFrameRef.current = requestAnimationFrame(drawLive)

    const mr = new MediaRecorder(stream)
    mediaRecorderRef.current = mr
    const chunks = []
    recChunksRef.current = chunks
    mr.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }
    mr.onstop = () => {
      if (operation !== recordingRevisionRef.current || abandonRef.current) { abandonRef.current = false; return }
      stopLiveViz()
      const blob = new Blob(chunks, { type: 'audio/webm' })
      recBlobRef.current = blob
      recStreamRef.current?.getTracks().forEach(track => track.stop())
      recStreamRef.current = null
      setRecPhase('recorded')
      practiceApi.saveRecording(audioFileId, selectedSentence.index, blob).then(({ data }) => {
        if (operation !== recordingRevisionRef.current) return
        setCurrentRecordId(data.id)
        practiceApi.getHistory(audioFileId, selectedSentence.index)
          .then(r => { if (operation === recordingRevisionRef.current) setHistory(r.data) }).catch(() => {})
      }).catch(() => {})
    }
    abandonRef.current = false
    mr.start()
    setRecPhase('recording')
  }

  function pauseRecording() { mediaRecorderRef.current?.pause(); setRecPhase('paused') }
  function resumeRecording() { mediaRecorderRef.current?.resume(); setRecPhase('recording') }
  function finishRecording() { mediaRecorderRef.current?.stop() }

  function playAB() {
    if (abPhaseRef.current) { stopComparisons(); return }
    if (!userReadyRef.current || !origWsRef.current?.getDuration()) return
    stopComparisons()
    setRecError(null)
    setAbPhase('A')
    origWsRef.current.seekTo(0)
    origWsRef.current.setPlaybackRate(playbackRateRef.current)
    playSafely(origWsRef.current)
  }

  async function submitRecording() {
    if (!currentRecordId) return
    stopComparisons()
    const operation = recordingRevisionRef.current
    setRecPhase('submitting')
    setRecError(null)
    try {
      const { data } = await practiceApi.scoreRecording(currentRecordId)
      if (operation !== recordingRevisionRef.current) return
      setResult(data)
      practiceApi.getHistory(audioFileId, selectedSentence.index)
        .then(r => { if (operation === recordingRevisionRef.current) setHistory(r.data) }).catch(() => {})
    } catch (err) {
      if (operation !== recordingRevisionRef.current) return
      setRecError(err.response?.data?.detail ?? err.message ?? t('practice.scoreFailed'))
    }
    if (operation === recordingRevisionRef.current) setRecPhase('recorded')
  }

  async function loadHistoryRecord(record) {
    resetRec()
    const operation = recordingRevisionRef.current
    setResult(record)
    setCurrentRecordId(record.id)
    try {
      const resp = await fetch(practiceApi.recordStreamUrl(record.id))
      if (!resp.ok) throw new Error('Recording unavailable')
      const blob = await resp.blob()
      if (operation !== recordingRevisionRef.current) return
      recBlobRef.current = blob
      setRecPhase('recorded')
    } catch {
      if (operation === recordingRevisionRef.current) playbackFailed()
    }
  }

  async function deleteHistoryRecord(e, record) {
    e.stopPropagation()
    await practiceApi.deleteRecord(record.id).catch(() => {})
    if (currentRecordId === record.id) {
      setResult(null)
      setCurrentRecordId(null)
      resetRec()
    }
    setHistory(h => h.filter(r => r.id !== record.id))
  }

  return {
    recPhase, recError, userPlaying, userReady, simultaneousPhase,
    currentRecordId, setCurrentRecordId, history, setHistory, result, setResult,
    abPhase, setAbPhase, abPhaseRef,
    recBlobRef, liveCanvasRef, userWsRef, userContainerRef,
    startRecording, pauseRecording, resumeRecording, finishRecording,
    resetRec, resetForSentence, submitRecording, playAB,
    toggleSimultaneousPlayback, stopSimultaneousPlayback, stopComparisonPlayback,
    stopAllPlayback: stopComparisons,
    handleSimultaneousOriginalFinish, handleABOriginalFinish,
    toggleOriginalPlayback, toggleUserPlayback,
    loadHistoryRecord, deleteHistoryRecord,
  }
}
