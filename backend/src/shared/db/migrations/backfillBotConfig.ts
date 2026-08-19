import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/node-postgres'
import { Pool } from 'pg'
import { getEnv } from '../../../env.ts'
import { loadRootEnv } from '../../../env/loadRootEnv.ts'
import { logger } from '../../logging/logger.ts'
import { DEFAULT_BOT_PROMPT } from '../../../domain/bot/defaultPrompt.ts'
import { buildBaselineRules, type RuleEntry } from '../../../domain/bot/rulesCatalog.ts'
import { buildBaselineToolsConfig } from '../../../domain/bot/tools.ts'
import { buildBaselineLimits } from '../../../domain/bot/limitsCatalog.ts'
import { getOrCreateSystemActor } from '../../../domain/bot/systemActor.ts'
import { appendChangeLog } from '../../changeLog/appendChangeLog.ts'
import { BOT_CONFIG_ENTITY_TYPE } from '../../../domain/bot/botConfig.ts'

type LegacyRow = { workspaceId: string; prompt: string | null; rulesLegacyText: string | null }

/**
 * One-time data migration, run manually between the interim and finalize
 * schema migrations (see docs/plans/2026-08-19-bot-config-tab-implementation-plan.md
 * Task 3). Idempotent: a row whose `rules` column is already populated is
 * skipped, so re-running this after a partial failure is safe.
 */
export async function backfillBotConfig(url: string = getEnv().MIGRATION_DATABASE_URL): Promise<void> {
  const pool = new Pool({ connectionString: url })
  const db = drizzle(pool)
  try {
    const rows = await db.execute<LegacyRow & { rules: unknown }>(
      `select workspace_id as "workspaceId", prompt, rules_legacy_text as "rulesLegacyText", rules
         from bot_config where rules is null`,
    )

    for (const row of rows.rows as (LegacyRow & { rules: unknown })[]) {
      await db.transaction(async (tx) => {
        const actorId = await getOrCreateSystemActor(tx)

        const afterPrompt = row.prompt ?? DEFAULT_BOT_PROMPT
        const baseline = buildBaselineRules()
        const afterRules: RuleEntry[] =
          row.rulesLegacyText === null
            ? baseline
            : [
                ...baseline,
                { key: `legacy-${randomUUID()}`, text: row.rulesLegacyText, enabled: true, locked: false, source: 'custom' },
              ]
        const afterTools = buildBaselineToolsConfig()
        const afterLimits = buildBaselineLimits()

        await tx.execute(
          sql`update bot_config set prompt = ${afterPrompt}, rules = ${JSON.stringify(afterRules)}::jsonb, tools_config = ${JSON.stringify(afterTools)}::jsonb, limits_config = ${JSON.stringify(afterLimits)}::jsonb where workspace_id = ${row.workspaceId}`,
        )

        const changes = [
          ...(row.prompt === null ? [{ field: 'prompt', before: null, after: afterPrompt }] : []),
          { field: 'rules', before: row.rulesLegacyText, after: afterRules },
          { field: 'tools_config', before: null, after: afterTools },
          { field: 'limits_config', before: null, after: afterLimits },
        ]
        await appendChangeLog(tx, {
          workspaceId: row.workspaceId,
          entityType: BOT_CONFIG_ENTITY_TYPE,
          entityId: row.workspaceId,
          actorId,
          changes,
        })
      })
      logger.info('db', 'backfilled bot_config row', { workspaceId: row.workspaceId })
    }
  } finally {
    await pool.end()
  }
}

if (process.argv[1]?.endsWith('backfillBotConfig.ts')) {
  loadRootEnv(import.meta.url)
  await backfillBotConfig()
  logger.info('db', 'bot_config backfill complete')
}
