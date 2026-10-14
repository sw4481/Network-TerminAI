# Offline MAC registry

`mac-registry.json` is an immutable, compiled-in snapshot of the public IEEE Registration Authority CSV datasets, retrieved on 2026-10-14. The JSON `snapshot_at` is the retrieval/build timestamp in UTC RFC3339, not the date an assignment was made.

| Registry | Source | Published rows |
| --- | --- | ---: |
| MA-L (24 bits) | https://standards-oui.ieee.org/oui/oui.csv | 40,336 |
| MA-M (28 bits) | https://standards-oui.ieee.org/oui28/mam.csv | 6,635 |
| MA-S (36 bits) | https://standards-oui.ieee.org/oui36/oui36.csv | 7,233 |
| Legacy IAB (36 bits) | https://standards-oui.ieee.org/iab/iab.csv | 4,575 |
| CID (24-bit company identifier) | https://standards-oui.ieee.org/cid/cid.csv | 221 |

The 59,000 published rows produce 58,997 distinct registry/prefix entries. IEEE lists multiple organizations for the historical MA-L prefixes `080030` and `0001C8`; the snapshot preserves all names, separated by ` | `, and labels each corresponding postal address. Exact duplicate rows are collapsed. No organization is arbitrarily preferred.

## Rebuild

Download each official CSV into its own new directory under a separate download root, retaining the names `MA-L/oui.csv`, `MA-M/mam.csv`, `MA-S/oui36.csv`, `IAB/iab.csv`, and `CID/cid.csv`. Use a descriptive User-Agent such as `TerminAI/1.1.10 MAC Registry Updater`.

From the repository root, not the download directory:

```sh
python3 -I scripts/build_mac_registry_seed.py /path/to/download-root resources/mac-registry.json
python3 -m unittest scripts.tests.test_mac_lookup_resources -v
```

## Runtime updates

Operate → Tools → MAC Address Lookup → **Update Registry** fetches these five fixed HTTPS sources, validates the complete dataset, and atomically replaces `mac-registry/snapshot.json` in Tauri's application-local data directory. It never modifies this compiled seed or a signed application resource. A validated updated snapshot is preferred after restart; an absent/invalid cache falls back to the bundled snapshot. Failed updates retain the previous dataset. Lookups are local and never transmit the entered MAC address.

A registration identifies the organization assigned an address block, not necessarily a device's manufacturer, model, location, or authenticity. Local/randomized, multicast, broadcast, and all-zero addresses are classified separately rather than misleadingly assigned an ordinary hardware vendor. CID matches identify a registered local assignee, not a manufacturer.
