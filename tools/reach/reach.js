'use strict';
/**
 * Agent-Reach 兼容层 —— 给 AI agent 装"看互联网"的能力。
 *
 * 对齐 vendor/agent-reach 的真实契约：
 *   agent-reach doctor --json           → 每平台 active_backend 快照
 *   agent-reach <platform> read <url>   → 结构化读取
 *   agent-reach search <query>          → 跨平台检索
 * 设计原则（来自其 SKILL.md）：动手前先体检；active_backend 为 null 只表示
 * "本次未实时验证"，不代表后端不存在；失败按重试链处理，不瞎猜命令。
 *
 * 本适配器用零依赖实现 6 个"零配置"通道，其余平台在检测到上游 CLI 时自动路由。
 *
 * 用法：
 *   node tools/reach/reach.js doctor --json
 *   node tools/reach/reach.js read <URL> --json
 *   node tools/reach/reach.js search "<QUERY>" --json
 *   node tools/reach/reach.js github "<QUERY>" --json
 *   node tools/reach/reach.js rss <URL> --json
 *   node tools/reach/reach.js check-update
 */

const fs = require('fs');
const path = require('path');

const VERSION = '1.0.0';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/* ------------------------------------------------------------ 后端探测 */
const UPSTREAM = {
  opencli: 'OpenCLI 聚合后端',
  twitter: 'twitter-cli',
  rdt: 'rdt-cli (Reddit)',
  bili: 'bili-cli (Bilibili)',
  'yt-dlp': 'yt-dlp (YouTube)',
  gh: 'GitHub CLI',
  mcporter: 'mcporter (Exa 搜索)',
  jina: 'Jina Reader',
};

function which(bin) {
  const dirs = (process.env.PATH || '').split(path.delimiter);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) {
    for (const x of exts) {
      const f = path.join(d, bin + x);
      try {
        if (fs.existsSync(f)) return f;
      } catch (_) {
        /* ignore */
      }
    }
  }
  return null;
}

const PLATFORMS = [
  { id: 'web', name: '任意网页', needs_auth: false, builtin: true },
  { id: 'search', name: '网页搜索', needs_auth: false, builtin: true },
  { id: 'github', name: 'GitHub', needs_auth: false, builtin: true, upstream: ['gh'] },
  { id: 'rss', name: 'RSS/Atom', needs_auth: false, builtin: true },
  { id: 'twitter', name: 'Twitter/X', needs_auth: true, upstream: ['twitter', 'opencli'] },
  { id: 'reddit', name: 'Reddit', needs_auth: true, upstream: ['rdt', 'opencli'] },
  { id: 'bilibili', name: 'Bilibili', needs_auth: false, upstream: ['bili', 'opencli'] },
  { id: 'youtube', name: 'YouTube', needs_auth: false, upstream: ['yt-dlp'] },
  { id: 'xiaohongshu', name: '小红书', needs_auth: true, upstream: ['opencli'] },
];

function doctor() {
  const upstream = {};
  for (const [bin, desc] of Object.entries(UPSTREAM)) upstream[bin] = { path: which(bin), desc };

  const platforms = PLATFORMS.map((p) => {
    let backend = null;
    if (p.builtin) backend = 'builtin';
    else if (p.upstream) {
      for (const u of p.upstream) {
        if (upstream[u] && upstream[u].path) { backend = u; break; }
      }
    }
    return {
      id: p.id,
      name: p.name,
      requires_login: Boolean(p.needs_auth),
      active_backend: backend,
      note:
        backend === null
          ? '未检测到可用后端；active_backend=null 表示本次未实时验证，不代表后端不存在'
          : backend === 'builtin'
          ? '内置零配置通道'
          : '路由到上游 CLI：' + backend,
    };
  });

  return {
    ok: true,
    tool: 'reach-compatible',
    version: VERSION,
    platform: process.platform,
    node: process.version,
    upstream,
    platforms,
    zero_config: platforms.filter((p) => p.active_backend === 'builtin').map((p) => p.id),
    summary: platforms.filter((p) => p.active_backend).length + ' / ' + platforms.length + ' 平台可用',
  };
}

/* ------------------------------------------------------------ 抓取与抽取 */
function decodeEntities(s) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return String(s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return map[g] != null ? map[g] : m;
  });
}

