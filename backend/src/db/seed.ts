import { dirname, join } from 'node:path'
import { config as loadDotenv } from 'dotenv'

// `pnpm --filter @support/api db:seed` sets cwd to backend/, but .env lives at the repo
// root one level above. Same pattern as db/setup.ts: dotenv's default override:false makes
// this a no-op when a caller (e.g. a test) already populated process.env.
//
// This MUST run before anything below is imported, not merely before `seed()` is called:
// `./client.ts` reads `getEnv()` at module top level to build its connection pool, and
// static `import` statements are fully evaluated before this file's own body runs — so a
// `loadDotenv()` call interleaved among top-level imports would run too late. Dynamic
// `import()` defers evaluation to this exact point in the control flow, which is what
// makes the ordering here actually work when this file is executed directly by node.
loadDotenv({ path: join(dirname(new URL(import.meta.url).pathname), '..', '..', '..', '.env') })

const { randomUUID } = await import('node:crypto')
const { Client } = await import('pg')
const { DECLARED_FIELD_SEED } = await import('@support/types')
const { getEnv } = await import('../env.ts')
const { agent, declaredField, workspaceMember } = await import('./schema/index.ts')
const { closeDb } = await import('./client.ts')
const { withWorkspace, withoutWorkspace } = await import('./withWorkspace.ts')
const { generateWorkspaceSecret } = await import('../auth/workspaceSecret.ts')

const SLUG = process.env.SEED_WORKSPACE_SLUG ?? 'demo-game'
const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL ?? 'admin@example.test'

/**
 * Seeds one workspace, one admin, and the eleven declared fields.
 *
 * The `Other` intent and its catch-all subintent are NOT seeded here: the taxonomy
 * tables arrive in migration 002. Nothing in build-order steps 1-3 classifies
 * anything, so there is nothing yet that needs somewhere to land. Seeding them is
 * the first task of the step-5 slice.
 */
async function seed(): Promise<void> {
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
  const { adminId } = await withoutWorkspace(async (tx) => {

    // No password: agent auth is Google OAuth restricted to the mindstormstudios.com
    // org. google_subject stays null until this person's first real login.
    const [admin] = await tx
      .insert(agent)
      .values({ email: ADMIN_EMAIL, displayName: 'Seed Admin' })
      .onConflictDoUpdate({ target: agent.email, set: { displayName: 'Seed Admin' } })
      .returning({ id: agent.id })
    if (!admin) throw new Error('agent upsert returned nothing')

    return { adminId: admin.id }
  })

  // workspace_member and declared_field are BOTH scoped, so they belong here rather
  // than in the withoutWorkspace block above — an insert there would be refused by
  // the tenant policy's WITH CHECK. Only `workspace` and `agent` are unscoped.
  await withWorkspace(workspaceId, async (tx) => {
    await tx
      .insert(workspaceMember)
      .values({ workspaceId, agentId: adminId, role: 'admin' })
      .onConflictDoNothing()

    for (const field of DECLARED_FIELD_SEED) {
      await tx
        .insert(declaredField)
        .values({ workspaceId, key: field.key, label: field.label, type: field.type })
        .onConflictDoNothing()
    }
  })

  console.log(`workspace   ${SLUG} (${workspaceId})`)
  console.log(`admin       ${ADMIN_EMAIL}`)
  console.log(`declared    ${DECLARED_FIELD_SEED.length} fields`)
  console.log('')
  console.log('Workspace secret — printed only here, and only the game backend should hold it:')
  console.log(`  ${secret}`)
  console.log('')
  console.log('Re-running this seed mints a NEW secret and invalidates the previous one.')
}

await seed()
await closeDb()
