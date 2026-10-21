'use strict';
/**
 * 评分官 —— 逐题给出带证据的自主评判。
 *
 * 两条通道：
 *   1) 有 LLM：让模型按 rubric 打分，并强制引用候选人原话作为证据
 *   2) 无 LLM：证据抽取式评分 —— 逐条 rubric 检查回答里有没有对应证据，
 *      把命中的原句摘出来作为证据，分数由覆盖度 + 具体度算出
 *
 * 第二条通道是关键：它让"自主评判"在没有 API 时依然成立，
 * 而且给出的理由是可核查的（引用原文），不是黑箱数字。
 */

const llm = require('./llm');
const resume = require('./resume');
const followup = require('./followup');

/* ---------------------------------------------------------------- 诊断 */

/**
 * 降级原因。静默 catch 会让"接上 API 也不生效"这种 bug 永远查不出来，
 * 所以统一记到 llm.noteFallback，/api/health 能看到最后一次失败原因。
 */
function noteFailure(where, e) {
  llm.noteFallback('judge/' + where, e);
}

function diagnostics() {
  return llm.diagnostics();
}

/* ---------------------------------------------------------------- rubric */

/**
 * 通用 rubric：每一维给出判定函数与"命中的证据长什么样"。
 * 顺序即评语里的展示顺序。
 */
const RUBRIC = [
  {
    key: 'structure',
    name: '结构完整',
    weight: 20,
    test(a) {
      const c = a.coverage;
      const n = [c.context, c.task, c.action, c.result].filter(Boolean).length;
      return { hit: n >= 3, detail: n + '/4 要素（情境/任务/行动/结果）' };
    },
  },
  {
    key: 'specific',
    name: '细节具体',
    weight: 20,
    test(a) {
      const nums = a.metrics.length;
      const tech = a.tech.length;
      /* 假设性/设计类回答本来就没有数字，有具体技术选型 + 理由也算具体 */
      const design = a.hypothetical && tech >= 1 && a.coverage.context;
      return {
        hit: nums > 0 || tech >= 2 || design,
        detail: nums
          ? nums + ' 处量化数字'
          : tech
          ? tech + ' 个具体技术名词'
          : design
          ? '方案具体（技术选型 + 理由）'
          : '无具体名词或数字',
      };
    },
  },
  {
    key: 'ownership',
    name: '个人贡献清晰',
    weight: 20,
    test(a) {
      return { hit: a.coverage.self, detail: a.coverage.self ? '有第一人称 + 动作' : '看不出个人做了什么' };
    },
  },
  {
    key: 'obstacle',
    name: '有攻坚过程',
    weight: 15,
    test(a) {
      return { hit: a.coverage.obstacle, detail: a.coverage.obstacle ? '提到阻碍与解决' : '全程顺利，缺少阻碍' };
    },
  },
  {
    key: 'relevance',
    name: '扣题',
    weight: 15,
    test(a) {
      return { hit: !a.echoes, detail: a.echoes ? '大量复述题干' : '围绕题目作答' };
    },
  },
  {
    key: 'noFiller',
    name: '无空泛套话',
    weight: 10,
    test(a) {
      return { hit: a.vague.length === 0, detail: a.vague.length ? '出现「' + a.vague.slice(0, 3).join('、') + '」' : '无空泛限定词' };
    },
  },
];

/* ---------------------------------------------------------------- 提示词 */

const JUDGE_SYSTEM = [
  '你是严格的中文面试评分官。只输出一个 JSON 对象：',
  '{"score":0到100整数,"evidence":["引用候选人原话的片段1","片段2"],',
  '"comment":"不超过70字的评语，必须指向 evidence 里的原话","flagged":布尔,"missing":["缺失的要点"]}',
  '评分标准：结构完整（情境-任务-行动-结果）、有具体数字与技术名词、个人贡献清晰为高分；',
  '空泛套话、模板化背诵、复述题目、答非所问给低分且 flagged=true。',
  'evidence 必须是回答里【原样出现】的片段，不得改写。除 JSON 外不要输出任何内容。',
].join('\n');

/* ---------------------------------------------------------------- 主评判 */

/**
 * 评判一条回答。
 * @param {{question:string, answer:string, facts?:object, dim?:string, material?:string}} ctx
 * @returns {Promise<{score:number, comment:string, flagged:boolean,
 *                    evidence:string[], rubric:Array, coverage:object,
 *                    probe:object, source:'llm'|'rule'}>}
 */
