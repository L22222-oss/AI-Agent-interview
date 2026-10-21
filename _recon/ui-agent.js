/** 浏览器验收：登录 → AI 接入面板 → 候选人逐题追问 → 评判可见 */
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000/';
const PORT = Number(process.env.CDP_PORT || 9341);
const PROFILE = path.join(os.tmpdir(), 'interview-agent-ui-agent-' + process.pid);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject, timer } = this.pending.get(m.id);
        clearTimeout(timer);
        this.pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) this.events.push(m);
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error('timeout ' + method)); } }, 25000);
      this.pending.set(id, { resolve: res, reject: rej, timer });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) return { error: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
    return { value: r.result.value };
  }
}

(async () => {
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE,
    '--window-size=1280,1000', 'about:blank'], { stdio: 'ignore' });
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

    console.log('=== 1. 登录管理端 ===');
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(2200);
    await cdp.eval(`(function(){ document.querySelector('#lgAccount').value='admin'; document.querySelector('#lgPwd').value='demo1234'; document.querySelector('#lgBtn').click(); return 1; })()`);
    await sleep(2000);
    let r = await cdp.eval(`JSON.stringify({admin:!document.querySelector('#adminApp').classList.contains('hide'), who:(document.querySelector('#whoAmI')||{}).textContent})`);
    console.log('  ' + (r.value || r.error));

    console.log('\n=== 2. AI 接入面板 ===');
    await cdp.eval(`(function(){ var b=[].slice.call(document.querySelectorAll('.tabs button')).filter(function(x){return x.dataset.tab==='account';})[0]; if(b) b.click(); return 1; })()`);
    await sleep(1200);
    r = await cdp.eval(`JSON.stringify({
      status: (document.querySelector('#llmStatus')||{}).textContent,
      providerOptions: (document.querySelector('#llmProvider')||{}).options ? document.querySelector('#llmProvider').options.length : 0,
      base: (document.querySelector('#llmBase')||{}).value,
      model: (document.querySelector('#llmModel')||{}).value,
      hasSave: !!document.querySelector('#llmSave'),
      hasTest: !!document.querySelector('#llmTest')
    })`);
    console.log('  ' + (r.value || r.error));

    console.log('\n=== 3. 测试连接按钮 ===');
    await cdp.eval(`document.querySelector('#llmTest').click()`);
    await sleep(3500);
    r = await cdp.eval(`(document.querySelector('#llmResult')||{}).textContent`);
    console.log('  ' + (r.value || r.error));

    console.log('\n=== 4. 候选人逐题追问 ===');
    await cdp.send('Page.navigate', { url: BASE });
    await sleep(2000);
    /* 直接走候选人入口：先拿岗位 id */
    const job = await cdp.eval(`(async function(){
      var r = await fetch('/api/jobs', {credentials:'same-origin'});
      var list = await r.json();
      return list.length ? list[list.length - 1].id : null;
    })()`);
    console.log('  岗位: ' + (job.value || job.error));
    if (!job.value) throw new Error('当前没有可用岗位');

    await cdp.send('Page.navigate', { url: BASE + '?job=' + job.value });
    await sleep(2200);
    await cdp.eval(`(function(){
      document.querySelector('#candSelfName').value='浏览器候选人';
      document.querySelector('#candResumeText').value='孙七，本科软件工程。主导校园二手交易平台后端订单模块（Node.js + MySQL），设计唯一约束加乐观锁解决超卖，订单失败率从3%降到0.2%，半年零丢单。独立完成简历解析工具（Python + FastAPI），准确率从60%提升到90%。熟悉 Docker、Redis、Git。';
      document.querySelector('#candResumeText').dispatchEvent(new Event('input'));
      document.querySelector('#startInterview').click(); return 1;
    })()`);
    let q1 = '';
    for (let i = 0; i < 100; i++) {
      const state = await cdp.eval(`JSON.stringify({q:(document.querySelector('#stepText')||{}).textContent||'',err:(document.querySelector('#candErr')||{}).textContent||''})`);
      const current = JSON.parse(state.value || '{}');
      q1 = current.q;
      if (q1 || current.err) { if (!q1) throw new Error(current.err); break; }
      await sleep(500);
    }
    if (!q1) throw new Error('AI 首题等待超时');
    r = await cdp.eval(`JSON.stringify({q1:(document.querySelector('#stepText')||{}).textContent, prog:(document.querySelector('#stepProgress')||{}).textContent})`);
    console.log('  Q1: ' + (r.value || r.error));

    /* 空泛回答 → 下一题应是追问 */
    await cdp.eval(`(function(){
      var a=document.querySelector('#stepAnswer'); a.value='我做过一些后端相关的工作，大概就是增删改查那些，感觉还行。';
      a.dispatchEvent(new Event('input'));
      document.querySelector('#stepNext').click(); return 1;
    })()`);
    let q2 = '';
    for (let i = 0; i < 80; i++) {
      const state = await cdp.eval(`(document.querySelector('#stepText')||{}).textContent||''`);
      q2 = state.value || '';
      if (q2 && q2 !== q1) break;
      await sleep(500);
    }
    if (!q2 || q2 === q1) throw new Error('回答后未生成新的追问');
    r = await cdp.eval(`JSON.stringify({q2:(document.querySelector('#stepText')||{}).textContent,prog:(document.querySelector('#stepProgress')||{}).textContent})`);
    console.log('  ' + (r.value || r.error));

    const errs = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
    console.log('\n--- 未捕获异常 ---');
    console.log(errs.length ? errs.map((e) => (e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description) || e.params.exceptionDetails.text).join('\n') : '（无）');

    ws.close();
  } catch (e) {
    console.error('FATAL ' + e.message);
    process.exitCode = 1;
  } finally {
    child.kill();
  }
})();
