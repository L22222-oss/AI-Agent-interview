'use strict';
/**
 * 简历结构化抽取。
 *
 * 目标：把一段自由文本简历拆成"可以被追问的事实"。
 * 出题和评判都靠这些事实锚定，而不是靠模板槽位。
 *
 * 抽出来的东西：
 *   projects[]  {name, clause, tech[], metrics[], claims[], score}
 *   tech[]      技术名词（带分类）
 *   metrics[]   {raw, value, unit, clause}  —— 量化指标
 *   claims[]    {verb, object, clause}      —— 主导性/贡献度断言
 *   gaps[]      {tech}                      —— 简历提到但没有任何证据的技术
 *
 * 纯正则 + 词典，无外部依赖，确定性可复现。
 */

/* ---------------------------------------------------------------- 词典 */

const TECH = [
  // 语言
  ['Python', '语言'], ['Java', '语言'], ['JavaScript', '语言'], ['TypeScript', '语言'],
  ['C++', '语言'], ['C#', '语言'], ['Go', '语言'], ['Golang', '语言'], ['Rust', '语言'],
  ['PHP', '语言'], ['Ruby', '语言'], ['Swift', '语言'], ['Kotlin', '语言'], ['SQL', '语言'],
  ['Shell', '语言'], ['Scala', '语言'], ['R', '语言'], ['MATLAB', '语言'],
  // 前端
  ['React', '前端'], ['Vue', '前端'], ['Angular', '前端'], ['Svelte', '前端'],
  ['uni-app', '前端'], ['Taro', '前端'], ['小程序', '前端'], ['Electron', '前端'],
  ['Webpack', '前端'], ['Vite', '前端'], ['Three.js', '前端'], ['ECharts', '前端'],
  ['HTML', '前端'], ['CSS', '前端'], ['Tailwind', '前端'],
  // 后端
  ['Node.js', '后端'], ['Express', '后端'], ['Koa', '后端'], ['NestJS', '后端'],
  ['Spring', '后端'], ['SpringBoot', '后端'], ['Spring Boot', '后端'], ['Django', '后端'],
  ['Flask', '后端'], ['FastAPI', '后端'], ['Gin', '后端'], ['MyBatis', '后端'],
  // 数据
  ['MySQL', '数据'], ['PostgreSQL', '数据'], ['MongoDB', '数据'], ['Redis', '数据'],
  ['Elasticsearch', '数据'], ['ClickHouse', '数据'], ['SQLite', '数据'], ['Kafka', '数据'],
  ['RabbitMQ', '数据'], ['RocketMQ', '数据'], ['HBase', '数据'], ['Hive', '数据'],
  // 基础设施
  ['Docker', '基础设施'], ['Kubernetes', '基础设施'], ['K8s', '基础设施'], ['Linux', '基础设施'],
  ['Nginx', '基础设施'], ['Git', '基础设施'], ['Jenkins', '基础设施'], ['CI/CD', '基础设施'],
  ['AWS', '基础设施'], ['阿里云', '基础设施'], ['腾讯云', '基础设施'], ['Prometheus', '基础设施'],
  // AI / 算法
  ['PyTorch', 'AI'], ['TensorFlow', 'AI'], ['Keras', 'AI'], ['Transformers', 'AI'],
  ['LangChain', 'AI'], ['RAG', 'AI'], ['LLM', 'AI'], ['大模型', 'AI'], ['Fine-tune', 'AI'],
  ['OpenCV', 'AI'], ['Pandas', 'AI'], ['NumPy', 'AI'], ['Scikit-learn', 'AI'],
  // 移动端 / 其他
  ['Android', '移动端'], ['iOS', '移动端'], ['Flutter', '移动端'], ['React Native', '移动端'],
  ['Frida', '安全'], ['IDA', '安全'], ['Ghidra', '安全'],
];

const TECH_INDEX = TECH.map(([name, cat]) => ({ name, cat, lower: name.toLowerCase() }));

/** 主导性 / 贡献度断言动词，按"份量"排序。 */
const CLAIM_VERBS = [
  '从0到1', '从零到一', '主导', '牵头', '负责', '独立完成', '独立开发', '独立设计',
  '重构', '优化', '设计并实现', '搭建', '落地', '上线', '实现', '开发', '参与', '协助',
];

/** 项目名词后缀。 */
const PROJECT_SUFFIX = '(?:项目|平台|系统|小程序|工具|应用|服务|后台|中台|网站|APP|App|app|引擎|框架|组件库|SDK)';

/** 量化指标：阿拉伯数字 + 单位，以及中文"百分之X"。 */
const METRIC_PATTERNS = [
  /(\d+(?:\.\d+)?)\s*(%|％|倍|万|千|亿|人|天|小时|分钟|秒|ms|毫秒|GB|MB|TB|QPS|qps|TPS|次|条|个|款|篇|行)/g,
  /百分之([零一二三四五六七八九十百千两\d]+)/g,
  /\b(\d+(?:\.\d+)?)\s*(x|times)\b/gi,
];

