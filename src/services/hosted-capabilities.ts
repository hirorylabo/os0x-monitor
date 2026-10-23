export type HostedFeature = 'economicFred' | 'aisRelay';
type HostedCapabilities = Record<HostedFeature, boolean>;
const unavailable: HostedCapabilities = { economicFred: false, aisRelay: false };

export function createHostedCapabilityLoader(fetcher: typeof fetch, now = Date.now) {
  let snapshot: HostedCapabilities = { ...unavailable };
  let expiresAt = 0;
  let pending: Promise<void> | undefined;
  return {
    available: (feature: HostedFeature): boolean => snapshot[feature],
    async ensure(): Promise<void> {
      if (pending) return pending;
      if (expiresAt > now()) return;
      pending = (async () => {
        try {
          const response = await fetcher('/api/runtime-capabilities', { signal: AbortSignal.timeout(5_000) });
          if (!response.ok) throw new Error('Capabilities unavailable');
          const body = await response.json();
          snapshot = {
            economicFred: body?.features?.economicFred === true,
            aisRelay: body?.features?.aisRelay === true,
          };
          expiresAt = now() + 5 * 60_000;
        } catch {
          snapshot = { ...unavailable };
          expiresAt = now() + 60_000;
        } finally { pending = undefined; }
      })();
      return pending;
    },
  };
}

const loader = createHostedCapabilityLoader((...args) => globalThis.fetch(...args));
export const ensureHostedCapabilities = (): Promise<void> => loader.ensure();
export const isHostedFeatureAvailable = (feature: HostedFeature): boolean => loader.available(feature);
