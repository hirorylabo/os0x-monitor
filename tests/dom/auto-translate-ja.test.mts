import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const translation = vi.hoisted(() => ({
  isJapaneseLocale: vi.fn(() => true),
  getCachedJapaneseTranslation: vi.fn((): string | null => null),
  translateBatchToJapanese: vi.fn(async (texts: string[]) => texts.map(text => `日本語: ${text}`)),
}));
vi.mock('@/services/translation', () => translation);

import { autoTranslateBriefContent, autoTranslateContent } from '@/components/news/auto-translate';
import { formatIntelBrief } from '@/utils/format-intel-brief';

function title(text = 'Original headline'): HTMLElement {
  const element = document.createElement('a');
  element.className = 'item-title';
  element.href = 'https://example.com/story';
  element.textContent = text;
  document.body.appendChild(element);
  return element;
}

beforeEach(() => {
  translation.isJapaneseLocale.mockReturnValue(true);
  translation.getCachedJapaneseTranslation.mockReturnValue(null);
  translation.translateBatchToJapanese.mockReset().mockImplementation(async texts => texts.map(text => `日本語: ${text}`));
});
afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); });

describe('Japanese display translation', () => {
  it('preserves clickable citations and escapes translated brief text', async () => {
    const root = document.createElement('div');
    const brief = document.createElement('div');
    brief.className = 'insights-brief-text';
    const sources = [{ title: 'Original source', url: 'https://example.com/source' }];
    brief.innerHTML = formatIntelBrief('Original brief [1]', { sources });
    root.append(brief);
    document.body.append(root);
    translation.translateBatchToJapanese.mockResolvedValueOnce(['日本語の要約 [1] <script>bad</script>']);
    autoTranslateBriefContent(root, 'Original brief [1]', sources);
    await vi.waitFor(() => expect(brief.textContent).toContain('日本語の要約'));
    expect(brief.querySelector('.cb-citation')?.getAttribute('href')).toBe('https://example.com/source');
    expect(brief.querySelector('script')).toBeNull();
    expect(brief.textContent).toContain('<script>bad</script>');
  });

  it('translates display text while preserving its original and source link', async () => {
    const element = title();
    autoTranslateContent(document.body, '.item-title');
    await vi.waitFor(() => expect(element.textContent).toBe('日本語: Original headline'));
    expect(element.title).toBe('Original headline');
    expect(element.dataset.jaOriginal).toBe('Original headline');
    expect(element.href).toBe('https://example.com/story');
  });

  it('uses cached Japanese text on the first render without a request', () => {
    translation.getCachedJapaneseTranslation.mockReturnValue('キャッシュ済みの見出し');
    const element = title();
    autoTranslateContent(document.body, '.item-title');
    expect(element.textContent).toBe('キャッシュ済みの見出し');
    expect(translation.translateBatchToJapanese).not.toHaveBeenCalled();
  });

  it('keeps original text on provider failure and skips non-Japanese UI', async () => {
    const element = title();
    translation.translateBatchToJapanese.mockRejectedValueOnce(new Error('offline'));
    autoTranslateContent(document.body, '.item-title');
    await Promise.resolve();
    expect(element.textContent).toBe('Original headline');
    translation.isJapaneseLocale.mockReturnValue(false);
    translation.translateBatchToJapanese.mockClear();
    autoTranslateContent(document.body, '.item-title');
    expect(translation.translateBatchToJapanese).not.toHaveBeenCalled();
  });

  it('does not overwrite a new render or a manually translated headline', async () => {
    let resolve!: (values: string[]) => void;
    translation.translateBatchToJapanese.mockReturnValueOnce(new Promise(done => { resolve = done; }));
    const detached = title('Old headline');
    const manual = title('Another headline');
    autoTranslateContent(document.body, '.item-title');
    detached.remove();
    manual.textContent = '手動で翻訳した見出し';
    resolve(['古い見出し', '別の見出し']);
    await Promise.resolve();
    expect(detached.textContent).toBe('Old headline');
    expect(manual.textContent).toBe('手動で翻訳した見出し');
  });
});
