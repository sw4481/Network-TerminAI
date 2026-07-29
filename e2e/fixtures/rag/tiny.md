# Tiny RAG Fixture

This is a 1KB-ish markdown fixture used by the `@smoke rag-upload`
Playwright test.

## Section A — BGP

When configuring BGP on Cisco IOS-XE you can use the `router bgp <ASN>`
command. Neighbors are added with `neighbor <ip> remote-as <asn>`.
Address families live under `address-family ipv4` blocks.

## Section B — OSPF

OSPF process IDs are locally significant. Areas are identified by the
`area <id>` keyword. Use `passive-interface default` to silence
non-backbone interfaces.

## Section C — Filler

Filler text to push this fixture above 1KB so the chunker has at least
one chunk to work with. Lorem ipsum dolor sit amet, consectetur
adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore
magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation
ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute
irure dolor in reprehenderit in voluptate velit esse cillum dolore
eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non
proident, sunt in culpa qui officia deserunt mollit anim id est
laborum.
