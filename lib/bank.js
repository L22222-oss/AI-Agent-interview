'use strict';
/**
 * 内置题库 —— 第一轮简历问答 + 第二轮三维能力题。
 * 结构与目标站点一致：每题带 2-3 组考察要点（expects），组内命中任一关键词即得分。
 */

const R1_BANK = [
  {
    text: '请具体介绍你在{skills}中的职责和你完成的主要工作，说说你做了什么、怎么做的。',
    expects: [
      ['项目', '开发', '实现', '负责'],
      ['设计', '搭建', '优化', '上线'],
      ['结果', '效果', '数据', '提升'],
    ],
  },
  {
    text: '简历里提到「{project}」，请展开讲讲这个项目的背景、你的角色和最终结果。',
    expects: [
      ['背景', '需求', '目标'],
      ['负责', '参与', '主导', '承担'],
      ['结果', '效果', '上线', '数据', '提升'],
    ],
  },
  {
    text: '你简历中写了{skill}，请结合一个具体场景说明你是如何使用它的，遇到过什么难点、怎么解决的。',
    expects: [
      ['场景', '项目', '业务', '功能'],
      ['难点', '问题', '解决', '排查', '复盘'],
      ['结果', '效果', '提升', '优化'],
    ],
  },
  {
    text: '针对{job}这个岗位，你认为自己的优势与不足分别是什么？打算如何补足不足？',
    expects: [
      ['优势', '擅长', '熟悉'],
      ['不足', '欠缺', '短板'],
      ['计划', '学习', '提升', '补足'],
    ],
  },
  {
    text: '描述一次你与同学/同事在协作中出现分歧的经历，你是如何沟通并推进落地的？',
    expects: [
      ['分歧', '冲突', '意见'],
      ['沟通', '讨论', '对齐'],
      ['落地', '解决', '推进', '结果'],
    ],
  },
  {
    text: '围绕{skill}，请讲一个你最近主动学习并应用的新知识：为什么学、怎么学、用在了哪里？',
    expects: [
      ['学习', '了解', '研究', '阅读'],
      ['因为', '需求', '兴趣', '项目'],
      ['应用', '实践', '使用', '落地'],
    ],
  },
];

/** 第二轮：沟通 → 学习 → 执行，每题可带现场阅读材料。 */
const R2_BANK = [
  {
    dim: 'communication',
    text: '请简要介绍你自己，以及你为什么对{job}这个岗位感兴趣。',
    material: '',
  },
  {
    dim: 'communication',
    text: '请用 STAR 结构讲一段你真实经历：说明当时的情境、你的任务、你采取的行动和最终结果。',
    material: '',
  },
  {
    dim: 'learning',
    text: '阅读完上面的材料后，请用自己的话解释：{concept}解决了什么问题？同时会带来哪两个新问题？',
    material:
      '某团队为提升服务稳定性引入「消息队列」：上游服务把任务写入队列后立即返回，下游服务按自己的节奏从队列中取出任务处理。好处是削峰填谷、失败可重试；代价是链路变长，需要额外处理消息重复与顺序问题。',
  },
  {
    dim: 'learning',
    text: '请举一个你快速学会陌生知识或工具的亲身例子，说明你如何从「看懂」走到「会用」，以及如何验证自己真的学会了。',
    material: '',
  },
  {
    dim: 'execution',
    text: '如果让你负责一项时间紧、依赖多、资源有限的任务，你会如何拆解与排期？请结合真实经历说明。',
    material: '',
  },
  {
    dim: 'execution',
    text: '描述一次你推动的事情中途出问题的经历：你当时如何补救、事后如何复盘、最终结果如何？',
    material: '',
  },
];

/** 题库模板填充需要的槽位。 */
const GENERIC_FILL = [
  { text: '请完整介绍一段你参与时间最长的项目或实习：背景、你的角色、做了什么、结果如何。', expects: [['项目', '实习', '比赛'], ['负责', '参与', '完成'], ['结果', '成果', '上线', '提升']] },
  { text: '你是如何快速掌握一项新技能或新工具的？请举一个具体例子说明学习过程和应用效果。', expects: [['学习', '掌握', '入门'], ['因为', '需求', '项目'], ['应用', '实践', '使用']] },
  { text: '描述一次你在压力或截止日期下完成任务的经历，你是如何安排和执行的？最终结果如何？', expects: [['时间', '压力', '截止'], ['计划', '安排', '拆解'], ['完成', '交付', '结果']] },
  { text: '请介绍你最有代表性的成果或作品，并说明它解决了什么问题、带来了什么价值。', expects: [['作品', '成果', '奖项'], ['问题', '需求', '痛点'], ['价值', '效果', '提升']] },
];

const SKILL_WORDS = [
  'Python', 'Java', 'JavaScript', 'TypeScript', 'C++', 'Go', 'Rust', 'SQL',
  'React', 'Vue', 'Node.js', 'Docker', 'Kubernetes', 'Linux', 'Git', 'MySQL',
  'Redis', 'PyTorch', 'TensorFlow', 'Spring', 'Django', 'Flask', 'Frida',
];

function pickSkills(resume, n) {
  const hit = SKILL_WORDS.filter((s) => resume.toLowerCase().includes(s.toLowerCase()));
  if (hit.length >= n) return hit.slice(0, n);
  return hit.concat(SKILL_WORDS.slice(0, n - hit.length));
}

/** 从简历里抠一个"项目名"：优先书名号/引号包裹，其次最长中文名词块。 */
function pickProject(resume) {
  const quoted = resume.match(/[「『"“]([^」』"”]{2,30})[」』"”]/);
  if (quoted) return quoted[1];
  const en = resume.match(/\b([A-Za-z][A-Za-z0-9_.\- ]{3,24})\b/g);
  if (en && en.length) return en.sort((a, b) => b.length - a.length)[0].trim();
  const zh = resume.match(/[\u4e00-\u9fa5]{4,16}(?:项目|平台|系统|工具|小程序|应用)/g);
  if (zh && zh.length) return zh[0];
  return '你的核心项目';
}

/**
 * 生成第一轮题目（确定性通道）。
 * @param {{jobName:string, resume:string, count:number}} ctx
 */
function buildRound1(ctx) {
  const resume = String(ctx.resume || '');
  const count = ctx.count || 6;
  const skills = pickSkills(resume, 2);
  const project = pickProject(resume);
  const job = ctx.jobName || '该';
  const vars = { skills: skills.join('、'), project, job, skill: skills[0], concept: '这个机制' };

  const out = [];
  for (let i = 0; i < count; i++) {
    const tpl = R1_BANK[i % R1_BANK.length];
    const text = tpl.text.replace(/\{(\w+)\}/g, (_, k) => vars[k] || k);
    out.push({ text, expects: tpl.expects.map((g) => g.slice()) });
  }
  return out;
}

function buildRound2(ctx) {
  const count = ctx.count || 6;
  const job = ctx.jobName || '该';
  const out = [];
  for (let i = 0; i < count; i++) {
    const tpl = R2_BANK[i % R2_BANK.length];
    out.push({
      text: tpl.text.replace(/\{(\w+)\}/g, (_, k) => (k === 'job' ? job : tpl.material ? '这个机制' : k)),
      dim: tpl.dim,
      material: tpl.material,
    });
  }
  return out;
}

module.exports = { R1_BANK, R2_BANK, GENERIC_FILL, buildRound1, buildRound2, pickSkills, pickProject };
