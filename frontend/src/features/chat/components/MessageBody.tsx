import { lazy, useState, type KeyboardEvent } from 'react';
import { Maximize2 } from 'lucide-react';
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
  onImageClick,
}: {
  authorType: ChatAuthorType;
  body: string;
  attachment?: ChatAttachment | null;
  /** The bubble behind this body is a dark, on-brand background (e.g. the agent-console's own-message bubble) rather than the light `bg`/`surface` an article page renders on — so markdown body text should render in the light `accent-fg` colour instead of the default dark `text`. */
  dark?: boolean;
  /**
   * Omitted by the webview on purpose — a click-to-expand affordance is a
   * desktop agent-console feature, not a player one. When provided, the
   * image becomes clickable and shows a hover affordance; MessageBody itself
   * renders no lightbox, that's the caller's to own since it needs a
   * surface-styled Dialog.
   */
  onImageClick?: (attachment: ChatAttachment) => void;
}) {
  const [mediaLoaded, setMediaLoaded] = useState(false);
  const [mediaErrored, setMediaErrored] = useState(false);

  const text = !MARKDOWN_AUTHORS.has(authorType) ? (
    <>{body}</>
  ) : (
    <ArticleBody markdown={body} dark={dark} />
  );

  if (!attachment) return text;

  // When a send carries no typed text, the server stores the filename as the
  // body (see sendAgentMessage) purely so the row always has non-empty text.
  // That's an implementation detail, not something the agent actually typed —
  // showing it a second time above the image would read as a duplicated caption.
  const hasTypedText = body.trim().length > 0 && body !== attachment.filename;
  const isVideo = attachment.mimeType.startsWith('video/');

  return (
    <div className="flex flex-col gap-1">
      {hasTypedText && text}
      {attachment.url && !mediaErrored ? (
        isVideo ? (
          <video
            src={attachment.url}
            controls
            className="max-w-xs rounded-md"
            onLoadedData={() => setMediaLoaded(true)}
            onError={() => setMediaErrored(true)}
          />
        ) : (
          <div
            className={`group relative h-64 w-64 max-w-full overflow-hidden rounded-md ${
              onImageClick ? 'cursor-pointer' : ''
            }`}
            {...(onImageClick && {
              role: 'button',
              tabIndex: 0,
              onClick: () => onImageClick(attachment),
              onKeyDown: (event: KeyboardEvent) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  onImageClick(attachment);
                }
              },
            })}
          >
            {!mediaLoaded && (
              <div className="absolute inset-0 animate-pulse rounded-md bg-muted/20" />
            )}
            <img
              src={attachment.url}
              alt={attachment.filename}
              className={`h-full w-full object-contain transition-opacity duration-200 ${
                mediaLoaded ? 'opacity-100' : 'opacity-0'
              }`}
              onLoad={() => setMediaLoaded(true)}
              onError={() => setMediaErrored(true)}
            />
            {onImageClick && mediaLoaded && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-150 group-hover:bg-black/30 group-hover:opacity-100">
                <Maximize2 className="size-6 text-white drop-shadow" />
              </div>
            )}
          </div>
        )
      ) : (
        <span className="text-xs italic opacity-75">
          Attachment unavailable — {attachment.filename}
        </span>
      )}
    </div>
  );
}
