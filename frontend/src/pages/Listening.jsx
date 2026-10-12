import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ChevronLeft, Flag, Headphones, Loader2, Mic, Pause, Play, RotateCcw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { audioApi, markerApi } from '@/api'
import { bindListeningShortcuts, formatListeningTime, readMarkerTime, sentenceAtTime, reconcileMarkers, wordAtTime } from '@/lib/listening'

function readPending(storageKey) {
  try {
    const rows = JSON.parse(localStorage.getItem(storageKey) || '[]')
    return {
      rows: Array.isArray(rows) ? rows.filter(row => row.localId && Number.isFinite(row.time)).map(row => ({
        ...row, status: 'error', error: '这条标记尚未确认保存，请重试。',
      })) : [],
      error: '',
    }
  } catch {
    return { rows: [], error: '无法读取浏览器的待保存标记，请保持页面打开。' }
  }
}

// randomUUID requires HTTPS, while getRandomValues also works on LAN HTTP pages.
function newMarkerId() {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('此浏览器无法生成标记编号，请升级浏览器后重试。')
  }
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

const markerKey = marker => marker.localId ?? marker.id
const isTimedWord = word => typeof word?.word === 'string' && word.word.trim()
  && Number.isFinite(word.start) && Number.isFinite(word.end) && word.start >= 0 && word.end > word.start

export default function Listening() {
  const { audioFileId } = useParams()
  return <ListeningPlayer key={audioFileId} audioFileId={audioFileId} />
}

