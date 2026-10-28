package com.interviewagent.api;

import com.interviewagent.api.ApiExceptionHandler.ApiProblem;
import com.interviewagent.model.UserEntity;
import com.interviewagent.repository.UserRepository;
import com.interviewagent.service.PasswordService;
import com.interviewagent.service.SessionService;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/account")
public class AccountController {
    private final UserRepository users
    private final SessionService sessions;
    private final PasswordService passwords;

    public AccountController(UserRepository users, SessionService sessions, PasswordService passwords) {
        this.users = users;
        this.sessions = sessions;
        this.passwords = passwords;
    }

    @PostMapping("/password")
    public Map<String, Boolean> password(@RequestBody Map<String, String> body, HttpServletRequest request) {
        UserEntity user = sessions.current(request);
        if (user == null) throw new ApiProblem(HttpStatus.UNAUTHORIZED, "未登录");
        String oldPassword = body.getOrDefault("oldPassword", "");
        if (!matchesExisting(oldPassword, user)) throw new ApiProblem(HttpStatus.BAD_REQUEST, "原密码不正确");
        String next = body.getOrDefault("newPassword", "");
        if (next.length() < 6) throw new ApiProblem(HttpStatus.BAD_REQUEST, "新密码至少 6 位");
        user.passwordSalt = passwords.newSalt();
        user.passwordHash = passwords.hash(next, user.passwordSalt);
        users.save(user);
        return Map.of("ok", true);
    }

    private boolean matchesExisting(String password, UserEntity user) {
        try {
            byte[] actual = org.bouncycastle.crypto.generators.SCrypt.generate(password.getBytes(java.nio.charset.StandardCharsets.UTF_8), java.util.HexFormat.of().parseHex(user.passwordSalt), 16384, 8, 1, 32);
            return java.security.MessageDigest.isEqual(actual, java.util.HexFormat.of().parseHex(user.passwordHash));
        } catch (Exception ignored) { return false; }
    }
}
