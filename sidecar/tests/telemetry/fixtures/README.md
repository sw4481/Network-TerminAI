# Public offline telemetry format fixtures

All `.raw` files here are sanitized NTC public samples at immutable commit `e60dae39a28d148253e751176bd3ff15e35bfd56`, under Apache-2.0. Copyright 2015 Jason Edelman / Network to Code, LLC; attribution, original upstream notice and full license are in `src-tauri/telemetry/NOTICE.md` and `NTC-LICENSE`.

`manifest.json` pins each original URL/hash and sanitized hash, selected excerpt scope and expected parser rows. Acquisition is completed before tests; tests need no network. Deterministic per-fixture pseudonyms preserve distinct/equal IP/MAC/serial/discovery-name identities. Interface/VRF/vendor/model text remains public source format evidence. No saved target, user data or private capture was read.

The complete interface sample repeats contradictory `GigabitEthernet0/2` blocks. The inventory sample repeats identical name/serial records. Both remain intact and fail unique-row normalization; they are not deduplicated. `interfaces_one.raw` is only the first complete interface block, ending before the next header. BGP VRF detail retains its installed parser's empty-identity phantom row, which fails visibly.

No fixture establishes authorized lab/release/channel support, supported-empty output, unconfigured protocols, counter width/reset behavior or live calibration. `supported_empty` is deliberately empty. The existing wrapped IPv6 BGP fixture outside this directory has unverified local provenance and remains a demonstrated parser miss.
