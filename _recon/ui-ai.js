/** 浏览器验收：AI 全程面试 —— 切换模式、逐轮作答、智能体自主收尾 */
const { spawn } = require('child_process');
const path = require('path');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:3000/';
const PORT = 9347;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) this.events.push(m);
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 30000);
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { error: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    return { value: r.result.value };
  }
}

const ANSWERS = [
  '在二手交易平台项目里我负责订单模块，团队4人。当时并发下单会超卖，我先压测复现，发现库存校验和扣减不在一个事务里。我加乐观锁版本号并把校验放进事务，同时用唯一索引兜住重复提交。改完后压测2000QPS，失败率从3%降到0.2%，上线半年零丢单。',
  '这个百分比是压测工具统计的：固定2000QPS跑10分钟，失败订单数除以总订单数。基线是改动前同一套脚本，约3%。我用三轮压测对比，并核对线上监控的实际失败率。',
  '订单模块主要我一个人写，约2000行，乐观锁和幂等这块是我设计的。团队4人分工，我负责订单与库存。如果我被换掉，这块要重新设计，别人接手至少两周。',
  '最难的是压测时发现偶发超卖，看日志查了两天才定位到是版本号在并发下没生效。我改成CAS重试加唯一索引兜底，问题才彻底解决。',
  '选Node.js是因为团队已有积累，I/O密集够用。如果并发涨十倍，最先撑不住的是单库写入，我会先读写分离，再把订单表按用户ID分片。',
  'Docker我在团队里用过，写docker-compose把环境搭建从两小时降到十分钟。Kubernetes我只了解概念，没在生产用过。',
  '我更适合这个岗位，因为做过完整的订单链路，踩过并发和幂等的坑。最欠缺的是分布式事务实战经验，计划通过复现开源项目的Saga实现来补。',
  '补充一点：我还做过压测脚本的自动化，把每次改动后的回归压测从手工半天缩短到十分钟。',
];

(async () => {
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + path.join(__dirname, 'prof-ai'),
    '--window-size=1280,1100', 'about:blank'], { stdio: 'ignore' });
  try {
    let targets = null;
    for (let i = 0; i < 40; i++) {
      try { targets = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); if (targets && targets.length) break; } catch (_) {}
      await sleep(250);
    }
    const page = targets.find((t) => t.type === 'page') || targets[0];
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    const cdp = new CDP(ws);
    await cdp.send('Runtime.enable'); await cdp.send('Log.enable'); await cdp.send('Page.enable');

    /* 拿一个岗位 id（/api/jobs 需要登录，这里直接从服务端数据里挑一个已发布的） */
    const jobId = process.env.JOB_ID || 'j1792505027208';
    await cdp.send('Page.navigate', { url: BASE + '?job=' + jobId });
    await sleep(2200);

    console.log('=== 1. 选择 AI 全程面试 ===');
    /* 等候选人界面就绪 */
    for (let i = 0; i < 20; i++) {
      const ok = await cdp.eval(`!!document.querySelector('#modeHint') && !!document.querySelector('#candStart')`);
      if (ok.value) break;
      await sleep(400);
    }
    let r = await cdp.eval(`(function(){
      var segs=[].slice.call(document.querySelectorAll('.seg[data-mode]'));
      var seg=segs.filter(function(x){return x.dataset.mode==='ai';})[0];
      if(!seg) return JSON.stringify({found:false, segCount:segs.length, url:location.href});
      seg.click();
      return JSON.stringify({found:true, hint: document.querySelector('#modeHint').textContent});
    })()`);
    console.log('  ' + (r.value || r.error));

    console.log('\n=== 2. 填简历并开始 ===');
    await cdp.eval(`(function(){
      document.querySelector('#candName').value='AI模式候选人';
      document.querySelector('#candResume').value='吴九，本科软件工程。主导校园二手交易平台后端订单模块（Node.js + MySQL），设计唯一约束加乐观锁解决超卖，订单失败率从3%降到0.2%，半年零丢单。独立完成简历解析工具（Python + FastAPI），字段抽取准确率从60%提升到90%。熟悉 Docker、Redis、Git。';
      document.querySelector('#candStart').click(); return 1;
    })()`);
    await sleep(2800);
    r = await cdp.eval(`JSON.stringify({
      paneVisible: !document.querySelector('#aiPane').classList.contains('hide'),
      introHidden: document.querySelector('#candIntro').classList.contains('hide'),
      progress: document.querySelector('#aiProgress').textContent,
      firstQ: (document.querySelector('.turn .q')||{}).textContent,
      hasSend: !!document.querySelector('#aiSend')
    })`);
    console.log('  ' + (r.value || r.error));

    /* 逐轮作答，最多 8 轮 */
    for (let i = 0; i < ANSWERS.length; i++) {
      const st = await cdp.eval(`JSON.stringify({done: AI.done, turnVisible: !document.querySelector('#aiTurn').classList.contains('hide')})`);
      const s = JSON.parse(st.value);
      if (s.done || !s.turnVisible) break;
      await cdp.eval(`(function(){ document.querySelector('#aiAnswer').value=${JSON.stringify(ANSWERS[i])}; document.querySelector('#aiSend').click(); return 1; })()`);
      await sleep(2200);
      const after = await cdp.eval(`JSON.stringify({progress: document.querySelector('#aiProgress').textContent, done: AI.done})`);
      console.log('  第 ' + (i + 1) + ' 轮提交 → ' + after.value);
    }

    await sleep(1500);
    r = await cdp.eval(`JSON.stringify({
      done: AI.done,
      verdictShown: !document.querySelector('#aiVerdict').classList.contains('hide'),
      verdictText: (document.querySelector('#aiVerdict').textContent||'').replace(/\\s+/g,' ').slice(0,220),
      turnCount: document.querySelectorAll('#aiLog .turn').length,
      scores: [].slice.call(document.querySelectorAll('#aiLog .score-pill')).map(function(x){return x.textContent;})
    })`);
    console.log('\n=== 3. 自主收尾 ===');
    console.log('  ' + (r.value || r.error));

    const errs = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
    console.log('\n--- 未捕获异常 ---');
    console.log(errs.length ? errs.map((e) => (e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description) || e.params.exceptionDetails.text).join('\n') : '（无）');

    ws.close();
  } catch (e) {
    console.error('FATAL ' + e.message);
  } finally {
    child.kill();
  }
})();
