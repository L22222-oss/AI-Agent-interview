package com.interviewagent.api;

import com.interviewagent.api.ApiExceptionHandler.ApiProblem;
import com.interviewagent.model.SessionEntity;
import com.interviewagent.model.UserEntity;
import com.interviewagent.repository.SessionRepository;
import com.interviewagent.repository.UserRepository;
import com.interviewagent.service.PasswordService;
import com.interviewagent.service.SessionService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Map;
import java.util.UUID;
import org.bouncycastle.crypto.generators.SCrypt;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.transaction.annotation.Transactional;

@RestController
@RequestMapping("/api/auth")
public class AuthController {
    private final UserRepository users;
    private final SessionRepository sessions;
    private final PasswordService passwords;
    private final SessionService sessionService;

    @Value("${app.session.ttl-hours:168}")
    private long ttlHours;

    public AuthController(UserRepository users, SessionRepository sessions, PasswordService passwords, SessionService sessionService) {
        this.users = users;
        this.sessions = sessions;
        this.passwords = passwords;
        this.sessionService = sessionService;
    }

    @PostMapping("/login")
    public Map<String, Object> login(@RequestBody Map<String, Object> body, HttpServletResponse response) {
        String account = String.valueOf(body.getOrDefault("account", ""));
        String password = String.valueOf(body.getOrDefault("password", ""));
        UserEntity user = users.findByAccount(account).orElse(null);
        if (user == null || !matchesNodeScrypt(password, user.passwordSalt, user.passwordHash)) {
            throw new ApiProblem(HttpStatus.UNAUTHORIZED, "账号或密码不正确");
        }
        sessionService.start(user, response);
        return SessionService.publicUser(user);
    }

    @PostMapping("/register")
    @Transactional
    public Map<String, Object> register(@RequestBody Map<String, Object> body, HttpServletResponse response) {
        String account = String.valueOf(body.getOrDefault("account", "")).trim();
        String name = String.valueOf(body.getOrDefault("name", account)).trim();
        String password = String.valueOf(body.getOrDefault("password", ""));
        if (account.length() < 3 || account.length() > 40 || !account.matches("[\\w.+-]{3,40}")) throw new ApiProblem(HttpStatus.BAD_REQUEST, "请输入账号（3-40 位英文字母、数字或 . _ + -）。");
        if (name.length() > 30) throw new ApiProblem(HttpStatus.BAD_REQUEST, "显示名最多 30 个字。");
        if (password.length() < 6) throw new ApiProblem(HttpStatus.BAD_REQUEST, "密码太短：至少需要 6 位。");
        if (users.existsByAccount(account)) throw new ApiProblem(HttpStatus.BAD_REQUEST, "该账号已被注册。");
        UserEntity user = new UserEntity();
        user.id = "u" + UUID.randomUUID().toString().replace("-", "");
        user.account = account;
        user.name = name.isBlank() ? account : name;
        user.role = users.count() == 0 ? "admin" : "member";
        user.passwordSalt = passwords.newSalt();
        user.passwordHash = passwords.hash(password, user.passwordSalt);
        user.createdAt = Instant.now();
        users.save(user);
        sessionService.start(user, response);
        return SessionService.publicUser(user);
    }

    @PostMapping("/logout")
    public Map<String, Boolean> logout(HttpServletRequest request, HttpServletResponse response) {
        sessionService.end(request, response);
        return Map.of("ok", true);
    }

    @GetMapping("/session")
    public Map<String, Object> session(HttpServletRequest request) {
        UserEntity user = sessionService.current(request);
        if (user == null) throw new ApiProblem(HttpStatus.UNAUTHORIZED, "未登录");
        return SessionService.publicUser(user);
    }

    private boolean matchesNodeScrypt(String password, String saltHex, String expectedHex) {
        try {
            byte[] actual = SCrypt.generate(password.getBytes(java.nio.charset.StandardCharsets.UTF_8), java.util.HexFormat.of().parseHex(saltHex), 16384, 8, 1, 32);
            return java.security.MessageDigest.isEqual(actual, java.util.HexFormat.of().parseHex(expectedHex));
        } catch (Exception ignored) { return false; }
    }
}
