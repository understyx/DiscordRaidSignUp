-- Durable composition lifecycle, collaboration revisions, and publish tracking.
CREATE TABLE IF NOT EXISTS composition_meta (
  raid_id INT NOT NULL,
  comp_number INT NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  published_revision BIGINT UNSIGNED NULL,
  published_at DATETIME(3) NULL,
  discord_message_id BIGINT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (raid_id, comp_number),
  CONSTRAINT fk_composition_meta_raid FOREIGN KEY (raid_id) REFERENCES raids(id) ON DELETE CASCADE
);

INSERT IGNORE INTO composition_meta (raid_id, comp_number)
SELECT DISTINCT raid_id, comp_number FROM compositions;

INSERT IGNORE INTO composition_meta (raid_id, comp_number)
SELECT raid_id, comp_number FROM comp_labels;
