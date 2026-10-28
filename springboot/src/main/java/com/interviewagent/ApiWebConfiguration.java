package com.interviewagent;

import com.interviewagent.api.ApiAuthInterceptor;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.InterceptorRegistry;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;

@Configuration
public class ApiWebConfiguration implements WebMvcConfigurer {
    private final ApiAuthInterceptor authInterceptor;
    public ApiWebConfiguration(ApiAuthInterceptor authInterceptor) { this.authInterceptor = authInterceptor; }
    @Override public void addInterceptors(InterceptorRegistry registry) { registry.addInterceptor(authInterceptor).addPathPatterns("/api/**"); }
}
