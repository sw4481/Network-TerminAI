---
title: BFD Single-Hop Enable
description: Enable BFD on an interface for fast failure detection.
vendor: cisco
platform: iosxe
parameters:
  - name: intf
    prompt: Interface
    default: GigabitEthernet0/0/0
  - name: peer_ip
    prompt: BFD peer IP
    default: 10.0.0.2
  - name: interval_ms
    prompt: BFD interval (ms)
    default: "300"
---

# BFD Single-Hop Enable

## Pre-check

```command
show bfd neighbors
```

## Configure

```approval
Enable BFD to {{peer_ip}} on {{intf}} (interval {{interval_ms}} ms × 3)?
```

```command
configure terminal
interface {{intf}}
 bfd interval {{interval_ms}} min_rx {{interval_ms}} multiplier 3
end
router bgp 65001
 neighbor {{peer_ip}} fall-over bfd
end
```

## Validate

```assertion
{"command": "show bfd neighbors", "jsonpath": "$..state", "op": "contains", "expected": "Up"}
```
