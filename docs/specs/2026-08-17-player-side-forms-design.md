# Player-side forms — design

**Date:** 2026-08-17
**Status:** Approved
**Scope:** The player half of forms, in three slices: the data model with seeded forms, the in-chat
Q&A, and the agent's read of the answers. The admin form-builder is not here.

Supersedes the modal premise of `docs/specs/2026-08-11-forms-and-bot-config-data-model-design.md`.
Source of truth for product behaviour is `Docs/Customer Support Tool - CRM v2.txt` (pages 5, 21–23,
28).

---

## What this is

A form is a short set of structured questions attached to a subintent, asked in the chat before the
player reaches a human. It exists to remove a round trip: *"A purchase problem needs a receipt and a
store; a bug needs steps and a device. Asking before handoff saves an exchange, and in async support
an exchange is hours or days."*

The questions are asked **one at a time, in a card pinned above the composer** — not as a modal, and
not as conversation turns. The player answers, or skips; either way they reach an agent.

### The hard constraint

*"Nothing may prevent a player reaching a human."* Every decision below is checked against it. The
two places it bites are the skip (always present, one tap, cannot be removed) and the abandonment
sweeper (§2.6), and it is the reason `is_required` stays soft.

---

## Slices

| Slice | Ships | Done when |
|---|---|---|
| **1** Data model + seed | The forms half of the 2026-08-11 data-model spec, plus three published forms mapped to seeded subintents | `pnpm db:setup && pnpm db:seed` yields subintents that resolve to a published form |
| **2** Player Q&A | The offer at handoff, the pinned card, answer-per-step, skip, the gated status transition, the sweeper | A player rejects an article, answers inline, and the ticket reaches the queue only on submit/skip |
| **3** Agent display | The form section in the context rail | An agent opens the rail and reads what was answered and what was not |

Each slice depends only on the one before it.

---

# Slice 1 · Data model and seeded forms

## 1.1 What is inherited unchanged

`docs/specs/2026-08-11-forms-and-bot-config-data-model-design.md` is Accepted. Its `bot_config` and
`change_log` halves have shipped; its forms half has not. This slice executes that half **as
written**:

- `backend/src/shared/db/schema/forms.ts` — `form`, `form_version`, `form_submission`, `form_answer`
- `form_field_type` and `form_status` enums in `schema/enums.ts`
- `subintent.form_id` promoted from a bare uuid to a real composite FK; the
  `/** No form table yet, no FK yet. */` comment is deleted
- `UNIQUE (workspace_id, id)` on `conversation`
- `REVOKE UPDATE ON form_answer FROM support_app` in `002_rls.sql`
- `packages/types/src/forms.ts` — `formFieldSchema`, `formFieldsSchema`, `formAnswerValueSchemas`

Every column, constraint, composite FK and design rationale in that document stands. Its migration
ordering (§Migration steps 1–5, 8) stands. Its verification sections
(`tests/forms.dataModel.test.ts`, `tests/forms.types.test.ts`) stand.

Three amendments follow. Nothing else in that spec changes.

## 1.2 Amendment — the modal premise is reverted

That spec's premise is *"structured, Google-Form-style UIs opened in a modal — not questions asked
turn-by-turn in the thread"*, recorded in `docs/project-overview.md` on 2026-08-10. This design
reverts it: the questions are asked one at a time in the thread.

**The storage shape is unaffected.** Append-only `form_answer` rows keyed by `field_key`, each
snapshotting its `field_type`, is a better fit for one-at-a-time than for a modal — a modal submits
once and could have been a single row, whereas one-at-a-time writes a row per step and needs exactly
the durability that shape already provides.

What changes is prose, in three places:

1. The premise paragraph in the 2026-08-11 spec, which gains a pointer to this document.
2. The 2026-08-10 supersession note in `docs/project-overview.md`.
3. A third entry in `docs/decisions/spec-contradictions.md`.

## 1.3 Amendment — `form_status` is derived from the answer rows

The inherited spec defines `partial` as *"submitted with a required field left blank"*, which
presumes a submit button over a whole form. With one question at a time and a skip that can land at
any point, status is derived instead:

| `status` | Condition | Agent reads |
|---|---|---|
| `completed` | every field in the version has ≥1 answer | all questions answered |
| `partial` | ≥1 answer **and** ≥1 field with none | "2 answered · 4 not answered" |
| `skipped` | zero answers | "Player skipped the questions" |

