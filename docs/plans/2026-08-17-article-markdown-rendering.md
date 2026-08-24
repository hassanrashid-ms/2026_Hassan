# Article Markdown Rendering (Webview) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render article bodies as formatted markdown in the player-facing webview instead of showing agents' raw markdown syntax to players, behind one component boundary that a later media project can extend without touching any call site.

**Architecture:** A single new component, `ArticleBody`, takes one prop — the markdown string — and renders it with `react-markdown` + `remark-gfm`. Every element's appearance and behaviour is set through react-markdown's `components` map: that map is the only interception point, and it is what makes the `img` entry a cheap seam for the future media project. Links are the one entry that does more than style: they post `open_url` over the existing SDK bridge so the system browser opens instead of the webview navigating away from the support surface. The SDK gains a matching handler with a scheme whitelist.

**Tech Stack:** React 19, TypeScript, Vite, Vitest + jsdom + Testing Library, Tailwind v4 (config-in-CSS), `react-markdown`, `remark-gfm`, pnpm workspaces. SDK side: Unity C#, NUnit EditMode tests.

**Source spec:** `docs/specs/2026-08-17-article-markdown-rendering-design.md`

## Global Constraints

- **Two repos.** Tasks 1–4 are in the app repo at `/Users/hassanrashid/Desktop/git/mindstorm/crm/app`. Task 5 is in the SDK repo at `/Users/hassanrashid/Desktop/git/mindstorm/crm/SDK/CRM`. Commit in the repo the task's files live in.
- **No CSS.** Do not create a stylesheet, CSS module, or CSS-in-JS block, and do not edit `frontend/src/webview.css`. All styling is Tailwind utility classes.
- **No `@tailwindcss/typography`.** Do not install it and do not use `prose` classes. It ships absolute font sizes that fight the `clamp()` on `html` in `webview.css` that the whole rem scale rides on.
- **Use existing theme tokens only:** `text-text`, `text-muted`, `bg-surface`, `bg-accent-soft`, `text-accent`, `rounded-card`, `hairline`. They are defined in `frontend/src/webview.css`'s `@theme` block. Do not add tokens.
- **No `rehype-raw`.** Raw HTML in an article body must render as literal text. This is a security property, not a styling choice.
- **Do not change `react-markdown`'s default `urlTransform`.** It strips `javascript:` and other dangerous schemes.
- **Import boundaries are lint-enforced** (`eslint-plugin-boundaries`). `src/features/**` is the `shared` zone and **must not import from `src/surfaces/**`**. `ArticleBody` therefore imports only from `react-markdown`, `remark-gfm`, `react`, and `@/services/bridgeService`. It must not import any component from `surfaces/webview/components/ui/`.
- **No API, schema, migration, or `@support/types` change.** `article.body` already carries markdown end to end. Nothing goes in `backend/src/docs/openapi.ts`.
- **No `article_attachment` work.** It stays schema-only.
- **Never add a `Co-Authored-By: Claude` trailer to a commit message.**
- **Pre-existing failures, not regressions:** `TopBar`, `SupportHero`, `SupportChat`, and `ChatThread` have 5 failing tests on this branch already. Do not fix them, and do not treat them as caused by this work. Run individual test files rather than the whole suite when checking your own work.

---

### Task 1: `ArticleBody` renders block markdown

Installs the two dependencies and creates the component with the text-level half of the `components` map. Links, images, and tables come in Tasks 2 and 3.

**Files:**

- Modify: `frontend/package.json` (via `pnpm add` — do not hand-edit)
- Create: `frontend/src/features/articles/components/ArticleBody.tsx`
- Test: `frontend/src/features/articles/components/ArticleBody.test.tsx`

**Interfaces:**

- Consumes: nothing.
- Produces: `export function ArticleBody({ markdown }: { markdown: string }): JSX.Element` from `@/features/articles/components/ArticleBody`. Its **entire** public interface is the one `markdown` prop. Later tasks add entries to its internal `components` map; none of them change this signature.

- [ ] **Step 1: Install the dependencies**

Run from `/Users/hassanrashid/Desktop/git/mindstorm/crm/app/frontend`:

```bash
pnpm add react-markdown remark-gfm
```

Both are runtime dependencies, not dev dependencies — they ship in the player bundle.

- [ ] **Step 2: Write the failing test**

Create `frontend/src/features/articles/components/ArticleBody.test.tsx`:

