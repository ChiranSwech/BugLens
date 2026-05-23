-- BugBuddy — Migration 001
-- Adds: network_logs column to bugs, HOVER to step_action_type enum

-- Add network_logs JSONB column to store failed requests attached at submission time
ALTER TABLE bugs ADD COLUMN IF NOT EXISTS network_logs JSONB;

-- Add HOVER to step_action_type enum (already in Zod schema but missing from DB)
ALTER TYPE step_action_type ADD VALUE IF NOT EXISTS 'HOVER';
