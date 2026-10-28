package com.interviewagent.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.interviewagent.model.JobEntity;
import com.interviewagent.model.OrganizationEntity;
import com.interviewagent.model.ReportEntity;
import com.interviewagent.model.SettingEntity;
import com.interviewagent.model.UserEntity;
import com.interviewagent.repository.JobRepository;
import com.interviewagent.repository.OrganizationRepository;
import com.interviewagent.repository.ReportRepository;
import com.interviewagent.repository.SettingRepository;
import com.interviewagent.repository.UserRepository;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.HashMap;
import org.bouncycastle.crypto.generators.SCrypt;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class JsonImportService implements ApplicationRunner {
    private final ObjectMapper mapper;
    private final JsonService json;
    private final JobRepository jobs;
    private final ReportRepository reports;
    private final UserRepository users;
    private final SettingRepository settings;
    private final OrganizationRepository organizations;
    private final PasswordService passwords;
    private final WorkflowStore workflows;

    @Value("${app.data-dir:../data}")
    private String dataDir;

    public JsonImportService(ObjectMapper mapper, JsonService json, JobRepository jobs, ReportRepository reports,
                             UserRepository users, SettingRepository settings, OrganizationRepository organizations,
                             PasswordService passwords, WorkflowStore workflows) {
        this.mapper = mapper;
        this.json = json;
        this.jobs = jobs;
        this.reports = reports;
        this.users = users;
        this.settings = settings;
        this.organizations = organizations;
        this.passwords = passwords;
        this.workflows = workflows;
    }

    @Override
    @Transactional
    public void run(ApplicationArguments args) throws Exception {
        Path root = Path.of(dataDir).toAbsolutePath().normalize();
        importUsers(root.resolve("users.json"));
        Map<String, Integer> interviewCounts = interviewCounts(root.resolve("interviews.json"));
        importJobs(root.resolve("jobs.json"), interviewCounts);
        importReports(root.resolve("reports.json"));
        importSettings(root.resolve("settings.json"));
        importOrganizations(root.resolve("orgs.json"));
        importWorkflowRows(root.resolve("plans.json"), "plan");
        importWorkflowRows(root.resolve("interviews.json"), "session");
        importWorkflowRows(root.resolve("resumes.json"), "resume");
        importWorkflowRows(root.resolve("reports.json"), "report");
    }

    private void importUsers(Path file) throws IOException {
        if (!Files.exists(file)) return;
        for (Map<String, Object> row : readRows(file)) {
            String id = text(row, "id");
            String account = text(row, "account");
            if (id.isBlank() || account.isBlank() || users.existsById(id) || users.existsByAccount(account)) continue;
            UserEntity user = new UserEntity();
            user.id = id;
            user.account = account;
            user.name = row.getOrDefault("name", user.account).toString();
            user.role = row.getOrDefault("role", "member").toString();
            user.createdAt = instant(row.get("createdAt"));
            user.passwordSalt = text(row, "salt");
            user.passwordHash = text(row, "hash");
            users.save(user);
        }
    }

    private void importJobs(Path file, Map<String, Integer> interviewCounts) throws IOException {
        if (!Files.exists(file)) return;
        for (Map<String, Object> row : readRows(file)) {
            saveJob(row, interviewCounts.getOrDefault(text(row, "id"), 0));
        }
    }

    private void saveJob(Map<String, Object> row, int interviewCount) {
        String id = text(row, "id");
        if (id.isBlank() || jobs.existsById(id)) return;
        JobEntity job = new JobEntity();
        job.id = id;
        job.name = row.getOrDefault("name", "未命名岗位").toString();
        job.status = "draft".equals(row.get("status")) || Boolean.FALSE.equals(row.get("published")) ? "draft" : "published";
        job.published = !"draft".equals(job.status);
        job.candidates = Math.max(integer(row.get("candidates")), interviewCount);
        row.put("candidates", job.candidates);
        job.payload = json.write(row);
        job.createdAt = instant(row.get("createdAt"));
        job.updatedAt = instant(row.get("updatedAt"));
        jobs.save(job);
    }

    private void importReports(Path file) throws IOException {
        if (!Files.exists(file)) return;
        for (Map<String, Object> row : readRows(file)) saveReport(row);
    }

    private void saveReport(Map<String, Object> row) {
        String id = text(row, "id");
        if (id.isBlank() || reports.existsById(id)) return;
        ReportEntity report = new ReportEntity();
        report.id = id;
        report.jobId = text(row, "jobId");
        report.stage = row.getOrDefault("stage", "pending").toString();
        report.payload = json.write(row);
        report.createdAt = instant(row.get("at"));
        reports.save(report);
    }

    private void importSettings(Path file) throws IOException {
        if (!Files.exists(file) || settings.existsById("global")) return;
        List<Map<String, Object>> rows = readRows(file);
        if (rows.isEmpty()) return;
        SettingEntity setting = new SettingEntity();
        setting.id = "global";
        setting.payload = json.write(rows.getFirst());
        setting.updatedAt = instant(rows.getFirst().get("updatedAt"));
        settings.save(setting);
    }

    private void importOrganizations(Path file) throws IOException {
        if (!Files.exists(file)) return;
        for (Map<String, Object> row : readRows(file)) {
            String id = text(row, "id");
            if (id.isBlank() || organizations.existsById(id)) continue;
            OrganizationEntity organization = new OrganizationEntity();
            organization.id = id;
            organization.name = text(row, "name");
            organization.ownerId = text(row, "ownerId");
            organization.createdAt = instant(row.get("createdAt"));
            organizations.save(organization);
        }
    }

    private Map<String, Integer> interviewCounts(Path file) throws IOException {
        Map<String, Integer> counts = new HashMap<>();
        if (!Files.exists(file)) return counts;
        for (Map<String, Object> row : readRows(file)) {
            String jobId = text(row, "jobId");
            if (!jobId.isBlank()) counts.merge(jobId, 1, Integer::sum);
        }
        return counts;
    }

    private List<Map<String, Object>> readRows(Path file) throws IOException {
        return mapper.readValue(file.toFile(), new TypeReference<>() {});
    }

    private void importWorkflowRows(Path file, String kind) throws IOException {
        if (Files.exists(file)) workflows.importRows(kind, readRows(file));
    }

    private static String text(Map<String, Object> row, String key) { return row.get(key) == null ? "" : row.get(key).toString(); }
    private static int integer(Object value) { try { return Integer.parseInt(String.valueOf(value)); } catch (Exception ignored) { return 0; } }
    private static Instant instant(Object value) { try { return Instant.parse(value.toString()); } catch (Exception ignored) { return Instant.now(); } }
}
