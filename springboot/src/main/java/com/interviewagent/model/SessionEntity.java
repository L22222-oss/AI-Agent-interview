package com.interviewagent.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.Table;
import java.time.Instant;

@Entity
@Table(name = "app_sessions", indexes = @Index(name = "idx_sessions_user", columnList = "userId"))
public class SessionEntity {
    @Id
    @Column(length = 80)
    public String id;

    @Column(nullable = false, length = 80)
    public String userId;

    @Column(nullable = false)
    public Instant expiresAt;

    public SessionEntity() {}
}
