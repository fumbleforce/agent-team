const PATHS = {
  back: 'M10 3L5 8l5 5',
  check: 'M3 8.5l3 3 7-7',
  close: 'M4 4l8 8M12 4l-8 8',
  send: 'M2 8h11M9 4l4 4-4 4',
  image: 'M2 4.5A1.5 1.5 0 0 1 3.5 3h9A1.5 1.5 0 0 1 14 4.5v7a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5zM2 11l3.5-3.5 3 3 2-2L14 12',
  attach: 'M10.5 5.5l-5 5a1.8 1.8 0 0 0 2.5 2.5l5.5-5.5a3.2 3.2 0 0 0-4.5-4.5L3.5 8.5',
  chevron: 'M4 6l4 4 4-4',
  link: 'M6.5 9.5l3-3M5 11l-1.5 1.5a2.1 2.1 0 0 1-3-3L3 8M11 5l1.5-1.5a2.1 2.1 0 0 1 3 3L13 8',
  search: 'M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zM10.5 10.5L14 14',
  menu: 'M2 4h12M2 8h12M2 12h12',
  up: 'M8 13V3M4 7l4-4 4 4',
  down: 'M8 3v10M4 9l4 4 4-4',
  more: 'M3 8h.01M8 8h.01M13 8h.01',
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 14 }: { name: IconName; size?: number }) {
  return <svg aria-hidden width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round"><path d={PATHS[name]} /></svg>;
}
