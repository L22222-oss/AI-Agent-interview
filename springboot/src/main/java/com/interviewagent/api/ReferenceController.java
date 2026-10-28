package com.interviewagent.api;

import com.interviewagent.api.ApiExceptionHandler.ApiProblem;
import com.interviewagent.model.OrganizationEntity;
import com.interviewagent.model.SettingEntity;
import com.interviewagent.model.UserEntity;
import com.interviewagent.repository.OrganizationRepository;
import com.interviewagent.repository.SettingRepository;
import com.interviewagent.service.JsonService;
import com.interviewagent.service.SessionService;
import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class ReferenceController {
    private final OrganizationRepository organizations;
    private final SettingRepository settings;
    private final JsonService json;
    private final SessionService sessions;
    private final com.interviewagent.service.LlmService llm;

    public ReferenceController(OrganizationRepository organizations, SettingRepository settings, JsonService json, SessionService sessions, com.interviewagent.service.LlmService llm) {
        this.organizations = organizations;
        this.settings = settings;
        this.json = json;
        this.sessions = sessions;
        this.llm = llm;
    }

    @GetMapping("/api/roles")
    public List<Map<String, String>> roles() {
        return List.of(Map.of("id", "admin", "name", "管理员", "desc", "可管理岗位与企业"), Map.of("id", "member", "name", "成员", "desc", "仅可面试与查看"));
    }

    @GetMapping("/api/orgs")
    public List<Map<String, Object>> orgs() {
        return organizations.findAllByOrderByCreatedAtDesc().stream().map(org -> Map.<String, Object>of("id", org.id, "name", org.name, "ownerId", org.ownerId, "createdAt", org.createdAt.toString())).toList();
    }

    @PostMapping("/api/orgs")
    public Map<String, Object> createOrg(@RequestBody Map<String, Object> body, HttpServletRequest request) {
        String name = String.valueOf(body.getOrDefault("name", "")).trim();
        if (name.isBlank()) throw new ApiProblem(HttpStatus.BAD_REQUEST, "请填写企业名称");
        UserEntity user = sessions.current(request);
        OrganizationEntity org = new OrganizationEntity();
        org.id = "o" + UUID.randomUUID().toString().replace("-", "");
        org.name = name;
        org.ownerId = user.id;
        org.createdAt = Instant.now();
        organizations.save(org);
        return Map.of("id", org.id, "name", org.name, "ownerId", org.ownerId, "createdAt", org.createdAt.toString());
    }

    @GetMapping("/api/settings")
    public Map<String, Object> settings() {
        return settings.findById("global").map(item -> json.read(item.payload)).orElseGet(() -> Map.of("id", "global", "retentionDays", 90, "contactEmail", "", "autoAdvance", true));
    }

    @PutMapping("/api/settings")
    public Map<String, Object> saveSettings(@RequestBody Map<String, Object> changes) {
        SettingEntity setting = settings.findById("global").orElseGet(() -> {
            SettingEntity created = new SettingEntity(); created.id = "global"; created.payload = "{}"; created.updatedAt = Instant.now(); return created;
        });
        Map<String, Object> merged = new LinkedHashMap<>(json.read(setting.payload));
        merged.putIfAbsent("id", "global"); merged.putIfAbsent("retentionDays", 90); merged.putIfAbsent("contactEmail", ""); merged.putIfAbsent("autoAdvance", true);
        merged.putAll(changes);
        merged.put("updatedAt", Instant.now().toString());
        setting.payload = json.write(merged); setting.updatedAt = Instant.now(); settings.save(setting);
        return merged;
    }

    @GetMapping("/api/health")
    public Map<String, Object> health() {
        return Map.of("ok", true, "backend", "springboot", "database", "mysql");
    }
}
