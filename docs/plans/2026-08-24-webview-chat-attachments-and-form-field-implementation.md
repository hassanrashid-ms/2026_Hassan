# Webview Chat Attachments + Form Attachment Field Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the known limitation shipped in Phase 1 — a public image attachment is invisible to the player — by wiring the webview's read path to join `attachment` and sign URLs, giving the player's own composer the same send-an-image capability the agent console already has, and using that same send path to answer a form's `attachment` field type (currently hard-rejected).

**Architecture:** Three independent slices, in dependency order:

1. **Read path.** `getPlayerMessages` (`backend/src/surface/services/messagesService.ts`) gains the same `attachment` join + `presignGetObject` signing pass `getAgentConversationMessages` already has. `toPlayerView`/`toAgentView` already emit the non-URL `attachment` fields (Phase 1) — nothing there changes. `ChatBubbles.tsx` (webview) gains the one prop the agent console's `ThreadPanel` already passes to the same shared `MessageBody` component.
2. **Send path.** `sendPlayerMessage` gains the identical claim block Phase 1's `sendAgentMessage` has (HEAD-verify → CopyObject → insert `attachment` row, in the same transaction as the message insert), reachable through the same generic `/agent/uploads`-style presign/cancel endpoints — mirrored under `/surface/uploads` for the player token. The webview's `ChatComposer` passes the `allowAttachments`/`onUpload`/`onCancelUpload` props the shared `Composer` component already defines but the player surface currently omits (see the "Only the agent console passes these three" comment in `Composer.tsx`).
3. **Form attachment field.** This is a **design decision made in this plan, not previously specified beyond intent** (`docs/specs/2026-08-04-database-and-schema-design.md`:495-498 and `docs/decisions/spec-contradictions.md` §23 establish _that_ an attachment answer arrives as an ordinary image message, not _how_ the send is tied back to the form). The decision here: `SendMessageBody` gains an optional `form_field_key`; when present and it names the form's current pending `attachment` field, `sendPlayerMessage` — in the same transaction as the message+attachment insert — also inserts the `form_answer` row (`value: { attachmentId }`) and the `form_field_answered` event, exactly mirroring what `answerForm` already does for every other field type. `answerForm` itself keeps rejecting `attachment` outright; it is not the code path attachment answers use. **Review this design before executing Task 3** — it is the one part of this plan not already dictated by an approved spec.

**Tech Stack:** Drizzle ORM, Express 5, Zod, `@aws-sdk/client-s3` (via the existing storage choke point), React, TanStack Query, Socket.io.

**Spec:** `docs/specs/2026-08-24-minio-attachments-agent-chat-design.md` ("Out of scope" section — this plan closes that gap), `docs/specs/2026-08-04-database-and-schema-design.md`:495-498, `docs/decisions/spec-contradictions.md` §23, `docs/specs/2026-08-17-player-side-forms-design.md`.

## Global Constraints

- Images only: `image/png`, `image/jpeg`, `image/webp`, `image/gif`, reusing `ALLOWED_IMAGE_MIME_TYPES`/`MAX_ATTACHMENT_BYTES` from `backend/src/shared/storage/presign.ts` — no redeclaration.
- No hard deletes; `form_answer` stays append-only (`REVOKE UPDATE, DELETE` already enforces this structurally — this plan does not touch that).
- Pending upload key layout for the player surface: `pending/{workspaceId}/{playerId}/{uuid}.{ext}` — same shape as the agent's `pending/{workspaceId}/{agentId}/{uuid}.{ext}`, just keyed by player id instead of agent id.
- All new/changed routes are registered in `backend/src/docs/openapi.ts`.
- Follow existing repo conventions exactly: RLS is structural, `404` not `403` for "not yours", `sendError(res, status, code, message)`, `logger` never `console.*`.
- `FormCard.tsx`'s existing rule — "the card writes no message rows: answers live in `form_answer`" — is deliberately **not** followed by the `attachment` field type; that field is the one documented exception (per the spec decision above). Do not generalize this plan's message-row insert to any other field type.

---

### Task 1: Read path — join and sign attachments for the player

**Files:**

- Modify: `backend/src/surface/services/messagesService.ts`
- Test: `backend/tests/surface.messages.test.ts` (extend)

**Interfaces:**

- Consumes: `presignGetObject` from `backend/src/shared/storage/presign.ts`; `attachment` table (already imported wherever `conversationsService.ts` imports it from — `backend/src/shared/db/schema/index.ts`).
- Produces: `getPlayerMessages` now returns `PlayerMessageView[]` with `attachment.url` populated.

- [ ] **Step 1: Write the failing test**

Add to `backend/tests/surface.messages.test.ts`, reusing its existing `setup()` helper and app-under-test. This needs a real claimed attachment; the simplest path is inserting the `message` + `attachment` rows directly via `ownerPool`, since this file's app only mounts the surface's `messagesRouter` (no agent send path available here):

