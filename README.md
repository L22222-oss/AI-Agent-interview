# Interview Agent

Vue 3 frontend, Spring Boot REST API, and MySQL persistence.

## Requirements

- Java 21
- Node.js 18.17 or newer
- MySQL 8

## Configure MySQL

Create the database in MySQL:

```sql
CREATE DATABASE interview_agent CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

In PowerShell, set credentials for the current terminal (replace the password):

```powershell
$env:DB_USERNAME = "root"
$env:DB_PASSWORD = "your_mysql_password"
```

The application uses `DB_URL` when set; otherwise it connects to the local `interview_agent` database. The password is intentionally not included in this repository.

## Run in development

From this directory:

```powershell
npm install
npm run dev
```

Open `http://127.0.0.1:5173`. Vite serves Vue and proxies `/api` requests to Spring Boot on port 8080. `npm run dev` starts both development processes.

## Build and run the backend

```powershell
npm install
npm run build
.\springboot\mvnw.cmd -f .\springboot\pom.xml package
java -jar .\springboot\target\interview-agent-api-1.0.0.jar
```

The Maven build includes `vueeee/dist` in the Spring Boot JAR when the frontend has been built. The app then serves the frontend and API from port 8080.

## Notes

- This distribution contains no Node.js backend. Spring Boot owns the API.
- MySQL tables are managed by Spring Data JPA/Hibernate on startup.
- No personal JSON data or AI-provider credentials are included. Configure AI settings in the application after startup.
- Set `DB_URL`, `DB_USERNAME`, and `DB_PASSWORD` as environment variables before starting Spring Boot.
