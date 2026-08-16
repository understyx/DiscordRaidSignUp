-- Initial application schema. Later migrations evolve these tables.
CREATE TABLE IF NOT EXISTS raids (
  id INT NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  date DATETIME NOT NULL,
  description TEXT NULL,
  raid_instance VARCHAR(100) NOT NULL,
  max_size INT NULL DEFAULT 25,
  status ENUM('open', 'locked', 'posted') NULL DEFAULT 'open',
  created_by BIGINT NOT NULL,
  discord_message_id BIGINT NULL,
  discord_channel_id BIGINT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS characters (
  id INT NOT NULL AUTO_INCREMENT,
  discord_user_id BIGINT NOT NULL,
  char_name VARCHAR(50) NOT NULL,
  realm VARCHAR(50) NULL DEFAULT 'Icecrown',
  role ENUM('tank', 'healer', 'dps') NULL,
  char_class VARCHAR(50) NULL,
  spec VARCHAR(100) NULL,
  gearscore FLOAT NULL DEFAULT 0,
  last_updated DATETIME NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS signups (
  id INT NOT NULL AUTO_INCREMENT,
  raid_id INT NOT NULL,
  discord_user_id BIGINT NOT NULL,
  character_id INT NOT NULL,
  signup_type ENUM('fill', 'prio_role', 'prio_character') NULL DEFAULT 'fill',
  status ENUM('signed', 'tentative', 'declined') NULL DEFAULT 'signed',
  created_at DATETIME NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_signups_raid FOREIGN KEY (raid_id) REFERENCES raids(id),
  CONSTRAINT fk_signups_character FOREIGN KEY (character_id) REFERENCES characters(id)
);

CREATE TABLE IF NOT EXISTS compositions (
  id INT NOT NULL AUTO_INCREMENT,
  raid_id INT NOT NULL,
  character_id INT NOT NULL,
  role_slot VARCHAR(50) NOT NULL,
  created_by BIGINT NOT NULL,
  created_at DATETIME NULL,
  PRIMARY KEY (id),
  CONSTRAINT fk_compositions_raid FOREIGN KEY (raid_id) REFERENCES raids(id),
  CONSTRAINT fk_compositions_character FOREIGN KEY (character_id) REFERENCES characters(id)
);
