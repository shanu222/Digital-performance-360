import { useMemo, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes } from 'react';
import clsx from 'clsx';
import { AlertTriangle, ArrowDownRight, ArrowUpRight, CheckCircle2, ChevronDown, ChevronUp, Circle, Inbox, Loader2, Minus, X, XOctagon, CloudOff } from 'lucide-react';
import { fmtAgo } from '../lib/format';

/* ------------------------------ layout ------------------------------ */

export function PageHeader({ title, subtitle, actions, eyebrow }: { title: string; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: string }) {
  return (
    <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
      <div>
        {eyebrow && <div className="eyebrow mb-1.5 text-gold">{eyebrow}</div>}
        <h1 className="text-[26px] font-extrabold tracking-tight text-ink">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-ink-2">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, subtitle, actions, children, className, pad = true, source }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean; source?: string }) {
  return (
    <section className={clsx('card fade-in', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-line px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="text-[14.5px] font-bold text-ink">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {source && <SourceTag>{source}</SourceTag>}
            {actions}
          </div>
        </header>
      )}
      <div className={pad ? 'p-5' : ''}>{children}</div>
    </section>
  );
}

export function SourceTag({ children }: { children: ReactNode }) {
  return <span className="rounded-md border border-line px-1.5 py-0.5 text-[10.5px] font-semibold text-muted">{children}</span>;
}

/* ------------------------------ controls ------------------------------ */

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'gold'; size?: 'sm' | 'md'; loading?: boolean; icon?: ReactNode };
export function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }: BtnProps) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={clsx(
        'inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-8 px-3 text-xs' : 'h-9.5 px-4 text-sm',
        variant === 'primary' && 'bg-accent text-white hover:brightness-110',
        variant === 'gold' && 'bg-gold text-[#0b1324] hover:brightness-110',
        variant === 'secondary' && 'border border-line-strong bg-surface-2 text-ink hover:bg-surface-3',
        variant === 'ghost' && 'text-ink-2 hover:bg-surface-2 hover:text-ink',
        variant === 'danger' && 'border border-bad/40 bg-bad-soft text-bad hover:bg-bad/20',
        className,
      )}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...rest} className={clsx('h-9.5 rounded-lg border border-line-strong bg-surface-2 px-3 text-sm text-ink placeholder:text-muted focus:border-accent focus:outline-none', className)} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...rest} className={clsx('h-9.5 rounded-lg border border-line-strong bg-surface-2 px-3 pr-8 text-sm text-ink focus:border-accent focus:outline-none', className)}>
      {children}
    </select>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-semibold text-ink-2">{label}</span>
      {children}
      {hint && <span className="text-[11.5px] text-muted">{hint}</span>}
    </label>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)} className={clsx('relative h-5.5 w-10 shrink-0 rounded-full transition-colors', checked ? 'bg-accent' : 'bg-surface-3 ring-1 ring-line-strong')}>
      <span className={clsx('absolute top-0.5 h-4.5 w-4.5 rounded-full bg-white shadow transition-all', checked ? 'left-5' : 'left-0.5')} />
    </button>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: Array<{ value: T; label: string }> }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5" role="tablist">
      {items.map((i) => (
        <button
          key={i.value}
          role="tab"
          aria-selected={value === i.value}
          onClick={() => onChange(i.value)}
          className={clsx('rounded-md px-3 py-1.5 text-xs font-semibold transition-colors', value === i.value ? 'bg-surface text-ink shadow-sm ring-1 ring-line' : 'text-muted hover:text-ink')}
        >
          {i.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm" onMouseDown={onClose}>
      <div className={clsx('card fade-in max-h-[90vh] w-full overflow-auto', wide ? 'max-w-3xl' : 'max-w-lg')} onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal aria-label={title}>
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h3 className="font-bold">{title}</h3>
          <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-ink" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-5">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-line px-5 py-3.5">{footer}</div>}
      </div>
    </div>
  );
}

/* ------------------------------ data display ------------------------------ */

export function Change({ value, invert, suffix = '%', digits = 1 }: { value: number | null | undefined; invert?: boolean; suffix?: string; digits?: number }) {
  if (value == null) return <span className="text-xs text-muted">no comparison</span>;
  const good = invert ? value < 0 : value > 0;
  const flat = Math.abs(value) < 0.05;
  const Icon = flat ? Minus : value > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={clsx('inline-flex items-center gap-0.5 text-xs font-bold num', flat ? 'text-muted' : good ? 'text-good' : 'text-bad')}>
      <Icon className="h-3.5 w-3.5" />
      {flat ? (0).toFixed(digits) : `${value > 0 ? '+' : ''}${value.toFixed(digits)}`}
      {suffix}
    </span>
  );
}

export function Kpi({ label, value, change, invert, icon, hint, accent, changeSuffix, loading }: { label: string; value: ReactNode; change?: number | null; invert?: boolean; icon?: ReactNode; hint?: ReactNode; accent?: 'blue' | 'cyan' | 'gold'; changeSuffix?: string; loading?: boolean }) {
  return (
    <div className="card fade-in relative overflow-hidden p-4">
      <div className={clsx('absolute inset-x-0 top-0 h-[2px]', accent === 'gold' ? 'bg-gold' : accent === 'cyan' ? 'bg-cyan' : accent === 'blue' ? 'bg-accent' : 'bg-transparent')} />
      <div className="flex items-center justify-between">
        <span className="eyebrow">{label}</span>
        {icon && <span className="text-muted">{icon}</span>}
      </div>
      {loading ? <div className="skeleton mt-3 h-7 w-24" /> : <div className="num mt-2 text-[24px] font-extrabold leading-tight text-ink">{value}</div>}
      <div className="mt-1.5 flex min-h-4 items-center gap-2">
        {change !== undefined && !loading && <Change value={change} invert={invert} suffix={changeSuffix} />}
        {hint && <span className="truncate text-[11px] text-muted">{hint}</span>}
      </div>
    </div>
  );
}

const STATUS: Record<string, { cls: string; icon: typeof Circle; label: string }> = {
  connected: { cls: 'bg-good-soft text-good', icon: CheckCircle2, label: 'Connected' },
  success: { cls: 'bg-good-soft text-good', icon: CheckCircle2, label: 'Success' },
  healthy: { cls: 'bg-good-soft text-good', icon: CheckCircle2, label: 'Healthy' },
  partial: { cls: 'bg-warn-soft text-warn', icon: AlertTriangle, label: 'Partial' },
  needs_attention: { cls: 'bg-warn-soft text-warn', icon: AlertTriangle, label: 'Needs attention' },
  needs_setup: { cls: 'bg-warn-soft text-warn', icon: AlertTriangle, label: 'Needs setup' },
  warning: { cls: 'bg-warn-soft text-warn', icon: AlertTriangle, label: 'Warning' },
  never_synced: { cls: 'bg-surface-3 text-ink-2', icon: Circle, label: 'Awaiting first sync' },
  never: { cls: 'bg-surface-3 text-ink-2', icon: Circle, label: 'Awaiting first sync' },
  pending: { cls: 'bg-accent-soft text-accent', icon: Loader2, label: 'Queued' },
  running: { cls: 'bg-accent-soft text-accent', icon: Loader2, label: 'Running' },
  syncing: { cls: 'bg-accent-soft text-accent', icon: Loader2, label: 'Syncing' },
  info: { cls: 'bg-accent-soft text-accent', icon: Circle, label: 'Info' },
  critical: { cls: 'bg-bad-soft text-bad', icon: XOctagon, label: 'Critical' },
  failed: { cls: 'bg-bad-soft text-bad', icon: XOctagon, label: 'Failed' },
  error: { cls: 'bg-bad-soft text-bad', icon: XOctagon, label: 'Error' },
  revoked: { cls: 'bg-bad-soft text-bad', icon: XOctagon, label: 'Access revoked' },
  not_connected: { cls: 'bg-surface-3 text-muted', icon: CloudOff, label: 'Not connected' },
  not_configured: { cls: 'bg-surface-3 text-muted', icon: CloudOff, label: 'Not configured' },
  no_data: { cls: 'bg-surface-3 text-muted', icon: Circle, label: 'No data' },
};

/** Status always carries an icon + text label, never colour alone. */
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  const s = STATUS[status] ?? { cls: 'bg-surface-3 text-ink-2', icon: Circle, label: status };
  const Icon = s.icon;
  return (
    <span className={clsx('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-bold', s.cls)}>
      <Icon className={clsx('h-3 w-3', (status === 'running' || status === 'syncing' || status === 'pending') && 'animate-spin')} />
      {label ?? s.label}
    </span>
  );
}