```tsx
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ArticleBody } from './ArticleBody.tsx';

describe('ArticleBody block markdown', () => {
  it('renders a heading as a real heading, not as literal hashes', () => {
    render(<ArticleBody markdown={'## Refund policy\n\nSome text.'} />);

    expect(screen.getByRole('heading', { name: 'Refund policy' })).toBeInTheDocument();
    expect(screen.queryByText(/##/)).not.toBeInTheDocument();
  });

  it('renders emphasis as elements, not as literal asterisks', () => {
    const { container } = render(<ArticleBody markdown={'We refund within **30 days**.'} />);

    expect(container.querySelector('strong')?.textContent).toBe('30 days');
    expect(container.textContent).not.toContain('**');
  });

  it('renders a bulleted list as list items', () => {
    render(<ArticleBody markdown={'- First\n- Second'} />);

    const items = screen.getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(['First', 'Second']);
  });

  it('renders a blockquote and inline code', () => {
    const { container } = render(
      <ArticleBody markdown={'> Quoted line\n\nRun `npm test` first.'} />,
    );

    expect(container.querySelector('blockquote')?.textContent).toContain('Quoted line');
    expect(container.querySelector('code')?.textContent).toBe('npm test');
  });

  // No rehype-raw: content must never become markup.
  it('renders raw HTML as literal text', () => {
    const { container } = render(<ArticleBody markdown={'<script>alert(1)</script>'} />);

    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('<script>alert(1)</script>');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run from `frontend/`:

```bash
pnpm exec vitest run src/features/articles/components/ArticleBody.test.tsx
```

Expected: FAIL — `Failed to resolve import "./ArticleBody.tsx"`.

- [ ] **Step 4: Write the component**

Create `frontend/src/features/articles/components/ArticleBody.tsx`:

```tsx
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/*
 * Agents author bodies in a WYSIWYG markdown editor. Players used to get the raw
 * string — `##` and asterisks and all. This is the only place an article body is
 * rendered anywhere in the frontend.
 *
 * `components` is the whole design: it is the one interception point, which is why
 * a future media project can change how an image resolves without any call site
 * knowing. Deliberately NO rehype-raw — raw HTML in a body renders as literal
 * text, so article content can never become markup.
 *
 * Styling is Tailwind utilities on the webview theme tokens. @tailwindcss/typography
 * is not installed and must not be: it ships absolute font sizes that would fight
 * the clamp() on `html` that the entire rem-based scale rides on.
 */
