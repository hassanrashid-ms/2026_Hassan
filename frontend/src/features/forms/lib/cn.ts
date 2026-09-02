import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn's class merger. Lives inside features/forms/, not a surface's own
 *  copy or a shared top-level lib/, so this feature has no dependency on
 *  either surface's Tailwind-shaped helpers. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
