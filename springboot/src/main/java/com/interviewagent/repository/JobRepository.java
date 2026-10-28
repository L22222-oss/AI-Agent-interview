package com.interviewagent.repository;

import com.interviewagent.model.JobEntity;
import org.springframework.data.jpa.repository.JpaRepository;

public interface JobRepository extends JpaRepository<JobEntity, String> {
    boolean existsByNameIgnoreCase(String name);
}
