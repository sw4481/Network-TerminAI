# Telemetry asset provenance

The `cisco_ios_*.textfsm` files are unchanged NTC Templates 9.1.0 files from immutable commit `e60dae39a28d148253e751176bd3ff15e35bfd56`. Copyright 2015 Jason Edelman / Network to Code, LLC. Apache-2.0; see NTC-LICENSE (upstream notice and license URL). catalog.json records exact source URLs and SHA256 for every binding. Installed files were byte-compared against immutable upstream bytes before acquisition.

`ios_interface_bytes.textfsm` and widget/layout definitions are independently authored for this application. The counter parser derives only interface/byte/BW line formats from the source-pinned public raw sample recorded in the offline fixture manifest; no upstream template text or GPL application asset was used to author it. Existing NTC parser discards those byte captures. BW is configured bandwidth, not proof of negotiated/physical capacity.

terminaltelemetry2 commit `09d2a0b3f9c77e2b85bd5b48a055b7bedb40fe98` docs/WIDGETS.md was consulted only for import semantics. Its GPL-3.0-or-later application/widget/template assets are not bundled. The adapter supports a strict declared subset and preserves rejected original YAML as an invalid editable draft.

Public sample fixtures are sanitized offline NTC format evidence, under Apache-2.0 with the above attribution. Source URLs, original hashes, sanitized hashes and transformations are in sidecar/tests/telemetry/fixtures/manifest.json. No fixture establishes authorized lab, release, channel, supported-empty, reset or operational acceptance.
