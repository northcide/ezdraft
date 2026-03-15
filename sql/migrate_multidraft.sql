-- Migration: Add multi-draft support
-- Run this on existing installs that are upgrading
-- Compatible with MySQL 8.0

-- 1. Add 'name' column to drafts if not present
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'drafts' AND COLUMN_NAME = 'name'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE drafts ADD COLUMN name VARCHAR(255) NOT NULL DEFAULT ''Draft'' AFTER id',
  'SELECT ''drafts.name already exists'' AS info'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 2. Add 'started_at' column to drafts if not present
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'drafts' AND COLUMN_NAME = 'started_at'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE drafts ADD COLUMN started_at DATETIME DEFAULT NULL',
  'SELECT ''drafts.started_at already exists'' AS info'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 3. Add 'completed_at' column to drafts if not present
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'drafts' AND COLUMN_NAME = 'completed_at'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE drafts ADD COLUMN completed_at DATETIME DEFAULT NULL',
  'SELECT ''drafts.completed_at already exists'' AS info'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 4. Add 'draft_id' column to players if not present
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'players' AND COLUMN_NAME = 'draft_id'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE players ADD COLUMN draft_id INT NOT NULL DEFAULT 0 AFTER id',
  'SELECT ''players.draft_id already exists'' AS info'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 5. Add 'draft_id' column to teams if not present
SET @col_exists = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'teams' AND COLUMN_NAME = 'draft_id'
);
SET @sql = IF(@col_exists = 0,
  'ALTER TABLE teams ADD COLUMN draft_id INT NOT NULL DEFAULT 0 AFTER id',
  'SELECT ''teams.draft_id already exists'' AS info'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 6. Associate existing players/teams with the first draft (if any)
UPDATE players SET draft_id = (SELECT MIN(id) FROM drafts) WHERE draft_id = 0 AND (SELECT COUNT(*) FROM drafts) > 0;
UPDATE teams   SET draft_id = (SELECT MIN(id) FROM drafts) WHERE draft_id = 0 AND (SELECT COUNT(*) FROM drafts) > 0;

-- 7. Add composite index on players(draft_id, rank) if not present
SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'players' AND INDEX_NAME = 'idx_draft_rank'
);
SET @sql = IF(@idx_exists = 0,
  'ALTER TABLE players ADD INDEX idx_draft_rank (draft_id, `rank`)',
  'SELECT ''idx_draft_rank already exists'' AS info'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 8. Add composite index on teams(draft_id, draft_order) if not present
SET @idx_exists = (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'teams' AND INDEX_NAME = 'idx_draft_order'
);
SET @sql = IF(@idx_exists = 0,
  'ALTER TABLE teams ADD INDEX idx_draft_order (draft_id, draft_order)',
  'SELECT ''idx_draft_order already exists'' AS info'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 9. Add FK on players.draft_id if not present
SET @fk_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'players' AND CONSTRAINT_NAME = 'fk_players_draft'
);
SET @sql = IF(@fk_exists = 0,
  'ALTER TABLE players ADD CONSTRAINT fk_players_draft FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE',
  'SELECT ''fk_players_draft already exists'' AS info'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- 10. Add FK on teams.draft_id if not present
SET @fk_exists = (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'teams' AND CONSTRAINT_NAME = 'fk_teams_draft'
);
SET @sql = IF(@fk_exists = 0,
  'ALTER TABLE teams ADD CONSTRAINT fk_teams_draft FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE',
  'SELECT ''fk_teams_draft already exists'' AS info'
);
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
