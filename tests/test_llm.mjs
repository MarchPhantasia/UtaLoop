import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { config, loadConfig, removeModelProvider, saveModelProvider, selectModelProvider } from '../web/js/config.js';
import { chat, chatJSON, chatStream, listModels, LLMError } from '../web/js/llm.js';
import { errorMessage } from '../web/js/errors.js';

const messages = [{ role: 'user', content: 'test' }];
const completeJSON = () => chat({ messages, json: true, retries: 0 });
const reply = (content, finish_reason = 'stop') => Response.json({ choices: [{ message: { content }, finish_reason }] });
beforeEach(() => Object.assign(config, { baseUrl: 'https://model.example', model: 'test', apiKey: '',
  reasoningEffort: '', jsonMode: 1, timeout: 10 }));

test('regular and streaming model failures provide Chinese guidance without exposing server bodies', async (t) => {
  for (const status of [400, 401, 403, 404, 413, 422, 429, 500, 503]) {
    t.mock.method(globalThis, 'fetch', async () => new Response('<html>private key 私密内容</html>', { status }));
    for (const run of [() => chat({ messages, retries: 0 }), () => chatStream({ messages })]) {
      await assert.rejects(run(), (error) => {
        assert.ok(error instanceof LLMError);
        assert.equal(error.status, status);
        assert.match(error.message, /请/);
        assert.doesNotMatch(error.message, /private|私密|html/);
        return true;
      });
    }
    t.mock.restoreAll();
  }
});

test('empty model content and malformed success responses fail in both modes', async (t) => {
  for (const content of ['', '   ', null, []]) {
    t.mock.method(globalThis, 'fetch', async () => reply(content));
    await assert.rejects(completeJSON(), /未返回内容/);
    await assert.rejects(chatStream({ messages }), /未返回内容/);
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>Sign in</html>'));
  await assert.rejects(completeJSON(), /返回格式异常/);
  await assert.rejects(chatStream({ messages }), /返回格式异常/);
});

test('JSON fallback stays local to the interface and model, even if the active provider changes during a retry', async (t) => {
  const bodies = [];
  Object.assign(config, { baseUrl: 'https://first.example', apiKey: 'first-key', reasoningEffort: 'low' });
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push({ url, body, key: init.headers.Authorization });
    if (bodies.length === 1) {
      Object.assign(config, { baseUrl: 'https://second.example', apiKey: 'second-key', model: 'second', reasoningEffort: 'high' });
      return new Response('Unsupported', { status: 400 });
    }
    return reply('{"ok":true}');
  });
  assert.equal(await completeJSON(), '{"ok":true}');
  assert.equal(bodies.length, 2);
  for (const { url, body, key } of bodies) {
    assert.equal(url, 'https://first.example/v1/chat/completions');
    assert.equal(key, 'Bearer first-key');
    assert.equal(body.model, 'test');
    assert.equal(body.reasoning_effort, 'low');
  }
  assert.equal(bodies[1].body.response_format, undefined);
  await completeJSON();
  assert.deepEqual(bodies[2].body.response_format, { type: 'json_object' });
  assert.equal(bodies[2].key, 'Bearer second-key');
  assert.equal(bodies[2].body.reasoning_effort, 'high');
});

test('invalid structured output is actionable and does not echo the model output', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => reply('Private model output 私密内容'));
  await assert.rejects(chatJSON({ messages, retries: 0 }), (error) => /JSON/.test(error.message)
    && !/Private|私密/.test(error.message));
});

test('output truncation increases the limit once, then suggests adjusting the reasoning effort', async (t) => {
  const caps = [];
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    caps.push(JSON.parse(init.body).max_tokens); return reply('', 'length');
  });
  await assert.rejects(chat({ messages, maxTokens: 256, retries: 0 }), /输出达到上限.*降低思考程度/);
  assert.deepEqual(caps, [256, 512]);
});

