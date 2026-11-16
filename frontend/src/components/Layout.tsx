import { useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  LayoutDashboard,
  Globe,
  Search,
  KeyRound,
  FileText,
  ScanSearch,
  Users,
  Smartphone,
  HeartPulse,
  DollarSign,
  Sparkles,
  FileBarChart,
  Bell,
  Plug,
  Settings,
  Menu,
  X,
  Sun,
  Moon,
  LogOut,
  RefreshCw,
  CalendarRange,
} from 'lucide-react';
import { api, qs } from '../lib/api';
import { useAuth, useRange, useTheme, PRESETS, type Preset } from '../lib/context';
import { Input, Select } from './ui';

const NAV: Array<{ to: string; label: string; icon: typeof Globe; group?: string }> = [
  { to: '/', label: 'Overview', icon: LayoutDashboard, group: 'Portfolio' },
  { to: '/websites', label: 'Websites', icon: Globe },
  { to: '/seo', label: 'SEO Analytics', icon: Search, group: 'Search' },
  { to: '/keywords', label: 'Keywords', icon: KeyRound },
  { to: '/pages', label: 'Page Performance', icon: FileText },
  { to: '/indexing', label: 'Indexing Monitor', icon: ScanSearch },
  { to: '/traffic', label: 'Traffic Analytics', icon: Users, group: 'Audience' },
  { to: '/apps', label: 'Android Applications', icon: Smartphone, group: 'Apps & Revenue' },
  { to: '/play-health', label: 'Google Play Health', icon: HeartPulse },
  { to: '/admob', label: 'AdMob Revenue', icon: DollarSign },
  { to: '/ai', label: 'AI Intelligence', icon: Sparkles, group: 'Intelligence' },
  { to: '/reports', label: 'Reports', icon: FileBarChart },
  { to: '/notifications', label: 'Notifications', icon: Bell },
  { to: '/integrations', label: 'Integrations', icon: Plug, group: 'System' },
  { to: '/settings', label: 'Settings', icon: Settings },
];

/** Pages where the global date range applies. */
const RANGE_PAGES = ['/', '/websites', '/seo', '/keywords', '/pages', '/traffic', '/apps', '/play-health', '/admob', '/reports'];

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-2">
      <svg viewBox="0 0 64 64" className="h-8 w-8" aria-hidden>
        <rect width="64" height="64" rx="14" fill="#0b1324" />
        <circle cx="32" cy="32" r="17" fill="none" stroke="#22d3ee" strokeWidth="5" strokeDasharray="80 27" strokeLinecap="round" />
        <circle cx="32" cy="32" r="5" fill="#d6a84e" />
      </svg>
      <div className="leading-tight">
        <div className="text-[13.5px] font-extrabold tracking-tight text-ink">Digital Performance</div>
        <div className="text-[10.5px] font-bold tracking-[0.2em] text-gold">360 CONTROL ROOM</div>
      </div>
    </div>
  );
}

