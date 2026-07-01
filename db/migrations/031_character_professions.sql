-- Migration 031: Add profession columns to characters table
ALTER TABLE characters ADD COLUMN prof_1 VARCHAR(50) NULL;
ALTER TABLE characters ADD COLUMN prof_2 VARCHAR(50) NULL;
