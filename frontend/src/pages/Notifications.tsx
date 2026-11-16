import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCheck, Trash2, Mail } from 'lucide-react';
import { apiRaw, del, patch, post, qs } from '../lib/api';
import { useAction } from '../lib/hooks';
import { fmtDate } from '../lib/format';
import { Button, Card, Empty, ErrorBox, PageHeader, Skeleton, StatusBadge, Tabs } from '../components/ui';

interface N { id: string; type: string; severity: string; title: string; description: string; recommendedAction: string | null; entityType: string | null; entityId: string | null; entityLabel: string | null; isRead: boolean; emailedAt: string | null; createdAt: string }

const link = (n: N) => (n.entityType === 'website' && n.entityId ? `/websites/${n.entityId}` : n.entityType === 'android_app' && n.entityId ? `/apps/${n.entityId}` : n.entityType === 'admob' ? '/admob' : n.entityType === 'integration' ? '/integrations' : null);

export default function Notifications() {
  const [view, setView] = useState<'all' | 'unread'>('all');
  const [severity, setSeverity] = useState('');
  const q = useQuery({ queryKey: ['notifications', view, severity], queryFn: () => apiRaw<N[]>(`/api/notifications${qs({ unread: view === 'unread' ? 'true' : undefined, severity, limit: 200 })}`) });
  const inv = [['notifications'], ['unread']];
  const mark = useAction(({ id, isRead }: { id: string; isRead: boolean }) => patch(`/api/notifications/${id}`, { isRead }), { invalidate: inv });
  const all = useAction(() => post('/api/notifications/read-all'), { success: 'All marked as read', invalidate: inv });
  const remove = useAction((id: string) => del(`/api/notifications/${id}`), { invalidate: inv });
  return (
    <div>
      <PageHeader
        eyebrow="Alerts"
        title="Notifications"
        subtitle={`${q.data?.meta?.unread ?? 0} unread · thresholds are configurable in Settings · duplicates are suppressed`}
        actions={
          <>
            <Tabs value={severity} onChange={setSeverity} items={[{ value: '', label: 'All' }, { value: 'critical', label: 'Critical' }, { value: 'warning', label: 'Warning' }, { value: 'info', label: 'Info' }]} />
            <Tabs value={view} onChange={setView} items={[{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread' }]} />
            <Button icon={<CheckCheck className="h-4 w-4" />} onClick={() => all.mutate(undefined)}>Mark all read</Button>
          </>
        }
      />
      {q.error && <ErrorBox error={q.error} retry={() => q.refetch()} />}
      <Card pad={false}>
        {q.isLoading ? (
          <div className="space-y-3 p-5">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20" />)}</div>
        ) : !q.data?.data.length ? (
          <Empty title="You're all caught up">Alerts appear here after each synchronization when thresholds are crossed.</Empty>
        ) : (
          <ul className="divide-y divide-line">
            {q.data.data.map((n) => {
              const to = link(n);
              return (
                <li key={n.id} className={`flex gap-4 px-5 py-4 ${n.isRead ? 'opacity-70' : ''}`}>
                  <div className="pt-0.5">{!n.isRead ? <span className="block h-2 w-2 rounded-full bg-accent" title="Unread" /> : <span className="block h-2 w-2" />}</div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusBadge status={n.severity} />
                      <span className="font-bold">{n.title}</span>
                    </div>
                    <div className="mt-1 text-xs text-muted">
                      {n.entityLabel && (to ? <Link to={to} className="text-gold hover:underline">{n.entityLabel}</Link> : <span className="text-gold">{n.entityLabel}</span>)}
                      {n.entityLabel && ' · '}
                      {fmtDate(n.createdAt, true)}
                      {n.emailedAt && <span className="ml-2 inline-flex items-center gap-1"><Mail className="h-3 w-3" /> emailed</span>}
                    </div>
                    <p className="mt-2 text-sm text-ink-2">{n.description}</p>
                    {n.recommendedAction && <p className="mt-1.5 text-sm"><span className="font-semibold text-accent">Recommended: </span>{n.recommendedAction}</p>}
                  </div>
                  <div className="flex shrink-0 flex-col gap-1">
                    <Button size="sm" variant="ghost" onClick={() => mark.mutate({ id: n.id, isRead: !n.isRead })}>{n.isRead ? 'Mark unread' : 'Mark read'}</Button>
                    <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => remove.mutate(n.id)} aria-label="Delete" />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
