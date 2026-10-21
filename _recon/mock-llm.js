/**
 * 本地 OpenAI 兼容 mock：证明"接上 API 就能用"，而不是只留了个接口。
 * 监听 8899，实现 POST /v1/chat/completions。
 */
const http = require('http');

let calls = 0;
const seen = [];

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url.startsWith('/v1/chat/completions')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls++;
      let parsed = {};
      try { parsed = JSON.parse(body); } catch (_) {}
      const sys = (parsed.messages || []).find((m) => m.role === 'system');
      const usr = (parsed.messages || []).find((m) => m.role === 'user');
      seen.push({ sys: (sys || {}).content, usr: (usr || {}).content, model: parsed.model });

      const isProbe = /连通性探针/.test((sys || {}).content || '');
      const isJudge = /面试评分官/.test((sys || {}).content || '');
      const isQ = /资深中文技术面试官/.test((sys || {}).content || '');
      const isR2 = /第二轮通用能力评估/.test((sys || {}).content || '');
      const isJobPrep = /招聘流程设计师/.test((sys || {}).content || '');
      const isResumePrep = /中文面试准备智能体/.test((sys || {}).content || '');

      let content;
      if (isProbe) {
        content = 'ok';
      } else if (isJudge) {
        const userText = String((usr || {}).content || '');
        const answer = (userText.split('【候选人回答】\n')[1] || '').split('\n【')[0].trim();
        const poor = answer.length < 45 || /(不太清楚|差不多|还行|没什么特别|不知道|就正常做)/.test(answer);
        const evidence = answer.split(/[。；！？]/).filter((x) => x.trim().length >= 6)[0];
        content = JSON.stringify({
          score: poor ? 18 : 84,
          evidence: evidence ? [evidence.trim().slice(0, 36)] : [],
          comment: poor ? '回答空泛，缺少可核验的个人动作和结果。' : '回答包含具体动作与结果，建议补充指标基线。',
          flagged: poor,
          missing: poor ? ['具体个人动作', '量化结果'] : ['指标基线'],
        });
      } else if (isQ) {
        const userText = String((usr || {}).content || '');
        const probeMatch = userText.match(/【本次必须探查的缺口】(\w+)/);
        const kind = probeMatch ? probeMatch[1] : 'anchor';
        const byKind = {
          ownership: '「我负责订单模块，用乐观锁解决了超卖问题」这句话里，你个人具体写了哪几行代码？团队里谁负责压测和监控？',
          metric: '你提到的 0.2% 是怎么统计出来的？基线是多少，用了多大批量的样本？',
          obstacle: '这套乐观锁方案在实现过程中卡过吗？最难的一点具体是什么，你怎么绕过去的？',
          result: '改造上线之后的结果如何？失败率变成多少，有没有人真的在用？',
          empty: '刚才那段太短了。请完整说一个项目：背景是什么、你具体做了什么、最后结果如何？',
          vague: '你用了「还不错」这种说法。请举一个具体到某一天、某一次的例子，说清楚数字。',
          context: '这个订单模块是什么规模？团队几个人、做了多久、你处在什么角色？',
          none: '除了订单模块，你简历里的简历解析工具是怎么做到准确率从60%到90%的？具体改了什么？',
        };
        const resumeText = (userText.split('【简历原文】\n')[1] || '').split('\n\n【')[0].trim();
        const previous = userText.match(/答\d+：([^\n]+)/);
        const anchor = resumeText.split(/[。！？\n]/).map((x) => x.trim()).find((x) => /(项目|平台|订单|模块|工具|负责|主导)/.test(x)) || resumeText;
        const quote = (previous && previous[1] ? previous[1] : anchor).slice(0, 42);
        const question = probeMatch
          ? (previous ? '你刚才提到「' + quote + '」，' : '') + (byKind[kind] || byKind.none)
          : previous
            ? '你刚才提到「' + quote + '」，请补充你本人采取的具体措施，以及如何验证最终结果？'
            : '简历中写到「' + quote + '」，请说明你具体负责的部分、关键做法和最终结果如何验证？';
        content = JSON.stringify({
          text: question,
          expects: [['具体', '数字', '基线'], ['做法', '实现', '改'], ['结果', '验证', '对比']],
          reason: '针对缺口 ' + kind,
        });
      } else if (isR2) {
        const dim = String((sys || {}).content || '').match(/dim 必须是 "([^"]+)"/);
        const turn = String((usr || {}).content || '').match(/【这是第 (\d+) 题】/);
        const n = turn ? Number(turn[1]) : 1;
        const d = dim ? dim[1] : 'communication';
        content = JSON.stringify({
          text: n === 1
            ? '请结合岗位职责介绍你最相关的一段真实经历，并说明你本人承担的部分和最终结果。'
            : '结合前面回答，请补充你在该项目中的具体决策、验证方式，以及结果是否达到预期。',
          dim: d,
          material: d === 'learning'
            ? '缓存一致性要求读写操作遵循约定顺序。缓存更新可能失败，因此需要重试、过期策略和最终一致性校验。'
            : '',
        });
      } else if (isJobPrep) {
        content = JSON.stringify({
          summary: '围绕岗位核心职责核实候选人的实际贡献、技术决策与可量化结果。',
          candidateProfile: ['具备后端服务开发经验', '能说明个人职责、方案取舍与验证过程'],
          focus: [
            { label: '项目 ownership', reason: '区分个人交付与团队成果' },
            { label: '技术深度', reason: '核实关键设计及其取舍' },
            { label: '结果验证', reason: '检查指标口径和上线效果' },
          ],
          round1: [
            { dimension: '项目事实', question: '挑选最相关项目，说明背景、个人职责和最终结果。', followup: '请指出你亲自实现或决策的部分。', reason: '核验简历真实性' },
          ],
          round2: [
            { dimension: 'communication', question: '如何向非技术同事解释一次技术取舍？', reason: '评估表达能力' },
            { dimension: 'learning', question: '如何快速验证陌生技术是否适合当前场景？', material: '示例材料', reason: '评估学习迁移' },
            { dimension: 'execution', question: '资源受限时如何拆分并交付任务？', reason: '评估执行能力' },
          ],
          rubric: [
            { dimension: '事实与 ownership', weight: 35, excellent: '个人动作和边界清晰', pass: '能说明主要贡献', risk: '只描述团队成果' },
            { dimension: '技术判断', weight: 35, excellent: '解释方案和取舍', pass: '方案基本合理', risk: '无法解释关键决策' },
            { dimension: '结果验证', weight: 30, excellent: '指标可复核且有对比', pass: '有基本结果', risk: '无验证依据' },
          ],
          risks: ['成果口径缺少基线', '个人贡献边界不清'],
          nextAction: '优先核验简历中最重要的项目和量化指标。',
        });
      } else if (isResumePrep) {
        const raw = String((usr || {}).content || '');
        const resume = (raw.split('【简历原文】\n')[1] || '').split('\n【本地解析事实】')[0].trim();
        const quote = resume.slice(0, 48) || '简历中的项目经历';
        content = JSON.stringify({
          match: 86,
          matchReason: '简历展示了后端开发、缓存优化和效果验证经历，与岗位职责相关；仍需核实个人贡献和指标口径。',
          facts: [quote, '简历需进一步核验个人负责范围和线上验证方式'],
          pending: ['量化指标的统计口径与基线', '本人负责的代码和设计边界', '上线后的稳定性数据'],
          questions: [
            '你在简历中写到「' + quote + '」，请说明你本人负责的实现部分，以及如何验证结果？',
            '你提到的性能或业务指标是如何采集的，改造前后的对比周期和样本量是多少？',
            '项目中最难解决的问题是什么，你尝试过哪些方案，最后为什么选择当前方案？',
            '上线后出现过什么异常，你如何定位、止损并确认问题已经解决？',
            '如果重新做一次这个项目，你会改变哪个设计，原因是什么？',
            '请说明该项目的最终使用效果，以及你如何区分个人贡献和团队成果。',
          ],
        });
      } else {
        content = JSON.stringify({ summary: 'mock 评语', recommend: 'advance' });
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-mock',
        object: 'chat.completion',
        model: parsed.model || 'mock',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }));
    });
    return;
  }
  if (req.url === '/__stats') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ calls, seen: seen.slice(-3) }, null, 2));
  }
  res.writeHead(404); res.end('nope');
});

server.listen(8899, '127.0.0.1', () => console.log('mock llm on 8899'));
