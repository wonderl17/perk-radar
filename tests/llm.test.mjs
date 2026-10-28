import test from 'node:test';
import assert from 'node:assert/strict';
import { loadLlmConfig, callJson } from '../scripts/llm.mjs';

const config = { apiKey: 'test-secret-never-log', model: 'gpt-6.1-sol', baseUrl: 'https://example.com/v1', apiMode: 'chat_completions', reasoningEffort: 'medium', source: 'hermes' };
const schema = { type: 'object', properties: { accepted: { type: 'boolean' } }, required: ['accepted'], additionalProperties: false };
const args = { system: 'Extract public benefits.', prompt: 'Public evidence only.', schema, config };
const ok = (value = { accepted: true }) => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }));
const error = (status, message, param) => new Response(JSON.stringify({ error: { message, param } }), { status });

test('default provider uses only the native Hermes result and never guesses ambient keys', async () => {
  let calls = 0;
  const result = await loadLlmConfig({ env: { OPENAI_API_KEY: 'unrelated-key', OPENAI_BASE_URL: 'https://wrong.example' }, bridgeImpl: async () => { calls++; return config; } });
  assert.equal(calls, 1);
  assert.equal(result.apiKey, config.apiKey);
  assert.equal(result.baseUrl, config.baseUrl);
  assert.equal(result.model, 'gpt-6.1-sol');
  assert.equal(result.reasoningEffort, 'medium');
});
test('explicit runtime configuration is an atomic endpoint/key/model tuple', async () => {
  let called = false;
  const bridgeImpl = () => { called = true; return config; };
  await assert.rejects(loadLlmConfig({ env: { PERK_LLM_BASE_URL: 'https://attacker.example/v1' }, bridgeImpl }), /supplied together/);
  await assert.rejects(loadLlmConfig({ env: { PERK_LLM_REASONING_EFFORT: 'high' }, bridgeImpl }), /full PERK_LLM/);
  assert.equal(called, false);
  const result = await loadLlmConfig({ env: { PERK_LLM_BASE_URL: 'https://cloud.example/v1', PERK_LLM_API_KEY: 'cloud-key', PERK_LLM_MODEL: 'explicit-gpt', PERK_LLM_REASONING_EFFORT: 'high' }, bridgeImpl });
  assert.equal(result.apiKey, 'cloud-key');
  assert.equal(result.baseUrl, 'https://cloud.example/v1');
  assert.equal(result.model, 'explicit-gpt');
  assert.equal(result.reasoningEffort, 'high');
  assert.equal(called, false);
});
test('invalid endpoints, modes and resolver failures are sanitized', async () => {
  for (const baseUrl of ['http://external.example/v1', 'https://user:password@example.com/v1', 'https://example.com/v1?token=secret']) {
    await assert.rejects(loadLlmConfig({ env: {}, bridgeImpl: async () => ({ ...config, baseUrl }) }), /endpoint/);
  }
  await assert.rejects(loadLlmConfig({ env: {}, bridgeImpl: async () => ({ ...config, apiMode: 'anthropic_messages' }) }), /unsupported API mode/);
  await assert.rejects(loadLlmConfig({ env: {}, bridgeImpl: async () => { throw new Error(config.apiKey); } }), e => !e.message.includes(config.apiKey) && /Hermes runtime/.test(e.message));
});
test('chat completions preserves model and effort, requests strict schema and blocks redirects', async () => {
  const result = await callJson({ ...args, fetchImpl: async (url, request) => {
    assert.equal(url, config.baseUrl + '/chat/completions');
    assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, `Bearer ${config.apiKey}`);
    const body = JSON.parse(request.body);
    assert.equal(body.model, config.model);
    assert.equal(body.reasoning_effort, 'medium');
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(body.response_format.json_schema.schema, schema);
    return ok();
  } });
  assert.deepEqual(result.value, { accepted: true });
  assert.equal(result.model, config.model);
});
test('only an explicit unsupported-format HTTP400 permits one JSON fallback', async () => {
  const bodies = [];
  const result = await callJson({ ...args, fetchImpl: async (_url, request) => {
    bodies.push(JSON.parse(request.body));
    return bodies.length === 1 ? error(400, 'json_schema response_format is not supported', 'response_format') : ok();
  } });
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].response_format.type, 'json_schema');
  assert.equal(bodies[1].response_format.type, 'json_object');
  assert.match(bodies[1].messages[0].content, /exact JSON Schema/);
  assert.equal(bodies[1].model, config.model);
  assert.equal(result.value.accepted, true);
  let calls = 0;
  await assert.rejects(callJson({ ...args, fetchImpl: async () => { calls++; return error(400, 'model is not supported'); } }), /HTTP 400/);
  assert.equal(calls, 1);
});
test('fallback failure stops after one downgrade, without exposing provider error text', async () => {
  let calls = 0;
  await assert.rejects(callJson({ ...args, fetchImpl: async () => { calls++; return error(400, 'unsupported response_format ' + config.apiKey, 'response_format'); } }), e => /HTTP 400/.test(e.message) && !e.message.includes(config.apiKey));
  assert.equal(calls, 2);
});
test('refusals, token truncation, invalid JSON and non-object values never become successful extractions', async () => {
  const fixtures = [
    { choices: [{ finish_reason: 'stop', message: { refusal: 'No' } }] },
    { choices: [{ finish_reason: 'length', message: { content: '{}' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: '```json\n{}\n```' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: '[]' } }] },
    { choices: [{ finish_reason: 'content_filter', message: { content: '{}' } }] },
  ];
  for (const fixture of fixtures) await assert.rejects(callJson({ ...args, fetchImpl: async () => new Response(JSON.stringify(fixture)) }), /declined|incomplete|strict JSON|one JSON object/);
});
test('Responses API uses its native schema and completion/refusal states', async () => {
  const native = { ...config, apiMode: 'responses' };
  const result = await callJson({ ...args, config: native, fetchImpl: async (url, request) => {
    assert.equal(url, config.baseUrl + '/responses');
    const body = JSON.parse(request.body);
    assert.equal(body.reasoning.effort, 'medium');
    assert.equal(body.text.format.strict, true);
    assert.equal(body.store, false);
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '{"accepted":true}' }] }] }));
  } });
  assert.equal(result.value.accepted, true);
  await assert.rejects(callJson({ ...args, config: native, fetchImpl: async () => new Response(JSON.stringify({ status: 'incomplete', output: [] })) }), /incomplete/);
  await assert.rejects(callJson({ ...args, config: native, fetchImpl: async () => new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'refusal' }] }] })) }), /declined/);
});
test('only 429/5xx retry, at most twice, and arbitrary network failures never leak secrets', async () => {
  let calls = 0;
  const waits = [];
  const result = await callJson({ ...args, sleepImpl: async ms => waits.push(ms), fetchImpl: async () => { calls++; return calls < 3 ? error(503, config.apiKey) : ok(); } });
  assert.equal(result.value.accepted, true);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [250, 500]);
  calls = 0;
  await assert.rejects(callJson({ ...args, sleepImpl: async () => {}, fetchImpl: async () => { calls++; return error(429, config.apiKey); } }), /HTTP 429/);
  assert.equal(calls, 3);
  await assert.rejects(callJson({ ...args, fetchImpl: async () => { throw new Error(config.apiKey); } }), e => e.message === 'LLM network request failed.' && !e.message.includes(config.apiKey));
});
test('timeout aborts requests and streaming size limits cannot be bypassed by absent content-length', async () => {
  await assert.rejects(callJson({ ...args, timeoutMs: 5, fetchImpl: async (_url, request) => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error(config.apiKey)))) }), /timed out/);
  await assert.rejects(callJson({ ...args, fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) }), /size limit/);
});
test('unrecognized provider envelope and usage fields cannot leak reflected credentials', async () => {
  await assert.rejects(callJson({ ...args, fetchImpl: async () => new Response('null') }), /invalid response envelope/);
  const result = await callJson({ ...args, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }], usage: { total_tokens: 4, debug: config.apiKey } })) });
  assert.deepEqual(result.usage, { total_tokens: 4 });
  assert.equal(JSON.stringify(result).includes(config.apiKey), false);
});

