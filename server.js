'use strict';
/**
 * 面试智能体 · 服务端
 * 零依赖 Node（>=18.17，内置 fetch）。复刻目标站点全部 API 契约。
 *
 *   node server.js            # 默认 3000
 *   PORT=8080 node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const { Collection, rid } = require('./lib/store');
const scoring = require('./lib/scoring');
const bank = require('./lib/bank');
const agent = require('./lib/agent');
const llm = require('./lib/llm');
const resumeLib = require('./lib/resume');
const judge = require('./lib/judge');
const agentSession = require('./lib/session');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const SESSION_TTL = 7 * 24 * 3600 * 1000;

/* ------------------------------------------------------------------ 存储 */
const db = {
  users: new Collection('users'),
  jobs: new Collection('jobs'),
  orgs: new Collection('orgs'),
  reports: new Collection('reports'),
  plans: new Collection('plans'),
  settings: new Collection('settings'),
  sessions: new Collection('sessions'),
  interviews: new Collection('interviews'),
  resumes: new Collection('resumes'),
};

function getSettings() {
  let s = db.settings.all()[0];
  if (!s) {
    s = { id: 'global', retentionDays: 90, contactEmail: '', autoAdvance: true, updatedAt: new Date().toISOString() };
    db.settings.insert(s);
  }
  return s;
}
getSettings();

/**
 * 演示账号播种。
 * 目标站点首页公开写着「演示账号：admin / demo1234」，复刻版必须有同一个账号，
 * 否则从目标站点过来的人第一件事就是拿它登录，然后登不进去。
 * 可通过 DEMO_PASSWORD 环境变量覆盖；设为空串则关闭播种。
 */
const DEMO_ACCOUNT = process.env.DEMO_ACCOUNT || 'admin';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD === undefined ? 'demo1234' : process.env.DEMO_PASSWORD;

function seedDemoAccount() {
  if (!DEMO_PASSWORD) return null;
  const existing = db.users.find((u) => u.account === DEMO_ACCOUNT);
  if (existing) {
    /* 已存在：只在密码对不上时重置，避免每次重启都改掉用户自己改过的密码 */
    if (!verifyPassword(DEMO_PASSWORD, existing)) {
      const { salt, hash } = hashPassword(DEMO_PASSWORD);
      db.users.update(existing.id, { salt, hash });
      console.log('[seed] 演示账号 ' + DEMO_ACCOUNT + ' 的密码已重置为环境变量指定的值');
    }
    return existing;
  }
  const { salt, hash } = hashPassword(DEMO_PASSWORD);
  const user = db.users.insert({
    id: rid('u'),
    account: DEMO_ACCOUNT,
    name: '演示账号',
    role: 'admin',
    salt,
    hash,
    createdAt: nowISO(),
    demo: true,
  });
  console.log('[seed] 已创建演示账号：' + DEMO_ACCOUNT + ' / ' + DEMO_PASSWORD);
  return user;
}

/* ------------------------------------------------------------------ 工具 */
function nowISO() {
  return new Date().toISOString();
}

function hashPassword(password, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), s, 32).toString('hex');
  return { salt: s, hash };
}

function verifyPassword(password, user) {
  if (!user || !user.salt || !user.hash) return false;
  const { hash } = hashPassword(password, user.salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function accessCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function send(res, code, payload, extraHeaders) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const headers = Object.assign(
    {
      'Content-Type': typeof payload === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
    extraHeaders || {}
  );
  res.writeHead(code, headers);
  res.end(body);
}

function fail(res, code, error) {
  send(res, code, { error });
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const max = limit || 4 * 1024 * 1024;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error('body-too-large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(new Error('bad-json'));
      }
    });
    req.on('error', reject);
  });
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionUser(req) {
  const sid = parseCookies(req).iv_session;
  if (!sid) return null;
  const s = db.sessions.find((x) => x.id === sid);
  if (!s) return null;
  if (Date.now() - new Date(s.at).getTime() > SESSION_TTL) {
    db.sessions.remove(s.id);
    return null;
  }
  const u = db.users.find((x) => x.id === s.userId);
  return u || null;
}

function publicUser(u) {
  return { id: u.id, account: u.account, name: u.name, role: u.role };
}

/* ------------------------------------------------------------------ 报告形态 */
function reportView(r) {
  const rec = scoring.recommendFor(r);
  return Object.assign({}, r, { recommend: rec });
}

function findReport(id) {
  return db.reports.find((x) => x.id === id);
}

function textList(value, limit) {
  return (Array.isArray(value) ? value : [])
    .map((x) => String(x == null ? '' : x).trim())
    .filter(Boolean)
    .slice(0, limit || 12);
}

function prepItems(value, fields, limit) {
  return (Array.isArray(value) ? value : [])
    .map((item) => {
      if (typeof item === 'string') return { text: item.trim() };
      const out = {};
      (fields || []).forEach((key) => {
        if (item && item[key] != null) out[key] = String(item[key]).trim();
      });
      return out;
    })
    .filter((item) => Object.values(item).some(Boolean))
    .slice(0, limit || 12);
}

function normalizeJobPrep(raw, job) {
  const data = raw && typeof raw === 'object' ? raw : {};
  return {
    summary: String(data.summary || '').trim(),
    candidateProfile: textList(data.candidateProfile || data.profile, 8),
    focus: prepItems(data.focus, ['label', 'reason'], 8),
    round1: prepItems(data.round1 || data.round1Plan, ['dimension', 'question', 'followup', 'reason'], job.round1Count || 6),
    round2: prepItems(data.round2 || data.round2Plan, ['dimension', 'question', 'material', 'reason'], job.round2Count || 6),
    rubric: prepItems(data.rubric || data.scoringRubric, ['dimension', 'weight', 'excellent', 'pass', 'risk'], 8),
    risks: textList(data.risks, 8),
    nextAction: String(data.nextAction || '').trim(),
  };
}

function normalizeResumePrep(raw, job, facts) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const questions = (Array.isArray(data.questions) ? data.questions : [])
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      return String((item && (item.text || item.question)) || '').trim();
    })
    .filter(Boolean)
    .slice(0, job.round1Count || 6);
  return {
    facts: textList(data.facts, 12),
    pending: textList(data.pending || data.gaps || data.verification, 12),
    questions,
    match: Math.max(0, Math.min(100, Math.round(Number(data.match) || 0))),
    matchReason: String(data.matchReason || data.match_reason || '').trim(),
    parsed: {
      projects: facts.projects.slice(0, 8).map((x) => x.name),
      tech: facts.tech.slice(0, 16).map((x) => x.name),
      metrics: facts.metrics.slice(0, 12).map((x) => x.raw),
      gaps: facts.gaps.slice(0, 12).map((x) => x.tech),
    },
  };
}

