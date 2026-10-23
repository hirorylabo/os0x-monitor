import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { initTestI18n } from './helpers/i18n.mts';

const mocks = vi.hoisted(() => ({
  fred: vi.fn(),
  euYield: vi.fn(),
  eurostat: vi.fn(),
  china: vi.fn(),
  available: vi.fn(() => false),
}));
vi.mock('@/services/runtime-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/runtime-config')>()),
  isFeatureAvailable: mocks.available,
}));
vi.mock('@/services/economic', () => ({ getEurostatCountryData: mocks.eurostat }));
vi.mock('@/services/bootstrap', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/bootstrap')>()),
  getHydratedData: () => undefined,
}));
vi.mock('@/generated/client/worldmonitor/economic/v1/service_client', () => ({
  EconomicServiceClient: class {
    getFredSeriesBatch = mocks.fred;
    getEuYieldCurve = mocks.euYield;
    getChinaMacroSnapshot = mocks.china;
  },
}));

import { YieldCurvePanel } from '@/components/YieldCurvePanel';
import { MacroTilesPanel } from '@/components/MacroTilesPanel';

const panels: Array<YieldCurvePanel | MacroTilesPanel> = [];
beforeAll(initTestI18n);
beforeEach(() => {
  vi.useFakeTimers();
  mocks.available.mockReturnValue(false);
  mocks.fred.mockReset();
  mocks.euYield.mockReset();
  mocks.eurostat.mockReset();
  mocks.china.mockReset().mockResolvedValue({ unavailable: true, indicators: [] });
});
afterEach(() => {
  for (const panel of panels.splice(0)) {
    panel.destroy();
    panel.getElement().remove();
  }
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('FRED capability guards', () => {
  it('settles the yield panel as unavailable without calling a disabled API', async () => {
    const panel = new YieldCurvePanel();
    panels.push(panel);
    document.body.append(panel.getElement());
    expect(await panel.fetchData()).toBe(false);
    expect(mocks.fred).not.toHaveBeenCalled();
    expect(mocks.euYield).not.toHaveBeenCalled();
    expect(panel.getElement().textContent).toContain('No data available');
    expect(panel.getElement().querySelector('.panel-loading')).toBeNull();
  });

  it('keeps public Euro Area macro data available while skipping FRED', async () => {
    mocks.eurostat.mockResolvedValue({
      unavailable: false,
      countries: { DE: {
        cpi: { value: 2.1, priorValue: 2.2, hasPrior: true, date: '2026-10' },
      } },
    });
    const panel = new MacroTilesPanel();
    panels.push(panel);
    document.body.append(panel.getElement());
    expect(await panel.fetchData()).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.fred).not.toHaveBeenCalled();
    expect(mocks.eurostat).toHaveBeenCalledOnce();
    expect(panel.getElement().querySelector('[data-tab="eu"].active')).not.toBeNull();
    expect(panel.getElement().textContent).toContain('2.1%');
    expect(panel.getElement().querySelector('.panel-loading')).toBeNull();
    panel.getElement().querySelector<HTMLButtonElement>('[data-tab="us"]')!.click();
    await vi.advanceTimersByTimeAsync(200);
    expect(panel.getElement().textContent).toContain('No data available');
  });

  it('settles the macro panel when every eligible public source is unavailable', async () => {
    mocks.eurostat.mockResolvedValue({ unavailable: true, countries: {} });
    const panel = new MacroTilesPanel();
    panels.push(panel);
    document.body.append(panel.getElement());
    expect(await panel.fetchData()).toBe(false);
    expect(mocks.fred).not.toHaveBeenCalled();
    expect(panel.getElement().textContent).toContain('Macro data unavailable');
    expect(panel.getElement().querySelector('.panel-loading')).toBeNull();
  });
});
