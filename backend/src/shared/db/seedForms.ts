import { and, eq, inArray, isNull } from 'drizzle-orm'
import { formFieldsSchema, type FormField } from '@support/types'
import { form, formVersion, subintent } from './schema/index.ts'
import type { Tx } from './withWorkspace.ts'

export type SeedForm = {
  name: string
  /** Seeded subintents this form serves, BY NAME. Resolved against the rows
   *  seedTaxonomy created, so a taxonomy edit does not strand a hardcoded uuid. */
  subintents: string[]
  fields: FormField[]
}

/**
 * Three forms, matching the product spec's "Starting templates: purchase
 * receipt, bug report, account recovery". Each is published at version 1 and
 * serves several subintents, exercising the cardinality the spec states: a
 * subintent maps to exactly one form, a form can serve several subintents.
 *
 * No field uses `time` or `attachment`. The product spec names six usable types
 * and the enum declares seven; `time` is declared and unused, `attachment` is
 * declared and inert until the `attachment` table exists.
 *
 * The remaining ~28 seeded subintents map to NOTHING, deliberately: the null
 * path is the common one in production, so the seed must exercise it more than
 * it exercises the happy path.
 */
export const SEED_FORMS: SeedForm[] = [
  {
    name: 'Purchase receipt',
    // The four fields drawn in the product spec's own mockup (page 23, screen C).
    // Nothing invented.
    subintents: ['Missing Purchase', 'Double Charge', 'Refund Status', 'Refund Requests', 'Billing Errors'],
    fields: [
      {
        key: 'store',
        label: 'Store',
        type: 'choice',
        isRequired: true,
        position: 0,
        options: ['Apple App Store', 'Google Play', 'Other'],
        helperText: 'Where you made the purchase.',
      },
      {
        key: 'order_or_receipt_id',
        label: 'Order or receipt ID',
        type: 'short_text',
        isRequired: true,
        position: 1,
        placeholder: 'e.g. GPA.1234-5678-9012-34567',
        helperText: 'Found in your purchase confirmation email or receipt.',
      },
      {
        key: 'purchase_date',
        label: 'Date of purchase',
        type: 'date',
        isRequired: true,
        position: 2,
        helperText: "Can't be in the future.",
      },
      {
        key: 'what_you_expected',
        label: 'What you expected',
        type: 'long_text',
        isRequired: true,
        position: 3,
        placeholder: 'e.g. I expected to receive 500 gems after this purchase',
      },
    ],
  },
  {
    name: 'Bug report',
    subintents: ['Game Crashes', 'Performance Issues', 'Connection Problems'],
    fields: [
      {
        key: 'what_happened',
        label: 'What happened',
        type: 'long_text',
        isRequired: true,
        position: 0,
        placeholder: 'e.g. The app crashed when I opened the shop',
      },
      {
        key: 'steps_to_reproduce',
        label: 'Steps to reproduce',
        type: 'long_text',
        isRequired: false,
        position: 1,
        placeholder: 'e.g. 1. Open the app  2. Tap Shop  3. It crashes',
      },
      { key: 'when_it_happened', label: 'When it happened', type: 'date', isRequired: false, position: 2 },
      { key: 'device_model', label: 'Device model', type: 'short_text', isRequired: false, position: 3, placeholder: 'e.g. iPhone 14, Pixel 8' },
      { key: 'os_version', label: 'OS version', type: 'short_text', isRequired: false, position: 4, placeholder: 'e.g. iOS 17.4, Android 14' },
    ],
  },
  {
    name: 'Account recovery',
    subintents: ['Account Recovery', 'Lost Progress', 'Data Recovery', 'Device Transfer'],
    fields: [
      {
        key: 'last_known_player_id',
        label: 'Your last known player ID',
        type: 'short_text',
        isRequired: true,
        position: 0,
        placeholder: 'e.g. 8f3a2c1e',
        helperText: 'Found under Settings > Account in the game.',
      },
      {
        key: 'linked_account',
        label: 'Linked account',
        type: 'choice',
        isRequired: true,
        position: 1,
        options: ['Google Play', 'Apple Game Center', 'Guest', 'Not sure'],
      },
      { key: 'last_played', label: 'When you last played', type: 'date', isRequired: false, position: 2 },
      {
        key: 'what_changed',
        label: 'What changed before you lost access',
        type: 'long_text',
        isRequired: true,
        position: 3,
      },
    ],
  },
]

/**
 * Idempotent, like the rest of the seed. `form` is keyed by
 * UNIQUE (workspace_id, name) and `form_version` by UNIQUE (form_id, version),
 * so both inserts are ON CONFLICT DO NOTHING with an explicit lookup behind
 * them. The subintent mapping is a scoped UPDATE that only touches rows whose
 * `form_id` is still null, so a re-run never rewrites an admin's later choice.
 *
 * Runs on the APP pool inside the caller's withWorkspace transaction, so the
 * seed exercises the real RLS path rather than bypassing it.
 */
export async function seedForms(tx: Tx, workspaceId: string): Promise<{ forms: number; mapped: number }> {
  const now = new Date()
  let forms = 0
  let mapped = 0

  for (const seedForm of SEED_FORMS) {
    // Validate before writing. Nothing at the database layer checks `fields`, so
    // a malformed seed would otherwise ship a form the submission service can
    // never accept an answer for.
    const parsed = formFieldsSchema.safeParse(seedForm.fields)
    if (!parsed.success) {
      throw new Error(`Seed form "${seedForm.name}" has invalid fields: ${JSON.stringify(parsed.error.issues)}`)
    }

    let [row] = await tx
      .insert(form)
      .values({ workspaceId, name: seedForm.name })
      .onConflictDoNothing()
      .returning({ id: form.id })

    if (row) {
      forms++
    } else {
      ;[row] = await tx
        .select({ id: form.id })
        .from(form)
        .where(and(eq(form.workspaceId, workspaceId), eq(form.name, seedForm.name)))
        .limit(1)
    }
    if (!row) throw new Error(`form upsert returned nothing for "${seedForm.name}"`)

    await tx
      .insert(formVersion)
      .values({
        workspaceId,
        formId: row.id,
        version: 1,
        fields: parsed.data,
        publishedAt: now,
      })
      .onConflictDoNothing()

    const updated = await tx
      .update(subintent)
      .set({ formId: row.id })
      .where(
        and(
          eq(subintent.workspaceId, workspaceId),
          inArray(subintent.name, seedForm.subintents),
          isNull(subintent.formId),
        ),
      )
      .returning({ id: subintent.id })
    mapped += updated.length
  }

  return { forms, mapped }
}
