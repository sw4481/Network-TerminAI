---
title: OSPF Neighbor Add
description: Bring up an OSPFv2 neighbor on an interface and verify FULL state.
vendor: cisco
platform: iosxe
parameters:
  - name: intf
    prompt: Interface
    default: GigabitEthernet0/0/0
  - name: area
    prompt: OSPF area
    default: "0"
  - name: process_id
    prompt: OSPF process ID
    default: "1"
---

# OSPF Neighbor Add

## Pre-check

```command
show ip ospf neighbor
```

## Apply config

```approval
Confirm to enable OSPF on {{intf}} in area {{area}}.
```

```command
configure terminal
router ospf {{process_id}}
 network 0.0.0.0 255.255.255.255 area {{area}}
end
interface {{intf}}
 ip ospf {{process_id}} area {{area}}
end
```

## Validate FULL state

```assertion
{"command": "show ip ospf neighbor", "jsonpath": "$..state", "op": "contains", "expected": "FULL"}
```
