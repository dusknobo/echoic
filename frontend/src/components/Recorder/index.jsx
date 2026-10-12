import { useState, useRef, useEffect } from 'react'
import WaveSurfer from 'wavesurfer.js'
import { useTranslation } from 'react-i18next'
import { createRecordingSession, recordingErrorMessage, recordingInterruptionMessage } from '@/lib/recording'
import { Mic, Square, Play, RotateCcw, Loader2 } from 'lucide-react'
import { practiceApi } from '@/api'
import { Button } from '@/components/ui/button'

export default function Recorder({ sentence, audioFileId, onResult }) {
  const { t } = useTranslation()
  const [phase, setPhase] = useState('idle') // idle | recording | recorded | submitting
  const [error, setError] = useState(null)

  const captureRef = useRef(null)
  const revisionRef = useRef(0)
  const recordIdRef = useRef(null)
  const submittingRef = useRef(false)
  const blobRef = useRef(null)
  const waveformRef = useRef(null)
  const wavesurferRef = useRef(null)

  useEffect(() => {
    if (phase !== 'recorded' || !blobRef.current || !waveformRef.current) return
    const ws = WaveSurfer.create({
      container: waveformRef.current,
      waveColor: '#94a3b8',
      progressColor: '#3b82f6',
      cursorColor: 'transparent',
      height: 40,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
    })
    ws.on('error', () => setError(t('recording.playbackFailed', { defaultValue: '录音播放失败，请重试。' })))
    Promise.resolve(ws.loadBlob(blobRef.current)).catch(() => setError(t('recording.playbackFailed', { defaultValue: '录音播放失败，请重试。' })))
    wavesurferRef.current = ws
    return () => { ws.destroy(); wavesurferRef.current = null }
  }, [phase])

  useEffect(() => () => { revisionRef.current++; captureRef.current?.cancel() }, [])

  useEffect(() => { reset() }, [sentence?.index, audioFileId])

  function reset() {
    revisionRef.current++
    captureRef.current?.cancel()
    captureRef.current = null
    blobRef.current = null
    recordIdRef.current = null
    submittingRef.current = false
    setError(null)
    setPhase('idle')
  }

  async function startRecording() {
    if (!sentence || captureRef.current || submittingRef.current) return
    reset()
    const operation = revisionRef.current
    const isCurrent = () => operation === revisionRef.current
    setPhase('requesting')
    const capture = createRecordingSession({
      onStart: () => { if (isCurrent()) setPhase('recording') },
      onComplete: blob => {
        if (!isCurrent()) return
        captureRef.current = null
        blobRef.current = blob
        setPhase('recorded')
      },
      onInterrupt: reason => { if (isCurrent()) setError(recordingInterruptionMessage(reason, t)) },
      onError: failure => {
        if (!isCurrent()) return
        captureRef.current = null
        setError(recordingErrorMessage(failure, t))
        setPhase('idle')
      },
    })
    captureRef.current = capture
    await capture.start()
  }

  function stopRecording() { captureRef.current?.stop() }

  async function submitRecording() {
    if (!blobRef.current || submittingRef.current) return
    const operation = revisionRef.current
    submittingRef.current = true
    setPhase('submitting')
    setError(null)
    try {
      if (!recordIdRef.current) {
        const { data } = await practiceApi.saveRecording(audioFileId, sentence.index, blobRef.current)
        if (operation !== revisionRef.current) return
        recordIdRef.current = data.id
      }
      const { data } = await practiceApi.scoreRecording(recordIdRef.current)
      if (operation !== revisionRef.current) return
      onResult(data)
      reset()
    } catch (err) {
      if (operation !== revisionRef.current) return
      setError(err.response?.data?.detail ?? err.message ?? '提交失败，录音仍保留，请重试。')
      setPhase('recorded')
    } finally {
      if (operation === revisionRef.current) submittingRef.current = false
    }
  }

  return (
    <div className="flex flex-col items-center gap-4 pb-8 shrink-0 min-w-0">
      {/* Waveform after recording */}
      {(phase === 'recorded' || phase === 'submitting') && (
        <div className="w-full max-w-lg px-3 sm:px-8">
          <div className="rounded-xl bg-muted/50 px-4 py-3">
            <div ref={waveformRef} />
          </div>
        </div>
      )}

      {error && <p role="alert" className="text-sm text-destructive px-3 break-words">{error}</p>}

      {phase === 'requesting' && (
        <Button disabled className="min-h-11 gap-2"><Loader2 className="size-4 animate-spin" />正在等待麦克风授权…</Button>
      )}

      {phase === 'idle' && (
        <>
          <button
            onClick={startRecording}
            aria-label="开始录音"
            className="w-14 h-14 rounded-full bg-primary hover:bg-primary/90 transition-colors flex items-center justify-center shadow-lg"
          >
            <Mic className="w-6 h-6 text-primary-foreground" />
          </button>
          <p className="text-xs text-muted-foreground">点击开始录音</p>
        </>
      )}

      {phase === 'recording' && (
        <>
          <button
            onClick={stopRecording}
            aria-label="停止录音"
            className="w-14 h-14 rounded-full bg-destructive hover:bg-destructive/90 transition-colors flex items-center justify-center shadow-lg animate-pulse"
          >
            <Square className="w-5 h-5 text-white" />
          </button>
          <p className="text-xs text-destructive">录音中，点击停止</p>
        </>
      )}

      {(phase === 'recorded' || phase === 'submitting') && (
        <div className="flex items-center justify-center flex-wrap gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => wavesurferRef.current?.playPause()}
            disabled={phase === 'submitting'}
          >
            <Play className="w-4 h-4 mr-1" />
            播放
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={reset}
            disabled={phase === 'submitting'}
          >
            <RotateCcw className="w-4 h-4 mr-1" />
            重录
          </Button>
          <Button
            size="sm"
            onClick={submitRecording}
            disabled={phase === 'submitting'}
          >
            {phase === 'submitting' && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
            提交评分
          </Button>
        </div>
      )}
    </div>
  )
}
