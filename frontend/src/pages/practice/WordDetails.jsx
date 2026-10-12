import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Volume2, X, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { dictionaryApi } from '@/api'
import { normalizeStudyWord } from '@/lib/wordStudy'

const entryCache = new Map()

export default function WordDetails({ word, onPronounce, onClose, playing, pronunciationSource, playbackError, pronunciationDisabled }) {
  const { t } = useTranslation()
  const [entry, setEntry] = useState(null)
  const [loading, setLoading] = useState(true)
  const [lookupError, setLookupError] = useState(null)
  const [attempt, setAttempt] = useState(0)
  const [expanded, setExpanded] = useState(false)
  const query = normalizeStudyWord(word.text)

  useEffect(() => {
    const controller = new AbortController()
    setEntry(null)
    setLookupError(null)
    setExpanded(false)
    if (!query) { setLookupError('wordNotFound'); setLoading(false); return }
    if (entryCache.has(query)) {
      setEntry(entryCache.get(query)); setLoading(false); return
    }
    setLoading(true)
    dictionaryApi.lookup(query, { signal: controller.signal }).then(({ data }) => {
      if (controller.signal.aborted) return
      if (entryCache.size >= 256) entryCache.delete(entryCache.keys().next().value)
      entryCache.set(query, data)
      setEntry(data)
    }).catch(error => {
      if (controller.signal.aborted) return
      setLookupError(error.response?.status === 404 || error.response?.status === 422 ? 'wordNotFound' : 'wordLookupFailed')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [query, attempt])

  const hasMore = entry?.meanings?.some(meaning => meaning.definitions.length > 3)
  return (
    <section aria-label={t('practice.wordDetails')} className="mt-3 rounded-lg border border-border bg-muted/20 p-3">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
        <div className="min-w-0">
          <h3 className="break-words text-lg font-semibold">{query || word.text}</h3>
          {word.ipa && <p className="font-[family-name:var(--font-ipa)] text-sm text-muted-foreground">{word.ipa}</p>}
          {entry?.word && entry.word !== query && <p className="mt-0.5 text-xs text-muted-foreground">{t('practice.wordBaseForm', { word: entry.word })}</p>}
        </div>
        <div className="flex w-full shrink-0 items-center justify-between gap-1 sm:w-auto sm:justify-start">
          <Button variant="outline" size="sm" disabled={pronunciationDisabled} onClick={onPronounce}>
            <Volume2 className={`size-4 ${playing ? 'text-primary' : ''}`} />
            {t('practice.listenWord')}
          </Button>
          <Button variant="ghost" size="icon" className="size-11 sm:size-7" onClick={onClose} aria-label={t('practice.closeWordDetails')}>
            <X className="size-4" />
          </Button>
        </div>
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        {pronunciationDisabled ? t('practice.wordRecordingHint') : pronunciationSource === 'original' ? t('practice.wordOriginalVoice') : pronunciationSource === 'speech' ? t('practice.wordSynthVoice') : t('practice.wordVoiceHint')}
      </p>
      {playbackError && <p role="alert" className="mt-1 text-xs text-red-500">{playbackError}</p>}
      <div className="mt-3 border-t border-border/50 pt-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t('practice.englishDefinitions')}</p>
        {loading && <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />{t('practice.wordLoading')}</p>}
        {lookupError && (
          <div className="text-sm">
            <p role="status" className="text-muted-foreground">{t(`practice.${lookupError}`)}</p>
            {lookupError !== 'wordNotFound' && <Button variant="ghost" size="sm" className="mt-1" onClick={() => setAttempt(value => value + 1)}><RotateCcw className="size-3.5" />{t('practice.wordRetry')}</Button>}
          </div>
        )}
        {entry && (
          <div className="max-h-72 break-words space-y-3 overflow-y-auto pr-1" lang="en">
            {entry.meanings.map((meaning, i) => (
              <div key={`${meaning.partOfSpeech}-${i}`}>
                <p className="text-xs font-semibold italic text-primary">{meaning.partOfSpeech}</p>
                <ol className="mt-1 list-decimal space-y-2 pl-5 text-sm leading-relaxed">
                  {(expanded ? meaning.definitions : meaning.definitions.slice(0, 3)).map((definition, j) => (
                    <li key={j}>
                      <p>{definition.definition}</p>
                      {definition.examples?.slice(0, 2).map((example, k) => <p key={k} className="mt-0.5 text-xs italic text-muted-foreground">“{example}”</p>)}
                      {definition.synonyms?.length > 0 && <p className="mt-0.5 text-xs text-muted-foreground">{t('practice.wordSynonyms')}: {definition.synonyms.slice(0, 6).join(', ')}</p>}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        )}
        {hasMore && <button type="button" className="mt-2 text-xs text-primary underline-offset-2 hover:underline" onClick={() => setExpanded(value => !value)}>{t(expanded ? 'practice.wordLess' : 'practice.wordMore')}</button>}
        {entry?.source && <p className="mt-2 text-[10px] text-muted-foreground/70">{entry.source}</p>}
      </div>
    </section>
  )
}
