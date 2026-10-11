import { useCallback, useEffect, useRef, useState } from 'react'
import { audioApi, practiceApi } from '@/api'
import { getSegmentBlob } from '@/lib/audioSegment'
import { comparisonAudioRange } from '@/lib/aiComparison'

/** Play actual source clips without entering sentence loops or A/B playback. */
export function useAIComparisonPlayback({ audioFileId, selectedSentence, recordId, audioCacheRef, playbackRate = 1, onBeforePlay, disabled = false }) {
  const [playing, setPlaying] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const audioRef = useRef(null)
  const urlRef = useRef(null)
  const revisionRef = useRef(0)
  const mountedRef = useRef(true)
  const timingsRef = useRef(null)
  const recordingCacheRef = useRef(null)
  const fetchRef = useRef(null)
  const configRef = useRef(null)
  configRef.current = { audioFileId, selectedSentence, recordId, audioCacheRef, playbackRate, onBeforePlay, disabled }

  const release = useCallback(() => {
    const audio = audioRef.current
    audioRef.current = null
    if (audio) {
      audio.onended = null
      audio.onerror = null
      try { audio.pause(); audio.removeAttribute('src'); audio.load() } catch { /* Player already disposed. */ }
    }
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null }
  }, [])

  const stop = useCallback(() => {
    revisionRef.current++
    fetchRef.current?.abort()
    fetchRef.current = null
    release()
    if (mountedRef.current) { setPlaying(null); setLoading(false); setError(null) }
  }, [release])

  const clearRecordCache = useCallback(() => {
    timingsRef.current?.controller.abort()
    timingsRef.current = null
    recordingCacheRef.current = null
  }, [])

  async function getTimings(targetRecordId) {
    // Keep a local alignment request shared when switching between clip buttons.
    if (timingsRef.current?.recordId === targetRecordId) return timingsRef.current.promise
    const controller = new AbortController()
    const entry = { recordId: targetRecordId, controller, promise: null }
    entry.promise = (async () => {
      const timer = setTimeout(() => controller.abort(), 180000)
      try {
        const response = await fetch(`/api/practice/record/${targetRecordId}/word-timings`, { signal: controller.signal })
        if (!response.ok) {
          const body = await response.json().catch(() => ({}))
          throw new Error(typeof body.detail === 'string' ? body.detail : '录音定位暂时不可用，请重试。')
        }
        const data = await response.json()
        if (data.record_id !== targetRecordId || !Array.isArray(data.words) || !Number.isFinite(data.duration) || data.duration <= 0) {
          throw new Error('录音定位结果无效，可使用整句回听。')
        }
        return data
      } finally { clearTimeout(timer) }
    })().catch(failure => {
      if (timingsRef.current === entry) timingsRef.current = null
      throw failure
    })
    timingsRef.current = entry
    return entry.promise
  }

  const play = useCallback(async (target, source) => {
    stop()
    const config = configRef.current
    if (config.disabled || !config.selectedSentence || !target || !['original', 'recording'].includes(source)) return
    if (source === 'recording' && !config.recordId) return
    const operation = revisionRef.current
    const current = () => {
      const latest = configRef.current
      return mountedRef.current && operation === revisionRef.current && !latest.disabled
        && latest.audioFileId === config.audioFileId && latest.recordId === config.recordId
        && latest.selectedSentence?.index === config.selectedSentence.index
        && latest.selectedSentence?.start === config.selectedSentence.start
        && latest.selectedSentence?.end === config.selectedSentence.end
        && latest.selectedSentence?.text === config.selectedSentence.text
    }
    const fail = message => {
      if (!current()) return
      release()
      setPlaying(null); setLoading(false)
      setError(message || '片段播放失败，请重试或使用整句回听。')
    }
    try { config.onBeforePlay?.() } catch { fail(); return }
    if (!current()) return
    setPlaying({ targetKey: target.key, source })
    setLoading(true)
    setError(null)
    try {
      let blob
      if (source === 'original') {
        const sentence = config.selectedSentence
        const bounds = { start: sentence.start, end: sentence.end }
        const range = target.wholeSentence ? bounds : comparisonAudioRange(target, sentence, sentence.words, bounds)
        if (!range || !Number.isFinite(range.start) || !Number.isFinite(range.end) || range.end <= range.start) {
          fail('无法定位原音中的这个片段，请使用整句原音回听。'); return
        }
        blob = await getSegmentBlob(audioApi.streamUrl(config.audioFileId), range.start, range.end, config.audioCacheRef)
      } else if (target.wholeSentence) {
        const controller = new AbortController()
        fetchRef.current = controller
        const response = await fetch(practiceApi.recordStreamUrl(config.recordId), { signal: controller.signal })
        if (!response.ok) throw new Error('录音文件暂时无法读取，请重新选择录音后重试。')
        blob = await response.blob()
        if (fetchRef.current === controller) fetchRef.current = null
      } else {
        const data = await getTimings(config.recordId)
        if (!current()) return
        const range = comparisonAudioRange(target, config.selectedSentence, data.words, { start: 0, end: data.duration })
        if (!range) { fail('无法可靠定位录音中的这个片段，请使用整句录音回听。'); return }
        blob = await getSegmentBlob(practiceApi.recordStreamUrl(config.recordId), range.start, range.end, recordingCacheRef)
      }
      if (!current()) return
      if (!blob?.size) { fail(); return }
      const audio = new Audio()
      const url = URL.createObjectURL(blob)
      audioRef.current = audio
      urlRef.current = url
      audio.src = url
      const rate = configRef.current.playbackRate
      audio.playbackRate = Number.isFinite(rate) && rate > 0 ? rate : 1
      audio.onended = () => {
        if (!current() || audioRef.current !== audio) return
        release(); setPlaying(null); setLoading(false)
      }
      audio.onerror = () => { if (audioRef.current === audio) fail() }
      await audio.play()
      if (current() && audioRef.current === audio) setLoading(false)
      else if (audioRef.current === audio) release()
    } catch (failure) {
      if (failure?.name === 'AbortError') fail('录音定位或读取已超时，请重试；也可以先回听整句。')
      else fail(failure?.message || '片段播放失败，请重试或使用整句回听。')
    }
  }, [release, stop])

  useEffect(() => {
    const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1
    if (audioRef.current) audioRef.current.playbackRate = rate
  }, [playbackRate])
  useEffect(() => { if (disabled) stop() }, [disabled, stop])
  useEffect(() => { stop(); clearRecordCache() }, [audioFileId, selectedSentence?.index, recordId, stop, clearRecordCache])
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; stop(); clearRecordCache() }
  }, [stop, clearRecordCache])

  return { play, stop, playing, loading, error, disabled }
}
