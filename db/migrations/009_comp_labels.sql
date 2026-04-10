-- Migration 009: Add comp_labels table for custom raid tab names
CREATE TABLE IF NOT EXISTS comp_labels (
  raid_id INT NOT NULL,
  comp_number INT NOT NULL,
  label VARCHAR(100) NOT NULL,
  PRIMARY KEY (raid_id, comp_number),
  CONSTRAINT fk_comp_labels_raid FOREIGN KEY (raid_id) REFERENCES raids(id) ON DELETE CASCADE
);
