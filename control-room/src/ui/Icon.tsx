// A small stroke icon set, used only where an icon replaces a word.
const PATHS = {
  back: 'M10 4 6 8l4 4',
  chevron: 'm6 4 4 4-4 4',
  down: 'm4 6 4 4 4-4',
  search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10Zm3.5-1.5L14 14',
  undo: 'M5 4 2 7l3 3M2.5 7H10a4 4 0 0 1 0 8H8',
  lock: 'M4.5 7V5a3.5 3.5 0 0 1 7 0v2M3.5 7h9v7h-9z',
  file: 'M4 2h5l3 3v9H4zM9 2v3h3',
  check: 'm3 8.5 3 3 7-7',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, label, size = 16 }: { name: IconName; label?: string; size?: number }) {
  return (
    <svg
      width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round" role={label ? 'img' : undefined} aria-label={label}
      aria-hidden={label ? undefined : true} focusable="false" style={{ flex: 'none' }}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
