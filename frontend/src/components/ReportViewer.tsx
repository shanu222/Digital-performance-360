import { useState } from 'react';
import clsx from 'clsx';
import { CheckCircle2, Info, TriangleAlert, ChevronDown, ChevronUp } from 'lucide-react';
import { fmtCompact } from '../lib/format';
import { ColumnChart, TrendChart } from './charts';
import { PriorityBadge } from './ui';

export interface ReportDoc {
  title: string;
  subtitle: string;
  period: { start: string; end: string };
  previousPeriod: { start: string; end: string };
  generatedAt: string;
  sources: string[];
  executiveSummary: string[];
  sections: Array<{
    title: string;
    note?: string;
    callouts?: Array<{ tone: 'good' | 'bad' | 'info'; text: string }>;
    kpis?: Array<{ label: string; value: string; change?: string | null }>;
    chart?: { type: 'line' | 'bar'; title: string; labels: string[]; series: Array<{ name: string; values: Array<number | null> }> };
    table?: { title: string; headers: string[]; rows: Array<Array<string | number | null>> };
    actions?: Array<{ priority: string; area: string; action: string; evidence: string; impact: string; source?: string }>;
    definitions?: Array<{ term: string; formula: string; meaning: string }>;
  }>;
}

const TONE = {
  good: ['bg-good-soft text-good', CheckCircle2],
  bad: ['bg-bad-soft text-bad', TriangleAlert],
  info: ['bg-accent-soft text-accent', Info],
} as const;

const NUMERIC = /^[-+≈]?\s*([A-Z]{3}\s)?[-+]?[\d.,]+\s*(%|pts?|pos|days)?$|^—$/;

