import type { ChokepointStatusView } from './crawlable-live-tools.mjs';

export const CHOKEPOINT_LIVE_START: string;
export const CHOKEPOINT_LIVE_END: string;

export interface ChokepointPulse extends Omit<ChokepointStatusView, 'fetchedAt'> {
  navigationalWarningsAvailable: boolean;
  aisSnapshotAvailable: boolean;
  asOf: string;
}

export function chokepointPulseRecord(view: ChokepointStatusView): ChokepointPulse;
export function renderChokepointLiveSection(input: {
  chokepoint: { id: string; displayName: string };
  pulse: ChokepointPulse | null;
  live?: boolean;
}): string;

/** Null means the built document has no single well-formed replacement slot. */
export function replaceChokepointLiveSection(html: string, section: string): string | null;
