import { useState } from 'react'
import { NavLink } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { LayoutDashboard, Mic, Mic2, Settings, PanelLeftClose, PanelLeftOpen, AudioWaveform, BookOpen } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip'

const NAV = [
  { to: '/', icon: LayoutDashboard, key: 'nav.overview', end: true },
  { to: '/speaking', icon: Mic, key: 'nav.speaking' },
  { to: '/oral', icon: Mic2, key: 'nav.oral' },
  { to: '/gallery', icon: BookOpen, key: 'nav.gallery' },
  { to: '/settings', icon: Settings, key: 'nav.settings' },
]

export default function Layout({ children }) {
  const { t } = useTranslation()
  const [collapsed, setCollapsed] = useState(false)

  return (
    <TooltipProvider>
      <div className="flex h-[100dvh] min-h-0 min-w-0 flex-col overflow-hidden bg-background md:flex-row" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
        {/* Sidebar */}
        <aside className={`hidden shrink-0 bg-sidebar border-r border-sidebar-border flex-col p-3 gap-1 transition-[width] duration-200 md:flex ${collapsed ? 'w-[52px]' : 'w-[200px]'}`}>
          <div className="flex items-center gap-2.5 px-2 py-3 overflow-hidden">
            <AudioWaveform className="w-5 h-5 shrink-0 text-primary" />
            {!collapsed && (
              <span className="text-sm font-semibold text-sidebar-foreground truncate">Echonic</span>
            )}
          </div>

          <Separator className="bg-sidebar-border mb-1" />

          <nav aria-label="主导航" className="flex-1 flex flex-col gap-1">
            {NAV.map(({ to, icon: Icon, key, end }) => (
              collapsed ? (
                <Tooltip key={to}>
                  <TooltipTrigger
                    render={<NavLink to={to} end={end} />}
                    aria-label={t(key)}
                    className={({ isActive }) =>
                      `flex items-center justify-center px-2 py-2 rounded-md transition-colors ${
                        isActive
                          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                          : 'text-sidebar-foreground hover:bg-sidebar-accent/50'
                      }`
                    }
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                  </TooltipTrigger>
                  <TooltipContent side="right">{t(key)}</TooltipContent>
                </Tooltip>
              ) : (
                <NavLink
                  key={to}
                  to={to}
                  end={end}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 px-2 py-2 rounded-md text-sm transition-colors ${
                      isActive
                        ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                        : 'text-sidebar-foreground hover:bg-sidebar-accent/50'
                    }`
                  }
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  {t(key)}
                </NavLink>
              )
            ))}
          </nav>

          <Separator className="bg-sidebar-border mt-1 mb-1" />
          <Tooltip>
            <TooltipTrigger
              onClick={() => setCollapsed(v => !v)}
              aria-label={collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}
              className="flex items-center px-2 py-2 rounded-md text-sidebar-foreground/60 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground transition-colors"
            >
              {collapsed
                ? <PanelLeftOpen className="w-4 h-4 shrink-0" />
                : <PanelLeftClose className="w-4 h-4 shrink-0" />}
            </TooltipTrigger>
            <TooltipContent side="right">{collapsed ? t('nav.expandSidebar') : t('nav.collapseSidebar')}</TooltipContent>
          </Tooltip>
        </aside>

        {/* Main content */}
        <main id="main-content" className="min-h-0 min-w-0 flex-1 overflow-auto">
          {children}
        </main>
        <nav aria-label="手机主导航" className="grid shrink-0 grid-cols-5 border-t border-sidebar-border bg-sidebar px-1 pt-1 md:hidden" style={{ paddingBottom: 'max(0.25rem, env(safe-area-inset-bottom))', paddingLeft: 'max(0.25rem, env(safe-area-inset-left))', paddingRight: 'max(0.25rem, env(safe-area-inset-right))' }}>
          {NAV.map(({ to, icon: Icon, key, end }) => (
            <NavLink key={to} to={to} end={end} aria-label={t(key)} className={({ isActive }) => `flex min-h-14 min-w-0 flex-col items-center justify-center gap-1 rounded-md px-1 py-1.5 text-[10px] leading-tight transition-colors ${isActive ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground' : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/50'}`}>
              <Icon aria-hidden="true" className="size-5 shrink-0" />
              <span className="max-w-full truncate">{t(key)}</span>
            </NavLink>
          ))}
        </nav>
      </div>
    </TooltipProvider>
  )
}