test('configuration and resolver failures expose only a nonretryable configuration code', async () => {
  const check = error => {
    assert.equal(error.code, 'MODEL_CONFIG');
    assert.equal(error.retryable, false);
    assert.equal(error.httpStatus, undefined);
    assert.deepEqual(Object.keys(error).sort(), ['code', 'retryable']);
    assert(!`${error.message} ${JSON.stringify(error)}`.includes(config.apiKey));
    return true;
  };
  await assert.rejects(loadLlmConfig({ env: { PERK_LLM_API_KEY: config.apiKey } }), check);
  await assert.rejects(loadLlmConfig({ env: {}, bridgeImpl: async () => { throw new Error(`private provider response ${config.apiKey}`); } }), check);
  await assert.rejects(callJson({ ...args, config: { ...config, baseUrl: `https://example.com/?token=${config.apiKey}` } }), check);
  await assert.rejects(callJson({ ...args, timeoutMs: 0 }), check);
  await assert.rejects(callJson({ ...args, name: 'invalid name' }), check);
});

test('HTTP failures have controlled categories and status numbers with unchanged retry limits', async t => {
  for (const [status, code, retryable] of [[401, 'MODEL_AUTH', false], [403, 'MODEL_AUTH', false], [429, 'MODEL_RATE_LIMIT', true], [500, 'MODEL_UPSTREAM', true], [503, 'MODEL_UPSTREAM', true], [400, 'MODEL_HTTP', false], [404, 'MODEL_HTTP', false]]) await t.test(String(status), async () => {
    let calls = 0;
    const waits = [];
    await assert.rejects(callJson({ ...args, sleepImpl: async ms => waits.push(ms), fetchImpl: async () => { calls++; return error(status, `private response ${config.apiKey}`); } }), failure => {
      assert.equal(failure.code, code);
      assert.equal(failure.httpStatus, status);
      assert.equal(failure.retryable, retryable);
      assert.deepEqual(Object.keys(failure).sort(), ['code', 'httpStatus', 'retryable']);
      assert(!`${failure.message} ${JSON.stringify(failure)}`.includes(config.apiKey));
      assert(!failure.message.includes('private response'));
      return true;
    });
    assert.equal(calls, retryable ? 3 : 1);
    assert.deepEqual(waits, retryable ? [250, 500] : []);
  });
});

