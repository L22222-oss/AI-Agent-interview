/**
 * 自适应验证：同一份简历，两种回答，看第二题是否不同。
 * 还要验证：追问是否引用了上一题原话。
 */
const BASE = 'http://127.0.0.1:3000';

async function post(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const t = await r.text();
  try { return { status: r.status, data: JSON.parse(t) }; } catch (_) { return { status: r.status, data: t }; }
}

const RESUME = `李维，本科软件工程。主导校园二手交易平台后端订单模块（Node.js + MySQL），
设计唯一约束加乐观锁解决超卖，订单失败率从3%降到0.2%，半年零丢单。
独立完成简历解析工具（Python + FastAPI），用JSON结构校验加三次退避重试，
字段抽取准确率从60%提升到90%，用1000份样本做过对比评测。
熟悉 Docker、Redis、Git、Linux、Kubernetes。`;

const ANSWER_VAGUE = '我做过一些后端相关的工作，主要负责写接口，大概就是增删改查那些，感觉还行，后来项目也就那样结束了。';

const ANSWER_DETAILED = `在二手交易平台项目里，我负责订单模块。当时的问题是并发下单会超卖，我先压测复现，
发现是库存校验和扣减不在一个事务里。我的做法是给库存字段加乐观锁版本号，
并把校验放进事务，同时用唯一索引兜住重复提交。改完之后压测 2000 QPS，
失败率从 3% 降到 0.2%，上线后半年零丢单。`;

(async () => {
  /* 用演示账号建岗位 */
  const login = await post('/api/auth/login', { account: 'admin', password: 'demo1234' });
  if (login.status !== 200) { console.error('登录失败', login); process.exit(1); }
  const cookie = login.data ? 'iv_session=' + (login.data.sid || '') : '';

  const reg = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: 'demo1234' }),
  });
  const setCookie = (reg.headers.get('set-cookie') || '').split(';')[0];

  const job = await fetch(BASE + '/api/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: setCookie },
    body: JSON.stringify({ name: '后端实习生', round1Count: 6, round2Count: 6 }),
  }).then((r) => r.json());

  console.log('=== 岗位 ===');
  console.log('  ' + job.id + ' ' + job.name);

  /* 同一简历，两条会话 */
  async function run(label, answer1) {
    const plan = await post('/api/interview/plan', { jobId: job.id, cand: label, resume: RESUME });
    if (plan.status !== 200) { console.error('出题失败', plan); return null; }
    const qs = plan.data.questions.slice();
    console.log('\n=== ' + label + ' ===');
    console.log('  简历解析: ' + JSON.stringify(plan.data.agent.facts));
    console.log('  Q1: ' + qs[0]);

    /* 用 Q1 的回答去要 Q2 */
    const q2 = await post('/api/agent/next-question', {
      round: 1, planId: plan.data.planId, idx: 1,
      jobName: job.name, resume: RESUME, questions: qs, answers: [answer1],
    });
    console.log('  A1: ' + answer1.slice(0, 40) + '…');
    console.log('  Q2: ' + q2.data.text);
    console.log('  kind=' + q2.data.kind + '  basis=' + q2.data.basis);

    /* 再问一题，看第三题 */
    const q3 = await post('/api/agent/next-question', {
      round: 1, planId: plan.data.planId, idx: 2,
      jobName: job.name, resume: RESUME, questions: qs, answers: [answer1, '（第二题回答略）'],
    });
    console.log('  Q3: ' + q3.data.text);
    console.log('  kind=' + q3.data.kind);

    return { planId: plan.data.planId, q1: qs[0], q2: q2.data.text, q3: q3.data.text };
  }

  const a = await run('甲·空泛作答', ANSWER_VAGUE);
  const b = await run('乙·具体作答', ANSWER_DETAILED);

  console.log('\n=== 判定 ===');
  if (!a || !b) { console.log('  流程失败'); process.exit(1); }
  console.log('  Q1 相同？      ' + (a.q1 === b.q1 ? '是（同一份简历，应该相同）' : '否'));
  console.log('  Q2 不同？      ' + (a.q2 !== b.q2 ? '是 ✔ 说明随答案变化' : '否 ✘ 还是死题'));
  console.log('  甲 Q2 是追问？ ' + (/追问|你提到|这个说法|听起来|展开|补一下/.test(a.q2) ? '是' : '否'));
  console.log('  乙 Q3 是追问？ ' + (/追问|你提到|这个说法|听起来|展开|补一下/.test(b.q3) ? '是' : '否'));

  /* 评判验证 */
  console.log('\n=== 自主评判 ===');
  const j = await post('/api/agent/eval-round2', {
    questions: ['请介绍你做过的一个后端项目，说明你的角色和结果。'],
    answers: [ANSWER_VAGUE],
    dims: ['communication'],
    resume: RESUME,
  });
  console.log('  空泛作答 → score=' + j.data[0].score + ' flagged=' + j.data[0].flagged);
  console.log('    评语: ' + j.data[0].comment);
  console.log('    缺失: ' + JSON.stringify(j.data[0].missing));
  console.log('    rubric: ' + j.data[0].rubric.map((r) => r.name + (r.hit ? '✔' : '✘')).join(' '));

  const j2 = await post('/api/agent/eval-round2', {
    questions: ['请介绍你做过的一个后端项目，说明你的角色和结果。'],
    answers: [ANSWER_DETAILED],
    dims: ['communication'],
    resume: RESUME,
  });
  console.log('  具体作答 → score=' + j2.data[0].score + ' flagged=' + j2.data[0].flagged);
  console.log('    评语: ' + j2.data[0].comment);
  console.log('    证据: ' + JSON.stringify(j2.data[0].evidence));
})();
