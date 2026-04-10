-- Migration 008: Soft-delete characters
-- Instead of hard-deleting a character (which breaks historical signup records),
-- set is_deleted = 1 to hide it from listings while preserving raid history.

ALTER TABLE characters
  ADD COLUMN is_deleted TINYINT(1) NOT NULL DEFAULT 0;
