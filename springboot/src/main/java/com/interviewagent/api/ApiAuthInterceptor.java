package com.interviewagent.api;

import com.interviewagent.api.ApiExceptionHandler.ApiProblem;
import com.interviewagent.service.SessionService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

@Component
public class ApiAuthInterceptor implements HandlerInterceptor {
    private final SessionService sessions;

    public ApiAuthInterceptor(SessionService sessions) { this.sessions = sessions; }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        String path = request.getRequestURI();
        String method = request.getMethod();
        if (!path.startsWith("/api/")) return true;
        if ("GET".equals(method) && (path.equals("/api/health") || path.equals("/api/interview")
                || path.matches("/api/reports/[^/]+/offer") || path.matches("/api/agent/session/[^/]+"))) return true;
        if ("POST".equals(method) && (path.equals("/api/auth/login") || path.equals("/api/auth/register") || path.equals("/api/auth/logout")
                || path.equals("/api/interview/plan") || path.equals("/api/interview/plan2") || path.equals("/api/reports")
                || path.matches("/api/reports/[^/]+/offer/accept") || path.matches("/api/reports/[^/]+/contract/sign")
                || path.equals("/api/portal/lookup") || path.matches("/api/reports/[^/]+/practice")
                || path.equals("/api/agent/session/start") || path.equals("/api/agent/session/turn") || path.equals("/api/agent/session/finish")
                || path.equals("/api/agent/next-question") || path.equals("/api/agent/eval-round2"))) return true;
        if (sessions.current(request) == null) throw new ApiProblem(HttpStatus.UNAUTHORIZED, "未登录");
        return true;
    }
}
