'use strict';
/**
 * REA 兼容层 —— Reverse Engineer Anything 契约适配器。
 *
 * 对齐 vendor/rea 的真实域模型（src/domain/evidence.ts）：
 *   evidence_id  = "ev_" + sha256(canonicalJson(record without evidence_id))
 *   authority    ∈ shipped-artifact | controlled-replay | historical-reference
 *                  | external-service | analyst-inference
 *   confidence   ∈ observed | derived | inferred
 *   subject.format ∈ javascript | javascript-bundle | directory | file | unknown | ...
 *   locations[].kind ∈ address | address-range | artifact-path | file-offset |
 *                      file-offset-range | ...
 *   limitations[]  显式执行限制（解释性，不推断覆盖度）
 *
 * 用法：
 *   node tools/rea/rea.js doctor --json
 *   node tools/rea/rea.js analyze-web-application <URL> --json
 *   node tools/rea/rea.js analyze-javascript-application <DIR> --json
 *   node tools/rea/rea.js mcp          # stdio MCP server
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const VERSION = '1.0.0';
const PROVIDER = { id: 'helmd-rea', name: 'REA-compatible adapter (helmd)', version: VERSION };
const SCHEMA_VERSION = 'rea.evidence/1';

/* ------------------------------------------------------------ 规范化 JSON */
/** 与 REA 的 canonicalize 等价：键按 Unicode 码点排序、无空白、拒绝 NaN/Infinity。 */
function canonicalJson(value) {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite-number');
    return JSON.stringify(value);
  }
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort((a, b) => {
      const A = Array.from(a);
      const B = Array.from(b);
      for (let i = 0; i < Math.min(A.length, B.length); i++) {
        const d = A[i].codePointAt(0) - B[i].codePointAt(0);
        if (d !== 0) return d;
      }
      return A.length - B.length;
    });
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
  }
  throw new Error('unsupported-type:' + typeof value);
}

function computeEvidenceId(recordWithoutId) {
  return 'ev_' + crypto.createHash('sha256').update(canonicalJson(recordWithoutId)).digest('hex');
}

/* ------------------------------------------------------------ Evidence 构造 */
/**
 * 构造一条 REA 形态的 Evidence 记录。
 * @param {object} o
 * @param {object|null} o.subject
 * @param {string} o.predicate_type
 * @param {string} o.operation
 * @param {object} o.parameters
 * @param {*} o.raw_result
 * @param {*} o.normalized_result
 * @param {'observed'|'derived'|'inferred'} o.confidence
 * @param {string} o.authority
 * @param {string[]} o.limitations
 * @param {Array} [o.locations]
 * @param {string[]} [o.evidence_links]
 */
function makeEvidence(o) {
  const base = {
    subject: o.subject === undefined ? null : o.subject,
    provider: PROVIDER,
    analysis_profile: null,
    predicate_type: o.predicate_type,
    operation: o.operation,
    parameters: o.parameters || {},
    raw_result: o.raw_result === undefined ? null : o.raw_result,
    normalized_result: o.normalized_result === undefined ? {} : o.normalized_result,
    confidence: o.confidence || 'observed',
    authority: o.authority || 'external-service',
    environment: null,
    limitations: Array.isArray(o.limitations) ? o.limitations.slice() : [],
    relationship_coverage: null,
    locations: Array.isArray(o.locations) ? o.locations.slice() : [],
    evidence_links: Array.isArray(o.evidence_links) ? o.evidence_links.slice() : [],
  };
  return Object.assign({ evidence_id: computeEvidenceId(base) }, base);
}

