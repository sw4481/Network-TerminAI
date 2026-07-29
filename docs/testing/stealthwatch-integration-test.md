# Stealthwatch Integration Test Plan

## Prerequisites
- CCIE Terminal built and running
- Access to a Stealthwatch SMC instance (or mock server)
- Valid credentials

## Test 1: Settings UI Flow

1. Open CCIE Terminal
2. Open Settings (⌘,)
3. Click "Stealthwatch" tab
4. Verify form fields render correctly:
   - [ ] Host field
   - [ ] Username field
   - [ ] Password field
   - [ ] Verify SSL checkbox
   - [ ] Save button
   - [ ] Test Connection button

## Test 2: Test Connection

1. Fill in form:
   - Host: `smc.test.local` (or real SMC host)
   - Username: `admin`
   - Password: `<valid password>`
2. Click "Test Connection"
3. Verify status message appears:
   - [ ] "Testing connection…" shows immediately
   - [ ] Button disabled during test
   - [ ] Success: "Connected. Tenant ID: X"
   - [ ] OR Failure: "Authentication failed" or connection error

## Test 3: Save Configuration

1. Fill in form with valid credentials
2. Click "Save"
3. Verify:
   - [ ] "Configuration saved successfully" message
   - [ ] Close and reopen Settings
   - [ ] Stealthwatch tab loads saved values

## Test 4: MCP Server Registration

1. Save Stealthwatch config
2. Check database:
   ```sql
   SELECT * FROM mcp_servers WHERE id = 'stealthwatch-mcp';
   ```
3. Verify:
   - [ ] Row exists
   - [ ] `enabled = 1`
   - [ ] `transport = 'stdio'`
   - [ ] `env_json` contains credentials

## Test 5: Agent MCP Tool Call (Low Blast Radius)

1. Open terminal
2. Start agent session
3. Ask agent: "Use the stealthwatch_api_call tool to get hosts. Use GET method and path /sw-reporting/v1/tenants/123/hosts"
4. Verify:
   - [ ] Tool executes without approval modal (low blast radius = AutoAllow)
   - [ ] Agent receives response

## Test 6: Agent MCP Tool Call (Medium Blast Radius)

1. In agent session
2. Ask agent: "Create a flow query using POST to /sw-reporting/v1/tenants/123/flows/queries with body {startTime: '2024-06-01T00:00:00Z', endTime: '2024-06-17T00:00:00Z'}"
3. Verify:
   - [ ] Approval modal appears (medium blast radius = Confirm)
   - [ ] Modal shows method, path, body
   - [ ] Clicking "Approve" executes tool
   - [ ] Clicking "Deny" cancels

## Test 7: Agent MCP Tool Call (High Blast Radius)

1. In agent session
2. Ask agent: "Create a tag using POST to /smc-configuration/rest/v1/tenants/123/tags with body {name: 'Test', ranges: ['10.0.0.0/24']}"
3. Verify:
   - [ ] Approval modal appears (high blast radius = ConfirmOnce)
   - [ ] After approving once, subsequent high-tier calls don't prompt again

## Test 8: Error Scenarios

1. Invalid credentials:
   - [ ] Test connection shows "Authentication failed"
2. Unreachable host:
   - [ ] Test connection shows "Connection failed: ..."
3. SSL verification with self-signed cert:
   - [ ] With verifySsl=true: shows SSL error
   - [ ] With verifySsl=false: connects successfully

## Success Criteria

All checkboxes above must pass for the integration to be considered complete.

## Test Results

**Status:** Documentation created (manual E2E verification to be performed by operator)

**Date:** 2026-06-17

**Test Coverage:** 8 integration test scenarios covering:
- Settings UI rendering (Test 1)
- Connection validation (Test 2)
- Configuration persistence (Test 3)
- MCP server lifecycle (Test 4)
- Low/medium/high blast radius approval flows (Tests 5-7)
- Error handling (Test 8)

**Next Steps:**
1. Execute each test scenario against live Stealthwatch SMC or mock server
2. Document pass/fail status for each checkbox
3. Record any observed deviations from expected behavior
4. File issues for any failing tests before marking integration complete
