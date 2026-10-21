'use strict';
/**
 * 面试智能体 —— 出题官 + 追问官 + 规则链。
 *
 * 参考 AI-Meeting 的多智能体分工（出题官 / 提问官 / 评分官 / 追问官），
 * 按目标站点（面试智能体）的三关流程落地：
 *
 *   出题官 planRound1()  —— 把简历拆成事实，按考察意图排出题目骨架
 *   追问官 nextQuestion() —— 每一题都先看上一题回答，缺什么追什么（规则链）
 *   评分官 judge.js       —— 逐题给分 + 引用原文证据
 *
 * 关键设计：题目不是从题库里挑，而是由「简历事实 + 上一题回答的缺口」现场生成。
 * 同一个人答得不同，下一题就不同；不同的人来，第一题就不同。
 *
 * 有 LLM 时由模型措辞（提示词强制引用原文），无 LLM 时用确定性模板，
 * 两条通道的"追什么"由同一套规则链决定，所以行为一致、可回归。
 */

const llm = require('./llm');
const resume = require('./resume');
const followup = require('./followup');

const DIM_NAME = { communication: '沟通能力', learning: '学习能力', execution: '执行能力' };
const SPEC_DIM = ['communication', 'communication', 'learning', 'learning', 'execution', 'execution'];

/** 追问预算：一轮最多追问几次，避免跑偏成审讯。 */
const MAX_PROBES = 2;

/* ================================================================ 出题官 */

/**
 * 考察意图。顺序即默认推进顺序，但追问会插队。
 * 每个意图从简历事实里取料，取不到就跳过（降级到下一个）。
 */
const INTENT_BUILDERS = [
  {
    kind: 'anchor',
    expects: [
      ['项目', '平台', '系统', '做', '负责'],
      ['设计', '实现', '搭建', '开发', '改'],
      ['结果', '上线', '效果', '提升', '交付'],
    ],
    build(facts, ctx) {
      const top = resume.projectClause(facts);
      if (!top) return null;
      const quoted = trimQuote(top.clause, 46);
      const tech = top.tech.length ? '（' + top.tech.slice(0, 3).map((t) => t.name).join('、') + '）' : '';
      return '简历里你写到「' + quoted + '」' + tech + '。请把这段完整展开：当时是什么背景，你具体负责哪一部分，最后结果如何？';
    },
  },
  {
    kind: 'metric',
    expects: [
      ['数字', '百分比', '倍', '从', '提升', '降低', 'ms', '秒', '人', '天', '条'],
      ['基线', '之前', '原来', '对比', '测', '统计', '记录'],
      ['验证', '样本', '压测', '对比', '复测', '口径'],
    ],
    build(facts) {
      const m = resume.bestMetric(facts);
      if (!m) return null;
      const list = m.all.slice(0, 2).map((x) => x.raw).join('、');
      const unitWord = UNIT_WORD[m.metric.unit] || (m.metric.unit ? '「' + m.metric.unit + '」' : '数字');
      return '你简历里给了数字「' + list + '」（原句：「' + trimQuote(m.clause, 36) + '」）。' +
        '这个' + unitWord + '是怎么统计出来的？改动前的基线是多少，你用什么方法确认它真的变了？';
    },
  },
  {
    kind: 'ownership',
    expects: [
      ['我', '本人', '自己'],
      ['写', '做', '改', '设计', '实现', '负责', '主导'],
      ['团队', '人', '分工', '别人', '协作', '配合'],
    ],
    build(facts) {
      const c = resume.bestClaim(facts);
      if (!c) return null;
      return '你用了「' + c.verb + '」这个词（' + trimQuote(c.object || c.verb, 24) + '）。' +
        '这个项目团队几个人？哪一部分是你亲手做的，哪一部分是别人做的？如果把你换掉，哪些东西会做不出来？';
    },
  },
  {
    kind: 'tradeoff',
    expects: [
      ['因为', '考虑', '权衡', '对比', '评估'],
      ['性能', '成本', '复杂度', '维护', '生态', '熟悉'],
      ['换', '替代', '如果', '撑不住', '瓶颈'],
    ],
    build(facts, ctx) {
      const tech = facts.tech.filter((t) => t.cat !== '语言');
      const pick = tech[0] || facts.tech[0];
      if (!pick) return null;
      const alts = SAME_CAT_ALT[pick.cat] || [];
      const alt = alts.filter((a) => !facts.tech.some((t) => t.name.toLowerCase() === a.toLowerCase()))[0];
      const altText = alt ? '而不是 ' + alt : '而不是别的方案';
      return '你选了 ' + pick.name + ' ' + altText + '。当时的取舍是什么？' +
        '如果数据量或并发涨十倍，这套方案哪里会最先撑不住？';
    },
  },
  {
    kind: 'gap',
    expects: [
      ['用', '做', '写', '跑', '搭', '部署', '调'],
      ['项目', '场景', '需求', '功能'],
      ['结果', '效果', '问题', '解决'],
    ],
    build(facts, ctx) {
      const used = (ctx && ctx.coveredTech) || [];
      const g = resume.gapTech(facts, used);
      if (!g) return null;
      return '简历里写了 ' + g.tech + '，但没说你用它做过什么。' +
        '请讲一个你真正用 ' + g.tech + ' 解决过的问题：什么场景、你写了哪部分、最后跑通了吗？';
    },
  },
  {
    kind: 'motivation',
    expects: [
      ['因为', '兴趣', '想做', '匹配', '方向'],
      ['优势', '擅长', '熟悉', '经验'],
      ['计划', '提升', '补', '学习'],
    ],
    build(facts, ctx) {
      const job = (ctx && ctx.jobName) || '这个岗位';
      const strong = facts.tech.slice(0, 2).map((t) => t.name).join('、') || '你的技术栈';
      return '你在简历里体现了 ' + strong + '。为什么觉得自己适合' + job + '？' +
        '你认为自己现在最欠缺的一项能力是什么，打算怎么补？';
    },
  },
];

