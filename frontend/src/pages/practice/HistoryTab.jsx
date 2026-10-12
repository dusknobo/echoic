import { useTranslation } from 'react-i18next'
import { Trash2 } from 'lucide-react'
import ScoreCard from '@/components/ScoreCard'
import AIRecordingAnalysis from '@/components/AIRecordingAnalysis'
import { scoreColor, chipBg } from './utils'

export default function HistoryTab({ history, currentRecordId, analysisDisabled = false, comparison, result, wordSummary, selectedSentence, onLoadRecord, onDeleteRecord }) {
  const { t } = useTranslation()
  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-y-auto break-words">
      {/* History list */}
      <div className="max-h-64 overflow-y-auto px-3 py-3 md:px-5 md:py-4">
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {selectedSentence ? t('practice.noPractice') : t('practice.selectToView')}
          </p>
        ) : (
          <div className="space-y-2">
            {history.map(r => {
              const selected = r.id === currentRecordId
              return (
                <div
                  key={r.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={selected}
                  aria-label={`${t('practice.myPractice')} ${new Date(r.created_at).toLocaleString('zh-CN')}`}
                  onKeyDown={event => { if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); onLoadRecord(r) } }}
                  className={`cursor-pointer rounded-lg border border-border/40 p-3 transition-colors ${
                    selected ? 'bg-accent' : 'hover:bg-muted/30'
                  }`}
                  onClick={() => onLoadRecord(r)}
                >
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <p className="text-[11px] text-muted-foreground">
                      {new Date(r.created_at).toLocaleString('zh-CN')}
                    </p>
                    <button
                      type="button"
                      aria-label="删除这条录音"
                      className="inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:text-destructive"
                      onClick={e => onDeleteRecord(e, r)}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                  <div className="flex flex-wrap gap-x-5 gap-y-2">
                    {[[t('practice.accuracy'), r.accuracy_score], [t('practice.fluency'), r.fluency_score], [t('practice.completeness'), r.completeness_score]].map(([label, val]) => (
                      <div key={label} className="flex flex-col items-center gap-0.5">
                        <span className={`text-base font-semibold tabular-nums ${scoreColor(val)}`}>
                          {val != null ? Math.round(val) : '—'}
                        </span>
                        <span className="text-[10px] text-muted-foreground">{label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>

      <div className="border-t border-border/30">
        <AIRecordingAnalysis recordId={currentRecordId} disabled={analysisDisabled} selectedSentence={selectedSentence} comparison={comparison} />
      </div>

      {/* Word summary */}
      {wordSummary.length > 0 && (
        <div className="shrink-0 border-t border-border/30 px-3 py-3 md:px-5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
            {t('practice.wordSummary')}
          </p>
          <div className="flex flex-wrap gap-2">
            {wordSummary.map(({ word, avg, count }) => (
              <div key={word} className="flex flex-col items-center gap-0.5">
                <span className={`rounded px-2 py-0.5 text-xs font-medium ${chipBg(avg)}`}>{word}</span>
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {Math.round(avg)}{count > 1 ? ` ×${count}` : ''}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Detail panel */}
      {result?.accuracy_score != null && (
        <div className="border-t border-border/30 px-3 py-3 md:px-5 md:py-4">
          <ScoreCard result={result} />
        </div>
      )}
    </div>
  )
}