async function generateJobPrep(job) {
  if (!llm.enabled()) throw new Error('llm-disabled');
  const system = [
    '你是招聘流程设计师，负责把一个岗位 JD 变成可执行的 AI 面试方案。',
    '只输出一个 JSON 对象，不要 Markdown，不要解释 JSON 之外的内容。',
    '方案必须围绕岗位实际要求，不能输出泛泛的模板话术。',
  ].join('\n');
  const user = [
    '【岗位名称】' + job.name,
    '【岗位描述】' + String(job.jd || '未提供，请根据岗位名称建立最小可用方案').slice(0, 6000),
    '【第一轮题数】' + (job.round1Count || 6),
    '【第二轮题数】' + (job.round2Count || 6),
    '【预计时长】' + (job.duration || 35) + ' 分钟',
    '请严格返回以下结构：',
    JSON.stringify({
      summary: '岗位面试策略摘要',
      candidateProfile: ['候选人应具备的能力'],
      focus: [{ label: '重点能力', reason: '为什么考察' }],
      round1: [{ dimension: '简历事实', question: '结合简历要核实的问题', followup: '回答含糊时的追问', reason: '考察目的' }],
      round2: [{ dimension: 'communication|learning|execution', question: '能力题', material: '可选阅读材料', reason: '考察目的' }],
      rubric: [{ dimension: '能力维度', weight: 25, excellent: '优秀表现', pass: '通过标准', risk: '风险信号' }],
      risks: ['需要重点排查的风险'],
      nextAction: '下一步建议',
    }),
    'round1 与 round2 分别输出指定题数；round2 的 dimension 只能是 communication、learning、execution。',
  ].join('\n');
  try {
    return normalizeJobPrep(
      await llm.withTimeout(llm.chatJSON({ system, user, temperature: 0.25, maxTokens: 2600 }), 50000, 'job-ai-prep'),
      job
    );
  } catch (e) {
    llm.noteFallback('job-ai-prep', e);
    throw e;
  }
}

async function generateResumePrep(job, cand, resumeText) {
  if (!llm.enabled()) throw new Error('llm-disabled');
  const facts = resumeLib.parse(resumeText);
  const system = [
    '你是严谨的中文面试准备智能体。你必须读取岗位 JD 和候选人简历，再生成针对性面试准备结果。',
    '只输出一个 JSON 对象，不要 Markdown，不要虚构简历中没有的事实。',
  ].join('\n');
  const user = [
    '【岗位】' + job.name,
    '【岗位 JD】' + String(job.jd || '').slice(0, 5000),
    '【候选人】' + cand,
    '【简历原文】' + String(resumeText).slice(0, 12000),
    '【本地解析事实】' + JSON.stringify({
      projects: facts.projects.slice(0, 8).map((x) => x.name),
      tech: facts.tech.slice(0, 16).map((x) => x.name),
      metrics: facts.metrics.slice(0, 12).map((x) => x.raw),
      gaps: facts.gaps.slice(0, 12).map((x) => x.tech),
    }),
    '请返回：',
    JSON.stringify({
      match: 0,
      matchReason: '岗位要求与简历证据的对应说明',
      facts: ['只引用简历中的具体事实'],
      pending: ['需要通过面试核实的事实或岗位要求'],
      questions: ['结合简历和 JD 的个性化第一轮问题'],
    }),
    'questions 必须输出 ' + (job.round1Count || 6) + ' 道，问题要引用简历项目、技术或结果，不能重复模板。',
  ].join('\n');
  try {
    return normalizeResumePrep(
      await llm.withTimeout(llm.chatJSON({ system, user, temperature: 0.25, maxTokens: 2200 }), 50000, 'resume-ai-prep'),
      job,
      facts
    );
  } catch (e) {
    llm.noteFallback('resume-ai-prep', e);
    throw e;
  }
}

/** 候选人自助查询返回体（与目标站点字段一致）。 */
function portalState(r) {
  const r2 = r.round2 || null;
  const stage = r.stage;
  return {
    found: true,
    id: r.id,
    jobId: r.jobId,
    jobName: r.jobName,
    cand: r.cand,
    stage,
    r1: r.round1 ? r.round1.verdict : null,
    r2Done: Boolean(r2),
    r2Verdict: r2 ? r2.verdict : null,
    canRound2: Boolean(r.round1 && r.round1.verdict === '通过' && !r2),
    canPractice: Boolean(r2 && r2.verdict === '通过' && stage === 'practice' && !(r.practice && r.practice.url)),
    practice: r.practice || null,
    offer: r.offer || null,
    contract: r.contract || null,
  };
}

/* ------------------------------------------------------------------ 路由 */
const routes = [];
function route(method, pattern, handler, opts) {
  const keys = [];
  const rx = new RegExp(
    '^' +
      pattern.replace(/:[A-Za-z0-9_]+/g, (m) => {
        keys.push(m.slice(1));
        return '([^/]+)';
      }) +
      '$'
  );
  routes.push({ method, rx, keys, handler, auth: (opts && opts.auth) !== false });
}

/* ============================ 认证 ============================ */
route('POST', '/api/auth/register', async (ctx) => {
  const { account, name, password } = ctx.body;
  if (!account || typeof account !== 'string') return fail(ctx.res, 400, '请输入账号（3-40 位英文字母、数字或 . _ + -）。');
  if (/[\u4e00-\u9fa5\s]/.test(account)) return fail(ctx.res, 400, '账号不能包含中文或空格，请改用英文字母、数字或 . _ + -。');
  if (account.length < 3 || account.length > 40) return fail(ctx.res, 400, '账号长度需为 3-40 位，当前是 ' + account.length + ' 位。');
  if (!/^[\w.+-]{3,40}$/.test(account)) return fail(ctx.res, 400, '账号含不被支持的符号：仅允许英文字母、数字和 . _ + -。');
  if (name && String(name).length > 30) return fail(ctx.res, 400, '显示名最多 30 个字。');
  if (!password || String(password).length < 6) return fail(ctx.res, 400, '密码太短：至少需要 6 位。');
  if (db.users.find((u) => u.account === account)) return fail(ctx.res, 400, '该账号已被注册。');

  const { salt, hash } = hashPassword(password);
  const user = db.users.insert({
    id: rid('u'),
    account,
    name: name || account,
    role: db.users.all().length === 0 ? 'admin' : 'member',
    salt,
    hash,
    createdAt: nowISO(),
  });
  const sid = rid('s');
  db.sessions.insert({ id: sid, userId: user.id, at: nowISO() });
  return send(ctx.res, 200, publicUser(user), { 'Set-Cookie': 'iv_session=' + sid + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_TTL / 1000 });
}, { auth: false });

route('POST', '/api/auth/login', async (ctx) => {
  const { account, password } = ctx.body;
  const user = db.users.find((u) => u.account === account);
  if (!user || !verifyPassword(password, user)) return fail(ctx.res, 401, '账号或密码不正确');
  const sid = rid('s');
  db.sessions.insert({ id: sid, userId: user.id, at: nowISO() });
  return send(ctx.res, 200, publicUser(user), { 'Set-Cookie': 'iv_session=' + sid + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + SESSION_TTL / 1000 });
}, { auth: false });