/** 空泛词：出现在回答里说明没给具体信息。 */
const VAGUE_MARKERS = [
  '大概', '可能', '应该', '差不多', '之类的', '等等', '一些', '比较好', '还行',
  '还可以', '基本上', '反正', '差不多吧', '应该是', '估计', '略微', '稍微', '有点',
  '相对', '比较', '挺多', '很多', '不少',
];

/** 障碍/攻坚词：说明回答了"难在哪"。 */
const OBSTACLE_MARKERS = [
  '难点', '问题', '卡住', '踩坑', '坑', 'bug', 'Bug', '失败', '报错', '超时', '崩溃',
  '冲突', '瓶颈', '不兼容', '性能', '泄漏', '死锁', '脏数据', '回归', '故障', '事故',
];

/** 结果词：说明给了收束。 */
const RESULT_MARKERS = [
  '结果', '最终', '最后', '上线', '交付', '完成', '提升', '降低', '下降', '增长',
  '减少', '缩短', '通过率', '成功率', '零', '达到', '实现',
];

/** 第一人称承担词：判断是不是"我做的"。 */
const SELF_MARKERS = ['我', '本人'];

/* ---------------------------------------------------------------- 工具 */

function norm(s) {
  return String(s == null ? '' : s);
}

/** 按句读切分子句，保留原顺序。 */
function splitClauses(text) {
  return norm(text)
    .split(/[。；！？\n\r]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

function findTech(text) {
  const t = norm(text);
  const lower = t.toLowerCase();
  const hits = [];
  for (const item of TECH_INDEX) {
    let idx = lower.indexOf(item.lower);
    while (idx >= 0) {
      /* 英文技术名要求词边界，避免 Go 命中 Google、R 命中 Redis */
      if (/^[a-z0-9.+#/ -]+$/i.test(item.name)) {
        const before = idx === 0 ? '' : lower[idx - 1];
        const after = lower[idx + item.lower.length] || '';
        const boundaryOk = !/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after);
        if (!boundaryOk) { idx = lower.indexOf(item.lower, idx + 1); continue; }
      }
      hits.push({ name: item.name, cat: item.cat, at: idx });
      break;
    }
  }
  /* 去重保序 */
  const seen = new Set();
  return hits
    .sort((a, b) => a.at - b.at)
    .filter((h) => {
      const k = h.name.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map(({ name, cat }) => ({ name, cat }));
}

function findMetrics(text) {
  const t = norm(text);
  const out = [];
  for (const re of METRIC_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t)) !== null) {
      const raw = m[0];
      out.push({
        raw,
        value: m[1],
        unit: m[2] || '',
        at: m.index,
      });
      if (out.length > 40) break;
    }
  }
  const seen = new Set();
  return out
    .sort((a, b) => a.at - b.at)
    .filter((x) => {
      if (seen.has(x.raw)) return false;
      seen.add(x.raw);
      return true;
    });
}

function findClaims(text) {
  const t = norm(text);
  const out = [];
  for (const verb of CLAIM_VERBS) {
    const i = t.indexOf(verb);
    if (i < 0) continue;
    /* 取动词后 2-14 个字符作为宾语 */
    const rest = t.slice(i + verb.length).replace(/^[的了，,、\s]+/, '');
    const obj = rest.slice(0, 14).replace(/[，,。；;：:].*$/, '').trim();
    out.push({ verb, object: obj, at: i });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** 抽项目名：优先「」引号，其次"XX项目/平台/系统"名词块。 */
function findProjects(text) {
  const t = norm(text);
  const names = [];

  const quoted = /[「『"“]([^」』"”]{2,30})[」』"”]/g;
  let m;
  while ((m = quoted.exec(t)) !== null) names.push({ name: m[1], at: m.index, from: 'quoted' });

  const re = new RegExp('([\\u4e00-\\u9fa5A-Za-z0-9_.\\-]{2,20}' + PROJECT_SUFFIX + ')', 'g');
  while ((m = re.exec(t)) !== null) {
    names.push({ name: m[1], at: m.index, from: 'suffix' });
  }

  const seen = new Set();
  return names
    .sort((a, b) => a.at - b.at)
    .filter((x) => {
      const k = x.name.replace(/\s+/g, '');
      if (k.length < 2 || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

/* ---------------------------------------------------------------- 主解析 */

/**
 * 解析简历。
 * @param {string} resume
 * @returns {{clauses:Array, tech:Array, metrics:Array, claims:Array,
 *            projects:Array, gaps:Array, length:number, hasNumbers:boolean}}
 */
function parse(resume) {
  const text = norm(resume);
  const clauses = splitClauses(text);
  const tech = findTech(text);
  const metrics = findMetrics(text);

  /* 逐子句打标，供出题时引用原句 */
  const annotated = clauses.map((clause, i) => {
    const cTech = findTech(clause);
    const cMetrics = findMetrics(clause);
    const cClaims = findClaims(clause);
    /* 技能罗列句（一串技术名、没有动词也没有数字）不该被当成"经历" */
    const isSkillList = cTech.length >= 3 && cClaims.length === 0 && cMetrics.length === 0;
    const density =
      cTech.length * 1 +
      cMetrics.length * 6 +
      cClaims.length * 4 +
      Math.min(3, Math.floor(clause.length / 40)) -
      (isSkillList ? 6 : 0);
    return {
      i,
      clause,
      tech: cTech,
      metrics: cMetrics,
      claims: cClaims,
      isSkillList,
      density,
    };
  });

  /* 项目：把项目名挂到包含它的子句上 */
  const projNames = findProjects(text);
  const projects = projNames.map((p) => {
    const host =
      annotated.find((a) => a.clause.includes(p.name)) ||
      annotated.slice().sort((a, b) => b.density - a.density)[0];
    return {
      name: p.name,
      clause: host ? host.clause : '',
      tech: host ? host.tech : [],
      metrics: host ? host.metrics : [],
      claims: host ? host.claims : [],
      score: (host ? host.density : 0) + (p.from === 'quoted' ? 1 : 0),
    };
  }).sort((a, b) => b.score - a.score);

  /* 无证据技能：全文出现过，但没有任何子句把它和"做过什么"绑起来 */
  const evidenceClauses = annotated.filter((a) => a.claims.length > 0 || a.metrics.length > 0);
  const gaps = tech
    .filter((t) => !evidenceClauses.some((a) => a.tech.some((x) => x.name === t.name)))
    .map((t) => ({ tech: t.name, cat: t.cat }));

  return {
    clauses: annotated,
    tech,
    metrics,
    claims: findClaims(text),
    projects,
    gaps,
    length: text.length,
    hasNumbers: metrics.length > 0,
  };
}

/* ---------------------------------------------------------------- 派生 */

/** 信息密度最高的子句（用来出"展开讲讲"的题）。 */
function topClause(facts) {
  if (!facts || !facts.clauses.length) return null;
  return facts.clauses.slice().sort((a, b) => b.density - a.density)[0];
}

/**
 * 最值得"展开讲"的经历句：优先同时有动作断言和量化数字的，
 * 其次有数字的，再次有断言的，最后才按密度。技能罗列句排除。
 */
function projectClause(facts) {
  if (!facts || !facts.clauses.length) return null;
  const cand = facts.clauses.filter((c) => !c.isSkillList);
  const pool = cand.length ? cand : facts.clauses;
  const rank = (c) => {
    let r = 0;
    if (c.claims.length && c.metrics.length) r += 100;
    else if (c.metrics.length) r += 60;
    else if (c.claims.length) r += 40;
    if (c.claims.some((x) => ['主导', '牵头', '负责', '独立完成', '独立开发', '独立设计'].includes(x.verb))) r += 15;
    return r + c.density;
  };
  return pool.slice().sort((a, b) => rank(b) - rank(a))[0];
}

/** 最值得追问的量化指标：优先"从 A 到 B"这种对比型。 */
function bestMetric(facts) {
  if (!facts || !facts.metrics.length) return null;
  const withClause = facts.clauses
    .filter((c) => c.metrics.length)
    .sort((a, b) => b.metrics.length - a.metrics.length);
  if (!withClause.length) return null;
  const host = withClause[0];
  return { metric: host.metrics[0], clause: host.clause, all: host.metrics };
}

/** 最有份量的贡献度断言。 */
function bestClaim(facts) {
  if (!facts || !facts.claims.length) return null;
  const weight = (v) => CLAIM_VERBS.length - CLAIM_VERBS.indexOf(v);
  return facts.claims.slice().sort((a, b) => weight(b.verb) - weight(a.verb))[0];
}

/** 需要补证据的技术（优先非常见语言类）。 */
function gapTech(facts, exclude) {
  if (!facts || !facts.gaps.length) return null;
  const ex = new Set((exclude || []).map((s) => String(s).toLowerCase()));
  const cand = facts.gaps.filter((g) => !ex.has(g.tech.toLowerCase()));
  return cand[0] || null;
}

module.exports = {
  parse,
  splitClauses,
  findTech,
  findMetrics,
  findClaims,
  findProjects,
  topClause,
  projectClause,
  bestMetric,
  bestClaim,
  gapTech,
  TECH,
  CLAIM_VERBS,
  VAGUE_MARKERS,
  OBSTACLE_MARKERS,
  RESULT_MARKERS,
  SELF_MARKERS,
};
