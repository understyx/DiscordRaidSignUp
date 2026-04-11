-- Migration 010: Add role_type to guild_admin_roles
-- Extends guild_admin_roles to support multiple role types:
--   'admin'  – existing type: can manage raids on the website
--   'signup' – new type: allowed to sign up for raids
-- Existing rows default to 'admin'.  If no rows of a given type exist for a
-- guild, the base-case (everyone allowed) applies for that type.

ALTER TABLE guild_admin_roles
  ADD COLUMN role_type VARCHAR(20) NOT NULL DEFAULT 'admin' AFTER role_id;

ALTER TABLE guild_admin_roles
  DROP PRIMARY KEY;

ALTER TABLE guild_admin_roles
  ADD PRIMARY KEY (guild_id, role_id, role_type);