const SAME_CAT_ALT = {
  前端: ['Vue', 'React', 'Svelte'],
  后端: ['Spring Boot', 'Express', 'FastAPI', 'Gin'],
  数据: ['MySQL', 'PostgreSQL', 'MongoDB', 'Redis'],
  基础设施: ['Docker', 'Kubernetes', 'Nginx'],
  AI: ['PyTorch', 'TensorFlow', 'LangChain'],
  移动端: ['Flutter', 'React Native', 'Android'],
};

/** 单位读法，避免出现"这个 % 是怎么统计的"这种别扭问法。 */
const UNIT_WORD = {
  '%': '百分比', '％': '百分比', '倍': '倍数', '万': '量级', '千': '量级',
  人: '人数', 天: '天数', 小时: '小时数', 分钟: '时长', 秒: '秒数',
  ms: '耗时', 毫秒: '耗时', GB: '容量', MB: '容量', TB: '容量',
  QPS: '吞吐量', qps: '吞吐量', TPS: '吞吐量', 次: '次数', 条: '条数', 个: '数量',
};

function trimQuote(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/**
 * 出题官：生成第一轮题目骨架。
 * 意图取不到料就跳过，所以简历越具体，题目越具体。
 * @returns {Array<{kind:string,text:string,expects:string[][],basis:string}>}
 */
function planRound1(ctx) {
  const facts = ctx.facts || resume.parse(ctx.resume || '');
  const count = ctx.count || 6;
  const out = [];
  const seen = new Set();

  for (const intent of INTENT_BUILDERS) {
    if (out.length >= count) break;
    let text = null;
    try {
      text = intent.build(facts, ctx);
    } catch (_) {
      text = null;
    }
    if (!text) continue;
    const key = text.slice(0, 12);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: intent.kind, text, expects: intent.expects.map((g) => g.slice()), basis: 'resume:' + intent.kind });
  }

  /* 兜底：简历太薄时补通用题，但依然围绕已抽到的事实 */
  const FILL = [
    { kind: 'anchor', text: '请完整介绍一段你投入时间最长的项目：背景、你的角色、具体做了什么、最后结果如何？', expects: [['项目', '经历'], ['负责', '做', '设计'], ['结果', '上线', '效果']] },
    { kind: 'obstacle', text: '讲一次你真正卡住的经历：卡在哪里、你试过哪些办法、最后怎么解决的？', expects: [['难点', '问题', '卡'], ['试', '排查', '改'], ['解决', '结果', '原因']] },
    { kind: 'metric', text: '你做过的事情里，哪一件能拿出具体数字？请说明基线、改动和验证方式。', expects: [['数字', '百分比', '倍'], ['基线', '之前', '对比'], ['验证', '测', '样本']] },
    { kind: 'motivation', text: '为什么想做这个岗位？你现在的短板是什么，打算怎么补？', expects: [['因为', '兴趣', '匹配'], ['优势', '擅长'], ['计划', '补', '学习']] },
  ];
  for (let i = 0; out.length < count; i++) {
    const f = FILL[i % FILL.length];
    out.push({ kind: f.kind, text: f.text, expects: f.expects.map((g) => g.slice()), basis: 'fallback' });
    if (i > 12) break;
  }
  return out.slice(0, count);
}

