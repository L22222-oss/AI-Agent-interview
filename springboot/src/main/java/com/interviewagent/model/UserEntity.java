package com.interviewagent.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;

@Entity
@Table(name = "app_users")
public class UserEntity {
    @Id
    @Column(length = 80)
    public String id;

    @Column(nullable = false, unique = true, length = 40)
    public String account;

    @Column(nullable = false, length = 80)
    public String name;

    @Column(nullable = false, length = 20)
    public String role;

    @Column(nullable = false, length = 64)
    public String passwordSalt;

    @Column(nullable = false, length = 64)
    public String passwordHash;

    @Column(nullable = false)
    public Instant createdAt;

    public UserEntity() {}
}
