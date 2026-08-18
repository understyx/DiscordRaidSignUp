-- Migration 040: Durable, rate-limit-aware bulk Discord direct-message queue.

CREATE TABLE IF NOT EXISTS bulk_message_jobs (
    id               BIGINT NOT NULL AUTO_INCREMENT,
    guild_id         BIGINT NOT NULL,
    created_by       BIGINT NOT NULL,
    message_action   VARCHAR(50) NOT NULL,
    criteria_json    JSON NOT NULL,
    payload_json     JSON NOT NULL,
    recipient_count  INT NOT NULL DEFAULT 0,
    sent_count       INT NOT NULL DEFAULT 0,
    failed_count     INT NOT NULL DEFAULT 0,
    status           ENUM('queued', 'running', 'completed', 'completed_with_errors', 'failed') NOT NULL DEFAULT 'queued',
    created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at       DATETIME NULL,
    completed_at     DATETIME NULL,
    PRIMARY KEY (id),
    INDEX idx_bulk_message_jobs_guild_created (guild_id, created_at),
    INDEX idx_bulk_message_jobs_status (status)
);

CREATE TABLE IF NOT EXISTS bulk_message_recipients (
    job_id           BIGINT NOT NULL,
    discord_user_id  BIGINT NOT NULL,
    status           ENUM('pending', 'sending', 'sent', 'failed') NOT NULL DEFAULT 'pending',
    attempts         INT NOT NULL DEFAULT 0,
    next_attempt_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_error       VARCHAR(500) NULL,
    updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (job_id, discord_user_id),
    INDEX idx_bulk_message_recipients_pending (status, next_attempt_at),
    CONSTRAINT fk_bulk_message_recipient_job
      FOREIGN KEY (job_id) REFERENCES bulk_message_jobs(id) ON DELETE CASCADE
);
