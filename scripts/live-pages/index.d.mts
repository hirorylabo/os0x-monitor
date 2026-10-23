/** Topic-specific fields remain opaque to the routing middleware. */
export interface LiveTopicRecord {
  asOf: string;
  [field: string]: unknown;
}

export interface LiveTopicPage {
  readonly slug: string;
  readonly path: string;
  readonly statusPath: string;
  record(payload: unknown, now?: number): LiveTopicRecord;
  renderSection(record: LiveTopicRecord | null, options: { live: boolean }): string;
}

export const LIVE_TOPIC_PAGES: readonly LiveTopicPage[];
export function liveTopicPageForPath(pathname: string): LiveTopicPage | null;
export function liveTopicRpcPath(page: LiveTopicPage): string;
/** Null means the payload is stale or empty; other errors propagate. */
export function liveTopicReading(page: LiveTopicPage, payload: unknown, now?: number): LiveTopicRecord | null;