This costs no column. The inherited spec already says *"Missing fields are derived: the version's
field keys minus the keys that have at least one answer"* — the same derivation, read once more to
pick the status.

Consequences worth stating:

- **`status` records the outcome, not the action.** A player who answers every question cannot skip
  (the card is gone), and a player who skips at question one has no answers, so the derived status
  and the button pressed never disagree in a way an agent can act on. *Which* action terminated the
  submission — submit, skip, or the sweeper — is a fact about the turn, and lives in the
  `form_completed` event's payload (§2.2), not in a column.
- **Partial answers survive a skip.** Two answers followed by a skip is `partial` with both rows
  intact, not `skipped` with the answers discarded. This is the behaviour the agent display in
  slice 3 depends on.
- `is_required` stays soft. A required field left blank still lands, because *"nothing about a form
  may block a player reaching a human."*

The three statuses remain terminal, and there is still no path back to `in_progress`.

## 1.4 Amendment — six usable field types, seven declared

The product spec is explicit: *"Six field types only — short text, long text, choice, date, number,
attachment — because a form is for collecting facts, not for building a UI."* The inherited data
model declares seven, adding `time`.

The enum stays at seven. Removing a value from a shipped enum is a migration for no gain, and the
inherited spec's reasoning for freezing the wire contract once applies to `time` as much as to
`attachment`. But:

- No seeded form uses `time`.
- The form-builder slice must not offer `time` or `attachment`.
- `attachment` remains declared-but-inert per the inherited spec — the submission service rejects it
  as unsupported until the `attachment` table exists.

## 1.5 The read helper

`backend/src/domain/forms/resolveSubintentForm.ts`:

```ts
export type ResolvedForm = {
  formId: string
  formName: string
  version: number
  fields: FormField[]
}

export async function resolveSubintentForm(tx: Tx, subintentId: string): Promise<ResolvedForm | null>
```

The inherited spec's three conditions, all of which must hold:

1. `subintent.form_id IS NOT NULL`
2. that form's `archived_at IS NULL`
3. that form has at least one version with `published_at IS NOT NULL`

The version returned is the highest `version` with `published_at IS NOT NULL`.

**A failure of any condition returns `null`, never an error.** Same shape as missing player state:
the conversation proceeds without a form. One function, so slice 2 has exactly one place that asks
"is there a form here" and cannot answer it two different ways.

## 1.6 Seed

`backend/src/shared/db/seedForms.ts`, beside `seedTaxonomy.ts`, consumed by `seed.ts`.

Three forms, matching the product spec's *"Starting templates: purchase receipt, bug report, account
recovery"*, each published at `version = 1`. Each serves several subintents, exercising the spec's
cardinality: *"A subintent maps to exactly one form. A form can serve several subintents."*

Mapping is by subintent **name**, resolved against `SEED_TAXONOMY` at seed time, so a taxonomy edit
does not strand a hardcoded uuid.

### Purchase receipt

The four fields drawn in the product spec's own mockup (page 23, screen C). Nothing invented.

| key | label | type | required | options |
|---|---|---|---|---|
| `store` | Store | `choice` | yes | Apple App Store, Google Play, Other |
| `order_or_receipt_id` | Order or receipt ID | `short_text` | yes | — |
| `purchase_date` | Date of purchase | `date` | yes | — |
| `what_you_expected` | What you expected | `long_text` | yes | — |

Serves: Missing Purchase, Double Charge, Refund Status, Refund Requests, Billing Errors.

### Bug report

| key | label | type | required |
|---|---|---|---|
| `what_happened` | What happened | `long_text` | yes |
| `steps_to_reproduce` | Steps to reproduce | `long_text` | no |
| `when_it_happened` | When it happened | `date` | no |
| `device_model` | Device model | `short_text` | no |
| `os_version` | OS version | `short_text` | no |

Serves: Game Crashes, Performance Issues, Connection Problems.

### Account recovery

| key | label | type | required | options |
|---|---|---|---|---|
| `last_known_player_id` | Your last known player ID | `short_text` | yes | — |
| `linked_account` | Linked account | `choice` | yes | Google Play, Apple Game Center, Guest, Not sure |
| `last_played` | When you last played | `date` | no | — |
| `what_changed` | What changed before you lost access | `long_text` | yes | — |

