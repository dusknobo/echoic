import { useTranslation } from 'react-i18next'
import { scoreColor } from './utils'

export default function WordIpaRow({ words, activeIndex, selectedIndex, onWordClick }) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-2">
      {words.map((w, i) => {
        const isActive = i === activeIndex
        const textCls = isActive
          ? 'text-red-500 font-semibold'
          : w.score != null ? scoreColor(w.score) : 'text-foreground font-semibold'
        return (
          <button key={i} type="button" onClick={() => onWordClick(i)}
            aria-label={t('practice.studyWord', { word: w.text })}
            aria-pressed={selectedIndex === i}
            className={`flex max-w-full flex-col items-center gap-0.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${selectedIndex === i ? 'bg-accent ring-1 ring-border' : ''}`}>
            <span className={`max-w-full break-all text-base leading-6 tracking-wide transition-colors duration-100 ${textCls}`}>
              {w.text}
            </span>
            {w.ipa && (
              <span className={`font-[family-name:var(--font-ipa)] max-w-full break-all text-[11px] leading-4 transition-colors duration-100 ${isActive ? 'text-red-400' : 'text-muted-foreground'}`}>
                {w.ipa}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
