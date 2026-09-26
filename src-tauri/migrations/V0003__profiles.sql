-- Profiles table for storing model provider configurations
-- Profiles are also stored in config.toml, but this table tracks which profiles
-- have been used and provides a foreign key target for tabs.profile_id
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  last_used_at INTEGER
);

-- Create index for quick lookup by name
CREATE INDEX IF NOT EXISTS idx_profiles_name ON profiles(name);

-- The tabs.profile_id column already exists from V0002 migration
-- but we can now add a foreign key constraint in new rows
-- (SQLite doesn't support adding constraints to existing tables without recreation)
