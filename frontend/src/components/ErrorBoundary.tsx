import { Component, lazy, type ComponentType, type ReactNode } from 'react';
import { RefreshCw, TriangleAlert } from 'lucide-react';

const RELOAD_KEY = 'dp360-chunk-reload';

const isChunkError = (e: unknown) => /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk/i.test(String((e as Error)?.message ?? e));

/**
 * After a new Vercel deployment the old page chunks no longer exist. An open tab
 * would then fail to load the next page; reload once to pick up the new build.
 */
export function lazyPage<T extends ComponentType<object>>(factory: () => Promise<{ default: T }>) {
  return lazy(async () => {
    try {
      const m = await factory();
      sessionStorage.removeItem(RELOAD_KEY);
      return m;
    } catch (err) {
      if (isChunkError(err) && !sessionStorage.getItem(RELOAD_KEY)) {
        sessionStorage.setItem(RELOAD_KEY, '1');
        window.location.reload();
        return new Promise<{ default: T }>(() => undefined); // keep suspended while reloading
      }
      throw err;
    }
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (e) => {
    if (!sessionStorage.getItem(RELOAD_KEY)) {
      e.preventDefault();
      sessionStorage.setItem(RELOAD_KEY, '1');
      window.location.reload();
    }
  });
}

/** Never leave a blank screen: show what happened and a way back. */
export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { resetKey?: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    if (!this.state.error) return this.props.children;
    const stale = isChunkError(this.state.error);
    return (
      <div className="card mx-auto mt-10 max-w-lg p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-warn-soft text-warn">
          <TriangleAlert className="h-6 w-6" />
        </div>
        <div className="text-lg font-bold">{stale ? 'A new version is available' : 'This page could not be displayed'}</div>
        <p className="mt-2 text-sm text-ink-2">{stale ? 'The dashboard was updated while this tab was open.' : this.state.error.message}</p>
        <button
          onClick={() => {
            sessionStorage.removeItem(RELOAD_KEY);
            window.location.reload();
          }}
          className="mt-5 inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-4 text-sm font-semibold text-white"
        >
          <RefreshCw className="h-4 w-4" /> Reload
        </button>
      </div>
    );
  }
}
