-- Migration 032: Add shard tracking columns
ALTER TABLE characters ADD COLUMN sfs_count INT NULL;
ALTER TABLE characters ADD COLUMN val_count INT NULL;

ALTER TABLE compositions ADD COLUMN is_sfs_collector BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE compositions ADD COLUMN is_val_collector BOOLEAN NOT NULL DEFAULT FALSE;
