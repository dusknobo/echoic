import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import Markdown from 'react-markdown'
import WordIpaRow from './WordIpaRow'
import WordDetails from './WordDetails'

export default function AnalysisTab({ selectedSentence, words, activeWordIndex, analysis, analyzing, onAnalyze, phonemesLoading, onRefreshPhonemes, onPronounceWord, onStopWord, playingWordIndex, pronunciationSource, wordPlaybackError, pronunciationDisabled }) {
  const { t } = useTranslation()
  const [selectedWordIndex, setSelectedWordIndex] = useState(null)
  useEffect(() => { setSelectedWordIndex(null) }, [selectedSentence?.index])
  const selectedWord = selectedWordIndex === null ? null : words[selectedWordIndex]

  function selectWord(index) {
    setSelectedWordIndex(index)
    if (!pronunciationDisabled) onPronounceWord(index)
  }
  return (
    <>
      <div className="mb-4">
        {selectedSentence ? (
          <div className="group relative min-w-0 break-words pr-11 md:pr-0">
            <WordIpaRow words={words} activeIndex={activeWordIndex} selectedIndex={selectedWordIndex} onWordClick={selectWord} />
            <p className="mt-1 text-[11px] text-muted-foreground">{t('practice.wordClickHint')}</p>
            <button
              onClick={onRefreshPhonemes}
              disabled={phonemesLoading}
              title={t('practice.refreshPhonemes')}
              aria-label={t('practice.refreshPhonemes')}
              className="absolute -top-1 right-0 flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 md:-right-1 md:hidden md:size-6 md:group-hover:flex md:group-focus-within:flex"
            >
              {phonemesLoading
                ? <Loader2 className="size-3 animate-spin" />
                : <RefreshCw className="size-3" />}
            </button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground/50">{t('practice.selectSentence')}</p>
        )}
      </div>
      {selectedWord && (
        <WordDetails key={`${selectedSentence?.index}:${selectedWordIndex}:${selectedWord.text}`} word={selectedWord}
          onPronounce={() => onPronounceWord(selectedWordIndex)}
          onClose={() => { onStopWord(); setSelectedWordIndex(null) }}
          playing={playingWordIndex === selectedWordIndex} pronunciationSource={pronunciationSource}
          playbackError={wordPlaybackError} pronunciationDisabled={pronunciationDisabled} />
      )}
      {selectedSentence && (
        <div className="border-t border-border/20 pt-4">
          {analysis ? (
            <div className="min-w-0 break-words text-sm text-foreground/80 [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_h1]:mb-1 [&_h1]:mt-4 [&_h1]:text-base [&_h1]:font-bold [&_h1]:text-foreground [&_h2]:mb-1 [&_h2]:mt-4 [&_h2]:text-base [&_h2]:font-bold [&_h2]:text-foreground [&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-semibold [&_li]:my-0.5 [&_p]:my-1 [&_p]:leading-relaxed [&_strong]:font-semibold [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-4 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-4">
              <Markdown>{analysis}</Markdown>
            </div>
          ) : (
            <Button variant="outline" size="sm" disabled={analyzing} onClick={onAnalyze} className="gap-1.5">
              {analyzing && <Loader2 className="size-3.5 animate-spin" />}
              {t('practice.analyzeSentence')}
            </Button>
          )}
        </div>
      )}
    </>
  )
}
