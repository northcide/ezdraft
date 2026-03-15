CREATE DATABASE IF NOT EXISTS easydraft CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE easydraft;

CREATE TABLE IF NOT EXISTS players (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  `rank` INT NOT NULL,
  position VARCHAR(50) DEFAULT NULL COMMENT 'Pitcher, Catcher, Infield, Outfield, etc.',
  is_coaches_kid TINYINT(1) NOT NULL DEFAULT 0,
  age INT DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_rank (`rank`),
  INDEX idx_position (position),
  INDEX idx_coaches_kid (is_coaches_kid)
);

CREATE TABLE IF NOT EXISTS teams (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  draft_order INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_draft_order (draft_order)
);

CREATE TABLE IF NOT EXISTS drafts (
  id INT AUTO_INCREMENT PRIMARY KEY,
  status ENUM('setup', 'active', 'paused', 'completed') NOT NULL DEFAULT 'setup',
  total_rounds INT NOT NULL DEFAULT 0,
  timer_minutes INT NOT NULL DEFAULT 2,
  auto_pick_enabled TINYINT(1) NOT NULL DEFAULT 1,
  current_pick_num INT NOT NULL DEFAULT 1,
  timer_end DATETIME DEFAULT NULL,
  timer_remaining_seconds INT DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS picks (
  id INT AUTO_INCREMENT PRIMARY KEY,
  draft_id INT NOT NULL,
  round INT NOT NULL,
  pick_num INT NOT NULL,
  team_id INT NOT NULL,
  player_id INT DEFAULT NULL,
  is_pre_assigned TINYINT(1) NOT NULL DEFAULT 0,
  is_auto_pick TINYINT(1) NOT NULL DEFAULT 0,
  picked_at DATETIME DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_draft_pick (draft_id, pick_num),
  INDEX idx_draft_id (draft_id),
  INDEX idx_team_id (team_id),
  INDEX idx_player_id (player_id),
  FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE,
  FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
  FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE SET NULL
);