function ListeningPlayer({ audioFileId }) {
  const storageKey = `echoic.pendingMarkers.${audioFileId}`
  const [initialPending] = useState(() => readPending(storageKey))
  const [markers, setMarkers] = useState(initialPending.rows)
  const markersRef = useRef(initialPending.rows)
  const inFlightRef = useRef(new Set())
  const audioRef = useRef(null)
  const [audioFile, setAudioFile] = useState(null)
  const [loadError, setLoadError] = useState('')
  const [markersError, setMarkersError] = useState('')
  const [markersLoading, setMarkersLoading] = useState(true)
  const [storageError, setStorageError] = useState(initialPending.error)
  const [playerError, setPlayerError] = useState('')
  const [ready, setReady] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [speed, setSpeed] = useState(1)
  const [showText, setShowText] = useState(false)
  const [showMarkedWords, setShowMarkedWords] = useState(false)
  const [notice, setNotice] = useState('')
  const [noteDrafts, setNoteDrafts] = useState({})
  const [rowStatus, setRowStatus] = useState({})

  const updateMarkers = useCallback(update => {
    const next = update(markersRef.current)
    markersRef.current = next
    setMarkers(next)
    try {
      const pending = next.filter(marker => marker.status !== 'saved')
      localStorage.setItem(storageKey, JSON.stringify(pending))
      setStorageError('')
    } catch {
      setStorageError('浏览器暂存失败；未保存标记目前只在此页面，请重试保存后再关闭。')
    }
  }, [storageKey])

  const loadAudio = useCallback(async () => {
    setLoadError('')
    try {
      const { data } = await audioApi.get(audioFileId)
      setAudioFile(data)
    } catch {
      setLoadError('无法加载这份音频，请确认本地服务正在运行。')
    }
  }, [audioFileId])

  const loadMarkers = useCallback(async () => {
    setMarkersLoading(true)
    setMarkersError('')
    try {
      const { data } = await markerApi.list(audioFileId)
      updateMarkers(previous => reconcileMarkers(previous, data))
    } catch {
      setMarkersError('历史标记加载失败。新标记仍可记录，请重试加载。')
    } finally {
      setMarkersLoading(false)
    }
  }, [audioFileId, updateMarkers])

  useEffect(() => { loadAudio(); loadMarkers() }, [loadAudio, loadMarkers])
  useEffect(() => {
    if (audioRef.current) audioRef.current.playbackRate = speed
  }, [speed, audioFile])

  const persistMarker = useCallback(async localId => {
    if (inFlightRef.current.has(localId)) return
    const marker = markersRef.current.find(row => row.localId === localId && row.status !== 'saved')
    if (!marker) return
    inFlightRef.current.add(localId)
    updateMarkers(rows => rows.map(row => row.localId === localId ? { ...row, status: 'saving', error: '' } : row))
    try {
      const { data } = await markerApi.create(audioFileId, { time: marker.time, note: marker.note || '', client_id: localId })
      updateMarkers(rows => [...rows.filter(row => row.localId !== localId && row.id !== data.id), { ...data, localId, status: 'saved' }])
    } catch {
      updateMarkers(rows => rows.map(row => row.localId === localId ? {
        ...row, status: 'error', error: '无法确认保存成功，标记仍保留，请点重试。',
      } : row))
    } finally {
      inFlightRef.current.delete(localId)
    }
  }, [audioFileId, updateMarkers])

  const mark = useCallback(requestedTime => {
    const time = typeof requestedTime === 'number' ? Math.round(requestedTime * 1000) / 1000 : readMarkerTime(audioRef.current)
    if (time === null || !Number.isFinite(time) || time < 0) {
      setNotice('音频准备好后即可打标记。')
      return
    }
    let localId
    try {
      localId = newMarkerId()
    } catch (error) {
      setNotice(error.message)
      return
    }
    updateMarkers(rows => [...rows, { localId, time, note: '', created_at: new Date().toISOString(), status: 'saving' }])
    setNotice(`已标记 ${formatListeningTime(time)}，播放不受影响。`)
    persistMarker(localId)
  }, [persistMarker, updateMarkers])

  const togglePlayback = useCallback(() => {
    const audio = audioRef.current
    if (!audio || !ready) return
    if (audio.paused) {
      setPlayerError('')
      audio.play().catch(() => setPlayerError('播放失败，请点播放按钮重试。'))
    } else audio.pause()
  }, [ready])

  useEffect(() => bindListeningShortcuts(window, { mark, togglePlayback }), [mark, togglePlayback])
  const pendingCount = markers.filter(marker => marker.status !== 'saved').length
  useEffect(() => {
    if (!pendingCount) return
    function beforeUnload(event) { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [pendingCount])

  function replay(time, lead = 2) {
    const audio = audioRef.current
    if (!audio || !ready) return
    audio.currentTime = Math.max(0, time - lead)
    setPlayerError('')
    audio.play().catch(() => setPlayerError('回听失败，请点播放按钮重试。'))
  }

  async function saveNote(marker) {
    const key = markerKey(marker)
    const note = noteDrafts[key] ?? marker.note ?? ''
    if (marker.status !== 'saved') {
      updateMarkers(rows => rows.map(row => markerKey(row) === key ? { ...row, note } : row))
      setNotice('备注已暂存，点击重试即可连同标记保存。')
      return
    }
    setRowStatus(previous => ({ ...previous, [key]: { busy: true } }))
    try {
      const { data } = await markerApi.update(audioFileId, marker.id, { note })
      updateMarkers(rows => rows.map(row => markerKey(row) === key ? { ...row, ...data, note, status: 'saved' } : row))
      setRowStatus(previous => ({ ...previous, [key]: {} }))
      setNoteDrafts(previous => { const next = { ...previous }; delete next[key]; return next })
    } catch {
      setRowStatus(previous => ({ ...previous, [key]: { error: '备注保存失败，文字仍保留在输入框，请重试。' } }))
    }
  }

  async function deleteMarker(marker) {
    const key = markerKey(marker)
    if (marker.status !== 'saved') {
      updateMarkers(rows => rows.filter(row => markerKey(row) !== key))
      return
    }
    setRowStatus(previous => ({ ...previous, [key]: { busy: true } }))
    try {
      await markerApi.delete(audioFileId, marker.id)
      updateMarkers(rows => rows.filter(row => markerKey(row) !== key))
      setRowStatus(previous => ({ ...previous, [key]: {} }))
    } catch {
      setRowStatus(previous => ({ ...previous, [key]: { error: '删除失败，标记仍保留，请重试。' } }))
    }
  }

  const sentences = audioFile?.sentences ?? []
  const sortedMarkers = useMemo(() => [...markers].sort((left, right) => left.time - right.time), [markers])
  const markerWords = useMemo(() => new Map(markers.map(marker => [markerKey(marker), wordAtTime(sentences, marker.time)])), [markers, sentences])
  const markedWordKeys = useMemo(() => new Set([...markerWords.values()].filter(Boolean).map(word => word.sentence.index + ':' + word.wordIndex)), [markerWords])
  const hasWordTimes = sentences.some(sentence => sentence.words?.some(isTimedWord))
  const activeSentence = sentenceAtTime(sentences, currentTime)
  const practiceUrl = time => `/speaking/${audioFileId}?time=${time.toFixed(3)}`

  return (
    <div className="mx-auto w-full min-w-0 max-w-5xl space-y-5 px-4 py-4 md:space-y-6 md:py-5 md:px-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link to="/speaking" className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" /> 音频库
        </Link>
        <Link to={practiceUrl(currentTime)} className="inline-flex min-h-11 items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-muted">
          <Mic className="size-4" /> 去跟读对比
        </Link>
      </div>

      <header className="space-y-2">
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Headphones className="size-4" /> 第一遍 · 连续盲听</div>
        <h1 className="text-xl font-semibold break-words">{audioFile?.title || '加载音频中…'}</h1>
        <p className="text-sm text-muted-foreground">没听清时点“标记此刻”或按空格，记下这一刻，继续往下听。听完再逐处回听和跟读。</p>
      </header>

      {loadError && <div role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{loadError} <Button variant="outline" size="sm" onClick={loadAudio}>重试</Button></div>}

      <section aria-label="连续盲听播放器" className="space-y-5 rounded-xl border bg-card p-4 md:p-6">
        {audioFile && <audio
          ref={audioRef}
          src={audioApi.streamUrl(audioFileId)}
          preload="metadata"
          onLoadedMetadata={event => { setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0); setReady(true); setPlayerError('') }}
          onDurationChange={event => { if (Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration) }}
          onTimeUpdate={event => setCurrentTime(event.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onError={() => { setReady(false); setPlaying(false); setPlayerError('无法读取音频，请检查文件或刷新页面重试。') }}
        />}
        <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
          <div className="text-2xl sm:text-3xl font-medium tabular-nums" aria-label="当前播放时间">{formatListeningTime(currentTime)} <span className="text-sm text-muted-foreground">/ {formatListeningTime(duration)}</span></div>
          <span className="text-sm text-muted-foreground">{playing ? '连续播放中' : ready ? '已暂停' : '准备中'}</span>
        </div>
        <input
          aria-label="播放进度"
          type="range" min="0" max={duration || 0} step="0.1" value={Math.min(currentTime, duration || 0)} disabled={!ready}
          onChange={event => { const time = Number(event.target.value); if (audioRef.current) audioRef.current.currentTime = time; setCurrentTime(time) }}
          className="h-8 w-full accent-primary"
        />
        <div className="grid grid-cols-2 items-center gap-2 sm:flex sm:flex-wrap sm:gap-3">
          <Button size="lg" variant="outline" className="min-h-12 w-full sm:w-auto" onClick={togglePlayback} disabled={!ready} aria-label={playing ? '暂停 (P)' : '播放 (P)'}>
            {playing ? <Pause className="size-4" /> : <Play className="size-4" />} {playing ? '暂停' : '播放'} <kbd className="ml-1 hidden text-xs text-muted-foreground sm:inline">P</kbd>
          </Button>
          <Button size="lg" className="min-h-12 w-full sm:w-auto" onClick={mark} disabled={!ready}>
            <Flag className="size-4" /> 标记此刻 <kbd className="ml-1 hidden text-xs opacity-70 sm:inline">Space</kbd>
          </Button>
          <label className="col-span-2 flex items-center justify-end gap-2 text-sm text-muted-foreground sm:ml-auto">速度
            <select value={speed} onChange={event => setSpeed(Number(event.target.value))} className="rounded-md border bg-background px-2 py-1.5 text-foreground" aria-label="播放速度">
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map(value => <option key={value} value={value}>{value}×</option>)}
            </select>
          </label>
        </div>
        <div className="hidden space-y-1 text-xs leading-relaxed text-muted-foreground sm:block">
          <p><kbd>空格</kbd> / <kbd>M</kbd> / <kbd>;</kbd>：打标记，持续播放　·　<kbd>P</kbd>：播放 / 暂停</p>
          <p>快捷键仅在此盲听页生效。输入备注、选择速度或调整进度时不抢键；按住只记录一次。按钮可用 Enter 操作。</p>
        </div>
        <p role="status" aria-live="polite" className="min-h-5 text-sm text-muted-foreground">{notice}</p>
        {playerError && <p role="alert" className="text-sm text-destructive">{playerError}</p>}
      </section>

      <section className="space-y-3" aria-label="时间标记">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="font-medium">时间标记 <span className="ml-1 text-muted-foreground">{markers.length}</span></h2>
            <Button variant="outline" size="sm" onClick={() => setShowMarkedWords(value => !value)} aria-expanded={showMarkedWords}>
              {showMarkedWords ? '隐藏标记词' : '听完查看标记词'}
            </Button>
          </div>
          <span className="text-xs text-muted-foreground">{pendingCount ? `${pendingCount} 条尚未保存到本地服务` : '已保存到本地服务'} · 点击时间提前 2 秒回听</span>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">标记可定位到单词，第一遍默认隐藏。听完查看标记词及上下文；静音处可能显示附近词。词的时间来自自动转写，可能有偏差。</p>
        {storageError && <p role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{storageError}</p>}
        {markersError && <div role="alert" className="rounded-lg border border-destructive/30 p-3 text-sm text-destructive">{markersError} <Button size="sm" variant="outline" onClick={loadMarkers}>重试加载</Button></div>}
        {markersLoading && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> 正在加载标记…</p>}
        {!markersLoading && markers.length === 0 && <div className="rounded-lg border border-dashed p-7 text-center text-sm text-muted-foreground">还没有标记。播放音频后，遇到没听清的位置点“标记此刻”或按空格即可。</div>}
        <ol className="space-y-2">
          {sortedMarkers.map((marker, index) => {
            const key = markerKey(marker)
            const busy = marker.status === 'saving' || rowStatus[key]?.busy
            const draft = noteDrafts[key] ?? marker.note ?? ''
            const matchedWord = markerWords.get(key)
            const practiceTime = matchedWord ? (matchedWord.start + matchedWord.end) / 2 : marker.time
            return <li key={key} className="space-y-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-5 text-xs text-muted-foreground">{index + 1}</span>
                <button type="button" onClick={() => replay(marker.time)} className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 py-1 font-medium tabular-nums hover:bg-muted" title="提前 2 秒回听">
                  <Play className="size-3.5" /> {formatListeningTime(marker.time)}
                </button>
                <span className={`text-xs ${marker.status === 'error' ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {marker.status === 'saving' ? '保存中…' : marker.status === 'error' ? '未保存' : '已保存'}
                </span>
                {marker.status === 'error' && <Button size="sm" variant="outline" onClick={() => persistMarker(marker.localId)}><RotateCcw className="size-3" /> 重试</Button>}
                {sentences.length > 0 && <Link to={practiceUrl(practiceTime)} className="ml-auto inline-flex min-h-11 items-center text-xs hover:underline">跟读对应句子 →</Link>}
                <Button size="icon-sm" variant="ghost" disabled={busy} onClick={() => deleteMarker(marker)} aria-label={`删除 ${formatListeningTime(marker.time)} 标记`} className="text-muted-foreground hover:text-destructive"><Trash2 className="size-3.5" /></Button>
              </div>
              {showMarkedWords && (matchedWord ? <div className="space-y-2 rounded-md bg-muted/50 p-3" aria-label="标记的单词和上下文">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs text-muted-foreground">{matchedWord.match === 'exact' ? '对应单词' : '附近单词'}</span>
                  <strong className="text-sm">{matchedWord.word}</strong>
                  <span className="text-xs tabular-nums text-muted-foreground">{formatListeningTime(matchedWord.start, 2)}–{formatListeningTime(matchedWord.end, 2)}</span>
                  <Button variant="outline" size="sm" className="ml-auto" onClick={() => replay(matchedWord.start, 0.1)}>从该词回听</Button>
                </div>
                <p className="text-sm leading-relaxed">
                  {matchedWord.sentence.words.map((word, wordIndex) => <span key={wordIndex}>{wordIndex > 0 ? ' ' : ''}{wordIndex === matchedWord.wordIndex
                    ? <mark className="rounded bg-amber-200 px-0.5 text-amber-950">{word.word}</mark>
                    : word.word}</span>)}
                </p>
              </div> : <p className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">{hasWordTimes
                ? '此处没有足够接近的语音单词，保留时间标记。'
                : '暂无逐词时间轴。转写完成后刷新，即可查看对应单词；时间标记已保留。'}</p>)}
              <div className="flex flex-col gap-2 sm:flex-row">
                <input aria-label={`${formatListeningTime(marker.time)} 的备注`} maxLength={2000} value={draft} disabled={busy}
                  onChange={event => setNoteDrafts(previous => ({ ...previous, [key]: event.target.value }))}
                  placeholder="听完再写备注（可选）" className="min-w-0 flex-1 rounded-md border bg-background px-2.5 py-1.5 text-sm" />
                <Button variant="outline" size="sm" onClick={() => saveNote(marker)} disabled={busy || draft === (marker.note || '')}>保存备注</Button>
              </div>
              {(marker.error || rowStatus[key]?.error) && <p role="alert" className="text-xs text-destructive">{rowStatus[key]?.error || marker.error}</p>}
            </li>
          })}
        </ol>
      </section>

      <section className="space-y-3 rounded-lg border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium">原文默认隐藏</h2>
          <Button variant="ghost" size="sm" onClick={() => setShowText(value => !value)} aria-expanded={showText}>{showText ? '隐藏原文' : '听完查看原文'}</Button>
        </div>
        {showText && (sentences.length ? <div className="space-y-3 text-sm leading-relaxed">
          <p className="text-xs text-muted-foreground">点击单词可为该词新增标记，播放继续。按键稍慢时，可在这里点选目标词。</p>
          {sentences.map(sentence => <p key={sentence.index} className={activeSentence?.index === sentence.index ? 'rounded-md bg-muted p-2' : 'p-2 text-muted-foreground'}>
            <button type="button" onClick={() => replay(sentence.start + 2)} className="touch-inline mr-3 text-xs tabular-nums hover:underline">{formatListeningTime(sentence.start)}</button>
            {sentence.words?.length ? sentence.words.map((word, wordIndex) => <span key={wordIndex}>{wordIndex > 0 ? ' ' : ''}{isTimedWord(word)
              ? <button type="button" onClick={() => mark((word.start + word.end) / 2)}
                  aria-label={'标记单词 ' + word.word + '，第 ' + (sentence.index + 1) + ' 句第 ' + (wordIndex + 1) + ' 词'}
                  title="点击为这个单词新增标记，播放继续"
                  className={'touch-inline rounded px-0.5 text-left hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary '
                    + (markedWordKeys.has(sentence.index + ':' + wordIndex) ? 'bg-amber-200 text-amber-950' : '')}>{word.word}</button>
              : word.word}</span>) : sentence.text}
          </p>)}
        </div> : <p className="text-sm text-muted-foreground">还没有转写句子。你仍可以连续盲听和打时间标记；到音频库运行 ASR 后可逐句跟读。</p>)}
      </section>
    </div>
  )
}