Serves: Account Recovery, Lost Progress, Data Recovery, Device Transfer.

### Everything else has no form

Roughly 25 of the seeded subintents map to nothing. This is deliberate — the null path is the common
one in production, and the seed must exercise it more than it exercises the happy path.

## 1.7 Verification

The inherited spec's `tests/forms.dataModel.test.ts` and `tests/forms.types.test.ts` sections stand
in full. This slice adds:

**`tests/forms.resolve.test.ts`**

- Returns `null`, without throwing, for each of the three failure conditions independently:
  `form_id` null, form archived, no published version.
- Returns the **highest** published version when several exist, and ignores an unpublished higher
  version.
- Returns `fields` in `position` order.

**`tests/seed.test.ts` additions**

- Exactly three forms exist, each with exactly one published version.
- Every mapped subintent name resolves to the expected form; a form serving five subintents is
  reachable from all five.
- No seeded field uses `time` or `attachment`.
- `formFieldsSchema` validates every seeded field array.

---

# Slice 2 · Player-side Q&A

## 2.1 When a form is offered

One new branch in the `handoff` case of `backend/src/domain/bot/applyBotTurn.ts`.

**The rule:** the conversation's subintent is not null, `resolveSubintentForm` returns non-null, and
the handoff reason is not `asked_for_person`.

That is the whole condition. Two exclusions fall out of it without special-casing:

- `turn_cap` — `toolLoop.ts:64` returns `subintentId: null`, so it never resolves a form.
- `unavailable` (any reason) — a different decision kind with no subintent at all.

And one exclusion is explicit:

- `asked_for_person` — the product spec requires *"Immediate redirect to an agent. Not after three
  turns, not after a failed answer."* Putting four questions in front of someone who just asked for
  a human is the exact behaviour that rule forbids.

`article_rejected`, `no_article` and `sensitive` all offer a form when a subintent resolves.
`article_rejected` is the product spec's step 6 verbatim; the other two are this design's extension
of it, justified by the same round-trip argument.

## 2.2 The split transaction

Today the `handoff` case does five things in one transaction: post the handoff line, classify,
assign an agent, set `status = 'open'`, append `bot_handoff`. When a form applies, those split across
two moments.

**At handoff — immediately, one transaction:**

1. Post the handoff line (`pickHandoffMessage()`, `authorType: 'system'`), exactly as today. The
   player is told they are being connected at the moment it is decided.
2. `classifyIfUnset`.
3. Insert `form_submission` — `status: 'in_progress'`, `form_version` snapshotted from
   `resolveSubintentForm`.
4. Set `conversation.confirm_phase = 'form'`.
5. Append a `form_offered` event.

**Status stays `bot_active`. No `assignOnHandoff`. No `bot_handoff` event.**

**At terminate — on submit or skip, one transaction:**

1. Derive `status` per §1.3, set `submitted_at`.
2. `assignOnHandoff`, then `status = 'open'`, `confirm_phase = 'none'`, `assigned_agent_id` set.
3. Append `bot_handoff` (carrying `reason` and `assigned_agent_id`, as today) and `form_completed`.
4. Post the summary system card.

The terminal half is one function — `backend/src/domain/forms/completeFormAndHandoff.ts` — called
from the submit route, the skip route and the sweeper. Three callers, one transaction shape, so the
three cannot drift into producing different end states.

`form_completed`'s payload is `{ status, terminated_by, answered_count, field_count }`, where
`terminated_by` is `'submit' | 'skip' | 'timeout'`. One event type rather than three, because the
outcome and the action are separate facts and a type name can only carry one of them. **The
`'timeout'` case is the load-bearing one:** a submission the sweeper closed and one the player
skipped produce the identical `form_submission` row, and they need opposite fixes — one is a form
nobody wanted, the other is a form that lost the player halfway. Following the existing rule that a
negative outcome must be falsifiable rather than inferred from absence.

`confirm_phase` gains `'form'`. `enums.ts:30` already reserves it: *"The forms slice adds 'form'."*

### Events

