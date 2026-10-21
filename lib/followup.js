'use strict';
/**
 * 答案分析器 —— 决定"下一题该追什么"。
 *
 * 这是让面试从"念题库"变成"对话"的关键：每一题都先分析上一题的回答，
 * 找出它缺了哪个维度，再针对那个缺口追问。
 *
 * 分析维度（对齐 STAR + 面试常用四要素）：
 *   context   情境：什么项目/业务/时间点
 *   task      任务：你要达成什么
 *   action    行动：你具体做了什么（第一人称 + 动作动词）
 *   obstacle  阻碍：卡在哪、怎么绕过去
 *   result    结果：最后怎样
 *   metric    量化：数字、基线、幅度
 *
 * 输出 probe.kind 表示下一题应该追什么；'none' 表示这题答得够，可以推进。
 */

const resume = require('./resume');

/* ---------------------------------------------------------------- 词表 */

const ACTION_VERBS = [
  '做了', '写了', '改了', '加了', '拆了', '重构', '封装', '抽取', '迁移', '接入',
  '实现', '设计', '搭建', '开发', '调试', '排查', '定位', '优化', '压测', '联调',
  '部署', '上线', '回滚', '监控', '埋点', '对齐', '推动', '协调', '拆解', '排期',
];

const CONTEXT_MARKERS = [
  '当时', '那时候', '在', '项目', '业务', '需求', '背景', '场景', '阶段', '版本',
  '客户', '用户', '线上', '生产', '实习', '学校', '团队',
];

const TASK_MARKERS = [
  '要', '需要', '目标', '任务', '要求', '负责', '让我', '安排', '期望', '指标', 'kpi',
];

/* 追问模板：每个探针都要求引用原话，避免空泛 */
const PROBE_TEMPLATES = {
  empty: [
    '这个回答太短了，我没法判断。请展开说：具体是哪个项目、你做了什么、结果如何？',
    '信息量不够。请用至少三句话说清楚：背景是什么、你具体做了什么、最后结果怎样？',
  ],
  metric: [
    '你提到「{quote}」，但没有给数字。这件事的基线是多少，做完之后变成了多少，你用什么方法测的？',
    '「{quote}」这个说法太笼统。有没有具体数字？改动前后的对比是多少，样本量多大？',
  ],
  obstacle: [
    '「{quote}」听起来挺顺，但中间应该卡过。最难的一点具体是什么，你怎么绕过去的？',
    '你说了做了什么，但没说哪里出了问题。「{quote}」的过程中，有没有踩过坑或者返工？',
  ],
  ownership: [
    '「{quote}」这件事，团队几个人在做？哪一部分是你亲手写的/做的，哪一部分是别人做的？',
    '我想确认个人贡献。「{quote}」里，如果把你换掉，哪些东西会做不出来？',
  ],
  process: [
    '「{quote}」你给的是结论，我要过程。具体第一步做了什么，第二步做了什么？',
    '「{quote}」——这个结果是怎么一步步做出来的？中间改过几次方案？',
  ],
  result: [
    '「{quote}」讲完了过程，但没讲结果。最后上线了吗，效果如何，有没有人用它？',
    '这件事的收尾是什么？「{quote}」之后，留下了什么可以复用的东西？',
  ],
  context: [
    '「{quote}」——先补一下背景：这是什么规模的项目，做了多久，你处在什么角色？',
    '在「{quote}」之前，原来的做法是什么样的？为什么需要你来改？',
  ],
  vague: [
    '你用了「{vague}」这样的词，但我要具体的。请给一个真实例子，说清楚时间、地点、数字。',
    '「{quote}」听起来是概括。能不能举一个具体到某一天、某一次的事？',
  ],
  none: [],
};

/* ---------------------------------------------------------------- 该追什么 */

/**
 * 按"题目问的是什么"决定该查哪些维度。
 *
 * 这是关键修正：不能拿一套通用维度硬套所有题。
 * 问"这个数字怎么统计的"，候选人答了方法和基线就算答到点了，
 * 再去追"最后上线了吗"是问错方向 —— 那是另一道题的答案。
 */
const REQUIRED_BY_KIND = {
  anchor: ['context', 'action', 'result'],
  metric: ['metric', 'action', 'context'],
  ownership: ['self', 'action'],
  /* 取舍题问的是"为什么选它、哪里会先崩"，答案本来就是假设性的，
     强求"具体做了什么"会把好好的回答判成缺口。只要理由清楚即可。 */
  tradeoff: ['context'],
  gap: ['action', 'result'],
  motivation: ['action'],
  /* 已经在追问某种缺口时，就只看那一个维度有没有补上 */
  'probe:empty': ['context', 'action', 'result'],
  'probe:metric': ['metric'],
  'probe:obstacle': ['obstacle'],
  'probe:ownership': ['self'],
  'probe:process': ['action'],
  'probe:result': ['result'],
  'probe:context': ['context'],
  'probe:vague': ['action', 'metric'],
  default: ['action', 'metric'],
};

