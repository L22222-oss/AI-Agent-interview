'use strict';
/**
 * AI 全程面试 —— 由智能体自己主持的一轮面试。
 *
 * 与"标准流程"的区别：
 *   标准流程：题量写死 6 题，答完即止，追问上限 2 次 → 是表单
 *   全程面试：每一轮都做 评判 → 决策 → 出题，题量与结束时机由智能体自己判断
 *
 * 循环（每一步都落库，可断点续答）：
 *
 *   候选人作答
 *      ↓
 *   评分官 judge()      给分 + 原文证据 + 缺失项
 *      ↓
 *   决策 decide()       ① 证据够了 → 收尾
 *                       ② 连续两题无效 → 提前收尾
 *                       ③ 有明显缺口 → 追问
 *                       ④ 否则 → 换一个未考察的角度
 *      ↓
 *   出题官 nextQuestion() 带着缺口和已有问答生成下一题
 *
 * 关键：结束条件不是"答满 N 题"，而是"证据够不够"。所以有人 4 题就结束，
 * 有人要问到 8 题 —— 这才是面试官的行为。
 */

const resume = require('./resume');
const followup = require('./followup');
const agent = require('./agent');
const judge = require('./judge');

const DEFAULT_MAX_TURNS = 8;
const MAX_PROBES = 3;          // 全程面试允许的追问总数（比标准流程宽）
const STRONG_SCORE = 70;       // 算"有效作答"的分数线

/* ---------------------------------------------------------------- 建档 */

/**
 * 开一场 AI 面试。
 * @param {{resume:string, jobName?:string, jd?:string, maxTurns?:number}} ctx
 * @returns {Promise<object>} session
 */
async function start(ctx) {
  const text = String(ctx.resume || '');
  if (text.trim().length < 20) throw new Error('简历正文至少 20 字');

  const facts = resume.parse(text);
  const session = {
    id: null,
    jobName: ctx.jobName || '该岗位',
    jd: ctx.jd || '',
    resume: text,
    facts: {
      projects: facts.projects.slice(0, 8).map((p) => p.name),
      tech: facts.tech.map((t) => t.name),
      metrics: facts.metrics.map((m) => m.raw).slice(0, 12),
      gaps: facts.gaps.map((g) => g.tech),
    },
    maxTurns: Math.max(4, Math.min(12, Number(ctx.maxTurns) || DEFAULT_MAX_TURNS)),
    plan: [],                  // 出题官排好的可选角度（长期不变）
    turns: [],                 // [{q, a, judgment, kind, reason}]
    covered: [],               // 已考察的角度
    probes: 0,
    done: false,
    verdict: null,
    createdAt: new Date().toISOString(),
  };

  /* 出题官先把整份"可考察角度"排好，后面每轮从里面取。
     注意：这份计划要长期保存，不能拿"已问过的题"充当计划 ——
     否则意图池会被问过的题目污染，导致反复问同一道题。 */
  session.plan = agent.planRound1({
    facts,
    resume: text,
    jobName: session.jobName,
    jd: session.jd,
    count: session.maxTurns,
  });

  /* 第一题：出题官按简历排的第一个角度 */
  const first = await agent.nextQuestion({
    round: 1,
    idx: 0,
    jobName: session.jobName,
    jd: session.jd,
    resume: text,
    facts,
    intents: session.plan,
    questions: [],
    answers: [],
    probeCount: 0,
    probesAsked: [],
    usedIntents: [],
  });

  session.turns.push({ q: first.text, a: '', judgment: null, kind: first.kind, reason: first.basis, expects: first.expects });
  return session;
}

/* ---------------------------------------------------------------- 决策 */

/**
 * 核心决策：这一步该追、该换角度、还是该收尾。
 * 纯函数，不依赖 LLM —— 所以没有 API 时行为一致、可回归。
 *
 * @returns {{action:'finish'|'probe'|'advance', reason:string, kind?:string}}
 */
