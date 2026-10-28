package com.interviewagent.api;

import com.interviewagent.api.ApiExceptionHandler.ApiProblem;
import com.interviewagent.model.ReportEntity;
import com.interviewagent.repository.ReportRepository;
import com.interviewagent.service.JsonService;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/reports")
public class ReportController {
    private final ReportRepository reports;
    private final JsonService json;

    public ReportController(ReportRepository reports, JsonService json) {
        this.reports = reports;
        this.json = json;
    }

    @GetMapping
    public List<Map<String, Object>> list(@RequestParam(required = false) String jobId) {
        List<ReportEntity> rows = jobId == null ? reports.findAllByOrderByCreatedAtDesc() : reports.findByJobIdOrderByCreatedAtDesc(jobId);
        return rows.stream().map(this::view).toList();
    }

    @GetMapping("/{id}")
    public Map<String, Object> get(@PathVariable String id) {
        return reports.findById(id).map(this::view).orElseThrow(() -> new ApiProblem(HttpStatus.NOT_FOUND, "报告不存在"));
    }

    private Map<String, Object> view(ReportEntity entity) {
        Map<String, Object> row = json.read(entity.payload);
        row.put("id", entity.id);
        row.put("jobId", entity.jobId);
        row.put("stage", entity.stage);
        row.putIfAbsent("recommend", recommendation(row));
        return row;
    }

    private Map<String, String> recommendation(Map<String, Object> row) {
        return switch (String.valueOf(row.getOrDefault("stage", "pending"))) {
            case "pending" -> Map.of("action", "round2", "text", "待审核第一轮结果，可决定是否进入第二轮。");
            case "interviewing" -> Map.of("action", "review", "text", "第二轮进行中或已完成，请查看评估结果。");
            case "practice" -> Map.of("action", "practice", "text", "候选人已通过第二轮，可等待实操作品提交。");
            case "evaluated" -> Map.of("action", "offer", "text", "评估已完成，可决定是否发出 Offer。");
            case "offer" -> Map.of("action", "offer", "text", "Offer 已发送，等待候选人确认。");
            case "signing" -> Map.of("action", "sign", "text", "候选人已接受 Offer，等待完成签约。");
            case "signed" -> Map.of("action", "done", "text", "合同已签署，流程完成。");
            default -> Map.of("action", "review", "text", "查看候选人面试记录。");
        };
    }
}
