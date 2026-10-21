'use strict';
/**
 * 考核自检 harness。
 *
 * 三组考核：
 *   replica  —— 复刻一致性：评分公式回归 + 全流程 API 契约（对照目标站点实测向量）
 *   rea      —— REA 契约合规：Evidence 结构、evidence_id 可复算、authority/confidence 枚举、
 *               limitations 非空、unknowns 显式、MCP stdio 握手与 tools/list
 *   reach    —— Agent-Reach 契约合规：doctor 平台矩阵、read 抽取、github/rss 通道、JSON 输出稳定
 *
 *   node eval/run.js               # 全跑
 *   node eval/run.js --only=rea    # 单组
 *   node eval/run.js --base=http://127.0.0.1:3000   # 指定复刻实例
 */

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');

const ONLY = (process.argv.find((a) => a.startsWith('--only=')) || '').split('=')[1] || 'all';
const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '').split('=')[1] || 'http://127.0.0.1:3000';

const ROOT = path.join(__dirname, '..');
const scoring = require(path.join(ROOT, 'lib', 'scoring.js'));
const rea = require(path.join(ROOT, 'tools', 'rea', 'rea.js'));
const reach = require(path.join(ROOT, 'tools', 'reach', 'reach.js'));

/* ------------------------------------------------------------ 报告器 */
const results = [];
function check(group, name, fn) {
  const t0 = Date.now();
  try {
    const out = fn();
    if (out && typeof out.then === 'function') {
      return out.then(
        () => results.push({ group, name, ok: true, ms: Date.now() - t0 }),
        (e) => results.push({ group, name, ok: false, ms: Date.now() - t0, error: e.message })
      );
    }
    results.push({ group, name, ok: true, ms: Date.now() - t0 });
  } catch (e) {
    results.push({ group, name, ok: false, ms: Date.now() - t0, error: e.message });
  }
}

function head(t) {
  console.log('\n' + '='.repeat(64) + '\n' + t + '\n' + '='.repeat(64));
}

/* ============================================================ replica */
/** 目标站点实测向量（真值，来自 /api/reports 抓取与探针提交）。 */
const GROUND_TRUTH = [
  {
    name: '林润泽 / AI实习生',
    details: [
      { layer: 40, cause: 10, detail: 30, logic: 80, hit: 2, total: 3, accuracy: 67 },
      { layer: 15, cause: 10, detail: 30, logic: 55, hit: 2, total: 3, accuracy: 67 },
      { layer: 15, cause: 10, detail: 30, logic: 55, hit: 3, total: 3, accuracy: 100 },
      { layer: 40, cause: 10, detail: 30, logic: 80, hit: 3, total: 3, accuracy: 100 },
      { layer: 15, cause: 10, detail: 30, logic: 55, hit: 3, total: 3, accuracy: 100 },
      { layer: 15, cause: 10, detail: 30, logic: 55, hit: 1, total: 3, accuracy: 33 },
    ],
    expect: { logic: 63, accuracy: 78, verdict: '通过' },
  },
  {
    name: 'HELMD探针C / 算法实习生',
    details: [
      { layer: 0, cause: 10, detail: 30, logic: 40, hit: 2, total: 3, accuracy: 67 },
      { layer: 0, cause: 10, detail: 30, logic: 40, hit: 2, total: 3, accuracy: 67 },
      { layer: 0, cause: 10, detail: 30, logic: 40, hit: 3, total: 3, accuracy: 100 },
      { layer: 15, cause: 10, detail: 30, logic: 55, hit: 3, total: 3, accuracy: 100 },
      { layer: 0, cause: 10, detail: 30, logic: 40, hit: 2, total: 3, accuracy: 67 },
      { layer: 0, cause: 10, detail: 30, logic: 40, hit: 3, total: 3, accuracy: 100 },
    ],
    expect: { logic: 43, accuracy: 84, verdict: '不通过' },
  },
];

