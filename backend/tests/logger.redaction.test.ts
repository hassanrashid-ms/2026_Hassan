// backend/tests/logger.redaction.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../src/shared/logging/logger.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('logger redaction', () => {
  it('redacts an Authorization header and leaves other headers untouched', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logger.info('http', 'GET /agent/conversations ▶ request', {
      headers: {
        authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def',
        cookie: 'session=abc123',
        'x-workspace-id': 'workspace-1',
      },
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const meta = spy.mock.calls[0]![1] as { headers: Record<string, unknown> };
    expect(meta.headers.authorization).toBe('[REDACTED]');
    expect(meta.headers.cookie).toBe('[REDACTED]');
    expect(meta.headers['x-workspace-id']).toBe('workspace-1');
  });

  it('redacts sensitive fields nested inside a response body', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

    logger.info('http', 'POST /auth/player-token -> 200', {
      responseBody: {
        token: 'super-secret-jwt',
        session: { apiKey: 'abc', password: 'hunter2' },
        player: { id: 'p1' },
      },
    });

    const meta = spy.mock.calls[0]![1] as {
      responseBody: {
        token: unknown;
        session: { apiKey: unknown; password: unknown };
        player: { id: unknown };
      };
    };
    expect(meta.responseBody.token).toBe('[REDACTED]');
    expect(meta.responseBody.session.apiKey).toBe('[REDACTED]');
    expect(meta.responseBody.session.password).toBe('[REDACTED]');
    expect(meta.responseBody.player.id).toBe('p1');
  });

  it('does not mutate the caller-provided meta object', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const meta = { headers: { authorization: 'Bearer secret' } };

    logger.info('http', 'GET /x', meta);

    expect(meta.headers.authorization).toBe('Bearer secret');
  });
});