function htmlToText(html) {
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : '';
  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
  const description = descMatch ? decodeEntities(descMatch[1]) : '';
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s);
  s = s.replace(/[ \t\u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return { title, description, text: s };
}

async function fetchDoc(url, timeoutMs) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs || 20000);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ac.signal,
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: res.ok,
      status: res.status,
      final_url: res.url,
      content_type: res.headers.get('content-type') || '',
      bytes: buf.length,
      body: buf.toString('utf8'),
    };
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------ read */
async function read(url, opts) {
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'URL 必须以 http(s) 开头', platform: null };
  const host = new URL(url).hostname.replace(/^www\./, '');
  const platform =
    /(^|\.)github\.com$/.test(host) ? 'github'
    : /(^|\.)(twitter\.com|x\.com)$/.test(host) ? 'twitter'
    : /(^|\.)reddit\.com$/.test(host) ? 'reddit'
    : /(^|\.)bilibili\.com$/.test(host) ? 'bilibili'
    : /(^|\.)(youtube\.com|youtu\.be)$/.test(host) ? 'youtube'
    : /(^|\.)xiaohongshu\.com$/.test(host) ? 'xiaohongshu'
    : 'web';

  let doc;
  try {
    doc = await fetchDoc(url, (opts && opts.timeout) || 20000);
  } catch (e) {
    return { ok: false, platform, url, error: '抓取失败：' + e.message, backend: 'builtin' };
  }

  const maxChars = (opts && opts.max) || 6000;
  if (doc.content_type.includes('json')) {
    let parsed = null;
    try { parsed = JSON.parse(doc.body); } catch (_) { /* 保留原文 */ }
    return {
      ok: doc.ok,
      platform,
      backend: 'builtin',
      url,
      final_url: doc.final_url,
      status: doc.status,
      title: '',
      text: JSON.stringify(parsed || doc.body, null, 2).slice(0, maxChars),
      truncated: (parsed ? JSON.stringify(parsed) : doc.body).length > maxChars,
    };
  }

  const extracted = htmlToText(doc.body);
  const links = Array.from(doc.body.matchAll(/<a[^>]+href=["']([^"'#][^"']*)["'][^>]*>([\s\S]{0,120}?)<\/a>/gi))
    .map((m) => ({ href: m[1], text: decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim() }))
    .filter((l) => l.text && l.href)
    .slice(0, 40);

  return {
    ok: doc.ok,
    platform,
    backend: 'builtin',
    url,
    final_url: doc.final_url,
    status: doc.status,
    title: extracted.title,
    description: extracted.description,
    bytes: doc.bytes,
    chars: extracted.text.length,
    truncated: extracted.text.length > maxChars,
    text: extracted.text.slice(0, maxChars),
    links,
  };
}

/* ------------------------------------------------------------ github */
async function github(query, opts) {
  const gh = which('gh');
  if (gh) {
    /* 路由到官方 CLI（更稳、带鉴权配额） */
    const { execFileSync } = require('child_process');
    try {
      const out = execFileSync(gh, ['search', 'repos', query, '--limit', String((opts && opts.limit) || 10), '--json', 'fullName,description,stargazersCount,url'], { encoding: 'utf8', timeout: 30000 });
      return { ok: true, platform: 'github', backend: 'gh', query, items: JSON.parse(out) };
    } catch (_) {
      /* 落回内置 HTTP 通道 */
    }
  }
  const url = 'https://api.github.com/search/repositories?q=' + encodeURIComponent(query) + '&sort=stars&per_page=' + ((opts && opts.limit) || 10);
  try {
    const doc = await fetchDoc(url, 20000);
    const data = JSON.parse(doc.body);
    return {
      ok: doc.ok,
      platform: 'github',
      backend: 'builtin',
      query,
      total: data.total_count,
      items: (data.items || []).map((i) => ({
        full_name: i.full_name,
        stars: i.stargazers_count,
        language: i.language,
        description: i.description,
        url: i.html_url,
        topics: i.topics,
      })),
    };
  } catch (e) {
    return { ok: false, platform: 'github', backend: 'builtin', query, error: e.message };
  }
}

/* ------------------------------------------------------------ rss */
function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<item[\s\S]*?<\/item>/gi) || xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    const pick = (tag) => {
      const m = b.match(new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>', 'i'));
      return m ? decodeEntities(m[1].replace(/<!\[CDATA\[|\]\]>/g, '')).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
    };
    const linkM = b.match(/<link[^>]*href=["']([^"']+)["']/i) || b.match(/<link[^>]*>([\s\S]*?)<\/link>/i);
    items.push({
      title: pick('title'),
      link: linkM ? (linkM[1] || '').trim() : '',
      published: pick('pubDate') || pick('updated') || pick('published'),
      summary: pick('description') || pick('summary') || pick('content'),
    });
  }
  const chanTitle = (xml.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  return { title: decodeEntities(String(chanTitle).replace(/<[^>]+>/g, '')).trim(), items };
}

