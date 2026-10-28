package com.interviewagent.api;

import com.interviewagent.api.ApiExceptionHandler.ApiProblem;
import com.interviewagent.model.JobEntity;
import com.interviewagent.model.ReportEntity;
import com.interviewagent.repository.JobRepository;
import com.interviewagent.repository.ReportRepository;
import com.interviewagent.service.JsonService;
import com.interviewagent.service.LlmService;
import com.fasterxml.jackson.databind.JsonNode;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.http.HttpStatusCode;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/jobs")
public class JobController {
    private final JobRepository jobs;
    private final ReportRepository reports;
    private final JsonService json;
    private final LlmService llm;

    public JobController(JobRepository jobs, ReportRepository reports, JsonService json, LlmService llm) {
        this.jobs = jobs;
        this.reports = reports;
        this.json = json;
        this.llm = llm;
    }

    @GetMapping
    public List<Map<String, Object>> list() {
        return jobs.findAll().stream().map(job -> {
            Map<String, Object> row = json.read(job.payload);
            row.put("id", job.id);
            row.put("name", job.name);
            row.put("status", job.status);
            row.put("published", job.published);
            row.put("candidates", Math.max(job.candidates, reports.findByJobIdOrderByCreatedAtDesc(job.id).size()));
            row.putIfAbsent("headcount", 1);
            row.put("reportCount", reports.findByJobIdOrderByCreatedAtDesc(job.id).size());
            return row;
        }).toList();
    }

    @PostMapping
    @Transactional
    public Map<String, Object> create(@RequestBody Map<String, Object> body) {
        String name = String.valueOf(body.getOrDefault("name", "")).trim();
        if (name.isBlank()) throw new ApiProblem(HttpStatus.BAD_REQUEST, "请填写岗位名称");
        if (jobs.existsByNameIgnoreCase(name)) throw new ApiProblem(HttpStatus.BAD_REQUEST, "已存在同名岗位");
        Instant now = Instant.now();
        JobEntity job = new JobEntity();
        job.id = "j" + System.currentTimeMillis() + UUID.randomUUID().toString().substring(0, 6);
        job.name = name;
        job.status = "draft".equals(body.get("status")) ? "draft" : "published";
        job.published = !"draft".equals(job.status);
        job.candidates = 0;
        job.createdAt = now;
        job.updatedAt = now;
        Map<String, Object> payload = new LinkedHashMap<>(body);
        payload.put("id", job.id);
        payload.put("name", name);
        payload.putIfAbsent("jd", "");
        payload.putIfAbsent("round1Count", 6);
        payload.putIfAbsent("round2Count", 6);
        payload.putIfAbsent("duration", 35);
        payload.putIfAbsent("headcount", 1);
        payload.put("status", job.status);
        payload.put("published", job.published);
        payload.put("candidates", 0);
        payload.put("createdAt", now.toString());
        payload.put("updatedAt", now.toString());
        job.payload = json.write(payload);
        jobs.save(job);
        return payload;
    }

    @PutMapping("/{id}")
    @Transactional
    public Map<String, Object> update(@PathVariable String id, @RequestBody Map<String, Object> body) {
        JobEntity job = jobs.findById(id).orElseThrow(() -> new ApiProblem(HttpStatus.NOT_FOUND, "岗位不存在"));
        Map<String, Object> payload = json.read(job.payload);
        body.forEach((key, value) -> { if (List.of("name", "jd", "headcount", "round1Count", "round2Count", "duration", "published", "status").contains(key)) payload.put(key, value); });
        job.name = String.valueOf(payload.getOrDefault("name", job.name));
        job.status = Boolean.FALSE.equals(payload.get("published")) || "draft".equals(payload.get("status")) ? "draft" : "published";
        job.published = !"draft".equals(job.status);
        payload.put("status", job.status);
        payload.put("published", job.published);
        payload.put("updatedAt", Instant.now().toString());
        job.updatedAt = Instant.now();
        job.payload = json.write(payload);
        jobs.save(job);
        return payload;
    }

    @DeleteMapping("/{id}")
    @Transactional
    public Map<String, Boolean> delete(@PathVariable String id) {
        if (!jobs.existsById(id)) throw new ApiProblem(HttpStatus.NOT_FOUND, "岗位不存在");
        jobs.deleteById(id);
        return Map.of("ok", true);
    }

    @GetMapping("/{id}/ai-prep")
    public Map<String, Object> aiPrep(@PathVariable String id) {
        JobEntity job = jobs.findById(id).orElseThrow(() -> new ApiProblem(HttpStatus.NOT_FOUND, "岗位不存在"));
        return Map.of("jobId", id, "prep", json.read(job.payload).getOrDefault("aiPrep", Map.of()), "llm", Map.of("enabled", llm.status().get("enabled")));
    }

    @PostMapping("/{id}/ai-prep")
    @Transactional
    public Map<String, Object> generateAiPrep(@PathVariable String id) {
        JobEntity job = jobs.findById(id).orElseThrow(() -> new ApiProblem(HttpStatus.NOT_FOUND, "岗位不存在"));
        if (!Boolean.TRUE.equals(llm.status().get("enabled"))) throw new ApiProblem(HttpStatus.SERVICE_UNAVAILABLE, "AI 未配置，请先填写 API 地址、模型和 API Key");
        Map<String,Object> payload=json.read(job.payload);
        try {
            JsonNode ai=llm.chatJson("你是招聘面试设计专家。只输出 JSON，字段包含 candidateProfile 数组、focus 数组、questions 数组、dimensions 数组、redFlags 数组；所有内容围绕岗位 JD，不得编造。", "岗位："+job.name+"\n岗位描述："+payload.getOrDefault("jd",""),2600);
            Map<String,Object>prep=new LinkedHashMap<>();prep.put("candidateProfile",nodeStrings(ai.path("candidateProfile")));prep.put("focus",nodeStrings(ai.path("focus")));prep.put("questions",nodeStrings(ai.path("questions")));prep.put("dimensions",nodeStrings(ai.path("dimensions")));prep.put("redFlags",nodeStrings(ai.path("redFlags")));prep.put("source","llm");prep.put("generatedAt",Instant.now().toString());payload.put("aiPrep",prep);payload.put("updatedAt",Instant.now().toString());job.payload=json.write(payload);job.updatedAt=Instant.now();jobs.save(job);return Map.of("jobId",id,"prep",prep,"llm",Map.of("enabled",true,"model",llm.status().get("model")));
        } catch(Exception e){throw new ApiProblem(HttpStatus.BAD_GATEWAY,"岗位 AI 生成失败："+e.getMessage());}
    }

    private static List<String> nodeStrings(JsonNode n){List<String>out=new ArrayList<>();if(n.isArray())n.forEach(x->{if(!x.asText().isBlank())out.add(x.asText());});return out;}
}
