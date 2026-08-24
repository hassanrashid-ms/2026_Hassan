import { describe, expect, it } from 'vitest';
import {
  botFailureNote,
  HANDOFF_PLAYER_MESSAGES,
  pickHandoffMessage,
} from '../src/domain/bot/messages.ts';

describe('bot copy', () => {
  it('always picks a player-facing handoff line from the static list', () => {
    for (let i = 0; i < 50; i++) {
      expect(HANDOFF_PLAYER_MESSAGES).toContain(pickHandoffMessage());
    }
  });

  it('offers more than one line, so consecutive handoffs are not word-for-word identical', () => {
    expect(HANDOFF_PLAYER_MESSAGES.length).toBeGreaterThan(1);
    expect(new Set(HANDOFF_PLAYER_MESSAGES).size).toBe(HANDOFF_PLAYER_MESSAGES.length);
  });

  /**
   * The list serves both a deliberate handoff and a bot crash (`applyBotTurn`'s
   * `unavailable` branch), so no line may hint at which one the player got —
   * an apology or a "something went wrong" would leak the failure that the
   * internal note exists to record privately.
   */
  it('says a human is coming and nothing else — no apology, no promised wait, no failure hint', () => {
    for (const line of HANDOFF_PLAYER_MESSAGES) {
      expect(line.toLowerCase()).not.toMatch(
        /sorry|apolog|wrong|error|failed|unable|minute|hour|shortly|soon/,
      );
    }
  });

  it('embeds the reason in the internal failure note', () => {
    expect(botFailureNote('error')).toBe(
      'Bot could not respond (`error`). Handed off unclassified.',
    );
    expect(botFailureNote('timeout')).toBe(
      'Bot could not respond (`timeout`). Handed off unclassified.',
    );
  });
});
