/**
 * 浏览器端 LLM 客户端 (OpenAI 兼容 `/chat/completions`).
 *
 * 本机网页通过同源服务向模型接口转发。独立部署的前端仍可直连模型接口。
 * API Key 保存在浏览器，只在请求时由本机服务传给所选模型接口。
 *
 * * **两种模式** —— 词卡/翻译走非流式 + `response_format=json_object` (服务端不支持
 *   就自动降级); 讲解走 SSE 流式, 边下边渲染。
 * * **超时与重试** —— 非流式请求指数退避重试, 流式只连一次 (半路断了就地展示)。
 * * **同请求合并** —— `once(key, fn)` 让同一个 key 的并发调用共用一个 Promise,
 *   避免重复烧 token。
 *
 */

import { config, endpointOf, modelConnection } from './config.js';
import { errorMessage } from './errors.js';

const FENCE = /^\s*```(?:json)?\s*|\s*```\s*$/gi;
const CAP_MAX = 8192;                    // 自动加倍 max_tokens 的天花板
const plainJSONModels = new Set();
const relayHeader = 'X-UtaLoop-LLM';
const relayErrors = {
  origin: '本地模型转发只接受同一网页的请求，请通过 UtaLoop 本地地址打开后重试',
  request: '本地服务无法转发这项请求，请检查接口地址、API Key 或请求大小',
  redirect: '模型接口返回了跳转，请在 AI 助学中填写最终的 API 地址',
  timeout: '本地服务等待模型响应超时，请重试或降低思考程度',
  tls: '模型接口的 HTTPS 连接失败，请检查服务商的证书或本机代理设置',
  unreachable: 'UtaLoop 本地服务无法连接模型接口，请检查接口地址或本机网络',
  format: '模型接口返回了网页，请填写服务商的 API 地址',
  size: '模型接口返回的数据过大，请缩短请求或换一个模型',
};

export class LLMError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.name = 'LLMError';
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const choiceOf = (data) => (data && data.choices && data.choices[0]) || null;
const contentOf = (data) => {
  const choice = choiceOf(data);
  const msg = choice && choice.message;
  return (msg && msg.content) || '';
};
const msgOf = (err) => errorMessage(err, '模型请求失败，请重试');

function responseError(status) {
  const messages = {
    400: '模型拒绝了本次请求，请检查模型 ID 或将思考程度设为默认',
    401: '模型身份验证失败，请在「设置 → AI 助学」检查 API Key',
    403: '模型接口拒绝访问，请检查模型使用权限',
    404: '模型或接口不存在，请在「设置 → AI 助学」检查地址和模型名称',
    408: '模型请求超时，请稍后重试',
    413: '模型请求内容过长，请切换到支持更长上下文的模型',
    422: '模型请求参数无效，请检查模型 ID 和思考程度',
    429: '模型请求受限，请检查可用额度或稍后重试',
  };
  return new LLMError(messages[status] || `模型服务暂时不可用（HTTP ${status}），请稍后重试`, status);
}

async function responseJSON(resp) {
  try { return await resp.json(); }
  catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw new LLMError('模型返回格式异常，请检查接口配置后重试', 422);
  }
}

function requireContent(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new LLMError('模型未返回内容，请重试或更换模型', 422);
  }
  return text;
}

function serviceEndpoint(baseUrl, resource) {
  const endpoint = endpointOf(baseUrl, resource);
  if (!endpoint) throw new LLMError('请在「设置 → AI 助学」填写有效的接口地址');
  return endpoint;
}

function chatRequest(messages, temperature, stream, connection) {
  const { baseUrl, apiKey, model, reasoningEffort } = modelConnection(connection);
  const endpoint = serviceEndpoint(baseUrl);
  if (!model) throw new LLMError('请在「设置 → AI 助学」选择模型或填写模型 ID');
  const host = new URL(endpoint).hostname;
  const openAI = host === 'api.openai.com';
  const body = { model, messages, stream };
  if (!openAI || !(reasoningEffort || /^(?:o\d|gpt-5)(?:[.-]|$)/i.test(model)))
    body.temperature = temperature === undefined ? config.temperature : temperature;
  if (reasoningEffort) {
    if (host === 'openrouter.ai') body.reasoning = { effort: reasoningEffort };
    else body.reasoning_effort = reasoningEffort;
  }
  return { endpoint, apiKey, body, tokenField: openAI ? 'max_completion_tokens' : 'max_tokens' };
}

