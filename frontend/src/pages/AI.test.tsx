import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ToastProvider } from '../lib/context';
import AI from './AI';

const json = (data: unknown, meta?: unknown) => ({ ok: true, json: async () => ({ ok: true, data, meta }) });

describe('AI assistant', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('answers a suggested question even when scrollIntoView returns a Promise (newer Chrome)', async () => {
    // Newer browsers return a Promise here; returning it from an effect used to crash the page.
    Element.prototype.scrollIntoView = vi.fn(() => Promise.resolve()) as never;
    const f = vi.fn(async (url: string) =>
      url.includes('/api/ai/chat')
        ? json({ answer: 'Best website: **example.com**', toolsUsed: ['website_summary'], model: 'gemini/gemini-2.5-flash' })
        : json([], { configured: true }),
    );
    vi.stubGlobal('fetch', f);
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ToastProvider>
          <AI />
        </ToastProvider>
      </QueryClientProvider>,
    );
    const q = await screen.findByRole('button', { name: 'Which website performed best this month?' });
    await waitFor(() => expect(q).toBeEnabled());
    fireEvent.click(q);
    expect(await screen.findByText('example.com')).toBeInTheDocument();
    expect(screen.queryByText(/could not be displayed/i)).toBeNull();
  });
});
