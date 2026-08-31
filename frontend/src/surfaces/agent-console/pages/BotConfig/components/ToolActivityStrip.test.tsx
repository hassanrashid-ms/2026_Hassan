import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ToolActivityStrip } from './ToolActivityStrip.tsx';
import type { BotTestTurnDecision } from '@support/types';

describe('ToolActivityStrip', () => {
  it('shows the cited article and grounding score for a grounded answer', () => {
    const decision: BotTestTurnDecision = {
      kind: 'answer',
      reply: 'Go to settings and tap reset.',
      subintent_id: null,
      article_id: 'art-1',
      grounding: { score: 0.95, ungrounded: [] },
    };
    render(<ToolActivityStrip decision={decision} />);
    expect(screen.getByText(/art-1/)).toBeInTheDocument();
    expect(screen.getByText(/95%/)).toBeInTheDocument();
  });

  it('shows an answer with no citation as unsourced', () => {
    const decision: BotTestTurnDecision = {
      kind: 'answer',
      reply: 'Sure!',
      subintent_id: null,
    };
    render(<ToolActivityStrip decision={decision} />);
    expect(screen.getByText('Answered without a citation')).toBeInTheDocument();
  });

  it('renders a plain-language reason for a handoff', () => {
    const decision: BotTestTurnDecision = {
      kind: 'handoff',
      reason: 'unhelped_cap',
      subintent_id: null,
    };
    render(<ToolActivityStrip decision={decision} />);
    expect(screen.getByText('Gave up after too many unhelpful replies')).toBeInTheDocument();
  });

  it('renders an error state for an unavailable decision', () => {
    const decision: BotTestTurnDecision = { kind: 'unavailable', reason: 'timeout' };
    render(<ToolActivityStrip decision={decision} />);
    expect(screen.getByText(/timed out/)).toBeInTheDocument();
  });

  it('renders searches when present, regardless of kind', () => {
    const decision: BotTestTurnDecision = {
      kind: 'handoff',
      reason: 'no_article',
      subintent_id: null,
      searches: [{ query: 'refund', results: [{ id: 'a1', title: 'Refund policy' }] }],
    };
    render(<ToolActivityStrip decision={decision} />);
    expect(screen.getByText(/refund/)).toBeInTheDocument();
    expect(screen.getByText(/Refund policy/)).toBeInTheDocument();
  });
});
