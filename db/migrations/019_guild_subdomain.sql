-- Migration 019: Guild subdomain support
-- Adds an optional unique subdomain slug to bot_guilds so each guild can be
-- reached at  <subdomain>.<BASE_DOMAIN>  (e.g. my-guild.example.com).

ALTER TABLE bot_guilds ADD COLUMN subdomain VARCHAR(100) NULL DEFAULT NULL UNIQUE;