/** 维度 → 追问类型。action 追"过程"，self 追"个人贡献"，两者别混。 */
const DIM_TO_PROBE = {
  context: 'context',
  task: 'context',
  action: 'process',
  self: 'ownership',
  obstacle: 'obstacle',
  result: 'result',
  metric: 'metric',
};

/** 缺口的追问优先级：越靠前越先追 */
const PROBE_ORDER = ['self', 'action', 'metric', 'result', 'context', 'obstacle'];

/* ---------------------------------------------------------------- 工具 */

function norm(s) {
  return String(s == null ? '' : s);
}

function hasAny(text, words) {
  const t = norm(text);
  return words.some((w) => t.includes(w));
}

function countAny(text, words) {
  const t = norm(text);
  let n = 0;
  for (const w of words) if (t.includes(w)) n++;
  return n;
}

/** 取回答里最"实"的一段原话，用于追问引用。 */
function pickQuote(answer) {
  const clauses = resume.splitClauses(answer).filter((c) => c.length >= 6);
  if (!clauses.length) {
    const s = norm(answer).trim();
    return s.length > 28 ? s.slice(0, 28) + '…' : s;
  }
  /* 优先带数字或技术名词的子句，其次最长的 */
  const scored = clauses.map((c) => ({
    c,
    s: resume.findMetrics(c).length * 3 + resume.findTech(c).length * 2 + Math.min(4, Math.floor(c.length / 15)),
  }));
  scored.sort((a, b) => b.s - a.s);
  const pick = scored[0].c;
  return pick.length > 30 ? pick.slice(0, 30) + '…' : pick;
}

/** 找出回答里提到的、简历里没有的技术名词（可能是新东西，也可能是编的）。 */
function newTech(answer, facts) {
  const inAnswer = resume.findTech(answer).map((t) => t.name);
  const inResume = new Set((facts && facts.tech ? facts.tech : []).map((t) => t.name.toLowerCase()));
  return inAnswer.filter((n) => !inResume.has(n.toLowerCase()));
}

/** 检测"复述题目"：回答大量复用题干词，说明没真答。 */
function echoesQuestion(question, answer) {
  const q = norm(question);
  const a = norm(answer);
  if (a.length < 10) return false;
  const qChars = new Set(q.replace(/[，。？、；：\s]/g, '').split(''));
  const aChars = a.replace(/[，。？、；：\s]/g, '').split('');
  if (!aChars.length) return false;
  const overlap = aChars.filter((ch) => qChars.has(ch)).length / aChars.length;
  return overlap > 0.72;
}

/* ---------------------------------------------------------------- 主分析 */

/**
 * 分析一条回答。
 * @param {{question:string, answer:string, facts?:object}} ctx
 * @returns {{len:number, coverage:object, specificity:number, vague:string[],
 *            newTech:string[], echoes:boolean, probe:{kind:string, reason:string, quote:string},
 *            quote:string}}
 */
function analyze(ctx) {
  const question = norm(ctx.question);
  const answer = norm(ctx.answer).trim();
  const facts = ctx.facts || null;
  const len = answer.length;

  /* 假设性回答：取舍题、方案题的答案本来就是"我会…"，没有"我做了…"。
     把它当成缺少行动，会把好好的设计思路判成空洞。 */
  const hypothetical = /如果|假如|要是|假设|将来|未来|撑不住|涨/.test(answer) && /我(会|要|打算|想|准备|计划)/.test(answer);
  const planVerb = /我(会|要|打算|想|准备|计划)/.test(answer);

  const coverage = {
    context: hasAny(answer, CONTEXT_MARKERS) || len >= 60,
    task: hasAny(answer, TASK_MARKERS),
    action: countAny(answer, ACTION_VERBS) >= 1 || (hypothetical && planVerb),
    obstacle: hasAny(answer, resume.OBSTACLE_MARKERS),
    result: hasAny(answer, resume.RESULT_MARKERS),
    metric: resume.findMetrics(answer).length > 0,
    self: hasAny(answer, resume.SELF_MARKERS) && (countAny(answer, ACTION_VERBS) >= 1 || (hypothetical && planVerb)),
  };

  const vague = resume.VAGUE_MARKERS.filter((w) => answer.includes(w));
  const newTechList = newTech(answer, facts);
  const echoes = echoesQuestion(question, answer);
  const quote = pickQuote(answer);

  /* 具体度：长度 + 数字 + 技术名词 + 动作动词 - 空泛词 */
  const specificity = Math.max(
    0,
    Math.min(
      100,
      Math.round(
        Math.min(45, len / 3) +
          resume.findMetrics(answer).length * 12 +
          resume.findTech(answer).length * 6 +
          countAny(answer, ACTION_VERBS) * 5 -
          vague.length * 7 -
          (echoes ? 20 : 0)
      )
    )
  );

  /* 探针决策：只看"这道题该有的维度"里缺了哪个，不拿通用清单硬套 */
  const required = REQUIRED_BY_KIND[ctx.kind] || REQUIRED_BY_KIND.default;
  let kind = 'none';
  let reason = '回答已覆盖本题要求的信息，可以推进。';

  if (len < 25) {
    kind = 'empty';
    reason = '回答只有 ' + len + ' 字，信息不足以评估。';
  } else if (echoes) {
    kind = 'vague';
    reason = '回答大量复述题干，没有给出自己的内容。';
  } else {
    /* 按优先级找第一个缺失的必需维度 */
    let missingDim = null;
    for (const dim of PROBE_ORDER) {
      if (!required.includes(dim)) continue;
      if (!coverage[dim]) { missingDim = dim; break; }
    }

    if (missingDim) {
      kind = DIM_TO_PROBE[missingDim] || 'context';
      const why = {
        self: '没有出现第一人称的具体动作，看不出个人做了什么。',
        action: '没有说清具体怎么做的，只有结论没有过程。',
        metric: '本题要的是数字，回答里没有量化结果。',
        result: '讲了过程但没给结果，不知道最后是否落地。',
        context: '缺少项目规模、时间跨度这类背景信息。',
        obstacle: '全程顺利，没有提到任何阻碍，缺少真实的攻坚过程。',
      };
      reason = why[missingDim] || '缺少本题要求的关键信息。';
    } else if (vague.length >= 2) {      kind = 'vague';
      reason = '出现多个模糊限定词（' + vague.join('、') + '），缺少具体事实。';
    } else if (!coverage.obstacle && specificity < 72 && required.includes('action')) {
      /* 该答的都答了，但内容偏概括 —— 追一次攻坚过程，这是最后一道加分题 */
      kind = 'obstacle';
      reason = '要点齐了但偏概括，想确认有没有真实的攻坚过程。';
    }
  }

  return {
    len,
    coverage,
    hypothetical,
    specificity,
    vague,
    newTech: newTechList,
    echoes,
    quote,
    probe: { kind, reason, quote },
  };
}

