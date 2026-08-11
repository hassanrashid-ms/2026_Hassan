export {}

// This MUST run before anything below is imported, not merely before `seed()` is called:
// `./client.ts` reads `getEnv()` at module top level to build its connection pool, and
// static `import` statements are fully evaluated before this file's own body runs — so a
// call interleaved among top-level imports would run too late. Dynamic `import()` defers
// evaluation to this exact point in the control flow, which is what makes the ordering
// here actually work when this file is executed directly by node.
const { loadRootEnv } = await import('../../env/loadRootEnv.ts')
loadRootEnv(import.meta.url)

const { randomUUID } = await import('node:crypto')
const { Client } = await import('pg')
const { DECLARED_FIELD_SEED } = await import('@support/types')
const { getEnv } = await import('../../env.ts')
const { agent, declaredField, workspaceMember, intent, subintent, article } = await import('./schema/index.ts')
const { eq, and } = await import('drizzle-orm')
const { closeDb } = await import('./client.ts')
const { withWorkspace, withoutWorkspace } = await import('./withWorkspace.ts')
const { generateWorkspaceSecret } = await import('../auth/workspaceSecret.ts')
const { logger } = await import('../logging/logger.ts')
const { SEED_TAXONOMY } = await import('./seedTaxonomy.ts')
const { upsertArticleObject } = await import('../weaviate/articlesIndex.ts')

const SLUG = process.env.SEED_WORKSPACE_SLUG ?? 'demo-workspace'
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.test'

/**
 * Seeds one workspace, one admin, the eleven declared fields, and the support intents
 * taxonomy (intents, subintents, and published articles indexed into Weaviate).
 */