Three types. `event.type` is `text` (*"new types arrive every slice"*), so none needs a migration.
All three are written through `appendEvent`, in the same transaction as the state change they
explain, with `actorType: 'player'` and `actorId` the player id — except `form_offered`, which the
bot writes, and the sweeper's `form_completed`, which is `'system'` with a null actor.

| Type | When | Payload |
|---|---|---|
| `form_offered` | The offer transaction | `{ form_id, form_version, field_count }` |
| `form_field_answered` | Every accepted `POST /surface/form/answer` | `{ form_id, field_key, field_type, position, is_correction }` |
| `form_completed` | The terminate transaction | `{ status, terminated_by, answered_count, field_count }` |

**`form_field_answered` carries no answer value.** The value's durable home is `form_answer.value`,
which is RLS-scoped, append-only and read through one path. Copying player-written text into `event`
would put PII in a second table with different access characteristics and no consumer that needs it
— and *"treat `state.raw` as PII by default"* is the same instinct. The event records *that* a field
was answered and *which*, which is the whole of what the analysis needs.

What it makes answerable, and nothing else in the schema can:

- **Per-question drop-off.** A submission that timed out after question three is
  indistinguishable, in `form_answer`, from one that timed out after question three *last week* —
  but the gap between consecutive `form_field_answered` rows and the `form_completed` that never
  came is where a question that loses players shows up. A form nobody finishes is a form worth
  rewriting, and today that is invisible.
- **Time per question**, from the interval between consecutive events. A field averaging two
  minutes is a field asking for something the player has to go and look up.
- **Correction rate.** `is_correction` is true when an answer row already exists for that
  `field_key` — the append-only correction mechanism made visible. A field corrected often is a
  field whose label is unclear.

`position` is snapshotted rather than resolved from the version at read time, following the rule
that payload values are snapshots, never live pointers — so a field reordered in v2 does not rewrite
what question three meant in v1.

`answered_count` on `form_completed` is likewise a snapshot, not a live count, even though it is
derivable from the `form_field_answered` rows. Two rows disagreeing is a bug worth catching; a
report silently re-deriving it against a changed table is not.

**Volume.** One row per field per submission — a four-field form writes at most four, plus
corrections. `event` is append-only with a BRIN index on `created_at` and is already the spine every
bot turn writes to; this is a rounding error against `bot_search`.

`event.session_id` follows the existing rule — attribution, never a gate. The answer route carries a
player token, so the session id is confirmed with a scoped `(id, player_id)` select and stamped, or
degraded to `null` on any miss.

### Why the transition is gated at all

An agent picking up a handed-off conversation *"should not have to ask anything the bot already
covered."* If the ticket enters the queue at offer time, an agent can claim it and start replying
while the player is still on question two, which produces exactly the round trip the form exists to
remove. Gating the transition means the queue only ever receives finished tickets.

The player is not made to wait for anything: the handoff line and the first question both appear
immediately.

## 2.3 Routes

Conversation-implicit, following `/surface/resolution-answer` and `/surface/messages`:

```
POST /surface/form/answer   { field_key, value }
POST /surface/form/submit
POST /surface/form/skip
```

`answer` runs the inherited spec's five-step write, plus the event:

1. Resolve the submission's `(form_id, form_version)` to its `form_version.fields`.
2. Reject a `field_key` absent from that array.
3. Validate `value` against the field's declared type, plus `options` membership for `choice`.
4. Reject `attachment` as unsupported.
5. Insert a new row with `field_type` snapshotted from the resolved field. Never update.
6. Append `form_field_answered`, in the same transaction — a row written without its event, or an
   event without its row, is the divergence `appendEvent` exists to prevent.

A rejected answer writes neither. The event means *an answer was accepted*, so emitting one for a
validation failure would put a question in the drop-off numbers as answered when the player is still
looking at it.

`submit` and `skip` both call `completeFormAndHandoff`. They are the same function because the only
difference between them is which rows happen to exist, and §1.3 derives the status from exactly
that. Both are refused if the submission is already terminal — a terminal state has no transition
out of it.

All three are registered in `backend/src/docs/openapi.ts`.

### Why answer-per-step

Considered and rejected: collecting every answer client-side and submitting once. It loses
everything if the player drops mid-form, leaving a submission `in_progress` with no record of what
was answered; and to preserve partial answers on skip it has to send them anyway, so it does not
even buy a simpler client.

