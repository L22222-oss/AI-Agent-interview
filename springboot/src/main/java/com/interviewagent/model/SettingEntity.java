package com.interviewagent.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Lob;
import jakarta.persistence.Table;
import java.time.Instant;

@Entity
@Table(name = "app_settings")
public class SettingEntity {
    @Id
    @Column(length = 40)
    public String id;

    @Lob
    @Column(columnDefinition = "LONGTEXT", nullable = false)
    public String payload;

    @Column(nullable = false)
    public Instant updatedAt;

    public SettingEntity() {}
}
