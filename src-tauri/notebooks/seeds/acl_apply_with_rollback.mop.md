---
title: ACL Apply with Rollback
description: Apply an inbound ACL to an interface; verify, then keep or rollback.
vendor: cisco
platform: iosxe
parameters:
  - name: intf
    prompt: Interface
    default: GigabitEthernet0/0/0
  - name: acl_name
    prompt: ACL name
    default: PROD-EDGE-IN
---

# ACL Apply with Rollback

## Save current ACL

```command
show ip access-lists {{acl_name}}
```

## Apply

```approval
About to apply {{acl_name}} inbound on {{intf}}. Confirm?
```

```command
configure terminal
interface {{intf}}
 ip access-group {{acl_name}} in
end
```

## Validate

```assertion
{"command": "show ip interface {{intf}}", "jsonpath": "$..inbound_access_list", "op": "contains", "expected": "{{acl_name}}"}
```

## Rollback path (manual)

```approval
If validation FAILED, click Continue to remove the ACL. Otherwise click Cancel.
```

```command
configure terminal
interface {{intf}}
 no ip access-group {{acl_name}} in
end
```
