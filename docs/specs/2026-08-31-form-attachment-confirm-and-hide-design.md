# Form attachment field: confirm-before-send, hidden from the player's thread

## Problem

Two problems surfaced after using the redesigned attachment field
(`docs/specs/2026-08-31-form-attachment-upload-ui-design.md`) in the app:

1. **No chance to review or change the photo.** Picking a file immediately
   uploads it, sends it as a chat message, and advances the form — with no
   review step. Every other field type waits for an explicit Next/Submit tap
   before doing anything; the attachment field is the only one that commits
   itself the instant a file is chosen. If it was the form's last field, the
   form closes and hands off to an agent before the player can back out or
   swap the photo.
2. **The photo shows up as a normal chat bubble.** The player doesn't expect
   answering a form question to also post a visible message into the
   conversation — every other field type's answer is silent (`postFormAnswer`,
   never a message). The attachment field is the only one that is also a
   `sendPlayerMessage` call.

## Why the photo needs a message at all

The attachment answer's underlying file record (`attachment` table) is
**hard-linked to a message**: `attachment.message_id` is `NOT NULL`, and the
presigned-GET security check (`CLAUDE.md` Security section) walks
`attachment → message → visibility` to decide whether a caller may view the
file. That link is load-bearing, not incidental — reworking it to let an
attachment exist without a parent message would mean redesigning that
authorization path, which is out of scope here. So the message still gets
created (the agent needs to see the photo, same as today); only the
**player's own view of the thread** stops rendering it.

## Design

### 1. Defer the send until Next/Submit

`AttachmentField` (in `FormCard.tsx`) splits its single
"upload-then-send-then-advance" step into the same two-phase shape
`Composer.tsx` already uses for the agent-console composer:

- **Upload** happens the moment a file is picked (unchanged: instant local
  preview, real progress overlay). It returns `UploadedAttachment` (`{ key,
  filename, mimeType, byteSize }` — the type `Composer.tsx` already exports
  and `SupportChat.tsx` already imports) but does **not** post a message or
  advance the form.
- **Send** happens only when the player taps Next/Submit, exactly like every
  other field type's answer.

`AttachmentField` becomes a normal value/`onChange` field like the others:
its "value" is the `UploadedAttachment` once upload succeeds, `undefined`
before a file is picked or after it's removed. This plugs directly into
`FormCard`'s existing `draft`/`committed`/`changed`/required-field-gating
logic — no more separate `onUploading`/`onUploaded` advance path for
everything except still needing to disable Back/Skip/Next while an upload is
actively in flight (kept as a small `onUploading` callback, same as today).

A picked-and-uploaded (but not yet confirmed) file can be removed via an "×"
button on the thumbnail (mirroring `Composer.tsx`'s "Remove attachment"
button), clearing the value back to `undefined` so the player can pick a
different file before pressing Next.

`FormCard`'s `advance()` gains one branch: when the current field is type
`attachment` and its value changed, it calls the (renamed, simplified)
`onSendAttachment(fieldKey, attachment)` — no more `onProgress` parameter,
since the upload already happened — instead of `onAnswer`. Every other part
of `advance()` (the `isLast` → `onSubmit()` / `setIndex` tail, the
`setCommitted` bookkeeping) is unchanged and now applies uniformly to every
field type, attachment included.

**Restoring after Back:** if the player backs up past an already-answered
attachment field and returns to it, the local preview blob URL is gone
(the component unmounted). Rather than trying to re-fetch or re-derive a
preview, it renders a simple confirmed state — filename plus a checkmark and
a "Change" button — instead of the image thumbnail. No behavior existed here
before this change (the old design never restored anything for this field
either), so this is a new but minor affordance, not a regression.

### 2. Hide the resulting message from the player's own thread

