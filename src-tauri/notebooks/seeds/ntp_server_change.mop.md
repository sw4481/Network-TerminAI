---
title: NTP Server Change
description: Replace an NTP server and verify sync state.
vendor: cisco
platform: iosxe
parameters:
  - name: old_server
    prompt: Existing NTP server
    default: 10.0.0.99
  - name: new_server
    prompt: New NTP server
    default: 10.0.0.10
---

# NTP Server Change

## Capture baseline

```command
show ntp associations
```

## Apply

```approval
Replace NTP server {{old_server}} with {{new_server}}?
```

```command
configure terminal
no ntp server {{old_server}}
ntp server {{new_server}}
end
```

## Validate sync

```assertion
{"command": "show ntp associations", "jsonpath": "$..address", "op": "contains", "expected": "{{new_server}}"}
```
