-- Migration 010: Add note column to signups table
ALTER TABLE signups ADD COLUMN note VARCHAR(500) NULL DEFAULT NULL;
