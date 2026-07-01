ALTER TABLE characters ADD COLUMN membership_status VARCHAR(20) DEFAULT 'active' NOT NULL;
ALTER TABLE characters ADD COLUMN discord_role VARCHAR(100) DEFAULT NULL;
