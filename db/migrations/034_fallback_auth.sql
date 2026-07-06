ALTER TABLE discord_users ADD COLUMN fallback_username VARCHAR(100) UNIQUE DEFAULT NULL;
ALTER TABLE discord_users ADD COLUMN fallback_password_hash VARCHAR(255) DEFAULT NULL;
