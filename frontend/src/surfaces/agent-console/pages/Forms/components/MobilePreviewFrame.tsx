import type { ReactNode } from 'react';

/**
 * webview.css's actual `@theme` values (frontend/src/webview.css), duplicated
 * here rather than imported: importing webview.css into agent-console would
 * leak Tailwind's preflight reset across surfaces (see app/CLAUDE.md's
 * Styling section), so this is the deliberate exception to "utilities only" —
 * a scoped runtime value, not a hand-written stylesheet class.
 */
const WEBVIEW_THEME_VARS: Record<string, string> = {
  '--color-bg': '#ffffff',
  '--color-surface': '#f5f3fd',
  '--color-accent': '#7c3aed',
  '--color-accent-deep': '#5b21b6',
  '--color-accent-soft': '#ede9fe',
  '--color-accent-fg': '#ffffff',
  '--color-text': '#1a1720',
  '--color-muted': '#6b6577',
  '--radius-card': '1rem',
};

/**
 * Renders children with the webview surface's real colors and mobile type
 * scale, scoped to this container. webview.css sizes its root font with
 * `clamp(14px, 4.27vw, 22px)`, driven by actual viewport width — meaningless
 * inside a fixed-width box on a wide desktop page — so this frame hardcodes
 * 16px, the value that formula resolves to at its 375px reference width.
 */
export function MobilePreviewFrame({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="mobile-preview-frame"
      style={{ ...WEBVIEW_THEME_VARS, fontSize: '16px' }}
      className="mx-auto flex max-h-[700px] w-[375px] flex-col gap-4 overflow-y-auto rounded-[2rem] border border-black/10 bg-[var(--color-bg)] p-4 text-[var(--color-text)]"
    >
      {children}
    </div>
  );
}