function decide(session, judgment, analysis) {
  const turns = session.turns.length;               // 已出过的题数
  const answered = session.turns.filter((t) => t.judgment);
  const strong = answered.filter((t) => t.judgment.score >= STRONG_SCORE).length;
  const angles = new Set(session.covered).size;

  /* ① 题量上限 */
  if (turns >= session.maxTurns) {
    return { action: 'finish', reason: '已达到本次面试题量上限（' + session.maxTurns + ' 题）' };
  }

  /* ② 连续两题都拿不到有效信息 —— 再问也没有增量 */
  const lastTwo = answered.slice(-2);
  if (answered.length >= 3 && lastTwo.length === 2 && lastTwo.every((t) => t.judgment.flagged)) {
    return { action: 'finish', reason: '连续两题无法给出有效信息，继续提问不会有新证据' };
  }

  /* ③ 证据已经充分 */
  if (turns >= 4 && strong >= 3 && angles >= 3) {
    return { action: 'finish', reason: '已覆盖 ' + angles + ' 个考察角度、' + strong + ' 段高质量作答，证据充分' };
  }

  /* ④ 有明显缺口且还有追问预算 → 追 */
  const kind = analysis && analysis.probe ? analysis.probe.kind : 'none';
  if (kind !== 'none' && session.probes < MAX_PROBES && !alreadyProbed(session, kind)) {
    return { action: 'probe', reason: analysis.probe.reason, kind };
  }

  /* ⑤ 换一个没考察过的角度 */
  return { action: 'advance', reason: '该角度已取得足够证据，换下一个方向' };
}

/** 同一种缺口不追第二次，避免原地打转。 */
function alreadyProbed(session, kind) {
  return session.turns.some((t) => String(t.kind || '') === 'probe:' + kind);
}

/* ---------------------------------------------------------------- 推进一步 */

/**
 * 提交一条回答，返回评判 + 下一步。
 * @param {object} session
 * @param {string} answer
 * @returns {Promise<{judgment:object, done:boolean, question?:object, decision:object, progress:object}>}
 */
async function step(session, answer) {
  if (session.done) return { judgment: null, done: true, decision: { action: 'finish', reason: '本场面试已结束' }, progress: progressOf(session) };

  const cur = session.turns[session.turns.length - 1];
  const text = String(answer || '');
  cur.a = text;

  /* 1) 评判这一题 */
  const judgment = await judge.judge({
    question: cur.q,
    answer: text,
    dim: cur.dim,
    material: cur.material,
    facts: resume.parse(session.resume),
  });
  cur.judgment = judgment;

  /* 2) 记下这个角度已经考过 */
  const angle = String(cur.kind || '').replace(/^probe:/, '');
  if (angle && angle !== 'unknown' && angle !== 'fill') {
    if (!session.covered.includes(angle)) session.covered.push(angle);
  }
  if (String(cur.kind || '').startsWith('probe:')) session.probes += 1;

  /* 3) 分析这条回答，供决策与出题使用。
        传入本题的 kind —— 分析器据此只查"这道题该有的维度"，
        否则问"怎么统计的"却去追"最后上线了吗"，就是问错方向。 */
  const analysis = followup.analyze({
    question: cur.q,
    answer: text,
    facts: resume.parse(session.resume),
    kind: cur.kind,
  });

  /* 4) 决策 */
  const decision = decide(session, judgment, analysis);

  if (decision.action === 'finish') {
    session.done = true;
    session.verdict = finalize(session);
    return { judgment, done: true, decision, progress: progressOf(session), verdict: session.verdict };
  }

  /* 5) 出下一题。
        allowProbe 由 decide() 决定：它说推进，出题官就只换角度不再追。 */
  const qs = session.turns.map((t) => t.q);
  const as = session.turns.map((t) => t.a);
  const next = await agent.nextQuestion({
    round: 1,
    idx: session.turns.length,
    jobName: session.jobName,
    jd: session.jd,
    resume: session.resume,
    facts: resume.parse(session.resume),
    questions: qs,
    answers: as,
    /* 计划是"可选角度"，lastKind 是"上一题实际是什么类型" —— 两者别混 */
    intents: session.plan,
    lastKind: cur.kind,
    allowProbe: decision.action === 'probe',
    probeCount: session.probes,
    probesAsked: session.turns.filter((t) => String(t.kind || '').startsWith('probe:')).map((t) => String(t.kind).replace('probe:', '')),
    usedIntents: session.covered,
  });

  /* 决策说"该追"，但出题官给的是新角度 → 用规则把追问强制拉回来 */
  let finalQ = next;
  if (decision.action === 'probe' && !String(next.kind || '').startsWith('probe:')) {
    const probeText = followup.renderProbe(
      { kind: decision.kind, quote: analysis.probe.quote, vague: analysis.vague },
      session.probes
    );
    if (probeText) {
      finalQ = {
        text: probeText,
        expects: followup.expectsFor(decision.kind),
        kind: 'probe:' + decision.kind,
        basis: decision.reason,
        source: 'rule',
      };
    }
  }

  session.turns.push({
    q: finalQ.text,
    a: '',
    judgment: null,
    kind: finalQ.kind,
    reason: finalQ.basis || decision.reason,
    expects: finalQ.expects,
    decision: decision.action,
  });

  return {
    judgment,
    done: false,
    question: { text: finalQ.text, kind: finalQ.kind, reason: finalQ.basis || decision.reason, expects: finalQ.expects },
    decision,
    progress: progressOf(session),
  };
}

