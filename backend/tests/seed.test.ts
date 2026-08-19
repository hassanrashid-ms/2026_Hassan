import { and, eq } from 'drizzle-orm'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { seed } from '../src/shared/db/seed.ts'
import { intent } from '../src/shared/db/schema/index.ts'
import { withWorkspace } from '../src/shared/db/withWorkspace.ts'
import { closeDb } from '../src/shared/db/client.ts'
import { closeOwnerPool, ownerPool, truncateAll } from './helpers/db.ts'
import { formFieldsSchema } from '@support/types'
import { form, formVersion, subintent } from '../src/shared/db/schema/index.ts'
import { SEED_FORMS } from '../src/shared/db/seedForms.ts'
import { resolveSubintentForm } from '../src/domain/forms/resolveSubintentForm.ts'

const SLUG = process.env.SEED_WORKSPACE_SLUG ?? 'demo-workspace'

beforeEach(truncateAll)
afterAll(async () => {
  await closeDb()
  await closeOwnerPool()
})

async function workspaceIdBySlug(slug: string): Promise<string> {
  const { rows } = await ownerPool.query<{ id: string }>(`select id from workspace where slug = $1`, [slug])
  if (!rows[0]) throw new Error(`seed did not create a workspace with slug ${slug}`)
  return rows[0].id
}

describe('seed', () => {
  it('seeds exactly one is_system intent named Other, and re-running does not duplicate it', async () => {
    await seed()
    await seed()

    const workspaceId = await workspaceIdBySlug(SLUG)

    const rows = await withWorkspace(workspaceId, (tx) =>
      tx
        .select({ id: intent.id })
        .from(intent)
        .where(and(eq(intent.workspaceId, workspaceId), eq(intent.isSystem, true), eq(intent.name, 'Other'))),
    )
    expect(rows).toHaveLength(1)
  })

  it('seeds exactly three forms, each with exactly one published version, and re-running does not duplicate them', async () => {
    await seed()
    await seed()

    const workspaceId = await workspaceIdBySlug(SLUG)
    const rows = await withWorkspace(workspaceId, (tx) =>
      tx.select({ id: form.id, name: form.name }).from(form).where(eq(form.workspaceId, workspaceId)),
    )
    expect(rows.map((r) => r.name).sort()).toEqual(['Account recovery', 'Bug report', 'Purchase receipt'])

    for (const row of rows) {
      const versions = await withWorkspace(workspaceId, (tx) =>
        tx
          .select({ version: formVersion.version, publishedAt: formVersion.publishedAt })
          .from(formVersion)
          .where(eq(formVersion.formId, row.id)),
      )
      expect(versions, row.name).toHaveLength(1)
      expect(versions[0]?.version).toBe(1)
      expect(versions[0]?.publishedAt).not.toBeNull()
    }
  })

  it('resolves every mapped subintent name to its expected form, from all of them', async () => {
    await seed()
    const workspaceId = await workspaceIdBySlug(SLUG)

    for (const seedForm of SEED_FORMS) {
      for (const name of seedForm.subintents) {
        const [row] = await withWorkspace(workspaceId, (tx) =>
          tx
            .select({ id: subintent.id })
            .from(subintent)
            .where(and(eq(subintent.workspaceId, workspaceId), eq(subintent.name, name)))
            .limit(1),
        )
        expect(row, `no seeded subintent named ${name}`).toBeDefined()

        const resolved = await withWorkspace(workspaceId, (tx) => resolveSubintentForm(tx, row!.id))
        expect(resolved?.formName, name).toBe(seedForm.name)
        expect(resolved?.version, name).toBe(1)
      }
    }
  })

  it('leaves most subintents with no form — the null path is the common one', async () => {
    await seed()
    const workspaceId = await workspaceIdBySlug(SLUG)

    const rows = await withWorkspace(workspaceId, (tx) =>
      tx
        .select({ id: subintent.id, formId: subintent.formId })
        .from(subintent)
        .where(eq(subintent.workspaceId, workspaceId)),
    )
    const mappedCount = SEED_FORMS.reduce((n, f) => n + f.subintents.length, 0)
    expect(rows.filter((r) => r.formId !== null)).toHaveLength(mappedCount)
    expect(rows.filter((r) => r.formId === null).length).toBeGreaterThan(mappedCount)
  })

  it('uses no time and no attachment field — six usable types, seven declared', async () => {
    const types = SEED_FORMS.flatMap((f) => f.fields.map((field) => field.type))
    expect(types).not.toContain('time')
    expect(types).not.toContain('attachment')
  })

  it('validates every seeded field array against formFieldsSchema', async () => {
    for (const seedForm of SEED_FORMS) {
      const result = formFieldsSchema.safeParse(seedForm.fields)
      expect(result.success, `${seedForm.name}: ${JSON.stringify(result.error?.issues)}`).toBe(true)
      expect(seedForm.fields.length, seedForm.name).toBeGreaterThan(0)
    }
  })

  it('stores the fields the seed declares, in position order, through the resolver', async () => {
    await seed()
    const workspaceId = await workspaceIdBySlug(SLUG)

    const [row] = await withWorkspace(workspaceId, (tx) =>
      tx
        .select({ id: subintent.id })
        .from(subintent)
        .where(and(eq(subintent.workspaceId, workspaceId), eq(subintent.name, 'Missing Purchase')))
        .limit(1),
    )
    const resolved = await withWorkspace(workspaceId, (tx) => resolveSubintentForm(tx, row!.id))
    expect(resolved?.fields.map((f) => f.key)).toEqual([
      'store',
      'order_or_receipt_id',
      'purchase_date',
      'what_you_expected',
    ])
    expect(resolved?.fields[0]?.options).toEqual(['Apple App Store', 'Google Play', 'Other'])
  })
})
