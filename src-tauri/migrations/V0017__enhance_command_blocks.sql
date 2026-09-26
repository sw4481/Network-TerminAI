-- Add new columns to command_blocks table
ALTER TABLE command_blocks ADD COLUMN cwd TEXT NOT NULL DEFAULT '/';
ALTER TABLE command_blocks ADD COLUMN output_line_count INTEGER DEFAULT 0;
ALTER TABLE command_blocks ADD COLUMN is_bookmarked BOOLEAN DEFAULT 0;
ALTER TABLE command_blocks ADD COLUMN ai_analysis TEXT;
ALTER TABLE command_blocks ADD COLUMN duration_ms INTEGER;

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_blocks_bookmark ON command_blocks(is_bookmarked) WHERE is_bookmarked = 1;
CREATE INDEX IF NOT EXISTS idx_blocks_timestamp ON command_blocks(started_at DESC);

-- Update existing rows with default values for new columns
UPDATE command_blocks SET cwd = '/' WHERE cwd IS NULL;
UPDATE command_blocks SET output_line_count = 0 WHERE output_line_count IS NULL;
UPDATE command_blocks SET is_bookmarked = 0 WHERE is_bookmarked IS NULL;
