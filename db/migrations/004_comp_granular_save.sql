-- Migration 004: Per-slot granular saves for the compositions table
-- Adds updated_at for version tracking and a unique key to support per-slot UPSERT.

ALTER TABLE compositions
  ADD COLUMN updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3);

-- Back-fill existing rows so updated_at is not empty
UPDATE compositions SET updated_at = created_at WHERE updated_at IS NULL OR updated_at = 0;

-- Unique constraint required for INSERT ... ON DUPLICATE KEY UPDATE per slot
ALTER TABLE compositions
  ADD UNIQUE KEY uq_comp_slot (raid_id, comp_number, role_slot);
