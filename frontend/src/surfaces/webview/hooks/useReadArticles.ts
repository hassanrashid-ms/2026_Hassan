import { useSyncExternalStore } from 'react';

/**
 * Which articles this player has opened during this webview session.
 *
 * Module-level rather than shell state on purpose. WebviewShell owns exactly the
 * boot/bootstrap lifecycle; read-state is presentation trivia that three screens
 * (home list, search results, the sheet itself) all need. A module store keeps it
 * out of the shell's contract while still surviving navigation between routes,
 * which a per-screen useState would not.
 *
 * Deliberately not persisted: the session is the scope. A player reopening support
 * days later should see a clean list, and `article_read` is already recorded
 * server-side for anyone who needs the durable answer.
 */
const readIds = new Set<string>();
const listeners = new Set<() => void>();

/** Recreated on every mutation so useSyncExternalStore's identity check fires. */
let snapshot: readonly string[] = [];

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): readonly string[] {
  return snapshot;
}

export function markArticleRead(articleId: string): void {
  if (readIds.has(articleId)) return;
  readIds.add(articleId);
  snapshot = [...readIds];
  for (const listener of listeners) listener();
}

export function hasReadArticle(articleId: string): boolean {
  return readIds.has(articleId);
}

/** Subscribe a component to the set. Returns a membership predicate. */
export function useReadArticles(): (articleId: string) => boolean {
  const ids = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return (articleId: string) => ids.includes(articleId);
}
