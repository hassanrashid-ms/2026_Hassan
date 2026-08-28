/** Stable, hash-independent palette lookup: same colorIndex always renders the same classes. */
const TAG_BADGE_CLASSES: string[] = [
  'border-transparent bg-rose-100 text-rose-800',
  'border-transparent bg-orange-100 text-orange-800',
  'border-transparent bg-amber-100 text-amber-800',
  'border-transparent bg-lime-100 text-lime-800',
  'border-transparent bg-emerald-100 text-emerald-800',
  'border-transparent bg-teal-100 text-teal-800',
  'border-transparent bg-sky-100 text-sky-800',
  'border-transparent bg-indigo-100 text-indigo-800',
  'border-transparent bg-violet-100 text-violet-800',
  'border-transparent bg-pink-100 text-pink-800',
];

export function tagBadgeClassName(colorIndex: number): string {
  return TAG_BADGE_CLASSES[
    ((colorIndex % TAG_BADGE_CLASSES.length) + TAG_BADGE_CLASSES.length) % TAG_BADGE_CLASSES.length
  ]!;
}