route('POST', '/api/auth/logout', async (ctx) => {
  const sid = parseCookies(ctx.req).iv_session;
  if (sid) db.sessions.remove(sid);
  return send(ctx.res, 200, { ok: true }, { 'Set-Cookie': 'iv_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' });
}, { auth: false });

route('GET', '/api/auth/session', async (ctx) => send(ctx.res, 200, publicUser(ctx.user)));

route('POST', '/api/account/password', async (ctx) => {
  const { oldPassword, newPassword } = ctx.body;
  if (!verifyPassword(oldPassword, ctx.user)) return fail(ctx.res, 400, '原密码不正确');
  if (!newPassword || String(newPassword).length < 6) return fail(ctx.res, 400, '新密码至少 6 位');
  const { salt, hash } = hashPassword(newPassword);
  db.users.update(ctx.user.id, { salt, hash });
  return send(ctx.res, 200, { ok: true });
});

/* ============================ 岗位 ============================ */
route('GET', '/api/jobs', async (ctx) => {
  const reports = db.reports.all();
  const jobs = db.jobs.all().map((job) => {
    const jobReports = reports.filter((r) => r.jobId === job.id);
    const candidates = db.interviews.filter((s) => s.jobId === job.id).length + jobReports.length;
    return Object.assign({}, job, {
      status: job.published === false ? 'draft' : 'published',
      headcount: job.headcount || 1,
      candidates: Math.max(Number(job.candidates) || 0, candidates),
    });
  });
  return send(ctx.res, 200, jobs);
});

route('POST', '/api/jobs', async (ctx) => {
  const b = ctx.body;
  if (!b.name) return fail(ctx.res, 400, '请填写岗位名称');
  const job = db.jobs.insert({
    id: 'j' + Date.now(),
    name: b.name,
    jd: b.jd || '',
    headcount: Math.max(1, Number(b.headcount) || 1),
    status: b.status === 'draft' ? 'draft' : 'published',
    round1Count: Number(b.round1Count) || 6,
    round2Count: Number(b.round2Count) || 6,
    duration: Number(b.duration) || 35,
    published: b.status === 'draft' ? false : b.published !== false,
    orgId: b.orgId || null,
    createdAt: nowISO(),
    updatedAt: nowISO(),
  });
  return send(ctx.res, 200, job);
});

route('PUT', '/api/jobs/:id', async (ctx) => {
  const job = db.jobs.find((x) => x.id === ctx.params.id);
  if (!job) return fail(ctx.res, 404, '岗位不存在');
  const b = ctx.body;
  const patch = {};
  for (const k of ['name', 'jd', 'headcount', 'round1Count', 'round2Count', 'duration', 'published', 'status']) {
    if (b[k] !== undefined) patch[k] = b[k];
  }
  if (patch.status !== undefined) patch.published = patch.status !== 'draft';
  return send(ctx.res, 200, db.jobs.update(job.id, patch));
});

route('DELETE', '/api/jobs/:id', async (ctx) => {
  if (!db.jobs.remove(ctx.params.id)) return fail(ctx.res, 404, '岗位不存在');
  return send(ctx.res, 200, { ok: true });
});

/* ============================ 第四阶段：岗位 AI 准备 ============================ */
route('GET', '/api/jobs/:id/ai-prep', async (ctx) => {
  const job = db.jobs.find((x) => x.id === ctx.params.id);
  if (!job) return fail(ctx.res, 404, '岗位不存在');
  return send(ctx.res, 200, {
    jobId: job.id,
    prep: job.aiPrep || null,
    llm: llm.status(),
  });
});

route('POST', '/api/jobs/:id/ai-prep', async (ctx) => {
  const job = db.jobs.find((x) => x.id === ctx.params.id);
  if (!job) return fail(ctx.res, 404, '岗位不存在');
  if (!llm.enabled()) return fail(ctx.res, 503, 'AI 未配置，请先到「账号 → AI 接入」填写 API 地址、模型和 API Key');
  try {
    const prep = await generateJobPrep(job);
    const saved = db.jobs.update(job.id, {
      aiPrep: Object.assign({}, prep, {
        source: 'llm',
        provider: llm.status().provider,
        model: llm.status().model,
        generatedAt: nowISO(),
      }),
    });
    return send(ctx.res, 200, { ok: true, jobId: job.id, prep: saved.aiPrep });
  } catch (e) {
    return fail(ctx.res, 502, 'AI 准备调用失败：' + (e.message || '未知错误'));
  }
});

/* 公开：候选人拿岗位信息（不需要登录） */
route('GET', '/api/interview', async (ctx) => {
  const jobId = ctx.query.get('job');
  const job = db.jobs.find((x) => x.id === jobId);
  if (!job || job.published === false) return fail(ctx.res, 404, '岗位不存在或未发布');
  return send(ctx.res, 200, {
    id: job.id,
    name: job.name,
    jd: job.jd || '',
    round1Count: job.round1Count || 6,
    round2Count: job.round2Count || 6,
    duration: job.duration || 35,
  });
}, { auth: false });

/* ============================ 第一轮：生成计划 ============================ */
route('POST', '/api/interview/plan', async (ctx) => {
  const { jobId, cand, resume } = ctx.body;
  const job = db.jobs.find((x) => x.id === jobId);
  if (!job) return fail(ctx.res, 404, '岗位不存在或未发布');
  if (!resume || String(resume).trim().length < 20) return fail(ctx.res, 400, '简历正文至少 20 字');

  const count = job.round1Count || 6;

  /* 出题官：先把简历拆成事实，再按考察意图排出题目骨架。
     骨架的每一题都锚定简历原文，不是模板填空。 */
  const facts = resumeLib.parse(String(resume));
  const intents = agent.planRound1({
    facts,
    resume: String(resume),
    jobName: job.name,
    jd: job.jd,
    count,
  });

  /* 有 LLM 时让模型把第一题措辞得更好；失败就用骨架，不阻塞候选人 */
  let first = intents[0];
  let source = 'rule';
  if (llm.enabled() && first) {
    try {
      const q = await agent.nextQuestion({
        round: 1, idx: 0, jobName: job.name, jd: job.jd,
        resume: String(resume), questions: [], answers: [],
        facts, intents, usedIntents: [],
      });
      if (q && q.text) {
        first = { kind: q.kind, text: q.text, expects: q.expects || first.expects, basis: q.basis };
        source = 'llm';
      }
    } catch (e) {
      llm.noteFallback('plan-round1', e);
      /* 保留骨架题 */
    }
  }

  const questions = intents.map((it, i) => (i === 0 && first ? first : it));

  const plan = db.plans.insert({
    id: rid('pl'),
    jobId: job.id,
    jobName: job.name,
    jd: job.jd || '',
    cand: cand || '候选人',
    resume: String(resume),
    facts: {
      projects: facts.projects.slice(0, 8).map((p) => p.name),
      tech: facts.tech.map((t) => t.name),
      metrics: facts.metrics.map((m) => m.raw).slice(0, 12),
      gaps: facts.gaps.map((g) => g.tech),
    },
    intents: questions.map((q) => ({ kind: q.kind, basis: q.basis })),
    source,
    questions,
    askedKinds: [],
    probeCount: 0,
    createdAt: nowISO(),
  });

  return send(ctx.res, 200, {
    planId: plan.id,
    questions: questions.map((q) => q.text),
    expects: questions.map((q) => q.expects || []),
    source,
    duration: 15,
    agent: {
      enabled: llm.enabled(),
      mode: llm.enabled() ? 'llm' : 'rule',
      facts: {
        projects: facts.projects.slice(0, 5).map((p) => p.name),
        metrics: facts.metrics.slice(0, 6).map((m) => m.raw),
        gaps: facts.gaps.slice(0, 5).map((g) => g.tech),
      },
    },
  });
}, { auth: false });