/* ---------------------------------------------------------------- 收尾 */

/**
 * 汇总本场面试。分数、结论、证据全部来自逐题评判，不另起炉灶。
 */
function finalize(session) {
  const answered = session.turns.filter((t) => t.judgment);
  const scores = answered.map((t) => t.judgment.score);
  const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
  const insights = judge.insight(answered.map((t) => t.judgment), resume.parse(session.resume));

  const strong = answered.filter((t) => t.judgment.score >= STRONG_SCORE).length;
  const flagged = answered.filter((t) => t.judgment.flagged).length;

  /* 结论规则：看平均分 + 高质量作答占比 + 可疑占比，不看单一阈值 */
  let verdict;
  if (!answered.length) verdict = '不通过';
  else if (avg >= 70 && strong >= Math.ceil(answered.length / 2) && flagged === 0) verdict = '通过';
  else if (avg >= 60 && flagged <= 1) verdict = '待定';
  else verdict = '不通过';

  const reasons = [];
  reasons.push('共 ' + answered.length + ' 题，平均 ' + avg + ' 分');
  reasons.push('高质量作答 ' + strong + ' 段');
  if (flagged) reasons.push('可疑作答 ' + flagged + ' 段');
  if (insights.weaknesses.length) reasons.push('短板：' + insights.weaknesses.join('、'));

  return {
    score: avg,
    verdict,
    summary: insights.summary,
    reasons,
    strengths: insights.strengths,
    weaknesses: insights.weaknesses,
    suspicious: insights.suspicious,
    turns: answered.length,
    probes: session.probes,
    angles: session.covered.slice(),
  };
}

function progressOf(session) {
  return {
    turns: session.turns.filter((t) => t.judgment).length,
    maxTurns: session.maxTurns,
    probes: session.probes,
    angles: session.covered.slice(),
    done: session.done,
  };
}

/** 给前端看的一份完整记录（不含候选人隐私字段）。 */
function transcript(session) {
  return {
    id: session.id,
    jobName: session.jobName,
    facts: session.facts,
    maxTurns: session.maxTurns,
    done: session.done,
    verdict: session.verdict,
    progress: progressOf(session),
    turns: session.turns.map((t, i) => ({
      idx: i,
      q: t.q,
      a: t.a,
      kind: t.kind,
      reason: t.reason,
      decision: t.decision || null,
      judgment: t.judgment
        ? {
            score: t.judgment.score,
            comment: t.judgment.comment,
            flagged: t.judgment.flagged,
            evidence: t.judgment.evidence,
            missing: t.judgment.missing,
            rubric: t.judgment.rubric,
            source: t.judgment.source,
          }
        : null,
    })),
  };
}

module.exports = {
  start,
  step,
  decide,
  finalize,
  transcript,
  progressOf,
  DEFAULT_MAX_TURNS,
  MAX_PROBES,
  STRONG_SCORE,
};
