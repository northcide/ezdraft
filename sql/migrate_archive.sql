-- Migration: add archived column to drafts table
-- Run this once on existing installs (safe to run; DEFAULT 0 leaves all drafts unarchived)
-- Note: ALTER TABLE ADD COLUMN IF NOT EXISTS requires MySQL 8.0+; on older versions run this
-- only if the column does not already exist.
ALTER TABLE drafts ADD COLUMN archived TINYINT(1) NOT NULL DEFAULT 0 AFTER completed_at;
