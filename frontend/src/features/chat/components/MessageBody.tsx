import { lazy } from 'react';
import type { ChatAttachment, ChatAuthorType } from './types.ts';

/*
 * Lazy, and lazy HERE rather than at each call site, so both surfaces share one
 * chunk and one reason.
 *
 * ArticleSheet's own comment records why it must not be static: a static import
 * put ~790KB of react-markdown and remark-gfm on the webview's first paint and
 * blew past the SDK's 8s load timeout, so the surface never opened at all.
 *
 * This component therefore SUSPENDS the first time a bot or agent bubble renders.
 * The boundary belongs to the thread, not the bubble: one per bubble would flash
 * a fallback on every message as the list scrolls.
 */
const ArticleBody = lazy(() =>
  import('@/features/articles/components/ArticleBody').then((m) => ({ default: m.ArticleBody })),
);

/*
 * The whole rule, in one place so neither surface can drift.
 *
 * `player` is absent deliberately and permanently. ArticleBody is safe today only
 * because it omits rehype-raw, so raw HTML renders as literal text — a property
 * that was reasoned about for agent-authored article bodies. Pointing the renderer
 * at arbitrary player text would turn an incidental guarantee into one the system
 * depends on against an adversarial input source. `system` bodies are server copy
 * with no markdown in them, and get the same literal treatment.
 */
const MARKDOWN_AUTHORS: ReadonlySet<ChatAuthorType> = new Set(['bot', 'agent']);

export function MessageBody({
  authorType,
  body,
  attachment,
  dark = false,
}: {
  authorType: ChatAuthorType;
  body: string;
  attachment?: ChatAttachment | null;
  /** The bubble behind this body is a dark, on-brand background (e.g. the agent-console's own-message bubble) rather than the light `bg`/`surface` an article page renders on — so markdown body text should render in the light `accent-fg` colour instead of the default dark `text`. */
  dark?: boolean;
}) {
  const text = !MARKDOWN_AUTHORS.has(authorType) ? <>{body}</> : <ArticleBody markdown={body} dark={dark} />;

  if (!attachment) return text;

  return (
    <div className="flex flex-col gap-1">
      {attachment.url ? (
        <img
          src={attachment.url}
          alt={attachment.filename}
          className="max-h-64 max-w-full rounded-md object-contain"
          onError={(event) => {
            (event.currentTarget as HTMLImageElement).style.display = 'none';
          }}
        />
      ) : (
        <span className="text-xs italic opacity-75">Attachment unavailable — {attachment.filename}</span>
      )}
    </div>
  );
}