/* ================================================================ 追问官 */

/**
 * 规则链：根据上一题回答的缺口，决定这一题追什么。
 * 返回 null 表示不追问，推进到下一个意图。
 */
function ruleChain(analysis, ctx) {
  const probesUsed = (ctx.probeCount || 0);
  if (probesUsed >= MAX_PROBES) return null;
  if (!analysis || analysis.probe.kind === 'none') return null;

  /* 已经追过同一种缺口就不再追，换下一个 */
  const asked = new Set((ctx.probesAsked || []));
  let kind = analysis.probe.kind;
  if (asked.has(kind)) {
    const order = ['empty', 'vague', 'ownership', 'metric', 'obstacle', 'result', 'context'];
    kind = order.find((k) => !asked.has(k) && k !== 'none' && satisfies(k, analysis)) || 'none';
    if (kind === 'none') return null;
  }
  return {
    kind,
    reason: analysis.probe.reason,
    quote: analysis.probe.quote,
    vague: analysis.vague,
  };
}

/** 判断某个缺口是否真的存在于这条回答里（换 kind 时用）。 */
function satisfies(kind, a) {
  switch (kind) {
    case 'empty': return a.len < 25;
    case 'vague': return a.echoes || a.vague.length >= 2;
    case 'ownership': return !a.coverage.action;
    case 'metric': return !a.coverage.metric;
    case 'obstacle': return !a.coverage.obstacle;
    case 'result': return !a.coverage.result;
    case 'context': return !a.coverage.context;
    default: return false;
  }
}

/* ================================================================ 提示词 */

const Q_SYSTEM = [
  '你是一名资深中文技术面试官，正在进行第一轮简历问答。你一次只问【一道】题。',
  '只输出一个 JSON 对象：{"text":"问题","expects":[["关键词组1"],["关键词组2"]],"reason":"为什么问这个"}。',
  '硬性要求：',
  '1) 必须引用【简历原文】或【候选人上一题原话】中的至少一个具体片段（用「」包起来），不能凭空提问；',
  '2) 如果给出了【本次必须探查的缺口】，题目必须针对这个缺口，不得改问别的；',
  '3) 不得与【已问过的题目】重复或角度雷同；',
  '4) text 30-90 字，具体、可回答，不要问"你怎么看"这类空问题；',
  '5) expects 给 2-3 组，每组 3-5 个关键词，用来判断候选人是否答到了点上；',
  '6) 除 JSON 外不要输出任何内容。',
].join('\n');

function buildUserPrompt(ctx) {
  const facts = ctx.facts || resume.parse(ctx.resume || '');
  const parts = [];

  parts.push('【应聘岗位】' + (ctx.jobName || '该岗位'));
  if (ctx.jd) parts.push('【岗位描述】' + String(ctx.jd).slice(0, 500));

  parts.push('【简历原文】\n' + String(ctx.resume || '').slice(0, 3500));

  if (facts.projects.length) {
    parts.push('【已抽取的项目】' + facts.projects.slice(0, 5).map((p) => p.name).join('、'));
  }
  if (facts.metrics.length) {
    parts.push('【已抽取的量化指标】' + facts.metrics.slice(0, 8).map((m) => m.raw).join('、'));
  }
  if (facts.gaps.length) {
    parts.push('【提到但没有证据的技术】' + facts.gaps.slice(0, 6).map((g) => g.tech).join('、'));
  }

  const qs = ctx.questions || [];
  const as = ctx.answers || [];
  if (qs.length) {
    const lines = [];
    for (let i = 0; i < qs.length; i++) {
      lines.push('问' + (i + 1) + '：' + qs[i]);
      lines.push('答' + (i + 1) + '：' + String(as[i] || '（未作答）').slice(0, 400));
    }
    parts.push('【已进行的问答】\n' + lines.join('\n'));
  } else {
    parts.push('【已进行的问答】\n（这是第一题）');
  }

  if (ctx.analysis) {
    parts.push(
      '【上一题回答分析】' +
        JSON.stringify({
          字数: ctx.analysis.len,
          覆盖: ctx.analysis.coverage,
          空泛词: ctx.analysis.vague,
          是否复述题目: ctx.analysis.echoes,
          具体度: ctx.analysis.specificity,
        })
    );
  }
  if (ctx.probe) {
    parts.push('【本次必须探查的缺口】' + ctx.probe.kind + ' —— ' + ctx.probe.reason +
      '（引用片段：「' + (ctx.probe.quote || '') + '」）');
  } else {
    parts.push('【本次任务】上一题没有明显缺口，请从简历中换一个尚未考察的角度继续。');
  }
  parts.push('【这是第 ' + ((ctx.idx || 0) + 1) + ' 题】');

  return parts.join('\n\n');
}

