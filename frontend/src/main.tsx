import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './index.css';
import { AuthProvider, RangeProvider, ToastProvider, useAuth } from './lib/context';
import { Layout } from './components/Layout';
import { Skeleton } from './components/ui';
import Login from './pages/Login';
import { ErrorBoundary, lazyPage } from './components/ErrorBoundary';

const Overview = lazyPage(() => import('./pages/Overview'));
const Onboarding = lazyPage(() => import('./pages/Onboarding'));
const Websites = lazyPage(() => import('./pages/Websites'));
const WebsiteDetail = lazyPage(() => import('./pages/WebsiteDetail'));
const Seo = lazyPage(() => import('./pages/Seo'));
const Keywords = lazyPage(() => import('./pages/Keywords').then((m) => ({ default: m.Keywords })));
const PagesPerf = lazyPage(() => import('./pages/Keywords').then((m) => ({ default: m.PagesPerformance })));
const Indexing = lazyPage(() => import('./pages/Indexing'));
const Traffic = lazyPage(() => import('./pages/Traffic'));
const Apps = lazyPage(() => import('./pages/Apps'));
const AppDetail = lazyPage(() => import('./pages/AppDetail'));
const PlayHealth = lazyPage(() => import('./pages/PlayHealth'));
const Admob = lazyPage(() => import('./pages/Admob'));
const AI = lazyPage(() => import('./pages/AI'));
const Reports = lazyPage(() => import('./pages/Reports'));
const Notifications = lazyPage(() => import('./pages/Notifications'));
const Integrations = lazyPage(() => import('./pages/Integrations'));
const SettingsPage = lazyPage(() => import('./pages/Settings'));

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 60_000, refetchOnWindowFocus: false, retry: (n, e) => n < 1 && !(e as { status?: number }).status } },
});

function Loading() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-64" />
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-28" />
        ))}
      </div>
      <Skeleton className="h-72" />
    </div>
  );
}

function Protected() {
  const { user, loading } = useAuth();
  const loc = useLocation();
  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-line border-t-cyan" />
      </div>
    );
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return (
    <Layout>
      <ErrorBoundary resetKey={loc.pathname}>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/websites" element={<Websites />} />
          <Route path="/websites/:id" element={<WebsiteDetail />} />
          <Route path="/seo" element={<Seo />} />
          <Route path="/keywords" element={<Keywords />} />
          <Route path="/pages" element={<PagesPerf />} />
          <Route path="/indexing" element={<Indexing />} />
          <Route path="/traffic" element={<Traffic />} />
          <Route path="/apps" element={<Apps />} />
          <Route path="/apps/:id" element={<AppDetail />} />
          <Route path="/play-health" element={<PlayHealth />} />
          <Route path="/admob" element={<Admob />} />
          <Route path="/ai" element={<AI />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/notifications" element={<Notifications />} />
          <Route path="/integrations" element={<Integrations />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      </ErrorBoundary>
    </Layout>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <RangeProvider>
            <BrowserRouter>
              <Routes>
                <Route path="/login" element={<Login />} />
                <Route path="/*" element={<Protected />} />
              </Routes>
            </BrowserRouter>
          </RangeProvider>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
