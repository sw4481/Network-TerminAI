#!/bin/bash
# Cleanup script to close old tabs and optimize database

DB_PATH="$HOME/Library/Application Support/ccie-terminal/sessions.db"

if [ ! -f "$DB_PATH" ]; then
    echo "Database not found at: $DB_PATH"
    exit 1
fi

echo "🧹 Cleaning up CCIE Terminal database..."

# Close all open tabs
sqlite3 "$DB_PATH" "UPDATE tabs SET closed_at = strftime('%s','now') WHERE closed_at IS NULL;"

# Count tabs
TOTAL=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tabs;")
CLOSED=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM tabs WHERE closed_at IS NOT NULL;")

echo "✅ Closed all open tabs"
echo "📊 Total tabs in database: $TOTAL"
echo "📊 Closed tabs: $CLOSED"

# Optionally vacuum to reclaim space
echo "🗜️  Optimizing database..."
sqlite3 "$DB_PATH" "VACUUM;"

echo "✅ Database cleanup complete!"
echo ""
echo "You can now restart the app with: ./run.sh"