function SideNav({ onNavigate, unread }: { onNavigate?: () => void; unread: number }) {
  return (
    <nav className="flex flex-col gap-0.5 px-3 pb-6">
      {NAV.map((n) => (
        <div key={n.to}>
          {n.group && <div className="eyebrow mb-1.5 mt-5 px-3 first:mt-2">{n.group}</div>}
          <NavLink
            to={n.to}
            end={n.to === '/'}
            onClick={onNavigate}
            className={({ isActive }) =>
              clsx(
                'group relative flex items-center gap-3 rounded-lg px-3 py-2 text-[13.5px] font-semibold transition-colors',
                isActive ? 'bg-accent-soft text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
              )
            }
          >
            {({ isActive }) => (
              <>
                {isActive && <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-r bg-cyan" />}
                <n.icon className={clsx('h-4 w-4', isActive ? 'text-cyan' : 'text-muted group-hover:text-ink-2')} />
                <span className="flex-1">{n.label}</span>
                {n.to === '/notifications' && unread > 0 && <span className="num rounded-full bg-bad px-1.5 text-[10.5px] font-bold text-white">{unread > 99 ? '99+' : unread}</span>}
              </>
            )}
          </NavLink>
        </div>
      ))}
    </nav>
  );
}

export function RangePicker() {
  const { range, setRange } = useRange();
  return (
    <div className="flex items-center gap-2">
      <CalendarRange className="hidden h-4 w-4 text-muted sm:block" />
      <Select aria-label="Date range" value={range.preset} onChange={(e) => setRange({ ...range, preset: e.target.value as Preset })} className="h-9 text-[13px]">
        {PRESETS.map((p) => (
          <option key={p.value} value={p.value}>
            {p.label}
          </option>
        ))}
      </Select>
      {range.preset === 'custom' && (
        <>
          <Input type="date" aria-label="Start date" value={range.start ?? ''} onChange={(e) => setRange({ ...range, start: e.target.value })} className="h-9 w-[150px] text-[13px]" />
          <Input type="date" aria-label="End date" value={range.end ?? ''} onChange={(e) => setRange({ ...range, end: e.target.value })} className="h-9 w-[150px] text-[13px]" />
        </>
      )}
    </div>
  );
}

function SyncIndicator() {
  const q = useQuery({ queryKey: ['sync-status'], queryFn: () => api<{ active: Array<{ service: string; status: string; progress: number }> }>('/api/sync/status'), refetchInterval: 10_000 });
  const active = q.data?.active ?? [];
  if (!active.length) return null;
  const running = active.filter((a) => a.status === 'running');
  return (
    <NavLink to="/integrations" className="hidden items-center gap-2 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5 text-xs font-semibold text-ink-2 md:flex" title="Synchronization in progress">
      <RefreshCw className="h-3.5 w-3.5 animate-spin text-cyan" />
      {running.length ? `Syncing ${running.map((r) => r.service.replace('_', ' ')).join(', ')}` : `${active.length} queued`}
    </NavLink>
  );
}

export function Layout({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const loc = useLocation();
  const unread = useQuery({
    queryKey: ['unread'],
    queryFn: async () => {
      const { apiRaw } = await import('../lib/api');
      const r = await apiRaw<unknown[]>(`/api/notifications${qs({ unread: 'true', limit: 1 })}`);
      return Number(r.meta?.unread ?? 0);
    },
    refetchInterval: 60_000,
  });
  const showRange = RANGE_PAGES.includes(loc.pathname) || /^\/(websites|apps)\//.test(loc.pathname);

  return (
    <div className="min-h-screen lg:pl-[264px]">
      {/* desktop sidebar */}
      <aside className="glass fixed inset-y-0 left-0 z-30 hidden w-[264px] flex-col border-y-0 border-l-0 lg:flex">
        <div className="py-5">
          <Brand />
        </div>
        <div className="flex-1 overflow-y-auto">
          <SideNav unread={unread.data ?? 0} />
        </div>
        <div className="border-t border-line p-3 text-[11px] text-muted">Monitor. Analyze. Optimize. Grow.</div>
      </aside>

      {/* mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <aside className="glass absolute inset-y-0 left-0 w-[280px] overflow-y-auto">
            <div className="flex items-center justify-between py-5 pr-3">
              <Brand />
              <button onClick={() => setOpen(false)} className="rounded-md p-1.5 text-muted" aria-label="Close menu">
                <X className="h-5 w-5" />
              </button>
            </div>
            <SideNav onNavigate={() => setOpen(false)} unread={unread.data ?? 0} />
          </aside>
        </div>
      )}

      <header className="glass sticky top-0 z-20 flex h-16 items-center gap-3 border-x-0 border-t-0 px-4 md:px-8">
        <button className="rounded-md p-1.5 text-ink-2 lg:hidden" onClick={() => setOpen(true)} aria-label="Open menu">
          <Menu className="h-5 w-5" />
        </button>
        <div className="flex-1">{showRange && <RangePicker />}</div>
        <SyncIndicator />
        <NavLink to="/notifications" className="relative rounded-lg p-2 text-ink-2 hover:bg-surface-2" aria-label="Notifications">
          <Bell className="h-4.5 w-4.5" />
          {(unread.data ?? 0) > 0 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-bad ring-2 ring-surface" />}
        </NavLink>
        <button onClick={toggle} className="rounded-lg p-2 text-ink-2 hover:bg-surface-2" aria-label="Toggle theme">
          {theme === 'dark' ? <Sun className="h-4.5 w-4.5" /> : <Moon className="h-4.5 w-4.5" />}
        </button>
        <div className="hidden items-center gap-2 border-l border-line pl-3 sm:flex">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gold-soft text-xs font-extrabold text-gold">{user?.name?.slice(0, 1).toUpperCase()}</div>
          <div className="hidden leading-tight xl:block">
            <div className="text-xs font-bold text-ink">{user?.name}</div>
            <div className="text-[11px] text-muted">{user?.email}</div>
          </div>
        </div>
        <button onClick={() => void logout()} className="rounded-lg p-2 text-ink-2 hover:bg-surface-2" aria-label="Sign out" title="Sign out">
          <LogOut className="h-4.5 w-4.5" />
        </button>
      </header>

      <main className="mx-auto max-w-[1480px] px-4 py-7 md:px-8">{children ?? <Outlet />}</main>
    </div>
  );
}
