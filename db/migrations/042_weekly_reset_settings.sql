-- Per-guild weekly reset boundary used for cross-raid composition warnings.
-- Weekdays use JavaScript numbering: Sunday = 0 through Saturday = 6.

ALTER TABLE guild_settings
ADD COLUMN weekly_reset_weekday TINYINT UNSIGNED NOT NULL DEFAULT 3,
ADD COLUMN weekly_reset_time TIME NOT NULL DEFAULT '09:00:00',
ADD COLUMN weekly_reset_timezone VARCHAR(64) NOT NULL DEFAULT 'Europe/Berlin';
