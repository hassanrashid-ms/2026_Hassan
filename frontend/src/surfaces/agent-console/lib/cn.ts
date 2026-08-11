import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn's class merger. Lives inside the agent-console surface, not shared
 *  lib/ or the webview's copy, so each surface's Tailwind config stays isolated. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
