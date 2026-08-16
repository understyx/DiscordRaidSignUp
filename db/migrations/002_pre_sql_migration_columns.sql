-- Columns introduced before SQL migrations became the canonical schema history.
ALTER TABLE signups
  ADD COLUMN is_saved TINYINT(1) NOT NULL DEFAULT 0 AFTER status;

ALTER TABLE raids
  ADD COLUMN discord_log_thread_id BIGINT NULL AFTER discord_channel_id;

ALTER TABLE compositions
  ADD COLUMN comp_number INT NOT NULL DEFAULT 1 AFTER role_slot;
