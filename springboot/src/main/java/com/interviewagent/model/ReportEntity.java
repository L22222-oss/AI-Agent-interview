package com.interviewagent.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.Lob;
import jakarta.persistence.Table;
import java.time.Instant;

@Entity
@Table(name = "reports", indexes = {
        @Index(name = "idx_reports_job_id", columnList = "jobId"),
        @Index(name = "idx_reports_stage", columnList = "stage")
})
public class ReportEntity {
    @Id
    @Column(length = 100)
    public String id;

    @Column(length = 80)
    public String jobId;

    @Column(nullable = false, length = 32)
    public String stage;

    @Lob
    @Column(columnDefinition = "LONGTEXT")
    public String payload;

    @Column(nullable = false)
    public Instant createdAt;

    public ReportEntity() {}
}
