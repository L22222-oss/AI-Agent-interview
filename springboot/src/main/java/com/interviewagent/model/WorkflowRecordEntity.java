package com.interviewagent.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.Lob;
import jakarta.persistence.Table;
import java.time.Instant;

@Entity
@Table(name = "workflow_records", indexes = @Index(name = "idx_workflow_kind", columnList = "kind"))
public class WorkflowRecordEntity {
    @Id @Column(length = 140) public String recordKey;
    @Column(nullable = false, length = 20) public String kind;
    @Lob @Column(columnDefinition = "LONGTEXT") public String payload;
    @Column(nullable = false) public Instant createdAt;
    public WorkflowRecordEntity() {}
}