test('timeouts stay visible in regular and streaming requests while user cancellation stays an AbortError', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(globalThis, 'fetch', async (_url, init) => new Promise((_resolve, reject) => {
    if (init.signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
    init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  const regular = chat({ messages, retries: 0 });
  t.mock.timers.tick(10000);
  await assert.rejects(regular, /超时/);
  const stream = chatStream({ messages });
  t.mock.timers.tick(60000);
  await assert.rejects(stream, (error) => error.name === 'LLMError' && /超时/.test(error.message));
  const controller = new AbortController();
  const cancelled = chatStream({ messages, signal: controller.signal }); controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
});

test('network and mixed-content failures use targeted guidance without raw browser exceptions', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(chat({ messages, retries: 0 }), (error) => /CORS/.test(error.message) && !/Failed to fetch/.test(error.message));
  globalThis.location = { protocol: 'https:' };
  t.after(() => { delete globalThis.location; });
  config.baseUrl = 'http://model.example';
  await assert.rejects(chat({ messages, retries: 0 }), /使用 HTTPS/);
});

test('the local page routes model discovery and both chat modes through the same-origin relay', async (t) => {
  globalThis.location = new URL('http://127.0.0.1:13876/player.html');
  t.after(() => { delete globalThis.location; });
  const calls = [];
  const marker = 'X-UtaLoop-LLM';
  const draft = { baseUrl: 'https://provider.example/team/v1?tenant=uta', apiKey: 'draft-key', model: 'draft-model' };
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, ...init, body: JSON.parse(init.body) });
    const headers = { [marker]: '1' };
    if (url === '/llm/models') return Response.json({ data: [{ id: 'draft-model' }] }, { headers });
    if (calls.at(-1).body.payload.stream) return new Response('data: {"choices":[{"delta":{"content":"持续"}}]}\n\n', {
      headers: { ...headers, 'Content-Type': 'text/event-stream' },
    });
    return Response.json({ choices: [{ message: { content: 'OK' } }] }, { headers });
  });
  assert.deepEqual(await listModels(draft), [{ id: 'draft-model', name: '' }]);
  assert.equal(await chat({ messages, connection: draft, retries: 0 }), 'OK');
  assert.equal(await chatStream({ messages }), '持续');
  assert.deepEqual(calls.map(({ url, body }) => [url, body.endpoint]), [
    ['/llm/models', 'https://provider.example/team/v1/models?tenant=uta'],
    ['/llm/chat', 'https://provider.example/team/v1/chat/completions?tenant=uta'],
    ['/llm/chat', 'https://model.example/v1/chat/completions'],
  ]);
  for (const call of calls) {
    assert.equal(call.method, 'POST');
    assert.equal(call.credentials, 'omit');
    assert.equal(call.headers[marker], '1');
    assert.equal('apiKey' in call.body, false);
  }
  assert.equal(calls[0].headers.Authorization, 'Bearer draft-key');
  assert.equal(calls[1].body.payload.model, 'draft-model');
  assert.equal(config.model, 'test');
});

test('legacy local servers can fall back, but provider errors from the relay never trigger a direct request', async (t) => {
  globalThis.location = new URL('http://localhost:13876/');
  t.after(() => { delete globalThis.location; });
  const urls = [];
  let local = new Response(null, { status: 404 });
  t.mock.method(globalThis, 'fetch', async url => {
    urls.push(url);
    return url.startsWith('/') ? local : reply('OK');
  });
  assert.equal(await chat({ messages, retries: 0 }), 'OK');
  assert.deepEqual(urls.splice(0), ['/llm/chat', 'https://model.example/v1/chat/completions']);
  local = new Response('private response', { status: 404, headers: { 'X-UtaLoop-LLM': '1' } });
  await assert.rejects(listModels(config), /手动填写模型 ID/);
  assert.deepEqual(urls.splice(0), ['/llm/models']);
  local = new Response('private response', { status: 502,
    headers: { 'X-UtaLoop-LLM': '1', 'X-UtaLoop-LLM-Error': 'tls' } });
  await assert.rejects(chat({ messages, retries: 0 }), error => /HTTPS/.test(error.message) && !/private/.test(error.message));
  assert.deepEqual(urls, ['/llm/chat']);
});

test('platform and native error codes preserve the recovery action and hide internal detail', () => {
  assert.match(errorMessage(new DOMException('Quota exceeded', 'QuotaExceededError')), /存储空间不足/);
  assert.equal(errorMessage(new Error('AVAudioSession failed'), '播放失败，请重试'), '播放失败，请重试');
  const timeout = Object.assign(new Error('原生回调缺失（PIP_START_NO_CALLBACK）'), { code: 'PIP_START_NO_CALLBACK' });
  assert.match(errorMessage(timeout), /启动超时.*重试/);
  assert.doesNotMatch(errorMessage(timeout), /PIP_|回调|权限/);
});