function Table({ t }: { t: NonNullable<ReportDoc['sections'][number]['table']> }) {
  const [all, setAll] = useState(false);
  const rows = all ? t.rows : t.rows.slice(0, 15);
  // a column is numeric when its non-empty cells look like numbers, %, money or changes
  const numericCol = t.headers.map((_, i) => i > 0 && t.rows.every((r) => r[i] == null || typeof r[i] === 'number' || NUMERIC.test(String(r[i]))));
  if (!t.rows.length) return <p className="text-sm text-muted">No data for this period.</p>;
  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-line">
        <table className="w-full min-w-[640px] text-[12.5px]">
          <thead className="bg-surface-2">
            <tr>
              {t.headers.map((h, i) => (
                <th key={h + i} className={clsx('eyebrow whitespace-nowrap px-3 py-2', i === 0 ? 'text-left' : 'text-right')}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri} className="border-t border-line/70">
                {r.map((c, ci) => {
                  const s = c == null ? '—' : String(c);
                  const tone = /^[+]\d|▲/.test(s) ? 'text-good' : /^-\d|▼/.test(s) ? 'text-bad' : '';
                  return (
                    <td key={ci} className={clsx('px-3 py-2', numericCol[ci] ? 'num whitespace-nowrap text-right' : clsx('max-w-[320px] truncate text-left', ci === 0 && 'font-medium'), tone)} title={s}>
                      {s}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {t.rows.length > 15 && (
        <button onClick={() => setAll(!all)} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-accent">
          {all ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
          {all ? 'Show fewer rows' : `Show all ${t.rows.length} rows`}
        </button>
      )}
    </div>
  );
}

/** Renders the same structured report the PDF/Excel files contain. */
export function ReportViewer({ doc }: { doc: ReportDoc }) {
  return (
    <div className="space-y-5">
      <div className="overflow-hidden rounded-xl border border-line">
        <div className="px-6 py-5" style={{ background: 'linear-gradient(135deg,#0b1324,#0f2240)' }}>
          <div className="text-[10.5px] font-bold tracking-[0.25em] text-cyan">DIGITAL PERFORMANCE 360</div>
          <div className="mt-1 text-2xl font-extrabold text-white">{doc.title}</div>
          <div className="mt-1 text-xs text-slate-300">{doc.subtitle}</div>
          <div className="mt-2 text-[11px] text-slate-400">Sources: {doc.sources.join(' · ')} · generated {new Date(doc.generatedAt).toLocaleString()}</div>
        </div>
        <div className="bg-surface p-6">
          <div className="eyebrow mb-2 text-gold">Executive summary</div>
          <ul className="space-y-1.5 text-sm">
            {doc.executiveSummary.map((l, i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-gold" />
                <span>{l}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {doc.sections.map((s, si) => (
        <section key={si} className="card p-5">
          <h3 className="text-[15px] font-extrabold">{s.title}</h3>
          {s.note && <p className="mt-1 text-xs text-muted">{s.note}</p>}
          {s.callouts?.length ? (
            <div className="mt-3 space-y-2">
              {s.callouts.map((c, i) => {
                const [cls, Icon] = TONE[c.tone];
                return (
                  <div key={i} className={clsx('flex items-start gap-2 rounded-lg px-3 py-2 text-sm', cls)}>
                    <Icon className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="text-ink">{c.text}</span>
                  </div>
                );
              })}
            </div>
          ) : null}
          {s.actions?.length ? (
            <ol className="mt-3 space-y-2">
              {s.actions.map((a, i) => (
                <li key={i} className="flex gap-3 rounded-xl border border-line bg-surface-2/50 p-3">
                  <span className="num flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-xs font-bold">{i + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <PriorityBadge p={a.priority} />
                      <span className="text-xs font-semibold text-gold">{a.area}</span>
                      {a.source && <span className="rounded bg-surface-3 px-1.5 text-[10px] font-bold text-muted">{a.source}</span>}
                    </div>
                    <div className="mt-1 text-sm font-semibold">{a.action}</div>
                    <div className="mt-1 text-xs text-ink-2">
                      <span className="text-muted">Evidence:</span> {a.evidence}
                    </div>
                    <div className="text-xs text-ink-2">
                      <span className="text-muted">Expected impact:</span> {a.impact}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          ) : null}
          {s.kpis?.length ? (
            <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
              {s.kpis.map((k) => (
                <div key={k.label} className="rounded-lg border border-line p-3">
                  <div className="eyebrow">{k.label}</div>
                  <div className="num mt-1 text-lg font-extrabold">{k.value}</div>
                  {k.change && <div className={clsx('text-xs font-semibold', /^\+/.test(k.change) ? 'text-good' : /^-/.test(k.change) ? 'text-bad' : 'text-muted')}>{k.change}</div>}
                </div>
              ))}
            </div>
          ) : null}
          {s.chart && s.chart.labels.length ? (
            <div className="mt-4">
              <div className="mb-1 text-xs font-semibold text-ink-2">{s.chart.title}</div>
              {s.chart.type === 'bar' ? (
                <ColumnChart data={s.chart.labels.map((l, i) => ({ k: l, v: s.chart!.series[0].values[i] }))} xKey="k" yKey="v" name={s.chart.series[0].name} height={220} />
              ) : (
                <TrendChart
                  height={220}
                  data={s.chart.labels.map((l, i) => Object.fromEntries([['date', l], ...s.chart!.series.map((ser, j) => [`s${j}`, ser.values[i]])]))}
                  series={s.chart.series.map((ser, j) => ({ key: `s${j}`, name: ser.name }))}
                  format={fmtCompact}
                />
              )}
            </div>
          ) : null}
          {s.table && (
            <div className="mt-4">
              <Table t={s.table} />
            </div>
          )}
          {s.definitions?.length ? (
            <div className="mt-3 grid gap-2 md:grid-cols-2">
              {s.definitions.map((d) => (
                <div key={d.term} className="rounded-lg border border-line p-3">
                  <div className="text-sm font-bold">{d.term}</div>
                  <div className="mt-0.5 font-mono text-[11.5px] text-cyan">{d.formula}</div>
                  <div className="mt-1 text-xs text-ink-2">{d.meaning}</div>
                </div>
              ))}
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}