/** 把外部 signal 和超时并成一个 signal. */
function linkAbort(outer, ms) {
  const ctl = new AbortController();
  let timedOut = false;
  const onAbort = () => ctl.abort();
  if (outer) {
    if (outer.aborted) ctl.abort();
    else outer.addEventListener('abort', onAbort, { once: true });
  }
  const timer = ms > 0 ? setTimeout(() => { timedOut = true; ctl.abort(); }, ms) : 0;
  return {
    signal: ctl.signal,
    get timedOut() { return timedOut; },
    clear() {
      if (timer) clearTimeout(timer);
      if (outer) outer.removeEventListener('abort', onAbort);
    },
  };
}

/** Local relay first for cross-origin providers. Static and native pages can still connect directly. */
async function send(endpoint, apiKey, signal, body) {
  const page = globalThis.location;
  const relay = page?.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(page.hostname)
    && new URL(endpoint).origin !== page.origin;
  if (relay) {
    let response;
    try {
      const headers = { 'Content-Type': 'application/json', [relayHeader]: '1' };
      if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
      response = await fetch(body ? '/llm/chat' : '/llm/models', {
        method: 'POST', headers, body: JSON.stringify({ endpoint, payload: body }), signal, credentials: 'omit',
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      throw new LLMError('无法访问 UtaLoop 本地网页服务，请检查服务是否正在运行');
    }
    if (response.headers.get(relayHeader) === '1') {
      const error = response.headers.get(relayHeader + '-Error');
      if (Object.hasOwn(relayErrors, error)) throw new LLMError(relayErrors[error], response.status);
      return response;
    }
    // An older or static-only web server may not have this route. Only fall
    // back when the local request could not have reached the model.
    if (![404, 405, 501].includes(response.status))
      throw new LLMError('UtaLoop 本地模型转发不可用，请重启网页服务后重试', response.status);
  }
  const headers = body ? { 'Content-Type': 'application/json' } : {};
  if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
  const init = body ? { method: 'POST', body: JSON.stringify(body) } : { method: 'GET' };
  try {
    return await fetch(endpoint, { ...init, headers, signal, credentials: 'omit' });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    if (relay) throw new LLMError('当前网页服务尚未启用模型转发，请启动或重启 UtaLoop 网页服务后重试');
    throw new LLMError(hintFor(endpoint));
  }
}

/** 镜像 OpenAI 兼容的模型目录，读取当前表单中的连接信息。 */
export async function listModels(connection, { signal } = {}) {
  const { baseUrl, apiKey } = modelConnection(connection);
  const endpoint = serviceEndpoint(baseUrl, 'models');
  const link = linkAbort(signal, 15000);
  try {
    const response = await send(endpoint, apiKey, link.signal);
    if (response.status === 404 || response.status === 405) {
      throw new LLMError('这个服务商未提供模型列表，可以手动填写模型 ID', response.status);
    }
    if (!response.ok) throw responseError(response.status);
    const { data } = await responseJSON(response) || {};
    if (!Array.isArray(data)) throw new LLMError('模型列表格式不受支持，可以手动填写模型 ID');
    const models = new Map();
    for (const item of data) {
      const id = typeof item?.id === 'string' ? item.id.trim() : '';
      if (id && !models.has(id)) models.set(id, { id, name: typeof item.name === 'string' ? item.name.trim() : '' });
    }
    return [...models.values()].sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    if (link.timedOut) throw new LLMError('获取模型列表超时，请重试或手动填写模型 ID');
    throw error;
  } finally {
    link.clear();
  }
}

/** 按页面与模型地址的协议差异, 给一句具体的排查建议. */
function hintFor(endpoint) {
  let url = null;
  try { url = new URL(endpoint); } catch { return '模型接口地址无效，请在「设置 → AI 助学」检查地址'; }
  if (globalThis.location?.protocol === 'https:' && url.protocol === 'http:') {
    return '当前页面无法访问 HTTP 模型接口，请使用 HTTPS 接口地址';
  }
  return '无法连接模型接口，请检查网络、接口地址及服务的跨域访问（CORS）设置';
}

/**
 * 非流式请求, 返回 message.content.
 *
 * JSON 模式不兼容时只对当前接口和模型记住降级结果。
 */
export async function chat({
  messages, json = false, temperature, maxTokens = 0, signal, retries = 2, connection,
} = {}) {
  const { endpoint, apiKey, body, tokenField } = chatRequest(messages, temperature, false, connection);
  const timeout = Math.max(10, config.timeout) * 1000;
  const jsonKey = endpoint + '\n' + body.model;
  if (maxTokens > 0) body[tokenField] = maxTokens;
  if (json && config.jsonMode && !plainJSONModels.has(jsonKey)) body.response_format = { type: 'json_object' };

  let last = null;
  let grew = false;                      // 只自动加倍一次, 免得越试越贵
  let fallback = false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const link = linkAbort(signal, timeout);
    try {
      const resp = await send(endpoint, apiKey, link.signal, body);
      if (resp.status === 400 && body.response_format) {
        delete body.response_format;
        fallback = true;
        attempt--;
        continue;
      }
      if (!resp.ok) throw responseError(resp.status);
      const data = await responseJSON(resp);
      const text = contentOf(data);
      const choice = choiceOf(data);
      // 推理型模型会先写 reasoning_content; 上限太小就只剩思考、正文为空。
      // max_tokens 只是封顶不是预付, 所以先就地翻倍再试一次 (不计入 retries);
      // 还是空的就用 422 抛出, 让下面的 4xx 分支放弃重试 —— 再试只会一样被截断。
      if (!text && choice && choice.finish_reason === 'length') {
        if (body[tokenField] && !grew && body[tokenField] < CAP_MAX) {
          grew = true;
          body[tokenField] = Math.min(CAP_MAX, body[tokenField] * 2);
          attempt--;
          continue;
        }
        throw new LLMError('模型输出达到上限，请降低思考程度或换一个模型', 422);
      }
      const content = requireContent(text);
      if (fallback) plainJSONModels.add(jsonKey);
      return content;
    } catch (err) {
      if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
      last = link.timedOut ? new LLMError('模型请求超时，请重试或降低思考程度') : err;
      // 4xx 基本是配置/额度问题, 重试没意义
      if (err instanceof LLMError && err.status >= 400 && err.status < 500) break;
      if (attempt < retries) await sleep(600 * 2 ** attempt);
    } finally {
      link.clear();
    }
  }
  throw last instanceof LLMError ? last : new LLMError(msgOf(last));
}

/** 容错解析: 去掉 ```json 围栏, 再退一步抓第一个 {...}. */
export function parseLoose(text) {
  const body = String(text || '').trim().replace(FENCE, '');
  try { return JSON.parse(body); } catch { /* 继续找 */ }
  const match = body.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch { /* 放弃 */ }
  }
  return null;
}

