import { useState, type FormEvent } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Lock, Mail, ShieldCheck } from 'lucide-react';
import { useAuth, errMsg } from '../lib/context';
import { Button, Input } from '../components/ui';

export default function Login() {
  const { user, login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (user) return <Navigate to={loc.state?.from ?? '/'} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
      nav(loc.state?.from ?? '/', { replace: true });
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden overflow-hidden lg:block" style={{ background: 'linear-gradient(160deg,#0b1324 0%,#0a1a33 55%,#0b1324 100%)' }}>
        <svg className="absolute inset-0 h-full w-full opacity-40" aria-hidden>
          <defs>
            <pattern id="grid" width="48" height="48" patternUnits="userSpaceOnUse">
              <path d="M48 0H0V48" fill="none" stroke="rgba(148,163,184,0.12)" />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#grid)" />
        </svg>
        <div className="absolute -right-24 top-1/4 h-[420px] w-[420px] rounded-full border-[28px] border-cyan/20" />
        <div className="absolute -right-6 top-[calc(25%+90px)] h-[240px] w-[240px] rounded-full border-[14px] border-[#d6a84e]/30" />
        <div className="relative flex h-full flex-col justify-between p-14 text-white">
          <div className="text-[11px] font-bold tracking-[0.3em] text-cyan">DIGITAL PERFORMANCE 360</div>
          <div>
            <h1 className="max-w-md text-5xl font-extrabold leading-[1.05] tracking-tight">
              One control room for every site, app and revenue stream.
            </h1>
            <p className="mt-5 max-w-md text-[15px] text-slate-300">Search Console, Analytics, Google Play vitals and AdMob — synchronized, stored and analysed every day.</p>
          </div>
          <div className="flex gap-6 text-xs font-bold tracking-[0.18em] text-[#d6a84e]">
            <span>MONITOR</span>
            <span>ANALYZE</span>
            <span>OPTIMIZE</span>
            <span>GROW</span>
          </div>
        </div>
      </div>
      <div className="flex items-center justify-center p-6">
        <form onSubmit={submit} className="card w-full max-w-sm p-8">
          <div className="mb-6 flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <h2 className="text-2xl font-extrabold tracking-tight">Administrator sign in</h2>
          <p className="mt-1 text-sm text-ink-2">Private dashboard — authorised access only.</p>
          <div className="mt-6 space-y-3">
            <div className="relative">
              <Mail className="absolute left-3 top-3 h-4 w-4 text-muted" />
              <Input type="email" required autoComplete="username" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full pl-9" />
            </div>
            <div className="relative">
              <Lock className="absolute left-3 top-3 h-4 w-4 text-muted" />
              <Input type="password" required autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} className="w-full pl-9" />
            </div>
          </div>
          {error && <div className="mt-3 rounded-lg bg-bad-soft px-3 py-2 text-sm text-bad">{error}</div>}
          <Button type="submit" variant="primary" loading={busy} className="mt-5 w-full">
            Sign in
          </Button>
        </form>
      </div>
    </div>
  );
}
