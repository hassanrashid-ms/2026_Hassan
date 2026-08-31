import type { BotTestTurnDecision } from '@support/types';

const HANDOFF_COPY: Record<string, string> = {
  asked_for_person: 'Player asked for a human',
  article_rejected: 'Player said the cited article did not help',
  no_article: 'No article answered the question',
  sensitive: 'Flagged as sensitive — handed off without searching',
  unsure: 'Ran out of tool-call budget this turn',
  turn_cap: 'Hit the max-bot-messages limit for this conversation',
  unhelped_cap: 'Gave up after too many unhelpful replies',
};

const UNAVAILABLE_COPY: Record<string, string> = {
  not_provisioned: 'Bot is not provisioned for this workspace',
  error: 'The model call failed',
  timeout: 'The model call timed out',
  invalid_response: 'The model returned neither a tool call nor any text',
};

export function ToolActivityStrip({ decision }: { decision: BotTestTurnDecision }) {
  return (
    <div className="mt-1 flex flex-col gap-1 rounded-md border border-muted/20 bg-accent-soft/50 p-2 text-xs text-muted">
      {decision.kind === 'answer' &&
        (decision.article_id ? (
          <p>
            Cited article <span className="font-mono">{decision.article_id}</span>
            {decision.grounding && (
              <>
                {' '}
                — grounding {Math.round(decision.grounding.score * 100)}%
                {decision.grounding.ungrounded.length > 0 && (
                  <> (ungrounded: {decision.grounding.ungrounded.join(', ')})</>
                )}
              </>
            )}
          </p>
        ) : (
          <p>Answered without a citation</p>
        ))}
      {decision.kind === 'resolve' && <p>Marked resolved</p>}
      {decision.kind === 'handoff' && <p>{HANDOFF_COPY[decision.reason]}</p>}
      {decision.kind === 'confirm_player_resolution' && (
        <p>Confirming the player&apos;s own words: &quot;{decision.quoted_text}&quot;</p>
      )}
      {decision.kind === 'unavailable' && (
        <p className="border-l-2 border-red-500 pl-2 text-red-600">
          Unavailable — {UNAVAILABLE_COPY[decision.reason]}
        </p>
      )}
      {decision.searches?.map((s, i) => (
        <p key={i} className="pl-2">
          Searched: <span className="font-mono">{s.query}</span> → {s.results.length} result
          {s.results.length === 1 ? '' : 's'}
          {s.results.length > 0 && <> ({s.results.map((r) => r.title).join(', ')})</>}
        </p>
      ))}
    </div>
  );
}
