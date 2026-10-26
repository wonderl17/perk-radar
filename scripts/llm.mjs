import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const BRIDGE = resolve(dirname(fileURLToPath(import.meta.url)), 'hermes-config.py');
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MODES = new Set(['chat_completions', 'responses', 'codex_responses']);
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

function validateConfig(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('LLM configuration is unavailable.');
  if (typeof raw.apiKey !== 'string' || !raw.apiKey.trim()) throw new Error('LLM runtime credential is missing.');
  if (typeof raw.model !== 'string' || !raw.model.trim()) throw new Error('LLM model is missing.');
  let url;
  try { url = new URL(raw.baseUrl); } catch { throw new Error('LLM endpoint is invalid.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) throw new Error('LLM endpoint must use HTTPS without credentials or query parameters.');
  if (!MODES.has(raw.apiMode)) throw new Error('Hermes uses an unsupported API mode; configure a compatible GPT endpoint.');
  if (!EFFORTS.has(raw.reasoningEffort)) throw new Error('LLM reasoning effort is invalid.');
  return { ...raw, apiKey: raw.apiKey.trim(), baseUrl: url.href.replace(/\/$/, ''), model: raw.model.trim() };
}

/** Resolve credentials once per run, in memory. Explicit endpoint/key overrides
 * must be supplied together so a Hermes key never leaks to another endpoint. */
export async function loadLlmConfig({ env = process.env, bridgeImpl } = {}) {
  const keys = ['API_KEY', 'BASE_URL', 'MODEL'];
  const explicit = keys.some(key => env[`PERK_LLM_${key}`] !== undefined);
  if (explicit) {
    if (!keys.every(key => typeof env[`PERK_LLM_${key}`] === 'string' && env[`PERK_LLM_${key}`].trim())) throw new Error('PERK_LLM_API_KEY, PERK_LLM_BASE_URL and PERK_LLM_MODEL must be supplied together.');
    return validateConfig({
      apiKey: env.PERK_LLM_API_KEY, baseUrl: env.PERK_LLM_BASE_URL,
      model: env.PERK_LLM_MODEL, configuredModel: env.PERK_LLM_MODEL,
      apiMode: env.PERK_LLM_API_MODE || 'chat_completions',
      reasoningEffort: env.PERK_LLM_REASONING_EFFORT || 'medium', source: 'runtime-environment',
    });
  }
  if (env.PERK_LLM_API_MODE !== undefined || env.PERK_LLM_REASONING_EFFORT !== undefined) throw new Error('Mode/effort overrides require the full PERK_LLM endpoint, key and model configuration.');
  let raw;
  try {
    if (bridgeImpl) raw = await bridgeImpl();
    else {
      const home = resolve(env.PERK_HERMES_HOME || resolve(homedir(), '.hermes'));
      const repo = resolve(env.PERK_HERMES_REPO || resolve(home, 'hermes-agent'));
      const python = env.PERK_HERMES_PYTHON || resolve(repo, 'venv/bin/python');
      const { stdout } = await execFileAsync(python, [BRIDGE], {
        env: { ...env, PERK_HERMES_HOME: home, PERK_HERMES_REPO: repo, PERK_LLM_CONFIG_PIPE: '1' },
        timeout: 30000, maxBuffer: 262144, windowsHide: true,
      });
      raw = JSON.parse(stdout);
    }
  } catch { throw new Error('Unable to read the Hermes runtime. Check its local installation and configuration.'); }
  return validateConfig(raw);
}

function outputFormat(name, schema, fallback) {
  return fallback ? { type: 'json_object' } : { type: 'json_schema', name, schema, strict: true };
}
function requestBody({ system, prompt, schema, name, config, fallback }) {
  const instructions = fallback ? `${system}\nReturn only one JSON object matching this exact JSON Schema: ${JSON.stringify(schema)}` : system;
  if (config.apiMode === 'chat_completions') {
    const format = outputFormat(name, schema, fallback);
    return { model: config.model, reasoning_effort: config.reasoningEffort,
      messages: [{ role: 'system', content: instructions }, { role: 'user', content: prompt }],
      response_format: fallback ? format : { type: 'json_schema', json_schema: { name, schema, strict: true } },
    };
  }
  return { model: config.model, reasoning: { effort: config.reasoningEffort },
    input: [{ role: 'system', content: instructions }, { role: 'user', content: prompt }],
    text: { format: outputFormat(name, schema, fallback) }, store: false,
  };
}
async function boundedText(response, maxBytes) {
  const announced = Number(response.headers?.get('content-length'));
  if (announced > maxBytes) { await response.body?.cancel(); throw new Error('LLM response exceeds the size limit.'); }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new Error('LLM response exceeds the size limit.'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks.map(value => Buffer.from(value)), total).toString('utf8');
}
function formatUnsupported(status, body) {
  if (status !== 400) return false;
  let message;
  try { const error = JSON.parse(body).error; message = `${error?.param || ''} ${error?.code || ''} ${error?.message || ''}`; } catch { return false; }
  return /response_format|json_schema|text\.format|structured.{0,10}output/i.test(message) && /not supported|unsupported|unknown parameter|unrecognized|not available/i.test(message);
}
function safeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const result = {};
  for (const key of ['input_tokens', 'output_tokens', 'total_tokens', 'prompt_tokens', 'completion_tokens']) {
    if (Number.isFinite(raw[key]) && raw[key] >= 0) result[key] = raw[key];
  }
  return Object.keys(result).length ? result : null;
}
function responseOutput(body, config) {
  let data;
  try { data = JSON.parse(body); } catch { throw new Error('LLM returned an invalid response envelope.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('LLM returned an invalid response envelope.');
  let content;
  if (config.apiMode === 'chat_completions') {
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') throw new Error('LLM declined this extraction.');
    if (choice?.finish_reason !== 'stop') throw new Error('LLM extraction was incomplete.');
    content = choice.message?.content;
  } else {
    if (data.status !== 'completed') throw new Error('LLM extraction was incomplete.');
    if (!Array.isArray(data.output)) throw new Error('LLM returned an invalid response envelope.');
    const blocks = data.output.flatMap(item => Array.isArray(item?.content) ? item.content : []);
    if (blocks.some(block => block.type === 'refusal')) throw new Error('LLM declined this extraction.');
    content = blocks.filter(block => block.type === 'output_text').map(block => block.text || '').join('');
  }
  if (typeof content !== 'string' || !content.trim()) throw new Error('LLM returned no JSON extraction.');
  let value;
  try { value = JSON.parse(content); } catch { throw new Error('LLM extraction is not strict JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LLM extraction must be one JSON object.');
  return { value, model: config.model, usage: safeUsage(data.usage) };
}

/** Model output remains untrusted; callers must apply domain/evidence checks. */
export async function callJson({ system, prompt, schema, name = 'perk_extraction', config,
  fetchImpl = fetch, timeoutMs = 120000, sleepImpl = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
} = {}) {
  config = validateConfig(config);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('LLM timeout must be between 1 and 120000 milliseconds.');
  if (typeof system !== 'string' || typeof prompt !== 'string' || !schema || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw new Error('LLM request arguments are invalid.');
  const suffix = config.apiMode === 'chat_completions' ? '/chat/completions' : '/responses';
  const endpoint = config.baseUrl + suffix;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let fallback = false, transientRetries = 0;
  try {
    while (true) {
      let response;
      try {
        response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody({ system, prompt, schema, name, config, fallback })),
        });
      } catch { throw new Error(controller.signal.aborted ? 'LLM request timed out.' : 'LLM network request failed.'); }
      let body;
      try { body = await boundedText(response, MAX_RESPONSE_BYTES); }
      catch (error) { if (controller.signal.aborted) throw new Error('LLM request timed out.'); throw new Error(error.message === 'LLM response exceeds the size limit.' ? error.message : 'Unable to read the LLM response.'); }
      if (!response.ok) {
        if (!fallback && formatUnsupported(response.status, body)) { fallback = true; continue; }
        if ((response.status === 429 || response.status >= 500) && transientRetries < 2) {
          transientRetries++;
          await sleepImpl(250 * 2 ** (transientRetries - 1));
          if (controller.signal.aborted) throw new Error('LLM request timed out.');
          continue;
        }
        throw new Error(`LLM request failed (HTTP ${response.status}).`);
      }
      return responseOutput(body, config);
    }
  } finally { clearTimeout(timer); }
}
