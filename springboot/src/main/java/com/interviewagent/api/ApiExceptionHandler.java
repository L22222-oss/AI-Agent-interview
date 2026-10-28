package com.interviewagent.api;

import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class ApiExceptionHandler {
    @ExceptionHandler(ApiProblem.class)
    public ResponseEntity<Map<String, String>> apiProblem(ApiProblem problem) {
        return ResponseEntity.status(problem.status).body(Map.of("error", problem.getMessage()));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, String>> unexpected(Exception exception) {
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(Map.of("error", "服务端错误"));
    }

    public static class ApiProblem extends RuntimeException {
        public final HttpStatus status;
        public ApiProblem(HttpStatus status, String message) { super(message); this.status = status; }
    }
}
