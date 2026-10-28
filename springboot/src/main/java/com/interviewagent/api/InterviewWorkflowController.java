package com.interviewagent.api;

import com.fasterxml.jackson.databind.JsonNode;
import com.interviewagent.api.ApiExceptionHandler.ApiProblem;
import com.interviewagent.model.JobEntity;
import com.interviewagent.model.ReportEntity;
import com.interviewagent.repository.JobRepository;
import com.interviewagent.repository.ReportRepository;
import com.interviewagent.service.JsonService;
import com.interviewagent.service.LlmService;
import com.interviewagent.service.WorkflowStore;
import jakarta.servlet.http.HttpServletRequest;
import java.net.URI;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class InterviewWorkflowController {
    private static final List<String> STAGES = List.of("pending", "interviewing", "practice", "evaluated", "offer", "signing", "signed");
    private static final List<String> DIMS = List.of("communication", "communication", "learning", "learning", "execution", "execution");
    private final JobRepository jobs;
    private final ReportRepository reports;
    private final JsonService json;
    private final WorkflowStore store;
    private final LlmService llm;

    public InterviewWorkflowController(JobRepository jobs, ReportRepository reports, JsonService json, WorkflowStore store, LlmService llm) {
        this.jobs = jobs; this.reports = reports; this.json = json; this.store = store; this.llm = llm;
    }

    @GetMapping("/api/interview")
    public Map<String, Object> interview(@RequestParam String job) {
        JobEntity entity = jobs.findById(job).orElseThrow(() -> problem(HttpStatus.NOT_FOUND, "岗位不存在或未发布"));
        Map<String, Object> row = json.read(entity.payload);
        if (!entity.published) throw problem(HttpStatus.NOT_FOUND, "岗位不存在或未发布");
        return Map.of("id", entity.id, "name", entity.name, "jd", row.getOrDefault("jd", ""), "round1Count", row.getOrDefault("round1Count", 6), "round2Count", row.getOrDefault("round2Count", 6), "duration", row.getOrDefault("duration", 35));
    }

    @PostMapping("/api/interview/plan")
    public Map<String, Object> plan(@RequestBody Map<String, Object> body) {
        JobEntity job = jobs.findById(text(body, "jobId")).orElseThrow(() -> problem(HttpStatus.NOT_FOUND, "岗位不存在或未发布"));
        String resume = text(body, "resume").trim();
        if (resume.length() < 20) throw problem(HttpStatus.BAD_REQUEST, "简历正文至少 20 字");
        Map<String, Object> jd = json.read(job.payload);
        List<String> questions = new ArrayList<>();
        List<List<List<String>>> expects = new ArrayList<>();
        String source = "rule";
        if (Boolean.TRUE.equals(llm.status().get("enabled"))) {
            try {
                JsonNode ai = llm.chatJson("你是中文面试官。只输出 JSON 对象，包含 questions 数组，生成与简历事实相关的六个问题。", "岗位：" + job.name + "\nJD：" + jd.getOrDefault("jd", "") + "\n简历：" + resume, 1800);
                for (JsonNode q : ai.path("questions")) if (!q.asText().isBlank()) questions.add(q.asText());
                int maxQuestions = number(jd.get("round1Count"), 6);
                if (questions.size() > maxQuestions) questions = new ArrayList<>(questions.subList(0, maxQuestions));
                if (!questions.isEmpty()) source = "llm";
            } catch (Exception ignored) { questions.clear(); }
        }
        if (questions.isEmpty()) {
            questions = List.of("请介绍你在简历中最有代表性的项目，以及你承担的具体工作。", "项目遇到的最大困难是什么，你如何定位并解决？", "请说明项目中的关键技术选择及原因。", "你如何验证项目效果？请给出具体数据或结果。", "描述一次你与团队协作解决问题的经历。", "如果重新做这个项目，你会优先改进什么？").subList(0, Math.min(number(jd.get("round1Count"), 6), 6));
        }
        for (int i = 0; i < questions.size(); i++) expects.add(List.of(List.of("我", "负责", "实现", "设计"), List.of("因为", "因此", "导致", "解决"), List.of("%", "提升", "降低", "上线", "结果", "用户")));
        String id = "pl" + UUID.randomUUID().toString().replace("-", "");
        Map<String, Object> record = new LinkedHashMap<>(); record.put("id", id); record.put("jobId", job.id); record.put("jobName", job.name); record.put("jd", jd.getOrDefault("jd", "")); record.put("cand", body.getOrDefault("cand", "候选人")); record.put("resume", resume); record.put("questions", questions); record.put("expects", expects); record.put("source", source); record.put("createdAt", Instant.now().toString());
        store.save("plan", record);
        return Map.of("planId", id, "questions", questions, "expects", expects, "source", source, "duration", 15, "agent", Map.of("enabled", source.equals("llm"), "mode", source, "facts", Map.of()));
    }

    @PostMapping("/api/reports")
    @Transactional
    public Map<String, Object> submit(@RequestBody Map<String, Object> body) {
        if (number(body.get("round"), 1) == 2) return submitRound2(body);
        Map<String, Object> plan = store.find("plan", text(body, "planId"));
        if (plan == null) throw problem(HttpStatus.NOT_FOUND, "面试计划不存在");
        String clientId = text(body, "clientId");
        if (clientId.isBlank()) clientId = UUID.randomUUID().toString();
        List<Map<String, Object>> duplicates = store.list("report");
        for (Map<String, Object> existing : duplicates) if (text(existing, "planId").equals(text(body, "planId")) && text(existing, "clientId").equals(clientId)) return Map.of("id", existing.get("id"), "round", 1, "duplicate", true);
        List<String> answers = strings(body.get("answers"));
        List<String> questions = body.containsKey("questions") ? strings(body.get("questions")) : strings(plan.get("questions"));
        List<?> expects = body.get("expects") instanceof List<?> supplied ? supplied : (List<?>) plan.getOrDefault("expects", List.of());
        if (!questions.isEmpty()) plan.put("questions", questions);
        if (!expects.isEmpty()) plan.put("expects", expects);
        store.save("plan", plan);
        List<Map<String, Object>> details = new ArrayList<>(); int totalLogic = 0; int totalAccuracy = 0;
        for (int i = 0; i < expects.size(); i++) {
            String answer = i < answers.size() ? answers.get(i) : ""; int seg = (int) java.util.Arrays.stream(answer.split("[。；！？\\n]+")).map(String::trim).filter(s -> !s.isEmpty()).count();
            int layer = scoreLayer(answer);
            int cause = answer.trim().length() >= 20 ? 10 : 0; int detail = answer.trim().length() >= 60 ? 30 : answer.trim().length() >= 20 ? 10 : 0;
            int hit = 0; if (expects.get(i) instanceof List<?> groups) for (Object group : groups) if (group instanceof List<?> words && words.stream().anyMatch(w -> answer.toLowerCase().contains(String.valueOf(w).toLowerCase()))) hit++;
            int n = expects.get(i) instanceof List<?> list ? list.size() : 0; int accuracy = n == 0 ? 0 : Math.round(hit * 100f / n); totalLogic += layer + cause + detail; totalAccuracy += accuracy;
            details.add(Map.of("answered", !answer.isBlank(), "layer", layer, "cause", cause, "detail", detail, "logic", layer + cause + detail, "hit", hit, "total", n, "accuracy", accuracy));
        }
        int logic = expects.isEmpty() ? 0 : Math.round(totalLogic / (float) expects.size()); int accuracy = expects.isEmpty() ? 0 : Math.round(totalAccuracy / (float) expects.size()); String verdict = logic >= 60 && accuracy >= 40 ? "通过" : "不通过";
        String id = "rp" + UUID.randomUUID().toString().replace("-", ""); String code = verdict.equals("通过") ? String.valueOf(100000 + new java.security.SecureRandom().nextInt(900000)) : null;
        Map<String, Object> r1 = Map.of("questions", questions, "answers", answers, "expects", expects, "scores", Map.of("logic", logic, "accuracy", accuracy), "details", details, "verdict", verdict);
        Map<String, Object> record = new LinkedHashMap<>(); record.put("id", id); record.put("planId", plan.get("id")); record.put("clientId", clientId); record.put("jobId", plan.get("jobId")); record.put("jobName", plan.get("jobName")); record.put("cand", plan.get("cand")); record.put("resume", plan.get("resume")); record.put("at", Instant.now().toString()); record.put("updatedAt", Instant.now().toString()); record.put("stage", "pending"); record.put("round", 1); record.put("source", plan.get("source")); record.put("accessCode", code); record.put("round1", r1); record.put("round2", null); record.put("round2plan", null); record.put("eval", null); record.put("offer", null); record.put("contract", null); record.put("practice", null);
        saveReport(record);
        Map<String, Object> result = new LinkedHashMap<>(); result.put("id", id); result.put("round", 1); result.put("r1", Map.of("logic", logic, "accuracy", accuracy, "verdict", verdict)); result.put("eval", null); result.put("passed", verdict.equals("通过")); result.put("accessCode", code); return result;
    }

    @PostMapping("/api/interview/plan2")
    public Map<String, Object> plan2(@RequestBody Map<String, Object> body) {
        Map<String, Object> r = report(text(body, "reportId"));
        Map<?, ?> round1 = r.get("round1") instanceof Map<?, ?> result ? result : Map.of();
        if (!"通过".equals(round1.get("verdict"))) throw problem(HttpStatus.CONFLICT, "第一轮尚未通过，不能进入第二轮");
        if (r.get("round2plan") instanceof Map<?, ?> p) { Map<String, Object> copy = new LinkedHashMap<>((Map<String, Object>) p); copy.put("accessCode", r.get("accessCode")); return copy; }
        List<String> q = new ArrayList<>(); List<String> material = new ArrayList<>(); String source = "bank";
        if (Boolean.TRUE.equals(llm.status().get("enabled"))) try { JsonNode ai=llm.chatJson("你是中文招聘面试官。只返回 JSON，字段 questions 为六道问题字符串数组，materials 为对应材料字符串数组。覆盖沟通、学习、执行三个维度，问题具体且不得编造候选人经历。", "岗位："+r.getOrDefault("jobName","该岗位")+"\nJD："+jobs.findById(text(r,"jobId")).map(j->text(json.read(j.payload),"jd")).orElse("")+"\n简历："+r.getOrDefault("resume",""),2600); for(JsonNode x:ai.path("questions"))if(!x.asText().isBlank())q.add(x.asText());for(JsonNode x:ai.path("materials"))material.add(x.asText());if(q.size()>=3)source="llm";else q.clear(); } catch(Exception ignored) { q.clear(); }
        if(q.isEmpty()){q.addAll(List.of("请介绍你自己，以及你为什么对这个岗位感兴趣。", "请用 STAR 结构讲一段真实经历，说明情境、任务、行动和结果。", "阅读材料后解释消息队列解决的问题和带来的新问题。", "举例说明你如何快速学会陌生知识并验证掌握。", "任务时间紧且依赖多时，你如何拆解、排期和确定优先级？", "描述一次工作出问题的经历，你如何补救并复盘？"));material.addAll(List.of("", "", "消息队列可缓冲请求并削峰填谷，但需额外处理重复消费、顺序和失败重试。", "", "", ""));}
        while(material.size()<q.size())material.add(""); Map<String, Object> p = Map.of("questions", q, "dims", DIMS.subList(0,q.size()), "materials", material.subList(0,q.size()), "source", source);
        r.put("round2plan", p); r.put("stage", "interviewing"); saveReport(r);
        Map<String, Object> result = new LinkedHashMap<>(p); result.put("accessCode", r.get("accessCode")); return result;
    }

    @PostMapping("/api/agent/session/start")
    public Map<String, Object> startAgentSession(@RequestBody Map<String, Object> b) {
        String resume = text(b, "resume").trim();
        if (resume.length() < 20) throw problem(HttpStatus.BAD_REQUEST, "简历正文至少 20 字");
        String id = "as" + UUID.randomUUID().toString().replace("-", "");
        String firstQuestion = "请结合简历，介绍一个最能体现你能力的项目，以及你个人负责的部分。";
        String firstSource="rule";
        if(Boolean.TRUE.equals(llm.status().get("enabled")))try{JsonNode ai=llm.chatJson("你是严谨的中文面试官，只生成一道基于简历的第一题。返回 JSON：text,kind,reason,expects数组。", "岗位："+b.getOrDefault("jobName","该岗位")+"\n简历："+resume,500);if(ai.path("text").asText().length()>=8){firstQuestion=ai.path("text").asText();firstSource="llm";}}catch(Exception ignored){}
        Map<String,Object> turn = new LinkedHashMap<>(); turn.put("q", firstQuestion); turn.put("a", ""); turn.put("kind", "project"); turn.put("reason", "从简历项目经历开始核实"); turn.put("expects", List.of("个人职责", "技术方案", "结果")); turn.put("judgment", null);
        Map<String,Object> session = new LinkedHashMap<>(); session.put("id",id); session.put("jobId",b.get("jobId")); session.put("jobName",b.getOrDefault("jobName","该岗位")); session.put("cand",b.getOrDefault("cand","候选人")); session.put("resume",resume); session.put("turns",new ArrayList<>(List.of(turn))); session.put("maxTurns",Math.max(4,Math.min(12,number(b.get("maxTurns"),8)))); session.put("covered",List.of()); session.put("probes",0); session.put("done",false); session.put("source",firstSource);session.put("createdAt",Instant.now().toString());
        store.save("session", session);
        return Map.of("sessionId",id,"question",Map.of("text",firstQuestion,"kind","project","reason","从简历项目经历开始核实","expects",List.of("个人职责","技术方案","结果")),"facts",Map.of(),"maxTurns",session.get("maxTurns"),"progress",Map.of("turns",0,"maxTurns",session.get("maxTurns"),"probes",0,"angles",List.of(),"done",false),"mode",firstSource);
    }

    @PostMapping("/api/agent/session/turn")
    public Map<String,Object> agentTurn(@RequestBody Map<String,Object>b) {
        Map<String,Object>s=store.find("session",text(b,"sessionId"));if(s==null)throw problem(HttpStatus.NOT_FOUND,"面试会话不存在或已过期");if(Boolean.TRUE.equals(s.get("done")))throw problem(HttpStatus.CONFLICT,"本场面试已结束");
        List<Map<String,Object>> turns=(List<Map<String,Object>>)s.get("turns");Map<String,Object>last=turns.get(turns.size()-1);last.put("a",text(b,"answer"));String answer=text(b,"answer");Map<String,Object>judgment=judgeAnswer(text(last,"q"),answer,text(s,"resume"),"");last.put("judgment",judgment);String kind=text(last,"kind");if(!kind.isBlank()&&!"unknown".equals(kind)&&!"fill".equals(kind)&&!kind.startsWith("probe:")&&!((List<?>)s.getOrDefault("covered",List.of())).contains(kind)){List<String>covered=new ArrayList<>(strings(s.get("covered")));covered.add(kind);s.put("covered",covered);}if(kind.startsWith("probe:"))s.put("probes",number(s.get("probes"),0)+1);
        long valid=turns.stream().filter(t->t.get("judgment") instanceof Map<?,?>).count();long strong=turns.stream().filter(t->t.get("judgment") instanceof Map<?,?>j&&number(j.get("score"),0)>=70).count();long flagged=turns.stream().filter(t->t.get("judgment") instanceof Map<?,?>j&&Boolean.TRUE.equals(j.get("flagged"))).count();int max=number(s.get("maxTurns"),8);boolean done=turns.size()>=max||(valid>=3&&flagged>=2)||(turns.size()>=4&&strong>=3&&((List<?>)s.getOrDefault("covered",List.of())).size()>=3);String action="advance",decisionReason="换一个尚未考察的方向";boolean weak=number(judgment.get("score"),0)<60;if(!done&&weak&&number(s.get("probes"),0)<3){action="probe";decisionReason="回答中的具体行动或结果还需要核实";}
        String question="请结合简历中另一个经历，说明你采取的行动和可验证结果。",nextKind="project",source="rule";if(!done&&Boolean.TRUE.equals(llm.status().get("enabled")))try{JsonNode ai=llm.chatJson("你是严谨的中文面试官。根据候选人回答，给出下一道不重复的问题。低质量或缺细节时要追问；输出 JSON：text,kind,reason,expects数组。", "简历："+text(s,"resume")+"\n已完成问答："+turns.stream().map(t->"问："+t.get("q")+"\n答："+t.get("a")).reduce("",(a,x)->a+"\n"+x),700);if(ai.path("text").asText().length()>=8){question=ai.path("text").asText();nextKind=ai.path("kind").asText(action.equals("probe")?"probe:detail":"project");source="llm";}}catch(Exception ignored){}
        if(!done){Map<String,Object>next=new LinkedHashMap<>();next.put("q",question);next.put("a","");next.put("kind",nextKind);next.put("reason",decisionReason);next.put("expects",List.of("个人行动","具体细节","结果"));next.put("judgment",null);next.put("decision",action);turns.add(next);}else{s.put("done",true);s.put("verdict",finalizeSession(turns,number(s.get("probes"),0),strings(s.get("covered"))));String reportId=persistSessionReport(s);s.put("reportId",reportId);}
        s.put("turns",turns);s.put("updatedAt",Instant.now().toString());store.save("session",s);Map<String,Object>out=new LinkedHashMap<>();out.put("done",done);out.put("judgment",judgment);out.put("decision",Map.of("action",done?"finish":action,"reason",done?"已达到结束条件":decisionReason));out.put("question",done?null:Map.of("text",question,"kind",nextKind,"reason",decisionReason,"expects",List.of("个人行动","具体细节","结果")));out.put("progress",Map.of("turns",valid,"maxTurns",max,"probes",s.get("probes"),"angles",s.get("covered"),"done",done));out.put("verdict",s.get("verdict"));if(done)out.put("reportId",s.get("reportId"));return out;
    }

    @GetMapping("/api/agent/session/{id}") public Map<String,Object> agentTranscript(@PathVariable String id){Map<String,Object>s=store.find("session",id);if(s==null)throw problem(HttpStatus.NOT_FOUND,"面试会话不存在");Map<String,Object>out=new LinkedHashMap<>();out.put("id",s.get("id"));out.put("jobName",s.get("jobName"));out.put("facts",s.getOrDefault("facts",Map.of()));out.put("maxTurns",s.get("maxTurns"));out.put("done",s.get("done"));out.put("verdict",s.get("verdict"));List<Map<String,Object>>turns=(List<Map<String,Object>>)s.getOrDefault("turns",List.of());out.put("progress",Map.of("turns",turns.stream().filter(t->t.get("judgment") instanceof Map<?,?>).count(),"maxTurns",s.get("maxTurns"),"probes",s.getOrDefault("probes",0),"angles",s.getOrDefault("covered",List.of()),"done",s.get("done")));out.put("turns",turns.stream().map(t->{Map<String,Object>v=new LinkedHashMap<>();v.put("idx",turns.indexOf(t));v.put("q",t.get("q"));v.put("a",t.get("a"));v.put("kind",t.get("kind"));v.put("reason",t.get("reason"));v.put("decision",t.get("decision"));v.put("judgment",t.get("judgment"));return v;}).toList());return out;}
    @PostMapping("/api/agent/session/finish") public Map<String,Object> finishAgent(@RequestBody Map<String,Object>b){Map<String,Object>s=store.find("session",text(b,"sessionId"));if(s==null)throw problem(HttpStatus.NOT_FOUND,"面试会话不存在");if(!Boolean.TRUE.equals(s.get("done"))){s.put("done",true);s.put("verdict",finalizeSession((List<Map<String,Object>>)s.getOrDefault("turns",List.of()),number(s.get("probes"),0),strings(s.get("covered"))));String reportId=persistSessionReport(s);s.put("reportId",reportId);}store.save("session",s);return Map.of("done",true,"verdict",s.get("verdict"),"progress",Map.of("turns",((List<?>)s.getOrDefault("turns",List.of())).size(),"maxTurns",s.getOrDefault("maxTurns",6),"done",true),"reportId",s.get("reportId"));}

    private String persistSessionReport(Map<String,Object>s){String id="rp"+UUID.randomUUID().toString().replace("-","");List<Map<String,Object>>turns=(List<Map<String,Object>>)s.getOrDefault("turns",List.of());Map<String,Object>r1=new LinkedHashMap<>();r1.put("questions",turns.stream().map(t->t.get("q")).toList());r1.put("answers",turns.stream().map(t->t.get("a")).toList());r1.put("verdict","已完成");Map<String,Object>r=new LinkedHashMap<>();r.put("id",id);r.put("planId",s.get("id"));r.put("clientId","ai-"+s.get("id"));r.put("jobId",s.get("jobId"));r.put("jobName",s.get("jobName"));r.put("cand",s.get("cand"));r.put("resume",s.get("resume"));r.put("at",Instant.now().toString());r.put("updatedAt",Instant.now().toString());r.put("stage","interviewing");r.put("round",1);r.put("source","ai-session");r.put("round1",r1);r.put("judgments",turns.stream().map(t->t.get("judgment")).filter(java.util.Objects::nonNull).toList());r.put("offer",null);r.put("contract",null);r.put("practice",null);saveReport(r);s.put("reportId",id);return id;}

    private Map<String,Object> judgeAnswer(String question,String answer,String resume,String dim){int len=answer.trim().length();int segments=(int)java.util.Arrays.stream(answer.split("[。；！？\\n]+")).map(String::trim).filter(x->!x.isEmpty()).count();boolean action=answer.matches("(?s).*(我|负责|实现|设计|推动|解决|完成).*"),result=answer.matches("(?s).*(结果|提升|降低|上线|提高|减少|最终|因此|交付|%|\\d).*"),metric=answer.matches("(?s).*\\d+.*");int score=Math.min(100,(action?20:0)+(segments>=3?20:segments>=2?10:0)+(result?20:0)+(metric?20:0)+(len>=100?20:len>=40?10:0));boolean flagged=len<20||question.length()>0&&answer.trim().length()>0&&answer.contains(question.substring(0,Math.min(12,question.length())));List<String>evidence=answer.isBlank()?List.of():List.of(answer.substring(0,Math.min(120,answer.length())));Map<String,Object>j=new LinkedHashMap<>();j.put("score",score);j.put("comment",len==0?"未作答。":score>=70?"回答有具体行动或结果证据。":"回答细节不足，建议继续核实。");j.put("flagged",flagged);j.put("evidence",evidence);j.put("missing",List.of("具体行动","可验证结果"));j.put("rubric",List.of());j.put("coverage",Map.of("action",action,"result",result,"metric",metric));j.put("probe",Map.of("kind",score<60?"detail":"none"));j.put("source","rule");if(Boolean.TRUE.equals(llm.status().get("enabled")))try{JsonNode ai=llm.chatJson("你是严格面试评分官。仅输出 JSON：score(0到100整数),comment,flagged,evidence(只能引用回答原文),missing数组。", "题目："+question+"\n回答："+answer+"\n简历："+resume,500);int aiScore=ai.path("score").asInt(-1);if(aiScore>=0){j.put("score",Math.max(0,Math.min(100,aiScore)));j.put("comment",ai.path("comment").asText(String.valueOf(j.get("comment"))));j.put("flagged",ai.path("flagged").asBoolean(flagged));List<String>cited=new ArrayList<>();ai.path("evidence").forEach(x->{String e=x.asText();if(e.length()>=4&&answer.contains(e))cited.add(e);});if(!cited.isEmpty())j.put("evidence",cited);j.put("source","llm");}}catch(Exception ignored){}return j;}

    private Map<String,Object> finalizeSession(List<Map<String,Object>>turns,int probes,List<String>angles){List<Integer>scores=turns.stream().map(t->t.get("judgment")).filter(Map.class::isInstance).map(Map.class::cast).map(j->number(j.get("score"),0)).toList();int avg=scores.isEmpty()?0:(int)Math.round(scores.stream().mapToInt(x->x).average().orElse(0));long strong=scores.stream().filter(x->x>=70).count();long flagged=turns.stream().map(t->t.get("judgment")).filter(Map.class::isInstance).map(Map.class::cast).filter(j->Boolean.TRUE.equals(j.get("flagged"))).count();String verdict=scores.isEmpty()||avg<60?"不通过":avg>=70&&strong>=Math.ceil(scores.size()/2.0)&&flagged==0?"通过":"待定";Map<String,Object>v=new LinkedHashMap<>();v.put("score",avg);v.put("verdict",verdict);v.put("summary","共完成 "+scores.size()+" 题，平均 "+avg+" 分。");v.put("reasons",List.of("高质量作答 "+strong+" 段","追问 "+probes+" 次"));v.put("strengths",List.of());v.put("weaknesses",List.of());v.put("suspicious",List.of());v.put("turns",scores.size());v.put("probes",probes);v.put("angles",angles);return v;}

    @GetMapping("/api/reports/{id}/offer")
    public Map<String, Object> publicOffer(@PathVariable String id) { Map<String, Object> r = report(id); Map<String,Object> out=new LinkedHashMap<>();out.put("cand",r.getOrDefault("cand",""));out.put("jobName",r.getOrDefault("jobName",""));out.put("offer",r.get("offer"));out.put("contract",r.get("contract"));return out; }

    @PostMapping("/api/reports/{id}/offer") public Map<String, Object> sendOffer(@PathVariable String id, @RequestBody Map<String, Object> b) { Map<String, Object> r = report(id); if (!"evaluated".equals(r.get("stage"))) throw problem(HttpStatus.CONFLICT, "候选人尚未完成评估"); Map<String, Object> offer = new LinkedHashMap<>(b); offer.putIfAbsent("title", r.get("jobName")); offer.put("status", "sent"); offer.put("sentAt", Instant.now().toString()); r.put("offer", offer); r.put("stage", "offer"); saveReport(r); return Map.of("ok", true, "offer", offer); }

    @PostMapping("/api/reports/{id}/offer/accept") public Map<String, Object> acceptOffer(@PathVariable String id, @RequestBody Map<String, Object> b) { Map<String, Object> r = report(id); if (!(r.get("offer") instanceof Map<?, ?> om)) throw problem(HttpStatus.NOT_FOUND, "Offer 不存在"); Map<String, Object> offer = new LinkedHashMap<>((Map<String, Object>) om); if (!"sent".equals(offer.get("status"))) throw problem(HttpStatus.CONFLICT, "当前 Offer 状态不可操作"); if ("decline".equals(b.get("action"))) { offer.put("status", "declined"); r.put("offer", offer); saveReport(r); return Map.of("ok", true, "status", "declined"); } if (b.containsKey("action") && !"accept".equals(b.get("action"))) throw problem(HttpStatus.BAD_REQUEST, "Offer 操作不合法"); offer.put("status", "accepted"); offer.put("acceptedAt", Instant.now().toString()); Map<String, Object> contract = new LinkedHashMap<>(); contract.put("status", "pending_sign"); contract.put("name", ""); contract.put("title", offer.getOrDefault("title", r.get("jobName"))); contract.put("salary", offer.getOrDefault("salary", "")); contract.put("startDate", offer.getOrDefault("startDate", "")); contract.put("note", offer.getOrDefault("note", "")); contract.put("createdAt", Instant.now().toString()); r.put("offer", offer); r.put("contract", contract); r.put("stage", "signing"); saveReport(r); return Map.of("ok", true, "status", "accepted", "contract", contract); }

    @PostMapping("/api/reports/{id}/contract/sign") public Map<String, Object> sign(@PathVariable String id, @RequestBody Map<String, Object> b) { Map<String, Object> r = report(id); if (!(r.get("contract") instanceof Map<?, ?> cm)) throw problem(HttpStatus.NOT_FOUND, "合同不存在"); if (!"pending_sign".equals(cm.get("status"))) throw problem(HttpStatus.CONFLICT, "当前合同状态不可签署"); String name = text(b, "name").trim(), sign = text(b, "signData"); if (name.length() < 2 || name.length() > 30) throw problem(HttpStatus.BAD_REQUEST, "请填写 2-30 字的签署姓名"); if (!sign.startsWith("data:image/png;base64,") || sign.length() > 400000) throw problem(HttpStatus.BAD_REQUEST, "签名数据格式不正确或签名图过大"); Map<String, Object> c = new LinkedHashMap<>((Map<String, Object>) cm); c.put("status", "signed"); c.put("name", name); c.put("signData", sign); c.put("signedAt", Instant.now().toString()); r.put("contract", c); r.put("stage", "signed"); saveReport(r); return Map.of("ok", true, "contract", c); }

    @PostMapping("/api/portal/lookup") public Map<String, Object> portal(@RequestBody Map<String, Object> b) { String name = text(b, "name").trim(), code = text(b, "code"); if (!code.matches("\\d{6}") || name.isBlank()) throw problem(HttpStatus.BAD_REQUEST, "请填写姓名与 6 位认证码"); for (Map<String, Object> r : store.list("report")) if (text(r, "jobId").equals(text(b, "jobId")) && text(r, "cand").trim().equals(name) && code.equals(text(r, "accessCode"))) return portalView(r); throw problem(HttpStatus.NOT_FOUND, "没有匹配的面试记录，请确认姓名与认证码"); }

    @PostMapping("/api/reports/{id}/stage") public Map<String, Object> stage(@PathVariable String id, @RequestBody Map<String, Object> b) { Map<String, Object> r = report(id); String s = text(b, "stage"); if (!STAGES.contains(s)) throw problem(HttpStatus.BAD_REQUEST, "阶段不合法"); r.put("stage", s); saveReport(r); return Map.of("ok", true); }
    @PostMapping("/api/reports/batch-stage") public Map<String, Object> batchStage(@RequestBody Map<String, Object> b) { String s = text(b, "stage"); if (!STAGES.contains(s)) throw problem(HttpStatus.BAD_REQUEST, "阶段不合法"); int n = 0; for (Object id : (List<?>) b.getOrDefault("ids", List.of())) { Map<String, Object> r = store.find("report", String.valueOf(id)); if (r != null) { r.put("stage", s); saveReport(r); n++; } } return Map.of("ok", true, "updated", n); }
    @PostMapping("/api/reports/{id}/round1/pass") public Map<String, Object> pass(@PathVariable String id) { Map<String, Object> r = report(id); r.putIfAbsent("accessCode", String.valueOf(100000 + new java.security.SecureRandom().nextInt(900000))); ((Map<String, Object>)r.getOrDefault("round1", new LinkedHashMap<>())).put("verdict", "通过"); saveReport(r); return Map.of("ok", true, "accessCode", r.get("accessCode")); }
    @PostMapping("/api/reports/{id}/practice") public Map<String, Object> practice(@PathVariable String id, @RequestBody Map<String, Object> b) { Map<String, Object> r = report(id); if (!(r.get("round2") instanceof Map<?, ?> r2) || !"通过".equals(r2.get("verdict"))) throw problem(HttpStatus.BAD_REQUEST, "第二轮尚未通过"); String url = text(b, "url").trim(); URI uri; try { uri = URI.create(url); if (!(uri.getScheme().equals("http") || uri.getScheme().equals("https")) || uri.getHost() == null) throw new Exception(); } catch (Exception e) { throw problem(HttpStatus.BAD_REQUEST, "请填写公网可访问的作品网址（http/https 开头）"); } boolean reachable = false; try { reachable = java.net.http.HttpClient.newHttpClient().send(java.net.http.HttpRequest.newBuilder(uri).timeout(java.time.Duration.ofSeconds(8)).GET().build(), java.net.http.HttpResponse.BodyHandlers.discarding()).statusCode() < 500; } catch (Exception ignored) {} int score = Math.min(100, (reachable ? 55 : 25) + Math.min(15, (text(b,"note").trim().length()+1)/2) + ("https".equals(uri.getScheme()) ? 10 : 0) + (uri.getPath().length() > 1 ? 10 : 0)); Map<String,Object> p = new LinkedHashMap<>(); p.put("url",url);p.put("note",text(b,"note"));p.put("reachable",reachable);p.put("autoScore",score);p.put("hrScore",null);p.put("submittedAt",Instant.now().toString());r.put("practice",p);r.put("stage","practice");saveReport(r);return Map.of("ok",true,"autoScore",score,"reachable",reachable,"autoConfirmed",false); }
    @PostMapping("/api/reports/{id}/practice/review") public Map<String,Object> review(@PathVariable String id,@RequestBody Map<String,Object>b){Map<String,Object>r=report(id);if(!(r.get("practice") instanceof Map<?,?> pm))throw problem(HttpStatus.BAD_REQUEST,"候选人尚未提交实操作品");Map<String,Object>p=new LinkedHashMap<>((Map<String,Object>)pm);p.put("hrScore",Math.max(0,Math.min(100,number(b.get("score"),0))));p.put("hrComment",text(b,"comment"));r.put("practice",p);r.put("stage","evaluated");saveReport(r);return Map.of("ok",true);}

    @PostMapping("/api/agent/next-question")
    public Map<String,Object> nextQuestion(@RequestBody Map<String,Object>b){
        String q="请补充你在这个项目中的具体行动、遇到的困难以及最终结果。", kind="probe:detail", basis="继续核实个人行动与结果", source="rule";
        List<List<String>> expects=List.of(List.of("我","负责","行动"),List.of("困难","解决"),List.of("结果","提升","降低"));
        if(Boolean.TRUE.equals(llm.status().get("enabled"))) try { JsonNode ai=llm.chatJson("你是中文面试官，只输出 JSON：text、kind、basis、expects 数组（每项为关键词数组）。根据上下文生成一道不重复的追问。",json.write(b),700); if(ai.path("text").asText().length()>=8) { q=ai.path("text").asText(); kind=ai.path("kind").asText(kind); basis=ai.path("basis").asText(basis); List<List<String>> parsed=new ArrayList<>(); ai.path("expects").forEach(group->{List<String> words=new ArrayList<>();if(group.isArray())group.forEach(word->words.add(word.asText()));if(!words.isEmpty())parsed.add(words);}); if(!parsed.isEmpty())expects=parsed;source="llm";} } catch(Exception ignored) {}
        String planId=text(b,"planId");
        if(!planId.isBlank()) { Map<String,Object> plan=store.find("plan",planId); int index=number(b.get("idx"),-1); if(plan!=null&&index>=0){List<String> questions=new ArrayList<>(strings(plan.get("questions")));List<Object> allExpects=new ArrayList<>((List<?>)plan.getOrDefault("expects",List.of()));while(questions.size()<=index)questions.add("");while(allExpects.size()<=index)allExpects.add(List.of());questions.set(index,q);allExpects.set(index,expects);plan.put("questions",questions);plan.put("expects",allExpects);store.save("plan",plan);}}
        return Map.of("text",q,"kind",kind,"basis",basis,"expects",expects,"source",source);
    }

    @PostMapping("/api/agent/eval-round2")
    public List<Map<String,Object>> evaluateRound2(@RequestBody Map<String,Object>b){List<String>qs=strings(b.get("questions")),as=strings(b.get("answers")),ds=strings(b.get("dims"));List<Map<String,Object>>out=new ArrayList<>();for(int i=0;i<qs.size();i++)out.add(judgeAnswer(qs.get(i),i<as.size()?as.get(i):"",text(b,"resume"),i<ds.size()?ds.get(i):""));return out;}

    @PostMapping("/api/reports/{id}/judge")
    public Map<String,Object> judgeReport(@PathVariable String id){Map<String,Object>r=report(id);Map<?,?>r1=r.get("round1")instanceof Map<?,?>m?m:Map.of();List<String>qs=strings(r1.get("questions")),as=strings(r1.get("answers"));List<Map<String,Object>>js=new ArrayList<>();for(int i=0;i<qs.size();i++)js.add(judgeAnswer(qs.get(i),i<as.size()?as.get(i):"",text(r,"resume"),""));int avg=js.isEmpty()?0:(int)Math.round(js.stream().mapToInt(j->number(j.get("score"),0)).average().orElse(0));Map<String,Object>ins=Map.of("summary","共评估 "+js.size()+" 道回答，平均 "+avg+" 分。","strengths",js.stream().filter(j->number(j.get("score"),0)>=70).map(j->j.get("comment")).toList(),"weaknesses",js.stream().filter(j->number(j.get("score"),0)<70).map(j->j.get("comment")).toList(),"suspicious",js.stream().filter(j->Boolean.TRUE.equals(j.get("flagged"))).map(j->j.get("comment")).toList(),"score",avg);r.put("judgments",js);r.put("insights",ins);saveReport(r);return Map.of("judgments",js,"insights",ins);}

    @PostMapping("/api/llm") public Map<String,Object> llmProxy(@RequestBody Map<String,Object>b){List<?> messages=(List<?>)b.getOrDefault("messages",List.of());String system="",user="";for(Object item:messages)if(item instanceof Map<?,?>m){if("system".equals(m.get("role")))system+=m.get("content");if("user".equals(m.get("role")))user+=m.get("content");}if(user.isBlank())throw problem(HttpStatus.BAD_REQUEST,"缺少 user 消息");try{return Map.of("content",llm.chatJson(system,user,1800).toString());}catch(Exception e){throw problem(HttpStatus.BAD_GATEWAY,"LLM 调用失败："+e.getMessage());}}
    @GetMapping("/api/llm/config") public Map<String,Object> llmConfig(){return Map.of("status",llm.status(),"providers",llm.providers());}
    @org.springframework.web.bind.annotation.PutMapping("/api/llm/config") public Map<String,Object> saveLlm(@RequestBody Map<String,Object>b){if(!llm.providers().stream().anyMatch(p->p.get("id").equals(b.get("provider"))))throw problem(HttpStatus.BAD_REQUEST,"未知的 provider");return Map.of("ok",true,"status",llm.save(b));}
    @PostMapping("/api/llm/test") public Map<String,Object> testLlm(){return llm.probe();}

    @GetMapping("/api/resumes") public List<Map<String,Object>> resumes(){return store.list("resume");}
    @PostMapping("/api/resumes") public Map<String,Object> analyzeResume(@RequestBody Map<String,Object>b){JobEntity job=jobs.findById(text(b,"jobId")).orElseThrow(()->problem(HttpStatus.NOT_FOUND,"岗位不存在"));String candidate=text(b,"cand").isBlank()?"候选人":text(b,"cand");String resume=text(b,"text").isBlank()?text(b,"resume").trim():text(b,"text").trim();if(resume.length()<20)throw problem(HttpStatus.BAD_REQUEST,"简历正文至少 20 字");if(!Boolean.TRUE.equals(llm.status().get("enabled")))throw problem(HttpStatus.SERVICE_UNAVAILABLE,"AI 未配置，请先填写 API 地址、模型和 API Key");JsonNode ai=llm.chatJson("你是严谨的中文招聘面试官，只输出 JSON：match(0-100),matchReason,facts数组,pending数组,questions数组。不可编造简历事实。", "岗位："+job.name+"\n岗位描述："+text(json.read(job.payload),"jd")+"\n候选人："+candidate+"\n简历："+resume,2200);Map<String,Object>result=new LinkedHashMap<>();result.put("id","cv"+UUID.randomUUID().toString().replace("-",""));result.put("jobId",job.id);result.put("name",candidate);result.put("cand",candidate);result.put("text",resume);result.put("match",ai.path("match").asInt());result.put("matchReason",ai.path("matchReason").asText());result.put("facts",strings(ai.path("facts")));result.put("pending",strings(ai.path("pending")));result.put("questions",strings(ai.path("questions")));result.put("source","llm");result.put("at",Instant.now().toString());return store.save("resume",result);}
    @PostMapping("/api/resumes/batch") public Map<String,Object> analyzeResumeBatch(@RequestBody Map<String,Object>b){List<Map<String,Object>>results=new ArrayList<>();Object items=b.get("items");if(items instanceof List<?>list)for(Object item:list){if(item instanceof Map<?,?>m){Map<String,Object>one=new LinkedHashMap<>();m.forEach((k,v)->one.put(String.valueOf(k),v));one.put("jobId",b.get("jobId"));try{Map<String,Object>r=analyzeResume(one);results.add(Map.of("ok",true,"id",r.get("id"),"cand",r.get("cand"),"match",r.get("match"),"matchReason",r.get("matchReason"),"facts",r.get("facts"),"pending",r.get("pending"),"questions",r.get("questions"),"link","/?job="+b.get("jobId")));}catch(Exception e){results.add(Map.of("ok",false,"cand",m.get("cand")==null?"候选人":m.get("cand"),"error",String.valueOf(e.getMessage())));}}}return Map.of("jobId",b.get("jobId"),"results",results);}

    private Map<String,Object> submitRound2(Map<String,Object>b){Map<String,Object>r=report(text(b,"reportId"));if(r.get("round2")!=null)return Map.of("id",r.get("id"),"round",2,"duplicate",true);Map<?,?>p=r.get("round2plan") instanceof Map<?,?>m?m:Map.of();List<String>answers=strings(b.get("answers"));Object dimObj=b.containsKey("dims")?b.get("dims"):p.get("dims");List<?>dims=dimObj instanceof List<?>l?l:DIMS;Map<String,Integer>s=new LinkedHashMap<>();for(String d:List.of("communication","learning","execution")){List<Integer>v=new ArrayList<>();for(int i=0;i<dims.size();i++)if(d.equals(dims.get(i))){String a=i<answers.size()?answers.get(i):"";int fallback=Math.min(100,Math.round((scoreLayer(a)+scoreCause(a)+scoreDetail(a))*1.05f));if(a.trim().length()>=20)fallback=Math.max(fallback,45);Object evalObj=b.get("evals");if(evalObj instanceof List<?>evs&&i<evs.size()&&evs.get(i) instanceof Map<?,?>ev&&ev.get("score") instanceof Number n)fallback=Math.max(0,Math.min(100,n.intValue()));v.add(fallback);}s.put(d,v.isEmpty()?0:(int)Math.round(v.stream().mapToInt(x->x).average().orElse(0)));}int avg=Math.round((s.get("communication")+s.get("learning")+s.get("execution"))/3f);String verdict=avg>=60?"通过":"不通过";Map<String,Object>round2=new LinkedHashMap<>();round2.put("questions",b.getOrDefault("questions",p.get("questions")));round2.put("dims",dims);round2.put("materials",b.getOrDefault("materials",p.get("materials")));round2.put("answers",answers);round2.put("evals",b.getOrDefault("evals",List.of()));round2.put("scores",s);round2.put("verdict",verdict);Map<String,Object>ev=Map.of("avg",avg,"verdict",verdict,"summary","沟通、学习与执行三维平均分为 "+avg+" 分。");r.put("round2",round2);r.put("eval",ev);r.put("stage",verdict.equals("通过")?"practice":"evaluated");saveReport(r);return Map.of("id",r.get("id"),"round",2,"eval",ev,"passed",verdict.equals("通过"),"accessCode",r.getOrDefault("accessCode",""));}

    private Map<String,Object> report(String id){Map<String,Object>r=store.find("report",id);if(r==null)throw problem(HttpStatus.NOT_FOUND,"报告不存在");return r;}
    private void saveReport(Map<String,Object>r){store.save("report",r);ReportEntity e=reports.findById(text(r,"id")).orElseGet(ReportEntity::new);e.id=text(r,"id");e.jobId=text(r,"jobId");e.stage=text(r,"stage");e.payload=json.write(r);e.createdAt=Instant.parse(text(r,"at").isBlank()?Instant.now().toString():text(r,"at"));reports.save(e);}
    private Map<String,Object>portalView(Map<String,Object>r){Object r2=r.get("round2");Map<?,?>round1=r.get("round1")instanceof Map<?,?>m?m:Map.of();Map<String,Object>o=new LinkedHashMap<>();o.put("found",true);o.put("id",r.get("id"));o.put("jobId",r.get("jobId"));o.put("jobName",r.get("jobName"));o.put("cand",r.get("cand"));o.put("stage",r.get("stage"));o.put("r1",round1.get("verdict"));o.put("r2Done",r2!=null);o.put("r2Verdict",r2 instanceof Map<?,?>m?m.get("verdict"):null);o.put("canRound2","通过".equals(round1.get("verdict"))&&r2==null);o.put("canPractice",r2 instanceof Map<?,?>m&&"通过".equals(m.get("verdict"))&&"practice".equals(r.get("stage"))&&r.get("practice")==null);o.put("practice",r.get("practice"));o.put("offer",r.get("offer"));o.put("contract",r.get("contract"));return o;}
    private static ApiProblem problem(HttpStatus s,String m){return new ApiProblem(s,m);} private static String text(Map<String,Object>m,String k){return String.valueOf(m.getOrDefault(k,""));} private static int number(Object o,int d){try{return Integer.parseInt(String.valueOf(o));}catch(Exception e){return d;}} private static List<String> strings(Object o){return o instanceof List<?>l?l.stream().map(String::valueOf).toList():List.of();}
    private static int scoreLayer(String a){int n=(int)java.util.Arrays.stream(a.split("[。；！？\\n]+")).map(String::trim).filter(x->!x.isEmpty()).count();if(n>=3)return a.matches("(?s).*(最终|综上|总结|复盘|结果|因此|所以|落地|交付|上线后).*")?50:40;return n>=2?15:0;}
    private static int scoreCause(String a){return a.trim().length()>=20?10:0;} private static int scoreDetail(String a){return a.trim().length()>=60?30:a.trim().length()>=20?10:0;}
}
