/** 接上 mock LLM，验证三条通道真的走模型：测试连接 / 出题 / 评判 */
const APP = 'http://127.0.0.1:3000';
const MOCK = 'http://127.0.0.1:8899';

const j = async (url, opts) => {
  const r = await fetch(url, opts);
  const t = await r.text();
  try { return { status: r.status, data: JSON.parse(t), headers: r.headers }; } catch (_) { return { status: r.status, data: t }; }
};

const RESUME = '王小明，本科计算机。主导校园二手交易平台后端订单模块（Node.js + MySQL），'
  + '设计唯一约束加乐观锁解决超卖，订单失败率从3%降到0.2%，半年零丢单。'
  + '独立完成简历解析工具（Python + FastAPI），字段抽取准确率从60%提升到90%。';

(async () => {
  const login = await j(APP + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: 'admin', password: 'demo1234' }),
  });
  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];
  const H = { 'Content-Type': 'application/json', Cookie: cookie };

  console.log('=== 1. 配置指向 mock ===');
  const cfg = await j(APP + '/api/llm/config', {
    method: 'PUT', headers: H,
    body: JSON.stringify({ provider: 'custom', baseUrl: MOCK + '/v1', model: 'mock-model', apiKey: 'sk-mock-1234567890abcdef' }),
  });
  console.log('  ' + JSON.stringify(cfg.data.status));

  console.log('\n=== 2. 测试连接 ===');
  const t = await j(APP + '/api/llm/test', { method: 'POST', headers: H, body: '{}' });
  console.log('  ok=' + t.data.ok + ' latency=' + t.data.latency_ms + 'ms reply=' + JSON.stringify(t.data.reply));

  console.log('\n=== 3. 健康检查反映已接入 ===');
  const h = await j(APP + '/api/health');
  console.log('  ' + JSON.stringify(h.data.llm) + ' agent=' + JSON.stringify(h.data.agent));

  console.log('\n=== 4. 出题走模型 ===');
  const jobs = await j(APP + '/api/jobs', { headers: { Cookie: cookie } });
  const job = (jobs.data || []).find((x) => x.name === '后端实习生B') || jobs.data[0];
  const plan = await j(APP + '/api/interview/plan', {
    method: 'POST', headers: H,
    body: JSON.stringify({ jobId: job.id, cand: '模型测试', resume: RESUME }),
  });
  console.log('  source=' + plan.data.questions && 'ok');
  console.log('  Q1: ' + plan.data.questions[0]);
  console.log('  agent.mode=' + (plan.data.agent ? plan.data.agent.mode : '?'));

  console.log('\n=== 5. 追问走模型 ===');
  const q2 = await j(APP + '/api/agent/next-question', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      round: 1, planId: plan.data.planId, idx: 1, jobName: job.name, resume: RESUME,
      questions: plan.data.questions,
      answers: ['我负责订单模块，用乐观锁解决了超卖问题，效果还不错。'],
    }),
  });
  console.log('  Q2: ' + q2.data.text);
  console.log('  kind=' + q2.data.kind + ' source=' + q2.data.source);

  console.log('\n=== 6. 评判走模型 ===');
  const ev = await j(APP + '/api/agent/eval-round2', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      questions: ['讲讲你的订单模块'],
      answers: ['我负责订单模块，加乐观锁解决超卖，失败率从3%降到0.2%。'],
      dims: ['execution'], resume: RESUME,
    }),
  });
  console.log('  score=' + ev.data[0].score + ' source=' + ev.data[0].source);
  console.log('  comment=' + ev.data[0].comment);
  console.log('  evidence=' + JSON.stringify(ev.data[0].evidence));

  console.log('\n=== 7. mock 实际收到的调用 ===');
  const stats = await j(MOCK + '/__stats');
  console.log('  calls=' + stats.data.calls);
  const last = stats.data.seen[stats.data.seen.length - 1];
  console.log('  最后一次 system 开头: ' + String(last.sys || '').slice(0, 60).replace(/\n/g, ' '));
  console.log('  提示词含简历原文? ' + (String(last.usr || '').includes('乐观锁') ? '是 ✔' : '否'));
  console.log('  提示词含上一题回答? ' + (String(last.usr || '').includes('乐观锁解决超卖') ? '是 ✔' : '否'));

  /* 还原成"未接入"，避免污染默认状态 */
  await j(APP + '/api/llm/config', {
    method: 'PUT', headers: H,
    body: JSON.stringify({ provider: 'custom', baseUrl: '', model: '', apiKey: '' }),
  });
  console.log('\n（已还原为空配置）');
})();
