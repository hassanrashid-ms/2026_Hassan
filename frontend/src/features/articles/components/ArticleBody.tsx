import { useState } from 'react';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { post } from '@/services/bridgeService';

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

/*
 * Built per render rather than as a static map, because the text colour can't
 * just inherit from an ancestor: every element below sets its own explicit
 * text colour (needed so a `text-muted` blockquote or `text-accent` link
 * doesn't just become whatever colour the body text is), and an explicit
 * colour on the element always beats one inherited from a parent. The one
 * caller that renders this on a dark bubble background — an agent's own
 * message in ChatThread, styled `bg-accent text-accent-fg` — would otherwise
 * get `text-text`'s dark body colour laid directly over that dark bg.
 */
function getComponents(dark: boolean): Components {
  const body = dark ? 'text-accent-fg' : 'text-text';
  const quote = dark ? 'text-accent-fg/80' : 'text-muted';
  const rule = dark ? 'border-accent-fg/30' : 'border-accent-soft';
  const codeBg = dark ? 'bg-accent-fg/10' : 'bg-surface';
  const link = dark ? 'text-accent-fg' : 'text-accent';

  return {
    h1: ({ children }) => (
      <h1 className={`mt-6 mb-2 text-2xl leading-snug font-semibold ${body} first:mt-0`}>
        {children}
      </h1>
    ),
    h2: ({ children }) => (
      <h2 className={`mt-6 mb-2 text-xl leading-snug font-semibold ${body} first:mt-0`}>
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className={`mt-5 mb-2 text-lg leading-snug font-semibold ${body} first:mt-0`}>
        {children}
      </h3>
    ),
    p: ({ children }) => (
      <p className={`mb-3 text-base leading-relaxed ${body} last:mb-0`}>{children}</p>
    ),
    ul: ({ children }) => (
      <ul className={`mb-3 list-disc space-y-1 pl-5 text-base leading-relaxed ${body}`}>
        {children}
      </ul>
    ),
    ol: ({ children }) => (
      <ol className={`mb-3 list-decimal space-y-1 pl-5 text-base leading-relaxed ${body}`}>
        {children}
      </ol>
    ),
    li: ({ children }) => <li className="pl-0.5">{children}</li>,
    blockquote: ({ children }) => (
      <blockquote className={`mb-3 border-l-2 ${rule} pl-3 text-base leading-relaxed ${quote}`}>
        {children}
      </blockquote>
    ),
    hr: () => <hr className={`my-5 border-0 border-t ${rule}`} />,
    code: ({ children }) => (
      <code className={`rounded ${codeBg} px-1 py-0.5 font-mono text-[0.9em] ${body}`}>
        {children}
      </code>
    ),
    // A fenced block is a <pre> wrapping the <code> above; the block scrolls
    // within itself rather than making the drawer scroll sideways.
    pre: ({ children }) => (
      <pre className={`mb-3 overflow-x-auto rounded-card ${codeBg} p-3 text-sm`}>{children}</pre>
    ),
    img: ({ src, alt }) => (
      <ArticleImage src={typeof src === 'string' ? src : undefined} alt={alt} />
    ),
    // The wrapper, not the table, is what scrolls.
    table: ({ children }) => (
      <div className="mb-3 overflow-x-auto">
        <table className={`w-full border-collapse text-sm ${body}`}>{children}</table>
      </div>
    ),
    th: ({ children }) => (
      <th className={`border-b ${rule} px-2 py-1.5 text-left font-semibold whitespace-nowrap`}>
        {children}
      </th>
    ),
    td: ({ children }) => <td className={`border-b ${rule} px-2 py-1.5 align-top`}>{children}</td>,
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
        className={`${link} underline underline-offset-2`}
        onClick={(event) => {
          if (!href || !window.SupportBridge) return;
          event.preventDefault();
          post({ type: 'open_url', url: href });
        }}
      >
        {children}
      </a>
    ),
  };
}

export function ArticleBody({ markdown, dark = false }: { markdown: string; dark?: boolean }) {
  return (
    <div className={`text-base leading-relaxed ${dark ? 'text-accent-fg' : 'text-text'}`}>
      <Markdown remarkPlugins={[remarkGfm]} components={getComponents(dark)}>
        {markdown}
      </Markdown>
    </div>
  );
}
