import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

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
  h1: ({ children }) => <h1 className="mt-6 mb-2 text-2xl leading-snug font-semibold text-text first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-6 mb-2 text-xl leading-snug font-semibold text-text first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-5 mb-2 text-lg leading-snug font-semibold text-text first:mt-0">{children}</h3>,
  p: ({ children }) => <p className="mb-3 text-base leading-relaxed text-text last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-3 list-disc space-y-1 pl-5 text-base leading-relaxed text-text">{children}</ul>,
  ol: ({ children }) => <ol className="mb-3 list-decimal space-y-1 pl-5 text-base leading-relaxed text-text">{children}</ol>,
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="mb-3 border-l-2 border-accent-soft pl-3 text-base leading-relaxed text-muted">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-5 border-0 border-t border-accent-soft" />,
  code: ({ children }) => (
    <code className="rounded bg-surface px-1 py-0.5 font-mono text-[0.9em] text-text">{children}</code>
  ),
  // A fenced block is a <pre> wrapping the <code> above; the block scrolls
  // within itself rather than making the drawer scroll sideways.
  pre: ({ children }) => <pre className="mb-3 overflow-x-auto rounded-card bg-surface p-3 text-sm">{children}</pre>,
}

export function ArticleBody({ markdown }: { markdown: string }) {
  return (
    <div className="text-base leading-relaxed text-text">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </Markdown>
    </div>
  )
}