test('streaming errors after a partial answer stay visible without reflecting the error payload', async (t) => {
  const partial = 'data: {"choices":[{"delta":{"content":"部分讲解"}}]}\n\n';
  t.mock.method(globalThis, 'fetch', async () => new Response(partial + 'data: {"error":{"message":"private 私密数据"}}\n\n',
    { headers: { 'Content-Type': 'text/event-stream' } }));
  const deltas = [];
  await assert.rejects(chatStream({ messages, onDelta: (text) => deltas.push(text) }), (error) => /生成中断.*重试/.test(error.message)
    && !/private|私密/.test(error.message));
  assert.deepEqual(deltas, ['部分讲解']);
});

test('streaming parser accepts split chunks and a final line without a newline', async (t) => {
  const encoder = new TextEncoder();
  t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ start(controller) {
    for (const part of ['data: null\n\ndata: {"choices":[{"delta":', '{"content":"完整讲解"}}]}']) controller.enqueue(encoder.encode(part));
    controller.close();
  } }), { headers: { 'Content-Type': 'text/event-stream' } }));
  assert.equal(await chatStream({ messages }), '完整讲解');
});

test('model discovery gets the catalog for the draft endpoint and key without changing the active connection', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url, { method, headers }) => {
    seen.push({ url, method, key: headers.Authorization });
    return Response.json({ data: [{ id: 'z' }, { id: 'a', name: 'A' }, { id: 'a' }, { invalid: true }] });
  });
  const draft = { baseUrl: 'https://catalog.example/team/v1/chat/completions?workspace=practice', apiKey: ' draft-key ' };
  assert.deepEqual(await listModels(draft), [{ id: 'a', name: 'A' }, { id: 'z', name: '' }]);
  assert.deepEqual(seen, [{ url: 'https://catalog.example/team/v1/models?workspace=practice', method: 'GET', key: 'Bearer draft-key' }]);
  assert.equal(config.baseUrl, 'https://model.example');
  assert.equal(config.apiKey, '');
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response('private 提示', { status: 404 }));
  await assert.rejects(listModels(draft), (error) => /手动填写模型 ID/.test(error.message) && !error.message.includes('private'));
});

test('thinking settings are sent in both chat modes using the service format', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return reply('答复');
  });
  Object.assign(config, { baseUrl: 'https://api.openai.com/v1', model: 'gpt-5-mini', reasoningEffort: 'high' });
  await chat({ messages, maxTokens: 500 });
  assert.equal(calls[0].body.reasoning_effort, 'high');
  assert.equal(calls[0].body.max_completion_tokens, 500);
  assert.equal(calls[0].body.temperature, undefined);
  Object.assign(config, { baseUrl: 'https://openrouter.ai/api/v1', model: 'provider/model', reasoningEffort: 'low' });
  await chatStream({ messages });
  assert.deepEqual(calls[1].body.reasoning, { effort: 'low' });
  assert.equal(calls[1].body.stream, true);
  Object.assign(config, { baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', reasoningEffort: 'none' });
  await chat({ messages });
  assert.equal(calls[2].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(calls[2].body.reasoning_effort, 'none');
  config.reasoningEffort = '';
  await chatStream({ messages });
  assert.equal(calls[3].body.reasoning_effort, undefined);
});

test('legacy settings migrate and switching providers restores each key, model and effort after loading', (t) => {
  const storageKey = 'linguatrack.config.v1';
  const stored = new Map([[storageKey, JSON.stringify({ baseUrl: 'https://first.example/v1',
    apiKey: 'first-key', model: 'first-model', prompts: { lyricReading: 'Custom prompt' } })]]);
  const original = { ...config, prompts: { ...config.prompts } };
  const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value),
  } });
  t.after(() => {
    if (originalStorage) Object.defineProperty(globalThis, 'localStorage', originalStorage);
    else delete globalThis.localStorage;
    Object.assign(config, original);
  });
  loadConfig();
  const first = config.providers[0];
  assert.equal(first.name, 'first.example');
  assert.equal(config.apiKey, 'first-key');
  saveModelProvider({ name: 'Second', baseUrl: 'https://second.example', apiKey: 'second-key',
    model: 'second-model', reasoningEffort: 'high' });
  const second = config.providers[1];
  assert.equal(config.activeProviderId, second.id);
  selectModelProvider(first.id);
  assert.equal(config.model, 'first-model');
  assert.equal(config.reasoningEffort, '');
  selectModelProvider(second.id);
  loadConfig();
  assert.equal(config.apiKey, 'second-key');
  assert.equal(config.model, 'second-model');
  assert.equal(config.reasoningEffort, 'high');
  assert.equal(config.prompts.lyricReading, 'Custom prompt');
  removeModelProvider(second.id);
  assert.equal(config.activeProviderId, first.id);
  assert.equal(config.apiKey, 'first-key');
});
