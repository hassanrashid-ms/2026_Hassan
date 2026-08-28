import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { BootstrapResponse, PlayerStateAvailability } from '@support/types';
import { WebviewShell } from './WebviewShell.tsx';
import { useSupport } from './SupportContext.tsx';
import { fetchBootstrap } from '@/surfaces/webview/api/surfaceApi';

vi.mock('@/surfaces/webview/api/surfaceApi', () => ({
  fetchBootstrap: vi.fn(),
}));

const fetchBootstrapMock = vi.mocked(fetchBootstrap);

function bootstrapWith(availability: PlayerStateAvailability): BootstrapResponse {
  return {
    workspace: { name: 'Test Game' },
    session: {
      id: 'sess-1',
      entry_point: 'menu',
      started_at: '2026-08-17T00:00:00Z',
      ended_at: null,
    },
    player: { external_player_id: 'p-1' },
    player_state: { availability, captured_at: null, degraded_reason: null, declared: {} },
    unread_count: 0,
  };
}

function setLocation(url: string) {
  window.history.pushState(null, '', url);
}

function renderShell() {
  return render(
    <MemoryRouter>
      <Routes>
        <Route path="*" element={<WebviewShell />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The shell hands `error` to screens through context rather than rendering it
 *  itself whenever boot succeeded, so the poll tests need a screen to read it. */
function ErrorProbe() {
  const { error } = useSupport();
  return <div data-testid="probe-error">{error ?? ''}</div>;
}

function renderShellWithProbe() {
  return render(
    <MemoryRouter>
      <Routes>
        <Route path="*" element={<WebviewShell />}>
          <Route index element={<ErrorProbe />} />
          <Route path="*" element={<ErrorProbe />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('WebviewShell boot', () => {
  beforeEach(() => {
    delete (window as { SupportBridge?: unknown }).SupportBridge;
    fetchBootstrapMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never shows the technical no-token message while a bridge might still show up', () => {
    setLocation('/embed/support');

    renderShell();

    expect(screen.queryByText(/no session token was supplied/i)).not.toBeInTheDocument();
  });

  it('only falls back to the technical message once no bridge shows up in time', () => {
    vi.useFakeTimers();
    setLocation('/embed/support');

    renderShell();
    act(() => vi.runAllTimers());

    expect(screen.getByText('Open support from the game')).toBeInTheDocument();
  });

  it('asks the SDK to close instead of erroring on a stale reload with a session but no token', async () => {
    setLocation('/embed/support?session=abc-123');
    const post = vi.fn();
    window.SupportBridge = { post };

    renderShell();

    await waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'close' }));
    expect(screen.queryByText('Open support from the game')).not.toBeInTheDocument();
  });

  it('asks the SDK to close on a cold open too, once the bridge shows up', async () => {
    setLocation('/embed/support');
    const post = vi.fn();
    window.SupportBridge = { post };

    renderShell();

    await waitFor(() => expect(post).toHaveBeenCalledWith({ type: 'close' }));
    expect(screen.queryByText('Open support from the game')).not.toBeInTheDocument();
  });
});

describe('WebviewShell bootstrap poll', () => {
  beforeEach(() => {
    delete (window as { SupportBridge?: unknown }).SupportBridge;
    fetchBootstrapMock.mockReset();
    setLocation('/embed/support?session=abc-123#t=jwt');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lets queued promise callbacks run between fake-timer ticks. */
  async function tick(times: number) {
    for (let i = 0; i < times; i += 1) {
      await act(async () => {
        vi.advanceTimersByTime(POLL_INTERVAL_MS);
      });
    }
  }

  const POLL_INTERVAL_MS = 800;
  const MAX_POLL_ATTEMPTS = 15;

  it('stops polling as soon as player state lands', async () => {
    fetchBootstrapMock.mockResolvedValue(bootstrapWith('ok'));
    vi.useFakeTimers();

    renderShell();
    await act(async () => {});
    const afterMount = fetchBootstrapMock.mock.calls.length;

    await tick(5);

    // The mount fetch already resolved with 'ok', so the poll must never arm.
    expect(fetchBootstrapMock.mock.calls.length).toBe(afterMount);
  });

  /*
   * The bug this suite exists for. `data` was a dependency of the polling effect
   * while every successful poll called setData, so each tick tore the interval
   * down and rebuilt it with `attempts` back at 0. MAX_POLL_ATTEMPTS could then
   * only ever be reached on the all-throws path — a bootstrap that kept
   * succeeding with availability 'absent' polled forever, one request every
   * 800ms, which on a high-latency link queues faster than it drains.
   *
   * Player state that never arrives is a legitimate state, not an error: the
   * player just has no snapshot. So the poll gives up quietly and keeps the data
   * it has, rather than surfacing a failure screen.
   */
  it('gives up polling when player state never arrives, without erroring', async () => {
    fetchBootstrapMock.mockResolvedValue(bootstrapWith('absent'));
    vi.useFakeTimers();

    renderShell();
    await act(async () => {});

    await tick(MAX_POLL_ATTEMPTS + 5);

    // 1 mount fetch + at most MAX_POLL_ATTEMPTS polls, then silence.
    expect(fetchBootstrapMock.mock.calls.length).toBeLessThanOrEqual(MAX_POLL_ATTEMPTS + 1);

    const before = fetchBootstrapMock.mock.calls.length;
    await tick(5);
    expect(fetchBootstrapMock.mock.calls.length).toBe(before);

    expect(screen.queryByText(/could not load support/i)).not.toBeInTheDocument();
  });

  it('surfaces an error when bootstrap never succeeds at all', async () => {
    fetchBootstrapMock.mockRejectedValue(new Error('Could not load support.'));
    vi.useFakeTimers();

    renderShellWithProbe();
    await act(async () => {});

    await tick(MAX_POLL_ATTEMPTS + 1);

    // It stops rather than retrying forever...
    const before = fetchBootstrapMock.mock.calls.length;
    await tick(5);
    expect(fetchBootstrapMock.mock.calls.length).toBe(before);

    // ...and this is the one path that does surface a failure to the player,
    // because there is no data behind it to fall back on.
    expect(screen.getByTestId('probe-error')).toHaveTextContent('Could not load support.');
  });

  it('keeps showing data it already has instead of erroring when later polls fail', async () => {
    fetchBootstrapMock
      .mockResolvedValueOnce(bootstrapWith('absent'))
      .mockRejectedValue(new Error('Could not load support.'));
    vi.useFakeTimers();

    renderShellWithProbe();
    await act(async () => {});

    await tick(MAX_POLL_ATTEMPTS + 2);

    expect(screen.getByTestId('probe-error')).toHaveTextContent('');
  });
});
