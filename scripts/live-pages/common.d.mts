export function finiteNumber(value: unknown): number | null;
export function liveSectionMarkers(slug: string): { start: string; end: string };
/** Null means the built document has no single well-formed replacement slot. */
export function replaceLiveSection(html: string, slug: string, section: string): string | null;