Also rejected: a server-driven wizard returning the next question per call. Nothing in the product
spec asks for conditional branching — *"a form is for collecting facts, not for building a UI"* — so
it pays for an unused capability and makes the card unable to render without a round trip.

## 2.4 Wire and state

`GET /surface/messages` already returns `confirm_phase` (`messagesService.ts:255`). It is extended
to return, when `confirm_phase === 'form'`, the resolved form and the answers recorded so far. A
reconnect therefore resumes at the right question with earlier answers intact.

`emitPhaseChanged` (`shared/realtime/emit.ts:45`) already emits `conversation:phase_changed` to both
the agent and player rooms, so no new socket event is needed — it is called on both transitions.

### A bug this slice must fix

`frontend/src/surfaces/webview/pages/SupportChat.tsx:168`:

```ts
const confirmPending = (messagesQuery.data?.confirm_phase ?? 'none') !== 'none'
```

Adding a third enum value silently makes the yes/no resolution banner render during the form phase.
It narrows to an explicit check for `'bot_article' | 'agent_ask'`.

## 2.5 The card

`frontend/src/surfaces/webview/components/chat/FormCard.tsx`, rendered in the slot the confirm
banner already occupies.

```
transcript
  bot: I'll get someone to help
  -- connecting you to support --

pinned card
  < Back            2 of 4
  When did this happen?
  [ 2026-08-16 ]          Next >
  Skip and talk to an agent

composer
  Type a message...       [disabled]
```

- **One field at a time**, with a `2 of 4` counter.
- **Back**, on every question but the first. It returns to the previous question with that field's
  current answer prefilled, read from the answers the card already holds. Changing it and pressing
  **Next** writes a *second* `form_answer` row — never an update, per
  `REVOKE UPDATE ON form_answer` — and the newest `created_at` wins on read. That second write is
  what sets `is_correction: true` on its `form_field_answered` event.

  Back is not optional politeness. A player who mistypes a receipt ID on a four-question form has no
  other recovery: they would have to finish, reach the agent, and be asked for it again — the exact
  round trip the form exists to remove.

  Pressing **Next** without changing a prefilled answer writes nothing. Re-submitting an identical
  value would inflate the correction rate with events that record no correction, and the append-only
  table would grow rows that differ only by timestamp.
- **"Skip and talk to an agent"** — the product spec's own button label (page 23, note 3). Present on
  every question. *"The skip option cannot be removed — a form must never block reaching support."*
- **The composer is disabled while the card is showing.** Same treatment the resolution banner
  already gets (`disabled={send.isPending || confirmPending || settled}`), extended with the form
  phase. There is no dead-end, because skip is one tap and always visible.
- Field rendering is a map from the six usable types to inputs. `choice` renders as buttons, not a
  `<select>` — the mockup draws it that way and it is one tap on a phone.
- Required fields do not block **Next**. `is_required` is soft.

**The card is not a message and writes no `message` rows for questions or answers.** It leaves
exactly one trace in the transcript: a summary system card posted at terminate, rendered with the
centered muted `authorType: 'system'` style that `ChatThread.tsx` already has.

Answers must never be posted as chat messages. They would then live in two places — `message` rows
and `form_answer` rows — which can disagree, and they would fill the agent transcript with
questionnaire noise that slice 3 renders properly anyway.

## 2.6 Abandonment sweeper

Gating the status transition creates a failure mode that does not exist today: a player who force-
quits mid-form leaves a conversation in `bot_active` with `confirm_phase = 'form'`, no agent
assigned, and nothing aware of it. That is *"nothing may prevent a player reaching a human"*
violated by accident.

`backend/src/shared/jobs/formTimeout.ts`, on the `sessionTimeout.ts` pattern:

- BullMQ repeatable, every 5 minutes.
- Selects `form_submission` rows with `status = 'in_progress'` and `started_at` older than
  **30 minutes**, whose conversation has `confirm_phase = 'form'`.
- Calls `completeFormAndHandoff` on each.

Answers so far are kept, the status derives normally, the ticket reaches the queue. A player who
returns later reads a thread in which they were handed off — which is what the handoff line already
told them, so nothing reads wrong.

30 minutes is chosen to be far longer than any plausible fill time and far shorter than a support
SLA. It is a constant in one file, tunable without a schema change.