export async function seed(): Promise<void> {
  const { secret, secretHash } = generateWorkspaceSecret(SLUG)

  // `workspace` is written on the OWNER connection, not the app pool: the app role
  // holds only SELECT there, so it cannot rewrite a workspace secret even if a
  // handler is compromised. Seeding is ops tooling, so the owner credential is
  // appropriate here and nowhere in the request path. See
  // docs/decisions/2026-08-04-unscoped-table-writes.md.
  const owner = new Client({ connectionString: getEnv().MIGRATION_DATABASE_URL })
  await owner.connect()
  let workspaceId: string
  try {
    const { rows } = await owner.query<{ id: string }>(
      `insert into workspace (id, name, slug, secret_hash) values ($1, 'Demo Game', $2, $3)
         on conflict (slug) do update set secret_hash = excluded.secret_hash
       returning id`,
      [randomUUID(), SLUG, secretHash],
    )
    if (!rows[0]) throw new Error('workspace upsert returned nothing')
    workspaceId = rows[0].id
  } finally {
    await owner.end()
  }

  // Everything below stays on the APP pool deliberately, so the seed exercises the
  // real RLS path rather than bypassing it.
  const { adminId, alexId, samId } = await withoutWorkspace(async (tx) => {

    // No password: agent auth is Google OAuth restricted to the mindstormstudios.com
    // org. google_subject stays null until this person's first real login.
    const [admin] = await tx
      .insert(agent)
      .values({ email: ADMIN_EMAIL, displayName: 'Seed Admin' })
      .onConflictDoUpdate({ target: agent.email, set: { displayName: 'Seed Admin' } })
      .returning({ id: agent.id })
    if (!admin) throw new Error('agent upsert returned nothing')

    const [alex] = await tx
      .insert(agent)
      .values({ email: 'alex@example.test', displayName: 'Alex Agent' })
      .onConflictDoUpdate({ target: agent.email, set: { displayName: 'Alex Agent' } })
      .returning({ id: agent.id })
    const [sam] = await tx
      .insert(agent)
      .values({ email: 'sam@example.test', displayName: 'Sam Agent' })
      .onConflictDoUpdate({ target: agent.email, set: { displayName: 'Sam Agent' } })
      .returning({ id: agent.id })
    if (!alex || !sam) throw new Error('agent upsert returned nothing')

    return { adminId: admin.id, alexId: alex.id, samId: sam.id }
  })

  // workspace_member and declared_field are BOTH scoped, so they belong here rather
  // than in the withoutWorkspace block above — an insert there would be refused by
  // the tenant policy's WITH CHECK. Only `workspace` and `agent` are unscoped.
  const insertedArticles: (typeof article.$inferSelect)[] = []
  let skippedArticles = 0
  await withWorkspace(workspaceId, async (tx) => {
    const now = new Date()
    await tx
      .insert(workspaceMember)
      .values({ workspaceId, agentId: adminId, role: 'admin' })
      .onConflictDoNothing()
    await tx
      .insert(workspaceMember)
      .values({ workspaceId, agentId: alexId, role: 'agent' })
      .onConflictDoNothing()
    await tx
      .insert(workspaceMember)
      .values({ workspaceId, agentId: samId, role: 'agent' })
      .onConflictDoNothing()

    for (const field of DECLARED_FIELD_SEED) {
      await tx
        .insert(declaredField)
        .values({ workspaceId, key: field.key, label: field.label, type: field.type })
        .onConflictDoNothing()
    }

    // `intent`/`subintent` are idempotent via their own unique indexes. `article` has
    // no such index (titles aren't unique in general), so idempotency is enforced
    // here with an explicit lookup — otherwise every re-run of this seed would
    // duplicate all sixteen articles.
    for (const intentData of SEED_TAXONOMY) {
      const [newIntent] = await tx
        .insert(intent)
        .values({ workspaceId, name: intentData.name })
        .onConflictDoNothing()
        .returning({ id: intent.id })

      if (newIntent) {
        for (const subintentName of intentData.subintents) {
          await tx
            .insert(subintent)
            .values({ workspaceId, intentId: newIntent.id, name: subintentName })
            .onConflictDoNothing()
        }

        for (const articleData of intentData.articles) {
          const [existing] = await tx
            .select({ id: article.id })
            .from(article)
            .where(and(eq(article.workspaceId, workspaceId), eq(article.title, articleData.title)))
            .limit(1)
          if (existing) {
            skippedArticles++
            continue
          }

          const [row] = await tx
            .insert(article)
            .values({
              workspaceId,
              intentId: newIntent.id,
              title: articleData.title,
              body: articleData.body,
              keywords: articleData.keywords,
              state: 'published',
              createdBy: adminId,
              publishedAt: now,
            })
            .returning()
          if (row) insertedArticles.push(row)
        }
      }
    }
  })

  // Indexed after the transaction commits, the same shape `publishArticle` sends
  // (backend/src/agent/services/articlesService.ts) — one Weaviate call per article,
  // not held open inside the Postgres transaction above.
  let indexedCount = 0
  for (const row of insertedArticles) {
    try {
      await upsertArticleObject({
        id: row.id,
        title: row.title,
        body: row.body,
        keywords: row.keywords,
        intentId: row.intentId,
        workspaceId: row.workspaceId,
      })
      indexedCount++
    } catch (e) {
      logger.warn('weaviate', `Failed to index article "${row.title}" into Weaviate: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  logger.info('db', `workspace   ${SLUG} (${workspaceId})`)
  logger.info('db', `admin       ${ADMIN_EMAIL}`)
  logger.info('db', `declared    ${DECLARED_FIELD_SEED.length} fields`)
  logger.info(
    'db',
    `intents     ${SEED_TAXONOMY.length} categories, ${SEED_TAXONOMY.reduce((n, i) => n + i.subintents.length, 0)} sub-intents, ${insertedArticles.length} articles created (${skippedArticles} already existed), ${indexedCount} indexed into Weaviate`,
  )
  logger.info('db', 'Workspace secret — printed only here, and only the game backend should hold it:')
  logger.info('db', `  ${secret}`)
  logger.info('db', 'Re-running this seed mints a NEW secret and invalidates the previous one.')
}

if (process.argv[1]?.endsWith('seed.ts')) {
  await seed()
  await closeDb()
}