/* ============================ 第一轮：提交 ============================ */
route('POST', '/api/reports', async (ctx) => {
  const b = ctx.body || {};

  /* ---- 第二轮提交 ---- */
  if (Number(b.round) === 2) {
    const r = findReport(b.reportId);
    if (!r) return fail(ctx.res, 404, '面试记录不存在');
    if (r.round2) return send(ctx.res, 200, { id: r.id, round: 2, duplicate: true });

    const plan = r.round2plan || { questions: [], dims: [], materials: [] };
    const questions = Array.isArray(b.questions) ? b.questions : plan.questions;
    const dims = Array.isArray(b.dims) ? b.dims : plan.dims;
    const materials = Array.isArray(b.materials) ? b.materials : plan.materials;
    const answers = Array.isArray(b.answers) ? b.answers : [];
    const evals = Array.isArray(b.evals) ? b.evals : [];

    const scored = scoring.scoreRound2(answers, dims, evals);
    const summary = await agent.summarizeRound2(scored.scores);

    const round2 = {
      questions,
      dims,
      materials,
      answers,
      evals,
      scores: scored.scores,
      verdict: scored.verdict,
    };
    const evaluation = { avg: summary.avg, verdict: scored.verdict, summary: summary.summary };

    db.reports.update(r.id, {
      round2,
      eval: evaluation,
      stage: scored.verdict === '通过' ? 'practice' : 'evaluated',
    });
    return send(ctx.res, 200, {
      id: r.id,
      round: 2,
      r1: r.round1 ? r.round1.scores ? Object.assign({}, r.round1.scores, { verdict: r.round1.verdict }) : null : null,
      eval: evaluation,
      passed: scored.verdict === '通过',
      accessCode: r.accessCode,
    });
  }

  /* ---- 第一轮提交 ---- */
  const { planId, clientId, answers } = b;
  const plan = db.plans.find((x) => x.id === planId);
  if (!plan) return fail(ctx.res, 404, '面试计划不存在');

  /* 幂等：同一 clientId 重复提交直接返回原记录 */
  const dup = db.reports.find((x) => x.planId === planId && x.clientId === clientId);
  if (dup) return send(ctx.res, 200, { id: dup.id, round: 1, duplicate: true });

  const expects = plan.questions.map((q) => q.expects || []);
  const r1 = scoring.scoreRound1(Array.isArray(answers) ? answers : [], expects);
  const passed = r1.verdict === '通过';

  const report = db.reports.insert({
    id: rid('rp'),
    planId,
    clientId: clientId || rid('c'),
    jobId: plan.jobId,
    jobName: plan.jobName,
    cand: plan.cand,
    resume: plan.resume,
    at: nowISO(),
    updatedAt: nowISO(),
    stage: 'pending',
    round: 1,
    source: plan.source,
    accessCode: passed ? accessCode() : null,
    round1: {
      questions: plan.questions.map((q) => q.text),
      answers: Array.isArray(answers) ? answers : [],
      expects,
      scores: r1.scores,
      hits: r1.hits,
      details: r1.details,
      verdict: r1.verdict,
    },
    round2plan: null,
    round2: null,
    eval: null,
    judgments: null,
    insights: null,
    offer: null,
    contract: null,
    practice: null,
  });

  return send(ctx.res, 200, {
    id: report.id,
    round: 1,
    r1: Object.assign({}, r1.scores, { verdict: r1.verdict }),
    eval: null,
    passed,
    accessCode: report.accessCode,
  });
}, { auth: false });

/* ============================ 第二轮：生成计划 ============================ */
route('POST', '/api/interview/plan2', async (ctx) => {
  const r = findReport(ctx.body.reportId);
  if (!r) return fail(ctx.res, 404, '面试记录不存在');
  if (r.round2plan) return send(ctx.res, 200, Object.assign({}, r.round2plan, { accessCode: r.accessCode }));

  const job = db.jobs.find((x) => x.id === r.jobId) || { name: r.jobName, jd: '', round2Count: 6 };
  const count = job.round2Count || 6;
  const resumePlan = r.planId ? db.plans.find((x) => x.id === r.planId) : null;
  const resume = (resumePlan && resumePlan.resume) || r.resume || '';

  let items = [];
  let source = 'bank';
  if (llm.enabled()) {
    try {
      const first = await agent.nextQuestion({ round: 2, idx: 0, jobName: job.name, jd: job.jd, resume, facts: resumeLib.parse(resume), questions: [], answers: [] });
      items = [first].concat(agent.planRound2({ jobName: job.name, count }).slice(1));
      source = first.source === 'llm' ? 'llm' : 'bank';
    } catch (_) {
      items = [];
    }
  }
  if (!items.length) {
    items = bank.buildRound2({ jobName: job.name, count }).map((q) => ({ text: q.text, dim: q.dim, material: q.material, source: 'bank' }));
  }

  const plan = {
    questions: items.map((q) => q.text),
    dims: items.map((q) => q.dim || 'execution'),
    materials: items.map((q) => q.material || ''),
    source,
  };
  db.reports.update(r.id, { round2plan: plan, stage: 'interviewing' });
  return send(ctx.res, 200, Object.assign({}, plan, { accessCode: r.accessCode }));
}, { auth: false });

/* ============================ 报告读写 ============================ */
route('GET', '/api/reports', async (ctx) => {
  const jobId = ctx.query.get('jobId');
  let list = db.reports.all();
  if (jobId) list = list.filter((x) => x.jobId === jobId);
  return send(ctx.res, 200, list.map(reportView));
});

route('GET', '/api/reports/:id', async (ctx) => {
  const r = findReport(ctx.params.id);
  if (!r) return fail(ctx.res, 404, '报告不存在');
  return send(ctx.res, 200, reportView(r));
});

