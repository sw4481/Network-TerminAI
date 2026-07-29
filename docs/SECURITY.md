# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |
| < 1.0   | :x:                |

## Security Overview

CCIE Terminal is designed with security as a foundational principle. This document outlines our security measures, how to report vulnerabilities, and best practices for users.

## Security Measures

### 1. Input Validation

All user input is validated and sanitized before processing:

- **Tab IDs**: Validated to prevent path traversal and injection attacks
- **Commands**: Checked for null bytes and length limits
- **Session Names**: Restricted to alphanumeric characters, hyphens, underscores, and spaces
- **Search Queries**: Escaped for FTS5 to prevent SQL injection
- **File Paths**: Validated and canonicalized to prevent path traversal

Maximum input lengths are enforced:
- Tab IDs: 64 characters
- Session Names: 128 characters
- Commands: 8,192 characters
- Search Queries: 1,024 characters
- File Paths: 4,096 characters

### 2. SQL Injection Prevention

- All database queries use **prepared statements** with parameterized queries
- No raw SQL is constructed from user input
- Search queries are escaped for FTS5 full-text search
- Additional validation layer detects suspicious SQL patterns

### 3. Command Injection Prevention

- Commands are executed through a PTY (pseudo-terminal) which provides proper shell escaping
- No commands are executed through `sh -c` or similar shells
- Command validation checks for null bytes and malicious patterns
- The application never evaluates or parses shell syntax itself

### 4. Path Traversal Prevention

- All file paths are canonicalized using `std::path::PathBuf::canonicalize()`
- Paths are validated against allowed directories
- Access to sensitive system files is blocked:
  - `/etc/passwd`, `/etc/shadow`, `/etc/sudoers`
  - `/etc/ssh/`, `/root/`, `/.ssh/`
- Symlink attacks are prevented through canonicalization

### 5. Content Security Policy (CSP)

The application enforces strict CSP headers to prevent XSS attacks:

```
default-src: 'self'
script-src: 'self' 'wasm-unsafe-eval'
style-src: 'self' 'unsafe-inline'
img-src: 'self' data: https:
font-src: 'self' data:
connect-src: 'self' http://localhost:* ws://localhost:* wss://localhost:*
worker-src: 'self'
frame-src: 'none'
object-src: 'none'
base-uri: 'self'
```

Note: `wasm-unsafe-eval` is required for Tauri's WASM runtime. `unsafe-inline` for styles is required for React's CSS-in-JS.

### 6. MCP Server Sandboxing

MCP (Model Context Protocol) servers run with restricted permissions:

- **Approval Policies**: Four levels of control
  - `AutoAllow`: Read-only operations (get, list, search)
  - `Confirm`: Prompt user each time (write, create, update)
  - `ConfirmOnce`: Prompt first time, remember decision (execute, delete)
  - `Deny`: Never allow
- **Default to Least Privilege**: Unknown tools require confirmation
- **Approval Memory**: User decisions are stored in SQLite
- **Timeout Protection**: Approval requests timeout after 30 seconds

### 7. Dependency Security

- Regular security audits using `cargo audit`
- Dependencies are reviewed before updates
- Minimal dependency tree to reduce attack surface
- No dependencies with known vulnerabilities

### 8. Data Protection

- **Local Storage**: All data is stored locally in SQLite
- **No Cloud Sync**: Application does not send data to external servers
- **Session Encryption**: Sensitive data can be encrypted at rest (future feature)
- **Secure Deletion**: Sessions can be permanently deleted

### 9. Network Security

- **Local Communication Only**: Application only communicates with localhost
- **No External Connections**: Except for user-initiated MCP servers
- **TLS for Updates**: Software updates use HTTPS with signature verification
- **WebSocket Security**: Local WebSocket connections use secure tokens

## Reporting a Vulnerability

We take security vulnerabilities seriously. If you discover a security issue, please report it responsibly:

### How to Report

1. **DO NOT** open a public GitHub issue
2. Email: `security@ccie-terminal.dev` (not yet active - use GitHub private vulnerability reporting)
3. Use GitHub's [Private Vulnerability Reporting](https://github.com/sw4481/ccie-terminal/security/advisories/new)

### What to Include

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)
- Your contact information

### Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial Assessment**: Within 5 business days
- **Fix Development**: Depends on severity (critical: 7 days, high: 14 days, medium: 30 days)
- **Disclosure**: Coordinated with reporter

### Severity Levels

- **Critical**: Remote code execution, privilege escalation
- **High**: SQL injection, command injection, authentication bypass
- **Medium**: XSS, CSRF, information disclosure
- **Low**: Minor information leaks, denial of service

## Security Best Practices for Users

### 1. Keep Software Updated

