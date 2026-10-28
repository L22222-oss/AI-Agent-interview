package com.interviewagent.repository;

import com.interviewagent.model.WorkflowRecordEntity;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface WorkflowRecordRepository extends JpaRepository<WorkflowRecordEntity, String> {
    Optional<WorkflowRecordEntity> findByKindAndRecordKey(String kind, String recordKey);
    List<WorkflowRecordEntity> findAllByKindOrderByCreatedAtDesc(String kind);
}