/* ================================================================ 对外接口 */

/**
 * 出下一题。核心入口。
 *
 * @param {{round?:1|2, idx:number, jobName:string, jd?:string, resume?:string,
 *          questions?:string[], answers?:string[], facts?:object,
 *          probeCount?:number, probesAsked?:string[], coveredTech?:string[],
 *          intents?:Array, usedIntents?:string[]}} ctx
 * @returns {Promise<{text:string, expects?:string[][], dim?:string, material?:string,
 *                    kind:string, basis:string, source:'llm'|'rule'}>}
 */
async function nextQuestion(ctx) {
  if (ctx.round === 2) return nextRound2Question(ctx);

  const facts = ctx.facts || resume.parse(ctx.resume || '');
  const questions = ctx.questions || [];
  const answers = ctx.answers || [];
  const idx = ctx.idx || 0;

  /* 1) 分析上一题回答。
        注意：questions 可能是预先填好的骨架（长度已等于总题数），
        所以"上一题"要用 idx-1，不能用 questions.length-1。 */
  const lastIdx = Math.min(idx, questions.length) - 1;
  const lastKind = ctx.lastKind
    || (lastIdx >= 0 && ctx.intents && ctx.intents[lastIdx] ? ctx.intents[lastIdx].kind : null);
  const analysis = lastIdx >= 0
    ? followup.analyze({ question: questions[lastIdx], answer: answers[lastIdx] || '', facts, kind: lastKind })
    : null;

  /* 2) 规则链决定是否追问。
        会话模式下由上层 decide() 说了算：它说"推进"就不许再插追问，
        否则两层各判一次，会出现"刚说这角度够了，出题官又追着问"的矛盾。 */
  const probe = ctx.allowProbe === false ? null : ruleChain(analysis, ctx);

  /* 3) 组装上下文 */
  const full = Object.assign({}, ctx, { facts, analysis, probe, idx });

  /* 4) 有 LLM 就让模型措辞 */
  if (llm.enabled()) {
    try {
      const data = await llm.withTimeout(
        llm.chatJSON({ system: Q_SYSTEM, user: buildUserPrompt(full), temperature: 0.6 }),
        30000,
        'next-question'
      );
      const text = String((data && (data.text || data.question)) || '').trim();
      const okLen = text.length >= 8 && text.length <= 260;
      const notDup = !questions.includes(text);
      if (okLen && notDup) {
        const ex = Array.isArray(data.expects) ? data.expects.filter((g) => Array.isArray(g) && g.length) : [];
        return {
          text,
          expects: ex.length ? ex : followup.expectsFor(probe ? probe.kind : 'none'),
          kind: probe ? 'probe:' + probe.kind : intentFor(ctx, facts, idx).kind,
          basis: probe ? probe.reason : (String(data.reason || '').slice(0, 80) || 'resume'),
          source: 'llm',
        };
      }
    } catch (e) {
      llm.noteFallback('next-question', e);
      /* 落规则通道 */
    }
  }

  /* 5) 规则通道 */
  return ruleQuestion(ctx, facts, idx, probe, analysis);
}

/**
 * 确定性通道：追问优先，其次按意图推进。
 * 关键点：同一个人答得不同，这里返回的题就不同。
 */
function ruleQuestion(ctx, facts, idx, probe, analysis) {
  const questions = ctx.questions || [];

  if (probe) {
    const variant = (ctx.probesAsked || []).length;
    const text = followup.renderProbe(probe, variant);
    if (text && !questions.includes(text)) {
      return {
        text,
        expects: followup.expectsFor(probe.kind),
        kind: 'probe:' + probe.kind,
        basis: probe.reason,
        source: 'rule',
      };
    }
  }

  const intent = intentFor(ctx, facts, idx);
  return {
    text: intent.text,
    expects: intent.expects,
    kind: intent.kind,
    basis: intent.basis,
    source: 'rule',
  };
}

