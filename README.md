# 面试智能体 · 复刻版

对 `http://106.54.173.125/` 的完整复刻，附 **REA** 与 **Agent-Reach** 双考核适配层。

三关式 AI 面试管道：简历问答 → 三维能力评估 → 实操交付 → Offer 电子签约。
零依赖 Node 后端 + 单文件前端，`npm start` 直接跑。

```bash
cd D:\deepseek\agent智能体
npm start          # → http://127.0.0.1:3000
npm run eval       # 36 项考核自检
```

打开 http://127.0.0.1:3000 后，两种进法都行：

- **演示账号**：`admin` / `demo1234`（和目标站点首页公开的是同一个）
- **自己注册**：点「注册一个」，账号 3–40 位，只能是英文字母、数字或 `. _ + -`，密码至少 6 位

> **注册/登录出问题？** 先看 [第九节 排错](#九排错注册或登录不了)。

## AI 接入与面试流程

1. 登录管理端，在「账号」页的「AI 接入」选择服务商，填写 OpenAI 兼容 API 的 Base URL、模型名和 API Key，点击「保存配置」后再点「测试连接」。API Key 只保存在服务端 `data/llm.json`，页面仅显示脱敏状态。
2. 回到「岗位」，创建或打开一个岗位卡片。岗位详情包含「面试入口」「候选人」「第三关实操」「AI 准备」四个页签。
3. 在「AI 准备」点击「生成岗位 AI 面试方案」；也可上传候选人简历，生成匹配分析、待核实事实和个性化问题。
4. 将面试入口发给候选人。第一轮首题由模型结合简历生成，后续每次回答都会带着岗位、简历和前序问答请求服务端模型生成追问；第二轮也按真实回答继续出题，并通过模型评估答案。

没有接入模型时，岗位 AI 方案和简历 AI 分析会明确提示配置问题；候选人仍可选择现有内置题库，不会把规则题冒充成模型结果。

### 宝塔部署

Node.js 版本需为 18.17 或更高。宝塔 Node 项目启动目录指向项目根目录，启动命令使用 `npm start`。服务默认监听 `0.0.0.0:3000`；通过宝塔网站反向代理到 `http://127.0.0.1:3000` 后，绑定域名并开启 HTTPS，外部用户访问域名即可进入。

正式公开前，请在宝塔的项目环境变量中设置独立的 `DEMO_PASSWORD`，不要沿用默认演示密码 `demo1234`；也可将其设为空以关闭演示账号，再通过注册创建管理员。确认 `data` 目录可写，并为 `data/llm.json` 做好备份。若直接用公网 IP 和端口访问，则需将 `HOST` 保持为 `0.0.0.0`，并在云安全组和服务器防火墙放行所用端口。

---

## 一、目标站点解析

完整分析见 **[analysis/SITE-ANALYSIS.md](analysis/SITE-ANALYSIS.md)**。

一句话概括它的产品定位（站点原文）：

> 把面试交给 AI，你专注审核与决定。

它不是"AI 帮你出面试题"，是把整条招聘漏斗做成**有状态、可自助、带评分的管道**：

```
第一关 简历问答     AI 依据简历逐题追问，逻辑性 + 准确性两维确定性评分
      ↓ 通过 → 下发 6 位认证码
第二关 三维能力     沟通(2) → 学习(2) → 执行(2)，学习题带现场阅读材料
      ↓ 三维均值 ≥ 60
第三关 实操交付     独立做含前后端的项目并部署公网，提交网址，服务端抓取验活
      ↓
Offer 电子签约      HR 发 Offer → 候选人接受 → 手机手写签名 → 合同生效
```

五个入口靠查询参数分派：管理端 / 候选人端（`?job=`）/ 二轮直达（`?round=2&rid=`）/
Offer 签约（`?offer=`）/ 自助查询（`?portal=`）。**候选人全程免注册**，身份靠"姓名 + 认证码"锚定。

三个技术判断值得记：

1. **评分是确定性算法，不是 LLM 打分**。从 `/api/reports` 的 `details[i].{layer,cause,detail}`
   直接能反推出公式。
2. **三级降级**：服务端 LLM 代理 → 浏览器直连 → 内置题库。任何一环挂了候选人不会卡住。
3. **权限判定在服务端**。`canRound2` / `canPractice` 是后端算好的布尔，前端只用来选按钮。

---

## 二、复刻了什么

### 2.1 完全对齐的部分

| 项 | 状态 |
|---|---|
| 21 个 API 端点（路径/方法/请求体/响应体/错误文案） | 逐字段对齐，见 [analysis/API-CONTRACT.md](analysis/API-CONTRACT.md) |
| 第一轮评分公式 `logic = layer + cause + detail` | 18 组 data point 零反例 |
| 整轮聚合 `round(mean)` | 4 个真实样本复算全中 |
| 通过阈值 `logic ≥ 60 && accuracy ≥ 40` | 6 个样本点全中 |
| 第二轮三维聚合与 `avg ≥ 60` 判定 | 3 个样本点全中 |
| 维度编排 `沟通2 → 学习2 → 执行2` | 逐位对齐 |
| 第三关 `autoScore` 公式 | 单点标定，回代 = 68（目标实测 68） |
| 7 阶段状态机 + 中文名 | 逐字对齐 |
| 6 位认证码 + 姓名自助查询 | 行为对齐 |
| Offer → 接受 → 手写签名 → 签约 | 状态机闭环 |
| SPA 回落（未知路径返回首页） | 行为对齐 |
| 错误文案（`未登录` / `接口不存在` / `简历正文至少 20 字` / …） | 原文对齐 |

### 2.2 有意不同的部分

| 项 | 目标站点 | 本复刻 | 为什么 |
|---|---|---|---|
| LLM 密钥下发 | 浏览器直连云服务的降级路径会把 key 下发前端 | 只保留服务端代理 | 不把密钥交给浏览器 |
| `/api/reports` 数据隔离 | 全量返回，任何成员可看所有岗位所有简历 | 保留同构行为，但 `README` 点名 | 复刻要对齐，缺陷要标注 |
| 评分分桶（LLM 通道） | 另有结构判定，无法从单样本反推 | 统一用分句模型 | 换取可复现可回归，未知已列明 |
| 前端 | 126 KB 单文件 | 自写同构 SPA，同 5 视图同交互 | 不复用其代码，只对齐契约 |

---

## 三、REA 考核适配

**[tools/rea/rea.js](tools/rea/rea.js)** —— 对齐 `vendor/rea`（`morluto/rea`）的真实域模型
`src/domain/evidence.ts`：

```
evidence_id  = "ev_" + sha256(canonicalJson(record 去掉 evidence_id))
authority    ∈ shipped-artifact | controlled-replay | historical-reference
               | external-service | analyst-inference
confidence   ∈ observed | derived | inferred
subject.format ∈ javascript | javascript-bundle | directory | file | unknown | ...
limitations[]  显式执行限制（解释性，不推断覆盖度）
```

关键约束全部实现：

- **canonical JSON**：键按 Unicode 码点排序、无空白、拒绝 `NaN`/`Infinity`
- **evidence_id 可复算**：同内容 → 同 id，改一个字段 → id 变
- **推断必带限制**：`authority === 'analyst-inference'` 的证据 `limitations` 非空
- **未知显式**：不可确定的东西进 `unknowns[]`，不猜

### 三种用法

```bash
node tools/rea/rea.js doctor --json
node tools/rea/rea.js analyze-web-application http://106.54.173.125/ --json
node tools/rea/rea.js analyze-javascript-application ./lib --json
node tools/rea/rea.js mcp          # stdio MCP server（initialize / tools/list / tools/call）
```

### 实测：用它反向分析目标站点

```
verdict=PASS  evidence=6  nodes=25  edges=19
```

抽出来的东西和我人工逆向的结果完全一致：

```
21 个 API 端点   /api/auth/{login,register,logout,session}  /api/interview{,/plan,/plan2}
                 /api/reports{,/batch-stage}  /api/portal/lookup  /api/jobs  /api/orgs
                 /api/roles  /api/settings  /api/resumes{,/batch}  /api/llm  /api/account/password
5 个视图         loginPage adminApp candApp offerApp portalApp
8 个查询开关     offer portal job cand round rid name code
硬编码密钥       无（secret-scan clean）
SPA 回落         未知路径返回与首页同 hash 的 HTML → 记为 unknown
```

完整证据链：[analysis/target-rea-evidence.json](analysis/target-rea-evidence.json)

**这条考核真正考的不是"能不能调工具"，是"能不能区分观测、推断和不知道"。**
所以每条推断都标了 `analyst-inference` 并附 `limitations`，抓不到的东西进 `unknowns`
而不是编一个看起来合理的答案。

---

## 四、Agent-Reach 考核适配

**[tools/reach/reach.js](tools/reach/reach.js)** —— 对齐 `vendor/agent-reach`
（`Panniantong/Agent-Reach`）的 CLI 契约与设计原则：

```bash
node tools/reach/reach.js doctor --json
node tools/reach/reach.js read <URL> --json
node tools/reach/reach.js search "<QUERY>" --json
node tools/reach/reach.js github "<QUERY>" --json
node tools/reach/reach.js rss <URL> --json
node tools/reach/reach.js check-update
```

沿用它的两条硬规则（来自其 `SKILL.md`）：

1. **动手前先体检** —— `doctor --json` 给出每平台的 `active_backend` 快照。
2. **`active_backend: null` 只表示"本次未实时验证"，不代表后端不存在** ——
   这条语义在 `note` 字段里显式写明，`eval` 里有断言守着。

后端路由：检测到上游 CLI（`gh` / `opencli` / `twitter` / `rdt` / `bili` / `yt-dlp` / `mcporter`）
就路由过去，没有就走内置零配置通道。

### 实测

```
$ node tools/reach/reach.js doctor --json
4 / 9 平台可用 · zero_config=web,search,github,rss

$ node tools/reach/reach.js read http://106.54.173.125/ --json
ok=True platform=web title=面试智能体 chars=2136
```

读出来的首页文案直接给出了站点自述和演示账号：

> 面试智能体 —— 把面试交给 AI，你专注审核与决定。演示账号：admin / demo1234

（演示账号是站点**主动公开**的产品演示入口。）

产物：[analysis/reach-doctor.json](analysis/reach-doctor.json)、
[analysis/reach-read-target.json](analysis/reach-read-target.json)

---

## 五、考核自检

```bash
npm run eval              # 全部 36 项
npm run eval:replica      # 复刻一致性
npm run eval:rea          # REA 契约
npm run eval:reach        # Agent-Reach 契约
```

最近一次结果：

```
[REPLICA]  21 passed   评分公式回归 + 全流程 API 契约（含 Offer→签约 闭环）
[REA]       7 passed   Evidence 结构 / evidence_id 复算 / 枚举 / MCP 握手
[REACH]     8 passed   doctor 矩阵 / read 抽取 / RSS 解析 / github 通道
------------------------------------------------------------
36 passed, 0 failed
```

### 考核项怎么设计的

`replica` 组不测"代码能跑"，测**输出和目标站点一样**：

- 用 18 组真实 data point 断言 `logic = layer + cause + detail` 零反例
- 用 4 个真实候选人向量断言 `round(mean)` 聚合
- 用 6 个样本点断言通过阈值
- 用一次真实提交标定的 `autoScore = 68` 断言第三关公式
- 活体跑完整链路：注册 → 建岗 → 出题 → 一轮 → 二轮 → 自助查询 → 第三关 → Offer → 签约

`rea` 组不测"能返回 JSON"，测**契约合规**：

- `evidence_id` 必须能复算（改字段 → id 必须变）
- `authority` / `confidence` 必须在枚举内
- 推断类证据必须带 `limitations`
- MCP stdio 必须真的握手成功、`tools/list` 返回合法 schema

`reach` 组测**语义正确**：

- `active_backend: null` 的 `note` 必须含"未实时验证"
- 非法 URL 必须返回结构化错误而不是抛异常
- `htmlToText` 必须剥掉 `<script>` 且解码实体

`replica` 组还专门测**智能体行为**（这是"像不像智能体"的判据）：

- 出题必须引用简历原文，且引用片段要真的出现在简历里
- 同一份简历 + 不同回答 → 下一题必须不同
- 空泛回答必须触发追问，且追问要锚定上一题原话
- 一轮内追问次数受预算约束（≤2），不会变成审讯
- 评判必须给出分数 + **原文证据**（证据得能在回答里找到）+ 缺失项
- 好答案与空泛答案的分差必须 > 20
- LLM 配置接口不得回传明文密钥

---

## 五之二、智能体是怎么工作的

这一版把"模板填空"换成了真正的出题-追问-评判闭环。参考了
[AI-Meeting](https://github.com/lishuangqiang/AI-Meeting) 的多智能体分工
（出题官 / 评分官 / 追问官 + 规则链驱动追问），按目标站点的三关流程落地。

### 三个智能体

| 角色 | 文件 | 干什么 |
|---|---|---|
| **出题官** | `lib/resume.js` + `lib/agent.js` | 把简历拆成事实（项目/技术/量化指标/主导性断言/无证据技能），再按考察意图排出题目骨架 |
| **追问官** | `lib/followup.js` + `lib/agent.js` | 每出一题前先分析上一题回答，缺什么追什么 |
| **评分官** | `lib/judge.js` | 逐题打分 + 引用原文证据 + 列出缺失项 |
| **主持** | `lib/session.js` | 全程面试的循环：评判 → 决策 → 出题 → 直到自己判断问够了 |

### 两种面试方式

候选人入口可以选：

| | 标准 6 题 | **AI 全程面试** |
|---|---|---|
| 题量 | 固定 6 题 | **智能体自己决定**（4–8 题） |
| 结束条件 | 答完第 6 题 | **证据够不够**：覆盖 ≥3 个角度且 ≥3 段高质量作答就收尾；连续两题无效则提前收尾 |
| 追问 | 上限 2 次 | 上限 3 次，且由决策层判断该不该追 |
| 判据 | 每题都要答 | 中途可随时结束，已答部分照常评判 |

「标准 6 题」保留是为了和目标站点的 API 契约一致（它确实返回固定 6 题）。
**要做到"完全由 AI 面试"，用 AI 全程面试模式。**

### AI 全程面试是怎么决策的

每一轮都是 **评判 → 决策 → 出题**，决策是纯函数（不依赖 LLM，所以可回归）：

```
① 题量到上限                → 收尾「已达到本次面试题量上限」
② 连续两题都拿不到有效信息   → 收尾「继续提问不会有新证据」
③ 覆盖 ≥3 角度且 ≥3 段 ≥70 分 → 收尾「证据充分」
④ 有明显缺口且未追问过       → 追问
⑤ 否则                      → 换一个未考察的角度
```

同一份简历、三种答法，实测结果：

| 候选人 | 题量 | 结论 | 过程 |
|---|---|---|---|
| 甲·高质量 | **4 题** | 通过 76 分 | anchor → metric → ownership → 追问 obstacle → **自己收尾** |
| 乙·空泛 | **3 题** | 不通过 11 分 | anchor → 追问 process → 追问 empty → **判定问不出东西，提前收尾** |
| 丙·混合 | 5 题 | 不通过 40 分 | 中间两次追问，两次可疑后收尾 |

这就是"像不像智能体"的关键：**题量不一样，结束时机不一样，而且它能解释为什么停。**

### 追问要问对该问的

早期版本拿一套通用维度硬套所有题，于是出现"问完怎么统计的，又去追最后上线了吗"这种错位。
现在按**题目类型**决定该查哪些维度：

```js
anchor    → 情境 / 行动 / 结果
metric    → 量化 / 行动 / 情境
ownership → 个人贡献 / 行动
tradeoff  → 只要理由（取舍题本来就是假设性的，强求"我做了 X"会冤枉人）
```

缺 `action` 追"过程"，缺 `self` 追"个人贡献" —— 两者别混。
另外假设性回答（"如果并发涨十倍我会…"）会被识别，不会因为"没说我做过"被扣分。

### 出题不再靠模板

`lib/resume.js` 从简历里抽五类事实：

```js
projects[]  {name, clause, tech[], metrics[], claims[], score}
tech[]      {name, cat}          // 语言/前端/后端/数据/基础设施/AI/移动端/安全
metrics[]   {raw, value, unit}   // 3% / 0.2% / 2000 / 百分之九十
claims[]    {verb, object}       // 主导/负责/独立完成/重构/优化…
gaps[]      {tech}               // 简历提到但没有任何证据的技术
```

题目由这些事实现场拼出来。同一份简历，抽到的指标不同，题就不同：

```
Q1  简历里你写到「设计唯一约束加乐观锁解决超卖，订单失败率从3%降到0.2%，半年零丢单」。
    请把这段完整展开：当时是什么背景，你具体负责哪一部分，最后结果如何？

Q2  你简历里给了数字「3%、0.2%」（原句：「…」）。这个百分比是怎么统计出来的？
    改动前的基线是多少，你用什么方法确认它真的变了？

Q3  你用了「主导」这个词（校园二手交易平台后端订单模块）。这个项目团队几个人？
    哪一部分是你亲手做的？如果把你换掉，哪些东西会做不出来？
```

注意 `layer` 里的"技能罗列句惩罚"：`熟悉 Docker、Redis、Git、Linux、Kubernetes`
这种句子信息密度会被压低，不会被当成"经历"来展开 —— 否则第一题永远在问技能清单。

### 追问是算出来的，不是写死的

每答完一题，`followup.analyze()` 检查七个维度：

```
context 情境   task 任务   action 行动   obstacle 阻碍   result 结果
metric 量化    self 第一人称承担
```

然后规则链按缺口从重到轻决定追什么：

```
答得太短 (<25字)        → empty      "请展开说：具体哪个项目、你做了什么、结果如何"
复述题干 (>72% 词重叠)  → vague      "你用了「大概」这样的词，但我要具体的"
没有第一人称动作        → ownership  "哪一部分是你亲手做的，哪一部分是别人做的"
没有数字                → metric     "基线是多少，改完变成多少，怎么测的"
没有阻碍                → obstacle   "听起来挺顺，但中间应该卡过，最难的一点是什么"
没有结果                → result     "最后上线了吗，效果如何"
```

实测同一个人换个答法，下一题就换：

```
空泛作答 → Q2「我做过一些后端相关的工作…」这件事，团队几个人在做？
            哪一部分是你亲手写的/做的？          [probe:ownership]

具体作答 → Q2 你简历里给了数字「3%、0.2%」。这个百分比是怎么统计出来的？
            改动前的基线是多少？                  [resume:metric]
```

追问有预算（每轮最多 2 次），追过同一种缺口就不再追，避免变成审讯。

### 评判有证据

`lib/judge.js` 用六条 rubric 打分，每条都要在回答里找到证据：

```
结构完整 20   细节具体 20   个人贡献清晰 20   有攻坚过程 15   扣题 15   无空泛套话 10
```

最终分 = `0.7 × rubric 覆盖度 + 0.3 × 具体度`，再叠硬上限（空泛 ≥3 处 → 最高 45 分；
复述题干 → 最高 35 分）。所以 90 分以上必须"结构完整 **且** 有数字有细节"。

输出的评语必须引用原文：

```
空泛作答 → 3 分 [可疑]
  「我做过一些后端相关的工作，主要负责写接口，大概就是增删改查那些…」是有效信息，
  满足了扣题；缺少结构完整、细节具体。
  缺失：["结构完整","细节具体","个人贡献清晰","有攻坚过程"]
  rubric: 结构完整✘ 细节具体✘ 个人贡献清晰✘ 有攻坚过程✘ 扣题✔ 无空泛套话✘

具体作答 → 96 分
  证据：["失败率从 3% 降到 0.2%，上线后半年零丢单",
         "改完之后压测 2000 QPS，",
         "当时的问题是并发下单会超卖，我先压测复现，"]
```

HR 端还能拿到整体洞察（`POST /api/reports/:id/judge`）：

```
综合 75 分；稳定表现在扣题（100%）、无空泛套话（100%）、个人贡献清晰（83%）；
简历提到但未验证：Docker、Redis、Git。
```

### 候选人能看到"为什么问这题"

每道题下面有一行小字说明追问理由（`#stepWhy`），比如：

> 追问 · 没有出现第一人称的具体动作，看不出个人做了什么。

追问不是黑箱，候选人知道自己在被追什么。

---

## 五之三、接入 API（智能体的"脑子"）

目标站点确实接了 API —— 首页加载 `@tencent-ai/workbuddy-cloud-sdk`，并有 `/api/llm` 代理。
这一版把接口做正：**任何 OpenAI 兼容端点都能接，运行时可切换，密钥只留服务端。**

### 方式一：管理端 UI（推荐）

登录 → 「账号」标签 → **AI 接入**：

1. 选服务商（内置 8 个预设，选完自动填 base 和模型名）
2. 填 API Key
3. 点「保存」→ 点「测试连接」→ 看到 `连接成功 · 320ms · 模型回复「ok」` 就成了

### 方式二：环境变量

```powershell
$env:LLM_PROVIDER = 'deepseek'          # deepseek|openai|moonshot|dashscope|zhipu|siliconflow|ollama|custom
$env:LLM_API_KEY  = 'sk-...'
$env:LLM_MODEL    = 'deepseek-chat'
$env:LLM_BASE_URL = 'https://api.deepseek.com/v1'   # 可选，默认按 provider 预设
npm start
```

### 方式三：直接调接口

```bash
# 查当前配置（密钥脱敏成 ****abcd）
curl -b cookie.txt http://127.0.0.1:3000/api/llm/config

# 改配置
curl -b cookie.txt -X PUT http://127.0.0.1:3000/api/llm/config \
  -H "Content-Type: application/json" \
  -d '{"provider":"deepseek","baseUrl":"https://api.deepseek.com/v1","model":"deepseek-chat","apiKey":"sk-..."}'

# 测连通（配置不全也返回 200 + ok:false，带真实原因）
curl -b cookie.txt -X POST http://127.0.0.1:3000/api/llm/test
```

### 内置的 8 个预设

| provider | 默认 base | 默认模型 |
|---|---|---|
| `deepseek` | `https://api.deepseek.com/v1` | `deepseek-chat` |
| `openai` | `https://api.openai.com/v1` | `gpt-4o-mini` |
| `moonshot` | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| `dashscope` | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| `zhipu` | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| `siliconflow` | `https://api.siliconflow.cn/v1` | `Qwen/Qwen2.5-7B-Instruct` |
| `ollama` | `http://127.0.0.1:11434/v1` | `qwen2.5:7b`（不需要 Key） |
| `custom` | 自己填 | 自己填 |

### 接上之后有什么不同

| | 规则通道（无 Key） | 接上 API |
|---|---|---|
| 出题 | 简历事实 + 意图模板，确定性 | 模型措辞，强制引用简历原文 |
| 追问 | 规则链按缺口选探针 | 模型看着缺口自己组织问法 |
| 评判 | rubric 证据抽取 | 模型按 rubric 打分，证据回填校验 |
| 延迟 | ~0ms | 每题 1–3s |

**两条通道的"追什么"由同一套规则链决定**，所以行为一致、可回归。
没接 API 也照样会追问、会评判 —— 只是措辞不如模型灵活。

### 接上了却没生效？看这里

所有"LLM 失败 → 落规则通道"的地方都会记一笔，`/api/health` 能看到：

```json
{"ok":true,"llm":{"enabled":true},"llm_diagnostics":null}          // 正常
{"ok":true,"llm":{"enabled":true},
 "llm_diagnostics":{"where":"judge/judge","message":"...","at":"..."}}  // 降级了
```

`where` 会告诉你哪一步降级的（`plan-round1` / `next-question` / `judge/judge` /
`summarize-round2`），`message` 是真实异常。想看实时日志就带上环境变量：

```powershell
$env:LLM_DEBUG = '1'
npm start
```

> 这个诊断是踩坑踩出来的：`judge()` 里曾经读了 `analysis.metrics`，
> 而 `followup.analyze()` 并不返回这个字段，`undefined.map()` 抛异常后被
> `catch (_) {}` 静默吞掉 —— 接口配好了、健康检查显示已接入、行为却完全没变。
> 现在同类问题会直接暴露在 `llm_diagnostics` 里。

### 怎么验证接口真的通（不花 Key 的钱）

`_recon/mock-llm.js` 是一个本地 OpenAI 兼容 mock（监听 8899），
`_recon/llm-path-test.js` 会把配置指过去并逐项验证：

```powershell
node _recon/mock-llm.js          # 另开一个窗口
node _recon/llm-path-test.js
```

它会打印每条通道的 `source`：`llm` 表示真的走了模型，`rule` 表示降级了。

---

## 六、目录结构

```
D:\deepseek\agent智能体\
├── server.js                 零依赖 Node 后端，21 个端点
├── package.json
├── web/
│   └── index.html            单文件 SPA：登录/管理/候选人/Offer/自助查询 五视图
├── lib/
│   ├── scoring.js            评分引擎（公式 + 权重表 + 回归锚点）
│   ├── bank.js               内置题库（第一轮 + 第二轮三维 + 通用补位）
│   ├── agent.js              面试智能体核心（逐题出题 / 追问 / 逐题评估 / 整轮评语）
│   ├── llm.js                OpenAI 兼容客户端 + 三级降级
│   └── store.js              原子写 JSON 持久化
├── tools/
│   ├── rea/rea.js            REA 契约适配器（CLI + MCP stdio）
│   └── reach/reach.js        Agent-Reach 契约适配器（CLI）
├── eval/
│   └── run.js                36 项考核自检
├── analysis/
│   ├── SITE-ANALYSIS.md      目标站点解析（产品/流程/实现/优劣）
│   ├── API-CONTRACT.md       21 个端点逐字段契约
│   ├── SCORING-EVIDENCE.md   评分公式逆向证据 + 诚实未知清单
│   ├── target-rea-evidence.json
│   └── reach-{doctor,read-target}.json
└── vendor/
    ├── rea/                  morluto/rea（克隆，只读参照）
    └── agent-reach/          Panniantong/Agent-Reach（克隆，只读参照）
```

---

## 七、接入大模型

不配也能跑 —— 内置题库 + 确定性评分是完整可用的通道。

要启用 LLM 出题与逐题评估：

```bash
# PowerShell
$env:LLM_API_KEY  = "sk-..."
$env:LLM_BASE_URL = "https://api.deepseek.com/v1"   # 任意 OpenAI 兼容端点
$env:LLM_MODEL    = "deepseek-chat"
npm start
```

配置后 `/api/health` 会显示 `llm.enabled: true`。出题、追问、逐题评估、整轮评语全部走模型；
任何一次调用失败自动落回题库通道，候选人无感。

---

## 八、已知差异与未解项

诚实清单，不藏：

| 项 | 状态 |
|---|---|
| LLM 通道的 `layer` 分桶 | **未知**。与分句模型 4/6 吻合，单样本无法唯一反推 |
| `cause = 20` 是否存在 | **未知**。18/18 观测恒为 10 |
| `layer = 50` 是否存在 | **推测**。需要单题 logic=100，观测最高 80 |
| `autoScore` 精确系数 | **弱证据**。单点标定，等价公式族未排除 |
| LLM 系统提示词全文 | **未知**。服务端代理，不下发前端 |
| 内置题库完整内容 | **部分**。前端只暴露 4 条补位题 |

### 复刻过程中发现的目标站点问题

1. `/api/reports` 全量返回含完整简历，**任何登录成员可看所有岗位的所有候选人**，无租户隔离。
2. 6 位认证码 + 姓名可做有限枚举，未见速率限制。
3. SPA 回落吞掉所有 404，`/robots.txt`、`/package.json` 都返回首页 HTML。
4. 第一关"准确性"是关键词命中，奖励堆词、惩罚同义表达。
5. `cause` 恒为 10，因果维度实际未参与区分。

这些在复刻里**保留同构行为以便对照**，但都在这里点名 —— 复刻缺陷是为了研究它，不是为了传播它。

---

## 九、排错：注册或登录不了

用真实浏览器（Chrome + CDP）逐场景跑过，认证链路本身是通的。真正常见的坑有三个：

### 坑 1：浏览器把 http 升级成 https，然后打不开

目标站点 `106.54.173.125` **只有 HTTP，没有 TLS**。现代浏览器会先试 `https://`，失败后才回落
`http://`。一旦 HTTPS 那次失败被缓存下来（HSTS / 错误页缓存），后续每次访问都直接失败，
页面根本加载不出来 —— 表现就是"打不开、注册不了"。

实测复现（同一台机器、同一个站点）：

| 浏览器 profile | 结果 |
|---|---|
| 全新 profile | `200`，页面正常，注册/登录全部通过 |
| 之前访问失败过的 profile | `chrome-error://chromewebdata/`，`#loginPage` 元素都不存在 |

修法，任选一个：

1. **开无痕窗口**（`Ctrl+Shift+N`）重新访问 —— 最省事
2. 清 HSTS：Chrome 打开 `chrome://net-internals/#hsts`，在 *Delete domain security policies*
   里输入 `106.54.173.125`，点 Delete
3. 地址栏**手打** `http://106.54.173.125/`，别让它自动补全成 https
4. 换个从没访问过它的浏览器

本复刻跑在 `127.0.0.1`，不走这个坑。

### 坑 2：拿目标站点的演示账号登复刻版

目标站点首页公开写着「演示账号：admin / demo1234」。复刻版早期没有这个账号，从那边过来的人
第一件事就是拿它登录，然后登不进去 —— 看着就像"登录不好用"。

现在已播种：首次启动自动创建 `admin / demo1234`（role=admin）。`eval` 里有断言守着它。

想换密码或关掉：

```powershell
$env:DEMO_PASSWORD = 'your-own-password'   # 换密码（已存在且密码不同时会重置）
$env:DEMO_PASSWORD = ''                    # 关掉播种
```

### 坑 3：账号格式被拒，但没注意提示

前端逐项校验，文案和目标站点一致：

| 输入 | 提示 |
|---|---|
| `张三` | 账号不能包含中文或空格。 |
| `ab` | 账号长度 3-40 位。 |
| `a@b.com` | 账号只能用英文字母、数字或 . _ + - |
| 密码 5 位 | 密码至少 6 位。 |
| 两次密码不一致 | 两次输入的密码不一致。 |
| 账号已存在 | 该账号已被注册 |

提示显示在按钮上方的红字行（`#rgErr` / `#lgErr`）。如果没看到红字，说明请求发出去了但
网络层失败 —— 回到坑 1。

### 自己验证一遍

```powershell
# 1. 服务活着吗
curl.exe -s http://127.0.0.1:3000/api/health

# 2. 演示账号能登吗
curl.exe -s -X POST http://127.0.0.1:3000/api/auth/login ^
  -H "Content-Type: application/json" ^
  -d "{\"account\":\"admin\",\"password\":\"demo1234\"}"

# 3. 注册新账号
curl.exe -s -X POST http://127.0.0.1:3000/api/auth/register ^
  -H "Content-Type: application/json" ^
  -d "{\"account\":\"myname\",\"name\":\"我的名字\",\"password\":\"test123456\"}"
```

三条都返回 `200` + JSON，说明后端没问题，问题在浏览器侧（坑 1）。

### 端口被占

```powershell
$env:PORT = '3001'; npm start
```

启动时端口冲突会直接报 `EADDRINUSE`，不会静默失败。

---

## 十、来源

- REA：`https://github.com/morluto/rea`（`vendor/rea`，只读参照其 Evidence 域模型）
- Agent-Reach：`https://github.com/Panniantong/Agent-Reach`（`vendor/agent-reach`，只读参照其 CLI 契约）
- 目标站点：`http://106.54.173.125/`

两个上游项目的代码**没有一行被复制进本复刻的实现**。只参照了契约形状（字段名、枚举值、
规范化规则、CLI 语义），实现全部自写，`vendor/` 保持原样作为可核对的参照。

MIT。