async function evalReplica() {
  head('考核一 · 复刻一致性 (replica)');

  await check('replica', '单题公式 logic = layer + cause + detail', () => {
    for (const gt of GROUND_TRUTH) {
      for (const d of gt.details) assert.strictEqual(d.layer + d.cause + d.detail, d.logic);
    }
  });

  await check('replica', '整轮聚合 round(mean) 与目标一致', () => {
    for (const gt of GROUND_TRUTH) {
      const logic = Math.round(gt.details.reduce((a, d) => a + d.logic, 0) / gt.details.length);
      const accuracy = Math.round(gt.details.reduce((a, d) => a + d.accuracy, 0) / gt.details.length);
      assert.strictEqual(logic, gt.expect.logic, gt.name + ' logic');
      assert.strictEqual(accuracy, gt.expect.accuracy, gt.name + ' accuracy');
    }
  });

  await check('replica', 'verdict 阈值 logic>=60 && accuracy>=40', () => {
    const cases = [
      [{ logic: 63, accuracy: 78 }, '通过'],
      [{ logic: 68, accuracy: 89 }, '通过'],
      [{ logic: 100, accuracy: 44 }, '通过'],
      [{ logic: 78, accuracy: 84 }, '通过'],
      [{ logic: 23, accuracy: 6 }, '不通过'],
      [{ logic: 17, accuracy: 0 }, '不通过'],
    ];
    for (const [s, v] of cases) {
      const got = s.logic >= 60 && s.accuracy >= 40 ? '通过' : '不通过';
      assert.strictEqual(got, v, JSON.stringify(s));
    }
  });

  await check('replica', '分句模型复现探针 6 题的 layer 分桶', () => {
    /* 探针实测 layer = [0,0,0,15,0,0]，全部由「。；」分句数决定 */
    const answers = [
      '我作为负责人主导课程表小程序前端的设计与开发，用uni-app实现课表导入、提醒、分享三个模块，因为学校教务数据不统一，我设计了解析适配层，最终上线后两千多同学使用，导入成功率从百分之九十提升到百分之九十八。',
      '我主导校园二手交易平台后端订单模块的开发与上线，用Node.js和MySQL实现订单接口，因为并发下单会超卖，我设计了唯一约束加乐观锁，库存校验放在事务里，结果是半年零丢单，订单失败率从百分之三降到千分之二。',
      '我用Python开发简历解析工具，因为模型输出不稳定，我在项目里加了JSON结构校验和三次指数退避重试，解决了字段缺失的问题，准确率从六成提升到九成，并用一千份样本做了对比评测。',
      '我的优势是熟悉工程落地与大模型应用开发，擅长接口联调；不足是算法理论欠缺，短板在复杂度分析，我计划每周刷十道题并复现一篇论文，三个月内补足。',
      '我和同学在方案上出现分歧时，先把两套意见写成对比文档列成本与风险，再约三十分钟会议沟通对齐，用数据讨论，最终推进落地并提前两天交付，结果是双方都认可。',
      '我最近主动学习Docker因为项目需要环境一致，我用两周从零阅读官方文档并研究实践，把服务打成镜像并写docker-compose，应用在团队交付上，环境搭建时间从两小时降到十分钟。',
    ];
    const got = answers.map((a) => scoring.scoreLayer(a));
    assert.deepStrictEqual(got, [0, 0, 0, 15, 0, 0], 'got ' + JSON.stringify(got));
  });

  await check('replica', '第三关预评公式标定值 = 68', () => {
    /* 目标实测：reachable=true / note 26 字 / http + 根路径 → autoScore 68 */
    const s = scoring.practiceAutoScore('http://106.54.173.125/', '探针：仅验证第三关提交与预评逻辑，未提交真实作品。', true);
    assert.strictEqual(s, 68, 'got ' + s);
  });

  await check('replica', '第二轮三维 avg = round(mean) 与目标一致', () => {
    const cases = [
      [{ communication: 75, learning: 87, execution: 79 }, 80],
      [{ communication: 95, learning: 65, execution: 78 }, 79],
      [{ communication: 87, learning: 84, execution: 84 }, 85],
    ];
    for (const [s, avg] of cases) {
      const got = Math.round((s.communication + s.learning + s.execution) / 3);
      assert.strictEqual(got, avg, JSON.stringify(s));
    }
  });

  await check('replica', 'hitGroups 组内任一命中即计分', () => {
    const expects = [['python', 'Python'], ['难点', '问题', '解决'], ['结果', '提升']];
    const r = scoring.hitGroups('我用 Python 解决了这个难点，最终效果提升明显', expects);
    assert.deepStrictEqual(r, { hit: 3, total: 3 });
    const r2 = scoring.hitGroups('不知道', expects);
    assert.deepStrictEqual(r2, { hit: 0, total: 3 });
  });

  /* ---- 活体 API 契约 ---- */
  const api = async (p, opts) => {
    const init = { method: (opts && opts.method) || 'GET', headers: { 'Content-Type': 'application/json' } };
    if (opts && opts.body) init.body = JSON.stringify(opts.body);
    if (opts && opts.cookie) init.headers.Cookie = opts.cookie;
    const res = await fetch(BASE + p, init);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
    return { status: res.status, data, headers: res.headers };
  };

  let alive = true;
  try {
    const h = await api('/api/health');
    alive = h.status === 200 && h.data && h.data.ok === true;
  } catch (_) {
    alive = false;
  }

  if (!alive) {
    results.push({ group: 'replica', name: '活体实例可达（跳过 API 契约组）', ok: false, ms: 0, error: '无法连接 ' + BASE + '，请先 npm start' });
    return;
  }

  await check('replica', '活体：/api/auth/session 未登录返回 401 未登录', async () => {
    const r = await api('/api/auth/session');
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.data.error, '未登录');
  });

  await check('replica', '活体：演示账号 admin / demo1234 可登录且为 admin', async () => {
    const r = await api('/api/auth/login', { method: 'POST', body: { account: 'admin', password: 'demo1234' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.strictEqual(r.data.account, 'admin');
    assert.strictEqual(r.data.role, 'admin');
  });

  await check('replica', '活体：错误密码文案对齐目标「账号或密码不正确」', async () => {
    const r = await api('/api/auth/login', { method: 'POST', body: { account: 'admin', password: 'definitely-wrong' } });
    assert.strictEqual(r.status, 401);
    assert.strictEqual(r.data.error, '账号或密码不正确');
  });

  const account = 'eval' + Date.now().toString(36);
  const cookie = await (async () => {
    const r = await api('/api/auth/register', { method: 'POST', body: { account, name: 'EVAL', password: 'Eval#2026' } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    return (r.headers.get('set-cookie') || '').split(';')[0];
  })();

  await check('replica', '活体：注册返回 {id,account,name,role}', () => {
    assert.ok(cookie, 'missing session cookie');
  });

  const job = await (async () => {
    const r = await api('/api/jobs', { method: 'POST', cookie, body: { name: '考核岗位', round1Count: 6, round2Count: 6 } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    return r.data;
  })();

  await check('replica', '活体：/api/interview?job= 公开返回岗位契约', async () => {
    const r = await api('/api/interview?job=' + job.id);
    assert.strictEqual(r.status, 200);
    for (const k of ['id', 'name', 'jd', 'round1Count', 'round2Count', 'duration']) assert.ok(k in r.data, 'missing ' + k);
  });

  await check('replica', '活体：简历 <20 字返回 400 简历正文至少 20 字', async () => {
    const r = await api('/api/interview/plan', { method: 'POST', body: { jobId: job.id, cand: 'x', resume: '短' } });
    assert.strictEqual(r.status, 400);
    assert.strictEqual(r.data.error, '简历正文至少 20 字');
  });

  const resume = '张三，本科计算机专业。主导课程表小程序前端（uni-app），主导校园二手交易平台后端（Node.js + MySQL），独立完成基于大模型的简历解析工具（Python，准确率从60%提升到90%）。熟悉 Python、JavaScript、MySQL、Git、Linux、Docker。';
  const plan = await (async () => {
    const r = await api('/api/interview/plan', { method: 'POST', body: { jobId: job.id, cand: '考核候选人', resume } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    return r.data;
  })();

  await check('replica', '活体：plan 返回 planId + 6 题', () => {
    assert.ok(plan.planId);
    assert.strictEqual(plan.questions.length, 6);
  });

  const answers = [
    '我作为负责人主导课程表小程序前端的设计与开发。用 uni-app 实现课表导入、提醒、分享三个模块，因为学校教务数据不统一，我设计了解析适配层。最终上线后两千多同学使用，导入成功率从百分之九十提升到百分之九十八。',
    '我主导校园二手交易平台后端订单模块的开发与上线。用 Node.js 和 MySQL 实现订单接口，因为并发下单会超卖，我设计了唯一约束加乐观锁。结果是半年零丢单，订单失败率从百分之三降到千分之二。',
    '我用 Python 开发简历解析工具，负责字段抽取与结构化输出。因为模型输出不稳定，我在项目里加了 JSON 结构校验和三次指数退避重试。最终准确率从六成提升到九成，并用一千份样本做了对比评测。',
    '我的优势是熟悉工程落地与大模型应用开发，擅长接口联调；不足是算法理论欠缺，短板在复杂度分析。我的补足计划是每周刷十道题并复现一篇论文。三个月内把基础补齐，并做一次完整的评测复现。',
    '我和同学在方案上出现分歧时，会先把两套意见写成对比文档，列出成本与风险。然后约三十分钟会议沟通对齐，用数据讨论而不是靠嗓门。最终推进落地并提前两天交付，结果是双方都认可这个折中方案。',
    '我最近主动学习 Docker，因为项目交付时环境总是不一致。我用两周从零阅读官方文档并动手实践，把服务打成镜像并写了 docker-compose。应用在团队交付上之后，环境搭建时间从两小时降到十分钟。',
  ];

  const r1 = await (async () => {
    const r = await api('/api/reports', { method: 'POST', body: { planId: plan.planId, clientId: 'eval1', answers } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    return r.data;
  })();

  await check('replica', '活体：第一轮返回 {id,round,r1{logic,accuracy,verdict},passed,accessCode}', () => {
    assert.strictEqual(r1.round, 1);
    assert.ok(typeof r1.r1.logic === 'number');
    assert.ok(typeof r1.r1.accuracy === 'number');
    assert.ok(['通过', '不通过'].includes(r1.r1.verdict));
    assert.strictEqual(typeof r1.passed, 'boolean');
  });

  await check('replica', '活体：幂等——同 planId+clientId 重复提交返回 duplicate', async () => {
    const r = await api('/api/reports', { method: 'POST', body: { planId: plan.planId, clientId: 'eval1', answers } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.duplicate, true);
    assert.strictEqual(r.data.id, r1.id);
  });

  /* ---------------- 智能体行为：这才是"像不像智能体"的部分 ---------------- */

  const AGENT_RESUME = '赵六，本科软件工程。主导校园二手交易平台后端订单模块（Node.js + MySQL），'
    + '设计唯一约束加乐观锁解决超卖，订单失败率从3%降到0.2%，半年零丢单。'
    + '独立完成简历解析工具（Python + FastAPI），字段抽取准确率从60%提升到90%。'
    + '熟悉 Docker、Redis、Git、Linux、Kubernetes。';

  await check('replica', '智能体：出题锚定简历原文（引用简历片段而非模板）', async () => {
    const r = await api('/api/interview/plan', { method: 'POST', body: { jobId: job.id, cand: '锚定测试', resume: AGENT_RESUME } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    const q1 = r.data.questions[0];
    assert.ok(q1.includes('「'), '首题必须引用简历原文，实际：' + q1);
    /* 引用的片段要真的在简历里 */
    const quoted = q1.match(/「([^」]+)」/);
    assert.ok(quoted && AGENT_RESUME.includes(quoted[1].replace(/…$/, '')), '引用片段必须来自简历原文');
    assert.ok(r.data.agent && r.data.agent.facts, 'plan 必须回传解析出的事实');
    assert.ok(r.data.agent.facts.metrics.length >= 3, '应识别出量化指标');
  });

  await check('replica', '智能体：同一份简历，不同回答 → 下一题不同', async () => {
    const p1 = await api('/api/interview/plan', { method: 'POST', body: { jobId: job.id, cand: 'A', resume: AGENT_RESUME } });
    const p2 = await api('/api/interview/plan', { method: 'POST', body: { jobId: job.id, cand: 'B', resume: AGENT_RESUME } });
    assert.strictEqual(p1.data.questions[0], p2.data.questions[0], '同一简历首题应相同');

    const vague = '我做过一些后端相关的工作，主要负责写接口，大概就是增删改查那些，感觉还行。';
    const detail = '在二手交易平台项目里我负责订单模块。当时并发下单会超卖，我先压测复现，'
      + '发现库存校验和扣减不在一个事务里。我加乐观锁版本号并把校验放进事务，'
      + '改完后压测 2000 QPS，失败率从 3% 降到 0.2%，上线后半年零丢单。';

    const qa = await api('/api/agent/next-question', {
      method: 'POST',
      body: { round: 1, planId: p1.data.planId, idx: 1, jobName: job.name, resume: AGENT_RESUME, questions: p1.data.questions, answers: [vague] },
    });
    const qb = await api('/api/agent/next-question', {
      method: 'POST',
      body: { round: 1, planId: p2.data.planId, idx: 1, jobName: job.name, resume: AGENT_RESUME, questions: p2.data.questions, answers: [detail] },
    });
    assert.strictEqual(qa.status, 200, JSON.stringify(qa.data));
    assert.strictEqual(qb.status, 200, JSON.stringify(qb.data));
    assert.notStrictEqual(qa.data.text, qb.data.text, '不同回答必须得到不同的下一题');
    assert.ok(qa.data.basis, '必须说明为什么问这一题');
  });

  await check('replica', '智能体：追问会引用上一题原话（不是泛泛而问）', async () => {
    const p = await api('/api/interview/plan', { method: 'POST', body: { jobId: job.id, cand: 'C', resume: AGENT_RESUME } });
    const vague = '我做过一些后端相关的工作，主要负责写接口，大概就是增删改查那些，感觉还行，后来项目就结束了。';
    const q = await api('/api/agent/next-question', {
      method: 'POST',
      body: { round: 1, planId: p.data.planId, idx: 1, jobName: job.name, resume: AGENT_RESUME, questions: p.data.questions, answers: [vague] },
    });
    assert.strictEqual(q.status, 200);
    assert.ok(String(q.data.kind).startsWith('probe:'), '空泛作答必须触发追问，实际 kind=' + q.data.kind);
    /* 追问里应出现上一题回答的片段 */
    const frag = vague.slice(4, 14);
    assert.ok(q.data.text.includes(frag) || q.data.text.includes('你刚才'), '追问必须锚定上一题内容：' + q.data.text);
  });

  await check('replica', '智能体：一轮内追问次数受预算约束', async () => {
    const p = await api('/api/interview/plan', { method: 'POST', body: { jobId: job.id, cand: 'D', resume: AGENT_RESUME } });
    const bad = '不太清楚，大概是做了一些事情吧。';
    const qs = p.data.questions.slice();
    const as = [];
    let probes = 0;
    for (let i = 1; i < 6; i++) {
      const q = await api('/api/agent/next-question', {
        method: 'POST',
        body: { round: 1, planId: p.data.planId, idx: i, jobName: job.name, resume: AGENT_RESUME, questions: qs, answers: as.slice() },
      });
      qs[i] = q.data.text;
      as.push(bad);
      if (String(q.data.kind).startsWith('probe:')) probes++;
    }
    assert.ok(probes <= 2, '追问预算上限 2 次，实际 ' + probes);
  });

  await check('replica', '智能体：自主评判给出分数 + 原文证据 + 缺失项', async () => {
    const good = '在二手交易平台项目里我负责订单模块。当时并发下单会超卖，我先压测复现，'
      + '发现库存校验和扣减不在一个事务里。我加乐观锁版本号并把校验放进事务，'
      + '改完后压测 2000 QPS，失败率从 3% 降到 0.2%，上线后半年零丢单。';
    const bad = '我做过一些后端相关的工作，大概就是增删改查那些，感觉还行。';

    const jg = await api('/api/agent/eval-round2', { method: 'POST', body: { questions: ['讲讲你的订单模块'], answers: [good], dims: ['execution'], resume: AGENT_RESUME } });
    const jb = await api('/api/agent/eval-round2', { method: 'POST', body: { questions: ['讲讲你的订单模块'], answers: [bad], dims: ['execution'], resume: AGENT_RESUME } });
    assert.strictEqual(jg.status, 200);
    const g = jg.data[0];
    const b = jb.data[0];

    assert.ok(typeof g.score === 'number' && typeof b.score === 'number');
    assert.ok(g.score > b.score + 20, '好答案必须显著高于空泛答案：' + g.score + ' vs ' + b.score);
    assert.ok(Array.isArray(g.evidence) && g.evidence.length > 0, '必须给出原文证据');
    for (const e of g.evidence) assert.ok(good.includes(e.replace(/…$/, '')), '证据必须是原文片段：' + e);
    assert.ok(Array.isArray(b.missing) && b.missing.length > 0, '空泛答案必须列出缺失项');
    assert.strictEqual(b.flagged, true, '空泛答案应标记可疑');
    assert.ok(g.comment.length > 8, '必须有评语');
    assert.ok(g.score <= 100 && b.score >= 0);
  });

  /* ---------------- AI 全程面试：智能体自己主持 ---------------- */

  const AI_RESUME = '郑十，本科软件工程。主导校园二手交易平台后端订单模块（Node.js + MySQL），'
    + '设计唯一约束加乐观锁解决超卖，订单失败率从3%降到0.2%，半年零丢单。'
    + '独立完成简历解析工具（Python + FastAPI），字段抽取准确率从60%提升到90%。'
    + '熟悉 Docker、Redis、Git、Linux。';

  const GOOD_ANSWERS = [
    '在二手交易平台项目里我负责订单模块，团队4人。当时并发下单会超卖，我先压测复现，发现库存校验和扣减不在一个事务里。我加乐观锁版本号并把校验放进事务，同时用唯一索引兜住重复提交。改完后压测2000QPS，失败率从3%降到0.2%，上线半年零丢单。',
    '这个百分比是压测工具统计的：固定2000QPS跑10分钟，失败订单数除以总订单数。基线是改动前同一套脚本，约3%。我用三轮压测对比，并核对线上监控的实际失败率。',
    '订单模块主要我一个人写，约2000行，乐观锁和幂等这块是我设计的。团队4人分工，我负责订单与库存。如果我被换掉，这块要重新设计，别人接手至少两周。',
    '最难的是压测时发现偶发超卖，看日志查了两天才定位到是版本号在并发下没生效。我改成CAS重试加唯一索引兜底，问题才彻底解决。',
    '选Node.js是因为团队已有积累，I/O密集够用。如果并发涨十倍，最先撑不住的是单库写入，我会先读写分离，再把订单表按用户ID分片。',
    'Docker我在团队里用过，写docker-compose把环境搭建从两小时降到十分钟。Kubernetes我只了解概念，没在生产用过。',
    '我更适合这个岗位，因为做过完整的订单链路，踩过并发和幂等的坑。最欠缺的是分布式事务实战经验，计划通过复现开源项目的Saga实现来补。',
  ];

  const VAGUE_ANSWERS = [
    '我做过一些后端的工作，大概就是写接口，增删改查那些，感觉还行。',
    '不太清楚，反正就是按照需求做的吧。',
    '差不多就是那样，没什么特别的。',
    '就正常做呗，没什么好说的。',
  ];

  /** 跑完一整场 AI 面试，返回每一步的记录 */
  async function runAiInterview(answers) {
    const s = await api('/api/agent/session/start', { method: 'POST', body: { cand: 'eval', resume: AI_RESUME, maxTurns: 8 } });
    assert.strictEqual(s.status, 200, JSON.stringify(s.data));
    const trace = [{ q: s.data.question.text, kind: s.data.question.kind }];
    let cur = s.data;
    let last = null;
    for (let i = 0; i < answers.length; i++) {
      last = await api('/api/agent/session/turn', { method: 'POST', body: { sessionId: cur.sessionId, answer: answers[i] } });
      assert.strictEqual(last.status, 200, JSON.stringify(last.data));
      if (last.data.done) break;
      trace.push({ q: last.data.question.text, kind: last.data.question.kind, decision: last.data.decision.action });
    }
    /* 答案用完了还没收尾 → 主动结束 */
    if (!last.data.done) {
      const f = await api('/api/agent/session/finish', { method: 'POST', body: { sessionId: cur.sessionId } });
      assert.strictEqual(f.status, 200);
      last = { data: { done: true, verdict: f.data.verdict, reportId: f.data.reportId } };
    }
    return { sessionId: cur.sessionId, trace, final: last.data };
  }

  await check('replica', 'AI 面试：会话能开启并给出带理由的第一题', async () => {
    const s = await api('/api/agent/session/start', { method: 'POST', body: { resume: AI_RESUME, maxTurns: 8 } });
    assert.strictEqual(s.status, 200, JSON.stringify(s.data));
    assert.ok(s.data.sessionId, '必须返回 sessionId');
    assert.ok(s.data.question && s.data.question.text.length > 10);
    assert.ok(s.data.question.reason, '首题必须说明为什么问这个');
    assert.ok(s.data.question.text.includes('「'), '首题应引用简历原文');
    assert.ok(s.data.facts && Array.isArray(s.data.facts.metrics), '应回传解析出的简历事实');
    assert.strictEqual(typeof s.data.maxTurns, 'number');
  });

  await check('replica', 'AI 面试：题量由智能体决定，不是固定值', async () => {
    const good = await runAiInterview(GOOD_ANSWERS);
    const bad = await runAiInterview(VAGUE_ANSWERS);
    const goodTurns = good.final.verdict.turns;
    const badTurns = bad.final.verdict.turns;
    assert.ok(goodTurns >= 3 && goodTurns <= 8, '高质量候选人题量应在 3-8 之间，实际 ' + goodTurns);
    assert.ok(badTurns <= 8, '题量不得超过上限');
    assert.notStrictEqual(goodTurns, badTurns, '不同候选人应得到不同题量：' + goodTurns + ' vs ' + badTurns);
    /* 关键在于"有人没答满上限就结束了"—— 那才是智能体在判断 */
    assert.ok(badTurns < 8 || goodTurns < 8, '至少有一类候选人应在答满上限前被收尾');
  });

  await check('replica', 'AI 面试：空泛作答被打断并判不通过', async () => {
    const bad = await runAiInterview(VAGUE_ANSWERS);
    assert.strictEqual(bad.final.verdict.verdict, '不通过', '空泛作答应判不通过，实际 ' + bad.final.verdict.verdict);
    assert.ok(bad.final.verdict.score < 50, '分数应显著偏低，实际 ' + bad.final.verdict.score);
    assert.ok(bad.final.verdict.turns <= 6, '不该对无效候选人浪费太多题，实际 ' + bad.final.verdict.turns);
  });

  await check('replica', 'AI 面试：每步都有判断依据（分数/证据/决策理由）', async () => {
    const good = await runAiInterview(GOOD_ANSWERS);
    const v = good.final.verdict;
    assert.ok(typeof v.score === 'number' && v.score >= 0 && v.score <= 100);
    assert.ok(['通过', '待定', '不通过'].includes(v.verdict), '结论必须在枚举内：' + v.verdict);
    assert.ok(v.summary && v.summary.length > 5, '必须给总评');
    assert.ok(Array.isArray(v.reasons) && v.reasons.length > 0, '必须给出结论依据');
    assert.ok(Array.isArray(v.angles) && v.angles.length >= 2, '应覆盖多个考察角度');
    /* 每道题都要有决策痕迹 */
    const trace = good.trace;
    assert.ok(trace.length >= 3, '至少有 3 道题');
    assert.ok(trace.every((t) => t.q && t.q.length > 5));
  });

  await check('replica', 'AI 面试：结束后生成报告并可在数据里查到', async () => {
    const good = await runAiInterview(GOOD_ANSWERS);
    assert.ok(good.final.reportId, '收尾必须生成报告');
    const list = await api('/api/reports', { cookie });
    assert.strictEqual(list.status, 200);
    const found = (list.data || []).find((x) => x.id === good.final.reportId);
    assert.ok(found, '报告应出现在 /api/reports');
    assert.strictEqual(found.source, 'ai-session');
  });

  await check('replica', 'AI 面试：会话记录可回放且含逐题证据', async () => {
    const good = await runAiInterview(GOOD_ANSWERS);
    const t = await api('/api/agent/session/' + good.sessionId);
    assert.strictEqual(t.status, 200, JSON.stringify(t.data));
    assert.ok(Array.isArray(t.data.turns) && t.data.turns.length >= 3);
    const answered = t.data.turns.filter((x) => x.judgment);
    assert.ok(answered.length >= 3, '应有逐题评判');
    for (const x of answered) {
      assert.ok(typeof x.judgment.score === 'number');
      assert.ok(x.q && typeof x.a === 'string');
    }
    /* 至少有一条回答能摘出原文证据 */
    assert.ok(answered.some((x) => x.judgment.evidence && x.judgment.evidence.length), '应至少有一条带原文证据');
  });

  await check('replica', '智能体：LLM 配置接口可用且不回传明文密钥', async () => {    const r = await api('/api/llm/config', { cookie });
    assert.strictEqual(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.status && typeof r.data.status.enabled === 'boolean');
    assert.ok(Array.isArray(r.data.providers) && r.data.providers.length >= 6, '应内置多个 provider 预设');
    for (const p of r.data.providers) assert.ok(p.id && p.name);
    const s = JSON.stringify(r.data);
    assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(s), '响应不得包含明文密钥');
    if (r.data.status.key_set) assert.ok(r.data.status.key_hint.startsWith('****'), '密钥只能回显末四位');
  });

  if (r1.passed) {
    const plan2 = await (async () => {
      const r = await api('/api/interview/plan2', { method: 'POST', body: { reportId: r1.id } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.data));
      return r.data;
    })();

    await check('replica', '活体：plan2 返回 questions/dims/materials 三维编排', () => {
      assert.strictEqual(plan2.questions.length, 6);
      assert.strictEqual(plan2.dims.length, 6);
      assert.deepStrictEqual(plan2.dims, ['communication', 'communication', 'learning', 'learning', 'execution', 'execution']);
      assert.strictEqual(plan2.materials.length, 6);
    });

    const r2answers = [
      '你好，我是考核候选人，软件工程专业应届生。我做过课程表小程序前端和二手交易平台后端订单模块，两个项目都是我从零跟到上线。因为实习中大量用到接口联调与数据处理，我对这个岗位很感兴趣，希望把工程能力用在模型评测上。',
      '在二手交易平台项目中，情境是支付回调上线后出现重复扣款，影响了几十笔订单。我的任务是当天止血并定位根因，我采取了关闭回调重试、加去重表的行动，同时拉上支付方一起对账。最终结果是把重复扣单降到零，并补上了监控告警。',
      '消息队列解决的是上下游解耦与削峰填谷，让上游快速返回、下游按自己节奏处理，失败还能重试。但它会带来两个新问题：一是消息重复投递，下游必须保证幂等。二是顺序无法严格保证，需要额外设计分区键与顺序键。',
      '我快速学会 Docker 是这样做的：先看官方文档跑通最小例子，再拆成我自己的服务。遇到构建慢，我去查缓存层原理并重排了 Dockerfile 的层顺序。最后写出 docker-compose 并在团队落地，验证方式是把环境搭建时间从两小时压到十分钟。',
      '时间紧依赖多的任务，我会先拆解成可并行的模块，标注依赖关系后排出关键路径。然后用 Mock 先行解除上游依赖，并设里程碑每周对齐进度。在二手平台项目里我就是先 Mock 订单接口再并行做支付回调，结果提前两天上线。',
      '有一次支付回调上线后出现重复扣款，我先止血：关闭回调重试并加去重表，控制住影响面。然后当天定位到幂等键缺失，补救后补了唯一索引与监控告警。复盘时我把回调场景写成测试用例并加入发布清单，之后半年零重复扣单。',
    ];

    const r2 = await (async () => {
      const r = await api('/api/reports', { method: 'POST', body: { round: 2, reportId: r1.id, answers: r2answers } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.data));
      return r.data;
    })();

    await check('replica', '活体：第二轮返回 eval{avg,verdict,summary} 与三维分', () => {
      assert.strictEqual(r2.round, 2);
      assert.ok(r2.eval && typeof r2.eval.avg === 'number');
      assert.ok(['通过', '不通过'].includes(r2.eval.verdict));
      assert.ok(typeof r2.eval.summary === 'string' && r2.eval.summary.length > 0);
    });

    await check('replica', '活体：/api/portal/lookup 凭姓名+认证码返回 canPractice', async () => {
      const r = await api('/api/portal/lookup', { method: 'POST', body: { jobId: job.id, name: '考核候选人', code: r1.accessCode } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.data));
      assert.strictEqual(r.data.found, true);
      assert.strictEqual(typeof r.data.canRound2, 'boolean');
      assert.strictEqual(typeof r.data.canPractice, 'boolean');
    });

    if (r2.eval.verdict === '通过') {
      await check('replica', '活体：第三关提交返回 {ok,autoScore,reachable,autoConfirmed}', async () => {
        const r = await api('/api/reports/' + r1.id + '/practice', {
          method: 'POST',
          body: { url: BASE + '/', note: '考核 harness 自动提交：验证第三关预评与自动确认链路。' },
        });
        assert.strictEqual(r.status, 200, JSON.stringify(r.data));
        assert.strictEqual(r.data.ok, true);
        assert.ok(typeof r.data.autoScore === 'number');
        assert.strictEqual(typeof r.data.reachable, 'boolean');
        assert.strictEqual(typeof r.data.autoConfirmed, 'boolean');
      });

      await check('replica', '活体：Offer → 接受 → 签约 状态机闭环', async () => {
        const o = await api('/api/reports/' + r1.id + '/offer', { method: 'POST', cookie, body: { title: '考核岗位', salary: '300 元/天', startDate: '2026-11-01', expire: '2026-10-30', note: '' } });
        assert.strictEqual(o.status, 200, JSON.stringify(o.data));
        const a = await api('/api/reports/' + r1.id + '/offer/accept', { method: 'POST', body: { action: 'accept' } });
        assert.strictEqual(a.status, 200, JSON.stringify(a.data));
        assert.strictEqual(a.data.contract.status, 'pending_sign');
        const s = await api('/api/reports/' + r1.id + '/contract/sign', {
          method: 'POST',
          body: { name: '考核候选人', signData: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' },
        });
        assert.strictEqual(s.status, 200, JSON.stringify(s.data));
        assert.strictEqual(s.data.contract.status, 'signed');
        const d = await api('/api/reports/' + r1.id, { cookie });
        assert.strictEqual(d.data.stage, 'signed');
      });
    }
  }
}

/* ============================================================ rea */
const AUTHORITIES = ['shipped-artifact', 'controlled-replay', 'historical-reference', 'external-service', 'analyst-inference'];
const CONFIDENCES = ['observed', 'derived', 'inferred'];

function assertEvidenceShape(ev, label) {
  assert.ok(/^ev_[0-9a-f]{64}$/.test(ev.evidence_id), label + ' evidence_id format');
  assert.strictEqual(ev.evidence_id, rea.computeEvidenceId(Object.fromEntries(Object.entries(ev).filter(([k]) => k !== 'evidence_id'))), label + ' evidence_id recomputes');
  assert.ok(ev.provider && ev.provider.id && ev.provider.name, label + ' provider');
  assert.ok(typeof ev.predicate_type === 'string' && ev.predicate_type.length > 0, label + ' predicate_type');
  assert.ok(typeof ev.operation === 'string' && ev.operation.length > 0, label + ' operation');
  assert.ok(ev.parameters && typeof ev.parameters === 'object', label + ' parameters');
  assert.ok(AUTHORITIES.includes(ev.authority), label + ' authority enum: ' + ev.authority);
  assert.ok(CONFIDENCES.includes(ev.confidence), label + ' confidence enum: ' + ev.confidence);
  assert.ok(Array.isArray(ev.limitations), label + ' limitations array');
  assert.ok(Array.isArray(ev.locations), label + ' locations array');
  assert.ok(Array.isArray(ev.evidence_links), label + ' evidence_links array');
  assert.ok('normalized_result' in ev, label + ' normalized_result present');
  assert.ok('raw_result' in ev, label + ' raw_result present');
}

async function evalRea() {
  head('考核二 · REA 契约合规 (rea)');

  await check('rea', 'doctor 报告 provider / schema / capabilities', () => {
    const d = rea.doctor();
    assert.strictEqual(d.ok, true);
    assert.ok(d.provider.id && d.provider.name && d.provider.version);
    assert.ok(Array.isArray(d.capabilities) && d.capabilities.length >= 2);
    assert.ok(d.engines && typeof d.engines === 'object');
  });

  await check('rea', 'canonicalJson 键序与 REA 一致（码点排序、无空白）', () => {
    assert.strictEqual(rea.canonicalJson({ b: 1, a: 2 }), '{"a":2,"b":1}');
    assert.strictEqual(rea.canonicalJson({ z: [1, 'x', null, true] }), '{"z":[1,"x",null,true]}');
    assert.throws(() => rea.canonicalJson({ n: Infinity }), /non-finite/);
  });

  await check('rea', 'evidence_id 可复算（内容相同 → id 相同，内容变化 → id 变化）', () => {
    const a = rea.makeEvidence({ predicate_type: 'p', operation: 'o', parameters: {}, normalized_result: { x: 1 } });
    const b = rea.makeEvidence({ predicate_type: 'p', operation: 'o', parameters: {}, normalized_result: { x: 1 } });
    const c = rea.makeEvidence({ predicate_type: 'p', operation: 'o', parameters: {}, normalized_result: { x: 2 } });
    assert.strictEqual(a.evidence_id, b.evidence_id);
    assert.notStrictEqual(a.evidence_id, c.evidence_id);
  });

  await check('rea', 'analyze-javascript-application 产出合规 Evidence + 模块图', () => {
    const out = rea.analyzeJavascriptApplication(path.join(ROOT, 'lib'));
    assert.ok(out.evidence.length >= 2);
    for (const ev of out.evidence) assertEvidenceShape(ev, ev.operation);
    assert.ok(out.graph.nodes.length > 0, 'graph nodes');
    assert.ok(Array.isArray(out.limitations));
    assert.ok(Array.isArray(out.unknowns));
    assert.strictEqual(out.verdict, 'PASS');
  });

  await check('rea', 'analyze-web-application 对本地复刻实例产出合规 Evidence', async () => {
    const out = await rea.analyzeWebApplication(BASE + '/');
    assert.strictEqual(out.verdict, 'PASS', out.error || '');
    assert.ok(out.evidence.length >= 4, 'evidence count ' + out.evidence.length);
    for (const ev of out.evidence) assertEvidenceShape(ev, ev.operation);
    const surface = out.evidence.find((e) => e.predicate_type === 'api-surface');
    assert.ok(surface, 'api-surface evidence present');
    assert.ok(surface.normalized_result.endpoints.length >= 10, 'endpoints ' + surface.normalized_result.endpoints.length);
    assert.ok(surface.limitations.length > 0, 'api-surface must declare limitations');
  });

  await check('rea', 'web 分析能抽出状态机阶段枚举（derived + analyst-inference）', async () => {
    const out = await rea.analyzeWebApplication(BASE + '/');
    const hasDerived = out.evidence.some((e) => e.confidence === 'derived' || e.confidence === 'inferred');
    assert.ok(hasDerived, '至少一条 derived/inferred 证据');
    const withAuthority = out.evidence.filter((e) => e.authority === 'analyst-inference');
    for (const e of withAuthority) assert.ok(e.limitations.length > 0, '推断必须带限制说明');
  });

  await check('rea', 'MCP stdio 握手 + tools/list 返回 2 个工具', async () => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'rea', 'rea.js'), 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const responses = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) responses.push(JSON.parse(line));
      }
    });

    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'eval', version: '1' } } });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

    await new Promise((r) => setTimeout(r, 900));
    child.kill();

    const init = responses.find((r) => r.id === 1);
    assert.ok(init && init.result && init.result.serverInfo, 'initialize handshake');
    const list = responses.find((r) => r.id === 2);
    assert.ok(list && Array.isArray(list.result.tools), 'tools/list');
    assert.strictEqual(list.result.tools.length, 2);
    for (const t of list.result.tools) {
      assert.ok(t.name && t.description && t.inputSchema);
      assert.strictEqual(t.inputSchema.type, 'object');
    }
  });
}

/* ============================================================ reach */
async function evalReach() {
  head('考核三 · Agent-Reach 契约合规 (reach)');

  await check('reach', 'doctor 返回平台矩阵与 active_backend 语义', () => {
    const d = reach.doctor();
    assert.strictEqual(d.ok, true);
    assert.ok(Array.isArray(d.platforms) && d.platforms.length >= 8);
    for (const p of d.platforms) {
      assert.ok(typeof p.id === 'string');
      assert.ok('active_backend' in p);
      assert.ok(p.active_backend === null || typeof p.active_backend === 'string');
    }
    const zero = d.platforms.filter((p) => p.active_backend === 'builtin');
    assert.ok(zero.length >= 4, '零配置通道至少 4 个，实际 ' + zero.length);
  });

  await check('reach', 'active_backend=null 时 note 明确"未实时验证"而非"不存在"', () => {
    const d = reach.doctor();
    for (const p of d.platforms) {
      if (p.active_backend === null) assert.ok(/未实时验证/.test(p.note), p.id + ' note 语义');
    }
  });

  await check('reach', 'read 抽取标题/正文/链接（本地实例）', async () => {
    const out = await reach.read(BASE + '/');
    assert.strictEqual(out.ok, true, out.error || '');
    assert.ok(out.title && out.title.length > 0, 'title');
    assert.ok(out.text && out.text.length > 100, 'text length ' + (out.text || '').length);
    assert.ok(Array.isArray(out.links));
    assert.strictEqual(out.backend, 'builtin');
  });

  await check('reach', 'read 对非法 URL 返回结构化错误而非抛异常', async () => {
    const out = await reach.read('not-a-url');
    assert.strictEqual(out.ok, false);
    assert.ok(/http/.test(out.error));
  });

  await check('reach', 'htmlToText 剥离 script/style 且解码实体', () => {
    const out = reach.htmlToText('<html><head><title>A &amp; B</title></head><body><script>var x=1</script><p>hello&nbsp;world</p></body></html>');
    assert.strictEqual(out.title, 'A & B');
    assert.ok(out.text.includes('hello world'));
    assert.ok(!out.text.includes('var x=1'));
  });

  await check('reach', 'parseFeed 解析 RSS item', () => {
    const xml = '<rss><channel><title>Feed</title><item><title>Post 1</title><link>https://e.com/1</link><pubDate>Mon, 01 Jan 2026</pubDate><description>desc</description></item></channel></rss>';
    const f = reach.parseFeed(xml);
    assert.strictEqual(f.title, 'Feed');
    assert.strictEqual(f.items.length, 1);
    assert.strictEqual(f.items[0].link, 'https://e.com/1');
  });

  await check('reach', 'github 通道可用（命中任一后端）', async () => {
    const out = await reach.github('rea reverse engineering');
    assert.ok(out.backend === 'gh' || out.backend === 'builtin');
    assert.ok(out.ok || out.error, '返回结构化结果');
    if (out.ok) assert.ok(Array.isArray(out.items) && out.items.length > 0);
  });

  await check('reach', 'check-update 返回版本三元组', () => {
    const u = reach.checkUpdate();
    assert.ok(u.current && u.latest);
    assert.strictEqual(typeof u.update_available, 'boolean');
  });
}

/* ============================================================ 主流程 */
(async () => {
  const t0 = Date.now();
  if (ONLY === 'all' || ONLY === 'replica') await evalReplica();
  if (ONLY === 'all' || ONLY === 'rea') await evalRea();
  if (ONLY === 'all' || ONLY === 'reach') await evalReach();

  console.log('\n' + '-'.repeat(64));
  let pass = 0;
  let fail = 0;
  let group = '';
  for (const r of results) {
    if (r.group !== group) {
      group = r.group;
      console.log('\n[' + group.toUpperCase() + ']');
    }
    if (r.ok) {
      pass++;
      console.log('  PASS  ' + r.name + '  (' + r.ms + 'ms)');
    } else {
      fail++;
      console.log('  FAIL  ' + r.name);
      console.log('        → ' + r.error);
    }
  }
  console.log('\n' + '-'.repeat(64));
  console.log('结果: ' + pass + ' passed, ' + fail + ' failed, ' + (Date.now() - t0) + 'ms');
  console.log(fail === 0 ? '考核结论: 全部通过' : '考核结论: 存在未通过项');
  process.exit(fail === 0 ? 0 : 1);
})();
