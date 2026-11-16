import type React from 'react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Sparkles, Send, Bot, User as UserIcon, X, Wand2 } from 'lucide-react';
import { apiRaw, patch, post, qs } from '../lib/api';
import { useAction, type Insight } from '../lib/hooks';
import { errMsg } from '../lib/context';
import { fmtDate } from '../lib/format';
import { Button, Card, Empty, ErrorBox, Notice, PageHeader, PriorityBadge, Select, Skeleton } from '../components/ui';

export function InsightCard({ i, onDismiss }: { i: Insight; onDismiss?: () => void }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2/60 p-4">
      <div className="flex items-start gap-2">
        <PriorityBadge p={i.priority} />
        {i.category === 'positive' && <span className="rounded-full bg-good-soft px-2 py-0.5 text-[11px] font-bold text-good">Positive</span>}
        <div className="ml-auto flex items-center gap-2 text-[11px] text-muted">
          {fmtDate(i.generatedForDate)}
          {onDismiss && (
            <button onClick={onDismiss} className="rounded p-0.5 hover:bg-surface-3 hover:text-ink" aria-label="Dismiss" title="Dismiss">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>
      <div className="mt-2 font-bold">{i.title}</div>
      {i.entityLabel && <div className="text-xs text-gold">{i.entityLabel}</div>}
      <p className="mt-2 text-sm text-ink-2">{i.problem}</p>
      {i.evidence.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {i.evidence.map((e, k) => (
            <span key={k} className="rounded-md border border-line bg-surface px-2 py-1 text-[11px]">
              <span className="text-muted">{e.metric}:</span> <span className="num font-semibold">{e.value}</span>
              {e.period && <span className="text-muted"> · {e.period}</span>}
            </span>
          ))}
        </div>
      )}
      <div className="mt-3 rounded-lg bg-accent-soft px-3 py-2 text-sm">
        <span className="font-semibold text-accent">Recommended: </span>
        {i.recommendedAction}
      </div>
      {i.potentialImpact && <div className="mt-2 text-xs text-muted">Potential impact: {i.potentialImpact} (not guaranteed)</div>}
    </div>
  );
}

const SUGGESTIONS = [
  'Which website performed best this month?',
  'Which application generated the highest revenue last month?',
  'Which keywords lost rankings in the last 28 days?',
  'Which pages need SEO improvement?',
  'Which country generates the most traffic?',
  'What was my total AdMob revenue yesterday?',
  'Compare all my websites this month.',
  'Which Android apps have the highest crash rates?',
  'What should I prioritize today?',
];

interface Msg {
  role: 'user' | 'assistant';
  content: string;
  tools?: string[];
}