test('malformed HTTP status values cannot become reflected diagnostic text or fields', async () => {
  const response = error(400, 'private response body');
  Object.defineProperty(response, 'status', { value: `private status ${config.apiKey}` });
  await assert.rejects(callJson({ ...args, fetchImpl: async () => response }), failure => {
    assert.equal(failure.code, 'MODEL_HTTP');
    assert.equal(failure.httpStatus, undefined);
    assert.equal(failure.message, 'LLM request failed.');
    assert(!JSON.stringify(failure).includes(config.apiKey));
    return true;
  });
});

test('known HTTP failure categories survive unreadable or oversized error bodies without adding retries', async t => {
  for (const [status, code, retryable] of [[401, 'MODEL_AUTH', false], [403, 'MODEL_AUTH', false], [429, 'MODEL_RATE_LIMIT', true], [503, 'MODEL_UPSTREAM', true]]) await t.test(String(status), async () => {
    for (const oversized of [false, true]) {
      let calls = 0;
      await assert.rejects(callJson({ ...args, fetchImpl: async () => {
        calls++;
        return new Response(oversized ? 'x'.repeat(2 * 1024 * 1024 + 1) : new ReadableStream({ start(controller) { controller.error(new Error(config.apiKey)); } }), { status });
      } }), failure => {
        assert.equal(failure.code, code);
        assert.equal(failure.httpStatus, status);
        assert.equal(failure.retryable, retryable);
        assert(!`${failure.message} ${JSON.stringify(failure)}`.includes(config.apiKey));
        return true;
      });
      assert.equal(calls, 1, 'unreadable bodies keep the existing stop behavior');
    }
  });
});

