import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, post, setCsrf, setUnauthorizedHandler, ApiError } from './api';

/* ------------------------------- auth ------------------------------- */

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthCtx = createContext<AuthState>(null as never);

export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        const r = await api<{ user: User; csrfToken: string }>('/api/auth/me');
        setCsrf(r.csrfToken);
        return r.user;
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setCsrf(null);
      qc.setQueryData(['me'], null);
    });
  }, [qc]);

  const login = useCallback(
    async (email: string, password: string) => {
      const r = await post<{ user: User; csrfToken: string }>('/api/auth/login', { email, password });
      setCsrf(r.csrfToken);
      qc.setQueryData(['me'], r.user);
    },
    [qc],
  );
  const logout = useCallback(async () => {
    try {
      await post('/api/auth/logout');
    } finally {
      setCsrf(null);
      qc.clear();
      qc.setQueryData(['me'], null);
    }
  }, [qc]);

  return <AuthCtx.Provider value={{ user: me.data ?? null, loading: me.isLoading, login, logout }}>{children}</AuthCtx.Provider>;
}
export const useAuth = () => useContext(AuthCtx);

/* ---------------------------- date range ---------------------------- */

export type Preset = 'today' | 'yesterday' | 'last7' | 'last28' | 'last30' | 'last90' | 'last180' | 'this_month' | 'last_month' | 'custom';
export const PRESETS: Array<{ value: Preset; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: 'last7', label: 'Last 7 days' },
  { value: 'last28', label: 'Last 28 days' },
  { value: 'last30', label: 'Last 30 days' },
  { value: 'last90', label: 'Last 90 days' },
  { value: 'last180', label: 'Last 6 months' },
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'custom', label: 'Custom range' },
];

export interface RangeState {
  preset: Preset;
  start?: string;
  end?: string;
}
const RangeCtx = createContext<{ range: RangeState; setRange: (r: RangeState) => void; params: Record<string, string | undefined> }>(null as never);

export function RangeProvider({ children }: { children: ReactNode }) {
  const [range, setRange] = useState<RangeState>({ preset: 'last28' });
  const params = useMemo(
    () => ({ preset: range.preset, start: range.preset === 'custom' ? range.start : undefined, end: range.preset === 'custom' ? range.end : undefined }),
    [range],
  );
  return <RangeCtx.Provider value={{ range, setRange, params }}>{children}</RangeCtx.Provider>;
}
export const useRange = () => useContext(RangeCtx);

/* ------------------------------- theme ------------------------------- */

export function useTheme() {
  const [theme, setTheme] = useState<'dark' | 'light'>(() => (document.documentElement.dataset.theme as 'dark' | 'light') ?? 'dark');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('dp360-theme', theme); // UI preference only
    } catch {
      /* storage unavailable */
    }
  }, [theme]);
  return { theme, toggle: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')) };
}

/* ------------------------------- toasts ------------------------------- */

type Toast = { id: number; kind: 'success' | 'error' | 'info'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-5 right-5 z-[100] flex w-[360px] max-w-[calc(100vw-2.5rem)] flex-col gap-2" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`fade-in card flex items-start gap-3 px-4 py-3 text-sm ${t.kind === 'error' ? 'border-bad/40' : t.kind === 'success' ? 'border-good/40' : ''}`}
          >
            <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${t.kind === 'error' ? 'bg-bad' : t.kind === 'success' ? 'bg-good' : 'bg-accent'}`} />
            <span className="text-ink">{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export function errMsg(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
