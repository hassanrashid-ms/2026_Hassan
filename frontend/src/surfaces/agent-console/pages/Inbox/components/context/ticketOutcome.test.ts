import { describe, expect, it } from 'vitest';
import { ticketOutcome } from './ticketOutcome.ts';

describe('ticketOutcome', () => {
  it('names the resolving agent', () => {
    expect(ticketOutcome('resolved', 'agent', 'Sam', 0)).toBe('Resolved by Sam');
  });

  it('names the bot', () => {
    expect(ticketOutcome('resolved', 'bot', null, 0)).toBe('Resolved by the bot');
  });

  it('falls back when the agent name is missing', () => {
    expect(ticketOutcome('resolved', 'agent', null, 0)).toBe('Resolved by an agent');
  });

  it('reads Closed when a finished ticket has no resolution source', () => {
    expect(ticketOutcome('closed', null, null, 0)).toBe('Closed');
  });

  it('names the forcing admin for a force-resolved ticket', () => {
    expect(ticketOutcome('resolved', 'admin_forced', 'Priya', 0)).toBe('Force-resolved by Priya');
  });

  it('falls back when the forcing admin name is missing', () => {
    expect(ticketOutcome('resolved', 'admin_forced', null, 0)).toBe('Force-resolved by an admin');
  });

  it('reads Resolved by an admin for legacy force-resolved rows with no resolution source', () => {
    expect(ticketOutcome('resolved', null, null, 0)).toBe('Resolved by an admin');
  });

  // The rail now lists the ticket the agent is currently reading, which is
  // usually live. Branching on resolution_source alone labelled every one of
  // these "Closed".
  it('reports the live state rather than an outcome for an unfinished ticket', () => {
    expect(ticketOutcome('open', null, null, 0)).toBe('Open');
    expect(ticketOutcome('new', null, null, 0)).toBe('New');
    expect(ticketOutcome('bot_active', null, null, 0)).toBe('With the bot');
    expect(ticketOutcome('awaiting_player', null, null, 0)).toBe('Awaiting player');
    expect(ticketOutcome('escalated', null, null, 0)).toBe('Escalated');
  });

  // A reopened ticket keeps the resolution_source of the resolution that was
  // undone; reading it as an outcome would call a live ticket "Resolved by Sam".
  it('does not call a reopened ticket resolved', () => {
    expect(ticketOutcome('open', 'agent', 'Sam', 1)).toBe('Open · reopened once');
  });

  it('appends the reopen count', () => {
    expect(ticketOutcome('resolved', 'agent', 'Sam', 1)).toBe('Resolved by Sam · reopened once');
    expect(ticketOutcome('resolved', 'agent', 'Sam', 2)).toBe('Resolved by Sam · reopened twice');
    expect(ticketOutcome('resolved', 'bot', null, 3)).toBe(
      'Resolved by the bot · reopened 3 times',
    );
    expect(ticketOutcome('closed', null, null, 4)).toBe('Closed · reopened 4 times');
  });
});
