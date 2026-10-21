/**
 * AI 全程面试验证：智能体是否自己决定问什么、追什么、何时收尾。
 * 三个候选人：
 *   甲 高质量（应该 4-5 题就收尾，判通过）
 *   乙 空泛（应该追问、然后提前收尾，判不通过）
 *   丙 混合（应该问到接近上限）
 */
const BASE = 'http://127.0.0.1:3000';
const post = async (p, b) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  const t = await r.text();
  try { return { status: r.status, data: JSON.parse(t) }; } catch (_) { return { status: r.status, data: t }; }
};

const RESUME = '周八，本科软件工程。主导校园二手交易平台后端订单模块（Node.js + MySQL），'
  + '设计唯一约束加乐观锁解决超卖，订单失败率从3%降到0.2%，半年零丢单。'
  + '独立完成简历解析工具（Python + FastAPI），字段抽取准确率从60%提升到90%，用1000份样本评测过。'
  + '熟悉 Docker、Redis、Git、Linux。';

const GOOD = [
  '在二手交易平台项目里我负责订单模块，团队4人，我做订单和库存。当时并发下单会超卖，我先用压测复现，发现库存校验和扣减不在一个事务里。我加乐观锁版本号并把校验放进事务，同时用唯一索引兜住重复提交。改完后压测2000QPS，失败率从3%降到0.2%，上线半年零丢单。',
  '这个百分比是压测工具统计的：固定2000QPS跑10分钟，失败订单数除以总订单数。基线是改动前同一套脚本，约3%。验证方式是对比三轮压测，并核对线上监控的实际失败率。',
  '订单模块主要我一个人写，约2000行，乐观锁和幂等这块是我设计的。如果我被换掉，这部分要重新设计，别人接手至少两周。',
  '选Node.js是因为团队已有积累，I/O密集够用。并发涨十倍最先撑不住的是单库写入，我会先读写分离，再把订单表按用户ID分片。',
  'Docker我在团队里用过，写docker-compose把环境搭建从两小时降到十分钟。Kubernetes我只了解概念，没在生产用过。',
];

const VAGUE = [
  '我做过一些后端的工作，大概就是写接口，增删改查那些，感觉还行。',
  '不太清楚，反正就是按照需求做的吧。',
  '差不多就是那样，没什么特别的。',
];

const MIXED = [
  GOOD[0],
  '这个我没具体统计过，大概是感觉快了一些。',
  GOOD[2],
  '团队协作还行吧，大家都挺配合的。',
  'Docker用过一点，具体记不清了。',
];

async function run(label, answers) {
  const s = await post('/api/agent/session/start', { cand: label, resume: RESUME, maxTurns: 8 });
  if (s.status !== 200) { console.log('启动失败 ' + JSON.stringify(s.data)); return null; }
  console.log('\n===== ' + label + ' =====');
  console.log('Q1 [' + s.data.question.kind + '] ' + s.data.question.text);
  console.log('     ↳ ' + s.data.question.reason);

  let sid = s.data.sessionId;
  let out = null;
  let i = 0;
  while (i < answers.length) {
    out = await post('/api/agent/session/turn', { sessionId: sid, answer: answers[i] });
    if (out.status !== 200) { console.log('  turn 失败 ' + JSON.stringify(out.data)); break; }
    const j = out.data.judgment;
    console.log('A' + (i + 1) + ' → ' + j.score + '分 ' + (j.flagged ? '[可疑]' : '') + ' | 决策: ' + out.data.decision.action + ' — ' + out.data.decision.reason);
    if (out.data.done) { console.log('  ▸ 智能体收尾'); break; }
    console.log('Q' + (i + 2) + ' [' + out.data.question.kind + '] ' + out.data.question.text);
    console.log('     ↳ ' + out.data.question.reason);
    i++;
  }

  if (out && !out.data.done) {
    const f = await post('/api/agent/session/finish', { sessionId: sid });
    out = { data: { done: true, verdict: f.data.verdict, reportId: f.data.reportId } };
    console.log('  ▸ 候选人答完，主动收尾');
  }

  const v = out.data.verdict;
  console.log('--- 结论: ' + v.verdict + ' | ' + v.score + ' 分 | ' + v.turns + ' 题 | 追问 ' + v.probes + ' 次 ---');
  console.log('    ' + v.reasons.join('；'));
  return { label, verdict: v.verdict, score: v.score, turns: v.turns, probes: v.probes, reportId: out.data.reportId };
}

(async () => {
  const a = await run('甲·高质量', GOOD);
  const b = await run('乙·空泛', VAGUE);
  const c = await run('丙·混合', MIXED);

  console.log('\n===== 判定 =====');
  const turns = [a, b, c].filter(Boolean).map((x) => x.turns);
  console.log('  题量随人变化？      ' + (new Set(turns).size > 1 ? '是 ✔' : '否 ✘') + '（' + turns.join(' / ') + '）');
  console.log('  都不是固定 8 题？    ' + (turns.every((t) => t < 8) ? '是 ✔' : '否 ✘'));
  console.log('  空泛者被提前收尾？   ' + (b && b.turns <= 3 ? '是 ✔ ' + b.turns + ' 题' : '否 ✘'));
  console.log('  甲判通过？          ' + (a ? (a.verdict === '通过' ? '是 ✔' : '否 ✘ ' + a.verdict + ' ' + a.score) : '?'));
  console.log('  乙判不通过？        ' + (b ? (b.verdict === '不通过' ? '是 ✔' : '否 ✘ ' + b.verdict) : '?'));
  console.log('  报告已生成？        ' + (a && a.reportId ? '是 ✔ ' + a.reportId : '否 ✘'));
})();
