-- Migration 021: Schema-driven form generator enhancements
-- Adds per-question defaults, field grouping (with repeatable support),
-- and multi-column layout control.

ALTER TABLE recruitment_questions ADD COLUMN default_value TEXT DEFAULT NULL;
ALTER TABLE recruitment_questions ADD COLUMN group_key VARCHAR(100) DEFAULT NULL;
ALTER TABLE recruitment_questions ADD COLUMN group_label VARCHAR(255) DEFAULT NULL;
ALTER TABLE recruitment_questions ADD COLUMN is_group_repeatable TINYINT(1) NOT NULL DEFAULT 0;
ALTER TABLE recruitment_questions ADD COLUMN col_width ENUM('full','half','third') NOT NULL DEFAULT 'full';
