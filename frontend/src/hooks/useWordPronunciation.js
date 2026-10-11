import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { audioApi } from '@/api'
import { getSegmentBlob } from '@/lib/audioSegment'
import { normalizeStudyWord, wordAudioRange } from '@/lib/wordStudy'

/** A separate player keeps word clips outside sentence looping and comparison modes. */
export function useWordPronunciation({ audioFileId, selectedSentence, words, audioCacheRef, playbackRate = 1, onBeforePlay, disabled = false }) {
  const { t } = useTranslation()
  const [playingWordIndex, setPlayingWordIndex] = useState(null)
  const [wordPlaybackError, setWordPlaybackError] = useState(null)
  const [pronunciationSource, setPronunciationSource] = useState(null)
  const audioRef = useRef(null)
  const urlRef = useRef(null)
  const requestRef = useRef(null)
  const revisionRef = useRef(0)
  const mountedRef = useRef(true)
  const configRef = useRef(null)
  configRef.current = { audioFileId, selectedSentence, words, audioCacheRef, playbackRate, onBeforePlay, disabled, t }

  const releaseAudio = useCallback(() => {
    const audio = audioRef.current
    audioRef.current = null
    if (audio) {
      audio.onended = null
      audio.onerror = null
      try { audio.pause(); audio.removeAttribute('src'); audio.load() } catch { /* Already disposed. */ }
    }
    if (urlRef.current) { URL.revokeObjectURL(urlRef.current); urlRef.current = null }
  }, [])

  const stopWordPlayback = useCallback(() => {
    revisionRef.current++
    requestRef.current?.abort()
    requestRef.current = null
    releaseAudio()
    if (mountedRef.current) {
      setPlayingWordIndex(null)
      setPronunciationSource(null)
      setWordPlaybackError(null)
    }
  }, [releaseAudio])

  const playWord = useCallback(async index => {
    stopWordPlayback()
    const config = configRef.current
    if (config.disabled || !Number.isInteger(index) || !config.words?.[index]) return
    const text = config.words[index].text ?? config.words[index].word ?? ''
    const token = normalizeStudyWord(text)
    if (!token) return
    const operation = revisionRef.current
    const current = () => mountedRef.current && operation === revisionRef.current && !configRef.current.disabled
    const fail = () => {
      if (!current()) return
      releaseAudio()
      setPlayingWordIndex(null)
      setWordPlaybackError(configRef.current.t('practice.wordPlaybackFailed', { defaultValue: '单词发音暂时不可用，请重试。' }))
    }
    try { config.onBeforePlay?.() } catch { fail(); return }
    if (!current()) return
    setPlayingWordIndex(index)

    async function playBlob(blob, source) {
      if (!current()) return
      releaseAudio()
      const audio = new Audio()
      const url = URL.createObjectURL(blob)
      audioRef.current = audio
      urlRef.current = url
      audio.src = url
      const rate = configRef.current.playbackRate
      audio.playbackRate = Number.isFinite(rate) && rate > 0 ? rate : 1
      setPronunciationSource(source)
      audio.onended = () => {
        if (!current() || audioRef.current !== audio) return
        releaseAudio()
        setPlayingWordIndex(null)
      }
      const failed = () => {
        if (!current() || audioRef.current !== audio) return
        releaseAudio()
        if (source === 'original') void playSpeech()
        else fail()
      }
      audio.onerror = failed
      try { await audio.play() } catch { failed() }
      if (!current() && audioRef.current === audio) releaseAudio()
    }

    async function playSpeech() {
      if (!current()) return
      setPronunciationSource('speech')
      const controller = new AbortController()
      requestRef.current = controller
      const timeout = setTimeout(() => controller.abort(), 15000)
      try {
        const response = await fetch(`/api/word-speech/en/${encodeURIComponent(token)}`, { signal: controller.signal })
        if (!response.ok) throw new Error('Word speech unavailable')
        const blob = await response.blob()
        if (!blob.size) throw new Error('Empty word speech')
        if (current()) await playBlob(blob, 'speech')
      } catch { fail() }
      finally {
        clearTimeout(timeout)
        if (requestRef.current === controller) requestRef.current = null
      }
    }

    const range = wordAudioRange(config.words, index, config.selectedSentence)
    if (!range) { await playSpeech(); return }
    try {
      const blob = await getSegmentBlob(audioApi.streamUrl(config.audioFileId), range.start, range.end, config.audioCacheRef)
      if (current()) await playBlob(blob, 'original')
    } catch { if (current()) await playSpeech() }
  }, [releaseAudio, stopWordPlayback])

  useEffect(() => {
    const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : 1
    if (audioRef.current) audioRef.current.playbackRate = rate
  }, [playbackRate])

  useEffect(() => { stopWordPlayback() }, [audioFileId, selectedSentence?.index, stopWordPlayback])
  useEffect(() => { if (disabled) stopWordPlayback() }, [disabled, stopWordPlayback])
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false; stopWordPlayback() }
  }, [stopWordPlayback])

  return { playWord, stopWordPlayback, playingWordIndex, wordPlaybackError, pronunciationSource }
}