- Enable automatic updates in settings
- Check for updates regularly: `Help > Check for Updates`
- Review release notes for security fixes

### 2. MCP Server Configuration

- **Only install trusted MCP servers** from known sources
- Review server permissions before enabling
- Use `ConfirmOnce` or `Confirm` policies for destructive operations
- Audit your approved tools regularly: `Settings > MCP Servers > Policies`

### 3. Session Management

- Use strong session names (avoid predictable patterns)
- Delete old sessions you no longer need
- Export sessions to secure backup locations
- Review session contents before sharing

### 4. Command Execution

- Review AI-generated commands before executing
- Don't execute commands from untrusted sources
- Use command blocks to isolate dangerous operations
- Enable shell integration for better command tracking

### 5. File System Access

- Be cautious when granting file system permissions to MCP servers
- Review file paths before confirming destructive operations
- Keep sensitive files outside the terminal's working directory
- Use separate user accounts for high-risk operations

### 6. Network Operations

- Only connect to trusted networks
- Use VPNs when accessing remote systems
- Be cautious of MCP servers that require network access
- Monitor network activity if available

### 7. Credentials and Secrets

- **Never store credentials in command history**
- Use environment variables for sensitive values
- Consider using a secrets manager
- Clear scrollback when finished with sensitive operations: `Edit > Clear Scrollback`

### 8. AI Interactions

- Don't share sensitive information with AI assistants
- Review AI responses before executing suggested commands
- Remember that AI conversations are stored locally
- Clear AI history if needed: `Settings > Privacy > Clear AI History`

## Security Architecture

### Threat Model

CCIE Terminal is designed to protect against:

1. **Malicious Input**: User or AI-provided commands that attempt injection attacks
2. **Rogue MCP Servers**: Third-party servers that attempt unauthorized actions
3. **Path Traversal**: Attempts to access files outside allowed directories
4. **XSS Attacks**: Malicious content in terminal output or AI responses
5. **Dependency Vulnerabilities**: Security issues in third-party libraries

### Trust Boundaries

```
┌─────────────────────────────────────────────┐
│              User / Frontend                │ (Untrusted)
└──────────────────┬──────────────────────────┘
                   │ IPC (Tauri Commands)
                   │ + Input Validation
                   ▼
┌─────────────────────────────────────────────┐
│           Rust Backend (Tauri)              │ (Trusted)
│  - Input validation                         │
│  - SQL prepared statements                  │
│  - Path canonicalization                    │
│  - MCP approval policies                    │
└──────────────────┬──────────────────────────┘
                   │
      ┌────────────┼────────────┐
      │            │            │
      ▼            ▼            ▼
   ┌─────┐    ┌────────┐   ┌──────────┐
   │ PTY │    │ SQLite │   │ MCP      │ (Semi-Trusted)
   │     │    │   DB   │   │ Servers  │ (User approval required)
   └─────┘    └────────┘   └──────────┘
      │                         │
      ▼                         ▼
   ┌─────┐                 ┌──────────┐
   │Shell│                 │ External │ (Untrusted)
   │     │                 │ Services │
   └─────┘                 └──────────┘
```

### Defense in Depth

Multiple layers of security:

1. **Input Validation**: First line of defense
2. **Prepared Statements**: SQL injection prevention
3. **PTY Isolation**: Command execution sandboxing
4. **MCP Policies**: User approval for dangerous operations
5. **CSP Headers**: XSS prevention
6. **Path Validation**: File system access control
7. **Dependency Audits**: Supply chain security

## Compliance

CCIE Terminal follows industry best practices:

- **OWASP Top 10**: Protection against common web vulnerabilities
- **CWE Top 25**: Mitigation of common software weaknesses
- **NIST Cybersecurity Framework**: Security controls and risk management

## Security Roadmap

Planned security enhancements for future releases:

- [ ] Session encryption at rest (AES-256)
- [ ] SSH key management integration
- [ ] Certificate pinning for updates
- [ ] Audit logging for all operations
- [ ] Sandboxed Python sidecar (gVisor or similar)
- [ ] Hardware security key support (YubiKey)
- [ ] Integration with system keychain/credential manager
- [ ] Security dashboard with threat indicators
- [ ] Automated vulnerability scanning in CI/CD

## Contact

- Security Issues: `security@ccie-terminal.dev` (GitHub private reporting for now)
- General Questions: GitHub Discussions
- Documentation: https://docs.ccie-terminal.dev (future)

## Acknowledgments

We thank the security researchers and contributors who help keep CCIE Terminal secure:

- (List will be updated as vulnerabilities are reported and fixed)

---

**Last Updated**: 2026-04-23  
**Version**: 1.0.0
