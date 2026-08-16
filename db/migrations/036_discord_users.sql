-- Discord identity cache previously created implicitly by SQLAlchemy.
CREATE TABLE IF NOT EXISTS discord_users (
  discord_user_id BIGINT NOT NULL,
  username VARCHAR(100) NOT NULL,
  display_name VARCHAR(100) NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (discord_user_id)
);
