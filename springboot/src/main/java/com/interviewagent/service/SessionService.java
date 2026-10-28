package com.interviewagent.service;

import com.interviewagent.model.SessionEntity;
import com.interviewagent.model.UserEntity;
import com.interviewagent.repository.SessionRepository;
import com.interviewagent.repository.UserRepository;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HexFormat;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.stereotype.Service;

@Service
public class SessionService {
    public static final String COOKIE_NAME = "iv_session";
    private static final SecureRandom RANDOM = new SecureRandom();
    private final SessionRepository sessions;
    private final UserRepository users;

    @Value("${app.session.ttl-hours:168}")
    private long ttlHours;

    public SessionService(SessionRepository sessions, UserRepository users) {
        this.sessions = sessions;
        this.users = users;
    }

    public UserEntity current(HttpServletRequest request) {
        String id = cookieValue(request, COOKIE_NAME);
        if (id == null) return null;
        return sessions.findByIdAndExpiresAtAfter(id, Instant.now())
                .flatMap(session -> users.findById(session.userId)).orElse(null);
    }

    public void start(UserEntity user, HttpServletResponse response) {
        byte[] bytes = new byte[24];
        RANDOM.nextBytes(bytes);
        String id = HexFormat.of().formatHex(bytes);
        SessionEntity session = new SessionEntity();
        session.id = id;
        session.userId = user.id;
        session.expiresAt = Instant.now().plus(ttlHours, ChronoUnit.HOURS);
        sessions.save(session);
        response.addHeader(HttpHeaders.SET_COOKIE, ResponseCookie.from(COOKIE_NAME, id)
                .httpOnly(true).sameSite("Lax").path("/").maxAge(ttlHours * 3600).build().toString());
    }

    public void end(HttpServletRequest request, HttpServletResponse response) {
        String id = cookieValue(request, COOKIE_NAME);
        if (id != null) sessions.deleteById(id);
        response.addHeader(HttpHeaders.SET_COOKIE, ResponseCookie.from(COOKIE_NAME, "")
                .httpOnly(true).sameSite("Lax").path("/").maxAge(0).build().toString());
    }

    public static String cookieValue(HttpServletRequest request, String name) {
        Cookie[] cookies = request.getCookies();
        if (cookies == null) return null;
        for (Cookie cookie : cookies) if (name.equals(cookie.getName())) return cookie.getValue();
        return null;
    }

    public static Map<String, Object> publicUser(UserEntity user) {
        return Map.of("id", user.id, "account", user.account, "name", user.name, "role", user.role);
    }
}