route('POST', '/api/reports/:id/stage', async (ctx) => {
  const r = findReport(ctx.params.id);
  if (!r) return fail(ctx.res, 404, '报告不存在');
  const order = ['pending', 'interviewing', 'practice', 'evaluated', 'offer', 'signing', 'signed'];
  if (!order.includes(ctx.body.stage)) return fail(ctx.res, 400, '阶段不合法');
  db.reports.update(r.id, { stage: ctx.body.stage });
  return send(ctx.res, 200, { ok: true });
});

route('POST', '/api/reports/batch-stage', async (ctx) => {
  const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids : [];
  const stage = ctx.body.stage;
  const order = ['pending', 'interviewing', 'practice', 'evaluated', 'offer', 'signing', 'signed'];
  if (!order.includes(stage)) return fail(ctx.res, 400, '阶段不合法');
  let n = 0;
  for (const id of ids) {
    if (db.reports.update(id, { stage })) n++;
  }
  return send(ctx.res, 200, { ok: true, updated: n });
});

/* HR 人工改判第一轮通过，补发认证码 */
route('POST', '/api/reports/:id/round1/pass', async (ctx) => {
  const r = findReport(ctx.params.id);
  if (!r) return fail(ctx.res, 404, '报告不存在');
  const code = r.accessCode || accessCode();
  const round1 = Object.assign({}, r.round1, { verdict: '通过' });
  db.reports.update(r.id, { round1, accessCode: code, stage: r.stage === 'pending' ? 'pending' : r.stage });
  return send(ctx.res, 200, { ok: true, accessCode: code });
});

/* ============================ 第三关：实操交付 ============================ */
async function probeUrl(url) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const res = await fetch(url, { method: 'GET', redirect: 'follow', signal: ac.signal });
    clearTimeout(t);
    return res.status >= 200 && res.status < 500;
  } catch (_) {
    return false;
  }
}

route('POST', '/api/reports/:id/practice', async (ctx) => {
  const r = findReport(ctx.params.id);
  if (!r) return fail(ctx.res, 404, '报告不存在');
  if (!r.round2 || r.round2.verdict !== '通过') return fail(ctx.res, 400, '第二轮尚未通过');
  const url = String(ctx.body.url || '').trim();
  const note = String(ctx.body.note || '').trim();
  if (!/^https?:\/\/.+\..+/.test(url)) return fail(ctx.res, 400, '请填写公网可访问的作品网址（http/https 开头）');

  const reachable = await probeUrl(url);
  const autoScore = scoring.practiceAutoScore(url, note, reachable);
  const settings = getSettings();
  const autoConfirmed = Boolean(settings.autoAdvance && reachable && autoScore >= 60);

  const practice = {
    url,
    note,
    reachable,
    autoScore,
    hrScore: autoConfirmed ? autoScore : null,
    hrComment: autoConfirmed ? '系统自动确认（网址已验证可达且预评达标）' : '',
    submittedAt: nowISO(),
  };
  db.reports.update(r.id, { practice, stage: autoConfirmed ? 'evaluated' : 'practice' });
  return send(ctx.res, 200, { ok: true, autoScore, reachable, autoConfirmed });
}, { auth: false });

route('POST', '/api/reports/:id/practice/review', async (ctx) => {
  const r = findReport(ctx.params.id);
  if (!r) return fail(ctx.res, 404, '报告不存在');
  if (!r.practice) return fail(ctx.res, 400, '候选人尚未提交实操作品');
  const score = Math.max(0, Math.min(100, Number(ctx.body.score) || 0));
  const practice = Object.assign({}, r.practice, { hrScore: score, hrComment: String(ctx.body.comment || '') });
  db.reports.update(r.id, { practice, stage: 'evaluated' });
  return send(ctx.res, 200, { ok: true });
});

/* ============================ Offer 与电子签约 ============================ */
route('GET', '/api/reports/:id/offer', async (ctx) => {
  const r = findReport(ctx.params.id);
  if (!r) return fail(ctx.res, 404, 'Offer 不存在');
  return send(ctx.res, 200, {
    cand: r.cand,
    jobName: r.jobName,
    offer: r.offer || null,
    contract: r.contract || null,
  });
}, { auth: false });

route('POST', '/api/reports/:id/offer', async (ctx) => {
  const r = findReport(ctx.params.id);
  if (!r) return fail(ctx.res, 404, '报告不存在');
  const b = ctx.body;
  const offer = {
    title: b.title || r.jobName,
    salary: b.salary || '',
    startDate: b.startDate || '',
    expire: b.expire || '',
    note: b.note || '',
    status: 'sent',
    sentAt: nowISO(),
  };
  db.reports.update(r.id, { offer, stage: 'offer' });
  return send(ctx.res, 200, { ok: true, offer });
});

route('POST', '/api/reports/:id/offer/accept', async (ctx) => {
  const r = findReport(ctx.params.id);
  if (!r || !r.offer) return fail(ctx.res, 404, 'Offer 不存在');
  const action = ctx.body.action === 'decline' ? 'decline' : 'accept';
  if (action === 'decline') {
    db.reports.update(r.id, { offer: Object.assign({}, r.offer, { status: 'declined' }) });
    return send(ctx.res, 200, { ok: true, status: 'declined' });
  }
  const contract = {
    status: 'pending_sign',
    name: '',
    title: r.offer.title || r.jobName,
    salary: r.offer.salary,
    startDate: r.offer.startDate,
    note: r.offer.note,
    createdAt: nowISO(),
  };
  db.reports.update(r.id, {
    offer: Object.assign({}, r.offer, { status: 'accepted', acceptedAt: nowISO() }),
    contract,
    stage: 'signing',
  });
  return send(ctx.res, 200, { ok: true, status: 'accepted', contract });
}, { auth: false });

route('POST', '/api/reports/:id/contract/sign', async (ctx) => {
  const r = findReport(ctx.params.id);
  if (!r || !r.contract) return fail(ctx.res, 404, '合同不存在');
  const name = String(ctx.body.name || '').trim();
  const signData = String(ctx.body.signData || '');
  if (name.length < 2 || name.length > 30) return fail(ctx.res, 400, '请填写 2-30 字的签署姓名');
  if (!/^data:image\/png;base64,/.test(signData)) return fail(ctx.res, 400, '签名数据格式不正确');
  if (signData.length > 400000) return fail(ctx.res, 400, '签名图过大');
  const contract = Object.assign({}, r.contract, { status: 'signed', name, signData, signedAt: nowISO() });
  db.reports.update(r.id, { contract, stage: 'signed' });
  return send(ctx.res, 200, { ok: true, contract });
}, { auth: false });

