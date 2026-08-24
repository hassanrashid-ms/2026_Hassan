# Import Article from Markdown — Design

## Summary

Add an "Import from Markdown" action to the existing article editor
(`ArticleEditorSheet.tsx`, agent-console KnowledgeBase page) that lets an
agent pick a local `.md` file and have it fill the open editor's fields.
This is a client-side convenience feature only — no backend, schema, or
OpenAPI changes.

## Motivation

Agents/admins sometimes already have article content written as markdown
(e.g. migrated from another docs system) and currently have to copy/paste
it manually into the editor, re-typing title/tags by hand. This removes
that friction for the single-file case.

## Scope

- One file at a time, selected from the currently-open article editor.
- Selecting a file **overwrites** all editor fields it has data for
  (title, body, keywords). This is a deliberate "fresh import" semantic,
  not a merge.
- Category (`intentId`) is **never** touched by import, even if the
  frontmatter specifies a category — `intentId` is a foreign key into an
  existing intent list, and there is no reliable way to resolve an
  arbitrary frontmatter string to the correct intent. The agent always
  picks category manually.
- No slug support — the `article` schema has no slug field.
- No bulk import (multiple files / zip) — out of scope for this feature.
- No persistence side effects — import only changes in-memory form state.
  Nothing is saved until the existing Save/Publish action.

## Flow

1. Agent clicks "Import from Markdown" in the `ArticleEditorSheet` header.
2. A hidden `<input type="file" accept=".md,.markdown">` opens the native
   file picker.
3. The selected file is read with `FileReader.readAsText`.
4. The content is parsed with the `front-matter` npm package into
   `{ attributes, body }`.
5. Editor fields are overwritten:
   - `title` ← `attributes.title`, else the file's first `# H1` line,
     else the filename with its extension stripped.
   - `body` (MDXEditor content) ← parsed markdown `body`, set directly
     (MDXEditor edits markdown natively).
   - `keywords` ← `attributes.tags`, normalized through the existing
     `parseKeywordsInput()` helper (accepts array or comma-separated
     string). If `tags` is absent, keywords are cleared to `[]` (import
     overwrites, it does not merge).
   - `intentId` — untouched.
6. `state` (draft/published) and any other DB-backed fields are
   unaffected.

## Error handling

| Case | Behavior |
|---|---|
| Empty file | Toast: "File is empty." No fields changed. |
| No frontmatter block | Whole file treated as body. Title still falls back to H1/filename. |
| Malformed frontmatter (parser throws) | Toast: "Couldn't parse frontmatter." Whole file treated as body, title falls back to H1/filename. |
| File read error | Toast: generic file-read error. No fields changed. |

In all failure cases, the editor's current content is left untouched —
a failed import must never blank out what the agent already had open.

## Dependencies

- Add `front-matter` (small, pure JS, browser-safe — no Node polyfills)
  to `frontend/package.json`.

## Testing

Unit test the parse-and-fill logic as a pure function, decoupled from the
file-picker DOM plumbing, covering:
- Full frontmatter (title + tags array)
- Frontmatter with `tags` as a comma-separated string
- No frontmatter block at all
- Malformed frontmatter
- Missing title fallback chain (frontmatter → H1 → filename)
- Import overwriting pre-existing editor content (keywords cleared when
  `tags` absent)

## Non-goals

- Backend/API changes
- Bulk/multi-file import
- Category/intent auto-resolution
- Slug support
