---
title: VLAN Trunk Add
description: Add a new VLAN to a trunk port and verify allowed list.
vendor: cisco
platform: iosxe
parameters:
  - name: intf
    prompt: Trunk interface
    default: GigabitEthernet1/0/24
  - name: vlan_id
    prompt: VLAN ID
    default: "200"
  - name: vlan_name
    prompt: VLAN name
    default: VOICE
---

# VLAN Trunk Add

## Pre-check

```command
show interfaces trunk
```

## Configure

```approval
Add VLAN {{vlan_id}} ({{vlan_name}}) to {{intf}} allowed list?
```

```command
configure terminal
vlan {{vlan_id}}
 name {{vlan_name}}
exit
interface {{intf}}
 switchport trunk allowed vlan add {{vlan_id}}
end
```

## Validate

```assertion
{"command": "show interfaces trunk", "jsonpath": "$..vlans_allowed_on_trunk", "op": "contains", "expected": "{{vlan_id}}"}
```