/* ============================ 候选人自助查询 ============================ */
route('POST', '/api/portal/lookup', async (ctx) => {
  const { jobId, name, code } = ctx.body;
  if (!name || !/^\d{6}$/.test(String(code || ''))) return fail(ctx.res, 400, '请填写姓名与 6 位认证码');
  const r = db.reports.find(
    (x) => x.jobId === jobId && String(x.cand).trim() === String(name).trim() && String(x.accessCode) === String(code)
  );
  if (!r) return fail(ctx.res, 404, '没有匹配的面试记录，请确认姓名与认证码');
  return send(ctx.res, 200, portalState(r));
}, { auth: false });

/* ============================ 企业 / 角色 / 设置 / 简历 ============================ */
route('GET', '/api/orgs', async (ctx) => send(ctx.res, 200, db.orgs.all()));

route('POST', '/api/orgs', async (ctx) => {
  const name = String(ctx.body.name || '').trim();
  if (!name) return fail(ctx.res, 400, '请填写企业名称');
  const org = db.orgs.insert({ id: rid('o'), name, ownerId: ctx.user.id, createdAt: nowISO() });
  return send(ctx.res, 200, org);
});

route('GET', '/api/roles', async (ctx) =>
  send(ctx.res, 200, [
    { id: 'admin', name: '管理员', desc: '可管理岗位与企业' },
    { id: 'member', name: '成员', desc: '仅可面试与查看' },
  ])
);

route('GET', '/api/settings', async (ctx) => send(ctx.res, 200, getSettings()));

route('PUT', '/api/settings', async (ctx) => {
  const s = getSettings();
  const patch = {};
  if (ctx.body.retentionDays !== undefined) patch.retentionDays = Number(ctx.body.retentionDays);
  if (ctx.body.contactEmail !== undefined) patch.contactEmail = String(ctx.body.contactEmail);
  if (ctx.body.autoAdvance !== undefined) patch.autoAdvance = Boolean(ctx.body.autoAdvance);
  db.settings.update(s.id, patch);
  return send(ctx.res, 200, getSettings());
});

route('GET', '/api/resumes', async (ctx) => send(ctx.res, 200, db.resumes.all()));

/* 单份简历导入：第四阶段的真实 AI 接入入口。 */
route('POST', '/api/resumes', async (ctx) => {
  const b = ctx.body || {};
  const job = db.jobs.find((x) => x.id === b.jobId);
  const cand = String(b.cand || b.name || '候选人').trim() || '候选人';
  const text = String(b.text || b.resume || '').trim();
  if (!job) return fail(ctx.res, 404, '岗位不存在');
  if (text.length < 20) return fail(ctx.res, 400, '简历正文至少 20 字');
  if (!llm.enabled()) return fail(ctx.res, 503, 'AI 未配置，请先到「账号 → AI 接入」填写 API 地址、模型和 API Key');
  try {
    const prep = await generateResumePrep(job, cand, text);
    const rec = db.resumes.insert({
      id: rid('cv'),
      jobId: job.id,
      name: cand,
      cand,
      text,
      facts: prep.facts,
      pending: prep.pending,
      questions: prep.questions,
      parsed: prep.parsed,
      match: prep.match,
      matchReason: prep.matchReason,
      source: 'llm',
      provider: llm.status().provider,
      model: llm.status().model,
      at: nowISO(),
    });
    return send(ctx.res, 200, rec);
  } catch (e) {
    return fail(ctx.res, 502, '简历 AI 分析失败：' + (e.message || '未知错误'));
  }
});

route('POST', '/api/resumes/batch', async (ctx) => {
  const b = ctx.body || {};
  const job = db.jobs.find((x) => x.id === b.jobId);
  if (!job) return fail(ctx.res, 404, '岗位不存在');
  if (!llm.enabled()) return fail(ctx.res, 503, 'AI 未配置，请先到「账号 → AI 接入」填写 API 地址、模型和 API Key');
  const items = Array.isArray(b.items) ? b.items.slice(0, 20) : [];
  const results = await Promise.all(items.map(async (it) => {
    const cand = String(it.cand || it.name || '候選人').trim() || '候選人';
    const text = String(it.text || '').trim();
    if (text.length < 20) return { ok: false, cand, error: '简历正文至少 20 字' };
    try {
      const prep = await generateResumePrep(job, cand, text);
      const rec = db.resumes.insert({
        id: rid('cv'), jobId: job.id, name: cand, cand, text,
        facts: prep.facts, pending: prep.pending, questions: prep.questions,
        parsed: prep.parsed, match: prep.match, matchReason: prep.matchReason,
        source: 'llm', provider: llm.status().provider, model: llm.status().model, at: nowISO(),
      });
      return {
        ok: true, id: rec.id, cand, match: prep.match, matchReason: prep.matchReason,
        skills: prep.parsed.tech, facts: prep.facts, pending: prep.pending, questions: prep.questions,
        link: '/?job=' + encodeURIComponent(job.id) + '&name=' + encodeURIComponent(job.name) + '&cand=' + encodeURIComponent(cand),
      };
    } catch (e) {
      return { ok: false, cand, error: 'AI 分析失败：' + (e.message || '未知错误') };
    }
  }));
  return send(ctx.res, 200, { jobId: job.id, jobName: job.name, results });
});

/* ============================ LLM 代理 ============================ */
route('POST', '/api/llm', async (ctx) => {
  if (!llm.enabled()) return fail(ctx.res, 503, 'LLM 未配置，请使用内置题库通道');
  const messages = Array.isArray(ctx.body.messages) ? ctx.body.messages : [];
  const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
  const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  if (!user) return fail(ctx.res, 400, '缺少 user 消息');
  try {
    const content = await llm.chat({ system, user, json: true, temperature: 0.4 });
    return send(ctx.res, 200, { content });
  } catch (e) {
    return fail(ctx.res, 502, 'LLM 调用失败：' + e.message);
  }
});

/* ============================ 智能体端点（候选人端实时出题 / 逐题评估） ============================ */
/**
 * 出下一题。
 * 有 planId 时走"带状态的追问"：读取该计划已生成的题目与作答，
 * 由规则链判断上一题缺什么，生成追问并【回写进 plan】，保证评分用的是真实问过的题。
 */