/* ------------------------------------------------------------ 网络抓取 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchText(url, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs || 15000);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/json,text/javascript,*/*' },
    });
    const text = await res.text();
    return {
      status: res.status,
      finalUrl: res.url,
      contentType: res.headers.get('content-type') || '',
      headers: Object.fromEntries(res.headers.entries()),
      text,
    };
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------ Web 应用分析 */
const ROUTE_PATTERNS = [
  /["'`](\/api\/[A-Za-z0-9_\-/{}$:.?=&%]+)["'`]/g,
  /fetch\(\s*["'`]([^"'`]+)["'`]/g,
  /\.(get|post|put|patch|delete)\(\s*["'`]([^"'`]+)["'`]/gi,
];

const SECRET_PATTERNS = [
  { name: 'aws_access_key', re: /AKIA[0-9A-Z]{16}/g },
  { name: 'openai_key', re: /sk-[A-Za-z0-9]{20,}/g },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'private_key', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
  { name: 'google_api_key', re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: 'github_token', re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
];

/**
 * 逆向一个 Web 应用：抓首页 → 内联脚本 → 路由/端点/状态机/数据契约。
 * 返回完整 Evidence 集合 + 限制 + 未知。
 */
async function analyzeWebApplication(rootUrl, opts) {
  const startedAt = new Date().toISOString();
  const origin = new URL(rootUrl).origin;
  const evidence = [];
  const limitations = [];
  const unknowns = [];
  const nodes = [];
  const edges = [];

  let home;
  try {
    home = await fetchText(rootUrl, (opts && opts.timeout) || 15000);
  } catch (e) {
    return {
      schema_version: SCHEMA_VERSION,
      tool: 'analyze-web-application',
      target: rootUrl,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      evidence: [],
      graph: { nodes: [], edges: [] },
      limitations: ['目标不可达，未获得任何观察'],
      unknowns: [{ question: '目标站点的可达性与真实技术栈是什么？', domain: 'availability' }],
      error: e.message,
      verdict: 'FAIL',
    };
  }

  const subject = {
    name: new URL(rootUrl).hostname,
    digest: { sha256: crypto.createHash('sha256').update(home.text).digest('hex') },
    local_path: new URL(rootUrl).pathname || '/',
    format: 'javascript',
    architecture: null,
  };

  /* --- E1: 首页可达性与响应面 --- */
  evidence.push(
    makeEvidence({
      subject,
      predicate_type: 'http-response',
      operation: 'fetch-document',
      parameters: { url: rootUrl },
      raw_result: { status: home.status, content_type: home.contentType },
      normalized_result: {
        status: home.status,
        final_url: home.finalUrl,
        content_type: home.contentType,
        server: home.headers.server || null,
        bytes: Buffer.byteLength(home.text),
      },
      confidence: 'observed',
      authority: 'external-service',
      limitations: ['单次请求快照，不覆盖后续版本变更'],
      locations: [{ kind: 'artifact-path', path: new URL(rootUrl).pathname || '/' }],
    })
  );
  nodes.push({ id: 'doc:' + new URL(rootUrl).pathname, kind: 'document' });

  const html = home.text;

  /* --- E2: 单页应用证据（同一 HTML 响应未知路径 → SPA 回落） --- */
  const isSpa = /id="(?:app|root)"|<\s*script[^>]*src=|location\.search|history\.pushState/.test(html);
  evidence.push(
    makeEvidence({
      subject,
      predicate_type: 'application-shape',
      operation: 'classify-rendering-model',
      parameters: { url: rootUrl },
      raw_result: null,
      normalized_result: { single_page_application: isSpa, has_inline_script: /<script(?![^>]*src=)[^>]*>[\s\S]{40,}<\/script>/.test(html) },
      confidence: 'derived',
      authority: 'analyst-inference',
      limitations: ['由静态标记推断；运行时行为未在本操作中观测'],
    })
  );

  /* --- E3: 路由 / API 端点抽取 --- */
  const endpoints = new Set();
  for (const re of ROUTE_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(html)) !== null) {
      const raw = m[m.length - 1];
      if (!raw || raw.length > 200 || raw.startsWith('data:') || raw.startsWith('//')) continue;
      endpoints.add(raw.startsWith('/') ? raw : '/' + raw.replace(/^\.?\//, ''));
    }
  }
  const apiEndpoints = Array.from(endpoints).filter((e) => e.startsWith('/api')).sort();

  /* --- E4: 客户端视图路由（一次性发现全部页面） --- */
  const viewIds = Array.from(html.matchAll(/id="([A-Za-z][A-Za-z0-9_]*App|[A-Za-z][A-Za-z0-9_]*Page)"/g)).map((m) => m[1]);
  const querySwitches = Array.from(new Set(Array.from(html.matchAll(/getParam\(\s*['"]([A-Za-z0-9_]+)['"]/g)).map((m) => m[1])));

  evidence.push(
    makeEvidence({
      subject,
      predicate_type: 'api-surface',
      operation: 'extract-endpoints-from-client-bundle',
      parameters: { source: 'inline-script', patterns: ROUTE_PATTERNS.length },
      raw_result: { endpoints: apiEndpoints },
      normalized_result: { count: apiEndpoints.length, endpoints: apiEndpoints },
      confidence: 'observed',
      authority: 'external-service',
      limitations: [
        '仅覆盖静态可达的字面量路径；拼接构造的路径不可见',
        'Authorization 与 CSRF 行为未在本操作中验证',
      ],
      locations: [{ kind: 'artifact-path', path: '/' }],
    })
  );

  evidence.push(
    makeEvidence({
      subject,
      predicate_type: 'client-route-map',
      operation: 'enumerate-client-views-and-query-switches',
      parameters: {},
      raw_result: null,
      normalized_result: { views: viewIds, query_switches: querySwitches },
      confidence: 'observed',
      authority: 'external-service',
      limitations: querySwitches.length ? [] : ['未发现查询参数驱动的分支，可能使用 hash 路由'],
    })
  );

  for (const e of apiEndpoints) {
    nodes.push({ id: 'endpoint:' + e, kind: 'endpoint' });
    edges.push({ from: 'doc:' + (new URL(rootUrl).pathname || '/'), to: 'endpoint:' + e, type: 'exposes' });
  }
  for (const v of viewIds) nodes.push({ id: 'view:' + v, kind: 'view' });

  /* --- E5: 硬编码凭据扫描 --- */
  const secrets = [];
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0;
    const hits = html.match(p.re);
    if (hits && hits.length) secrets.push({ kind: p.name, count: hits.length });
  }
  evidence.push(
    makeEvidence({
      subject,
      predicate_type: 'secret-scan',
      operation: 'scan-client-bundle-for-credentials',
      parameters: { patterns: SECRET_PATTERNS.map((p) => p.name) },
      raw_result: null,
      normalized_result: { findings: secrets, clean: secrets.length === 0 },
      confidence: 'observed',
      authority: 'external-service',
      limitations: ['正则启发式；命中需人工复核，未命中不代表不存在'],
    })
  );

  /* --- E6: 评分/规则常量抽取 --- */
  const constants = [];
  const weightRe = /(logic|layer|cause|detail|accuracy|score|threshold|avg|verdict)\s*[:=]\s*(-?\d+(?:\.\d+)?)/gi;
  let cm;
  while ((cm = weightRe.exec(html)) !== null) constants.push({ name: cm[1], value: Number(cm[2]) });
  if (constants.length) {
    evidence.push(
      makeEvidence({
        subject,
        predicate_type: 'business-rule-constants',
        operation: 'extract-score-constants',
        parameters: {},
        raw_result: null,
        normalized_result: { constants: constants.slice(0, 60) },
        confidence: 'derived',
        authority: 'analyst-inference',
        limitations: ['常量名与语义的对应关系需用行为样本回归验证'],
      })
    );
  }

  /* --- E7: 未知路径回落验证（SPA 断言） --- */
  let fallback = null;
  try {
    const probe = await fetchText(origin + '/__rea_probe_' + Date.now(), 10000);
    fallback = {
      status: probe.status,
      same_as_root: crypto.createHash('sha256').update(probe.text).digest('hex') === subject.digest.sha256,
    };
  } catch (e) {
    limitations.push('未知路径回落探测失败：' + e.message);
  }
  if (fallback) {
    evidence.push(
      makeEvidence({
        subject,
        predicate_type: 'spa-fallback',
        operation: 'probe-unknown-path',
        parameters: { path: '/__rea_probe_*' },
        raw_result: fallback,
        normalized_result: fallback,
        confidence: 'observed',
        authority: 'external-service',
        limitations: [],
      })
    );
    if (fallback.same_as_root) {
      unknowns.push({
        question: '未知路径返回首页，静态资源与后端路由的同构边界在哪里？',
        domain: 'routing',
        probe: { operation: 'fetch-document', rationale: '需要响应头与 404 语义区分' },
      });
    }
  }

  if (!apiEndpoints.length) {
    unknowns.push({
      question: '该应用是否存在未在客户端字面量中出现的后端接口？',
      domain: 'api-surface',
      probe: { operation: 'fetch-document', rationale: '需对候选路径逐条探测状态码' },
    });
  }

  return {
    schema_version: SCHEMA_VERSION,
    tool: 'analyze-web-application',
    target: rootUrl,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    evidence,
    graph: { nodes, edges },
    limitations,
    unknowns,
    verdict: 'PASS',
  };
}

/* ------------------------------------------------------------ JS 应用分析 */
function walk(dir, out, depth) {
  if ((depth || 0) > 8) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out, (depth || 0) + 1);
    else if (/\.(js|mjs|cjs|ts|tsx|jsx|html|json)$/.test(e.name)) out.push(full);
  }
  return out;
}

function analyzeJavascriptApplication(dir) {
  const startedAt = new Date().toISOString();
  const files = walk(dir, []);
  const evidence = [];
  const limitations = [];
  const modules = [];
  const routeSet = new Set();
  const secretSet = [];

  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(f, 'utf8');
    } catch (_) {
      limitations.push('读取失败：' + path.relative(dir, f));
      continue;
    }
    const rel = path.relative(dir, f).split(path.sep).join('/');
    const imports = Array.from(text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)|from\s+['"]([^'"]+)['"]/g))
      .map((m) => m[1] || m[2])
      .filter((s) => s && s.startsWith('.'));
    modules.push({
      path: rel,
      bytes: Buffer.byteLength(text),
      sha256: crypto.createHash('sha256').update(text).digest('hex'),
      local_imports: Array.from(new Set(imports)),
    });
    for (const re of ROUTE_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const raw = m[m.length - 1];
        if (raw && raw.startsWith('/') && raw.length < 200) routeSet.add(raw);
      }
    }
    for (const p of SECRET_PATTERNS) {
      p.re.lastIndex = 0;
      const hits = text.match(p.re);
      if (hits) secretSet.push({ file: rel, kind: p.name, count: hits.length });
    }
  }

  evidence.push(
    makeEvidence({
      subject: {
        name: path.basename(dir),
        digest: {
          sha256: crypto
            .createHash('sha256')
            .update(modules.map((m) => m.sha256).join(''))
            .digest('hex'),
        },
        local_path: dir,
        format: 'directory',
        architecture: null,
      },
      predicate_type: 'module-graph',
      operation: 'analyze-javascript-application',
      parameters: { root: dir },
      raw_result: null,
      normalized_result: { files: modules.length, modules },
      confidence: 'observed',
      authority: 'shipped-artifact',
      limitations: [
        '静态扫描；动态 require() 与运行时生成的路径不计入',
        '未执行目标代码，运行时副作用未观测',
      ],
      locations: modules.slice(0, 50).map((m) => ({ kind: 'artifact-path', path: m.path })),
    })
  );

  evidence.push(
    makeEvidence({
      subject: null,
      predicate_type: 'api-surface',
      operation: 'extract-route-literals',
      parameters: {},
      raw_result: null,
      normalized_result: { routes: Array.from(routeSet).sort() },
      confidence: 'derived',
      authority: 'analyst-inference',
      limitations: ['仅覆盖字面量路径'],
      evidence_links: [],
    })
  );

  return {
    schema_version: SCHEMA_VERSION,
    tool: 'analyze-javascript-application',
    target: dir,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    evidence,
    graph: {
      nodes: modules.map((m) => ({ id: 'module:' + m.path, kind: 'module' })),
      edges: modules.flatMap((m) =>
        m.local_imports.map((imp) => {
          const resolved = path.posix.join(path.posix.dirname(m.path), imp);
          return { from: 'module:' + m.path, to: 'module:' + resolved, type: 'imports' };
        })
      ),
    },
    limitations,
    unknowns:
      secretSet.length === 0
        ? [{ question: '是否存在运行时注入的凭据？', domain: 'secret-scan', probe: { operation: 'analyze-javascript-application', rationale: '需要运行时追踪' } }]
        : [],
    secrets: secretSet,
    verdict: 'PASS',
  };
}

/* ------------------------------------------------------------ doctor */
function doctor() {
  const engines = ['ghidra', 'ida', 'radare2', 'rizin', 'objdump', 'jadx', 'adb', 'node', 'python'];
  const found = {};
  for (const e of engines) {
    const paths = (process.env.PATH || '').split(path.delimiter);
    const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
    let hit = null;
    for (const p of paths) {
      for (const x of exts) {
        const f = path.join(p, e + x);
        if (fs.existsSync(f)) { hit = f; break; }
      }
      if (hit) break;
    }
    found[e] = hit;
  }
  return {
    ok: true,
    tool: 'rea-compatible',
    version: VERSION,
    schema_version: SCHEMA_VERSION,
    provider: PROVIDER,
    engines: found,
    capabilities: [
      { id: 'analyze-web-application', requires: ['node'], available: true },
      { id: 'analyze-javascript-application', requires: ['node'], available: true },
      { id: 'mcp', requires: ['node'], available: true },
    ],
    notes: [
      '本适配器实现 REA 的 Evidence 契约（evidence_id / authority / confidence / limitations / unknowns）。',
      '原生二进制分析需要 vendor/rea 的 provider（Ghidra / IDA），本适配器不替代它。',
    ],
  };
}

/* ------------------------------------------------------------ MCP stdio */
const MCP_TOOLS = [
  {
    name: 'analyze_web_application',
    description: 'Reverse engineer a live web application into REA Evidence records.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute http(s) URL' } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'analyze_javascript_application',
    description: 'Static module-graph and route extraction over a JavaScript tree.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute directory' } },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

function startMcp() {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch (_) {
      return;
    }
    const id = msg.id === undefined ? null : msg.id;
    const reply = (result) => {
      if (id === null) return;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    };
    const error = (code, message) => {
      if (id === null) return;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
    };

    try {
      if (msg.method === 'initialize') {
        return reply({
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: PROVIDER.name, version: VERSION },
        });
      }
      if (msg.method === 'tools/list') return reply({ tools: MCP_TOOLS });
      if (msg.method === 'tools/call') {
        const name = msg.params && msg.params.name;
        const args = (msg.params && msg.params.arguments) || {};
        let payload;
        if (name === 'analyze_web_application') payload = await analyzeWebApplication(args.url);
        else if (name === 'analyze_javascript_application') payload = analyzeJavascriptApplication(args.path);
        else return error(-32602, 'unknown tool: ' + name);
        return reply({ content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: false });
      }
      if (msg.method === 'ping') return reply({});
      return error(-32601, 'method not found: ' + msg.method);
    } catch (e) {
      return error(-32603, e.message);
    }
  });
}