async function judge(ctx) {
  const answer = String(ctx.answer || '');
  const question = String(ctx.question || '');
  const facts = ctx.facts || null;
  const analysis = followup.analyze({ question, answer, facts });

  /* 收集证据素材 */
  const evidencePool = collectEvidence(answer, facts);
  /* 注意：followup.analyze() 不返回 metrics/tech，这里单独抽取，别去猜字段名 */
  const metrics = resume.findMetrics(answer);
  const techs = resume.findTech(answer);

  const deterministic = ruleJudge({ question, answer, analysis, facts, evidencePool });

  if (!llm.enabled()) return deterministic;

  try {
    const d = await llm.withTimeout(
      llm.chatJSON({
        system: JUDGE_SYSTEM,
        user: [
          '【考察维度】' + (ctx.dim ? (ctx.dim === 'communication' ? '沟通表达' : ctx.dim === 'learning' ? '学习能力' : '执行落地') : '综合'),
          '【题目】' + question,
          ctx.material ? '【阅读材料】' + ctx.material : '',
          '【候选人回答】\n' + answer.slice(0, 2000),
          '【已检测到的事实】' + JSON.stringify({
            字数: analysis.len,
            覆盖: analysis.coverage,
            量化数字: metrics.map((m) => m.raw).slice(0, 5),
            技术名词: techs.map((t) => t.name).slice(0, 6),
            空泛词: analysis.vague,
            复述题目: analysis.echoes,
          }),
        ]
          .filter(Boolean)
          .join('\n'),
        temperature: 0.2,
      }),
      25000,
      'judge'
    );

    const score = Math.round(Number(d && d.score));
    if (!Number.isFinite(score)) return deterministic;

    /* 只保留真正出现在原文里的证据，防止模型编造引用 */
    const cited = (Array.isArray(d.evidence) ? d.evidence : [])
      .map((s) => String(s || '').trim())
      .filter((s) => s.length >= 4 && answer.includes(s))
      .slice(0, 4);

    return {
      score: clamp(score),
      comment: String((d && d.comment) || '').slice(0, 200) || deterministic.comment,
      flagged: Boolean(d && d.flagged),
      evidence: cited.length ? cited : deterministic.evidence,
      rubric: deterministic.rubric,
      coverage: analysis.coverage,
      probe: analysis.probe,
      missing: Array.isArray(d && d.missing) ? d.missing.map(String).slice(0, 4) : deterministic.missing,
      source: 'llm',
    };
  } catch (e) {
    noteFailure('judge', e);
    return deterministic;
  }
}

