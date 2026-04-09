-- Migration 003: allow placeholder entries in compositions
-- Make character_id nullable and add placeholder_text column

ALTER TABLE compositions
  MODIFY COLUMN character_id INT NULL;

ALTER TABLE compositions
  ADD COLUMN placeholder_text VARCHAR(100) NULL AFTER character_id;