```ts
import { presignPutObject } from '../src/shared/storage/presign.ts';

describe('GET /messages with an attachment', () => {
  it('returns a fetchable presigned url for a public message with an attachment', async () => {
    const { workspaceId, playerId, sessionId, token } = await setup();
    const { rows: convRows } = await ownerPool.query<{ id: string }>(
      `insert into conversation (workspace_id, player_id, session_id, number) values ($1, $2, $3, 1) returning id`,
      [workspaceId, playerId, sessionId],
    );
    const conversationId = convRows[0]!.id;
    const { rows: msgRows } = await ownerPool.query<{ id: string }>(
      `insert into message (workspace_id, conversation_id, seq, author_type, body, visibility)
       values ($1, $2, 1, 'agent', 'diagram.png', 'public') returning id`,
      [workspaceId, conversationId],
    );
    const messageId = msgRows[0]!.id;

    const key = `ws/${workspaceId}/attachments/${crypto.randomUUID()}.png`;
    const body = Buffer.from('fake-png-bytes');
    const { url: putUrl } = await presignPutObject({
      key,
      contentType: 'image/png',
      contentLength: body.length,
    });
    await fetch(putUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png', 'Content-Length': String(body.length) },
      body,
    });
    await ownerPool.query(
      `insert into attachment (workspace_id, message_id, storage_key, mime_type, byte_size)
       values ($1, $2, $3, 'image/png', $4)`,
      [workspaceId, messageId, key, body.length],
    );

    const res = await request(app)
      .get(`/messages?session_id=${sessionId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    const withAttachment = res.body.messages.find((m: { attachment: unknown }) => m.attachment);
    expect(withAttachment.attachment.url).toBeTruthy();
    const getRes = await fetch(withAttachment.attachment.url);
    expect(getRes.status).toBe(200);
  });

  it('never signs an attachment on an internal-visibility message (unreachable via toPlayerView, verified defensively)', async () => {
    const { workspaceId, playerId, sessionId, token } = await setup();
    const { rows: convRows } = await ownerPool.query<{ id: string }>(
      `insert into conversation (workspace_id, player_id, session_id, number) values ($1, $2, $3, 1) returning id`,
      [workspaceId, playerId, sessionId],
    );
    await ownerPool.query(
      `insert into message (workspace_id, conversation_id, seq, author_type, body, visibility)
       values ($1, $2, 1, 'agent', 'internal note', 'internal')`,
      [workspaceId, convRows[0]!.id],
    );

    const res = await request(app)
      .get(`/messages?session_id=${sessionId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.messages).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && pnpm test tests/surface.messages.test.ts`
Expected: FAIL — `withAttachment` is `undefined` (no join exists yet).

- [ ] **Step 3: Implement the join and signing pass**

In `backend/src/surface/services/messagesService.ts`, add the import and update `getPlayerMessages`:

```ts
import { presignGetObject } from '../../shared/storage/presign.ts';
import { attachment } from '../../shared/db/schema/index.ts'; // add to the existing schema import list
```

Replace the message query and the return in `getPlayerMessages`:

```ts
const rows = await tx
  .select({
    id: message.id,
    conversationId: message.conversationId,
    seq: message.seq,
    authorType: message.authorType,
    authorAgentId: message.authorAgentId,
    body: message.body,
    articleId: message.articleId,
    visibility: message.visibility,
    deliveryState: message.deliveryState,
    readAt: message.readAt,
    createdAt: message.createdAt,
    authorAgentName: agent.displayName,
    authorPlayerName: player.externalId,
    attachmentId: attachment.id,
    attachmentStorageKey: attachment.storageKey,
    attachmentFilename: attachment.filename,
    attachmentMimeType: attachment.mimeType,
    attachmentByteSize: attachment.byteSize,
  })
  .from(message)
  .innerJoin(conversation, eq(conversation.id, message.conversationId))
  .innerJoin(player, eq(player.id, conversation.playerId))
  .leftJoin(agent, eq(agent.id, message.authorAgentId))
  .leftJoin(attachment, eq(attachment.messageId, message.id))
  .where(eq(message.conversationId, found.id))
  .orderBy(message.seq);

const storageKeyByMessageId = new Map(
  rows.filter((r) => r.attachmentStorageKey).map((r) => [r.id, r.attachmentStorageKey!]),
);
const views = await Promise.all(
  rows
    .map(toPlayerView)
    .filter((m): m is PlayerMessageView => m !== null)
    .map(async (view) => {
      if (!view.attachment) return view;
      const storageKey = storageKeyByMessageId.get(view.id);
      if (!storageKey) return view;
      try {
        return {
          ...view,
          attachment: { ...view.attachment, url: await presignGetObject(storageKey) },
        };
      } catch {
        // A broken attachment must not break loading the rest of the thread.
        return view;
      }
    }),
);

return {
  conversation_id: found.id,
  messages: views,
  status: found.status,
  confirm_phase: found.confirmPhase,
  form: found.confirmPhase === 'form' ? await loadPlayerForm(tx, found.id) : null,
};
```

(No visibility check is needed inside the signer: `toPlayerView` already returns `null` for any non-`public` row, and the `.filter()` above drops those before signing ever runs — an `internal` message's attachment is never fetched, matching the design doc's "visibility-gated reads" requirement structurally rather than by an explicit check in `presignGetObject`.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && pnpm test tests/surface.messages.test.ts`
Expected: PASS.

- [ ] **Step 5: Re-run the full backend suite**

Run: `cd backend && pnpm test`
Expected: PASS — confirms nothing else depended on `getPlayerMessages`'s prior row shape.

- [ ] **Step 6: Commit**

```bash
git add backend/src/surface/services/messagesService.ts backend/tests/surface.messages.test.ts
git commit -m "Sign attachment URLs on the player message-list read path"
```

---

### Task 2: Frontend — render attachments in the webview thread

**Files:**

- Modify: `frontend/src/surfaces/webview/components/chat/ChatBubbles.tsx`
- Test: `frontend/src/surfaces/webview/components/chat/ChatBubbles.test.tsx` (extend if it exists — check with `grep -rln "ChatBubbles" frontend/src/surfaces/webview` first; else add inline coverage in whatever file currently tests message rendering for this component)

**Interfaces:**

- Consumes: `ChatAttachment`/`attachment` field already on `ChatMessage` (Phase 1, `frontend/src/features/chat/components/types.ts`) and already rendered by `MessageBody` (Phase 1).
- Produces: nothing consumed elsewhere — purely wires an existing prop through.

- [ ] **Step 1: Write the failing test**

```tsx
it('renders an attachment image when the message carries one', () => {
  const message = {
    id: 'm1',
    authorType: 'agent' as const,
    body: 'diagram.png',
    attachment: {
      id: 'a1',
      filename: 'diagram.png',
      mimeType: 'image/png',
      byteSize: 10,
      url: 'https://minio.local/signed',
    },
    // ...whatever other fields this component's ChatMessage fixture already needs...
  };
  render(<ChatBubbles messages={[message]} /* ...other existing required props... */ />);
  expect(screen.getByAltText('diagram.png')).toHaveAttribute('src', 'https://minio.local/signed');
});
```

(Match the exact prop shape `ChatBubbles` already expects — read the component's props type before writing the fixture; do not guess field names not already confirmed in Phase 1's `ChatMessage`/`ChatAttachment` types.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd frontend && pnpm test src/surfaces/webview/components/chat/ChatBubbles.test.tsx`
Expected: FAIL — no image renders, since `attachment` is never passed to `MessageBody`.

- [ ] **Step 3: Pass the prop through**

In `ChatBubbles.tsx`, change:

```tsx
<MessageBody authorType={message.authorType} body={message.body} />
```

to:

```tsx
<MessageBody authorType={message.authorType} body={message.body} attachment={message.attachment} />
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd frontend && pnpm test src/surfaces/webview/components/chat/ChatBubbles.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/surfaces/webview/components/chat/ChatBubbles.tsx frontend/src/surfaces/webview/components/chat/ChatBubbles.test.tsx
git commit -m "Render chat attachment images in the webview thread"
```

---

### Task 3: Player-side upload endpoints

**Files:**

- Create: `backend/src/surface/routers/uploadsRouter.ts`
- Create: `backend/src/surface/controllers/uploadsController.ts`
- Create: `backend/src/surface/services/uploadsService.ts`
- Modify: `backend/src/surface/router.ts` (mount the new router)
- Modify: `packages/types/src/chat.ts` (reuse `RequestUploadBody`/`RequestUploadResponse`, already generic — no new types needed)
- Test: `backend/tests/surface.uploads.test.ts` (new)

**Interfaces:**

- Consumes: `AgentContext`-equivalent `PlayerContext` from `backend/src/shared/middleware/requirePlayerToken.ts`; `presignPutObject`, `deleteObject`, `ALLOWED_IMAGE_MIME_TYPES`, `MAX_ATTACHMENT_BYTES` from `backend/src/shared/storage/presign.ts`.
- Produces (used by Task 4): `buildPendingPlayerKey(workspaceId, playerId, contentType): string` (format `pending/{workspaceId}/{playerId}/{uuid}.{ext}`), `requestPlayerUpload`, `cancelPlayerUpload` — same shape as `backend/src/agent/services/uploadsService.ts`'s `requestUpload`/`cancelUpload`.

This task is a near-verbatim mirror of Phase 1's Task 3 (`backend/src/agent/{routers,controllers,services}/uploadsRouter.ts`), retargeted at `PlayerContext`. Rather than re-deriving the design, copy that module's structure directly.

- [ ] **Step 1: Write the failing test**

`backend/tests/surface.uploads.test.ts`, mirroring `backend/tests/agent.uploads.test.ts`'s structure but mounting `requirePlayerToken` + the new `uploadsRouter`, and minting a player token the way `backend/tests/surface.messages.test.ts`'s `setup()` does:

```ts
import express from 'express';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { req as request } from './helpers/http.ts';
import { closeDb } from '../src/shared/db/client.ts';
import { requirePlayerToken } from '../src/shared/middleware/requirePlayerToken.ts';
import { errorMiddleware } from '../src/errors.ts';
import { mintToken } from './helpers/playerToken.ts'; // use whatever helper surface.messages.test.ts already imports for this
import { uploadsRouter } from '../src/surface/routers/uploadsRouter.ts';
import { headObject } from '../src/shared/storage/presign.ts';
import { closeOwnerPool, seedWorkspace, seedPlayer, truncateAll } from './helpers/db.ts';

const app = express();
app.use(express.json());
app.use(requirePlayerToken, uploadsRouter);
app.use(errorMiddleware);

afterAll(async () => {
  await closeDb();
  await closeOwnerPool();
});

beforeEach(truncateAll);

describe('POST /uploads (player)', () => {
  it('returns a presigned PUT url for an allowed image type', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const token = await mintToken({
      workspace_id: workspaceId,
      player_id: playerId,
      external_player_id: 'p1',
    });

    const res = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'screenshot.png', content_type: 'image/png', byte_size: 1024 })
      .expect(200);

    expect(res.body.key).toContain(`pending/${workspaceId}/${playerId}/`);
  });

  it('422s for a disallowed content type', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const token = await mintToken({
      workspace_id: workspaceId,
      player_id: playerId,
      external_player_id: 'p1',
    });

    const res = await request(app)
      .post('/uploads')
      .set('Authorization', `Bearer ${token}`)
      .send({ filename: 'doc.pdf', content_type: 'application/pdf', byte_size: 1024 })
      .expect(422);
    expect(res.body.error.code).toBe('unsupported_media_type');
  });
});

describe('DELETE /uploads/:key (player)', () => {
  it('deletes an object the caller owns', async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const token = await mintToken({
      workspace_id: workspaceId,
      player_id: playerId,
      external_player_id: 'p1',
    });
    const key = `pending/${workspaceId}/${playerId}/${crypto.randomUUID()}.png`;

    await request(app)
      .delete(`/uploads/${encodeURIComponent(key)}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    expect(await headObject(key)).toBeNull();
  });

  it("404s for a key under a different player's path", async () => {
    const workspaceId = await seedWorkspace();
    const playerId = await seedPlayer(workspaceId);
    const token = await mintToken({
      workspace_id: workspaceId,
      player_id: playerId,
      external_player_id: 'p1',
    });
    const otherKey = `pending/${workspaceId}/${crypto.randomUUID()}/${crypto.randomUUID()}.png`;

    await request(app)
      .delete(`/uploads/${encodeURIComponent(otherKey)}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(404);
  });
});
```

Confirm the exact name/import path of the player-token-minting test helper (`mintToken` or equivalent) by checking the top of `backend/tests/surface.messages.test.ts` before writing this file — use whatever it actually imports.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd backend && pnpm test tests/surface.uploads.test.ts`
Expected: FAIL — `Cannot find module '../src/surface/routers/uploadsRouter.ts'`.

- [ ] **Step 3: Implement the service**

`backend/src/surface/services/uploadsService.ts` — identical to `backend/src/agent/services/uploadsService.ts` except the path segment and context type:

```ts
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { RequestUploadBody, RequestUploadResponse } from '@support/types';
import {
  ALLOWED_IMAGE_MIME_TYPES,
  MAX_ATTACHMENT_BYTES,
  deleteObject,
  presignPutObject,
} from '../../shared/storage/presign.ts';
import type { PlayerContext } from '../../shared/middleware/requirePlayerToken.ts';

function extensionFor(contentType: string): string {
  switch (contentType) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'bin';
  }
}

export function buildPendingPlayerKey(
  workspaceId: string,
  playerId: string,
  contentType: string,
): string {
  return `pending/${workspaceId}/${playerId}/${randomUUID()}.${extensionFor(contentType)}`;
}

export type RequestUploadResult =
  | ({ outcome: 'ok' } & RequestUploadResponse)
  | { outcome: 'invalid_media_type' }
  | { outcome: 'too_large' };

export async function requestPlayerUpload(
  ctx: PlayerContext,
  body: z.infer<typeof RequestUploadBody>,
): Promise<RequestUploadResult> {
  if (
    !ALLOWED_IMAGE_MIME_TYPES.includes(
      body.content_type as (typeof ALLOWED_IMAGE_MIME_TYPES)[number],
    )
  ) {
    return { outcome: 'invalid_media_type' };
  }
  if (body.byte_size > MAX_ATTACHMENT_BYTES) {
    return { outcome: 'too_large' };
  }
  const key = buildPendingPlayerKey(ctx.workspaceId, ctx.playerId, body.content_type);
  const { url, expiresAt } = await presignPutObject({
    key,
    contentType: body.content_type,
    contentLength: body.byte_size,
  });
  return { outcome: 'ok', key, upload_url: url, expires_at: expiresAt };
}

export async function cancelPlayerUpload(
  ctx: PlayerContext,
  key: string,
): Promise<'ok' | 'not_owner'> {
  const expectedPrefix = `pending/${ctx.workspaceId}/${ctx.playerId}/`;
  if (!key.startsWith(expectedPrefix)) return 'not_owner';
  await deleteObject(key);
  return 'ok';
}
```

- [ ] **Step 4: Implement the controller**

`backend/src/surface/controllers/uploadsController.ts` — identical to the agent version, swapping `req.agent!` for `req.player!` and the service imports:

```ts
import type { RequestHandler } from 'express';
import { RequestUploadBody } from '@support/types';
import { sendError } from '../../errors.ts';
import { cancelPlayerUpload, requestPlayerUpload } from '../services/uploadsService.ts';

export const postUploadRequestHandler: RequestHandler = async (req, res) => {
  const ctx = req.player!;
  const body = RequestUploadBody.safeParse(req.body);
  if (!body.success) {
    sendError(res, 422, 'invalid_request', 'filename, content_type and byte_size are required.');
    return;
  }
  if (body.data.byte_size > 10 * 1024 * 1024) {
    sendError(res, 422, 'invalid_request', 'byte_size exceeds the 10 MB limit.');
    return;
  }
  const result = await requestPlayerUpload(ctx, body.data);
  if (result.outcome === 'invalid_media_type') {
    sendError(res, 422, 'unsupported_media_type', 'Only PNG, JPEG, WEBP and GIF are accepted.');
    return;
  }
  if (result.outcome === 'too_large') {
    sendError(res, 422, 'invalid_request', 'byte_size exceeds the 10 MB limit.');
    return;
  }
  res
    .status(200)
    .json({ key: result.key, upload_url: result.upload_url, expires_at: result.expires_at });
};

export const deleteUploadHandler: RequestHandler = async (req, res) => {
  const ctx = req.player!;
  const key = req.params.key as string;
  const result = await cancelPlayerUpload(ctx, key);
  if (result === 'not_owner') {
    sendError(res, 404, 'not_found', 'Upload not found.');
    return;
  }
  res.status(204).send();
};
```

- [ ] **Step 5: Wire the router**

`backend/src/surface/routers/uploadsRouter.ts` — identical to the agent version:

```ts
import { Router } from 'express';
import { deleteUploadHandler, postUploadRequestHandler } from '../controllers/uploadsController.ts';

export const uploadsRouter = Router();
uploadsRouter.post('/uploads', postUploadRequestHandler);
uploadsRouter.delete(
  '/uploads/{*key}',
  (req, res, next) => {
    const raw = req.params.key;
    req.params.key = Array.isArray(raw) ? raw.join('/') : (raw ?? '');
    next();
  },
  deleteUploadHandler,
);
```

In `backend/src/surface/router.ts`, add the import and mount alongside the other routers:

```ts
import { uploadsRouter } from './routers/uploadsRouter.ts';
// ...
surfaceRouter.use(uploadsRouter);
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `cd backend && pnpm test tests/surface.uploads.test.ts`
Expected: PASS.

- [ ] **Step 7: Register both routes in OpenAPI**

In `backend/src/docs/openapi.ts`, near the `/agent/uploads*` registrations, add the `/surface/uploads` and `/surface/uploads/{key}` equivalents with the same shapes, `security: []` (no bearer scheme — surface routes use the player-token header pattern already documented for other `/surface/*` routes; match whatever security block those use).

- [ ] **Step 8: Commit**

```bash
git add backend/src/surface/routers/uploadsRouter.ts backend/src/surface/controllers/uploadsController.ts backend/src/surface/services/uploadsService.ts backend/src/surface/router.ts backend/tests/surface.uploads.test.ts backend/src/docs/openapi.ts
git commit -m "Add player-side presigned upload request and cancel endpoints"
```

---

### Task 4: Claim on `POST /messages`, plus the form-attachment-field linkage

**Files:**

- Modify: `packages/types/src/chat.ts` (`SendMessageBody`)
- Modify: `backend/src/surface/services/messagesService.ts`
- Modify: `backend/src/surface/controllers/messagesController.ts`
- Modify: `backend/src/errors.ts` (reuse existing `attachment_not_found`/`attachment_mismatch`/`unsupported_field_type` — no new codes needed)
- Test: `backend/tests/surface.messages.test.ts` (extend)

**Interfaces:**

- Consumes: `headObject`, `copyObject`, `deleteObject` from Task 3's storage module (already shared); `attachment` table; `formAnswer`, `formSubmission`, `formVersion` tables (already imported in this file).
- Produces: `sendPlayerMessage`'s result carries `message.attachment` populated the same way `sendAgentMessage`'s does.

- [ ] **Step 1: Extend `SendMessageBody`**

In `packages/types/src/chat.ts`, replace:

```ts
export const SendMessageBody = z.object({
  body: z.string().min(1).max(4000),
  session_id: z.uuid().optional(),
});
```

with:

```ts
export const SendMessageBody = z
  .object({
    body: z.string().max(4000),
    session_id: z.uuid().optional(),
    attachment: z
      .object({
        key: z.string().min(1),
        filename: z.string().min(1).max(255),
        mime_type: z.string().min(1),
        byte_size: z.number().int().positive(),
      })
      .optional(),
    /**
     * Present only when this send is answering a form's `attachment` field —
     * the client-local form progress (see FormCard.tsx) names which field it
     * is answering, since form state is never server-refetched mid-form.
     */
    form_field_key: z.string().min(1).optional(),
  })
  .refine((v) => v.body.trim().length > 0 || v.attachment !== undefined, {
    message: 'body must be non-empty, or an attachment must be provided',
    path: ['body'],
  });
```

- [ ] **Step 2: Write the failing tests**

Add to `backend/tests/surface.messages.test.ts`:

```ts
import { presignPutObject } from '../src/shared/storage/presign.ts';

async function uploadFixtureImage(workspaceId: string, playerId: string) {
  const key = `pending/${workspaceId}/${playerId}/${crypto.randomUUID()}.png`;
  const body = Buffer.from('fake-png-bytes');
  const { url } = await presignPutObject({
    key,
    contentType: 'image/png',
    contentLength: body.length,
  });
  await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/png', 'Content-Length': String(body.length) },
    body,
  });
  return key;
}

describe('POST /messages with an attachment', () => {
  it('claims the pending object and inserts an attachment row', async () => {
    const { workspaceId, playerId, token } = await setup();
    const key = await uploadFixtureImage(workspaceId, playerId);

    const res = await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({
        body: '',
        attachment: { key, filename: 'shot.png', mime_type: 'image/png', byte_size: 14 },
      })
      .expect(200);

    expect(res.body.message.body).toBe('shot.png');
    expect(res.body.message.attachment).toMatchObject({
      filename: 'shot.png',
      mime_type: 'image/png',
      byte_size: 14,
    });
  });

  it('422s with attachment_not_found for a bogus key', async () => {
    const { workspaceId, playerId, token } = await setup();
    const bogusKey = `pending/${workspaceId}/${playerId}/${crypto.randomUUID()}.png`;

    const res = await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({
        body: '',
        attachment: { key: bogusKey, filename: 'ghost.png', mime_type: 'image/png', byte_size: 14 },
      })
      .expect(422);
    expect(res.body.error.code).toBe('attachment_not_found');
  });
});

describe('POST /messages answering a form attachment field', () => {
  it('creates a form_answer with the attachment id and does not error', async () => {
    const { workspaceId, playerId, token } = await setup();
    // Seed a form with an `attachment` field, start a submission, and drive the
    // conversation into confirm_phase 'form' — mirror whatever seeding
    // `forms.submission.test.ts` already uses for this (seedForm/seedFormVersion/
    // seedFormSubmission), including one prior text-field answer if the form
    // requires the attachment field to not be first, per that form's fixture.
    // ...seeding omitted here; copy the exact pattern from forms.submission.test.ts...

    const key = await uploadFixtureImage(workspaceId, playerId);
    const res = await request(app)
      .post('/messages')
      .set('Authorization', `Bearer ${token}`)
      .send({
        body: '',
        attachment: { key, filename: 'receipt.png', mime_type: 'image/png', byte_size: 14 },
        form_field_key: 'proof_of_purchase', // match the seeded field's key
      })
      .expect(200);

    expect(res.body.message.attachment).toBeTruthy();
    const { rows } = await ownerPool.query(
      `select value from form_answer where field_key = 'proof_of_purchase'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toMatchObject({ attachmentId: expect.any(String) });
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd backend && pnpm test tests/surface.messages.test.ts`
Expected: FAIL — `res.body.message.attachment` is `undefined`, or the send 422s on the current schema's `body.min(1)`.

- [ ] **Step 4: Implement the claim logic**

In `backend/src/surface/services/messagesService.ts`, add imports:

```ts
import { randomUUID } from 'node:crypto';
import { copyObject, deleteObject, headObject } from '../../shared/storage/presign.ts';
import { attachment } from '../../shared/db/schema/index.ts';
```

Change `sendPlayerMessage`'s signature and body. Before the `withWorkspace` call, add the claim step (mirroring `sendAgentMessage`'s Task 4 in the Phase 1 plan) and change the return type:

```ts
export type SendPlayerMessageResult =
  | { outcome: 'ok'; conversation_id: string; message: PlayerMessageView | null }
  | { outcome: 'attachment_not_found' }
  | { outcome: 'attachment_mismatch' };

export async function sendPlayerMessage(
  ctx: PlayerContext,
  body: SendMessageBodyType,
): Promise<SendPlayerMessageResult> {
  let claimedDestKey: string | null = null;
  let pendingKeyToDelete: string | null = null;

  if (body.attachment) {
    const real = await headObject(body.attachment.key);
    if (!real) return { outcome: 'attachment_not_found' };
    if (
      real.contentType !== body.attachment.mime_type ||
      real.contentLength !== body.attachment.byte_size
    ) {
      return { outcome: 'attachment_mismatch' };
    }
    const extension = body.attachment.key.slice(body.attachment.key.lastIndexOf('.'));
    claimedDestKey = `ws/${ctx.workspaceId}/attachments/${randomUUID()}${extension}`;
    await copyObject({ sourceKey: body.attachment.key, destKey: claimedDestKey });
    pendingKeyToDelete = body.attachment.key;
  }

  const messageBody = body.body.trim().length > 0 ? body.body : body.attachment!.filename;

  const result = await withWorkspace(ctx.workspaceId, async (tx) => {
    // ...unchanged conversation lookup/open/reopen block from the existing function...

    const posted = await postMessage(tx, {
      workspaceId: ctx.workspaceId,
      conversationId,
      authorType: 'player',
      actorId: ctx.playerId,
      sessionId,
      body: messageBody,
    });

    let attachmentRow: { id: string } | null = null;
    if (body.attachment && claimedDestKey) {
      const [inserted] = await tx
        .insert(attachment)
        .values({
          workspaceId: ctx.workspaceId,
          messageId: posted.id,
          storageKey: claimedDestKey,
          mimeType: body.attachment.mime_type,
          byteSize: body.attachment.byte_size,
        })
        .returning();
      attachmentRow = { id: inserted!.id };
    }

    // Form-attachment-field linkage: only runs when the client says this send
    // is answering a specific field, and only writes anything if that field
    // really is the workspace's pending `attachment` field for this player's
    // live submission. Silently no-ops otherwise — an ordinary image message
    // sent outside of a form must never accidentally answer one.
    if (body.form_field_key && attachmentRow) {
      const [liveSub] = await tx
        .select({
          id: formSubmission.id,
          formId: formSubmission.formId,
          formVersion: formSubmission.formVersion,
        })
        .from(formSubmission)
        .where(
          and(
            eq(formSubmission.conversationId, conversationId),
            eq(formSubmission.status, 'in_progress'),
          ),
        )
        .limit(1);
      if (liveSub) {
        const [version] = await tx
          .select({ fields: formVersion.fields })
          .from(formVersion)
          .where(
            and(
              eq(formVersion.formId, liveSub.formId),
              eq(formVersion.version, liveSub.formVersion),
            ),
          )
          .limit(1);
        const field = version?.fields.find((f) => f.key === body.form_field_key);
        if (field?.type === 'attachment') {
          await tx.insert(formAnswer).values({
            workspaceId: ctx.workspaceId,
            formSubmissionId: liveSub.id,
            fieldKey: field.key,
            fieldType: 'attachment',
            value: { attachmentId: attachmentRow.id },
          });
          await appendEvent(tx, {
            workspaceId: ctx.workspaceId,
            type: 'form_field_answered',
            conversationId,
            sessionId,
            actorId: ctx.playerId,
            actorType: 'player',
            payload: {
              form_id: liveSub.formId,
              field_key: field.key,
              field_type: 'attachment',
              position: field.position,
              is_correction: false,
            },
          });
        }
      }
    }

    // ...unchanged reopenPosted / shouldEnqueue block...

    return {
      outcome: 'ok',
      conversationId,
      posted,
      reopenPosted,
      inboxStatus,
      shouldEnqueue,
    } as const;
  });

  if (result.outcome === 'ok' && pendingKeyToDelete) {
    await deleteObject(pendingKeyToDelete);
  }

  // ...unchanged emit / enqueue block, using `result.posted` as before...

  return {
    outcome: 'ok',
    conversation_id: result.conversationId,
    message: toPlayerView(result.posted),
  };
}
```

(The `...unchanged...` markers above mark blocks to carry over verbatim from the current function body shown in this file today — the conversation lookup/open/reopen logic, the `reopenPosted` handling, and the socket-emit/bot-enqueue tail are untouched by this task, only re-flowed around the new claim/insert/form-linkage code and the new result type.)

- [ ] **Step 5: Update the controller**

In `backend/src/surface/controllers/messagesController.ts`:

```ts
export const postMessageHandler: RequestHandler = async (req, res) => {
  const ctx = req.player!;
  const body = SendMessageBody.safeParse(req.body);
  if (!body.success) {
    sendError(
      res,
      422,
      'invalid_request',
      'body must be a non-empty string, or an attachment must be provided.',
    );
    return;
  }
  const result = await sendPlayerMessage(ctx, body.data);
  if (result.outcome === 'attachment_not_found') {
    sendError(res, 422, 'attachment_not_found', 'The uploaded file was not found or has expired.');
    return;
  }
  if (result.outcome === 'attachment_mismatch') {
    sendError(
      res,
      422,
      'attachment_mismatch',
      'The uploaded file does not match its declared type or size.',
    );
    return;
  }
  res.status(200).json({ conversation_id: result.conversation_id, message: result.message });
};
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && pnpm test tests/surface.messages.test.ts`
Expected: PASS.

- [ ] **Step 7: Re-run the full backend suite**

Run: `cd backend && pnpm test`
Expected: PASS — confirms `sendPlayerMessage`'s changed return shape didn't break other callers (bot pipeline tests, resolution tests, etc. that post player messages).

- [ ] **Step 8: Update OpenAPI**

In `backend/src/docs/openapi.ts`, extend the `/surface/messages` POST body schema with the optional `attachment` object (same shape as the `/agent/messages` registration) and the optional `form_field_key: z.string()`, and add `422` responses for `attachment_not_found`/`attachment_mismatch`.

- [ ] **Step 9: Commit**

```bash
git add packages/types/src/chat.ts backend/src/surface/services/messagesService.ts backend/src/surface/controllers/messagesController.ts backend/tests/surface.messages.test.ts backend/src/docs/openapi.ts
git commit -m "Claim uploaded attachments on player message send; link to form attachment field"
```

---

### Task 5: Frontend — webview composer send-attachment + the form attachment field UI

**Files:**

- Modify: `frontend/src/surfaces/webview/components/chat/ChatComposer.tsx`
- Modify: `frontend/src/surfaces/webview/pages/SupportChat.tsx`
- Modify: `frontend/src/surfaces/webview/api/surfaceApi.ts` (or wherever the webview's fetch wrappers live — confirm the exact filename with `grep -rl "sendMessage\|SendMessageBody" frontend/src/surfaces/webview` before editing)
- Modify: `frontend/src/surfaces/webview/components/chat/FormCard.tsx`
- Test: `frontend/src/surfaces/webview/components/chat/ChatComposer.test.tsx`, `frontend/src/surfaces/webview/components/chat/FormCard.test.tsx` (extend both)

**Interfaces:**

- Consumes: `Composer`'s existing `allowAttachments`/`onUpload`/`onCancelUpload` props (Phase 1); `POST /surface/uploads`, `DELETE /surface/uploads/:key` (Task 3); `POST /messages` with `attachment`/`form_field_key` (Task 4).
- Produces: none consumed elsewhere.

- [ ] **Step 1: Add upload/cancel/send API functions**

In the webview's API module, add the player-token equivalents of Phase 1's `agentApi.ts` functions:

```ts
export type RequestUploadResult = { key: string; upload_url: string; expires_at: string };

export function requestUpload(
  token: string,
  file: { filename: string; contentType: string; byteSize: number },
): Promise<RequestUploadResult> {
  return call(`/uploads`, token, {
    method: 'POST',
    body: JSON.stringify({
      filename: file.filename,
      content_type: file.contentType,
      byte_size: file.byteSize,
    }),
  });
}

export async function putFileToUploadUrl(uploadUrl: string, file: File): Promise<void> {
  const res = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type, 'Content-Length': String(file.size) },
    body: file,
  });
  if (!res.ok) throw new Error(`Upload failed with ${res.status}`);
}

export function cancelUpload(token: string, key: string): Promise<void> {
  return call(`/uploads/${key}`, token, { method: 'DELETE' });
}
```

Update the existing `sendMessage` function's signature to accept the optional attachment and `formFieldKey`, mirroring `agentApi.sendAgentMessage`'s change in Phase 1:

```ts
export function sendMessage(
  token: string,
  body: string,
  sessionId?: string,
  attachment?: { key: string; filename: string; mimeType: string; byteSize: number },
  formFieldKey?: string,
): Promise<{ conversation_id: string | null; message: PlayerMessageView | null }> {
  return call(`/messages`, token, {
    method: 'POST',
    body: JSON.stringify({
      body,
      session_id: sessionId,
      attachment: attachment
        ? {
            key: attachment.key,
            filename: attachment.filename,
            mime_type: attachment.mimeType,
            byte_size: attachment.byteSize,
          }
        : undefined,
      form_field_key: formFieldKey,
    }),
  });
}
```

- [ ] **Step 2: Write the failing `ChatComposer` test**

Check `ChatComposer.tsx`'s current props (it wraps the shared `Composer` and, per its own comment, "guarantees [no attachments] by not [passing the props]") before writing this test:

```tsx
it('passes allowAttachments and upload handlers through to the shared Composer', () => {
  const onUpload = vi.fn().mockResolvedValue({
    key: 'pending/ws/player/uuid.png',
    filename: 'shot.png',
    mimeType: 'image/png',
    byteSize: 3,
  });
  render(<ChatComposer onSend={() => {}} onUpload={onUpload} onCancelUpload={() => {}} />);
  expect(screen.getByLabelText('Attach image')).toBeInTheDocument();
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd frontend && pnpm test src/surfaces/webview/components/chat/ChatComposer.test.tsx`
Expected: FAIL — `ChatComposer` doesn't forward these props today.

- [ ] **Step 4: Wire `ChatComposer`**

Add `allowAttachments`, `onUpload`, `onCancelUpload` to `ChatComposer`'s prop type and pass them straight through to the underlying `Composer`, the same way it already forwards `onSend`/`disabled`/`placeholder`.

- [ ] **Step 5: Wire `SupportChat.tsx`'s call site**

At the `<ChatComposer ... />` call (line ~388 per the current file), add:

```tsx
allowAttachments={messagesQuery.data?.status !== 'bot_active'}
onUpload={async (file) => {
  const uploaded = await requestUpload(token, { filename: file.name, contentType: file.type, byteSize: file.size });
  await putFileToUploadUrl(uploaded.upload_url, file);
  return { key: uploaded.key, filename: file.name, mimeType: file.type, byteSize: file.size };
}}
onCancelUpload={(key) => { void cancelUpload(token, key); }}
```

Update the existing `onSend` handler passed to `ChatComposer` to forward the attachment argument into `sendMessage(...)` (its third positional argument from Step 1), and to include the current form's pending `attachment`-field key when `confirmPhase === 'form'` and the active field is that type — read this off the same local form-progress state `FormCard` already derives, lifted or duplicated one level up into `SupportChat.tsx` only as far as is needed to know "is the current field an attachment field, and if so what's its key" (do not lift `FormCard`'s full draft/committed state — that stays local to the card per its existing design comment).

**Bot can't read images:** `allowAttachments` is gated on `messagesQuery.data?.status !== 'bot_active'`, not passed unconditionally — a bot-answered turn has no path to see or act on an image, so the attach control must not be offered while the bot is the active responder. This mirrors the existing pattern at line ~414 where the composer is already disabled based on conversation status (`settled`), rather than adding new enforcement machinery. Add a test in `SupportChat.test.tsx` asserting the attach control (`getByLabelText('Attach image')` or equivalent, whatever `Composer`/`ChatComposer` actually renders) is absent/not-queryable when `status: 'bot_active'` and present once status moves to `'open'`/`'escalated'`/`'awaiting_player'`. This is UI-only gating (same as the existing `settled` gate) — no backend change in Task 4 is required for this; a message with an attachment sent while `bot_active` is not something the API needs to reject, it is simply not offerable in the composer.

- [ ] **Step 6: Write the failing `FormCard` test**

```tsx
it('renders an attach-image control for the attachment field type instead of the inert message', () => {
  const form = {
    /* ...seed with one field: { key: 'proof', type: 'attachment', position: 0, label: 'Upload a photo' }... */
  };
  render(
    <FormCard
      form={form}
      onAnswer={vi.fn()}
      onSubmit={vi.fn()}
      onSkip={vi.fn()}
      busy={false}
      onSendAttachment={vi.fn()}
    />,
  );
  expect(screen.getByLabelText('Attach image')).toBeInTheDocument();
  expect(screen.queryByText('This question cannot be answered here yet.')).not.toBeInTheDocument();
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `cd frontend && pnpm test src/surfaces/webview/components/chat/FormCard.test.tsx`
Expected: FAIL — the `case 'attachment':` branch still renders the inert placeholder text.

- [ ] **Step 8: Implement the attachment field UI**

`FormCard` gains a new required prop, `onSendAttachment: (fieldKey: string, file: File) => Promise<void>` — the parent (`SupportChat.tsx`) implements this as upload → claim-on-send via `sendMessage(..., attachment, fieldKey)`, then calls the card's existing `advance()` path. Replace the `case 'attachment':` branch in the field-renderer:

```tsx
case 'attachment':
  return (
    <div className="flex flex-col gap-2">
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        aria-label="Attach image"
        disabled={disabled}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          setSending(true);
          try {
            await onSendAttachment(field.key, file);
            setCommitted((current) => ({ ...current, [field.key]: true }));
            if (isLast) onSubmit();
            else setIndex((current) => current + 1);
          } finally {
            setSending(false);
          }
        }}
      />
    </div>
  );
```

This bypasses the normal `draft`/`changed`/`advance()` flow (which is built around typed values, not file picks): the field's own `onChange` handler drives advancement directly, since a picked file that uploads successfully has no "unchanged, don't resubmit" case the way a re-shown text field does.

- [ ] **Step 9: Run the test to verify it passes**

Run: `cd frontend && pnpm test src/surfaces/webview/components/chat/FormCard.test.tsx`
Expected: PASS.

- [ ] **Step 10: Manual check with `run`**

Start the app in a browser (or the SDK's dev harness), open the webview, and: (a) have an agent send an image from the console and confirm it renders in the player's thread; (b) send an image from the player composer and confirm it appears in the agent console; (c) trigger a form with an `attachment` field (seed one if none exists in dev data) and confirm picking a photo advances the form and posts an image message.

- [ ] **Step 11: Commit**

```bash
git add frontend/src/surfaces/webview/components/chat/ChatComposer.tsx frontend/src/surfaces/webview/pages/SupportChat.tsx frontend/src/surfaces/webview/api frontend/src/surfaces/webview/components/chat/FormCard.tsx frontend/src/surfaces/webview/components/chat/ChatComposer.test.tsx frontend/src/surfaces/webview/components/chat/FormCard.test.tsx
git commit -m "Wire webview composer and form attachment field to image send"
```
