---
title: IS-IS Neighbor Add
description: Bring up an IS-IS L2 adjacency and verify Up state.
vendor: cisco
platform: iosxe
parameters:
  - name: intf
    prompt: Interface
    default: GigabitEthernet0/0/0
  - name: net
    prompt: NET (system ID)
    default: "49.0001.0000.0000.0001.00"
---

# IS-IS Neighbor Add

## Pre-check

```command
show isis neighbors
```

## Configure

```approval
Apply IS-IS configuration on {{intf}}?
```

```command
configure terminal
router isis CORE
 net {{net}}
 is-type level-2-only
 metric-style wide
end
interface {{intf}}
 ip router isis CORE
 isis circuit-type level-2-only
end
```

## Validate

```assertion
{"command": "show isis neighbors", "jsonpath": "$..state", "op": "contains", "expected": "Up"}
```
