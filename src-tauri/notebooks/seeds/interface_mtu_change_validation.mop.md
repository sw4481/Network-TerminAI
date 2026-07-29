---
title: Interface MTU Change Validation
description: Change MTU on an interface and confirm via show interfaces.
vendor: cisco
platform: iosxe
parameters:
  - name: intf
    prompt: Interface
    default: GigabitEthernet0/0/0
  - name: mtu
    prompt: New MTU
    default: "9216"
---

# Interface MTU Change

## Pre-check

```command
show interfaces {{intf}}
```

## Apply MTU

```approval
Confirm changing MTU on {{intf}} to {{mtu}} (this may bounce the link).
```

```command
configure terminal
interface {{intf}}
 mtu {{mtu}}
end
```

## Validate

```assertion
{"command": "show interfaces {{intf}}", "jsonpath": "$..mtu", "op": "contains", "expected": "{{mtu}}"}
```
