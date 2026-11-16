import { useState, type ReactNode } from 'react';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis, type TooltipProps } from 'recharts';
import { fmtCompact, shortDate } from '../lib/format';
import { Empty, Tabs } from './ui';
import { BarChart3 } from 'lucide-react';

/** Categorical slots in fixed order (validated palette); colour follows the series, never its rank. */
export const SERIES = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)'];

export interface SeriesDef {
  key: string;
  name: string;
}

type Fmt = (v: number) => string;

function ChartTooltip({ active, payload, label, format, labelFormat }: TooltipProps<number, string> & { format: Fmt; labelFormat?: (l: string) => string; payload?: Array<{ name?: string; value?: number; color?: string }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="card min-w-[150px] px-3 py-2 text-xs">
      <div className="mb-1 font-bold text-ink">{labelFormat ? labelFormat(String(label)) : label}</div>
      {payload.map((p) => (
        <div key={p.name} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-ink-2">
            <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
            {p.name}
          </span>
          <span className="num font-bold text-ink">{p.value == null ? '—' : format(Number(p.value))}</span>
        </div>
      ))}
    </div>
  );
}

function Legend({ series }: { series: SeriesDef[] }) {
  if (series.length < 2) return null;
  return (
    <div className="mb-2 flex flex-wrap gap-4 text-xs text-ink-2">
      {series.map((s, i) => (
        <span key={s.key} className="flex items-center gap-1.5">
          <span className="h-[3px] w-4 rounded" style={{ background: SERIES[i % SERIES.length] }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

/**
 * Time series on ONE y-axis. Series must share a unit (e.g. sessions & users);
 * different units use MetricTrend's toggle instead of a second axis.
 */
export function TrendChart<T extends Record<string, unknown>>({
  data,
  series,
  xKey = 'date',
  format = fmtCompact,
  height = 260,
  area = true,
  yDomain,
  reversed,
}: {
  data: T[];
  series: SeriesDef[];
  xKey?: string;
  format?: Fmt;
  height?: number;
  area?: boolean;
  yDomain?: [number | 'auto', number | 'auto'];
  reversed?: boolean;
}) {
  if (!data.length)
    return (
      <div style={{ height }} className="flex items-center">
        <Empty title="No data stored for this period" icon={<BarChart3 className="h-6 w-6" />}>
          Data appears after the first successful synchronization.
        </Empty>
      </div>
    );
  const xFmt = (v: string) => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? shortDate(v) : v);
  const common = (
    <>
      <CartesianGrid stroke="var(--grid)" vertical={false} />
      <XAxis dataKey={xKey} tickFormatter={xFmt} tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false} tickLine={false} minTickGap={24} />
      <YAxis tickFormatter={(v) => format(Number(v))} tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false} tickLine={false} width={56} domain={yDomain ?? [0, 'auto']} reversed={reversed} />
      <Tooltip content={<ChartTooltip format={format} labelFormat={xFmt} />} cursor={{ stroke: 'var(--border-strong)', strokeWidth: 1 }} />
    </>
  );
  return (
    <div>
      <Legend series={series} />
      <ResponsiveContainer width="100%" height={height}>
        {area ? (
          <AreaChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
            <defs>
              {series.map((s, i) => (
                <linearGradient key={s.key} id={`g-${s.key}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={SERIES[i % SERIES.length]} stopOpacity={series.length > 1 ? 0.12 : 0.28} />
                  <stop offset="100%" stopColor={SERIES[i % SERIES.length]} stopOpacity={0} />
                </linearGradient>
              ))}
            </defs>
            {common}
            {series.map((s, i) => (
              <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={SERIES[i % SERIES.length]} strokeWidth={2} fill={`url(#g-${s.key})`} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }} connectNulls={false} isAnimationActive={false} />
            ))}
          </AreaChart>
        ) : (
          <LineChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
            {common}
            {series.map((s, i) => (
              <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={SERIES[i % SERIES.length]} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: 'var(--surface)' }} connectNulls={false} isAnimationActive={false} />
            ))}
          </LineChart>
        )}
      </ResponsiveContainer>
    </div>
  );
}

/** One chart, several metrics of different units → a toggle, never a dual axis. */
export function MetricTrend<T extends Record<string, unknown>>({ data, metrics, height }: { data: T[]; metrics: Array<{ key: string; label: string; format?: Fmt; reversed?: boolean }>; height?: number }) {
  const [m, setM] = useState(metrics[0].key);
  const cur = metrics.find((x) => x.key === m) ?? metrics[0];
  return (
    <div>
      <div className="mb-3">
        <Tabs value={m} onChange={setM} items={metrics.map((x) => ({ value: x.key, label: x.label }))} />
      </div>
      <TrendChart data={data} series={[{ key: cur.key, name: cur.label }]} format={cur.format} height={height} reversed={cur.reversed} yDomain={cur.reversed ? ['auto', 'auto'] : undefined} />
    </div>
  );
}

export function ColumnChart<T extends object>({ data, xKey, yKey, name, format = fmtCompact, height = 240 }: { data: T[]; xKey: string; yKey: string; name: string; format?: Fmt; height?: number }) {
  if (!data.length) return <Empty title="No data for this period" />;
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 0 }} barCategoryGap="22%">
        <CartesianGrid stroke="var(--grid)" vertical={false} />
        <XAxis dataKey={xKey} tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false} tickLine={false} />
        <YAxis tickFormatter={(v) => format(Number(v))} tick={{ fill: 'var(--muted)', fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
        <Tooltip content={<ChartTooltip format={format} />} cursor={{ fill: 'var(--surface-2)' }} />
        <Bar dataKey={yKey} name={name} fill={SERIES[0]} radius={[4, 4, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Ranked horizontal bars in plain HTML — readable labels, hover title, values in text ink. */
export function BarList({ items, format = fmtCompact, max: maxRows = 10, valueLabel }: { items: Array<{ label: ReactNode; value: number | null; sub?: ReactNode; key: string }>; format?: Fmt; max?: number; valueLabel?: string }) {
  const rows = items.filter((i) => i.value != null).slice(0, maxRows);
  if (!rows.length) return <Empty title="No data for this period" />;
  const top = Math.max(...rows.map((r) => r.value ?? 0), 1);
  return (
    <ul className="space-y-2.5">
      {rows.map((r) => (
        <li key={r.key} className="group" title={`${typeof r.label === 'string' ? r.label : ''} — ${valueLabel ?? ''} ${format(r.value ?? 0)}`}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-[13px]">
            <span className="min-w-0 truncate text-ink">{r.label}</span>
            <span className="num shrink-0 font-bold text-ink">
              {format(r.value ?? 0)}
              {r.sub && <span className="ml-2 font-medium text-muted">{r.sub}</span>}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full transition-all group-hover:brightness-125" style={{ width: `${Math.max(2, ((r.value ?? 0) / top) * 100)}%`, background: SERIES[0] }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Share-of-total stacked bar (devices etc.) with a legend + values. */
export function ShareBar({ items, format = fmtCompact }: { items: Array<{ key: string; label: string; value: number | null }>; format?: Fmt }) {
  const rows = items.filter((i) => (i.value ?? 0) > 0).slice(0, 4);
  const total = rows.reduce((s, r) => s + (r.value ?? 0), 0);
  if (!total) return <Empty title="No data for this period" />;
  return (
    <div>
      <div className="flex h-3 gap-[2px] overflow-hidden rounded-full">
        {rows.map((r, i) => (
          <div key={r.key} title={`${r.label}: ${format(r.value ?? 0)}`} style={{ width: `${((r.value ?? 0) / total) * 100}%`, background: SERIES[i] }} />
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {rows.map((r, i) => (
          <div key={r.key} className="flex items-center gap-2 text-xs">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: SERIES[i] }} />
            <span className="capitalize text-ink-2">{r.label}</span>
            <span className="num ml-auto font-bold text-ink">{(((r.value ?? 0) / total) * 100).toFixed(1)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}
