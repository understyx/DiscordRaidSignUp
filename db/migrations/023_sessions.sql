CREATE TABLE IF NOT EXISTS sessions (
  session_id VARCHAR(128) NOT NULL,
  expires INT(11) UNSIGNED NOT NULL,
  data MEDIUMTEXT,
  PRIMARY KEY (session_id)
);
