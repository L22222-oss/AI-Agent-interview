package com.interviewagent.repository;

import com.interviewagent.model.SettingEntity;
import org.springframework.data.jpa.repository.JpaRepository;

public interface SettingRepository extends JpaRepository<SettingEntity, String> {}
