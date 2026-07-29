# Cisco Stealthwatch MCP Agent

The Stealthwatch MCP agent provides AI-powered access to Cisco Stealthwatch Enterprise (now Cisco Secure Network Analytics) for security event analysis, flow monitoring, and threat detection.

## Setup

1. **Configure Credentials**
   - Open Settings (⌘,)
   - Click the "Stealthwatch" tab
   - Enter your Stealthwatch Management Console (SMC) details:
     - Host: SMC hostname or IP (without https://)
     - Username: User with API access permissions
     - Password: User's password
     - Verify SSL: Check for production, uncheck for self-signed certs
   
2. **Test Connection**
   - Click "Test Connection" to verify credentials
   - Successful test shows: "Connected. Tenant ID: X"
   
3. **Save Configuration**
   - Click "Save" to persist credentials
   - MCP server is automatically enabled

## Usage

The agent has access to the `stealthwatch_api_call` tool which can call any Stealthwatch REST API endpoint.

### Example Queries

**Get security events:**
```
Show me critical security events from the last 24 hours in Stealthwatch
```

**Analyze network flows:**
```
Get the top 10 hosts by traffic volume in Stealthwatch for the last hour
```

**Create tags:**
```
Create a tag in Stealthwatch named "Critical Servers" for the 10.0.1.0/24 network
```

**Query host information:**
```
Get details about host 10.0.1.5 from Stealthwatch
```

## Approval Policies

Operations are classified by blast radius:

- **Low (auto-allowed)**: GET operations - read-only queries
- **Medium (confirm)**: POST/PUT for queries - requires approval each time
- **High (confirm once)**: Configuration changes (tags, policies) - requires approval first time
- **Destructive (confirm once)**: DELETE operations - requires approval first time

## API Endpoints

The tool provides access to all Stealthwatch Enterprise REST API endpoints:

- `/sw-reporting/v1/tenants/{tenantId}/security-events/*` - Security events
- `/sw-reporting/v1/tenants/{tenantId}/flows/*` - Flow data
- `/sw-reporting/v1/tenants/{tenantId}/hosts/*` - Host inventory
- `/smc-configuration/rest/v1/tenants/{tenantId}/tags/*` - Tag management
- `/smc-configuration/rest/v1/tenants/{tenantId}/custom-security-events/*` - Custom rules
- `/smc-configuration/rest/v1/tenants/{tenantId}/users/*` - User management

Full API documentation: https://developer.cisco.com/docs/stealthwatch/enterprise/

## Troubleshooting

**"Authentication failed"**
- Verify credentials in Settings
- Ensure user has API access permissions in Stealthwatch

**"SSL certificate verification failed"**
- For self-signed certificates, uncheck "Verify SSL" in Settings
- For production, install the SMC's CA certificate

**"Connection timed out"**
- Verify SMC is reachable from your network
- Check firewall rules allow HTTPS (443) to SMC

## Security

- Credentials are stored in SQLite (plaintext) for agent accessibility
- All API calls are authenticated with session tokens
- Session tokens are managed automatically by the MCP server
- Approval gates prevent unauthorized destructive operations
