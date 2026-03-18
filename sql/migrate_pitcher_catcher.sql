-- Migration: add is_pitcher and is_catcher columns to players table
-- Safe to run on existing installs (DEFAULT 0 leaves all existing players unchanged)
ALTER TABLE players
  ADD COLUMN is_pitcher TINYINT(1) NOT NULL DEFAULT 0 AFTER age,
  ADD COLUMN is_catcher TINYINT(1) NOT NULL DEFAULT 0 AFTER is_pitcher;