/**
 * 把探针渲染成一道具体的追问。
 * @param {{kind:string, quote?:string, vague?:string[]}} probe
 * @param {number} variant 用于同 kind 时换措辞，避免连着两次问法一样
 */
function renderProbe(probe, variant) {
  const kind = probe && probe.kind ? probe.kind : 'none';
  const list = PROBE_TEMPLATES[kind];
  if (!list || !list.length) return '';
  const quote = String((probe && probe.quote) || '').replace(/[。；]$/, '').trim();

  /* 引文为空（作答太短/全是空话）时，跳过需要引用的模板，避免出现「这件事」这种空指代 */
  const needsQuote = /\{quote\}/.test(list[0]);
  const usable = quote ? list : list.filter((t) => !/\{quote\}/.test(t));
  const pool = usable.length ? usable : list;
  const tpl = pool[(variant || 0) % pool.length];

  return tpl
    .replace(/\{quote\}/g, quote || '你刚才那段')
    .replace(/\{vague\}/g, (probe && probe.vague && probe.vague[0]) || '差不多');
}

/**
 * 追问对应的考察要点：让 accuracy 这一维真正衡量"有没有答到点上"。
 * 与探针类型绑定，而不是泛泛的三组关键词。
 */
const PROBE_EXPECTS = {
  empty: [['项目', '做过', '负责', '参与'], ['具体', '比如', '当时'], ['结果', '效果', '完成']],
  metric: [['数字', '百分比', '倍', '从', '提升', '降低', 'ms', '秒', '人', '天'], ['基线', '之前', '原来', '对比', '测', '统计'], ['验证', '样本', '压测', '对比', '复测']],
  obstacle: [['难点', '问题', '卡', '坑', '报错', '失败', '瓶颈'], ['解决', '绕', '改', '排查', '定位', '换'], ['原因', '因为', '根因', '本质']],
  ownership: [['我', '本人', '自己'], ['写', '做', '改', '设计', '实现', '负责'], ['团队', '人', '分工', '别人', '协作']],
  process: [['第一步', '先', '然后', '接着', '最后', '之后'], ['改', '做', '试', '换', '拆', '加', '写'], ['因为', '发现', '原因', '所以']],
  result: [['上线', '交付', '完成', '结果', '最终'], ['效果', '提升', '降低', '使用', '采用'], ['复用', '沉淀', '留下', '文档', '工具']],
  context: [['项目', '业务', '系统', '平台'], ['规模', '多少', '时长', '个月', '周'], ['角色', '负责', '团队']],
  vague: [['具体', '比如', '一次', '那天'], ['时间', '地点', '项目'], ['数字', '结果', '效果']],
  none: [['因为', '所以', '结果'], ['具体', '比如'], ['验证', '复盘']],
};

function expectsFor(kind) {
  const e = PROBE_EXPECTS[kind] || PROBE_EXPECTS.none;
  return e.map((g) => g.slice());
}

module.exports = {
  analyze,
  renderProbe,
  expectsFor,
  pickQuote,
  echoesQuestion,
  newTech,
  ACTION_VERBS,
  PROBE_TEMPLATES,
  PROBE_EXPECTS,
};