route('POST', '/api/agent/next-question', async (ctx) => {
  const b = ctx.body || {};
  const round = Number(b.round) === 2 ? 2 : 1;

  const plan = b.planId ? db.plans.find((x) => x.id === b.planId) : null;
  const report = b.reportId ? findReport(b.reportId) : null;
  const reportPlan = report && report.planId ? db.plans.find((x) => x.id === report.planId) : null;
  const sourcePlan = plan || reportPlan;

  const questions = plan ? plan.questions.map((q) => q.text) : (Array.isArray(b.questions) ? b.questions : []);
  const answers = Array.isArray(b.answers) ? b.answers : [];
  const idx = Number.isFinite(Number(b.idx)) ? Number(b.idx) : questions.length;

  /* 只把"真正问过"的题交给智能体。客户端传上来的 questions 可能包含尚未提问的骨架题，
     直接整份传进去会让它以为所有角度都用过了。 */
  const askedTexts = questions.slice(0, idx);
  const askedAnswers = answers.slice(0, idx);

  const resume = (sourcePlan && sourcePlan.resume) || b.resume || '';
  const facts = resumeLib.parse(resume);
  const intents = plan && Array.isArray(plan.questions) ? plan.questions : [];

  /* 已经问过的意图：取该计划里 idx 之前真实问过的题的 kind（追问不计入意图消耗） */
  const consumed = (intents || [])
    .slice(0, idx)
    .map((q) => q && q.kind)
    .filter((k) => k && !String(k).startsWith('probe:') && k !== 'fill');
  const probeKinds = (plan && plan.probeKinds) || [];

  const q = await agent.nextQuestion({
    round,
    idx,
    jobName: (sourcePlan && sourcePlan.jobName) || b.jobName || '该岗位',
    jd: (sourcePlan && sourcePlan.jd) || b.jd || '',
    resume,
    facts,
    intents,
    questions: askedTexts,
    answers: askedAnswers,
    probeCount: probeKinds.length,
    probesAsked: probeKinds,
    usedIntents: consumed,
  });

  /* 回写：把真实问过的题存回 plan，评分才有据可依 */
  if (plan) {
    const patch = { questions: plan.questions.slice() };
    while (patch.questions.length <= idx) {
      patch.questions.push({ kind: 'fill', text: '请补充一段你最有代表性的经历：背景、你的角色、做法与结果。', expects: [], basis: 'pad' });
    }
    patch.questions[idx] = {
      kind: q.kind || 'unknown',
      text: q.text,
      expects: q.expects || [],
      dim: q.dim,
      material: q.material,
      basis: q.basis || '',
      source: q.source || 'rule',
      adapted: true,
    };
    if (String(q.kind || '').startsWith('probe:')) {
      patch.probeKinds = probeKinds.concat([String(q.kind).replace('probe:', '')]);
      patch.probeCount = patch.probeKinds.length;
    }
    db.plans.update(plan.id, patch);
  }

  return send(ctx.res, 200, q);
}, { auth: false });

/**
 * 逐题评判（第二轮 / HR 复盘）。
 * 返回每题的分数、证据引用、缺失要点，以及追问建议。
 */
route('POST', '/api/agent/eval-round2', async (ctx) => {
  const b = ctx.body || {};
  const questions = Array.isArray(b.questions) ? b.questions : [];
  const answers = Array.isArray(b.answers) ? b.answers : [];
  const dims = Array.isArray(b.dims) ? b.dims : [];
  const materials = Array.isArray(b.materials) ? b.materials : [];
  const facts = b.resume ? resumeLib.parse(b.resume) : null;

  const out = await judge.judgeAll(
    questions.map((q, i) => ({
      question: q,
      answer: answers[i] || '',
      dim: dims[i],
      material: materials[i],
      facts,
    }))
  );

  /* 兼容旧前端：把 score/comment/flagged 放顶层 */
  return send(
    ctx.res,
    200,
    out.map((j) => ({
      score: j.score,
      comment: j.comment,
      flagged: j.flagged,
      evidence: j.evidence,
      missing: j.missing,
      rubric: j.rubric,
      probe: j.probe,
      source: j.source,
    }))
  );
}, { auth: false });

/** 评判第一轮（HR 打开报告时按需计算，带证据与洞察）。 */
route('POST', '/api/reports/:id/judge', async (ctx) => {
  const r = findReport(ctx.params.id);
  if (!r) return fail(ctx.res, 404, '报告不存在');
  const r1 = r.round1 || {};
  const facts = resumeLib.parse(r.resume || '');
  const items = (r1.questions || []).map((q, i) => ({
    question: q,
    answer: (r1.answers || [])[i] || '',
    facts,
  }));
  const judgments = await judge.judgeAll(items);
  const insights = judge.insight(judgments, facts);
  db.reports.update(r.id, { judgments, insights });
  return send(ctx.res, 200, { judgments, insights });
});

/* ============================ LLM 接入配置（接口层） ============================ */
/**
 * 智能体的"脑子"从这里接。
 * 任何 OpenAI 兼容端点都能用：DeepSeek / OpenAI / 月之暗面 / 通义 / 智谱 / 硅基流动 / 本地 Ollama。
 * 密钥只存服务端 data/llm.json，接口只回脱敏状态。
 */
route('GET', '/api/llm/config', async (ctx) =>
  send(ctx.res, 200, { status: llm.status(), providers: llm.listProviders() })
);

route('PUT', '/api/llm/config', async (ctx) => {
  const b = ctx.body || {};
  if (b.provider && !llm.PROVIDERS[b.provider]) return fail(ctx.res, 400, '未知的 provider');
  try {
    llm.configure({
      provider: b.provider,
      baseUrl: b.baseUrl,
      apiKey: b.apiKey,
      model: b.model,
      timeout: b.timeout,
    });
  } catch (e) {
    return fail(ctx.res, 400, '保存失败：' + e.message);
  }
  return send(ctx.res, 200, { ok: true, status: llm.status() });
});

/** 测试连接：真实发一次 ping，返回延迟与模型回显。
 *  注意：这是诊断接口，配置不全也算"正常返回"，用 200 + ok:false 表达，
 *  否则前端只会看到 HTTP 502 而看不到真正的原因。 */
route('POST', '/api/llm/test', async (ctx) => {
  const r = await llm.probe();
  return send(ctx.res, 200, r);
});

/* ============================ AI 全程面试（智能体自己主持） ============================ */

/**
 * 把一场结束的 AI 面试落成一条报告，让它出现在「数据」标签里。
 * /turn 自然收尾和 /finish 主动收尾都走这里，避免两处逻辑漂移。
 */
function persistSessionReport(s) {
  const dup = db.reports.find((x) => x.planId === s.id && x.source === 'ai-session');
  if (dup) return dup.id;

  const v = s.verdict || {};
  const report = db.reports.insert({
    id: rid('rp'),
    planId: s.id,
    clientId: 'ai-' + s.id,
    jobId: s.jobId || null,
    jobName: s.jobName,
    cand: s.cand || '候选人',
    resume: s.resume,
    at: nowISO(),
    updatedAt: nowISO(),
    stage: 'interviewing',
    round: 1,
    source: 'ai-session',
    accessCode: null,
    round1: {
      questions: s.turns.map((t) => t.q),
      answers: s.turns.map((t) => t.a),
      expects: s.turns.map((t) => t.expects || []),
      scores: s.turns.map((t) => (t.judgment ? t.judgment.score : 0)),
      hits: null,
      details: null,
      verdict: v.verdict || '不通过',
      mode: 'ai-session',
    },
    judgments: s.turns.filter((t) => t.judgment).map((t) => t.judgment),
    insights: {
      summary: v.summary || '',
      strengths: v.strengths || [],
      weaknesses: v.weaknesses || [],
      suspicious: v.suspicious || [],
      score: v.score || 0,
      reasons: v.reasons || [],
      angles: v.angles || [],
    },
    round2plan: null,
    round2: null,
    eval: null,
    offer: null,
    contract: null,
    practice: null,
  });
  return report.id;
}

