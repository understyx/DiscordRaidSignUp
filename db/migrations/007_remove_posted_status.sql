-- Migration 007: Remove 'posted' raid status
-- Convert any existing 'posted' raids to 'locked', then drop 'posted' from the ENUM.

UPDATE raids SET status = 'locked' WHERE status = 'posted';

ALTER TABLE raids MODIFY COLUMN status ENUM('open', 'locked') NOT NULL DEFAULT 'open';
