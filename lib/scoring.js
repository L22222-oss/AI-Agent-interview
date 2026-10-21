'use strict';
/**
 * 评分引擎 —— 复刻目标站点的确定性评分（内置题库通道）。
 *
 * 结构由证据锁定（18 组 data point 全部吻合）：
 *   logic(单题)    = layer + cause + detail
 *   accuracy(单题) = round(hit / total * 100)
 *   logic(整轮)    = round(mean(logic_i))
 *   accuracy(整轮) = round(mean(accuracy_i))
 *   verdict(第一轮) = logic >= 60 && accuracy >= 40
 *
 * 证据（见 analysis/SCORING-EVIDENCE.md）：
 *   林润泽   details.logic [80,55,55,80,55,55] → mean 63.33 → 63 ✔
 *            details.accuracy[67,67,100,100,100,33] → mean 77.83 → 78 ✔
 *   HELMD探针 details.logic [20,20,20,35,20,20] → mean 22.5 → 23 ✔
 *            details.accuracy[0,0,33,0,0,0]     → mean 5.5  → 6  ✔
 *
 * 分桶（layer / cause / detail）：
 *   - source=bank 通道：分句模型，在 6 组"作答文本 → 分数"上 6/6 完全吻合（eval 有回归断言）。
 *   - source=llm 通道：目标给出不同的分桶结果（同一套文本规则无法复现——例如 3 句无收束词时
 *     它给 15 而分句模型给 40），说明 LLM 通道另有结构判定。该判定无法由单一候选人的向量
 *     唯一确定，已在 analysis/SCORING-EVIDENCE.md 列为显式未知；本复刻两条通道统一用分句模型，
 *     换取可复现与可回归。
 *   权重集中在下面 WEIGHTS 里，可热调。
 */

const WEIGHTS = {
  // 结构层：按语义分句数（。；！？\n 切分）
  //   1 句 → 0；2 句 → 15；>=3 句 → 40；>=3 句且带收束词 → 50
  //   标定集：source=bank 探针 6 题，实测 layer=[0,0,0,15,0,0]，6/6 吻合。
  layer: { none: 0, few: 15, many: 40, manyWithClose: 50, manyAt: 3, fewAt: 2 },
  // 因果层：观测中恒为 10（18/18），阈值化建模
  cause: { none: 0, present: 10, minLen: 20 },
  // 细节层：按作答长度
  detail: { none: 0, short: 10, rich: 30, shortLen: 20, richLen: 60 },
};

const CLOSING = /(最终|综上|总结|复盘|结果|因此|所以|结论|落地|交付|上线后)/;
const SEGMENT_SPLIT = /[。；！？\n]+/;

function countSegments(text) {
  return String(text || '')
    .split(SEGMENT_SPLIT)
    .map((s) => s.trim())
    .filter(Boolean).length;
}

function scoreLayer(answer) {
  const n = countSegments(answer);
  const w = WEIGHTS.layer;
  if (n >= w.manyAt) return CLOSING.test(answer) ? w.manyWithClose : w.many;
  if (n >= w.fewAt) return w.few;
  return w.none;
}

function scoreCause(answer) {
  const w = WEIGHTS.cause;
  return String(answer || '').trim().length >= w.minLen ? w.present : w.none;
}

function scoreDetail(answer) {
  const w = WEIGHTS.detail;
  const len = String(answer || '').trim().length;
  if (len >= w.richLen) return w.rich;
  if (len >= w.shortLen) return w.short;
  return w.none;
}

