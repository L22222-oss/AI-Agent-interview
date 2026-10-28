package com.interviewagent.service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.HexFormat;
import org.bouncycastle.crypto.generators.SCrypt;
import org.springframework.stereotype.Service;

@Service
public class PasswordService {
    private static final SecureRandom RANDOM = new SecureRandom();

    public String newSalt() {
        byte[] salt = new byte[16];
        RANDOM.nextBytes(salt);
        return HexFormat.of().formatHex(salt);
    }

    public String hash(String password, String saltHex) {
        try {
            byte[] hash = SCrypt.generate(password.getBytes(StandardCharsets.UTF_8), HexFormat.of().parseHex(saltHex), 16384, 8, 1, 32);
            return HexFormat.of().formatHex(hash);
        } catch (Exception exception) {
            throw new IllegalStateException("密码哈希失败", exception);
        }
    }

    public boolean matches(String password, String salt, String expectedHash) {
        return MessageDigest.isEqual(HexFormat.of().parseHex(hash(password, salt)), HexFormat.of().parseHex(expectedHash));
    }
}