export function PriorityBadge({ p }: { p: string }) {
  const map: Record<string, string> = { critical: 'critical', high: 'warning', medium: 'info', low: 'no_data' };
  return <StatusBadge status={map[p] ?? 'info'} label={p.charAt(0).toUpperCase() + p.slice(1)} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={clsx('skeleton', className)} />;
}

export function Empty({ title, children, action, icon }: { title: string; children?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="mb-3 rounded-xl bg-surface-2 p-3 text-muted">{icon ?? <Inbox className="h-6 w-6" />}</div>
      <div className="font-bold text-ink">{title}</div>
      {children && <div className="mt-1 max-w-md text-sm text-ink-2">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function ErrorBox({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="flex items-start gap-3 rounded-xl border border-bad/30 bg-bad-soft p-4 text-sm">
      <XOctagon className="mt-0.5 h-4 w-4 shrink-0 text-bad" />
      <div className="flex-1">
        <div className="font-bold text-bad">Could not load this data</div>
        <div className="mt-0.5 text-ink-2">{msg}</div>
      </div>
      {retry && (
        <Button size="sm" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}

export function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'warn' }) {
  return (
    <div className={clsx('flex items-start gap-2 rounded-lg px-3 py-2 text-xs', tone === 'warn' ? 'bg-warn-soft text-warn' : 'bg-accent-soft text-ink-2')}>
      <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
      <div>{children}</div>
    </div>
  );
}

export function Updated({ at, label = 'Updated' }: { at?: string | Date | null; label?: string }) {
  return <span className="text-[11px] text-muted">{label} {fmtAgo(at ?? null)}</span>;
}

/* ------------------------------ data table ------------------------------ */

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => number | string | null;
  align?: 'left' | 'right';
  width?: string;
}

/** Sortable table with client-side search + pagination (server pagination via props). */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  loading,
  empty,
  pageSize = 25,
  onRowClick,
  initialSort,
  serverSort,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (r: T) => string;
  loading?: boolean;
  empty?: ReactNode;
  pageSize?: number;
  onRowClick?: (r: T) => void;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  serverSort?: { key: string; dir: 'asc' | 'desc'; onChange: (key: string, dir: 'asc' | 'desc') => void };
}) {
  const [sort, setSort] = useState(initialSort);
  const [page, setPage] = useState(0);
  const active = serverSort ?? sort;
  const sorted = useMemo(() => {
    if (serverSort || !sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sortValue) return rows;
    return [...rows].sort((a, b) => {
      const va = col.sortValue!(a);
      const vb = col.sortValue!(b);
      if (va == null) return 1;
      if (vb == null) return -1;
      const r = va < vb ? -1 : va > vb ? 1 : 0;
      return sort.dir === 'asc' ? r : -r;
    });
  }, [rows, sort, columns, serverSort]);
  const paged = serverSort ? sorted : sorted.slice(page * pageSize, (page + 1) * pageSize);
  const pages = Math.ceil(sorted.length / pageSize);

  const clickSort = (c: Column<T>) => {
    if (!c.sortValue && !serverSort) return;
    const dir = active?.key === c.key && active.dir === 'desc' ? 'asc' : 'desc';
    if (serverSort) serverSort.onChange(c.key, dir);
    else setSort({ key: c.key, dir });
    setPage(0);
  };

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead>
            <tr className="border-b border-line">
              {columns.map((c) => (
                <th
                  key={c.key}
                  style={{ width: c.width }}
                  onClick={() => clickSort(c)}
                  className={clsx('eyebrow select-none whitespace-nowrap px-4 py-2.5', c.align === 'right' ? 'text-right' : 'text-left', (c.sortValue || serverSort) && 'cursor-pointer hover:text-ink')}
                >
                  <span className="inline-flex items-center gap-1">
                    {c.header}
                    {active?.key === c.key && (active.dir === 'desc' ? <ChevronDown className="h-3 w-3" /> : <ChevronUp className="h-3 w-3" />)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading
              ? Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="border-b border-line/60">
                    {columns.map((c) => (
                      <td key={c.key} className="px-4 py-3">
                        <Skeleton className="h-4 w-full max-w-[140px]" />
                      </td>
                    ))}
                  </tr>
                ))
              : paged.map((r) => (
                  <tr key={rowKey(r)} onClick={() => onRowClick?.(r)} className={clsx('border-b border-line/60 transition-colors hover:bg-surface-2', onRowClick && 'cursor-pointer')}>
                    {columns.map((c) => (
                      <td key={c.key} className={clsx('px-4 py-2.5 align-middle', c.align === 'right' ? 'num text-right' : 'text-left')}>
                        {c.render(r)}
                      </td>
                    ))}
                  </tr>
                ))}
          </tbody>
        </table>
      </div>
      {!loading && !rows.length && (empty ?? <Empty title="No data for this period" />)}
      {!serverSort && pages > 1 && <Pager page={page} pages={pages} onChange={setPage} total={sorted.length} />}
    </div>
  );
}

export function Pager({ page, pages, onChange, total }: { page: number; pages: number; onChange: (p: number) => void; total: number }) {
  return (
    <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-xs text-muted">
      <span>
        {total.toLocaleString()} rows · page {page + 1} of {pages}
      </span>
      <div className="flex gap-1">
        <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => onChange(page - 1)}>
          Previous
        </Button>
        <Button size="sm" variant="ghost" disabled={page >= pages - 1} onClick={() => onChange(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}
