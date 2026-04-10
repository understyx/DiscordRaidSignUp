-- Migration 005: Absolute slot system
-- Converts role_slot from "role_N" format (e.g. "tank_1", "healer_3", "dps_10")
-- to "slot_N" format (e.g. "slot_1", "slot_3", "slot_10").
-- Adds slot_role column to store the role separately so that slot identity and
-- role are orthogonal: the unique key (raid_id, comp_number, role_slot) now
-- enforces that each slot NUMBER can only be occupied once per comp.

-- Step 1: Add slot_role column
ALTER TABLE compositions
  ADD COLUMN slot_role VARCHAR(20) NOT NULL DEFAULT 'dps' AFTER role_slot;

-- Step 2: Populate slot_role from the role prefix embedded in role_slot
UPDATE compositions
  SET slot_role = SUBSTRING_INDEX(role_slot, '_', 1);

-- Step 3: Remove duplicate slot numbers within the same comp.
-- Under the old scheme "healer_19" and "dps_19" were separate unique keys,
-- allowing the same physical slot to be double-booked.  Keep only the row
-- with the lowest id for each (raid_id, comp_number, slot_number).
DELETE c1 FROM compositions c1
  JOIN compositions c2
    ON  c2.raid_id     = c1.raid_id
    AND c2.comp_number = c1.comp_number
    AND SUBSTRING_INDEX(c2.role_slot, '_', -1) = SUBSTRING_INDEX(c1.role_slot, '_', -1)
    AND c2.id < c1.id;

-- Step 4: Convert role_slot to "slot_N" format
UPDATE compositions
  SET role_slot = CONCAT('slot_', SUBSTRING_INDEX(role_slot, '_', -1));
