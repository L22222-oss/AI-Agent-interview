package com.interviewagent.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.stereotype.Service;

@Service
public class JsonService {
    private static final TypeReference<Map<String, Object>> MAP_TYPE = new TypeReference<>() {};
    private final ObjectMapper mapper;

    public JsonService(ObjectMapper mapper) {
        this.mapper = mapper;
    }

    public String write(Object value) {
        try { return mapper.writeValueAsString(value); }
        catch (Exception exception) { throw new IllegalStateException("JSON 序列化失败", exception); }
    }

    public Map<String, Object> read(String json) {
        if (json == null || json.isBlank()) return new LinkedHashMap<>();
        try { return mapper.readValue(json, MAP_TYPE); }
        catch (Exception exception) { throw new IllegalStateException("数据库 JSON 数据损坏", exception); }
    }
}
