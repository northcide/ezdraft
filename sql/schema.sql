CREATE DATABASE IF NOT EXISTS easydraft CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE easydraft;

CREATE TABLE IF NOT EXISTS settings (
  `key`       VARCHAR(100) NOT NULL PRIMARY KEY,
  value       TEXT,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS drafts (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  name                    VARCHAR(255) NOT NULL DEFAULT 'Draft',
  status                  ENUM('setup','active','paused','completed') NOT NULL DEFAULT 'setup',
  total_rounds            INT NOT NULL DEFAULT 10,
  timer_minutes           INT NOT NULL DEFAULT 2,
  auto_pick_enabled       TINYINT(1) NOT NULL DEFAULT 1,
  current_pick_num        INT NOT NULL DEFAULT 1,
  timer_end               DATETIME DEFAULT NULL,
  timer_remaining_seconds INT DEFAULT NULL,
  started_at              DATETIME DEFAULT NULL,
  completed_at            DATETIME DEFAULT NULL,
  archived                TINYINT(1) NOT NULL DEFAULT 0,
  coach_name              VARCHAR(255) DEFAULT NULL,
  coach_pin               VARCHAR(255) DEFAULT NULL,
  coach_mode              ENUM('shared','team') NOT NULL DEFAULT 'shared',
  created_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at              TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS players (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  draft_id        INT NOT NULL,
  name            VARCHAR(255) NOT NULL,
  `rank`          INT NOT NULL,
  position        VARCHAR(50) DEFAULT NULL,
  is_coaches_kid  TINYINT(1) NOT NULL DEFAULT 0,
  age             INT DEFAULT NULL,
  is_pitcher      TINYINT(1) NOT NULL DEFAULT 0,
  is_catcher      TINYINT(1) NOT NULL DEFAULT 0,
  notes           TEXT DEFAULT NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_draft_rank (draft_id, `rank`),
  FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS teams (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  draft_id     INT NOT NULL,
  name         VARCHAR(255) NOT NULL,
  draft_order  INT NOT NULL,
  pin          VARCHAR(255) NULL,
  created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_draft_order (draft_id, draft_order),
  FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS picks (
  id               INT AUTO_INCREMENT PRIMARY KEY,
  draft_id         INT NOT NULL,
  round            INT NOT NULL,
  pick_num         INT NOT NULL,
  team_id          INT NOT NULL,
  player_id        INT DEFAULT NULL,
  is_pre_assigned  TINYINT(1) NOT NULL DEFAULT 0,
  is_auto_pick     TINYINT(1) NOT NULL DEFAULT 0,
  skipped          TINYINT(1) NOT NULL DEFAULT 0,
  picked_at        DATETIME DEFAULT NULL,
  created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_draft_pick (draft_id, pick_num),
  UNIQUE KEY unique_draft_player (draft_id, player_id),
  INDEX idx_draft_id (draft_id),
  INDEX idx_player_id (player_id),
  FOREIGN KEY (draft_id)  REFERENCES drafts(id)  ON DELETE CASCADE,
  FOREIGN KEY (team_id)   REFERENCES teams(id)   ON DELETE CASCADE,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE SET NULL
);

INSERT IGNORE INTO settings (`key`, value) VALUES
  ('league_name', 'My League'),
  ('admin_pin',   'admin1234');

-- Link-based sign-in tokens (added 2026-03-17)
-- ALTER TABLE drafts
--   ADD COLUMN coach_login_token      CHAR(64) DEFAULT NULL,
--   ADD COLUMN coach_token_expires_at DATETIME DEFAULT NULL,
--   ADD INDEX  idx_coach_token (coach_login_token);
--
-- ALTER TABLE teams
--   ADD COLUMN login_token      CHAR(64) DEFAULT NULL,
--   ADD COLUMN token_expires_at DATETIME DEFAULT NULL,
--   ADD INDEX  idx_team_token (login_token);