const components: Components = {
  h1: ({ children }) => (
    <h1 className="mt-6 mb-2 text-2xl leading-snug font-semibold text-text first:mt-0">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="mt-6 mb-2 text-xl leading-snug font-semibold text-text first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="mt-5 mb-2 text-lg leading-snug font-semibold text-text first:mt-0">
      {children}
    </h3>
  ),
  p: ({ children }) => (
    <p className="mb-3 text-base leading-relaxed text-text last:mb-0">{children}</p>
  ),
  ul: ({ children }) => (
    <ul className="mb-3 list-disc space-y-1 pl-5 text-base leading-relaxed text-text">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="mb-3 list-decimal space-y-1 pl-5 text-base leading-relaxed text-text">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-accent-soft pl-3 text-base leading-relaxed text-muted">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-5 border-0 border-t border-accent-soft" />,
  code: ({ children }) => (
    <code className="rounded bg-surface px-1 py-0.5 font-mono text-[0.9em] text-text">
      {children}
    </code>
  ),
  // A fenced block is a <pre> wrapping the <code> above; the block scrolls
  // within itself rather than making the drawer scroll sideways.
  pre: ({ children }) => (
    <pre className="mb-3 overflow-x-auto rounded-card bg-surface p-3 text-sm">{children}</pre>
  ),
};

export function ArticleBody({ markdown }: { markdown: string }) {
  return (
    <div className="text-base leading-relaxed text-text">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </Markdown>
    </div>
  );
}
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm exec vitest run src/features/articles/components/ArticleBody.test.tsx
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Typecheck and lint**

```bash
pnpm typecheck
```

Expected: clean. This runs `tsc --noEmit && eslint .`; the eslint half is what proves `ArticleBody` did not cross the `shared` → `surfaces` import boundary.

- [ ] **Step 7: Commit**

```bash
cd /Users/hassanrashid/Desktop/git/mindstorm/crm/app
git add frontend/package.json pnpm-lock.yaml frontend/src/features/articles/components/ArticleBody.tsx frontend/src/features/articles/components/ArticleBody.test.tsx
git commit -m "feat(webview): render article markdown blocks with react-markdown"
```

---

### Task 2: Tables and images

Adds the two `components` entries that need structure rather than only classes. The `img` entry is the seam the future media project extends.

**Files:**

- Modify: `frontend/src/features/articles/components/ArticleBody.tsx`
- Test: `frontend/src/features/articles/components/ArticleBody.test.tsx` (append)

**Interfaces:**

- Consumes: `ArticleBody` from Task 1, unchanged signature.
- Produces: no new exports. `ArticleImage` is module-private; the future media project changes its internals, not its position in the map.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/features/articles/components/ArticleBody.test.tsx`:

First widen the existing Testing Library import at the top of the file — do not add a
second `import` statement further down:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
```

Then append:

```tsx
describe('ArticleBody tables', () => {
  it('renders a GFM table inside its own horizontally scrolling container', () => {
    const markdown = ['| Plan | Price |', '| --- | --- |', '| Free | $0 |'].join('\n');
    const { container } = render(<ArticleBody markdown={markdown} />);

    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    // A wide table must scroll within itself, not make the whole drawer
    // scroll sideways.
    expect(table?.parentElement?.className).toContain('overflow-x-auto');
    expect(screen.getByRole('cell', { name: '$0' })).toBeInTheDocument();
  });
});

describe('ArticleBody images', () => {
  it('renders an image lazily at its natural size, capped to the container', () => {
    const { container } = render(
      <ArticleBody markdown={'![A happy cat](https://cdn.example.com/cat.gif)'} />,
    );

    const img = container.querySelector('img');
    expect(img?.getAttribute('src')).toBe('https://cdn.example.com/cat.gif');
    expect(img?.getAttribute('loading')).toBe('lazy');
    expect(img?.className).toContain('max-w-full');
  });

  // Third-party image hosts rot. Degrade to the alt text, not to a broken glyph.
  it('falls back to the alt text when the image fails to load', () => {
    const { container } = render(
      <ArticleBody markdown={'![A happy cat](https://cdn.example.com/gone.gif)'} />,
    );

    fireEvent.error(container.querySelector('img')!);

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('A happy cat')).toBeInTheDocument();
  });

  it('renders nothing at all when a broken image has no alt text', () => {
    const { container } = render(
      <ArticleBody markdown={'![](https://cdn.example.com/gone.gif)'} />,
    );

    fireEvent.error(container.querySelector('img')!);

    expect(container.querySelector('img')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm exec vitest run src/features/articles/components/ArticleBody.test.tsx
```

Expected: FAIL — the table test fails on `parentElement.className` not containing `overflow-x-auto`, and the image tests fail on the missing `loading` attribute and on the `img` still being present after `error`.

- [ ] **Step 3: Add the image component**

In `frontend/src/features/articles/components/ArticleBody.tsx`, add the import and the component above the `components` map:

```tsx
import { useState } from 'react';
```

```tsx
/*
 * THIS IS THE SEAM. Article media is a separate project: when it ships, this
 * component learns to recognise an attachment handle and resolve it to a signed
 * URL, and nothing else in the app changes — not the components map, not
 * ArticleBody's props, not the call site.
 *
 * Today an agent can type a third-party URL into the editor and it renders. Those
 * hosts rot, so a failed load degrades to the alt text as a caption rather than
 * leaving a broken-image glyph in the middle of a help article.
 */
function ArticleImage({ src, alt }: { src?: string; alt?: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return alt ? <span className="mb-3 block text-sm text-muted italic">{alt}</span> : null;
  }

  return (
    <img
      src={src}
      alt={alt ?? ''}
      loading="lazy"
      onError={() => setFailed(true)}
      className="mb-3 h-auto max-w-full rounded-card"
    />
  );
}
```

- [ ] **Step 4: Add the `img` and `table` entries to the map**

Add these entries to the `components` object in the same file:

```tsx
  img: ({ src, alt }) => <ArticleImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
  // The wrapper, not the table, is what scrolls.
  table: ({ children }) => (
    <div className="mb-3 overflow-x-auto">
      <table className="w-full border-collapse text-sm text-text">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border-b border-accent-soft px-2 py-1.5 text-left font-semibold whitespace-nowrap">{children}</th>
  ),
  td: ({ children }) => <td className="border-b border-accent-soft px-2 py-1.5 align-top">{children}</td>,
```

Note: an `<img>` produced from `![]()` is a phrasing-content child of a `<p>`, so the fallback uses a `<span>` with `block`, not a `<div>` — a `<div>` inside a `<p>` is invalid HTML and React will warn.

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm exec vitest run src/features/articles/components/ArticleBody.test.tsx
```

Expected: PASS, 9 tests.

- [ ] **Step 6: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/hassanrashid/Desktop/git/mindstorm/crm/app
git add frontend/src/features/articles/components/ArticleBody.tsx frontend/src/features/articles/components/ArticleBody.test.tsx
git commit -m "feat(webview): render article tables and inline images"
```

---

### Task 3: Links open the system browser via the bridge

A bare `<a href>` in a webview navigates in place, replacing the whole support surface with the target page — no back button, no chrome, no way home. The player is stranded inside the game's help view. This task prevents that.

**Files:**

- Modify: `frontend/src/services/bridgeService.ts`
- Modify: `frontend/src/features/articles/components/ArticleBody.tsx`
- Test: `frontend/src/features/articles/components/ArticleBody.test.tsx` (append)

**Interfaces:**

- Consumes: `post` from `@/services/bridgeService`.
- Produces: a new `BridgeMessage` variant `{ type: 'open_url'; url: string }`. Task 5's SDK handler is the other half of this contract — the `type` string and the `url` field name must match exactly.

- [ ] **Step 1: Write the failing tests**

Append to `frontend/src/features/articles/components/ArticleBody.test.tsx`:

Widen the existing vitest import at the top of the file rather than adding a second one:

```tsx
import { beforeEach, describe, expect, it } from 'vitest';
```

Then append:

```tsx
/** Stands in for the bridge the SDK injects, recording what the page posts. */
function installBridge(): unknown[] {
  const posted: unknown[] = [];
  (window as { SupportBridge?: unknown }).SupportBridge = {
    post: (message: unknown) => posted.push(message),
  };
  return posted;
}

describe('ArticleBody links', () => {
  beforeEach(() => {
    delete (window as { SupportBridge?: unknown }).SupportBridge;
  });

  it('posts open_url and suppresses navigation when the bridge is present', () => {
    const posted = installBridge();
    render(<ArticleBody markdown={'See [our terms](https://example.com/terms).'} />);

    // fireEvent.click returns false when the handler called preventDefault —
    // which is what stops the webview navigating away from the support surface.
    const notCancelled = fireEvent.click(screen.getByRole('link', { name: 'our terms' }));

    expect(posted).toEqual([{ type: 'open_url', url: 'https://example.com/terms' }]);
    expect(notCancelled).toBe(false);
  });

  it('behaves as a normal new-tab link with no bridge, for desktop development', () => {
    render(<ArticleBody markdown={'See [our terms](https://example.com/terms).'} />);

    const link = screen.getByRole('link', { name: 'our terms' });
    expect(link.getAttribute('href')).toBe('https://example.com/terms');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(fireEvent.click(link)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
pnpm exec vitest run src/features/articles/components/ArticleBody.test.tsx
```

Expected: FAIL — `posted` is empty and the click is not cancelled, because no `a` entry exists in the map yet.

- [ ] **Step 3: Add `open_url` to the bridge message union**

In `frontend/src/services/bridgeService.ts`, add to the `BridgeMessage` union, after the `close` variant:

```ts
  /**
   * "Open this somewhere that is not me."
   *
   * A link tapped inside the webview would otherwise navigate in place, replacing
   * the entire support surface with the target page — no back button, no way home.
   * The SDK opens it in the system browser instead, leaving both the game and this
   * surface intact.
   *
   * An SDK build predating the handler ignores this (unknown types are always
   * ignored, never errored) and the tap does nothing. A dead tap is strictly
   * better than a stranded player, and `post` is fire-and-forget so the page
   * cannot feature-detect the difference.
   */
  | { type: 'open_url'; url: string }
```

- [ ] **Step 4: Add the `a` entry to the components map**

In `ArticleBody.tsx`, add the import:

```tsx
import { post } from '@/services/bridgeService';
```

and this entry to the `components` object:

```tsx
  /*
   * The bridge is checked at click time, not at render time: the SDK injects it
   * asynchronously on page load, so a render-time check can read `undefined` on a
   * platform that does in fact have a bridge a moment later.
   *
   * With no bridge — a plain desktop browser, which is a supported development
   * mode — nothing is prevented and the anchor opens a new tab as normal. That is
   * why target/rel are always present rather than conditional.
   */
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-accent underline underline-offset-2"
      onClick={(event) => {
        if (!href || !window.SupportBridge) return
        event.preventDefault()
        post({ type: 'open_url', url: href })
      }}
    >
      {children}
    </a>
  ),
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
pnpm exec vitest run src/features/articles/components/ArticleBody.test.tsx
```

Expected: PASS, 11 tests.

- [ ] **Step 6: Typecheck**

```bash
pnpm typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
cd /Users/hassanrashid/Desktop/git/mindstorm/crm/app
git add frontend/src/services/bridgeService.ts frontend/src/features/articles/components/ArticleBody.tsx frontend/src/features/articles/components/ArticleBody.test.tsx
git commit -m "feat(webview): open article links in the system browser via the bridge"
```

---

### Task 4: Use `ArticleBody` in `ArticleSheet`

The one-line call-site change that closes the user-facing bug. Everything else in the sheet — the loading skeleton, the error state, the `article_read` emit, the keyword badges — is untouched.

**Files:**

- Modify: `frontend/src/surfaces/webview/components/ArticleSheet.tsx:67`
- Test: `frontend/src/surfaces/webview/components/ArticleSheet.test.tsx` (create)

**Interfaces:**

- Consumes: `ArticleBody` from `@/features/articles/components/ArticleBody` (Task 1), unchanged since.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/surfaces/webview/components/ArticleSheet.test.tsx`:

```tsx
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ArticleSheet } from './ArticleSheet.tsx';
import { SupportContextProvider } from './SupportContext.tsx';

