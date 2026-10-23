import { getCorsHeaders, isDisallowedOrigin } from './_cors.js';
import { checkRateLimit } from './_rate-limit.js';
import { getCachedJson, setCachedJson } from './_upstash-cache.js';

export const REQUEST_TIMEOUT_MS = 22_000;
export const MAX_TEXT_LENGTH = 1600;
const inflight = new Map();

export class RequestError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export class BudgetError extends Error {
  constructor(response) { super('AI budget unavailable'); this.response = response; }
}
export function jsonResponse(value, cors, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: {
    'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors,
  } });
}
export function requestGate(request) {
  const cors = getCorsHeaders(request, 'POST, OPTIONS');
  if (isDisallowedOrigin(request)) return { cors, response: jsonResponse({ error: 'Origin not allowed' }, cors, 403) };
  if (request.method === 'OPTIONS') return { cors, response: new Response(null, { status: 204, headers: cors }) };
  if (request.method !== 'POST') return { cors, response: jsonResponse({ error: 'Method not allowed' }, cors, 405) };
  return { cors, response: null };
}
export async function bounded(work, milliseconds, fallback) {
  let timer;
  try {
    return await Promise.race([work, new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), Math.max(1, milliseconds)); })]);
  } finally { clearTimeout(timer); }
}
export async function readJson(request) {
  if (!request.body) throw new RequestError('JSON body required');
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => { void reader.cancel().catch(() => {}); }, 2_000);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32_768) throw new RequestError('Request too large', 413);
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('JSON object required');
    return body;
  } catch (error) {
    if (error instanceof RequestError) throw error;
    throw new RequestError('Invalid JSON');
  } finally { clearTimeout(timer); void reader.cancel().catch(() => {}); }
}
export function envLimit(name, fallback, maximum) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}
export async function requestBudget(request, cors) {
  return bounded(checkRateLimit(request, cors, { scope: 'os0x-ai-requests', limit: 60, window: '1 m', failClosed: true }),
    1500, jsonResponse({ error: 'AI budget unavailable' }, cors, 503));
}
async function providerBudget(request, cors, deadline) {
  const response = await bounded(checkRateLimit(request, cors, {
    scope: 'os0x-ai-provider-daily', identifier: 'all-providers',
    limit: envLimit('OS0X_AI_DAILY_LIMIT', 1000, 100_000), window: '1 d', failClosed: true,
  }), Math.min(1500, deadline - Date.now()), jsonResponse({ error: 'AI budget unavailable' }, cors, 503));
  if (response) throw new BudgetError(response);
}
export function modelConfig() {
  return { gemini: process.env.OS0X_GEMINI_MODEL || 'gemini-3.5-flash-lite', groq: process.env.OS0X_GROQ_MODEL || 'openai/gpt-oss-20b' };
}
function credentials() {
  const gemini = [...new Set([
    process.env.GEMINI_API_KEY, process.env.GEMINI_AISTUDIO_API_KEY,
    ...[1, 2, 3].flatMap((n) => [process.env[`gemini_aistudio_api_key_0${n}`], process.env[`GEMINI_AISTUDIO_API_KEY_0${n}`]]),
  ].filter(Boolean))];
  return { gemini, groq: process.env.GROQ_API_KEY || process.env.GROQ_API_KEY_01 || '' };
}
export async function cacheIdentity(namespace, input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(input)));
  return `os0x:${namespace}:v2:${Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join('')}`;
}
export async function cachedValue(key, fallback, deadline) {
  const cached = await bounded(getCachedJson(key), Math.min(1000, deadline - Date.now()), null);
  return cached ?? fallback;
}
export async function storeValue(key, value, ttl, deadline) {
  await bounded(setCachedJson(key, value, ttl), Math.min(1000, deadline - Date.now()), false);
}
export async function singleFlight(key, work) {
  if (inflight.has(key)) return inflight.get(key);
  const pending = Promise.resolve().then(work);
  inflight.set(key, pending);
  try { return await pending; } finally { inflight.delete(key); }
}
export async function generateJapanese({ request, cors, deadline, prompt, system, validate, json = false }) {
  const keys = credentials();
  const models = modelConfig();
  // One attempt per provider; key aliases must not multiply latency or retries.
  const choices = [];
  if (keys.gemini.length) choices.push({ provider: 'gemini', model: models.gemini, key: keys.gemini[0] });
  if (keys.groq) choices.push({ provider: 'groq', model: models.groq, key: keys.groq });
  for (const choice of choices) {
    if (deadline - Date.now() < 1000) break;
    await providerBudget(request, cors, deadline);
    const signal = AbortSignal.timeout(Math.max(1, Math.min(8000, deadline - Date.now() - 500)));
    try {
      const gemini = choice.provider === 'gemini';
      const response = await fetch(gemini
        ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(choice.model)}:generateContent`
        : 'https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'os0x-monitor/2.11.3',
          ...(gemini ? { 'x-goog-api-key': choice.key } : { Authorization: `Bearer ${choice.key}` }),
        },
        body: JSON.stringify(gemini ? {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: json ? 6144 : 2048,
            ...(json ? { responseMimeType: 'application/json' } : {}),
            ...(choice.model.startsWith('gemini-3.8') ? { thinkingConfig: { thinkingLevel: 'low' } } : {}),
            ...(choice.model.startsWith('gemini-3.5-flash-lite') ? { thinkingConfig: { thinkingLevel: 'minimal' } } : {}),
          },
        } : {
          model: choice.model, temperature: 0.1, max_completion_tokens: json ? 8192 : 2048,
          ...(choice.model.includes('gpt-oss') ? { reasoning_effort: 'low', include_reasoning: false } : {}),
          messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
        }),
      });
      if (!response.ok) { void response.body?.cancel().catch(() => {}); continue; }
      const data = await response.json();
      const text = gemini
        ? data?.candidates?.[0]?.content?.parts?.filter((part) => !part.thought).map((part) => part.text || '').join('').trim()
        : data?.choices?.[0]?.message?.content?.trim();
      const value = typeof text === 'string' ? validate(text) : null;
      if (value) return { value, provider: choice.provider, model: choice.model };
    } catch { /* A bounded provider failure advances once to the fallback. */ }
  }
  return null;
}
export function errorResponse(error, cors) {
  if (error instanceof BudgetError) return error.response;
  return jsonResponse({ error: error instanceof RequestError ? error.message : 'AI request failed', fallback: true }, cors,
    error instanceof RequestError ? error.status : 503);
}
