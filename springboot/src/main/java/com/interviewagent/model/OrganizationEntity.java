package com.interviewagent.model;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;

@Entity
@Table(name = "organizations")
public class OrganizationEntity {
    @Id
    @Column(length = 80)
    public String id;

    @Column(nullable = false, length = 200)
    public String name;

    @Column(nullable = false, length = 80)
    public String ownerId;

    @Column(nullable = false)
    public Instant createdAt;

    public OrganizationEntity() {}
}
