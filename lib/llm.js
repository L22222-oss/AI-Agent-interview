'use strict';
/**
 * LLM 接入层 —— 面向"任意 OpenAI 兼容端点"的统一接口。
 *
 * 目标站点确实接了 API（首页加载 @tencent-ai/workbuddy-cloud-sdk，并有 /api/llm 代理），
 * 所以这里把接口做正：密钥只留在服务端，前端只能看到脱敏状态和"测试连接"的结果。
 *
 * 配置优先级：运行时配置（data/llm.json，可在管理端 UI 里改） > 环境变量 > 预设默认值。
 *
 * 环境变量：
 *   LLM_PROVIDER  deepseek|openai|moonshot|dashscope|zhipu|siliconflow|ollama|custom
 *   LLM_BASE_URL  OpenAI 兼容 base（含 /v1）
 *   LLM_API_KEY
 *   LLM_MODEL
 *   LLM_TIMEOUT   单次调用超时毫秒，默认 30000
 */

const fs = require('fs');
const path = require('path');

/** 常用端点预设。base 一律指向 OpenAI 兼容的 /v1 根。 */
const PROVIDERS = {
  deepseek: { name: 'DeepSeek', base: 'https://api.deepseek.com/v1', model: 'deepseek-chat', needsKey: true },
  openai: { name: 'OpenAI', base: 'https://api.openai.com/v1', model: 'gpt-4o-mini', needsKey: true },
  moonshot: { name: 'Moonshot 月之暗面', base: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', needsKey: true },
  dashscope: { name: '阿里云百炼 / 通义千问', base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus', needsKey: true },
  zhipu: { name: '智谱 GLM', base: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash', needsKey: true },
  siliconflow: { name: '硅基流动', base: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct', needsKey: true },
  ollama: { name: '本地 Ollama', base: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b', needsKey: false },
  custom: { name: '自定义端点', base: '', model: '', needsKey: true },
};

const CONFIG_FILE = path.join(__dirname, '..', 'data', 'llm.json');

let runtime = null; // { provider, baseUrl, apiKey, model, timeout }

function readConfigFile() {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const j = JSON.parse(raw);
    return j && typeof j === 'object' ? j : null;
  } catch (_) {
    return null;
  }
}

function writeConfigFile(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
}

/** 解析出生效配置：运行时 > 环境变量 > 预设。 */
function resolve() {
  if (runtime) return runtime;
  const saved = readConfigFile() || {};
  const provider = saved.provider || process.env.LLM_PROVIDER || (process.env.LLM_API_KEY ? 'custom' : 'deepseek');
  const preset = PROVIDERS[provider] || PROVIDERS.custom;

  const baseUrl = saved.baseUrl || process.env.LLM_BASE_URL || preset.base || '';
  const apiKey = saved.apiKey || process.env.LLM_API_KEY || '';
  const model = saved.model || process.env.LLM_MODEL || preset.model || '';
  const timeout = Number(saved.timeout || process.env.LLM_TIMEOUT || 30000);

  runtime = { provider, baseUrl, apiKey, model, timeout };
  return runtime;
}

/** 应用运行时配置并持久化（管理端 UI 用）。传空字符串可清空某一项。 */
function configure(patch) {
  const cur = resolve();
  const next = {
    provider: patch.provider != null ? String(patch.provider) : cur.provider,
    baseUrl: patch.baseUrl != null ? String(patch.baseUrl).trim() : cur.baseUrl,
    model: patch.model != null ? String(patch.model).trim() : cur.model,
    timeout: patch.timeout != null ? Number(patch.timeout) || 30000 : cur.timeout,
    apiKey: cur.apiKey,
  };
  if (patch.apiKey != null) next.apiKey = String(patch.apiKey).trim();

  /* 换 provider 且没显式给 base/model 时，自动套用该 provider 的预设 */
  const preset = PROVIDERS[next.provider];
  if (preset) {
    if (!next.baseUrl) next.baseUrl = preset.base;
    if (!next.model) next.model = preset.model;
  }
  writeConfigFile(next);
  runtime = null;
  return resolve();
}

function enabled() {
  const c = resolve();
  if (!c.baseUrl) return false;
  const preset = PROVIDERS[c.provider];
  if (preset && preset.needsKey && !c.apiKey) return false;
  return true;
}

/* ---------------------------------------------------------------- 降级诊断 */
/**
 * 所有"LLM 失败 → 落规则通道"的地方都往这里记一笔。
 * 静默 catch 是这类系统最难查的 bug 来源：接口明明接上了，
 * 行为却没变，因为异常在某个 .map() 里被吞了。
 */
let lastFallback = null;

function noteFallback(where, err) {
  lastFallback = {
    where: String(where || 'unknown'),
    message: err && err.message ? String(err.message) : String(err),
    at: new Date().toISOString(),
  };
  if (process.env.LLM_DEBUG) console.error('[llm] 降级于 ' + lastFallback.where + '：' + lastFallback.message);
}

function diagnostics() {
  return { enabled: enabled(), last_fallback: lastFallback };
}

/** 给前端看的脱敏状态：密钥只回显末四位。 */
function status() {
  const c = resolve();
  const preset = PROVIDERS[c.provider] || PROVIDERS.custom;
  return {
    enabled: enabled(),
    provider: c.provider,
    provider_name: preset.name,
    base_url: c.baseUrl,
    model: c.model,
    timeout: c.timeout,
    key_set: Boolean(c.apiKey),
    key_hint: c.apiKey ? '****' + c.apiKey.slice(-4) : '',
    source: readConfigFile() ? 'runtime' : (process.env.LLM_API_KEY ? 'env' : 'default'),
  };
}

function listProviders() {
  return Object.entries(PROVIDERS).map(([id, p]) => ({
    id, name: p.name, base_url: p.base, model: p.model, needs_key: p.needsKey,
  }));
}

/** 从模型输出里剥出第一个 JSON 对象（容忍 markdown 围栏与前后噪音）。 */
function parseJSONText(txt) {
  let s = String(txt == null ? '' : txt).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('bad-json');
  return JSON.parse(s.slice(a, b + 1));
}

/**
 * 单轮对话，返回原始文本。
 * @param {{system:string,user:string,temperature?:number,json?:boolean,model?:string,
 *          timeout?:number,maxTokens?:number,signal?:AbortSignal}} opts
 */
async function chat(opts) {
  if (!enabled()) throw new Error('llm-disabled');
  const c = resolve();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), opts.timeout || c.timeout);
  if (opts.signal) opts.signal.addEventListener('abort', () => ac.abort(), { once: true });

  const body = {
    model: opts.model || c.model,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
    temperature: opts.temperature == null ? 0.4 : opts.temperature,
    stream: false,
  };
  if (opts.json) body.response_format = { type: 'json_object' };
  if (opts.maxTokens) body.max_tokens = opts.maxTokens;

  const headers = { 'Content-Type': 'application/json' };
  if (c.apiKey) headers.Authorization = 'Bearer ' + c.apiKey;

  try {
    const res = await fetch(c.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      const err = new Error('llm-http-' + res.status);
      err.status = res.status;
      err.detail = text.slice(0, 500);
      throw err;
    }
    const data = JSON.parse(text);
    const content =
      data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content
        : '';
    if (!content) throw new Error('llm-empty');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

/** 要求模型只输出一个 JSON 对象。 */
async function chatJSON(opts) {
  const raw = await chat(Object.assign({}, opts, { json: true }));
  return parseJSONText(raw);
}

/** 带超时的 Promise 包装，防止候选人干等。 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout:' + (label || 'llm'))), ms)),
  ]);
}

/**
 * 连通性自测：发一句 ping，返回延迟与模型回显。
 * 管理端"测试连接"按钮和 /api/llm/test 都走这里。
 */
async function probe() {
  const c = resolve();
  if (!c.baseUrl) return { ok: false, reason: '未配置 base_url' };
  const preset = PROVIDERS[c.provider];
  if (preset && preset.needsKey && !c.apiKey) {
    return { ok: false, reason: '该服务商需要 API Key，当前未填写' };
  }
  const t0 = Date.now();
  try {
    const reply = await withTimeout(
      chat({ system: '你是一个连通性探针。只回复两个字符：ok', user: 'ping', temperature: 0, maxTokens: 16 }),
      15000,
      'probe'
    );
    return {
      ok: true,
      latency_ms: Date.now() - t0,
      model: c.model,
      base_url: c.baseUrl,
      reply: String(reply).trim().slice(0, 40),
    };
  } catch (e) {
    return {
      ok: false,
      latency_ms: Date.now() - t0,
      reason: e.message,
      detail: e.detail ? String(e.detail).slice(0, 300) : '',
      base_url: c.baseUrl,
    };
  }
}

module.exports = {
  PROVIDERS,
  listProviders,
  resolve,
  configure,
  enabled,
  status,
  chat,
  chatJSON,
  parseJSONText,
  withTimeout,
  probe,
  noteFallback,
  diagnostics,
  get DEFAULT_MODEL() { return resolve().model; },
  get DEFAULT_BASE() { return resolve().baseUrl; },
};
