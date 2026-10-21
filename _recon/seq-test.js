/** 完整 6 题连答：确认意图推进、无重复、追问有据 */
const BASE = 'http://127.0.0.1:3000';
const post = async (p, body) => {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  try { return JSON.parse(t); } catch (_) { return t; }
};

const RESUME = `王小明，本科计算机。主导校园二手交易平台后端订单模块（Node.js + MySQL），
设计唯一约束加乐观锁解决超卖，订单失败率从3%降到0.2%，半年零丢单。
独立完成简历解析工具（Python + FastAPI），用JSON结构校验加三次退避重试，
字段抽取准确率从60%提升到90%，用1000份样本做过对比评测。
熟悉 Docker、Redis、Git、Linux、Kubernetes。`;

const ANSWERS = [
  '在二手交易平台项目里，我负责订单模块。当时的问题是并发下单会超卖，我先压测复现，发现库存校验和扣减不在一个事务里。我的做法是加乐观锁版本号并把校验放进事务，同时用唯一索引兜住重复提交。改完后压测 2000 QPS，失败率从 3% 降到 0.2%，上线后半年零丢单。',
  '这个百分比是我用压测工具统计的：固定 2000 QPS 跑 10 分钟，统计失败订单数除以总订单数。基线是改动前的同一套压测脚本，3% 左右。验证方式是对比三轮压测结果，并核对线上监控的实际失败率。',
  '订单模块主要是我一个人写的，大约 2000 行。团队一共 4 个人，我做订单与库存，另外两个同学做商品和支付，还有一个做前端。如果我被换掉，乐观锁和幂等这块要重新设计，别人接手至少要两周。',
  '技术选型上我选 Node.js 是因为团队已有积累，而且 I/O 密集场景够用。如果并发涨十倍，最先撑不住的是单库写入，我会先加读写分离和分库分表，把订单表按用户 ID 分片。',
  'Docker 我在团队里用过，把服务打成镜像并写 docker-compose，环境搭建时间从两小时降到十分钟。Kubernetes 我只了解概念，没在生产用过。',
  '我认为自己适合后端岗位，因为做过完整的订单链路，踩过并发和幂等的坑。最欠缺的是分布式事务的实战经验，我计划通过复现开源项目里的 Saga 实现来补。',
];

(async () => {
  const lr = await fetch(BASE + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: 'demo1234' }),
  });
  const cookie = (lr.headers.get('set-cookie') || '').split(';')[0];
  const job = await fetch(BASE + '/api/jobs', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ name: '后端实习生B', round1Count: 6, round2Count: 6 }),
  }).then((r) => r.json());

  const plan = await post('/api/interview/plan', { jobId: job.id, cand: '王小明', resume: RESUME });
  const qs = plan.questions.slice();
  const asks = [qs[0]];
  console.log('Q1 [' + 'resume' + '] ' + qs[0]);

  for (let i = 1; i < 6; i++) {
    const r = await post('/api/agent/next-question', {
      round: 1, planId: plan.planId, idx: i,
      jobName: job.name, resume: RESUME, questions: qs, answers: ANSWERS.slice(0, i),
    });
    qs[i] = r.text;
    asks.push(r.text);
    console.log('Q' + (i + 1) + ' [' + r.kind + '] ' + r.text);
    console.log('     ↳ ' + r.basis);
  }

  console.log('\n--- 检查 ---');
  const dup = asks.filter((t, i) => asks.indexOf(t) !== i);
  console.log('重复题目: ' + (dup.length ? dup.join(' | ') : '无 ✔'));
  console.log('题目数量: ' + asks.length);
  console.log('平均长度: ' + Math.round(asks.reduce((a, t) => a + t.length, 0) / asks.length) + ' 字');

  /* 提交，看评分与洞察 */
  const rep = await post('/api/reports', { planId: plan.planId, clientId: 'seq' + Date.now(), answers: ANSWERS });
  console.log('\n第一轮: logic=' + rep.r1.logic + ' accuracy=' + rep.r1.accuracy + ' ' + rep.r1.verdict);

  const judge = await fetch(BASE + '/api/reports/' + rep.id + '/judge', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.json());
  console.log('\n逐题评判:');
  judge.judgments.forEach((j, i) => {
    console.log('  Q' + (i + 1) + ' ' + j.score + ' 分 ' + (j.flagged ? '[可疑]' : '') + ' ' + j.comment.slice(0, 70));
  });
  console.log('\n整体洞察: ' + judge.insights.summary);
})();
