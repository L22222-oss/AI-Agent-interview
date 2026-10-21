# API 契约（逆向结果）

对 `http://106.54.173.125/` 逐端点实测。标注 **鉴权** 的端点需要 `iv_session` Cookie，
其余为公开端点（候选人链路不需要登录）。

状态码与错误文案均为**实测原文**，不是猜测。

---

## 认证

| 方法 | 路径 | 鉴权 | 请求 | 响应 / 错误 |
|---|---|---|---|---|
| POST | `/api/auth/register` | – | `{account,name,password}` | `200 {id,account,name,role}` |
| POST | `/api/auth/login` | – | `{account,password}` | `200 {id,account,name,role}` / `401 {error:"账号或密码错误"}` |
| POST | `/api/auth/logout` | – | – | `200 {ok:true}` |
| GET | `/api/auth/session` | – | – | `200 {id,account,name,role}` / `401 {error:"未登录"}` |
| POST | `/api/account/password` | ✔ | `{oldPassword,newPassword}` | `200 {ok:true}` |

账号规则（前端逐项校验，实测文案）：

- 3–40 位，仅 `[A-Za-z0-9._+-]`
- 不能含中文或空格
- 密码 ≥ 6 位

---

## 岗位

| 方法 | 路径 | 鉴权 | 请求 | 响应 / 错误 |
|---|---|---|---|---|
| GET | `/api/jobs` | ✔ | – | `200 [{id,name,jd,round1Count,round2Count,duration,published,...}]` |
| POST | `/api/jobs` | ✔ | `{name,jd?,round1Count?,round2Count?,duration?}` | `200 {job}` |
| PUT | `/api/jobs/:id` | ✔ | 局部字段 | `200 {job}` |
| DELETE | `/api/jobs/:id` | ✔ | – | `200 {ok:true}` |
| GET | `/api/interview?job=<id>` | **–** | – | `200 {id,name,jd,round1Count,round2Count,duration}` / `404 {error:"岗位不存在或未发布"}` |

`/api/interview` 是候选人链路的**唯一公开入口**，只回 6 个字段，不泄露其他数据。

---

## 第一轮

| 方法 | 路径 | 鉴权 | 请求 | 响应 / 错误 |
|---|---|---|---|---|
| POST | `/api/interview/plan` | – | `{jobId,cand,resume}` | `200 {planId,questions[6],duration}` |
| | | | | `400 {error:"简历正文至少 20 字"}` |
| | | | | `404 {error:"岗位不存在或未发布"}` |
| POST | `/api/reports` | – | `{planId,clientId,answers[]}` | `200 {id,round:1,r1:{logic,accuracy,verdict},eval:null,passed,accessCode}` |
| | | | | 重复提交 → `200 {id,round:1,duplicate:true}` |
| | | | | `404 {error:"面试计划不存在"}` |

`accessCode` 是 6 位数字字符串，**仅在第一轮 `通过` 时下发**，否则为 `null`。

---

## 第二轮

| 方法 | 路径 | 鉴权 | 请求 | 响应 |
|---|---|---|---|---|
| POST | `/api/interview/plan2` | – | `{reportId}` | `200 {questions[6],dims[6],materials[6],accessCode}` |
| POST | `/api/reports` | – | `{round:2,reportId,answers[],questions?,dims?,materials?,evals?}` | `200 {id,round:2,r1,eval:{avg,verdict,summary},passed,accessCode}` |

`dims` 恒为 `["communication","communication","learning","learning","execution","execution"]`。

---

## 报告（HR 侧）

| 方法 | 路径 | 鉴权 | 请求 | 响应 |
|---|---|---|---|---|
| GET | `/api/reports` | ✔ | `?jobId=` 可选 | `200 [report]` |
| GET | `/api/reports/:id` | ✔ | – | `200 report` / `404 {error:"报告不存在"}` |
| POST | `/api/reports/:id/stage` | ✔ | `{stage}` | `200 {ok:true}` |
| POST | `/api/reports/batch-stage` | ✔ | `{ids[],stage}` | `200 {ok:true,updated}` |
| POST | `/api/reports/:id/round1/pass` | ✔ | – | `200 {ok:true,accessCode}` — 人工改判通过 |
| POST | `/api/reports/:id/practice/review` | ✔ | `{score,comment}` | `200 {ok:true}` |

report 对象字段（实测完整键集）：

```
id, clientId, jobId, jobName, cand, resume, at, updatedAt, stage, round, source,
round1, round2plan, round2, eval, offer, practice, accessCode, recommend
```

`recommend` 是**服务端计算**的推进建议，不是前端拼的：

```json
{ "action": "round2" | "hold" | "review" | "offer" | "done",
  "text": "第二轮已通过，等待候选人进入第三关并提交实操作品网址。" }
```

