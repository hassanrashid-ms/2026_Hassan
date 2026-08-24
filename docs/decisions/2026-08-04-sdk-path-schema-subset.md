# Ten tables first, twenty-two later

**Date:** 2026-08-04
**Status:** Accepted
**Context:** the SDK-seam slice (build-order steps 1–3 of `2026-08-04-sdk-wire-contract.md`)

## Decision

Migration `001` creates ten of the thirty-two specced tables — the ones the SDK path
touches: `workspace`, `agent`, `workspace_member`, `player`, `session`,
`player_state_snapshot`, `declared_field`, `event`, and a minimal `conversation` and
`message`. The remaining twenty-two arrive in migration `002`, at the start of the
conversation slice.

## Consequences

- **`conversation` and `message` exist only because `GET /sdk/unread` joins them.**
  `conversation.subintent_id`, `resolution_cycle`, labels and form submissions are
  absent, and the status machine is a default rather than a machine. Nothing in this
  slice creates a conversation.
- **The `Other` intent and its catch-all subintent are not seeded**, because `intent`
  and `subintent` do not exist. The build order asks step 1 to seed _"one workspace and
  the `Other` taxonomy"_; the taxonomy half moves to migration `002` and is the first
  task of that slice. **This is the one deferral with a real risk of being forgotten** —
  conversations store a subintent, so without the catch-all there is nowhere for
  "anything it can't place" to land.
- **`event` ships now, in full**, as the schema spec demands ("build this on day two").
  Its data cannot be reconstructed later, and `session_start` / `session_end` /
  `article_read` / `sdk_incident` all flow through it from this slice onwards.
- Migration `002` will `ALTER TABLE conversation` rather than create it. That is a
  cheap, additive change and is the price of proving the seam first.

## Rejected

**All 33 tables in migration 001.** The schema is fully designed, so this was
defensible. Rejected because it puts several tasks of DDL — pgvector, HNSW, forms,
automation — ahead of the first endpoint, and the seam is what needs proving first:
it spans both repos and is where the surprises live.
