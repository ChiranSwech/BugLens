-- BugBuddy — Migration 002
-- Adds missing bug report fields to the bugs table

ALTER TABLE bugs ADD COLUMN IF NOT EXISTS expected_result TEXT;
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS actual_result TEXT;
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS console_logs JSONB;
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS storage_snapshot JSONB;
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS bug_url TEXT;
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS test_data TEXT;
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS main_image_index SMALLINT;
