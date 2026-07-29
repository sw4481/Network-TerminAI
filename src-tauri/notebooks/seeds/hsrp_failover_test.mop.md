---
title: HSRP Failover Test
description: Force HSRP failover by adjusting priority, then revert.
vendor: cisco
platform: iosxe
parameters:
  - name: intf
    prompt: Interface
    default: Vlan10
  - name: group
    prompt: HSRP group
    default: "10"
---

# HSRP Failover Test

## Capture baseline

```command
show standby brief
```

## Force failover

```approval
This will adjust HSRP priority and trigger a failover. Confirm to proceed.
```

```command
configure terminal
interface {{intf}}
 standby {{group}} priority 50
end
```

## Validate failover

```assertion
{"command": "show standby brief", "jsonpath": "$..state", "op": "contains", "expected": "Standby"}
```

## Revert

```approval
Click Continue to restore HSRP priority.
```

```command
configure terminal
interface {{intf}}
 standby {{group}} priority 110
end
```
