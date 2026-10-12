import { useEffect, useMemo, useRef, useState } from 'react'
import axios from 'axios'
import { Link } from 'react-router-dom'
import { Loader2, Sparkles, Settings2, RotateCcw, Play, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { comparisonTargets } from '@/lib/aiComparison'

const PROVIDERS = {
  tencent: '腾讯云口语评测', azure: 'Azure 发音评测', iflytek: '讯飞语音评测',
  openai: 'OpenAI 音频模型', gemini: 'Gemini 音频模型', qwen: '通义千问音频模型', local: '本地音频模型',
}
const SCORE_LABELS = [
  ['overall_score', '综合'], ['accuracy_score', '准确度'], ['fluency_score', '流利度'],
  ['completeness_score', '完整度'], ['prosody_score', '韵律'],
]
const EVIDENCE_LABELS = { measured: '音频检测', reference: '朗读建议', uncertain: '待确认' }
const ERROR_LABELS = { Mispronunciation: '发音偏差', Omission: '漏读', Insertion: '多读', UnknownWord: '未识别单词', UnexpectedBreak: '意外停顿', MissingBreak: '缺少停顿', Monotone: '语调单一' }
const isCancelled = error => axios.isCancel(error) || error?.name === 'AbortError' || error?.code === 'ERR_CANCELED'
const displayScore = value => typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : '—'
function errorMessage(error, fallback) {
  return typeof error?.response?.data?.detail === 'string' ? error.response.data.detail : fallback
}

function ComparisonPanel({ selection, selectedSentence, comparison }) {
  const [targetKey, setTargetKey] = useState('')
  const panelRef = useRef(null)
  const targets = useMemo(() => comparisonTargets(selection.text, selectedSentence), [selection.text, selectedSentence])
  const target = targets.length === 1 ? targets[0] : targets.find(item => item.key === targetKey)
  const disabled = !comparison || comparison.disabled
  const wholeSentence = { key: 'sentence', wholeSentence: true, text: selectedSentence?.text || '' }
  const active = comparison?.playing
  const stop = comparison?.stop

  useEffect(() => {
    const frame = requestAnimationFrame(() => panelRef.current?.scrollIntoView({ block: 'nearest' }))
    return () => cancelAnimationFrame(frame)
  }, [selection.id])

  function playbackButton(source, whole = false) {
    const playbackTarget = whole ? wholeSentence : target
    const label = whole ? source === 'original' ? '整句原音' : '整句录音' : source === 'original' ? '原音' : '我的录音'
    const playing = !!playbackTarget && active?.targetKey === playbackTarget.key && active?.source === source
    return <Button type="button" size="sm" variant={playing ? 'default' : 'outline'} aria-pressed={playing}
      disabled={disabled || comparison?.loading || !playbackTarget || (whole && !wholeSentence.text)}
      onClick={() => comparison?.play(playbackTarget, source)}>
      <Play className="size-3.5" />{label}
    </Button>
  }

  return (
    <div ref={panelRef} role="region" aria-label="原音与录音片段对比" className="space-y-3 rounded-lg border border-primary/20 bg-muted/30 p-3" data-testid="ai-comparison-panel">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="break-words text-sm font-medium">对比回听：{selection.text}</p>
        {(comparison?.loading || active) && <Button type="button" variant="ghost" size="sm" onClick={stop}><Square className="size-3.5" />停止</Button>}
      </div>
      {targets.length > 1 && <label className="block space-y-1 text-xs">
        <span className="text-muted-foreground">句中有多处相同内容，请选择出现位置</span>
        <select aria-label="回听出现位置" className="h-9 w-full rounded-md border border-input bg-background px-2" value={targetKey} disabled={disabled}
          onChange={event => { stop?.(); setTargetKey(event.target.value) }}>
          <option value="">请选择出现位置</option>
          {targets.map(item => <option key={item.key} value={item.key}>{item.label}</option>)}
        </select>
      </label>}
      {targets.length > 0 ? <div className="space-y-2">
        <div className="flex flex-wrap gap-2">{playbackButton('original')}{playbackButton('recording')}</div>
        <p className="text-[11px] text-muted-foreground">分别听同一位置的原音与跟读录音；请结合回听判断 AI 的提示。单词位置为自动定位；漏读或含混时可回听整句确认。</p>
      </div> : <p className="text-xs leading-relaxed text-muted-foreground">这段文字未匹配到参考句子，无法定位单词或短语。可以先回听整句。</p>}
      <div className="flex flex-wrap gap-2">{playbackButton('original', true)}{playbackButton('recording', true)}</div>
      {comparison?.loading && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />正在准备回听片段…</p>}
      {active && !comparison?.loading && <p role="status" className="text-[11px] text-muted-foreground">正在播放{active.source === 'original' ? '原音' : '我的录音'}</p>}
      {comparison?.error && <p role="alert" className="whitespace-pre-wrap break-words text-xs text-destructive">{comparison.error}</p>}
      {disabled && <p className="text-[11px] text-muted-foreground">录音或评分结束后可以对比回听。</p>}
    </div>
  )
}

function AnalysisResult({ result, selectedSentence, comparison }) {
  const [selection, setSelection] = useState(null)
  const stop = comparison?.stop
  useEffect(() => () => stop?.(), [stop])
  function selectIssue(id, text) {
    stop?.()
    setSelection({ id, text })
  }
  const isFeedback = result.kind !== 'assessment'
  const scores = SCORE_LABELS.filter(([field]) => typeof result[field] === 'number' && Number.isFinite(result[field]))
  const words = Array.isArray(result.words) ? result.words : []
  const connectedSpeech = Array.isArray(result.connected_speech) ? result.connected_speech : []
  const limitations = Array.isArray(result.limitations) ? result.limitations : []
  return (
    <div className="min-w-0 break-words space-y-4 rounded-lg border border-border/50 p-4" data-testid="ai-analysis-result">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">{PROVIDERS[result.provider] || result.provider} · {isFeedback ? 'AI 参考反馈' : '专用发音评测'}</p>
        {result.created_at && <time className="text-[11px] text-muted-foreground">{new Date(result.created_at).toLocaleString('zh-CN')}</time>}
      </div>
      {scores.length > 0 && <div>
        <div className="flex flex-wrap gap-x-6 gap-y-3">{scores.map(([field, label]) => <div key={field} className="space-y-0.5">
          <p className="text-xl font-semibold tabular-nums">{displayScore(result[field])}</p>
          <p className="text-[11px] text-muted-foreground">{label}{isFeedback ? '参考分' : ''}</p>
        </div>)}</div>
        {isFeedback && <p className="mt-2 text-[11px] text-muted-foreground">模型给出的参考分尚未校准，不能换算为雅思分数。</p>}
      </div>}
      {result.feedback && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{result.feedback}</p>}
      {selection && <ComparisonPanel key={selection.id} selection={selection} selectedSentence={selectedSentence} comparison={comparison} />}
      {words.length > 0 && <div>
        <p className="mb-2 text-xs font-medium">单词评测 · 词分</p>
        <div className="flex flex-wrap gap-2">{words.map((word, index) => <button key={index} type="button" aria-label={`对比回听：${word.word}`} aria-pressed={selection?.id === `word-${index}`}
          disabled={comparison?.disabled} onClick={() => selectIssue(`word-${index}`, word.word)}
          className={`inline-flex max-w-full flex-wrap items-center gap-2 rounded-md border px-2 py-1 text-xs transition-colors hover:bg-accent disabled:opacity-50 ${selection?.id === `word-${index}` ? 'border-primary bg-accent' : 'border-transparent bg-muted'}`}>
          <span>{word.word}</span><span className="tabular-nums text-muted-foreground">{displayScore(word.accuracy_score ?? word.overall_score)}</span>
        </button>)}</div>
        <details className="mt-3 rounded-md border border-border/30 p-2">
          <summary className="cursor-pointer text-xs font-medium">单词详情与纠音建议</summary>
          <div className="mt-3 space-y-3">
            {words.map((word, index) => <div key={index} className="space-y-1 border-t border-border/30 pt-2 text-xs first:border-t-0 first:pt-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">{word.word} · 词分 {displayScore(word.accuracy_score ?? word.overall_score)}</p>
                <button type="button" className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline disabled:opacity-50" aria-label={`回听单词：${word.word}`} disabled={comparison?.disabled} onClick={() => selectIssue(`word-${index}`, word.word)}><Play className="size-3" />对比回听</button>
              </div>
              {word.error_type && !['None', 'Unknown'].includes(word.error_type) && <p className="text-muted-foreground">错误提示：{ERROR_LABELS[word.error_type] || word.error_type}</p>}
              {word.expected_phonemes && <p className="break-words text-muted-foreground">参考音素：{word.expected_phonemes}</p>}
              {word.actual_phonemes && <p className="break-words text-muted-foreground">{isFeedback ? '模型推测音素' : '接口返回音素'}：{word.actual_phonemes}</p>}
              {word.feedback && <p className="whitespace-pre-wrap break-words leading-relaxed">{word.feedback}</p>}
              {Array.isArray(word.phoneme_scores) && word.phoneme_scores.length > 0 && <div className="flex flex-wrap gap-2 pt-1">
                {word.phoneme_scores.map((phone, phoneIndex) => <span key={phoneIndex} className="rounded bg-muted px-2 py-1 text-[11px]">{phone.phoneme} · {displayScore(phone.score)}</span>)}
              </div>}
            </div>)}
          </div>
        </details>
      </div>}
      {connectedSpeech.length > 0 && <div className="space-y-2">
        <p className="text-xs font-medium">连读、弱读与语流</p>
        {connectedSpeech.map((item, index) => <div key={index} className="space-y-1 rounded-md bg-muted/50 p-3">
          <div className="flex flex-wrap items-center gap-2">
            {item.text ? <button type="button" className="max-w-full break-words text-left text-sm font-medium text-primary underline decoration-primary/30 underline-offset-4 hover:decoration-primary disabled:opacity-50" aria-label={`对比回听：${item.text}`} aria-pressed={selection?.id === `phrase-${index}`} disabled={comparison?.disabled} onClick={() => selectIssue(`phrase-${index}`, item.text)}>{item.text}</button> : <span className="text-sm font-medium">{item.category || '语流反馈'}</span>}
            {item.text && item.category && <span className="text-[11px] text-muted-foreground">{item.category}</span>}
            <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">{EVIDENCE_LABELS[item.evidence] || EVIDENCE_LABELS.uncertain}</span>
          </div>
          {item.observation && <p className="whitespace-pre-wrap break-words text-xs leading-relaxed">{item.observation}</p>}
          {item.suggestion && <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-muted-foreground">练习建议：{item.suggestion}</p>}
        </div>)}
      </div>}
      {limitations.length > 0 && <div className="space-y-1 border-t border-border/30 pt-3 text-[11px] leading-relaxed text-muted-foreground">
        <p className="font-medium">本次评测的限制</p>
        {limitations.map((item, index) => <p key={index} className="whitespace-pre-wrap break-words">{item}</p>)}
      </div>}
    </div>
  )
}

export default function AIRecordingAnalysis({ recordId, disabled = false, selectedSentence, comparison }) {
  const [settings, setSettings] = useState(null)
  const [settingsError, setSettingsError] = useState('')
  const [settingsReload, setSettingsReload] = useState(0)
  const [stored, setStored] = useState({ recordId: null, items: [] })
  const [selectedAnalysisId, setSelectedAnalysisId] = useState(null)
  const [historyError, setHistoryError] = useState('')
  const [historyReload, setHistoryReload] = useState(0)
  const [request, setRequest] = useState({ recordId: null, busy: false, error: '' })
  const recordRef = useRef(recordId)
  const requestRevision = useRef(0)
  const historyController = useRef(null)
  const analysisController = useRef(null)
  recordRef.current = recordId

  useEffect(() => {
    const controller = new AbortController()
    setSettingsError('')
    axios.get('/api/ai/settings', { signal: controller.signal, timeout: 15000 }).then(({ data }) => {
      if (!controller.signal.aborted) setSettings(data)
    }).catch(error => { if (!controller.signal.aborted && !isCancelled(error)) setSettingsError(errorMessage(error, '无法读取 AI 设置，请重试。')) })
    return () => controller.abort()
  }, [settingsReload])

  useEffect(() => {
    const revision = ++requestRevision.current
    analysisController.current?.abort()
    historyController.current?.abort()
    setRequest({ recordId, busy: false, error: '' })
    setHistoryError('')
    setSelectedAnalysisId(null)
    setStored(previous => previous.recordId === recordId ? previous : { recordId, items: [] })
    if (!recordId) return
    const controller = new AbortController()
    historyController.current = controller
    axios.get('/api/ai/records/' + recordId + '/analyses', { signal: controller.signal, timeout: 15000 }).then(({ data }) => {
      if (controller.signal.aborted || recordRef.current !== recordId || requestRevision.current !== revision) return
      setStored({ recordId, items: Array.isArray(data) ? data : [] })
    }).catch(error => {
      if (!isCancelled(error) && recordRef.current === recordId && requestRevision.current === revision) setHistoryError(errorMessage(error, '无法读取这条录音的 AI 分析记录。'))
    })
    return () => { controller.abort(); analysisController.current?.abort(); requestRevision.current++ }
  }, [recordId, historyReload])

  const provider = settings?.analysis_provider || ''
  const isFeedback = !['tencent', 'azure', 'iflytek'].includes(provider)
  const providerConfig = settings?.providers?.[provider]
  const configured = providerConfig?.configured === true
  const busy = request.recordId === recordId && request.busy
  const error = request.recordId === recordId ? request.error : ''
  const analyses = stored.recordId === recordId ? stored.items : []
  const selectedAnalysis = analyses.find(item => item.id === selectedAnalysisId) || analyses[0]

  async function analyze() {
    if (!recordId || busy || disabled || !settings?.enabled || !configured) return
    historyController.current?.abort()
    analysisController.current?.abort()
    const controller = new AbortController()
    analysisController.current = controller
    const revision = ++requestRevision.current
    const targetRecordId = recordId
    setRequest({ recordId: targetRecordId, busy: true, error: '' })
    setHistoryError('')
    try {
      const { data } = await axios.post('/api/ai/records/' + targetRecordId + '/analyze', {}, { signal: controller.signal, timeout: 240000 })
      if (controller.signal.aborted || recordRef.current !== targetRecordId || requestRevision.current !== revision) return
      setStored(previous => ({ recordId: targetRecordId, items: [data, ...(previous.recordId === targetRecordId ? previous.items : []).filter(item => item.id !== data.id)] }))
      setSelectedAnalysisId(data.id)
      setRequest({ recordId: targetRecordId, busy: false, error: '' })
    } catch (failure) {
      if (controller.signal.aborted || recordRef.current !== targetRecordId || requestRevision.current !== revision) return
      setRequest({ recordId: targetRecordId, busy: false, error: errorMessage(failure, '分析失败，请检查默认服务配置后重试。') })
    }
  }

  return (
    <div className="min-w-0 space-y-4 px-3 py-4 sm:px-5" data-testid="ai-recording-analysis">
      <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-3">
        <p className="flex items-center gap-2 text-sm font-medium"><Sparkles className="size-4" />AI 录音分析</p>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <button type="button" className="inline-flex min-h-11 items-center gap-1 text-xs text-muted-foreground hover:text-foreground sm:min-h-0 disabled:opacity-50" disabled={busy} onClick={() => setSettingsReload(value => value + 1)}><RotateCcw className="size-3" />刷新配置</button>
          <Link to="/settings" className="inline-flex min-h-11 items-center gap-1 text-xs text-muted-foreground hover:text-foreground sm:min-h-0"><Settings2 className="size-3.5" />AI 设置</Link>
        </div>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">点击 AI 分析，将当前选择的跟读录音和参考文本发送到设置中的默认服务。结果会保存在这条录音下，单次录音最长 60 秒。</p>
      {!recordId && <p className="rounded-md bg-muted/50 p-3 text-sm">请先录一段跟读，或在上方选择一条已有录音。</p>}
      {settingsError && <div className="flex flex-wrap items-center gap-2 text-xs"><p role="alert" className="text-destructive">{settingsError}</p><Button type="button" variant="outline" size="sm" onClick={() => setSettingsReload(value => value + 1)}><RotateCcw className="size-3" />重试读取设置</Button></div>}
      {!settings && !settingsError && <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />正在读取 AI 设置…</p>}
      {settings && <div className="space-y-3 rounded-lg border border-border/40 p-3">
        {!settings.enabled && <p className="text-xs text-muted-foreground">AI 分析尚未开启。请在 <Link to="/settings" className="text-primary underline underline-offset-2">设置</Link> 中开启并填写服务配置。</p>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm">默认服务：<span className="font-medium">{PROVIDERS[provider] || provider || '尚未选择'}</span></p>
            <p className="text-[11px] text-muted-foreground">{provider ? isFeedback ? 'AI 参考反馈 · 发音、连读与练习建议' : '专用发音评测 · 以服务返回的评分指标为准' : '请在 AI 设置中选择默认服务。'}</p>
          </div>
          <Button type="button" size="sm" className="h-9" disabled={!recordId || busy || disabled || !settings.enabled || !configured} onClick={analyze}>{busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}{busy ? '分析中…' : 'AI 分析'}</Button>
        </div>
        {!configured && <p className="text-[11px] text-muted-foreground">此服务尚未完成配置。<Link to="/settings" className="text-primary underline underline-offset-2">前往设置</Link>{Array.isArray(providerConfig?.errors) && providerConfig.errors.length > 0 ? '：' + providerConfig.errors.join('；') : ''}</p>}
        {disabled && recordId && <p className="text-[11px] text-muted-foreground">请先停止播放，或完成当前录音与本地评测。</p>}
        {busy && <p role="status" className="text-[11px] text-muted-foreground">正在分析录音…</p>}
        {error && <p role="alert" className="whitespace-pre-wrap break-words text-xs text-destructive">{error}</p>}
      </div>}
      {historyError && stored.recordId === recordId && <div className="flex flex-wrap items-center gap-2 text-xs"><p role="alert" className="text-destructive">{historyError}</p><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => setHistoryReload(value => value + 1)}>重试读取记录</Button></div>}
      {analyses.length > 1 && <label className="block space-y-1 text-xs"><span className="text-muted-foreground">已保存的分析</span><select aria-label="已保存的分析" className="h-9 w-full rounded-md border border-input bg-background px-2" value={selectedAnalysis?.id ?? ''} onChange={event => setSelectedAnalysisId(analyses.find(item => String(item.id) === event.target.value)?.id ?? null)}>{analyses.map(item => <option key={item.id} value={item.id}>{PROVIDERS[item.provider] || item.provider} · {item.kind === 'assessment' ? '专用评测' : 'AI 反馈'} · {new Date(item.created_at).toLocaleString('zh-CN')}</option>)}</select></label>}
      {selectedAnalysis && <><p className="text-[11px] text-muted-foreground">已保存在当前录音下</p><AnalysisResult key={`${recordId}-${selectedAnalysis.id}`} result={selectedAnalysis} selectedSentence={selectedSentence} comparison={comparison ? { ...comparison, disabled: comparison.disabled || busy } : comparison} /></>}
    </div>
  )
}
