-- Migration 018: recruitment system
-- Adds guild-specific application forms, questions, applications, answers,
-- and OAuth tokens for the recruitment feature.

CREATE TABLE IF NOT EXISTS recruitment_forms (
  id              INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  guild_id        BIGINT UNSIGNED NOT NULL,
  title           VARCHAR(255)    NOT NULL,
  description     TEXT,
  is_active       TINYINT(1)      NOT NULL DEFAULT 1,
  created_by      BIGINT UNSIGNED NOT NULL,
  created_at      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  recruit_role_id    BIGINT UNSIGNED DEFAULT NULL,
  invite_channel_id  BIGINT UNSIGNED DEFAULT NULL,
  PRIMARY KEY (id),
  INDEX idx_rf_guild (guild_id)
);

CREATE TABLE IF NOT EXISTS recruitment_questions (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  form_id       INT UNSIGNED NOT NULL,
  question_text TEXT         NOT NULL,
  question_type ENUM('text','textarea','select','radio') NOT NULL DEFAULT 'text',
  options       JSON         DEFAULT NULL,
  is_required   TINYINT(1)   NOT NULL DEFAULT 0,
  sort_order    INT          NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  INDEX idx_rq_form (form_id)
);

CREATE TABLE IF NOT EXISTS recruitment_applications (
  id                    INT UNSIGNED    NOT NULL AUTO_INCREMENT,
  form_id               INT UNSIGNED    NOT NULL,
  guild_id              BIGINT UNSIGNED NOT NULL,
  applicant_discord_id  BIGINT UNSIGNED NOT NULL,
  applicant_username    VARCHAR(100)    NOT NULL,
  applicant_display_name VARCHAR(100)  NOT NULL,
  status                ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
  wants_discord_notify  TINYINT(1)      NOT NULL DEFAULT 0,
  discord_invited       TINYINT(1)      NOT NULL DEFAULT 0,
  submitted_at          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_by           BIGINT UNSIGNED DEFAULT NULL,
  reviewed_at           DATETIME        DEFAULT NULL,
  PRIMARY KEY (id),
  INDEX idx_ra_form (form_id),
  INDEX idx_ra_guild (guild_id),
  INDEX idx_ra_applicant (applicant_discord_id)
);

CREATE TABLE IF NOT EXISTS recruitment_answers (
  id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
  application_id  INT UNSIGNED NOT NULL,
  question_id     INT UNSIGNED NOT NULL,
  answer_text     TEXT,
  PRIMARY KEY (id),
  INDEX idx_raa_application (application_id)
);

CREATE TABLE IF NOT EXISTS recruitment_oauth_tokens (
  applicant_discord_id  BIGINT UNSIGNED NOT NULL,
  guild_id              BIGINT UNSIGNED NOT NULL,
  access_token          VARCHAR(512)    NOT NULL,
  refresh_token         VARCHAR(512)    DEFAULT NULL,
  expires_at            DATETIME        DEFAULT NULL,
  PRIMARY KEY (applicant_discord_id, guild_id)
);
