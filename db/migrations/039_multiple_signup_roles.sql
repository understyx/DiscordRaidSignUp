-- Migration 039: Multiple signup roles
-- Stores every Discord role that may satisfy a guild's role-based signup restriction.

CREATE TABLE IF NOT EXISTS guild_signup_roles (
    guild_id BIGINT NOT NULL,
    role_id  BIGINT NOT NULL,
    PRIMARY KEY (guild_id, role_id)
);

-- Preserve existing single-role settings when moving to the mapping table.
INSERT IGNORE INTO guild_signup_roles (guild_id, role_id)
SELECT guild_id, signup_role_id
FROM guild_settings
WHERE signup_role_id IS NOT NULL;
