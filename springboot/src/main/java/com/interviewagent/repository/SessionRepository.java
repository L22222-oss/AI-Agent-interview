package com.interviewagent.repository;

import com.interviewagent.model.SessionEntity;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface SessionRepository extends JpaRepository<SessionEntity, String> {
    Optional<SessionEntity> findByIdAndExpiresAtAfter(String id, java.time.Instant now);
}
