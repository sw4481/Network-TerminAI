# Cisco IOS-XE Quick Reference

This is a small markdown fixture used by the RAG extract tests. It needs
to be at least 100 characters of clean text after extraction.

## Show commands

- `show running-config` — display the active configuration.
- `show ip interface brief` — list interface state.
- `show ip bgp summary` — display BGP neighbor summary.

## Configuration

```
interface GigabitEthernet1
 ip address 10.0.0.1 255.255.255.0
 no shutdown
```
