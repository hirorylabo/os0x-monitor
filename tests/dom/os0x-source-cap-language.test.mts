import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { App } from '@/App';

const sourceLanguage = (): string => {
  const app = Object.create(App.prototype) as App;
  return (Reflect.get(app, 'currentSourceCapLanguage') as () => string).call(app);
};
const originalInitialized = i18next.isInitialized;
const originalLanguage = i18next.language;

beforeEach(() => {
  i18next.isInitialized = false;
  localStorage.clear();
  history.replaceState({}, '', '/dashboard');
  vi.spyOn(navigator, 'language', 'get').mockReturnValue('en-US');
});
afterEach(() => {
  i18next.isInitialized = originalInitialized;
  i18next.language = originalLanguage;
  localStorage.clear();
  history.replaceState({}, '', '/dashboard');
});

describe('os0x source-cap language follows the displayed UI', () => {
  it('uses Japanese deployment defaults before i18n starts on an English browser', () => {
    expect(sourceLanguage()).toBe('ja');
  });

  it('honors URL language before an explicit stored preference', () => {
    localStorage.setItem('wm-locale-explicit', 'ja');
    history.replaceState({}, '', '/dashboard?lang=fr-CA');
    expect(sourceLanguage()).toBe('fr');
  });

  it('honors explicit English and ignores unsupported URL languages', () => {
    localStorage.setItem('wm-locale-explicit', 'en');
    history.replaceState({}, '', '/dashboard?lang=zz');
    expect(sourceLanguage()).toBe('en');
  });

  it('uses the initialized language after i18n resolves the active UI', () => {
    localStorage.setItem('wm-locale-explicit', 'en');
    i18next.language = 'ja-JP';
    i18next.isInitialized = true;
    expect(sourceLanguage()).toBe('ja');
  });
});