/*
 * The hook is a real useQuery, so it is mocked at the module boundary rather than
 * spied on: this test is about what the sheet renders, not about fetching.
 *
 * The article is inlined in the factory on purpose. vi.mock is hoisted above every
 * other statement in the file, and the factory runs during the import of
 * ArticleSheet — so a module-level `const ARTICLE` referenced here would be in its
 * temporal dead zone and throw.
 */
vi.mock('@/surfaces/webview/hooks/useArticleDetail', () => ({
  useArticleDetail: () => ({
    data: {
      id: 'art-1',
      title: 'Refund policy',
      body: '## When we refund\n\nWe refund within **30 days** of purchase.',
      keywords: ['refund'],
    },
    isError: false,
  }),
}));

describe('ArticleSheet body', () => {
  it('renders the body as formatted markdown, not as raw syntax', () => {
    render(
      <SupportContextProvider value={{ boot: null, data: null, error: null, retry: vi.fn() }}>
        <ArticleSheet articleId="art-1" onClose={vi.fn()} />
      </SupportContextProvider>,
    );

    expect(screen.getByRole('heading', { name: 'When we refund' })).toBeInTheDocument();
    expect(screen.getByText('30 days').tagName).toBe('STRONG');
    // The bug this closes: players used to see the literal markers.
    expect(screen.queryByText(/\*\*/)).not.toBeInTheDocument();
    expect(screen.queryByText(/##/)).not.toBeInTheDocument();
  });
});
```

If `useArticleDetail`'s real return type makes the `mockReturnValue` cast awkward, or `SupportContextProvider`'s value type has more required fields, match the shape used in `frontend/src/surfaces/webview/components/TopBar.test.tsx` — it is the established pattern in this directory. Do not change `useArticleDetail` or `SupportContext` to make the test easier.

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm exec vitest run src/surfaces/webview/components/ArticleSheet.test.tsx
```

Expected: FAIL — no heading role is found, because the body is still a single `<p>` of raw text.

- [ ] **Step 3: Swap the paragraph for `ArticleBody`**

In `frontend/src/surfaces/webview/components/ArticleSheet.tsx`, add the import:

```tsx
import { ArticleBody } from '@/features/articles/components/ArticleBody';
```

and replace line 67:

```tsx
<p className="text-base leading-relaxed whitespace-pre-wrap text-text">{article.data.body}</p>
```

with:

```tsx
<ArticleBody markdown={article.data.body} />
```

Change nothing else in this file.

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm exec vitest run src/surfaces/webview/components/ArticleSheet.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Verify nothing else in the webview regressed**

```bash
pnpm exec vitest run src/surfaces/webview src/features/articles
pnpm typecheck
```

Expected: the `ArticleBody`, `ArticleSheet`, `WebviewShell`, `useSurfaceReadySignal`, `SupportHome`, and `articleSearch` tests pass. `TopBar` (2), `SupportHero` (2), and `SupportChat` (1) still fail — those 5 are pre-existing and out of scope. If any _other_ test fails, it is yours; stop and fix it.

- [ ] **Step 6: Commit**

```bash
cd /Users/hassanrashid/Desktop/git/mindstorm/crm/app
git add frontend/src/surfaces/webview/components/ArticleSheet.tsx frontend/src/surfaces/webview/components/ArticleSheet.test.tsx
git commit -m "fix(webview): show article bodies as formatted markdown to players"
```

---

### Task 5: SDK handles `open_url` with a scheme whitelist

**Different repo:** `/Users/hassanrashid/Desktop/git/mindstorm/crm/SDK/CRM`.

`Application.OpenURL` honours custom URI schemes — `tel:`, `mailto:`, and any app deep-link registered on the device. Without a guard, `open_url` is a path from article content to an arbitrary URI handler on the player's phone. `react-markdown`'s `urlTransform` sanitizes on the page side, but the bridge is a plain string channel and the SDK must not assume the page is the only thing that can post to it.

The guard is a standalone static class so it compiles and unit-tests regardless of the `SUPPORT_UNITY_WEBVIEW` define that wraps the surface class.

**Files:**

- Create: `Assets/Support/Surface/ExternalUrlPolicy.cs`
- Create: `Assets/Support/Tests/EditMode/ExternalUrlPolicyTests.cs`
- Modify: `Assets/Support/Surface/UnityWebViewSupportSurface.cs` (the `OnMessage` switch, currently around line 227)

**Interfaces:**

- Consumes: the wire contract from Task 3 — message `type` is exactly `"open_url"` and the URL field is exactly `"url"`.
- Produces: `public static bool Support.Sdk.Surface.ExternalUrlPolicy.IsOpenable(string url)` — true only for absolute `http`/`https` URLs.

- [ ] **Step 1: Write the failing test**

Create `Assets/Support/Tests/EditMode/ExternalUrlPolicyTests.cs`:

```csharp
using NUnit.Framework;
using Support.Sdk.Surface;

namespace Support.Sdk.Tests
{
    public class ExternalUrlPolicyTests
    {
        [Test]
        public void AllowsHttpAndHttps()
        {
            Assert.IsTrue(ExternalUrlPolicy.IsOpenable("https://example.com/terms"));
            Assert.IsTrue(ExternalUrlPolicy.IsOpenable("http://example.com/terms"));
        }

        // Application.OpenURL honours any URI scheme registered on the device, so
        // article content must not be able to reach one.
        [Test]
        public void RejectsEverySchemeThatIsNotHttpOrHttps()
        {
            Assert.IsFalse(ExternalUrlPolicy.IsOpenable("tel:+15551234567"));
            Assert.IsFalse(ExternalUrlPolicy.IsOpenable("mailto:someone@example.com"));
            Assert.IsFalse(ExternalUrlPolicy.IsOpenable("file:///etc/passwd"));
            Assert.IsFalse(ExternalUrlPolicy.IsOpenable("javascript:alert(1)"));
            Assert.IsFalse(ExternalUrlPolicy.IsOpenable("somegame://buy?sku=gems"));
        }

        [Test]
        public void RejectsMissingAndRelativeUrls()
        {
            Assert.IsFalse(ExternalUrlPolicy.IsOpenable(null));
            Assert.IsFalse(ExternalUrlPolicy.IsOpenable(""));
            Assert.IsFalse(ExternalUrlPolicy.IsOpenable("   "));
            Assert.IsFalse(ExternalUrlPolicy.IsOpenable("/terms"));
            Assert.IsFalse(ExternalUrlPolicy.IsOpenable("example.com/terms"));
        }

        [Test]
        public void IsNotFooledBySchemeCasing()
        {
            Assert.IsTrue(ExternalUrlPolicy.IsOpenable("HTTPS://example.com"));
        }
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run the EditMode suite. Either use the Unity Test Runner window (Window → General → Test Runner → EditMode → Run All), or the MCP `run_tests` tool with mode `EditMode`.

Expected: a **compile error**, `The name 'ExternalUrlPolicy' does not exist in the current context` — which is the correct failing state here, not a red test.

- [ ] **Step 3: Write the policy**

Create `Assets/Support/Surface/ExternalUrlPolicy.cs`:

```csharp
using System;

namespace Support.Sdk.Surface
{
    /// <summary>
    /// Decides whether a URL the web surface asked us to open is safe to hand to
    /// Application.OpenURL.
    ///
    /// Application.OpenURL honours whatever URI schemes are registered on the
    /// device — tel:, mailto:, and arbitrary app deep-links. The bridge is a plain
    /// string channel, so the SDK must not assume the page is the only thing that
    /// can post to it: without this guard, `open_url` is a path from article
    /// content to any URI handler on the player's phone.
    ///
    /// Deliberately a standalone static class rather than a private method on
    /// UnityWebViewSupportSurface, so it compiles and unit-tests regardless of the
    /// SUPPORT_UNITY_WEBVIEW define that wraps the surface itself.
    /// </summary>
    public static class ExternalUrlPolicy
    {
        public static bool IsOpenable(string url)
        {
            if (string.IsNullOrWhiteSpace(url)) return false;
            if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return false;
            return uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps;
        }
    }
}
```

`Uri.Scheme` is already lower-cased by `Uri`, which is what makes the casing test pass without an explicit `ToLower`.

- [ ] **Step 4: Run the test to verify it passes**

Run the EditMode suite again. Expected: 4 `ExternalUrlPolicyTests` pass, and the existing `PiiGuardTests`, `OutboxTests`, `SupportSdkTests`, `SupportOverlayTests`, and `SnapshotCaptureTests` still pass.

- [ ] **Step 5: Handle the message in `OnMessage`**

In `Assets/Support/Surface/UnityWebViewSupportSurface.cs`, add a case to the `OnMessage` switch, after `case "close":` and before `default:`:

```csharp
                    case "open_url":
                        // A link tapped in the page would otherwise navigate the
                        // webview in place, replacing the support surface with the
                        // target site and stranding the player with no way back.
                        var url = parsed.TryGetValue("url", out var urlObj) ? urlObj?.ToString() : null;
                        if (ExternalUrlPolicy.IsOpenable(url))
                        {
                            Application.OpenURL(url);
                        }
                        else
                        {
                            SupportUtil.LogWarning($"UnityWebViewSupportSurface: refused to open non-http(s) url — {url}");
                        }
                        break;
```

`Application.OpenURL` and `SupportUtil` are both already in scope in this file. Do not add a `using` and do not touch the `#else` stub.

- [ ] **Step 6: Verify the project compiles and the suite still passes**

Let Unity recompile (or use the MCP `refresh_unity` tool), check the console for errors, then run the EditMode suite again. Expected: no compile errors, all tests pass.

- [ ] **Step 7: Commit**

Unity generates a `.meta` file for each new `.cs` file on import — make sure both `.meta` files exist before committing, or the next person's Unity generates different GUIDs.

```bash
cd /Users/hassanrashid/Desktop/git/mindstorm/crm/SDK/CRM
git add Assets/Support/Surface/ExternalUrlPolicy.cs Assets/Support/Surface/ExternalUrlPolicy.cs.meta \
        Assets/Support/Tests/EditMode/ExternalUrlPolicyTests.cs Assets/Support/Tests/EditMode/ExternalUrlPolicyTests.cs.meta \
        Assets/Support/Surface/UnityWebViewSupportSurface.cs
git commit -m "feat(surface): open article links in the system browser, http(s) only"
```

---

## Manual verification

After Task 4, before Task 5 ships to a device:

1. Run the agent console, create an article whose body uses a heading, bold text, a bulleted list, a table, an external image URL, and a link. Publish it.
2. Open the webview surface in a desktop browser (`pnpm dev`, then the webview route). The body should be formatted; the link should open a new tab; the image should render.
3. After Task 5, open it in a Unity build. The link should open the system browser with the game still running behind it, and the support surface should still be on screen when you return.

## Out of scope — do not do these

- Installing `@tailwindcss/typography`, and therefore also fixing the silently-inert `prose prose-sm` classes on MDXEditor in `ArticleEditorSheet`. Known, deliberate, separate.
- Adding `tablePlugin` to MDXEditor. The renderer accepts tables the editor cannot reliably author; that asymmetry is accepted.
- Any `article_attachment`, S3, upload endpoint, or video work.
- Fixing the 5 pre-existing `TopBar` / `SupportHero` / `SupportChat` / `ChatThread` test failures.