`action === "round2" && stage === "pending"` 时前端才渲染「采纳 · 复制第二轮链接」按钮。

---

## 第三关

| 方法 | 路径 | 鉴权 | 请求 | 响应 / 错误 |
|---|---|---|---|---|
| POST | `/api/reports/:id/practice` | – | `{url,note}` | `200 {ok:true,autoScore,reachable,autoConfirmed}` |
| | | | | `400 {error:"第二轮尚未通过"}` |
| | | | | `400 {error:"请填写公网可访问的作品网址（http/https 开头）"}` |

服务端会**主动抓取提交的 URL** 判断 `reachable`（实测：提交自己的域名返回 `reachable:true`）。

---

## Offer 与电子签约

| 方法 | 路径 | 鉴权 | 请求 | 响应 / 错误 |
|---|---|---|---|---|
| GET | `/api/reports/:id/offer` | – | – | `200 {cand,jobName,offer,contract}` / `404 {error:"Offer 不存在"}` |
| POST | `/api/reports/:id/offer` | ✔ | `{title,salary,startDate,expire,note}` | `200 {ok:true,offer}` |
| POST | `/api/reports/:id/offer/accept` | – | `{action:"accept"\|"decline"}` | `200 {ok:true,status,contract?}` |
| POST | `/api/reports/:id/contract/sign` | – | `{name,signData}` | `200 {ok:true,contract}` |

`signData` 是 `data:image/png;base64,...` 的手写签名画板导出（前端 canvas → `toDataURL`）。
`contract.status` 状态：`pending_sign` → `signed`。

---

## 候选人自助查询

| 方法 | 路径 | 鉴权 | 请求 | 响应 / 错误 |
|---|---|---|---|---|
| POST | `/api/portal/lookup` | – | `{jobId,name,code}` | `200 portalState` / `404 {error:"没有匹配的面试记录，请确认姓名与认证码"}` |

`portalState` 实测字段：

```json
{ "found": true, "id": "...", "jobId": "...", "jobName": "...", "cand": "...",
  "stage": "practice", "r1": "通过", "r2Done": true, "r2Verdict": "通过",
  "canRound2": false, "canPractice": true,
  "practice": { "url": "...", "autoScore": 68, "hrScore": null, "hrComment": "",
                "submittedAt": "2026-10-20T13:54:01.020Z" },
  "offer": null, "contract": null }
```

`canRound2` / `canPractice` 是**服务端算好的布尔**，前端只用来决定渲染哪个按钮 ——
权限判定不在客户端，这点做得对。

---

## 企业 / 角色 / 设置 / 简历

| 方法 | 路径 | 鉴权 | 请求 | 响应 |
|---|---|---|---|---|
| GET | `/api/orgs` | ✔ | – | `200 [{id,name,createdAt,...}]` |
| POST | `/api/orgs` | ✔ | `{name}` | `200 {org}` |
| GET | `/api/roles` | ✔ | – | `200 [{id,name,desc}]` |
| GET | `/api/settings` | ✔ | – | `200 {retentionDays,contactEmail,autoAdvance}` |
| PUT | `/api/settings` | ✔ | 局部字段 | `200 settings` |
| GET | `/api/resumes` | ✔ | – | `200 []` |
| POST | `/api/resumes/batch` | ✔ | `{items[]}` | `200 [...]` |

默认 `settings`：`{retentionDays: 90, contactEmail: "", autoAdvance: true}`。
`retentionDays` 的 UI 文案明确写了「仅影响之后提交的申请，不代表法定期限」——合规措辞，抄了。

---

## LLM 代理

| 方法 | 路径 | 鉴权 | 请求 | 响应 |
|---|---|---|---|---|
| POST | `/api/llm` | ✔ | `{messages:[{role,content}]}` | `200 {content}` / `502 {error}` |

密钥留在服务端，前端只调这个代理。前端还有一条**浏览器直连云服务**的降级路径
（`CLOUD.llm.chat.completions.create`，流式 + `response_format: json_object`），
代理不可用时启用。最后兜底才是内置题库。

本复刻只实现服务端代理这一条（不把密钥下发到浏览器），并在无 `LLM_API_KEY` 时
直接走题库确定性通道。

---

## 路由行为

- 所有非 `/api/` 路径都返回同一个 `index.html`（SPA 回落），实测 `/app.js`、`/robots.txt`、
  `/package.json` 全部返回 200 + 首页 HTML。
- 未匹配的 `/api/*` 返回 `404 {error:"接口不存在"}`；路径存在但方法不对也给这个。
- 未登录访问鉴权端点返回 `401 {error:"未登录"}`。

---

## 附：站点自述

首页文案（`reach read` 抽取）：

> 面试智能体 —— 把面试交给 AI，你专注审核与决定。演示账号：admin / demo1234

演示账号是站点**主动公开**的，用于产品演示，不是泄露。