The agent still needs to see the photo inline in their conversation view
(confirmed with the user — only the player's view changes). The fix marks
which messages exist purely to carry a form's attachment answer, so the
player-side webview can skip rendering them.

- **Schema:** add a nullable `form_field_key text` column to `message`
  (`backend/src/shared/db/schema/conversations.ts`). Null for every message
  except a form-attachment-answer send.
- **Write path:** `sendPlayerMessage` in
  `backend/src/surface/services/messagesService.ts` already validates,
  inside its existing `if (field?.type === 'attachment')` block, that
  `body.form_field_key` names a real, live, pending attachment field before
  writing the `formAnswer` row. Add one more statement in that same block,
  same transaction: `UPDATE message SET form_field_key = field.key WHERE id
  = posted.id`. Deliberately a follow-up update rather than passing it into
  `postMessage` at insert time — `postMessage` is the one shared choke point
  every message send (agent, bot, system, player) funnels through, and the
  field/submission validation this depends on only exists in the player
  attachment path; keeping the change local avoids touching that shared
  function's contract for every other caller.
- **Read path:** the player message-list query in `getPlayerMessages`
  (`messagesService.ts`) selects `message.formFieldKey`; `PostedMessageRow`
  (`backend/src/domain/conversations/postMessage.ts`) gains an optional
  `formFieldKey?: string | null` field; `toPlayerView`
  (`backend/src/domain/conversations/serializers.ts`) emits it as
  `form_field_key: row.formFieldKey ?? null`.
- **Wire contract:** `PlayerMessageView` (`packages/types/src/chat.ts`) gains
  `form_field_key: string | null`. Additive field on a response type — safe
  per the frozen-contract rule. `AgentMessageView` inherits it automatically
  (it's `PlayerMessageView & {...}`) but the agent console makes no use of
  it — the agent keeps seeing the message exactly as today.
- **Filtering:** `SupportChat.tsx` (webview only) filters
  `messagesQuery.data.messages` to drop any message with a non-null
  `form_field_key` before mapping to `chatMessages` for rendering. The
  player still sees their own picture immediately via `AttachmentField`'s
  own preview while answering the form; they just never see it reappear as a
  separate bubble afterward.

### Out of scope

- Removing the message/attachment link entirely (would require reworking
  presigned-GET authorization — a separate, security-sensitive change).
- Hiding the message from the agent's conversation view (explicitly kept
  visible there, per the user's choice).
- A DB migration for existing rows — `form_field_key` is nullable and only
  ever set going forward; no backfill needed.

## Files touched

**Backend:**
1. `backend/src/shared/db/schema/conversations.ts` — add nullable
   `form_field_key` column to `message`; generate the migration
   (`pnpm db:generate`).
2. `backend/src/domain/conversations/postMessage.ts` — add
   `formFieldKey?: string | null` to `PostedMessageRow`.
3. `backend/src/domain/conversations/serializers.ts` — `toPlayerView` emits
   `form_field_key`.
4. `packages/types/src/chat.ts` — `PlayerMessageView` gains `form_field_key:
   string | null`.
5. `backend/src/surface/services/messagesService.ts` — select
   `message.formFieldKey` in `getPlayerMessages`'s query; add the
   `UPDATE message SET form_field_key = ...` statement in `sendPlayerMessage`.

**Frontend:**
6. `frontend/src/surfaces/webview/components/chat/FormCard.tsx` —
   `AttachmentField` becomes value/`onChange`-driven with a remove/change
   affordance; `FormCardProps.onSendAttachment` signature changes to
   `(fieldKey: string, attachment: UploadedAttachment) => Promise<void>`
   (drops `onProgress`); `advance()` gains the attachment branch.
7. `frontend/src/surfaces/webview/pages/SupportChat.tsx` — split the current
   `onSendAttachment` prop into `onUploadAttachment` (upload only, keeps the
   `onProgress` threading from the prior task) and `onSendAttachment`
   (posts the message only, called at confirm time); filter
   `form_field_key`-tagged messages out of the rendered thread.