export async function chatJSON(opts) {
  const text = await chat({ ...opts, json: true });
  const data = parseLoose(text);
  if (!data || typeof data !== 'object') {
    throw new LLMError('模型返回的数据格式无效，请重试或更换支持 JSON 输出的模型');
  }
  return data;
}

/** 流式请求; 每来一段调用 onDelta(piece, full), 结束返回全文. */
export async function chatStream({ messages, onDelta, temperature, signal } = {}) {
  const { endpoint, apiKey, body } = chatRequest(messages, temperature, true);
  const link = linkAbort(signal, Math.max(60, config.timeout) * 1000);
  let out = '';
  try {
    const resp = await send(endpoint, apiKey, link.signal, body);
    if (!resp.ok) throw responseError(resp.status);
    const ctype = resp.headers.get('content-type') || '';
    // 有的网关会忽略 stream:true, 直接回整包 JSON
    if (!resp.body || !ctype.includes('text/event-stream')) {
      const data = await responseJSON(resp);
      out = requireContent(data ? contentOf(data) : '');
      if (onDelta) onDelta(out, out);
      return out;
    }
    out = await pump(resp.body.getReader(), onDelta);
    return requireContent(out);
  } catch (err) {
    if (signal?.aborted) throw new DOMException('已取消', 'AbortError');
    if (link.timedOut) throw new LLMError('讲解请求超时，请重试或降低思考程度');
    throw err instanceof LLMError ? err : new LLMError(msgOf(err));
  } finally {
    link.clear();
  }
}

/** 逐行消费 SSE: `data: {...}` / `data: [DONE]`. */
async function pump(reader, onDelta) {
  const dec = new TextDecoder();
  let buf = '';
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    buf += done ? dec.decode() : dec.decode(value, { stream: true });
    if (done && buf && !buf.endsWith('\n')) buf += '\n';
    let cut;
    while ((cut = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, cut).trim();
      buf = buf.slice(cut + 1);
      if (!line || !line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let chunk = null;
      try { chunk = JSON.parse(payload); } catch { continue; }
      if (chunk?.error) throw new LLMError('讲解生成中断，请重试');
      const choice = chunk?.choices?.[0];
      const piece = (choice && ((choice.delta && choice.delta.content) ||
        (choice.message && choice.message.content))) || '';
      if (typeof piece !== 'string' || !piece) continue;
      out += piece;
      if (onDelta) onDelta(piece, out);
    }
    if (done) break;
  }
  return out;
}

/** 同 key 的并发请求共用一个 Promise —— 缓存之外的第二道去重. */
const inflight = new Map();
export function once(key, factory) {
  const hit = inflight.get(key);
  if (hit) return hit;
  const task = (async () => factory())().finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}
