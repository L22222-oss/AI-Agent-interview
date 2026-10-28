package com.interviewagent.repository;

import com.interviewagent.model.ReportEntity;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ReportRepository extends JpaRepository<ReportEntity, String> {
    List<ReportEntity> findAllByOrderByCreatedAtDesc();
    List<ReportEntity> findByJobIdOrderByCreatedAtDesc(String jobId);
}
