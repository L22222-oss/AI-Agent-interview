package com.interviewagent.service;

import com.interviewagent.api.ApiExceptionHandler.ApiProblem;
import com.interviewagent.model.WorkflowRecordEntity;
import com.interviewagent.repository.WorkflowRecordRepository;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class WorkflowStore {
    private final WorkflowRecordRepository records;
    private final JsonService json;

    public WorkflowStore(WorkflowRecordRepository records, JsonService json) { this.records = records; this.json = json; }

    public Map<String, Object> get(String kind, String id) {
        return records.findByKindAndRecordKey(kind, key(kind, id)).map(row -> json.read(row.payload))
                .orElseThrow(() -> new ApiProblem(HttpStatus.NOT_FOUND, kind.equals("report") ? "报告不存在" : "记录不存在"));
    }

    public Map<String, Object> find(String kind, String id) {
        return records.findByKindAndRecordKey(kind, key(kind, id)).map(row -> json.read(row.payload)).orElse(null);
    }

    public List<Map<String, Object>> list(String kind) {
        return records.findAllByKindOrderByCreatedAtDesc(kind).stream().map(row -> json.read(row.payload)).toList();
    }

    @Transactional
    public Map<String, Object> save(String kind, Map<String, Object> payload) {
        String id = String.valueOf(payload.get("id"));
        String recordKey = key(kind, id);
        WorkflowRecordEntity row = records.findById(recordKey).orElseGet(WorkflowRecordEntity::new);
        row.recordKey = recordKey;
        row.kind = kind;
        row.payload = json.write(payload);
        row.createdAt = row.createdAt == null ? Instant.now() : row.createdAt;
        records.save(row);
        return payload;
    }

    @Transactional
    public void importRows(String kind, List<Map<String, Object>> rows) {
        for (Map<String, Object> payload : rows) {
            Object id = payload.get("id");
            if (id != null && records.findById(key(kind, id.toString())).isEmpty()) save(kind, payload);
        }
    }

    private static String key(String kind, String id) { return kind + ":" + id; }
}
