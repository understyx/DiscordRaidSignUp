-- Migration 016: normalize shared-lockout instance names to their canonical form.
-- ICC10 / ICC10 HC, ICC25 / ICC25 HC, TOC10 / TOGC10, TOC25 / TOGC25,
-- RS10 / RS10 HC, RS25 / RS25 HC each share a single weekly lockout.
-- Any existing rows stored under the non-canonical alias are merged into the
-- canonical row (INSERT … ON DUPLICATE KEY UPDATE) then deleted.

-- ICC10 HC → ICC10
INSERT INTO char_raid_saves (character_id, instance_name, is_saved)
SELECT character_id, 'ICC10', is_saved FROM char_raid_saves WHERE instance_name = 'ICC10 HC'
ON DUPLICATE KEY UPDATE is_saved = VALUES(is_saved);
DELETE FROM char_raid_saves WHERE instance_name = 'ICC10 HC';

-- ICC25 HC → ICC25
INSERT INTO char_raid_saves (character_id, instance_name, is_saved)
SELECT character_id, 'ICC25', is_saved FROM char_raid_saves WHERE instance_name = 'ICC25 HC'
ON DUPLICATE KEY UPDATE is_saved = VALUES(is_saved);
DELETE FROM char_raid_saves WHERE instance_name = 'ICC25 HC';

-- TOGC10 → TOC10
INSERT INTO char_raid_saves (character_id, instance_name, is_saved)
SELECT character_id, 'TOC10', is_saved FROM char_raid_saves WHERE instance_name = 'TOGC10'
ON DUPLICATE KEY UPDATE is_saved = VALUES(is_saved);
DELETE FROM char_raid_saves WHERE instance_name = 'TOGC10';

-- TOGC25 → TOC25
INSERT INTO char_raid_saves (character_id, instance_name, is_saved)
SELECT character_id, 'TOC25', is_saved FROM char_raid_saves WHERE instance_name = 'TOGC25'
ON DUPLICATE KEY UPDATE is_saved = VALUES(is_saved);
DELETE FROM char_raid_saves WHERE instance_name = 'TOGC25';

-- RS10 HC → RS10
INSERT INTO char_raid_saves (character_id, instance_name, is_saved)
SELECT character_id, 'RS10', is_saved FROM char_raid_saves WHERE instance_name = 'RS10 HC'
ON DUPLICATE KEY UPDATE is_saved = VALUES(is_saved);
DELETE FROM char_raid_saves WHERE instance_name = 'RS10 HC';

-- RS25 HC → RS25
INSERT INTO char_raid_saves (character_id, instance_name, is_saved)
SELECT character_id, 'RS25', is_saved FROM char_raid_saves WHERE instance_name = 'RS25 HC'
ON DUPLICATE KEY UPDATE is_saved = VALUES(is_saved);
DELETE FROM char_raid_saves WHERE instance_name = 'RS25 HC';