/** 取下一个未被使用的意图。 */
function intentFor(ctx, facts, idx) {
  const plan = ctx.intents && ctx.intents.length
    ? ctx.intents
    : planRound1({ facts, resume: ctx.resume, jobName: ctx.jobName, count: 6 });
  const used = new Set((ctx.usedIntents || []).map((k) => String(k).replace(/^probe:/, '')));
  const asked = new Set(ctx.questions || []);

  for (const item of plan) {
    if (used.has(item.kind)) continue;
    if (asked.has(item.text)) continue;
    return item;
  }
  /* 全用过就按索引取，并改写避免重复 */
  const fallback = plan[idx % plan.length] || plan[0];
  return {
    kind: fallback.kind,
    text: fallback.text + '（请换一个角度回答，不要重复前面的例子。）',
    expects: fallback.expects,
    basis: 'revisit',
  };
}

/* ================================================================ 第二轮 */

const R2_SPEC = [
  { dim: 'communication', task: '自我介绍 + 报考动机，考察表达是否有结构（背景-重点-收尾）。' },
  { dim: 'communication', task: 'STAR 经历深挖：让候选人讲一段真实经历，考察情境-任务-行动-结果是否完整。' },
  { dim: 'learning', task: '现场学习题：先写一段 80-150 字、与岗位相关但候选人大概率没学过的 mini 材料放进 material 字段；text 引导其阅读后用自己的话解释解决什么问题、带来哪两个新问题。' },
  { dim: 'learning', task: '学习方法与迁移：举例说明如何把学到的知识用到全新场景、如何验证自己真的学会了。' },
  { dim: 'execution', task: '任务拆解与排期：设定时间紧、依赖多、资源有限的情境，考察拆解、优先级与里程碑意识。' },
  { dim: 'execution', task: '异常补救与复盘：考察风险应对、补救措施与闭环复盘意识。' },
];

const R2_BANK = [
  { dim: 'communication', text: '请简要介绍你自己，以及你为什么对{job}这个岗位感兴趣。', material: '' },
  { dim: 'communication', text: '请用 STAR 结构讲一段你真实经历：说明当时的情境、你的任务、你采取的行动和最终结果。', material: '' },
  {
    dim: 'learning',
    text: '阅读完上面的材料后，请用自己的话解释：消息队列解决了什么问题？同时会带来哪两个新问题？',
    material:
      '某团队为提升服务稳定性引入「消息队列」：上游服务把任务写入队列后立即返回，下游服务按自己的节奏从队列中取出任务处理。好处是削峰填谷、失败可重试；代价是链路变长，需要额外处理消息重复与顺序问题。',
  },
  { dim: 'learning', text: '请举一个你快速学会陌生知识或工具的亲身例子，说明你如何从「看懂」走到「会用」，以及如何验证自己真的学会了。', material: '' },
  { dim: 'execution', text: '如果让你负责一项时间紧、依赖多、资源有限的任务，你会如何拆解与排期？请结合真实经历说明。', material: '' },
  { dim: 'execution', text: '描述一次你推动的事情中途出问题的经历：你当时如何补救、事后如何复盘、最终结果如何？', material: '' },
];