test('network, timeout and body read errors never expose their original exception or retry automatically', async () => {
  let calls = 0;
  await assert.rejects(callJson({ ...args, fetchImpl: async () => { calls++; throw Object.assign(new Error(config.apiKey), { code: 'MODEL_AUTH', response: 'private body' }); } }), failure => {
    assert.equal(failure.code, 'MODEL_NETWORK');
    assert.equal(failure.retryable, true);
    assert.equal(failure.httpStatus, undefined);
    assert.equal(failure.response, undefined);
    assert.equal(failure.message, 'LLM network request failed.');
    return true;
  });
  assert.equal(calls, 1);
  await assert.rejects(callJson({ ...args, timeoutMs: 1, fetchImpl: async (_url, request) => new Promise((_resolve, reject) => request.signal.addEventListener('abort', () => reject(new Error(config.apiKey)))) }), failure => failure.code === 'MODEL_TIMEOUT' && failure.retryable && !failure.message.includes(config.apiKey));
  await assert.rejects(callJson({ ...args, fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(config.apiKey)); } })) }), failure => failure.code === 'MODEL_RESPONSE_INVALID' && failure.httpStatus === 200 && failure.message === 'Unable to read the LLM response.');
  await assert.rejects(callJson({ ...args, fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) }), failure => failure.code === 'MODEL_RESPONSE_INVALID' && failure.httpStatus === 200 && /size limit/.test(failure.message));
});

test('invalid envelopes, incomplete outputs, refusals and invalid JSON retain separate safe model codes', async t => {
  const fixtures = [
    ['invalid envelope', 'MODEL_RESPONSE_INVALID', true, 'private raw response ' + config.apiKey],
    ['incomplete chat', 'MODEL_INCOMPLETE', true, { choices: [{ finish_reason: 'length', message: { content: config.apiKey } }] }],
    ['chat refusal', 'MODEL_REFUSAL', false, { choices: [{ finish_reason: 'stop', message: { refusal: config.apiKey } }] }],
    ['invalid JSON', 'MODEL_OUTPUT_INVALID', true, { choices: [{ finish_reason: 'stop', message: { content: config.apiKey } }] }],
    ['non-object JSON', 'MODEL_OUTPUT_INVALID', true, { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(config.apiKey) } }] }],
    ['incomplete response', 'MODEL_INCOMPLETE', true, { status: 'incomplete', incomplete_details: { reason: config.apiKey }, output: [] }, 'responses'],
    ['response refusal', 'MODEL_REFUSAL', false, { status: 'completed', output: [{ content: [{ type: 'refusal', refusal: config.apiKey }] }] }, 'responses'],
    ['malformed response block', 'MODEL_RESPONSE_INVALID', true, { status: 'completed', output: [{ content: [null] }] }, 'responses'],
  ];
  for (const [label, code, retryable, payload, apiMode = 'chat_completions'] of fixtures) await t.test(label, async () => {
    let calls = 0;
    await assert.rejects(callJson({ ...args, config: { ...config, apiMode }, fetchImpl: async () => { calls++; return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload)); } }), failure => {
      assert.equal(failure.code, code);
      assert.equal(failure.retryable, retryable);
      assert.equal(failure.httpStatus, 200);
      assert.equal(failure.cause, undefined);
      assert(!`${failure.message} ${JSON.stringify(failure)}`.includes(config.apiKey));
      return true;
    });
    assert.equal(calls, 1);
  });
});
