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
const RETRYABLE_ERRORS = new Set(['MODEL_RATE_LIMIT', 'MODEL_UPSTREAM', 'MODEL_NETWORK', 'MODEL_TIMEOUT', 'MODEL_RESPONSE_INVALID', 'MODEL_INCOMPLETE', 'MODEL_OUTPUT_INVALID']);
const ERROR_CODES = new Set([...RETRYABLE_ERRORS, 'MODEL_CONFIG', 'MODEL_AUTH', 'MODEL_REFUSAL', 'MODEL_HTTP']);
const safeHttpStatus = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
const httpErrorCode = status => [401, 403].includes(status) ? 'MODEL_AUTH' : status === 429 ? 'MODEL_RATE_LIMIT' : status >= 500 ? 'MODEL_UPSTREAM' : 'MODEL_HTTP';
function modelError(code, message, httpStatus) {
  return Object.assign(new Error(message), { code, retryable: RETRYABLE_ERRORS.has(code),
    ...(safeHttpStatus(httpStatus) ? { httpStatus } : {}) });
}

function validateConfig(raw) {
  if (!raw || typeof raw !== 'object') throw modelError('MODEL_CONFIG', 'LLM configuration is unavailable.');
  if (typeof raw.apiKey !== 'string' || !raw.apiKey.trim()) throw modelError('MODEL_CONFIG', 'LLM runtime credential is missing.');
  if (typeof raw.model !== 'string' || !raw.model.trim()) throw modelError('MODEL_CONFIG', 'LLM model is missing.');
  let url;
  try { url = new URL(raw.baseUrl); } catch { throw modelError('MODEL_CONFIG', 'LLM endpoint is invalid.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.search || url.hash) throw modelError('MODEL_CONFIG', 'LLM endpoint must use HTTPS without credentials or query parameters.');
  if (!MODES.has(raw.apiMode)) throw modelError('MODEL_CONFIG', 'Hermes uses an unsupported API mode; configure a compatible GPT endpoint.');
  if (!EFFORTS.has(raw.reasoningEffort)) throw modelError('MODEL_CONFIG', 'LLM reasoning effort is invalid.');
  return { ...raw, apiKey: raw.apiKey.trim(), baseUrl: url.href.replace(/\/$/, ''), model: raw.model.trim() };
}

/** Resolve credentials once per run, in memory. Explicit endpoint/key overrides
 * must be supplied together so a Hermes key never leaks to another endpoint. */
export async function loadLlmConfig({ env = process.env, bridgeImpl } = {}) {
  const keys = ['API_KEY', 'BASE_URL', 'MODEL'];
  const explicit = keys.some(key => env[`PERK_LLM_${key}`] !== undefined);
  if (explicit) {
    if (!keys.every(key => typeof env[`PERK_LLM_${key}`] === 'string' && env[`PERK_LLM_${key}`].trim())) throw modelError('MODEL_CONFIG', 'PERK_LLM_API_KEY, PERK_LLM_BASE_URL and PERK_LLM_MODEL must be supplied together.');
    return validateConfig({
      apiKey: env.PERK_LLM_API_KEY, baseUrl: env.PERK_LLM_BASE_URL,
      model: env.PERK_LLM_MODEL, configuredModel: env.PERK_LLM_MODEL,
      apiMode: env.PERK_LLM_API_MODE || 'chat_completions',
      reasoningEffort: env.PERK_LLM_REASONING_EFFORT || 'medium', source: 'runtime-environment',
    });
  }
  if (env.PERK_LLM_API_MODE !== undefined || env.PERK_LLM_REASONING_EFFORT !== undefined) throw modelError('MODEL_CONFIG', 'Mode/effort overrides require the full PERK_LLM endpoint, key and model configuration.');
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
  } catch { throw modelError('MODEL_CONFIG', 'Unable to read the Hermes runtime. Check its local installation and configuration.'); }
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
  if (announced > maxBytes) { await response.body?.cancel(); throw modelError('MODEL_RESPONSE_INVALID', 'LLM response exceeds the size limit.'); }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw modelError('MODEL_RESPONSE_INVALID', 'LLM response exceeds the size limit.'); }
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
  try { data = JSON.parse(body); } catch { throw modelError('MODEL_RESPONSE_INVALID', 'LLM returned an invalid response envelope.'); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw modelError('MODEL_RESPONSE_INVALID', 'LLM returned an invalid response envelope.');
  let content;
  if (config.apiMode === 'chat_completions') {
    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    if (choice?.message?.refusal || choice?.finish_reason === 'content_filter') throw modelError('MODEL_REFUSAL', 'LLM declined this extraction.');
    if (choice?.finish_reason !== 'stop') throw modelError('MODEL_INCOMPLETE', 'LLM extraction was incomplete.');
    content = choice.message?.content;
  } else {
    if (data.status !== 'completed') throw modelError('MODEL_INCOMPLETE', 'LLM extraction was incomplete.');
    if (!Array.isArray(data.output)) throw modelError('MODEL_RESPONSE_INVALID', 'LLM returned an invalid response envelope.');
    const blocks = data.output.flatMap(item => Array.isArray(item?.content) ? item.content : []);
    if (blocks.some(block => block.type === 'refusal')) throw modelError('MODEL_REFUSAL', 'LLM declined this extraction.');
    content = blocks.filter(block => block.type === 'output_text').map(block => block.text || '').join('');
  }
  if (typeof content !== 'string' || !content.trim()) throw modelError('MODEL_OUTPUT_INVALID', 'LLM returned no JSON extraction.');
  let value;
  try { value = JSON.parse(content); } catch { throw modelError('MODEL_OUTPUT_INVALID', 'LLM extraction is not strict JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw modelError('MODEL_OUTPUT_INVALID', 'LLM extraction must be one JSON object.');
  return { value, model: config.model, usage: safeUsage(data.usage) };
}

/** Model output remains untrusted; callers must apply domain/evidence checks. */
export async function callJson({ system, prompt, schema, name = 'perk_extraction', config,
  fetchImpl = fetch, timeoutMs = 120000, sleepImpl = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms)),
} = {}) {
  config = validateConfig(config);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw modelError('MODEL_CONFIG', 'LLM timeout must be between 1 and 120000 milliseconds.');
  if (typeof system !== 'string' || typeof prompt !== 'string' || !schema || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) throw modelError('MODEL_CONFIG', 'LLM request arguments are invalid.');
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
      } catch { throw modelError(controller.signal.aborted ? 'MODEL_TIMEOUT' : 'MODEL_NETWORK', controller.signal.aborted ? 'LLM request timed out.' : 'LLM network request failed.'); }
      let body;
      try { body = await boundedText(response, MAX_RESPONSE_BYTES); }
      catch (error) {
        const httpStatus = safeHttpStatus(response.status);
        const code = !response.ok && httpStatus ? httpErrorCode(httpStatus) : controller.signal.aborted ? 'MODEL_TIMEOUT' : 'MODEL_RESPONSE_INVALID';
        const message = controller.signal.aborted ? 'LLM request timed out.' : error.message === 'LLM response exceeds the size limit.' ? error.message : 'Unable to read the LLM response.';
        throw modelError(code, message, httpStatus);
      }
      if (!response.ok) {
        if (!fallback && formatUnsupported(response.status, body)) { fallback = true; continue; }
        if ((response.status === 429 || response.status >= 500) && transientRetries < 2) {
          transientRetries++;
          await sleepImpl(250 * 2 ** (transientRetries - 1));
          if (controller.signal.aborted) throw modelError('MODEL_TIMEOUT', 'LLM request timed out.', response.status);
          continue;
        }
        const httpStatus = safeHttpStatus(response.status);
        const code = httpErrorCode(httpStatus);
        throw modelError(code, httpStatus ? `LLM request failed (HTTP ${httpStatus}).` : 'LLM request failed.', httpStatus);
      }
      try { return responseOutput(body, config); }
      catch (error) {
        if (ERROR_CODES.has(error?.code)) throw modelError(error.code, error.message, response.status);
        throw modelError('MODEL_RESPONSE_INVALID', 'LLM returned an invalid response envelope.', response.status);
      }
    }
  } finally { clearTimeout(timer); }
}
