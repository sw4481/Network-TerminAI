#!/bin/bash
# Verify IaC Phase 1 features are working

DB_PATH="$HOME/Library/Application Support/ccie-terminal/ccie.db"

echo "================================================"
echo "IaC Phase 1 Feature Verification"
echo "================================================"
echo ""

# 1. Check database schema
echo "1. Checking database schema..."
if sqlite3 "$DB_PATH" "SELECT name FROM sqlite_master WHERE type='table' AND name='iac_executions'" | grep -q iac_executions; then
    echo "✅ iac_executions table exists"
else
    echo "❌ iac_executions table NOT found"
    exit 1
fi

# 2. Check for IaC executions
echo ""
echo "2. Checking for IaC executions..."
IAC_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM iac_executions")
echo "   Found: $IAC_COUNT executions"

if [ "$IAC_COUNT" -gt 0 ]; then
    echo ""
    echo "   Latest 5 executions:"
    sqlite3 "$DB_PATH" "
      SELECT 
        substr(id, 1, 8) as id,
        tool,
        subcommand,
        resources_changed as changed,
        resources_failed as failed,
        datetime(created_at, 'unixepoch', 'localtime') as time
      FROM iac_executions 
      ORDER BY created_at DESC 
      LIMIT 5
    " -header -column
fi

# 3. Check command blocks linked to IaC
echo ""
echo "3. Checking command blocks with IaC links..."
LINKED_COUNT=$(sqlite3 "$DB_PATH" "
  SELECT COUNT(DISTINCT cb.id)
  FROM command_blocks cb
  JOIN iac_executions ie ON ie.command_block_id = cb.id
")
echo "   Linked blocks: $LINKED_COUNT"

# 4. Sample parsed metadata
if [ "$IAC_COUNT" -gt 0 ]; then
    echo ""
    echo "4. Sample parsed metadata (latest execution):"
    sqlite3 "$DB_PATH" "
      SELECT metadata_json 
      FROM iac_executions 
      ORDER BY created_at DESC 
      LIMIT 1
    " | jq '{
      summary: .summary,
      resources_changed: .resourcesChanged,
      resources_failed: .resourcesFailed,
      event_count: (.resourceEvents | length),
      sample_event: .resourceEvents[0]
    }' 2>/dev/null || echo "   (Install jq to see formatted output)"
fi

# 5. Check frontend files
echo ""
echo "5. Checking frontend files..."
REPO_ROOT="$HOME/Network-TerminAI"

if [ -f "$REPO_ROOT/src/types/iac.ts" ]; then
    echo "✅ src/types/iac.ts exists"
else
    echo "❌ src/types/iac.ts NOT found"
fi

if [ -f "$REPO_ROOT/src/components/IaCCommandBlock.tsx" ]; then
    echo "✅ src/components/IaCCommandBlock.tsx exists"
else
    echo "❌ IaCCommandBlock.tsx NOT found"
fi

if grep -q "iacExecutionId" "$REPO_ROOT/src/state/blocksStore.ts" 2>/dev/null; then
    echo "✅ blocksStore.ts has IaC integration"
else
    echo "❌ blocksStore.ts missing IaC integration"
fi

# 6. Check backend files
echo ""
echo "6. Checking backend files..."
if [ -f "$REPO_ROOT/src-tauri/src/iac/detector.rs" ]; then
    echo "✅ iac/detector.rs exists"
else
    echo "❌ iac/detector.rs NOT found"
fi

if [ -f "$REPO_ROOT/src-tauri/src/iac/parser.rs" ]; then
    echo "✅ iac/parser.rs exists"
else
    echo "❌ iac/parser.rs NOT found"
fi

if grep -q "iac_process_block" "$REPO_ROOT/src-tauri/src/commands/mod.rs" 2>/dev/null; then
    echo "✅ iac_process_block command registered"
else
    echo "❌ iac_process_block command NOT found"
fi

echo ""
echo "================================================"
echo "Verification Complete"
echo "================================================"
