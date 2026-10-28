package com.interviewagent.service;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class PasswordServiceTest {
    private final PasswordService passwords = new PasswordService();

    @Test
    void hashesAndVerifiesPasswords() {
        String salt = passwords.newSalt();
        String hash = passwords.hash("test-password", salt);

        assertTrue(passwords.matches("test-password", salt, hash));
        assertFalse(passwords.matches("wrong-password", salt, hash));
    }
}
