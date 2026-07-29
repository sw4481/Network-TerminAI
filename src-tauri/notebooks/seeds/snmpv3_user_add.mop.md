---
title: SNMPv3 User Add
description: Add an SNMPv3 user with auth+priv and verify the user is configured.
vendor: cisco
platform: iosxe
parameters:
  - name: username
    prompt: SNMPv3 username
    default: monitor1
  - name: group
    prompt: SNMPv3 group
    default: NMS
  - name: auth_pass
    prompt: Auth password (≥8 chars)
    default: ChangeMe123
  - name: priv_pass
    prompt: Priv password (≥8 chars)
    default: ChangeMe123
---

# SNMPv3 User Add

## Pre-check

```command
show snmp user
```

## Configure

```approval
Add SNMPv3 user {{username}} in group {{group}}? Passwords will be set inline.
```

```command
configure terminal
snmp-server group {{group}} v3 priv
snmp-server user {{username}} {{group}} v3 auth sha {{auth_pass}} priv aes 256 {{priv_pass}}
end
```

## Validate

```assertion
{"command": "show snmp user", "jsonpath": "$..user_name", "op": "contains", "expected": "{{username}}"}
```
