CREATE TABLE raid_segments (
    id INT AUTO_INCREMENT PRIMARY KEY,
    raid_id INT NOT NULL,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    starts_at DATETIME,
    ends_at DATETIME,
    sort_order INT NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_raid_segments_raid_id FOREIGN KEY (raid_id) REFERENCES raids(id) ON DELETE CASCADE
);

CREATE INDEX idx_raid_segments_raid_id ON raid_segments(raid_id);

-- Provide a default segment for existing raids
INSERT INTO raid_segments (raid_id, name, sort_order)
SELECT id, IFNULL(name, 'Main Raid'), 0 FROM raids;

CREATE TABLE raid_segment_participations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    signup_id INT NOT NULL,
    raid_segment_id INT NOT NULL,
    attendance ENUM('attending', 'maybe', 'not_attending') NOT NULL,
    note TEXT,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_rsp_signup_id FOREIGN KEY (signup_id) REFERENCES signups(id) ON DELETE CASCADE,
    CONSTRAINT fk_rsp_segment_id FOREIGN KEY (raid_segment_id) REFERENCES raid_segments(id) ON DELETE CASCADE,
    UNIQUE KEY uq_signup_raid_segment (signup_id, raid_segment_id)
);

CREATE INDEX idx_rsp_signup_id ON raid_segment_participations(signup_id);
CREATE INDEX idx_rsp_segment_id ON raid_segment_participations(raid_segment_id);

CREATE TABLE raid_segment_participation_characters (
    participation_id INT NOT NULL,
    character_id INT NOT NULL,
    is_preferred BOOLEAN NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (participation_id, character_id),
    CONSTRAINT fk_rspc_participation_id FOREIGN KEY (participation_id) REFERENCES raid_segment_participations(id) ON DELETE CASCADE,
    CONSTRAINT fk_rspc_character_id FOREIGN KEY (character_id) REFERENCES characters(id) ON DELETE CASCADE
);

ALTER TABLE compositions ADD COLUMN raid_segment_id INT NULL;
ALTER TABLE compositions ADD CONSTRAINT fk_comp_raid_segment_id FOREIGN KEY (raid_segment_id) REFERENCES raid_segments(id) ON DELETE CASCADE;

-- Deduplicate signups and migrate data
-- This assumes that for a given raid and user, all entries in signups essentially represent the user's characters.
-- We can't easily merge them directly in SQL into one row while preserving auto-increment IDs for the children gracefully if there are multiple.
-- Actually, we can pick the MIN(id) as the canonical signup.

CREATE TEMPORARY TABLE canonical_signups AS
SELECT
    raid_id,
    discord_user_id,
    MIN(id) as canonical_id
FROM signups
GROUP BY raid_id, discord_user_id;

ALTER TABLE signups ADD COLUMN segment_application_mode ENUM('apply_all', 'customized') NOT NULL DEFAULT 'apply_all';

INSERT INTO raid_segment_participations (signup_id, raid_segment_id, attendance, note)
SELECT
    cs.canonical_id,
    rs.id,
    IF(MAX(s.status) = 'tentative', 'maybe', 'attending'),
    MAX(s.note)
FROM canonical_signups cs
JOIN signups s ON s.raid_id = cs.raid_id AND s.discord_user_id = cs.discord_user_id
JOIN raid_segments rs ON rs.raid_id = cs.raid_id
GROUP BY cs.canonical_id, rs.id;

INSERT INTO raid_segment_participation_characters (participation_id, character_id, is_preferred)
SELECT
    rsp.id,
    s.character_id,
    IF(s.signup_type = 'prio_character', 1, 0)
FROM signups s
JOIN canonical_signups cs ON s.raid_id = cs.raid_id AND s.discord_user_id = cs.discord_user_id
JOIN raid_segment_participations rsp ON rsp.signup_id = cs.canonical_id;

-- Delete non-canonical signups
DELETE signups FROM signups
LEFT JOIN canonical_signups cs ON signups.id = cs.canonical_id
WHERE cs.canonical_id IS NULL;

-- Remove old columns from signups safely.
ALTER TABLE signups DROP FOREIGN KEY signups_ibfk_2; -- Assuming foreign key name. Needs checking.
