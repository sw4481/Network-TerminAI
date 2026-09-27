---
title: BGP Peer Bringup
description: Bring up a new IBGP peer, verify session, verify prefix exchange.
vendor: cisco
platform: iosxe
parameters:
  - name: peer_ip
    prompt: Neighbor IP
    default: 10.0.0.2
  - name: peer_asn
    prompt: Neighbor ASN
    default: "65001"
---

# BGP Peer Bringup

## Step 1 — Pre-check

```command
show ip bgp summary
```

## Step 2 — Configure peer

```approval
Review config below, then click Continue to apply.
```

```command
configure terminal
router bgp 65001
 neighbor {{peer_ip}} remote-as {{peer_asn}}
 neighbor {{peer_ip}} activate
end
```

## Step 3 — Validate

```assertion
{"command": "show ip bgp summary", "jsonpath": "$.vrf.default.neighbor['{{peer_ip}}'].session_state", "op": "equals", "expected": "Established"}
```