/** Minimal, safe markdown: bold, bullets and pipe tables rendered as React elements (no HTML injection). */
function Markdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const out: React.ReactElement[] = [];
  const inline = (s: string, k: number) =>
    s.split(/(\*\*[^*]+\*\*)/g).map((p, j) => (p.startsWith('**') ? <strong key={`${k}-${j}`}>{p.slice(2, -2)}</strong> : <span key={`${k}-${j}`}>{p}</span>));
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*\|/.test(l)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        if (!/^\s*\|[\s:-]+\|/.test(lines[i]) || /[a-z0-9]/i.test(lines[i])) rows.push(lines[i].split('|').slice(1, -1).map((c) => c.trim()));
        i++;
      }
      i--;
      out.push(
        <div key={i} className="my-2 overflow-x-auto">
          <table className="w-full text-xs">
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri} className={ri === 0 ? 'font-bold' : 'border-t border-line'}>
                  {r.map((c, ci) => (
                    <td key={ci} className="px-2 py-1">{inline(c, ci)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (/^\s*[-*•]\s+/.test(l)) out.push(<li key={i} className="ml-4 list-disc">{inline(l.replace(/^\s*[-*•]\s+/, ''), i)}</li>);
    else if (/^#{1,4}\s/.test(l)) out.push(<div key={i} className="mt-2 font-bold">{inline(l.replace(/^#+\s/, ''), i)}</div>);
    else if (l.trim()) out.push(<p key={i} className="my-1">{inline(l, i)}</p>);
  }
  return <div className="text-sm leading-relaxed">{out}</div>;
}

function Chat({ configured }: { configured: boolean }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Braces matter: newer browsers return a Promise from scrollIntoView, and React
    // would treat any returned value as a cleanup function and crash calling it.
    end.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [msgs, busy]);

  const send = async (text: string) => {
    if (!text.trim() || busy) return;
    const next: Msg[] = [...msgs, { role: 'user', content: text.trim() }];
    setMsgs(next);
    setInput('');
    setBusy(true);
    try {
      const r = await post<{ answer: string; toolsUsed: string[]; model?: string }>('/api/ai/chat', { messages: next.map(({ role, content }) => ({ role, content })) });
      setMsgs([...next, { role: 'assistant', content: r.answer, tools: r.model ? [...r.toolsUsed, `via ${r.model}`] : r.toolsUsed }]);
    } catch (e) {
      setMsgs([...next, { role: 'assistant', content: `⚠️ ${errMsg(e)}` }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Analytics assistant" subtitle="Answers from your stored data with date ranges and sources" className="flex h-full flex-col">
      <div className="flex h-[560px] flex-col">
        <div className="flex-1 space-y-4 overflow-y-auto pr-1">
          {!msgs.length && (
            <div>
              <p className="mb-3 text-sm text-ink-2">Ask anything about your websites, apps and revenue:</p>
              <div className="flex flex-wrap gap-2">
                {SUGGESTIONS.map((s) => (
                  <button key={s} disabled={!configured} onClick={() => send(s)} className="rounded-full border border-line px-3 py-1.5 text-left text-xs text-ink-2 hover:border-accent hover:text-ink disabled:opacity-50">
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}
          {msgs.map((m, i) => (
            <div key={i} className={`flex gap-3 ${m.role === 'user' ? 'justify-end' : ''}`}>
              {m.role === 'assistant' && <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-gold-soft text-gold"><Bot className="h-4 w-4" /></div>}
              <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 ${m.role === 'user' ? 'bg-accent text-white' : 'border border-line bg-surface-2'}`}>
                {m.role === 'assistant' ? <Markdown text={m.content} /> : <p className="text-sm">{m.content}</p>}
                {m.tools && m.tools.length > 0 && <div className="mt-2 text-[10.5px] text-muted">Queried: {m.tools.join(', ').replace(/_/g, ' ')}</div>}
              </div>
              {m.role === 'user' && <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent"><UserIcon className="h-4 w-4" /></div>}
            </div>
          ))}
          {busy && (
            <div className="flex items-center gap-2 text-xs text-muted">
              <Sparkles className="h-4 w-4 animate-pulse text-gold" /> Analysing your data…
            </div>
          )}
          <div ref={end} />
        </div>
        <form
          className="mt-3 flex gap-2 border-t border-line pt-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void send(input);
          }}
        >
          <input value={input} onChange={(e) => setInput(e.target.value)} disabled={!configured} placeholder={configured ? 'Ask a question…' : 'Add an AI provider key in Settings to enable chat'} className="h-10 flex-1 rounded-lg border border-line-strong bg-surface-2 px-3 text-sm focus:border-accent focus:outline-none" maxLength={4000} />
          <Button type="submit" variant="primary" disabled={!configured || !input.trim()} loading={busy} icon={<Send className="h-4 w-4" />} />
        </form>
      </div>
    </Card>
  );
}

export default function AI() {
  const [priority, setPriority] = useState('');
  const [entityType, setEntityType] = useState('');
  const q = useQuery({ queryKey: ['insights', priority, entityType], queryFn: () => apiRaw<Insight[]>(`/api/ai/insights${qs({ priority, entityType })}`) });
  const configured = Boolean(q.data?.meta?.configured);
  const analyze = useAction(() => post('/api/ai/analyze', {}), { success: 'AI analysis queued — new recommendations appear in a minute or two', invalidate: [['sync-status']] });
  const dismiss = useAction((id: string) => patch(`/api/ai/insights/${id}`, { isDismissed: true }), { invalidate: [['insights']] });
  return (
    <div>
      <PageHeader
        eyebrow="Intelligence"
        title="AI Intelligence"
        subtitle="Recommendations generated only from evidence in your stored analytics."
        actions={<Button variant="gold" icon={<Wand2 className="h-4 w-4" />} disabled={!configured} loading={analyze.isPending} onClick={() => analyze.mutate(undefined)}>Run analysis now</Button>}
      />
      {q.data && !configured && <div className="mb-4"><Notice tone="warn">AI is not configured. Add an OpenAI, Gemini or OpenRouter key in Settings → AI providers (keys stay encrypted on the server).</Notice></div>}
      <div className="grid gap-5 xl:grid-cols-[1fr_440px]">
        <Card
          title="Recommendations"
          subtitle="Recommendations describe potential impact — they never guarantee rankings or earnings."
          actions={
            <>
              <Select value={entityType} onChange={(e) => setEntityType(e.target.value)} className="h-8 text-xs">
                <option value="">All sources</option>
                <option value="website">Websites</option>
                <option value="android_app">Android apps</option>
                <option value="admob">AdMob</option>
              </Select>
              <Select value={priority} onChange={(e) => setPriority(e.target.value)} className="h-8 text-xs">
                <option value="">All priorities</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </Select>
            </>
          }
        >
          {q.error && <ErrorBox error={q.error} />}
          {q.isLoading ? (
            <div className="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-40" />)}</div>
          ) : q.data?.data.length ? (
            <div className="grid gap-3 lg:grid-cols-2">{q.data.data.map((i) => <InsightCard key={i.id} i={i} onDismiss={() => dismiss.mutate(i.id)} />)}</div>
          ) : (
            <Empty title="No recommendations yet" icon={<Sparkles className="h-6 w-6" />}>Analysis runs automatically with the daily report, or click “Run analysis now” after your first sync.</Empty>
          )}
        </Card>
        <Chat configured={configured} />
      </div>
    </div>
  );
}