async function nextRound2Question(ctx) {
  const idx = ctx.idx || 0;
  const spec = R2_SPEC[Math.min(idx, R2_SPEC.length - 1)];
  const questions = ctx.questions || [];
  const answers = ctx.answers || [];

  if (llm.enabled()) {
    try {
      const qa = [];
      for (let i = 0; i < questions.length; i++) {
        qa.push('问' + (i + 1) + '：' + questions[i] + '\n答' + (i + 1) + '：' + String(answers[i] || '').slice(0, 300));
      }
      const data = await llm.withTimeout(
        llm.chatJSON({
          system: [
            '你是中文面试官，正在进行第二轮通用能力评估。你一次只问【一道】题。',
            '只输出 JSON：{"text":"问题","dim":"communication|learning|execution","material":"可选材料"}。',
            'dim 必须是 "' + spec.dim + '"。' + spec.task,
            '题目要贴合岗位场景与候选人简历。简历和上一题回答中出现具体项目、技术或结果时，优先围绕这些事实追问；不得虚构候选人经历。',
            '若上一题回答已充分，继续当前能力维度但换一个未考察的简历角度。',
            '除 JSON 外不要输出任何内容。',
          ].join('\n'),
          user:
            '【应聘岗位】' + (ctx.jobName || '该岗位') +
            (ctx.jd ? '\n【岗位描述】' + String(ctx.jd).slice(0, 400) : '') +
            (ctx.resume ? '\n【候选人简历】\n' + String(ctx.resume).slice(0, 5000) : '') +
            '\n【已进行问答】\n' + (qa.join('\n') || '（这是第一题）') +
            '\n【这是第 ' + (idx + 1) + ' 题】',
          temperature: 0.6,
        }),
        30000,
        'next-q2'
      );
      const text = String((data && data.text) || '').trim();
      if (text.length >= 8 && text.length <= 260 && !questions.includes(text)) {
        const out = { text, dim: spec.dim, kind: spec.dim, basis: 'r2-spec', source: 'llm' };
        const mat = String(data.material || '').trim();
        if (mat.length >= 40 && mat.length <= 600) out.material = mat;
        return out;
      }
    } catch (e) {
      llm.noteFallback('next-round2', e);
      /* 落题库 */
    }
  }

  const tpl = R2_BANK[Math.min(idx, R2_BANK.length - 1)];
  return {
    text: tpl.text.replace('{job}', ctx.jobName || '该'),
    dim: tpl.dim,
    material: tpl.material,
    kind: tpl.dim,
    basis: 'r2-bank',
    source: 'rule',
  };
}

/** 第二轮出题骨架（plan2 用）。 */
function planRound2(ctx) {
  const count = ctx.count || 6;
  const out = [];
  for (let i = 0; i < count; i++) {
    const tpl = R2_BANK[Math.min(i, R2_BANK.length - 1)];
    out.push({
      text: tpl.text.replace('{job}', (ctx && ctx.jobName) || '该'),
      dim: SPEC_DIM[i] || tpl.dim,
      material: tpl.material,
      kind: tpl.dim,
      basis: 'r2-bank',
      source: 'rule',
    });
  }
  return out;
}

/* ================================================================ 评语 */

const SUMMARY_SYSTEM = [
  '你是中文面试评估官。只输出一个 JSON 对象：',
  '{"summary":"不超过120字的整体评语，点名最强维度与最弱维度并给出证据","recommend":"advance 或 hold 或 reject"}。',
  '除 JSON 外不要输出任何内容。',
].join('\n');

async function summarizeRound2(scores) {
  const avg = Math.round((scores.communication + scores.learning + scores.execution) / 3);
  if (llm.enabled()) {
    try {
      const d = await llm.withTimeout(
        llm.chatJSON({
          system: SUMMARY_SYSTEM,
          user: '【三维得分】沟通 ' + scores.communication + ' / 学习 ' + scores.learning + ' / 执行 ' + scores.execution,
          temperature: 0.3,
        }),
        20000,
        'summary'
      );
      if (d && d.summary) return { avg, summary: String(d.summary).slice(0, 240), recommend: d.recommend || 'hold' };
    } catch (e) {
      llm.noteFallback('summarize-round2', e);
      /* 落模板 */
    }
  }
  const entries = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const best = entries[0];
  const worst = entries[entries.length - 1];
  return {
    avg,
    summary:
      '综合评分 ' + avg + ' 分（沟通 ' + scores.communication + ' / 学习 ' + scores.learning +
      ' / 执行 ' + scores.execution + '）。最强维度为' + (DIM_NAME[best[0]] || best[0]) + '（' + best[1] +
      ' 分），最弱维度为' + (DIM_NAME[worst[0]] || worst[0]) + '（' + worst[1] + ' 分）。' +
      (avg >= 60 ? '建议进入下一阶段。' : '建议人工复核。'),
    recommend: avg >= 60 ? 'advance' : 'hold',
  };
}

function qaDigest(questions, answers, upto) {
  const lines = [];
  for (let i = 0; i < upto; i++) {
    if (questions[i] === undefined) break;
    lines.push('问' + (i + 1) + '：' + questions[i] + '\n答' + (i + 1) + '：' + String(answers[i] || '（未作答）').slice(0, 300));
  }
  return lines.join('\n');
}

module.exports = {
  DIM_NAME,
  SPEC_DIM,
  MAX_PROBES,
  planRound1,
  planRound2,
  nextQuestion,
  nextRound2Question,
  ruleQuestion,
  ruleChain,
  intentFor,
  summarizeRound2,
  qaDigest,
  INTENT_BUILDERS,
};
