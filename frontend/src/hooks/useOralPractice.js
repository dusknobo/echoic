import { useState, useRef, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { oralApi } from '@/api'
import { createRecordingSession, recordingErrorMessage, recordingInterruptionMessage } from '@/lib/recording'

// phases: idle → generating → idle → requesting → recording → recorded → submitting → scored
export function useOralPractice({ questionType, language, difficulty, topic } = {}) {
  const { t } = useTranslation()
  const tRef = useRef(t)
  tRef.current = t
  const [phase, setPhase] = useState('idle')
  const [editableText, setEditableText] = useState('')
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [timerEnabled, setTimerEnabled] = useState(true)
  const [timerSecs, setTimerSecs] = useState(30)
  const [countdown, setCountdown] = useState(0)

  const liveCanvasRef = useRef(null)
  const recBlobRef = useRef(null)
  const captureRef = useRef(null)
  const analyserRef = useRef(null)
  const animFrameRef = useRef(null)
  const timerRef = useRef(null)
  const revisionRef = useRef(0)
  const submittingRef = useRef(false)
  // Snapshot the question and its settings with the recording, including retries.
  const pendingQuestionRef = useRef(null)
  const llmPromptRef = useRef('')

  const stopLiveViz = useCallback(() => {
    cancelAnimationFrame(animFrameRef.current)
    animFrameRef.current = null
    analyserRef.current?.audioCtx.close().catch(() => {})
    analyserRef.current = null
  }, [])

  const clearTimer = useCallback(() => {
    clearInterval(timerRef.current)
    timerRef.current = null
  }, [])

  const disposeCapture = useCallback(() => {
    revisionRef.current++
    captureRef.current?.cancel()
    captureRef.current = null
    clearTimer()
    stopLiveViz()
    recBlobRef.current = null
    pendingQuestionRef.current = null
    submittingRef.current = false
  }, [clearTimer, stopLiveViz])

  const resetPractice = useCallback(() => {
    disposeCapture()
    setCountdown(0)
    setResult(null)
    setError(null)
    setPhase('idle')
  }, [disposeCapture])

  useEffect(() => {
    resetPractice()
    return disposeCapture
  }, [questionType, language, difficulty, topic, resetPractice, disposeCapture])

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
    const step = 3
    const numBars = Math.max(1, Math.floor(w / step))
    const bucketSize = Math.max(1, Math.floor(data.length / numBars))
    for (let i = 0; i < numBars; i++) {
      let sum = 0
      for (let j = 0; j < bucketSize; j++) sum += Math.abs((data[i * bucketSize + j] ?? 128) - 128)
      const barH = Math.max(2, (sum / bucketSize / 128) * h * 2.5)
      ctx.fillStyle = '#f43f5e'
      ctx.fillRect(i * step, (h - barH) / 2, 2, barH)
    }
  }, [])

  const startLiveViz = useCallback(stream => {
    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext
    if (!AudioCtx) return
    let audioCtx
    try {
      audioCtx = new AudioCtx()
      const source = audioCtx.createMediaStreamSource(stream)
      const analyser = audioCtx.createAnalyser()
      analyser.fftSize = 256
      source.connect(analyser)
      analyserRef.current = { analyser, audioCtx }
      drawLive()
      return stopLiveViz
    } catch {
      audioCtx?.close().catch(() => {})
    }
  }, [drawLive, stopLiveViz])

  const generateQuestion = useCallback(async () => {
    disposeCapture()
    const operation = revisionRef.current
    setPhase('generating')
    setResult(null)
    setError(null)
    try {
      const res = await oralApi.generateQuestion({ questionType, language, difficulty, topic })
      if (operation !== revisionRef.current) return
      const q = res.data
      llmPromptRef.current = q.prompt ?? ''
      setEditableText(questionType === 'read_aloud' ? (q.reference_text ?? '') : (q.prompt ?? ''))
    } catch (e) {
      if (operation !== revisionRef.current) return
      setError(e?.response?.data?.detail || tRef.current('recording.generateFailed', { defaultValue: '生成题目失败，请重试。' }))
    }
    if (operation === revisionRef.current) setPhase('idle')
  }, [questionType, language, difficulty, topic, disposeCapture])

  const cancelRecording = resetPractice

  const startRecording = useCallback(async () => {
    const text = editableText.trim()
    if (!text || captureRef.current || submittingRef.current) return
    disposeCapture()
    const operation = revisionRef.current
    const isCurrent = () => operation === revisionRef.current
    const isReadAloud = questionType === 'read_aloud'
    pendingQuestionRef.current = {
      questionType, questionLanguage: language, questionDifficulty: difficulty,
      questionPrompt: isReadAloud ? (llmPromptRef.current || 'Read the following text aloud:') : text,
      questionReference: isReadAloud ? text : null,
      timerSecs: timerEnabled ? timerSecs : null,
    }
    setResult(null)
    setError(null)
    setCountdown(0)
    setPhase('requesting')
    const capture = createRecordingSession({
      onStream: startLiveViz,
      onStart: () => {
        if (!isCurrent()) return
        setPhase('recording')
        if (timerEnabled && timerSecs > 0) {
          const deadline = Date.now() + timerSecs * 1000
          setCountdown(timerSecs)
          timerRef.current = setInterval(() => {
            if (!isCurrent()) return
            const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
            setCountdown(remaining)
            if (remaining <= 0) { clearTimer(); capture.stop() }
          }, 250)
        }
      },
      onInterrupt: reason => {
        if (isCurrent()) {
          clearTimer()
          setError(recordingInterruptionMessage(reason, tRef.current))
        }
      },
      onComplete: blob => {
        if (!isCurrent()) return
        clearTimer()
        captureRef.current = null
        recBlobRef.current = blob
        setPhase('recorded')
      },
      onError: failure => {
        if (!isCurrent()) return
        clearTimer()
        captureRef.current = null
        setError(recordingErrorMessage(failure, tRef.current))
        setPhase('idle')
      },
    })
    captureRef.current = capture
    await capture.start()
  }, [editableText, questionType, language, difficulty, timerEnabled, timerSecs, startLiveViz, disposeCapture, clearTimer])

  const stopRecording = useCallback(() => {
    clearTimer()
    captureRef.current?.stop()
  }, [clearTimer])

  const submitRecording = useCallback(async () => {
    const q = pendingQuestionRef.current
    const blob = recBlobRef.current
    if (!blob || !q || submittingRef.current) return
    const operation = revisionRef.current
    submittingRef.current = true
    setPhase('submitting')
    setError(null)
    try {
      const res = await oralApi.submitAttempt({ ...q, blob })
      if (operation !== revisionRef.current) return
      setResult(res.data)
      setPhase('scored')
    } catch (e) {
      if (operation !== revisionRef.current) return
      setError(e?.response?.data?.detail || tRef.current('recording.submitFailed', {
        defaultValue: '提交评分失败，录音仍保留在当前页面，请联网后重试。',
      }))
      setPhase('recorded')
    } finally {
      if (operation === revisionRef.current) submittingRef.current = false
    }
  }, [])

  return {
    phase, editableText, setEditableText, result, error,
    timerEnabled, setTimerEnabled, timerSecs, setTimerSecs, countdown, liveCanvasRef,
    generateQuestion, resetPractice, startRecording, stopRecording, submitRecording, cancelRecording,
  }
}