/* ------------------------------------------------------------ CLI */
async function main(argv) {
  const cmd = argv[0] || 'doctor';
  const json = argv.includes('--json');
  const positional = argv.filter((a) => !a.startsWith('--'));

  if (cmd === 'doctor') {
    const out = doctor();
    return console.log(JSON.stringify(out, null, 2));
  }
  if (cmd === 'analyze-web-application') {
    const url = positional[1];
    if (!url) { console.error('usage: rea analyze-web-application <URL> --json'); process.exit(2); }
    const out = await analyzeWebApplication(url);
    if (json) return console.log(JSON.stringify(out, null, 2));
    console.log('# ' + out.target + '  (' + out.evidence.length + ' evidence records)');
    for (const ev of out.evidence) {
      console.log('- [' + ev.confidence + '/' + ev.authority + '] ' + ev.operation + '  ' + ev.evidence_id.slice(0, 12));
    }
    for (const l of out.limitations) console.log('! ' + l);
    for (const u of out.unknowns) console.log('? ' + u.question);
    return;
  }
  if (cmd === 'analyze-javascript-application') {
    const dir = positional[1];
    if (!dir) { console.error('usage: rea analyze-javascript-application <DIR> --json'); process.exit(2); }
    const out = analyzeJavascriptApplication(dir);
    if (json) return console.log(JSON.stringify(out, null, 2));
    console.log('# ' + out.target + '  (' + out.evidence.length + ' evidence records)');
    for (const ev of out.evidence) console.log('- [' + ev.confidence + '] ' + ev.operation + '  ' + ev.evidence_id.slice(0, 12));
    return;
  }
  if (cmd === 'mcp') return startMcp();

  console.error('usage: rea <doctor|analyze-web-application|analyze-javascript-application|mcp> [args] [--json]');
  process.exit(2);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  VERSION,
  PROVIDER,
  SCHEMA_VERSION,
  canonicalJson,
  computeEvidenceId,
  makeEvidence,
  analyzeWebApplication,
  analyzeJavascriptApplication,
  doctor,
  startMcp,
};
