import { describe, expect, it } from 'vitest'
import { isGrounded, MIN_GROUNDED_FRACTION, scoreGrounding } from '../src/domain/bot/grounding.ts'

/**
 * The check is deliberately lenient about grammar and strict about facts. These
 * pin both halves of that trade: a false rejection costs a tool call and, at
 * worst, ends the turn in a handoff — a safe outcome. A false acceptance puts an
 * invented promise in front of a player.
 */
const ARTICLE = [
  'Missing purchase',
  'If a purchase did not arrive, restart the game and open the shop. Your items are restored automatically. Contact support if they are still missing after the restart.',
]

describe('scoreGrounding', () => {
  it("accepts the article's own sentence unchanged", () => {
    const result = scoreGrounding('Restart the game and open the shop.', ARTICLE)
    expect(result.score).toBe(1)
    expect(isGrounded(result)).toBe(true)
  })

  it('accepts a resequenced, shortened rewrite that adds nothing', () => {
    const result = scoreGrounding('Open the shop after you restart — your items are restored automatically.', ARTICLE)
    expect(isGrounded(result)).toBe(true)
  })

  it("accepts the player's own words alongside the article's", () => {
    const sources = [...ARTICLE, 'i ordered treasure quest but it never showed up']
    const result = scoreGrounding('Your treasure quest items are restored automatically when you restart the game.', sources)
    expect(isGrounded(result)).toBe(true)
  })

  it('rejects an invented timeframe and names it', () => {
    const result = scoreGrounding('Restart the game. Your refund will arrive within 48 hours.', ARTICLE)
    expect(isGrounded(result)).toBe(false)
    expect(result.ungrounded).toEqual(expect.arrayContaining(['refund', '48']))
  })

  /**
   * The single most damaging substitution the bot can make, and the reason
   * numbers get no prefix leniency: "48" must never be grounded by "24".
   */
  it('rejects a number the article does not state even when every other word is grounded', () => {
    const sources = ['Refunds are issued within 24 hours.']
    const result = scoreGrounding('Refunds are issued within 48 hours.', sources)
    expect(isGrounded(result)).toBe(false)
    expect(result.ungrounded).toContain('48')
  })

  it('does not reject on inflection alone', () => {
    const result = scoreGrounding('Your item is restored when the purchases arrive.', ARTICLE)
    expect(isGrounded(result)).toBe(true)
  })

  it('scores an answer made only of function words as grounded, having claimed nothing', () => {
    expect(scoreGrounding('Yes, you can do that.', ARTICLE).score).toBe(1)
  })

  it('scores an answer with no relation to the article near zero', () => {
    const result = scoreGrounding('Equip the crimson banner from your seasonal loadout screen.', ARTICLE)
    expect(result.score).toBeLessThan(0.5)
    expect(isGrounded(result)).toBe(false)
  })

  it('caps the reported ungrounded words so a long fabrication cannot flood a log line', () => {
    const answer = 'alpha bravo charlie delta echo foxtrot golf hotel india juliett kilo lima mike november'
    expect(scoreGrounding(answer, ARTICLE).ungrounded).toHaveLength(10)
  })

  it('holds the threshold at the documented value', () => {
    // Guards the knob itself: loosening it is a product decision about how much
    // invention is tolerable, not a refactor.
    expect(MIN_GROUNDED_FRACTION).toBe(0.9)
  })
})
