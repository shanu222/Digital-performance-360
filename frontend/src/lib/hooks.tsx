import { useQuery, useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { api, apiRaw, qs } from './api';
import { errMsg, useRange, useToast } from './context';
import { Select } from '../components/ui';

export interface Integ {
  id: string;
  status: string;
  lastSyncedAt: string | null;
  lastError: string | null;
}
export interface WebsiteRow {
  id: string;
  name: string;
  domain: string;
  isMonitored: boolean;
  searchConsole: (Integ & { siteUrl: string }) | null;
  ga4: (Integ & { name: string; propertyName: string }) | null;
  lastSyncedAt: string | null;
  clicks: number | null;
  impressions: number | null;
  ctr: number | null;
  position: number | null;
  clicksChangePct: number | null;
  impressionsChangePct: number | null;
  activeUsersDailySum: number | null;
  sessions: number | null;
  sessionsChangePct: number | null;
  freshDays: number;
  seoHealth: number | null;
}
export interface Money {
  currency: string;
  earnings: number | null;
  impressions: number | null;
  clicks: number | null;
  adRequests: number | null;
  matchedRequests: number | null;
  ecpm: number | null;
  matchRate: number | null;
  showRate: number | null;
  ctr: number | null;
}
export interface AppRow {
  id: string;
  name: string;
  packageName: string;
  platform: string;
  source: string;
  isMonitored: boolean;
  playConsole: { id: string; status: string; lastSyncedAt: string | null; lastError: string | null; isSelected: boolean } | null;
  admob: { id: string; appId: string; displayName: string | null } | null;
  ga4: { id: string; name: string } | null;
  lastSyncedAt: string | null;
  crashRate: number | null;
  anrRate: number | null;
  health: string;
  activeUsersDailySum: number | null;
  earnings: Array<{ currency: string; earnings: number | null; impressions: number | null; ecpm: number | null }>;
  earningsChangePct: number | null;
}
export interface Insight {
  id: string;
  entityType: string;
  entityId: string | null;
  entityLabel: string | null;
  title: string;
  problem: string;
  evidence: Array<{ metric: string; value: string; period?: string }>;
  recommendedAction: string;
  priority: string;
  potentialImpact: string | null;
  category: string | null;
  generatedForDate: string;
  model: string | null;
}

/** GET with the global date range appended. */
export function useRanged<T>(key: string, path: string, extra: Record<string, string | number | undefined | null> = {}, opts: { enabled?: boolean } = {}) {
  const { params } = useRange();
  const all = { ...params, ...extra };
  return useQuery({ queryKey: [key, all], queryFn: () => apiRaw<T>(`${path}${qs(all)}`), enabled: opts.enabled ?? true, placeholderData: (prev) => prev });
}

export function useWebsites() {
  return useRanged<WebsiteRow[]>('websites', '/api/websites');
}

/** Mutation with toast + invalidation boilerplate. */
export function useAction<V, R = unknown>(fn: (v: V) => Promise<R>, opts: { success?: string | ((r: R) => string); invalidate?: QueryKey[] } = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      if (opts.success) toast('success', typeof opts.success === 'function' ? opts.success(r) : opts.success);
      for (const k of opts.invalidate ?? []) qc.invalidateQueries({ queryKey: k });
    },
    onError: (e) => toast('error', errMsg(e)),
  });
}

export function WebsitePicker({ value, onChange, allowAll = true, require }: { value: string; onChange: (id: string) => void; allowAll?: boolean; require?: 'searchConsole' | 'ga4' }) {
  const q = useQuery({ queryKey: ['website-list'], queryFn: () => api<WebsiteRow[]>('/api/websites?preset=last7') });
  const list = (q.data ?? []).filter((w) => !require || w[require]);
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Website" className="min-w-[220px]">
      {allowAll && <option value="">All websites</option>}
      {!allowAll && !value && <option value="">Select a website…</option>}
      {list.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
    </Select>
  );
}