/**
 * 与 /api/interview/plan 的"标准 6 题流程"不同：
 * 这里没有固定题量，每一轮都是 评判 → 决策 → 出题，
 * 什么时候收尾由智能体根据"证据够不够"自己判断。
 */
route('POST', '/api/agent/session/start', async (ctx) => {
  const b = ctx.body || {};
  const job = b.jobId ? db.jobs.find((x) => x.id === b.jobId) : null;
  if (b.jobId && !job) return fail(ctx.res, 404, '岗位不存在或未发布');

  let s;
  try {
    s = await agentSession.start({
      resume: b.resume,
      jobName: (job && job.name) || b.jobName || '该岗位',
      jd: (job && job.jd) || b.jd || '',
      maxTurns: b.maxTurns,
    });
  } catch (e) {
    return fail(ctx.res, 400, e.message);
  }

  const rec = db.interviews.insert(Object.assign({}, s, { id: rid('as'), jobId: (job && job.id) || null, cand: b.cand || '候选人' }));
  s.id = rec.id;

  return send(ctx.res, 200, {
    sessionId: rec.id,
    question: { text: s.turns[0].q, kind: s.turns[0].kind, reason: s.turns[0].reason, expects: s.turns[0].expects },
    facts: s.facts,
    maxTurns: s.maxTurns,
    progress: agentSession.progressOf(s),
    mode: llm.enabled() ? 'llm' : 'rule',
  });
}, { auth: false });

/** 提交一条回答 → 评判 + 下一步（可能是下一题，也可能是收尾）。 */
route('POST', '/api/agent/session/turn', async (ctx) => {
  const b = ctx.body || {};
  const s = db.interviews.find((x) => x.id === b.sessionId);
  if (!s) return fail(ctx.res, 404, '面试会话不存在或已过期');
  if (s.done) return fail(ctx.res, 409, '本场面试已结束');

  const out = await agentSession.step(s, b.answer);

  /* 落库（含逐题评判） */
  db.interviews.update(s.id, {
    turns: s.turns,
    plan: s.plan,
    covered: s.covered,
    probes: s.probes,
    done: s.done,
    verdict: s.verdict,
    updatedAt: nowISO(),
  });

  /* 收尾时生成一条报告，让它出现在「数据」里 */
  if (out.done) {
    out.reportId = persistSessionReport(s);
  }

  return send(ctx.res, 200, out);
}, { auth: false });

/** 读完整对话记录（候选人端复盘 / HR 端查看）。 */
/**
 * 读完整对话记录（候选人端复盘 / HR 端查看）。
 * 与 /api/interview/plan 一致不要求登录：候选人本来就无需注册，
 * sessionId 是随机生成的，等同于一次性访问凭据。
 */
route('GET', '/api/agent/session/:id', async (ctx) => {
  const s = db.interviews.find((x) => x.id === ctx.params.id);
  if (!s) return fail(ctx.res, 404, '面试会话不存在');
  return send(ctx.res, 200, agentSession.transcript(s));
}, { auth: false });

/** 主动收尾（候选人中途放弃 / 时间到）。 */
route('POST', '/api/agent/session/finish', async (ctx) => {
  const b = ctx.body || {};
  const s = db.interviews.find((x) => x.id === b.sessionId);
  if (!s) return fail(ctx.res, 404, '面试会话不存在');
  let reportId = null;
  if (!s.done) {
    s.done = true;
    s.verdict = agentSession.finalize(s);
    db.interviews.update(s.id, { done: true, verdict: s.verdict, turns: s.turns, covered: s.covered, probes: s.probes });
    reportId = persistSessionReport(s);
  }
  return send(ctx.res, 200, { done: true, verdict: s.verdict, progress: agentSession.progressOf(s), reportId });
}, { auth: false });

/* ============================ 健康检查 ============================ */
route('GET', '/api/health', async (ctx) =>
  send(ctx.res, 200, {
    ok: true,
    llm: (() => {
      const s = llm.status();
      return s.enabled ? { enabled: true, model: s.model, provider: s.provider } : { enabled: false };
    })(),
    agent: { mode: llm.enabled() ? 'llm' : 'rule', probes_per_round: agent.MAX_PROBES },
    llm_diagnostics: llm.diagnostics().last_fallback,
    counts: {
      jobs: db.jobs.all().length,
      reports: db.reports.all().length,
      users: db.users.all().length,
    },
    uptime: Math.round(process.uptime()),
  }),
  { auth: false }
);

/* ------------------------------------------------------------------ 静态资源 */
const WEB_DIR = path.join(__dirname, process.env.WEB_DIR || '_recon');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = rel.replace(/\.\./g, '');
  const file = path.join(WEB_DIR, rel);
  if (!file.startsWith(WEB_DIR)) return send(res, 403, 'forbidden');
  fs.readFile(file, (err, buf) => {
    if (err) {
      /* 目标站点是单页应用：未知路径一律回落到 index.html */
      return fs.readFile(path.join(WEB_DIR, 'index.html'), (e2, home) => {
        if (e2) return send(res, 404, 'not found');
        send(res, 200, home.toString('utf8'));
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': buf.length });
    res.end(buf);
  });
}

/* ------------------------------------------------------------------ 主循环 */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = url.pathname;

  if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

  const method = req.method.toUpperCase();
  const match = routes.find((r) => r.method === method && r.rx.test(pathname));
  if (!match) {
    /* 目标站点的 404 文案：路径存在但方法不对时给"接口不存在" */
    return fail(res, 404, '接口不存在');
  }

  const m = pathname.match(match.rx);
  const params = {};
  match.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));

  const user = sessionUser(req);
  if (match.auth && !user) return fail(res, 401, '未登录');

  let body = {};
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      body = await readBody(req);
    } catch (e) {
      return fail(res, 400, e.message === 'bad-json' ? '请求体不是合法 JSON' : '请求体过大');
    }
  }

  try {
    await match.handler({ req, res, params, query: url.searchParams, body, user });
  } catch (e) {
    console.error('[error]', method, pathname, e);
    if (!res.headersSent) fail(res, 500, '服务端错误');
  }
});

seedDemoAccount();

server.listen(PORT, HOST, () => {
  console.log('面试智能体复刻版已启动: http://' + (HOST === '0.0.0.0' ? '127.0.0.1' : HOST) + ':' + PORT);
  console.log('LLM: ' + (llm.enabled() ? llm.DEFAULT_MODEL + ' @ ' + llm.DEFAULT_BASE : '未配置 → 内置题库确定性通道'));
  if (DEMO_PASSWORD) console.log('演示账号: ' + DEMO_ACCOUNT + ' / ' + DEMO_PASSWORD + '  （也可直接注册新账号）');
});

module.exports = server;
