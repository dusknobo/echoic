import { useEffect, useRef, useState } from 'react'
import axios from 'axios'
import { CheckCircle2, ChevronDown, ExternalLink, Loader2, Save, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

const api = axios.create({ baseURL: '/api', timeout: 15000 })
const SECRET_FIELDS = ['api_key', 'secret_key', 'api_secret']
const PROVIDERS = [
  { id: 'tencent', name: '腾讯云口语评测', description: '专用口语评测：发音、流利度与连读等语音现象。', docs: 'https://cloud.tencent.com/document/product/1774/107342', fields: ['app_id', 'secret_id', 'secret_key', 'endpoint', 'language'], required: ['app_id', 'secret_id', 'secret_key'] },
  { id: 'azure', name: 'Azure 发音评估', description: '专用口语评测：音素、单词及韵律评分；韵律评估限美式英语。', docs: 'https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-pronunciation-assessment', fields: ['api_key', 'region', 'language', 'endpoint'], required: ['api_key'] },
  { id: 'iflytek', name: '讯飞语音评测', description: '英语朗读评测，提供单词、音节及句子的发音反馈。', docs: 'https://www.xfyun.cn/doc/voiceservice/ise/ise_protocol.html', fields: ['app_id', 'api_key', 'api_secret', 'endpoint', 'language'], required: ['app_id', 'api_key', 'api_secret'] },
  { id: 'openai', name: 'OpenAI 音频模型', description: '使用支持音频输入的模型分析录音，生成纠音与连读建议。', docs: 'https://developers.openai.com/api/docs/guides/audio-chat-completions', fields: ['api_key', 'endpoint', 'model'], required: ['api_key', 'endpoint', 'model'], feedback: true },
  { id: 'gemini', name: 'Google Gemini', description: '通过音频理解模型分析录音，生成发音与连读反馈。', docs: 'https://ai.google.dev/gemini-api/docs/audio', fields: ['api_key', 'endpoint', 'model'], required: ['api_key', 'endpoint', 'model'], feedback: true },
  { id: 'qwen', name: '通义千问 Qwen Omni', description: '使用阿里云音频模型，生成中文纠音和连读练习建议。', docs: 'https://help.aliyun.com/zh/model-studio/qwen-omni', fields: ['api_key', 'endpoint', 'model'], required: ['api_key', 'endpoint', 'model'], feedback: true },
  { id: 'local', name: '本地音频模型 / 兼容接口', description: '连接你自行运行的 Qwen3-Omni 等音频模型服务，需要支持音频输入的兼容接口。', docs: 'https://github.com/QwenLM/Qwen3-Omni', fields: ['endpoint', 'model', 'api_key'], required: ['endpoint', 'model'], feedback: true },
]
const FIELD_LABELS = { app_id: 'App ID', secret_id: 'Secret ID', secret_key: 'Secret Key', api_key: 'API Key', api_secret: 'API Secret', endpoint: '接口地址', model: '模型名称', region: '服务区域', language: '评测语言' }

function normalizeSettings(data) {
  const source = data?.settings || data || {}
  return {
    enabled: Boolean(source.enabled),
    analysis_provider: [source.analysis_provider, source.feedback_provider, 'qwen'].find(id => PROVIDERS.some(provider => provider.id === id)),
    providers: Object.fromEntries(PROVIDERS.map(provider => {
      const sourceProvider = source.providers?.[provider.id] || {}
      const fields = Object.fromEntries(provider.fields.filter(field => !SECRET_FIELDS.includes(field)).map(field => [field, sourceProvider[field] || '']))
      for (const field of SECRET_FIELDS) fields[field + '_set'] = Boolean(sourceProvider[field + '_set'])
      fields.configured = Boolean(sourceProvider.configured)
      fields.errors = Array.isArray(sourceProvider.errors) ? sourceProvider.errors.filter(item => typeof item === 'string') : []
      return [provider.id, fields]
    })),
  }
}

function isConfigured(provider, config) {
  return Boolean(config?.configured)
}

function errorText(error, fallback) {
  const detail = error?.response?.data?.detail
  return typeof detail === 'string' ? detail : fallback
}

export default function AISettings() {
  const [settings, setSettings] = useState(null)
  const [savedSettings, setSavedSettings] = useState(null)
  const [secretDrafts, setSecretDrafts] = useState({})
  const [clearedSecrets, setClearedSecrets] = useState({})
  const [expanded, setExpanded] = useState({})
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [validation, setValidation] = useState({})
  const [reload, setReload] = useState(0)
  const requests = useRef(new Set())
  const mounted = useRef(false)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      for (const controller of requests.current) controller.abort()
      requests.current.clear()
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    api.get('/ai/settings', { signal: controller.signal }).then(({ data }) => {
      const next = normalizeSettings(data)
      setSettings(next)
      setSavedSettings(next)
      setExpanded({ [next.analysis_provider]: true })
    }).catch(err => {
      if (!controller.signal.aborted) setError(errorText(err, 'AI 设置加载失败，请重试。'))
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false)
    })
    return () => controller.abort()
  }, [reload])

  function providerChanged(id) {
    return JSON.stringify(settings?.providers[id]) !== JSON.stringify(savedSettings?.providers[id]) ||
      Object.values(secretDrafts[id] || {}).some(value => value.trim()) || (clearedSecrets[id] || []).length > 0
  }

  const dirty = settings && (settings.enabled !== savedSettings?.enabled || settings.analysis_provider !== savedSettings?.analysis_provider ||
    PROVIDERS.some(provider => providerChanged(provider.id)))

  function resetMessages() {
    setError('')
    setNotice('')
    setValidation({})
  }

  function update(patch) {
    resetMessages()
    setSettings(prev => ({ ...prev, ...patch }))
  }

  function updateField(id, field, value) {
    resetMessages()
    if (SECRET_FIELDS.includes(field)) {
      setSecretDrafts(prev => ({ ...prev, [id]: { ...prev[id], [field]: value } }))
      setClearedSecrets(prev => ({ ...prev, [id]: (prev[id] || []).filter(item => item !== field) }))
    } else {
      setSettings(prev => ({ ...prev, providers: { ...prev.providers, [id]: { ...prev.providers[id], [field]: value } } }))
    }
  }

  function toggleClear(id, field) {
    resetMessages()
    setSecretDrafts(prev => ({ ...prev, [id]: { ...prev[id], [field]: '' } }))
    setClearedSecrets(prev => ({ ...prev, [id]: (prev[id] || []).includes(field) ? prev[id].filter(item => item !== field) : [...(prev[id] || []), field] }))
  }

  async function save() {
    const providers = {}
    for (const provider of PROVIDERS) {
      const patch = {}
      for (const field of provider.fields) {
        if (SECRET_FIELDS.includes(field)) {
          const value = secretDrafts[provider.id]?.[field]?.trim()
          if (value) patch[field] = value
        } else if (settings.providers[provider.id][field] !== savedSettings.providers[provider.id][field]) {
          patch[field] = settings.providers[provider.id][field].trim()
        }
      }
      if (clearedSecrets[provider.id]?.length) patch.clear_secrets = clearedSecrets[provider.id]
      if (Object.keys(patch).length) providers[provider.id] = patch
    }
    const controller = new AbortController()
    requests.current.add(controller)
    setSaving(true)
    resetMessages()
    try {
      const { data } = await api.put('/ai/settings', { enabled: settings.enabled, analysis_provider: settings.analysis_provider, providers }, { signal: controller.signal })
      if (!mounted.current || controller.signal.aborted) return
      const next = normalizeSettings(data)
      setSettings(next)
      setSavedSettings(next)
      setSecretDrafts({})
      setClearedSecrets({})
      setNotice('AI 设置已保存。')
    } catch (err) {
      if (mounted.current && !controller.signal.aborted) setError(errorText(err, 'AI 设置保存失败，请重试。'))
    } finally {
      requests.current.delete(controller)
      if (mounted.current && !controller.signal.aborted) setSaving(false)
    }
  }

  async function checkProvider(id) {
    const controller = new AbortController()
    requests.current.add(controller)
    setChecking(id)
    setError('')
    try {
      const { data } = await api.post('/ai/providers/' + id + '/validate', null, { signal: controller.signal })
      if (!mounted.current || controller.signal.aborted) return
      const errors = data.errors || data.missing_fields || []
      const valid = data.valid ?? data.configured ?? false
      setValidation(prev => ({ ...prev, [id]: { valid, message: data.message || (valid ? '必填配置完整。此检查不验证密钥有效性或模型访问权限。' : '配置不完整：' + (Array.isArray(errors) ? errors.filter(item => typeof item === 'string').join('、') : '请检查必填项')) } }))
    } catch (err) {
      if (mounted.current && !controller.signal.aborted) setValidation(prev => ({ ...prev, [id]: { valid: false, message: errorText(err, '配置检查失败，请重试。') } }))
    } finally {
      requests.current.delete(controller)
      if (mounted.current && !controller.signal.aborted) setChecking(null)
    }
  }

  return (
    <section className="mb-8 min-w-0" aria-labelledby="ai-settings-heading">
      <h2 id="ai-settings-heading" className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">AI 分析</h2>
      {loading ? (
        <div className="rounded-lg border border-border/60 p-4 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />加载 AI 设置…</div>
      ) : !settings ? (
        <div className="rounded-lg border border-border/60 p-4 space-y-3">
          <p role="alert" className="break-words text-sm text-destructive">{error}</p>
          <Button type="button" variant="outline" onClick={() => setReload(value => value + 1)}>重试</Button>
        </div>
      ) : (
        <div className="min-w-0 rounded-lg border border-border/60 p-3 sm:p-4 space-y-5">
          <div className="flex items-start justify-between gap-3 sm:items-center sm:gap-4">
            <div className="min-w-0">
              <Label id="ai-enabled-label" htmlFor="ai-enabled">启用 AI 分析</Label>
              <p className="text-xs text-muted-foreground mt-1">录音后手动发起分析，不会自动上传录音。</p>
            </div>
            <Switch id="ai-enabled" aria-labelledby="ai-enabled-label" checked={settings.enabled} onCheckedChange={enabled => update({ enabled })} disabled={saving || Boolean(checking)} />
          </div>
          <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground leading-relaxed flex gap-2">
            <ShieldCheck className="size-4 shrink-0 mt-0.5" />
            <p>密钥保存到本机后端，并由当前 Windows 用户加密保护，页面只显示是否已设置。使用云服务分析时，录音及参考文本会发送给所选服务商；本地接口则发送到你配置的地址。</p>
          </div>
          <div className="space-y-1.5 min-w-0">
            <Label htmlFor="ai-analysis_provider">默认分析服务</Label>
            <select id="ai-analysis_provider" value={settings.analysis_provider} onChange={event => { update({ analysis_provider: event.target.value }); setExpanded(prev => ({ ...prev, [event.target.value]: true })) }} disabled={saving || Boolean(checking)} className="h-11 sm:h-9 w-full min-w-0 rounded-md border border-input bg-background px-2 text-sm">
              {PROVIDERS.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
            </select>
            <p className="text-xs text-muted-foreground leading-relaxed">在“我的练习”点击“AI 分析”时使用此服务，分析结果会随录音保存。</p>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed">专用评测服务提供细分评分；音频大模型的发音分数与连读判断仅供练习参考。模型名称需填写支持音频输入的型号。</p>
          <div className="min-w-0 divide-y divide-border/50 rounded-md border border-border/60">
            {PROVIDERS.map(provider => {
              const config = settings.providers[provider.id]
              const configured = isConfigured(provider, savedSettings.providers[provider.id])
              const changed = providerChanged(provider.id)
              return (
                <div key={provider.id} data-ai-provider={provider.id}>
                  <button type="button" aria-expanded={Boolean(expanded[provider.id])} aria-controls={'ai-provider-' + provider.id} onClick={() => setExpanded(prev => ({ ...prev, [provider.id]: !prev[provider.id] }))} className="w-full flex items-center gap-2 p-3 text-left hover:bg-muted/30 rounded-md">
                    <span className="text-sm font-medium flex-1 min-w-0 break-words">{provider.name}</span>
                    <span className={'text-[11px] shrink-0 ' + (changed ? 'text-amber-600 dark:text-amber-400' : configured ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')}>{changed ? '未保存' : configured ? '已配置' : '未配置'}</span>
                    <ChevronDown className={'size-4 shrink-0 text-muted-foreground transition-transform ' + (expanded[provider.id] ? 'rotate-180' : '')} />
                  </button>
                  {expanded[provider.id] && (
                    <div id={'ai-provider-' + provider.id} className="min-w-0 px-3 pb-4 space-y-3">
                      <p className="text-xs text-muted-foreground leading-relaxed">{provider.description}</p>
                      <a href={provider.docs} target="_blank" rel="noopener noreferrer" className="inline-flex gap-1 items-center text-xs text-primary hover:underline">官方接口文档<ExternalLink className="size-3" /></a>
                      {provider.fields.map(field => {
                        const secret = SECRET_FIELDS.includes(field)
                        const hasSecret = config[field + '_set']
                        const clearing = (clearedSecrets[provider.id] || []).includes(field)
                        const id = 'ai-' + provider.id + '-' + field
                        return (
                          <div key={field} className="space-y-1.5">
                            <Label htmlFor={id} className="flex flex-wrap gap-x-1 gap-y-0.5">{FIELD_LABELS[field]}{provider.id === 'azure' && field === 'region' && <span className="text-muted-foreground text-xs ml-1">与接口地址至少填一项</span>}{provider.required.includes(field) && <span className="text-muted-foreground text-xs ml-1">必填</span>}</Label>
                            <div className="flex gap-2 items-center min-w-0">
                              <Input id={id} type={secret ? 'password' : 'text'} autoComplete={secret ? 'new-password' : 'off'} spellCheck={false} value={secret ? secretDrafts[provider.id]?.[field] || '' : config[field]} onChange={event => updateField(provider.id, field, event.target.value)} disabled={saving || Boolean(checking)} placeholder={secret ? (clearing ? '保存后清除密钥' : hasSecret ? '已保存；留空保持不变' : '输入密钥') : field === 'endpoint' ? '使用默认地址或填写完整接口地址' : field === 'region' ? '例如 eastasia' : field === 'language' ? '例如 en-US' : field === 'model' ? '支持音频输入的模型名称' : ''} className="min-w-0 flex-1 text-sm" />
                              {secret && hasSecret && <Button type="button" variant={clearing ? 'secondary' : 'outline'} size="sm" className="shrink-0" onClick={() => toggleClear(provider.id, field)} disabled={saving || Boolean(checking)}>{clearing ? '撤销清除' : '清除'}</Button>}
                            </div>
                            {secret && <p className="text-[11px] text-muted-foreground">{clearing ? '密钥将在保存设置后清除。' : hasSecret ? '已有密钥。填写新值可替换；留空保留原值。' : provider.id === 'local' ? '可选，仅在本地服务启用鉴权时填写。' : '保存后不会再显示密钥内容。'}</p>}
                          </div>
                        )
                      })}
                      <div className="space-y-2 pt-1">
                        <Button type="button" variant="outline" size="sm" onClick={() => checkProvider(provider.id)} disabled={saving || Boolean(checking) || Boolean(dirty)}>
                          {checking === provider.id ? <Loader2 className="size-3.5 animate-spin" /> : <CheckCircle2 className="size-3.5" />}检查配置
                        </Button>
                        <p className="text-[11px] text-muted-foreground">{dirty ? '请先保存更改，再检查配置。' : '只检查必填项，不发送录音、不调用付费接口。'}</p>
                        {validation[provider.id] && <p role="status" className={'text-xs leading-relaxed ' + (validation[provider.id].valid ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive')}>{validation[provider.id].message}</p>}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <Button type="button" onClick={save} disabled={saving || Boolean(checking) || !dirty}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}{saving ? '保存中…' : '保存 AI 设置'}
            </Button>
            {dirty && <span className="text-xs text-muted-foreground">有未保存的更改</span>}
            {notice && <p role="status" className="text-xs text-emerald-600 dark:text-emerald-400">{notice}</p>}
          </div>
          {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
        </div>
      )}
    </section>
  )
}
