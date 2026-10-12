export default function WaveformRow({ label, detail, containerRef, emptyState, actions }) {
  const hasActions = actions?.length > 0
  return (
    <div
      className={`min-w-0 min-h-[72px] overflow-hidden rounded-lg border border-border/30 bg-muted/5 ${hasActions ? 'grid grid-cols-1 md:grid-cols-[1fr_36px]' : ''}`}
    >
      <div className="min-w-0 px-2.5 py-1.5 md:px-3.5 md:py-2">
        <div className="mb-1.5 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
          <span className="min-w-0 truncate">{detail ?? ''}</span>
          <span className="shrink-0 tabular-nums">{label ?? ''}</span>
        </div>
        <div className="relative h-[52px] overflow-hidden">
          {emptyState ?? <div ref={containerRef} className="h-full" />}
        </div>
      </div>
      {hasActions && (
        <div className="grid grid-flow-col auto-cols-fr items-stretch border-t border-border/30 md:grid-flow-row md:auto-cols-auto md:auto-rows-fr md:border-l md:border-t-0">
          {actions.map((action, i) => (
            <div key={i} className={`flex min-w-0 items-stretch [&>button]:min-h-11 md:[&>button]:min-h-0 ${String(action?.key || '').startsWith('pad') ? 'hidden md:flex' : ''}`}>{action}</div>
          ))}
        </div>
      )}
    </div>
  )
}
