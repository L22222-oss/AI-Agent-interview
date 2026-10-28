package com.interviewagent.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

@Service
public class LlmService {
    private static final Map<String, Map<String, Object>> PROVIDERS = buildProviders();
    private final ObjectMapper mapper;
    private final RestClient.Builder clientBuilder;
    @Value("${app.data-dir:data}") private String dataDir;

    public LlmService(ObjectMapper mapper, RestClient.Builder clientBuilder) { this.mapper = mapper; this.clientBuilder = clientBuilder; }

    public Map<String, Object> status() {
        Map<String, Object> c = config();
        String key = str(c.get("apiKey"));
        String provider = str(c.get("provider"));
        boolean needsKey = !"ollama".equals(provider);
        boolean enabled = !str(c.get("baseUrl")).isBlank() && !str(c.get("model")).isBlank() && (!needsKey || !key.isBlank());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("enabled", enabled); out.put("provider", provider); out.put("provider_name", PROVIDERS.containsKey(provider) ? PROVIDERS.get(provider).get("name") : "自定义端点");
        out.put("base_url", c.get("baseUrl")); out.put("model", c.get("model")); out.put("timeout", c.getOrDefault("timeout", 30000));
        out.put("key_set", !key.isBlank()); out.put("key_hint", key.isBlank() ? "" : "****" + key.substring(Math.max(0, key.length() - 4)));
        out.put("source", Files.exists(configPath()) ? "runtime" : System.getenv("LLM_API_KEY") != null ? "env" : "default");
        return out;
    }

    public List<Map<String, Object>> providers() { return PROVIDERS.entrySet().stream().map(e -> Map.<String, Object>of("id", e.getKey(), "name", e.getValue().get("name"), "base_url", e.getValue().get("base"), "model", e.getValue().get("model"), "needs_key", e.getValue().get("needsKey"))).toList(); }

    public Map<String, Object> save(Map<String, Object> patch) {
        Map<String, Object> next = config();
        for (String key : List.of("provider", "baseUrl", "apiKey", "model", "timeout")) if (patch.containsKey(key)) next.put(key, patch.get(key));
        String provider = str(next.get("provider"));
        Map<String, Object> preset = PROVIDERS.get(provider);
        if (preset != null) {
            if (str(next.get("baseUrl")).isBlank()) next.put("baseUrl", preset.get("base"));
            if (str(next.get("model")).isBlank()) next.put("model", preset.get("model"));
        }
        try { Files.createDirectories(configPath().getParent()); mapper.writerWithDefaultPrettyPrinter().writeValue(configPath().toFile(), next); }
        catch (Exception e) { throw new IllegalStateException("LLM 配置保存失败", e); }
        return status();
    }

    public JsonNode chatJson(String system, String user, int maxTokens) {
        Map<String, Object> c = config();
        if (!Boolean.TRUE.equals(status().get("enabled"))) throw new IllegalStateException("LLM 未配置");
        Map<String, Object> body = Map.of("model", c.get("model"), "messages", List.of(Map.of("role", "system", "content", system), Map.of("role", "user", "content", user)), "temperature", 0.4, "stream", false, "response_format", Map.of("type", "json_object"), "max_tokens", maxTokens);
        RestClient client = clientBuilder.baseUrl(trimSlash(str(c.get("baseUrl"))) + "/chat/completions").build();
        String raw = client.post().contentType(MediaType.APPLICATION_JSON).headers(h -> { String k = str(c.get("apiKey")); if (!k.isBlank()) h.setBearerAuth(k); }).body(body).retrieve().body(JsonNode.class).path("choices").path(0).path("message").path("content").asText();
        try { return mapper.readTree(raw.replaceAll("(?s)^\\s*```(?:json)?\\s*|\\s*```\\s*$", "")); }
        catch (Exception e) { throw new IllegalStateException("模型返回的 JSON 格式无效", e); }
    }

    public Map<String, Object> probe() {
        long start = System.currentTimeMillis();
        try { String content = chatJson("只回复 JSON：{\"reply\":\"ok\"}", "ping", 16).path("reply").asText(); return Map.of("ok", true, "latency_ms", System.currentTimeMillis() - start, "model", config().get("model"), "reply", content); }
        catch (Exception e) { return Map.of("ok", false, "reason", String.valueOf(e.getMessage())); }
    }

    private Map<String, Object> config() {
        try { if (Files.exists(configPath())) return mapper.readValue(configPath().toFile(), mapper.getTypeFactory().constructMapType(LinkedHashMap.class, String.class, Object.class)); }
        catch (Exception ignored) {}
        String provider = System.getenv().getOrDefault("LLM_PROVIDER", "custom");
        Map<String, Object> c = new LinkedHashMap<>(); c.put("provider", provider); c.put("baseUrl", System.getenv().getOrDefault("LLM_BASE_URL", "")); c.put("apiKey", System.getenv().getOrDefault("LLM_API_KEY", "")); c.put("model", System.getenv().getOrDefault("LLM_MODEL", "")); c.put("timeout", 30000);
        return c;
    }
    private Path configPath() { return Path.of(dataDir, "llm.json").toAbsolutePath().normalize(); }
    private static String str(Object v) { return v == null ? "" : String.valueOf(v); }
    private static String trimSlash(String v) { return v.replaceAll("/+$", ""); }
    private static Map<String, Map<String, Object>> buildProviders() {
        Map<String, Map<String, Object>> m = new LinkedHashMap<>();
        m.put("deepseek", Map.of("name", "DeepSeek", "base", "https://api.deepseek.com/v1", "model", "deepseek-chat", "needsKey", true));
        m.put("openai", Map.of("name", "OpenAI", "base", "https://api.openai.com/v1", "model", "gpt-4o-mini", "needsKey", true));
        m.put("moonshot", Map.of("name", "Moonshot 月之暗面", "base", "https://api.moonshot.cn/v1", "model", "moonshot-v1-8k", "needsKey", true));
        m.put("dashscope", Map.of("name", "阿里云百炼 / 通义千问", "base", "https://dashscope.aliyuncs.com/compatible-mode/v1", "model", "qwen-plus", "needsKey", true));
        m.put("zhipu", Map.of("name", "智谱 GLM", "base", "https://open.bigmodel.cn/api/paas/v4", "model", "glm-4-flash", "needsKey", true));
        m.put("siliconflow", Map.of("name", "硅基流动", "base", "https://api.siliconflow.cn/v1", "model", "Qwen/Qwen2.5-7B-Instruct", "needsKey", true));
        m.put("ollama", Map.of("name", "Ollama", "base", "http://127.0.0.1:11434/v1", "model", "qwen2.5:7b", "needsKey", false));
        m.put("custom", Map.of("name", "自定义端点", "base", "", "model", "", "needsKey", true));
        return m;
    }
}