/** 单题命中：expects 是 2-3 组关键词，命中组内任一关键词即算命中该组。 */
function hitGroups(answer, expects) {
  const text = String(answer || '').toLowerCase();
  const groups = Array.isArray(expects) ? expects : [];
  let hit = 0;
  for (const group of groups) {
    const words = Array.isArray(group) ? group : [group];
    if (words.some((w) => w && text.includes(String(w).toLowerCase()))) hit++;
  }
  return { hit, total: groups.length };
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

/**
 * 第一轮评分。
 * @param {string[]} answers 候选人作答
 * @param {Array<Array<string[]>>} expects 每题考察要点分组
 */
function scoreRound1(answers, expects) {
  const details = [];
  const hits = [];

  for (let i = 0; i < expects.length; i++) {
    const raw = answers && answers[i] != null ? String(answers[i]) : '';
    const answered = raw.trim().length > 0;
    const { hit, total } = hitGroups(raw, expects[i]);
    const layer = answered ? scoreLayer(raw) : 0;
    const cause = answered ? scoreCause(raw) : 0;
    const detail = answered ? scoreDetail(raw) : 0;
    const logic = answered ? layer + cause + detail : 0;
    const accuracy = total ? Math.round((hit / total) * 100) : 0;
    details.push({ answered, layer, cause, detail, logic, hit, total, accuracy });
    hits.push({ hit, total });
  }

  const logic = Math.round(mean(details.map((d) => d.logic)));
  const accuracy = Math.round(mean(details.map((d) => d.accuracy)));
  return {
    scores: { logic, accuracy },
    hits,
    details,
    verdict: logic >= 60 && accuracy >= 40 ? '通过' : '不通过',
  };
}

const DIMS = ['communication', 'learning', 'execution'];

/**
 * 第二轮评分：三维能力（沟通 / 学习 / 执行）。
 * 有 LLM 逐题评估时用评估分聚合；否则用内置题库通道的确定性算法。
 */
function scoreRound2(answers, dims, evals) {
  const scores = { communication: 0, learning: 0, execution: 0 };
  const buckets = { communication: [], learning: [], execution: [] };

  for (let i = 0; i < (dims || []).length; i++) {
    const dim = DIMS.includes(dims[i]) ? dims[i] : 'execution';
    const raw = answers && answers[i] != null ? String(answers[i]) : '';
    const ev = evals && evals[i];
    let s;
    if (ev && Number.isFinite(Number(ev.score))) {
      s = Math.max(0, Math.min(100, Math.round(Number(ev.score))));
    } else {
      // 无 LLM 时的确定性兜底：结构 + 细节 + 命中密度
      const layer = scoreLayer(raw);
      const cause = scoreCause(raw);
      const detail = scoreDetail(raw);
      s = Math.min(100, Math.round((layer + cause + detail) * 1.05));
      if (String(raw).trim().length >= 20) s = Math.max(s, 45);
    }
    buckets[dim].push(s);
  }

  for (const d of DIMS) {
    scores[d] = buckets[d].length ? Math.round(mean(buckets[d])) : 0;
  }

  const avg = Math.round(mean(DIMS.map((d) => scores[d])));
  return {
    scores,
    eval: { avg, verdict: avg >= 60 ? '通过' : '不通过' },
    verdict: avg >= 60 ? '通过' : '不通过',
  };
}

/**
 * 第三关实操作品预评。
 * 公式由一次真实提交标定：reachable=true / note 26 字 / url=http 且路径为 "/"
 *   → 55 + min(15, ceil(26/2)) + 0 + 0 = 68 ✔（目标返回 autoScore=68）
 */
function practiceAutoScore(url, note, reachable) {
  const base = reachable ? 55 : 25;
  const noteBonus = Math.min(15, Math.ceil(String(note || '').trim().length / 2));
  let httpsBonus = 0;
  let pathBonus = 0;
  try {
    const u = new URL(String(url || ''));
    if (u.protocol === 'https:') httpsBonus = 10;
    if (u.pathname && u.pathname !== '/' && u.pathname.length > 1) pathBonus = 10;
  } catch (_) {
    /* 非法 URL 不给加分 */
  }
  const score = base + noteBonus + httpsBonus + pathBonus;
  return Math.max(0, Math.min(100, Math.round(score)));
}

/** 第一轮通过后按第二轮三维结果给 HR 的推进建议。 */
function recommendFor(report) {
  if (report.stage === 'pending') {
    if (report.round1 && report.round1.verdict === '通过') {
      return { action: 'round2', text: '第一轮已通过，建议发送第二轮链接，考察沟通 / 学习 / 执行。' };
    }
    return { action: 'hold', text: '第一轮未达标，可人工改判或结束本次流程。' };
  }
  if (report.stage === 'interviewing') {
    return { action: 'hold', text: '第二轮进行中，等待候选人提交。' };
  }
  if (report.stage === 'practice') {
    if (report.practice && report.practice.url) {
      return { action: 'review', text: '候选人已提交实操作品，请确认得分。' };
    }
    return { action: 'hold', text: '第二轮已通过，等待候选人进入第三关并提交实操作品网址。' };
  }
  if (report.stage === 'evaluated') {
    return { action: 'offer', text: '三关已完成，可发出 Offer。' };
  }
  if (report.stage === 'offer') {
    return { action: 'hold', text: 'Offer 已发出，等待候选人确认。' };
  }
  if (report.stage === 'signing') {
    return { action: 'hold', text: '候选人已接受 Offer，等待电子签约。' };
  }
  return { action: 'done', text: '流程已完结。' };
}

module.exports = {
  WEIGHTS,
  DIMS,
  countSegments,
  scoreLayer,
  scoreCause,
  scoreDetail,
  hitGroups,
  scoreRound1,
  scoreRound2,
  practiceAutoScore,
  recommendFor,
};
