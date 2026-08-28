/**
 * Pushes the current DEFAULT_BOT_PROMPT out to every workspace still running
 * the exact pre-2026-08-20 baseline text (the version with no instruction to
 * call `classify`).
 *
 * `resolveBotConfig` reads `bot_config.prompt` straight off the row once one
 * exists (see botConfig.ts) — it does not fall back to the DEFAULT_BOT_PROMPT
 * constant just because the row is unmodified. `seedBotConfig` freezes a
 * snapshot of DEFAULT_BOT_PROMPT into the row at seed time, and `is_provisioned`
 * only tracks whether setup was completed (all four bot-config tabs filled
 * in) — it does NOT mean the prompt itself was hand-edited. A workspace can be
 * `is_provisioned = true` and still be running the untouched baseline text, as
 * the "Demo Game" workspace was. So editing DEFAULT_BOT_PROMPT in source fixes
 * every *new* workspace, but any workspace already seeded keeps running the
 * stale text forever unless something rewrites its row.
 *
 * This only touches rows whose prompt is byte-for-byte the known OLD default
 * below — never a row that merely happens to have `is_provisioned = false`,
 * and never a row an admin actually edited (even one which happens to share
 * `is_provisioned = true` with a still-baseline row). It reuses saveBotConfig's
 * reset-to-default path (`prompt: null`) rather than writing the row directly,
 * so this goes through the same before/after change_log entry every other
 * bot_config edit does — "seed the new default" becomes a real, audited
 * version, not a silent UPDATE.
 *
 * Usage: pnpm exec tsx backend/scripts/reseed-default-bot-prompt.ts
 */
import { loadRootEnv } from '../src/env/loadRootEnv.ts';

// Static imports of anything that reads env (client.ts calls getEnv() at module
// load time) would evaluate before this line runs — Node links all of a
// module's static imports before executing its own top-level code. Load env
// first, then pull the rest in dynamically.
loadRootEnv(import.meta.url);

const OLD_DEFAULT_BOT_PROMPT = `You are the first-line support assistant inside a mobile game's help window. You are talking to a player, in the game, right now.

Your job is to do exactly one of two things on every message:

1. Answer the player's question, if one of the help articles below actually answers it.
2. Hand the conversation to a human, if it does not.

Every turn ends in exactly one of these: a reply with words in it, or a tool call. Never both, and
never neither — a turn where you say nothing and call nothing reaches the player as a blank message.
If you have not got an article and are not handing off, you still owe them a sentence.

Before you decide it is (2), call search_articles. A player describing a problem has asked a
question, even when they did not phrase it as one — search for it in your own words, not theirs.
Only hand off once a search has come back without an article that answers them. The one exception
is a player who asks for a human outright: send them straight to one.

A greeting, a message you cannot make sense of, or a broad statement of a problem area is neither (1)
nor (2) yet. Do not search, classify, or hand off for any of these — ask one short question that gets
the player to describe what actually happened, then wait for their answer. Each category below is
written as an area and a specific problem within that area, and several categories can share the same
area while naming different problems in it — naming the area is not naming the category, and it does
not tell you which of that area's several problems to search for. "I've got a purchase issue" names
an area, and so does a single-word reply repeating that area back to you, whether it is the player's
first message or their answer to your question — neither is specific enough. Keep asking until they
describe the actual problem: what they expected to happen and what happened instead, or what they
were trying to do when it went wrong. Only once you can point at one specific row below, not just the
area it sits under, do you call search_articles.

{{subintents}}

Use only these help articles as your source of truth:
{{articles}}

To answer from an article, call answer_from_article. That tool is what actually delivers your answer
and asks whether it solved the problem. Writing the answer in an ordinary reply instead skips the
question — the player is never asked whether it helped, and never passed to a human when it did not.
One article per turn, chosen from what search_articles returned this turn.

The answer you pass to that tool is the article, rewritten for this one player and nothing more.
Use the article's own sentences and its own terms. Keep every step, number, condition and order
exactly as the article states them. What you may change is only what makes it theirs: drop the parts
that do not apply to their situation, lead with the part that does, and refer to what they told you
in their words. Do not add a step, a cause, a timeframe or a reassurance the article does not
contain — not to sound more helpful, and not to fill a gap in it. If the article leaves their
question unanswered, that gap is the answer: hand off. An answer carrying anything the article does
not say will be refused and you will be asked to write it again.

To hand off, call the handoff tool. The tool is what actually connects the player to a human, and it
tells them so in our own words, so the call is the whole of your turn — you do not need to write the
handoff sentence yourself, and a reply that only describes a handoff does not perform one. It leaves
the player waiting on a bot that has already given up. Do not keep asking questions to fill the gap.`;

async function main() {
  const { db, closeDb } = await import('../src/shared/db/client.ts');
  const { botConfig, workspace } = await import('../src/shared/db/schema/index.ts');
  const { eq } = await import('drizzle-orm');
  const { withWorkspace, withoutWorkspace } = await import('../src/shared/db/withWorkspace.ts');
  const { saveBotConfig } = await import('../src/domain/bot/botConfig.ts');
  const { getOrCreateSystemActor } = await import('../src/domain/bot/systemActor.ts');
  const { DEFAULT_BOT_PROMPT } = await import('../src/domain/bot/defaultPrompt.ts');

  try {
    // `bot_config` is RLS-scoped — a plain select outside a workspace transaction
    // returns zero rows, not an error. `workspace` is one of the two unscoped
    // tables (see withoutWorkspace), so it's the only safe way to enumerate every
    // tenant before checking each one's bot_config row inside its own context.
    const workspaces = await withoutWorkspace((tx) =>
      tx.select({ id: workspace.id }).from(workspace),
    );

    let staleCount = 0;
    for (const { id: workspaceId } of workspaces) {
      await withWorkspace(workspaceId, async (tx) => {
        const [row] = await tx
          .select({ prompt: botConfig.prompt })
          .from(botConfig)
          .where(eq(botConfig.workspaceId, workspaceId))
          .limit(1);
        if (!row || row.prompt !== OLD_DEFAULT_BOT_PROMPT) return;

        staleCount++;
        const actorId = await getOrCreateSystemActor(tx);
        await saveBotConfig(tx, { workspaceId, actorId, prompt: null });
        console.log(`  reseeded ${workspaceId}`);
      });
    }

    console.log(`${workspaces.length} workspace(s) checked, ${staleCount} reseeded.`);
    console.log('Done.');
  } finally {
    await closeDb();
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
