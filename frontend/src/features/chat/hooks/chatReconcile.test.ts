import { describe, expect, it } from 'vitest';
import { reconcilePending, type PendingMessage } from './chatReconcile.ts';
import type { ChatMessage } from '../components/types.ts';

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'server-1',
    authorType: 'player',
    body: 'hi',
    createdAt: '2026-08-06T00:00:00Z',
    ...overrides,
  };
}

function pendingMsg(overrides: Partial<PendingMessage> = {}): PendingMessage {
  return { ...msg({ id: 'temp-1' }), tempId: 'temp-1', deliveryState: 'sending', ...overrides };
}

describe('reconcilePending', () => {
  it('keeps a pending message while the send is still in flight', () => {
    const pending = [pendingMsg()];
    expect(reconcilePending([], pending)).toEqual(pending);
  });

  it('drops a pending message once the server list contains the id its send returned', () => {
    const pending = [pendingMsg({ serverId: 'server-1' })];
    expect(reconcilePending([msg()], pending)).toEqual([msg()]);
  });

  it('keeps a pending message whose send has returned but whose refetch has not landed', () => {
    const pending = [pendingMsg({ serverId: 'server-9' })];
    expect(reconcilePending([msg()], pending)).toEqual([msg(), ...pending]);
  });

  it('never drops a pending message just because identical text already exists', () => {
    // The bug this replaced: an in-flight "hi" vanished the instant it was
    // added, because an older "hi" from the same author was already in the
    // thread — so repeated messages showed no optimistic bubble at all.
    const pending = [pendingMsg()];
    expect(reconcilePending([msg({ id: 'server-1', body: 'hi' })], pending)).toEqual([
      msg(),
      ...pending,
    ]);
  });
});
