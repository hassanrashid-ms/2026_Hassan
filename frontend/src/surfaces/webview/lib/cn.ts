import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** shadcn's class merger. Lives inside the webview surface, not in shared lib/, so
 *  the agent console has no path to Tailwind-shaped helpers it does not use. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
