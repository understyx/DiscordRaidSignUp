-- Migration 028: store discord roles on signup
-- Instead of fetching roles live on every page load, capture and persist the
-- member's guild role names (JSON array, highest position first) at sign-up time.

ALTER TABLE signups
  ADD COLUMN discord_roles TEXT NULL;