**Without this job, gating is strictly worse than not gating.** It is part of slice 2, not a
follow-up.

## 2.7 Verification

**`backend/tests/forms.offer.test.ts`**

- Each handoff reason offers or does not offer a form per §2.1. `asked_for_person` never offers one
  even when the subintent resolves to a published form.
- A handoff whose subintent is null offers no form.
- A handoff whose subintent has no form produces **byte-identical** behaviour to today: agent
  assigned, `status = 'open'`, one `bot_handoff` event, `confirm_phase = 'none'`. This is the
  regression that matters most.
- At offer time: `status` is still `bot_active`, `assigned_agent_id` is null, no `bot_handoff` event
  exists, and the handoff line has been posted.

**`backend/tests/forms.submission.test.ts`**

- Status derivation: 4 of 4 → `completed`; 2 of 4 then skip → `partial` with both answers present;
  skip at question one → `skipped` with zero answer rows.
- After terminate: `status = 'open'`, an agent is assigned, `confirm_phase = 'none'`, exactly one
  `bot_handoff` event, and one `form_completed` whose `terminated_by` matches the route called.
- `answer` rejects an unknown `field_key`, a value of the wrong type, a `choice` outside its
  `options`, and any `attachment`.
- A second `submit` or `skip` on a terminal submission is refused.
- Answers written before a skip are readable afterwards.

**`backend/tests/forms.events.test.ts`**

- `form_offered` is written in the offer transaction, once, with the version and field count.
- One `form_field_answered` per accepted answer, in `position` order, each carrying `field_key`,
  `field_type` and `position`.
- **No `form_field_answered` carries the answer value** — assert the payload keys exactly, so a
  later change that adds `value` fails rather than quietly leaking PII into `event`.
- A **rejected** answer writes no event and no `form_answer` row.
- A second answer for the same `field_key` sets `is_correction: true`; the first sets `false`.
- `position` is the snapshot from the submission's version, not the current one, after the form is
  edited to v2 with fields reordered.
- Atomicity: an `appendEvent` failure rolls the `form_answer` insert back, exercised through a real
  transaction rather than a mock — the same assertion `changeLog.test.ts` makes.
- `session_id` is stamped when a verified session accompanies the request and is `null` on a miss,
  never causing the answer to be rejected.
- `answered_count` on `form_completed` equals the number of distinct answered `field_key`s, not the
  number of `form_field_answered` events, when a correction happened.

**`backend/tests/forms.timeout.test.ts`**

- A stale `in_progress` submission is terminated by the sweeper and reaches the identical
  `form_submission` and `conversation` end state as a manual skip, distinguishable only by
  `form_completed.terminated_by === 'timeout'`.
- A submission younger than the window is untouched.
- A conversation whose `confirm_phase` is not `'form'` is untouched.

**Frontend**

- The composer is disabled while the card shows.
- The resolution banner does **not** render when `confirm_phase === 'form'`.
- A reconnect mid-form resumes at the correct question with earlier answers present.
- Skip is present on every question, including the first and the last.
- `choice` renders as buttons; a required field does not block **Next**.
- **Back** is absent on question one and present on every other, and returns with the current answer
  prefilled.
- Changing a prefilled answer and pressing **Next** posts a new answer; pressing **Next** on an
  unchanged prefilled answer posts nothing.
- Going back and forward does not advance the counter past the furthest question reached, and does
  not re-ask a question already answered on the way forward.

---

# Slice 3 · Agent display

## 3.1 Where

A third stacked section in `frontend/src/surfaces/agent-console/pages/Inbox/components/ContextRail.tsx`,
below Player state and Tickets. Same rail, no tabs, no new surface.

The rail exists so an agent can *"diagnose most issues without leaving the conversation view"*, and
*"the agent never has to ask for something a form already collected"* is the same argument applied to
form answers.

Served by extending `GET /agent/conversations/:id/context` with a `form` block rather than adding an
endpoint — one rail, one query, one failure mode.

## 3.2 What it renders

`pages/Inbox/components/context/FormPanel.tsx`. Five states, one of which is nothing:

| State | Rail shows |
|---|---|
| No form for this subintent | **Section omitted entirely** |
| `in_progress` | "Player is answering · 2 of 4", plus the answers so far |
| `completed` | Every field, labelled, in `position` order |
| `partial` | Answered fields, then the gaps rendered as "Not answered" |
| `skipped` | "Player skipped the questions" |

The omission follows the rail's existing precedent — the `raw` section is omitted when it is `{}`
"rather than opening onto nothing". An empty panel explaining an absence is worse than no panel.

`partial` and `skipped` are the two states carrying the product requirement. *"Skipping still hands
off. The conversation is marked as form-skipped so the agent knows to ask rather than wondering where
the details went."* A skipped form must therefore be a visible row, never a missing section — the
agent has to be able to tell "declined" from "never offered".

Gaps in a `partial` render as rows rather than being dropped, for the same reason.

### Versioning

**Labels resolve against the submission's snapshotted `form_version`, never the current one.**
*"Editing a live form creates v4. Answers already collected stay readable against v3."* This is the
first real consumer of `form_submission.form_version` and the reason that column exists. The section
header names it: "Purchase receipt · v1".

**Values render from the answer's own snapshotted `field_type`**, not from the resolved field — the
inherited spec snapshots it precisely so *"`value` is interpretable without resolving the version."*
Only labels need the version join.

### Not shown

Correction history. The read rule is *"the row with the greatest `created_at`"* for a
`(form_submission_id, field_key)`; older rows stay queryable, but revision history in a rail nobody
asked for is noise.

## 3.3 Query invalidation

`ContextRail`'s query is deliberately socket-free with a long `staleTime`, because *"the snapshot is
immutable by construction and ticket history changes on the order of days."*

**A form in progress is not immutable.** And the unassigned queue is
`assigned_agent_id IS NULL AND status NOT IN (resolved, closed)`, which includes `bot_active` — so an
agent genuinely can open a ticket while the player is still filling the form.

So the context query invalidates on `conversation:phase_changed`, which the rail's room already
receives (`emit.ts:46`), and on nothing else. The
`staleTime` is not dropped: player state and ticket history keep it, and this is one narrow trigger
for the one mutable thing in the panel. A missed invalidation leaves the panel stale rather than
wrong, and the next navigation corrects it.

## 3.4 Queue label

`ConversationList` labels a row whose `confirm_phase === 'form'` as "Answering questions".

No new data — `AgentConversationSummary` already carries `confirm_phase`
(`conversationsService.ts:47`). Without the label, an unassigned `bot_active` ticket with no agent
and a half-filled form reads as a stuck ticket.

## 3.5 Verification

- Each of the five states renders, including the omission when there is no form.
- `partial` renders unanswered fields as gaps rather than dropping them — the assertion that carries
  the product requirement.
- Labels resolve against the submission's version: a form edited to v2 after a v1 submission still
  renders the v1 labels.
- Values render from the answer's snapshotted `field_type`, including a field whose type changed in
  a later version.
- The rail invalidates on `conversation:phase_changed` and not on unrelated socket traffic.
- `GET /agent/conversations/:id/context` returns `form: null` when the subintent has no form.
- The other two rail sections render normally when the form block errors.
- Read-only tickets are unaffected: the form section is read-only in every state, so
  `markAgentMessagesRead` is still not called for an earlier ticket.

---

## Out of scope

- **The admin form-builder.** Forms exist through seed data and Drizzle Studio until that spec lands.
  It owns: authoring, version minting, the immutability of a published version, `form.created_by`,
  archiving, and wiring `form` / `form_version` edits into `change_log`.
- **Attachments in forms.** `attachment` stays declared-but-inert until the `attachment` table
  exists.
- **Conditional fields.** Six field types, no branching.
- **Re-offering a form.** `UNIQUE (conversation_id, form_id)` — offered once per conversation,
  terminal either way. A reclassified conversation does not auto-offer its new subintent's form; the
  agent asks manually.
- **Correction history in the rail.**
- **Forms on agent-initiated conversations.** The offer is a bot-turn outcome only.
- **`rule` and `rule_firing`.** Unchanged from the inherited spec.

## Deviations recorded

`docs/decisions/spec-contradictions.md` gains one entry: forms are asked one question at a time in
the chat, not in a modal — reverting the 2026-08-10 supersession, with the storage shape unchanged.

The two entries the inherited data-model spec recorded are untouched.