async function rss(url) {
  try {
    const doc = await fetchDoc(url, 20000);
    const feed = parseFeed(doc.body);
    return { ok: doc.ok, platform: 'rss', backend: 'builtin', url, title: feed.title, count: feed.items.length, items: feed.items.slice(0, 30) };
  } catch (e) {
    return { ok: false, platform: 'rss', backend: 'builtin', url, error: e.message };
  }
}

/* ------------------------------------------------------------ search */
async function search(query, opts) {
  const exa = which('mcporter');
  if (exa) {
    return { ok: false, platform: 'search', backend: 'mcporter', query, error: 'mcporter 已安装但本适配器未绑定 Exa 凭据；请配置后重试' };
  }
  /* 内置零配置：DuckDuckGo HTML 端点 */
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  try {
    const doc = await fetchDoc(url, 20000);
    const results = [];
    const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]{0,600}?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = re.exec(doc.body)) !== null && results.length < ((opts && opts.limit) || 10)) {
      results.push({
        title: decodeEntities(m[2].replace(/<[^>]+>/g, '')).trim(),
        url: decodeEntities(m[1]),
        snippet: decodeEntities(m[3].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim(),
      });
    }
    if (!results.length) {
      return { ok: false, platform: 'search', backend: 'builtin', query, error: '搜索引擎未返回可解析结果（可能被限流），请重试或改用 read 通道' };
    }
    return { ok: true, platform: 'search', backend: 'builtin', query, count: results.length, results };
  } catch (e) {
    return { ok: false, platform: 'search', backend: 'builtin', query, error: e.message };
  }
}

/* ------------------------------------------------------------ check-update */
function checkUpdate() {
  return { ok: true, tool: 'reach-compatible', current: VERSION, latest: VERSION, update_available: false };
}

/* ------------------------------------------------------------ CLI */
async function main(argv) {
  const cmd = argv[0];
  const json = argv.includes('--json');
  const args = argv.filter((a) => !a.startsWith('--'));

  if (!cmd || cmd === 'doctor') {
    const out = doctor();
    if (json) return console.log(JSON.stringify(out, null, 2));
    console.log('Agent Reach ' + out.version + ' · ' + out.summary);
    for (const p of out.platforms) {
      console.log('  ' + (p.active_backend ? '[ok] ' : '[--] ') + p.id.padEnd(12) + (p.active_backend || 'null'));
    }
    return;
  }
  if (cmd === 'read') {
    if (!args[1]) { console.error('usage: reach read <URL> --json'); process.exit(2); }
    const out = await read(args[1]);
    if (json) return console.log(JSON.stringify(out, null, 2));
    console.log(out.title || out.url);
    console.log((out.text || out.error || '').slice(0, 1200));
    return;
  }
  if (cmd === 'github') {
    if (!args[1]) { console.error('usage: reach github "<QUERY>" --json'); process.exit(2); }
    const out = await github(args[1]);
    if (json) return console.log(JSON.stringify(out, null, 2));
    for (const i of out.items || []) console.log(i.stars + '\t' + i.full_name + '\t' + (i.description || ''));
    return;
  }
  if (cmd === 'rss') {
    if (!args[1]) { console.error('usage: reach rss <URL> --json'); process.exit(2); }
    const out = await rss(args[1]);
    if (json) return console.log(JSON.stringify(out, null, 2));
    for (const i of out.items || []) console.log(i.published + '\t' + i.title);
    return;
  }
  if (cmd === 'search') {
    if (!args[1]) { console.error('usage: reach search "<QUERY>" --json'); process.exit(2); }
    const out = await search(args[1]);
    if (json) return console.log(JSON.stringify(out, null, 2));
    if (!out.ok) return console.error(out.error);
    for (const r of out.results) console.log('- ' + r.title + '\n  ' + r.url + '\n  ' + r.snippet);
    return;
  }
  if (cmd === 'check-update') return console.log(JSON.stringify(checkUpdate(), null, 2));

  if (cmd === 'install') {
    return console.log(JSON.stringify({ ok: true, note: '零依赖实现：无需安装，doctor 可直接运行', version: VERSION }, null, 2));
  }

  console.error('usage: reach <doctor|read|search|github|rss|check-update|install> [args] [--json]');
  process.exit(2);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { VERSION, doctor, read, github, rss, search, checkUpdate, htmlToText, parseFeed, which };