function clamp(n) {
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * 证据抽取：从回答里摘出"能证明他做了事"的原句。
 * 优先带数字的、带技术名词的、带动作动词的。
 */
function collectEvidence(answer, facts) {
  const clauses = resume.splitClauses(answer).filter((c) => c.length >= 6);
  const scored = clauses.map((c) => {
    const m = resume.findMetrics(c).length;
    const t = resume.findTech(c).length;
    const a = followup.ACTION_VERBS.filter((v) => c.includes(v)).length;
    const ob = resume.OBSTACLE_MARKERS.filter((v) => c.includes(v)).length;
    return { c, s: m * 4 + t * 2 + a * 2 + ob * 2 + Math.min(3, Math.floor(c.length / 25)) };
  });
  scored.sort((x, y) => y.s - x.s);
  return scored.filter((x) => x.s > 0).slice(0, 6).map((x) => (x.c.length > 40 ? x.c.slice(0, 40) + '…' : x.c));
}

/**
 * 确定性评判：逐条 rubric 检查证据，算出分数与理由。
 * 分数区间刻意保守 —— 没有具体细节的回答拿不到高分。
 */
function ruleJudge(ctx) {
  const analysis = ctx.analysis;
  const answer = ctx.answer;
  const enriched = Object.assign({}, analysis, {
    metrics: resume.findMetrics(answer),
    tech: resume.findTech(answer),
    hypothetical: Boolean(analysis.hypothetical),
  });

  const rubric = [];
  let got = 0;
  let total = 0;
  for (const r of RUBRIC) {
    const res = r.test(enriched);
    total += r.weight;
    if (res.hit) got += r.weight;
    rubric.push({ key: r.key, name: r.name, hit: res.hit, weight: r.weight, detail: res.detail });
  }

  /* 分数 = 0.7 × rubric 覆盖度 + 0.3 × 具体度。
     单看覆盖度会虚高（结构齐全但内容空洞也能满分），掺入具体度后
     只有"结构完整 + 有数字有细节"才拿得到 90 以上。 */
  let score = Math.round((got / total) * 100 * 0.7 + analysis.specificity * 0.3);

  /* 硬上限：没有具体内容，结构再全也不给高分 */
  if (analysis.len < 25) score = Math.min(score, 25);
  if (analysis.echoes) score = Math.min(score, 35);
  if (analysis.vague.length >= 3) score = Math.min(score, 45);
  if (!analysis.coverage.metric && score > 88) score = 88;
  score = clamp(score);

  const hits = rubric.filter((r) => r.hit).map((r) => r.name);
  const misses = rubric.filter((r) => !r.hit).map((r) => r.name);
  const evidence = ctx.evidencePool && ctx.evidencePool.length ? ctx.evidencePool.slice(0, 3) : [];

  let comment;
  if (!analysis.len) {
    comment = '未作答，无法评估。';
  } else if (evidence.length) {
    comment =
      '「' + evidence[0] + '」是有效信息，' +
      (hits.length ? '满足了' + hits.slice(0, 2).join('、') : '但结构不足') +
      (misses.length ? '；缺少' + misses.slice(0, 2).join('、') + '。' : '。');
  } else {
    comment = '回答里没有可核查的具体事实' + (misses.length ? '，缺少' + misses.slice(0, 3).join('、') : '') + '。';
  }

  return {
    score,
    comment: comment.slice(0, 200),
    flagged: analysis.echoes || analysis.vague.length >= 3 || analysis.len < 20,
    evidence,
    rubric,
    coverage: analysis.coverage,
    probe: analysis.probe,
    missing: misses.slice(0, 4),
    source: 'rule',
  };
}

/**
 * 批量评判（第二轮 / HR 复盘用）。
 * 串行避免打爆 API 限流。
 */
async function judgeAll(items) {
  const out = [];
  for (const it of items) {
    try {
      out.push(await judge(it));
    } catch (e) {
      out.push({ score: 0, comment: '评估失败：' + e.message, flagged: true, evidence: [], rubric: [], coverage: {}, probe: {}, missing: [], source: 'rule' });
    }
  }
  return out;
}

/**
 * 第一轮整体洞察：给 HR 看的"这个人在哪强、哪弱、哪可疑"。
 * 纯确定性，不需要 LLM。
 */
function insight(judgments, facts) {
  if (!judgments || !judgments.length) {
    return { summary: '无有效作答。', strengths: [], weaknesses: [], suspicious: [], score: 0 };
  }
  const avg = Math.round(judgments.reduce((a, j) => a + (j.score || 0), 0) / judgments.length);
  const tally = {};
  for (const j of judgments) {
    for (const r of j.rubric || []) {
      if (!tally[r.key]) tally[r.key] = { name: r.name, hit: 0, total: 0 };
      tally[r.key].total++;
      if (r.hit) tally[r.key].hit++;
    }
  }
  const dims = Object.values(tally).map((t) => ({ name: t.name, rate: Math.round((t.hit / t.total) * 100) }));
  dims.sort((a, b) => b.rate - a.rate);

  const strengths = dims.filter((d) => d.rate >= 70).slice(0, 3).map((d) => d.name + '（' + d.rate + '%）');
  const weaknesses = dims.filter((d) => d.rate < 50).slice(-3).map((d) => d.name + '（' + d.rate + '%）');
  const suspicious = judgments
    .map((j, i) => (j.flagged ? { idx: i + 1, why: (j.comment || '').slice(0, 60) } : null))
    .filter(Boolean)
    .slice(0, 4);

  const parts = ['综合 ' + avg + ' 分'];
  if (strengths.length) parts.push('稳定表现在' + strengths.join('、'));
  if (weaknesses.length) parts.push('明显短板是' + weaknesses.join('、'));
  if (suspicious.length) parts.push('第 ' + suspicious.map((s) => s.idx).join('、') + ' 题回答可疑（模板化或空泛）');
  if (facts && facts.gaps.length) parts.push('简历提到但未验证：' + facts.gaps.slice(0, 3).map((g) => g.tech).join('、'));

  return {
    summary: parts.join('；') + '。',
    strengths,
    weaknesses,
    suspicious,
    score: avg,
  };
}

module.exports = { judge, judgeAll, insight, ruleJudge, collectEvidence, RUBRIC, diagnostics, noteFailure };
