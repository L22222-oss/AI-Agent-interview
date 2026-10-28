package com.interviewagent.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.Table;
import jakarta.persistence.Lob;
import jakarta.persistence.Transient;
import java.time.Instant;

@Entity
@Table(name = "jobs", indexes = @Index(name = "idx_jobs_name", columnList = "name"))
public class JobEntity {
    @Id
    @Column(length = 80)
    public String id;

    @Column(nullable = false, length = 200)
    public String name;

    @Column(nullable = false, length = 20)
    public String status;

    @Column(nullable = false)
    public boolean published;

    @Column(nullable = false)
    public int candidates;

    @Lob
    @Column(columnDefinition = "LONGTEXT")
    public String payload;

    @Column(nullable = false)
    public Instant createdAt;

    @Column(nullable = false)
    public Instant updatedAt;

    @Transient
    public int reportCount;

    public JobEntity() {}
}
