package com.interviewagent.repository;

import com.interviewagent.model.UserEntity;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface UserRepository extends JpaRepository<UserEntity, String> {
    Optional<UserEntity> findByAccount(String account);
    boolean existsByAccount(String account);
}
