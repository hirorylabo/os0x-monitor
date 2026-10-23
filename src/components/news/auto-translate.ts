import { getCachedJapaneseTranslation, isJapaneseLocale, translateBatchToJapanese } from '@/services/translation';
import { formatIntelBrief, type IntelBriefCitationSource } from '@/utils/format-intel-brief';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';

/** Translate display text only; source models keep their original titles for search and analysis. */
export function autoTranslateContent(root: ParentNode & Node, selector: string): void {
  if (!isJapaneseLocale()) return;
  const pending: { element: HTMLElement; original: string }[] = [];
  for (const element of root.querySelectorAll<HTMLElement>(selector)) {
    if (element.dataset.jaOriginal) continue;
    const original = element.textContent?.trim();
    if (!original) continue;
    const cached = getCachedJapaneseTranslation(original);
    if (cached && cached !== original) {
      element.dataset.jaOriginal = original;
      element.title ||= original;
      element.textContent = cached;
    } else {
      pending.push({ element, original });
    }
  }
  if (pending.length === 0) return;
  void translateBatchToJapanese(pending.map(item => item.original)).then(translated => {
    if (!isJapaneseLocale()) return;
    pending.forEach(({ element, original }, index) => {
      const text = translated[index];
      // Replaced or manually translated elements must not be overwritten by an old request.
      if (!text || text === original || !root.contains(element) || element.textContent?.trim() !== original) return;
      element.dataset.jaOriginal = original;
      element.title ||= original;
      element.textContent = text;
    });
  }).catch(() => { /* Keep original content available when translation is unavailable. */ });
}

/** Reformat translated briefs through the same escaping and citation linker as the original. */
export function autoTranslateBriefContent(root: HTMLElement, brief: string | null, sources: readonly IntelBriefCitationSource[]): void {
  if (!brief || !isJapaneseLocale()) return;
  const element = root.querySelector<HTMLElement>('.insights-brief-text');
  if (!element) return;
  const originalHtml = element.innerHTML;
  const apply = (text: string | undefined): void => {
    if (!text || text === brief || !isJapaneseLocale() || !root.contains(element) || element.innerHTML !== originalHtml) return;
    setTrustedHtml(element, trustedHtml(formatIntelBrief(text, { sources }), 'formatIntelBrief escapes translated text and reconstructs source citations'));
  };
  const cached = getCachedJapaneseTranslation(brief);
  if (cached) apply(cached);
  else void translateBatchToJapanese([brief]).then(([text]) => apply(text)).catch(() => { /* Keep the original cited brief. */ });
}
