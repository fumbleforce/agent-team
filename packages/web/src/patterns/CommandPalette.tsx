import { lazy, Suspense, useEffect, useState } from 'react';
import type { Agent, ProjectNode } from '../data/client';

export interface PaletteLink { href: string; label: string; note?: string }
export interface CommandPaletteProps { projects: ProjectNode[]; agents: Agent[]; pages?: PaletteLink[]; screens: PaletteLink[] }

const OPEN_EVENT = 'agent-team:palette';
// Opens the palette from anywhere, for a button where there is no keyboard.
export const openPalette = () => window.dispatchEvent(new Event(OPEN_EVENT));

// The list and its search library load the first time the palette opens, so they stay out of the first page load.
const Body = lazy(() => import('./CommandPaletteBody').then(module => ({ default: module.CommandPaletteBody })));

// Ctrl or Cmd + K: jump to a project, an agent, a knowledge page or one of the main screens.
export function CommandPalette({ projects, agents, pages = [], screens }: CommandPaletteProps) {
  const [open, setOpen] = useState(false);
  const [wanted, setWanted] = useState(false);
  useEffect(() => { if (open) setWanted(true); }, [open]);
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); setOpen(value => !value); } };
    const show = () => setOpen(true);
    window.addEventListener('keydown', key);
    window.addEventListener(OPEN_EVENT, show);
    return () => { window.removeEventListener('keydown', key); window.removeEventListener(OPEN_EVENT, show); };
  }, []);
  if (!wanted) return null;
  return <Suspense fallback={null}><Body projects={projects} agents={agents} pages={pages} screens={screens} open={open} setOpen={setOpen} /></Suspense>;
}
