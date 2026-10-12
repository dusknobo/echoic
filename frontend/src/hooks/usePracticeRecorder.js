import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import WaveSurfer from 'wavesurfer.js'
import { practiceApi } from '@/api'
import { createPairedPlayback } from '@/lib/pairedPlayback'
import { createRecordingSession, recordingErrorMessage, recordingInterruptionMessage } from '@/lib/recording'

/** Recording, A/B comparison, simultaneous playback, history and scoring. */
export function usePracticeRecorder({ audioFileId, selectedSentence, origWsRef, playbackRate = 1 }) {
  const { t } = useTranslation()
  const [recPhase, setRecPhase] = useState('idle')
  const [recError, setRecError] = useState(null)
  const [saveState, setSaveState] = useState('idle')
  const [saveError, setSaveError] = useState(null)
  const [userPlaying, setUserPlaying] = useState(false)
  const [userReady, setUserReady] = useState(false)
  const [currentRecordId, setCurrentRecordId] = useState(null)
  const [history, setHistory] = useState([])
  const [result, setResult] = useState(null)
  const [abPhase, setAbPhaseState] = useState(null)
  const [simultaneousPhase, setSimultaneousPhase] = useState(null)

  const recBlobRef = useRef(null)
  const captureRef = useRef(null)
  const savePromiseRef = useRef(null)
  const savedRecordIdRef = useRef(null)
  const submittingRef = useRef(false)
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
    captureRef.current?.cancel()
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
    if (!ctx) return
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
    if (canvas) canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
  }

  function resetRec() {
    recordingRevisionRef.current++
    captureRef.current?.cancel()
    captureRef.current = null
    savePromiseRef.current = null
    savedRecordIdRef.current = null
    setCurrentRecordId(null)
    submittingRef.current = false
    stopComparisons()
    userReadyRef.current = false
    setUserReady(false)
    stopLiveViz()
    recBlobRef.current = null
    setRecError(null)
    setSaveState('idle')
    setSaveError(null)
    setRecPhase('idle')
  }

  function resetForSentence() {
    resetRec()
    setResult(null)
    setCurrentRecordId(null)
    setHistory([])
  }

  function saveRecordingBlob(operation = recordingRevisionRef.current) {
    if (operation !== recordingRevisionRef.current || !recBlobRef.current || !selectedSentence) return Promise.resolve(null)
    if (savedRecordIdRef.current) return Promise.resolve(savedRecordIdRef.current)
    if (savePromiseRef.current?.operation === operation) return savePromiseRef.current.promise
    const blob = recBlobRef.current
    const sentenceIndex = selectedSentence.index
    setSaveState('saving')
    setSaveError(null)
    const promise = (async () => {
      try {
        const { data } = await practiceApi.saveRecording(audioFileId, sentenceIndex, blob)
        if (operation !== recordingRevisionRef.current) return null
        savedRecordIdRef.current = data.id
        setCurrentRecordId(data.id)
        setSaveState('saved')
        practiceApi.getHistory(audioFileId, sentenceIndex)
          .then(r => { if (operation === recordingRevisionRef.current) setHistory(r.data) }).catch(() => {})
        return data.id
      } catch (error) {
        if (operation === recordingRevisionRef.current) {
          setSaveState('error')
          setSaveError(error.response?.data?.detail || tRef.current('recording.saveFailed', {
            defaultValue: '录音上传失败，音频仍保留在当前页面。请保持页面打开，联网后重试保存。',
          }))
        }
        return null
      } finally {
        if (savePromiseRef.current?.operation === operation) savePromiseRef.current = null
      }
    })()
    savePromiseRef.current = { operation, promise }
    return promise
  }

  function startLiveViz(stream) {
    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext
    if (!AudioCtx) return
    let audioCtx
    try {
      audioCtx = new AudioCtx()
      const source = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 128
      source.connect(analyser)
      analyserRef.current = { analyser, audioCtx }
      animFrameRef.current = requestAnimationFrame(drawLive)
      return stopLiveViz
    } catch {
      audioCtx?.close().catch(() => {})
    }
  }

  async function startRecording() {
    if (!selectedSentence || captureRef.current || recPhase === 'submitting') return
    resetRec()
    const operation = recordingRevisionRef.current
    setCurrentRecordId(null)
    setResult(null)
    setRecPhase('requesting')
    const isCurrent = () => operation === recordingRevisionRef.current
    const capture = createRecordingSession({
      onStream: startLiveViz,
      onStart: () => { if (isCurrent()) setRecPhase('recording') },
      onInterrupt: reason => {
        if (isCurrent()) setRecError(recordingInterruptionMessage(reason, tRef.current))
      },
      onComplete: blob => {
        if (!isCurrent()) return
        captureRef.current = null
        recBlobRef.current = blob
        setRecPhase('recorded')
        saveRecordingBlob(operation)
      },
      onError: error => {
        if (!isCurrent()) return
        captureRef.current = null
        setRecError(recordingErrorMessage(error, tRef.current))
        setRecPhase('idle')
      },
    })
    captureRef.current = capture
    await capture.start()
  }

  function pauseRecording() { if (captureRef.current?.pause()) setRecPhase('paused') }
  function resumeRecording() { if (captureRef.current?.resume()) setRecPhase('recording') }
  function finishRecording() { captureRef.current?.stop() }
  function retrySaveRecording() { return saveRecordingBlob() }

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
    if (!recBlobRef.current || submittingRef.current) return
    submittingRef.current = true
    stopComparisons()
    const operation = recordingRevisionRef.current
    setRecPhase('submitting')
    setRecError(null)
    try {
      const recordId = savedRecordIdRef.current || await saveRecordingBlob(operation)
      if (operation !== recordingRevisionRef.current) return
      if (!recordId) { submittingRef.current = false; setRecPhase('recorded'); return }
      const { data } = await practiceApi.scoreRecording(recordId)
      if (operation !== recordingRevisionRef.current) return
      setResult(data)
      practiceApi.getHistory(audioFileId, selectedSentence.index)
        .then(r => { if (operation === recordingRevisionRef.current) setHistory(r.data) }).catch(() => {})
    } catch (err) {
      if (operation !== recordingRevisionRef.current) return
      setRecError(err.response?.data?.detail ?? err.message ?? t('practice.scoreFailed'))
    }
    if (operation === recordingRevisionRef.current) { submittingRef.current = false; setRecPhase('recorded') }
  }

  async function loadHistoryRecord(record) {
    resetRec()
    const operation = recordingRevisionRef.current
    setResult(record)
    setCurrentRecordId(record.id)
    savedRecordIdRef.current = record.id
    setSaveState('saved')
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
    recPhase, recError, saveState, saveError, retrySaveRecording, userPlaying, userReady, simultaneousPhase,
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
