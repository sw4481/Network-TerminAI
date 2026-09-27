# Session Chain YAML Schema

Plan 10 chain templates and `Import YAML` / `Export YAML` actions in
ChainEditor speak this format. Versioned as `apiVersion: ccie-terminal/v1`.

## Top-level

```yaml
apiVersion: ccie-terminal/v1
kind: SessionChain
metadata:
  name: <unique chain name>           # required, must be unique per app instance
  description: <free-text>            # optional
hops:
  - <hop>                              # 1+ hops; ordered laptop → device
links:                                 # optional
  - child: <other chain name>
```

## Hop

```yaml
- kind: ssh | netconf | telnet | console
  target:
    kind: ssh_connection | netconf_device | ad_hoc
    # Either by id (exact match against ssh_connections.id /
    # netconf_devices.id) OR by name (resolved at import time).
    id: <stringified-id>               # one of id or name required
    name: <name in the credential row> # if missing, import flags as REPLACE_ME
  postConnect:                         # optional; commands run after the hop is ready
    - terminal length 0
    - terminal width 0
  timeoutMs: 15000                     # optional, default 15000
```

### Notes

- `target.kind`:
  - `ssh_connection` — references the `ssh_connections` table. Plan 10
    encrypts and stores the password separately; chains never carry secrets.
  - `netconf_device` — references the `netconf_devices` table. `id` is the
    integer primary key, stringified.
  - `ad_hoc` — for one-off targets. Encode the target as a JSON object with
    `host`, `port`, and `user`, prefixed by `json:` — e.g.
    `target_ref: 'json:{"host":"10.0.0.5","port":22,"user":"admin"}'`.
- `postConnect` for SSH/Telnet hops are typed into the live PTY after the
  hop's prompt regex matches. Cisco baseline is `terminal length 0` and
  `terminal width 0`. NETCONF post-commands must be valid `<rpc>...</rpc>`
  XML.
- `links` are resolved by name; missing children are silently dropped on
  import (warning logged).

## Importing

`importChainFromYaml(text)` returns:

```ts
{
  chain: SessionChain,                 // ready to persist
  unresolvedTargets: { idx, name }[],  // hops with REPLACE_ME placeholders
  links: string[],                     // child chain names referenced
}
```

If `unresolvedTargets` is non-empty, the editor prompts you to map each name
to a real `ssh_connection` / `netconf_device` before validation passes.

## Exporting

`exportChainToYaml(chain)` writes a deterministic YAML document using
`js-yaml` `JSON_SCHEMA`. Round-trip is guaranteed for chains that were
imported with fully resolved ids.
