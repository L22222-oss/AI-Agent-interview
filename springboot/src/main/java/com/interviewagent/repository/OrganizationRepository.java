package com.interviewagent.repository;

import com.interviewagent.model.OrganizationEntity;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface OrganizationRepository extends JpaRepository<OrganizationEntity, String> {
    List<OrganizationEntity> findAllByOrderByCreatedAtDesc();
}
