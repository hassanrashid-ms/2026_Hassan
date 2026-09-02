import type { Tx } from '../../shared/db/withWorkspace.ts';
import { pickEligibleAgent } from '../routing/pickEligibleAgent.ts';

/**
 * Thin wrapper over pickEligibleAgent, kept as its own named export because
 * every bot-handoff call site (applyBotTurn.ts, completeFormAndHandoff.ts,
 * messagesService.ts) reads clearly as "assign on handoff" at the call site.
 * See pickEligibleAgent.ts for the actual selection logic and its rationale.
 */
export async function assignOnHandoff(tx: Tx, workspaceId: string): Promise<string | null> {
  const result = await pickEligibleAgent(tx, workspaceId);
  return result.agentId;
}
