"""
ReACT loop with code execution as the tool.

Hybrid execution mode that combines:
1. ReACT reasoning loop (think → act → observe)
2. Code execution as the ONLY tool (execute_python_code)

This allows agents to:
- Reason about what information they need
- Write Python code to gather that information
- Observe results
- Reason about whether they have enough information
- Write more code OR answer the user's question

This is more powerful than pure code-exec mode because the agent can:
- Chain multiple API calls with intermediate reasoning
- Filter/transform results between calls
- Decide when to stop (rather than fixed retry loop)
"""

import json
from typing import Any, Callable, Dict, Optional

from ccie_sidecar.agents.code_exec import _build_sandbox_globals, _build_env_overrides, _execute_code_with_timeout


# Maximum ReACT loop steps. Headroom for multi-step exploration (discover →
# query → render) on larger tasks like topology diagrams.
MAX_STEPS = 16

# Cap on the code-exec stdout we feed back to the model each step. Without this,
# an unbounded print (e.g. os.walk over the filesystem) can blow past the model's
# context window — observed as a 2.7M-token request against a 128k-context model.
MAX_TOOL_OUTPUT_CHARS = 20_000


def _truncate_output(text: str, limit: int = MAX_TOOL_OUTPUT_CHARS) -> str:
    """Clip tool output to `limit` chars, keeping head and tail with a notice.

    Keeps the start (where useful results usually are) and the tail (where an
    error/summary often lands), dropping the bloated middle.
    """
    if text is None:
        return ""
    if len(text) <= limit:
        return text
    head = text[: int(limit * 0.7)]
    tail = text[-int(limit * 0.2):]
    dropped = len(text) - len(head) - len(tail)
    return (
        f"{head}\n\n…[output truncated: {dropped} chars dropped to fit context. "
        f"Print only what you need — e.g. filter/slice before printing, "
        f"don't dump whole directories or files.]…\n\n{tail}"
    )


def _build_client_section(
    cli_package: Optional[str],
    sandbox_globals: Dict[str, Any],
    meraki_client_ready: bool,
) -> str:
    """Describe the pre-loaded client for the execute_python_code tool.

    Tailored to whichever client is bound into the sandbox so the model uses the
    right API instead of groping. Crucially, when the `proxmox` module is present
    (the bundled Proxmox agent, which has no attached vendor tool), it points the
    model straight at it — otherwise the model falls back to generic
    docker/terraform/HTTP guessing.
    """
    if cli_package == "pyats":
        return (
            "- pyats: pre-initialized pyATS client bound to your testbed.\n"
            "  Every call returns an {ok, data, error, meta} envelope.\n"
            "  STEP 1 ALWAYS: discover real devices first. IMPORTANT: list-devices\n"
            "  returns data as a LIST OF DICTS, NOT a list of name strings:\n"
            "    env = pyats.call('list-devices')\n"
            "    devices = env['data']  # -> [{'name':'R1','os':'iosxe','type':'router'}, ...]\n"
            "    names = [d['name'] for d in devices]  # extract the NAME strings\n"
            "  NEVER iterate the dicts as if they were strings, and NEVER use a\n"
            "  device dict as a key/set member (that raises 'unhashable type: dict')\n"
            "  — always pull d['name'] first. NEVER guess names like R1/CORE1/SW2.\n"
            "  Read against a discovered NAME string:\n"
            "    for name in names:\n"
            "        r = pyats.call('run-show-command', device=name, command='show clock')\n"
            "        if r['ok']: print(name, r['data'])\n"
            "  Do NOT import pyats.topology or use `context`/`testbed` globals,\n"
            "  and do NOT search the filesystem — just call pyats.call(...).\n"
            "  Use run-show-command / learn for reads; configure* requires approval."
        )
    if cli_package == "meraki":
        return (
            "- meraki_api_call(method, path, body=None, query_params=None):\n"
            "  pre-bound function — your ONLY way to reach the Meraki Dashboard.\n"
            "  Do NOT use requests or the meraki SDK. Returns a JSON string;\n"
            "  json.loads it -> {status_code, data, error, blast_radius}.\n"
            "  Paths are under https://api.meraki.com/api/v1 (omit that prefix);\n"
            "  GET lists are auto-paginated. Find by name first, then query by id:\n"
            "    import json\n"
            "    orgs = json.loads(meraki_api_call('GET','/organizations'))['data']\n"
            "    nets = json.loads(meraki_api_call('GET', f'/organizations/{org_id}/networks'))['data']\n"
            "    devices = json.loads(meraki_api_call('GET', f'/networks/{net_id}/devices'))['data']\n"
            "    one_device = json.loads(meraki_api_call('GET', f'/devices/{serial}'))['data']\n"
            "    alerts = json.loads(meraki_api_call('GET', f'/organizations/{org_id}/assurance/alerts'))['data']\n"
            "      (org-wide; filter by deviceSerial) or /networks/{net_id}/health/alerts\n"
            "  ALWAYS GET /devices/{serial} for device detail — NEVER recite a\n"
            "  model's specs from memory. If a path 404s, call meraki.help() for\n"
            "  the correct path instead of guessing.\n"
            "  For PHYSICAL link topology: GET /networks/{net_id}/topology/linkLayer\n"
            "  (NOT /networks/{id}/topology — that 404s). If linkLayer is empty,\n"
            "  fall back to a logical diagram from /networks/{net_id}/devices\n"
            "  (MX root; MS*/C9* switches, MR*/CW* APs, MV* cameras, MT* sensors)."
        )
    if cli_package == "stealthwatch":
        return (
            "- stealthwatch_api_call(method, path, body=None, query_params=None):\n"
            "  pre-bound function — your ONLY way to reach Stealthwatch. Do NOT use\n"
            "  requests, do NOT touch proxmox, and do NOT walk the filesystem.\n"
            "  It returns a JSON string; json.loads it. Shape:\n"
            "    {\"status_code\": int, \"data\": <payload>, \"error\": str|None, \"blast_radius\": str}\n"
            "  STEP 1 ALWAYS: get the tenant id, then use it in every path:\n"
            "    import json\n"
            "    r = json.loads(stealthwatch_api_call('GET', '/sw-reporting/v1/tenants'))\n"
            "    tenant_id = r['data']['data'][0]['id']   # payload is under data.data\n"
            "  Then query, e.g.:\n"
            "    json.loads(stealthwatch_api_call('GET', f'/sw-reporting/v1/tenants/{tenant_id}/hosts'))\n"
            "  KEY tenant-scoped paths (all under /sw-reporting/v1/tenants/{tenant_id}/):\n"
            "    .../security-events/templates   the catalog of security-event TYPES\n"
            "        (id, name, description) — use THIS for 'what event types exist';\n"
            "        there is NO /sw-reporting/v1/security-event-types (that 404s).\n"
            "    .../security-events/queries     POST to start a security-event query\n"
            "    .../flows/queries               POST to start a flow query\n"
            "    .../hosts                        host inventory\n"
            "  Rows are under data['data']. Check status_code < 400 / error is None\n"
            "  before trusting data. If a path 404s it is the wrong shape — do NOT\n"
            "  brute-force singular/plural names; the templates path above is the\n"
            "  event-type catalog. If error says 'not configured', tell the user to\n"
            "  set Settings → Stealthwatch."
        )
    if cli_package == "ise":
        return (
            "- ise_api_call(method, path, body=None, query_params=None, base=None):\n"
            "  pre-bound function — your ONLY way to reach Cisco ISE. Do NOT use\n"
            "  requests, do NOT touch proxmox, do NOT look for env vars or config\n"
            "  files, and do NOT walk the filesystem. ISE is already configured.\n"
            "  It returns a JSON string; json.loads it. Shape:\n"
            "    {\"status_code\": int, \"data\": <payload>, \"error\": str|None, \"blast_radius\": str}\n"
            "  The surface/port is inferred from the path prefix:\n"
            "    /ers/...       ERS config API (port 9060), JSON\n"
            "    /api/...       OpenAPI config API (port 443)\n"
            "    /admin/API/mnt/... MnT monitoring (port 443), read-only, XML auto-parsed to a dict\n"
            "  ERS list responses wrap rows under data['SearchResult']['resources']\n"
            "  (each a stub {id, name, link} — GET by id for detail); page with\n"
            "  query_params={'size':100,'page':n}, filter with {'filter':'name.CONTAINS.x'}.\n"
            "  To list all network devices:\n"
            "    import json\n"
            "    r = json.loads(ise_api_call('GET', '/ers/config/networkdevice', query_params={'size':100}))\n"
            "    for d in r['data']['SearchResult']['resources']:\n"
            "        print(d['id'], d['name'])\n"
            "  Check status_code < 400 / error is None before trusting data. If error\n"
            "  says 'not configured', tell the user to set Settings → ISE."
        )
    if cli_package == "secure_endpoint":
        return (
            "- secure_endpoint_api_call(method, path, body=None, query_params=None):\n"
            "  pre-bound function — your ONLY way to reach Cisco Secure Endpoint. Do\n"
            "  NOT use requests, do NOT look for env vars or config files. Secure\n"
            "  Endpoint is already configured and authenticated.\n"
            "  It returns a JSON string; json.loads it. Shape:\n"
            "    {\"status_code\": int, \"data\": <payload>, \"error\": str|None, \"blast_radius\": str}\n"
            "  v1 response envelope is {\"version\",\"metadata\",\"data\"}; rows are under\n"
            "  data['data']. Page with query_params={'limit':100,'offset':0} (limit max 500).\n"
            "  Key paths: /v1/computers (list endpoints), /v1/computers/{guid} (detail),\n"
            "  /v1/computers/{guid}/isolation (GET status, PUT to isolate, DELETE to stop),\n"
            "  /v1/events, /v1/groups, /v1/policies, /v1/vulnerabilities, /v1/file_lists.\n"
            "  Find a host's connector_guid via GET /v1/computers first, then act on it.\n"
            "  To list computers:\n"
            "    import json\n"
            "    r = json.loads(secure_endpoint_api_call('GET', '/v1/computers', query_params={'limit':100}))\n"
            "    for c in r['data']['data']:\n"
            "        print(c['connector_guid'], c.get('hostname'))\n"
            "  Check status_code < 400 / error is None before trusting data. If error\n"
            "  says 'not configured', tell the user to set Settings → Secure Endpoint."
        )
    if cli_package == "cisco_xdr":
        from ccie_sidecar.cisco_xdr import XDR_CAPABILITIES_DOC
        return (
            "- cisco_xdr_api_call(method, path, body=None, query_params=None):\n"
            "  pre-bound function — your ONLY way to reach Cisco XDR. Do NOT use\n"
            "  requests, do NOT look for env vars or config files. Cisco XDR is\n"
            "  already configured and authenticated (do NOT mint tokens yourself).\n"
            "  It returns a JSON string; json.loads it.\n\n"
            + XDR_CAPABILITIES_DOC
        )
    if cli_package == "mist":
        from ccie_sidecar.mist import MIST_CAPABILITIES_DOC
        return (
            "- mist_api_call(method, path, body=None, query_params=None):\n"
            "  pre-bound function — your ONLY way to reach Juniper Mist. Do NOT use\n"
            "  requests, do NOT look for env vars or config files. Mist is already\n"
            "  configured and authenticated (a static API token is attached for you).\n"
            "  It returns a JSON string; json.loads it.\n\n"
            + MIST_CAPABILITIES_DOC
        )
    if cli_package == "cml":
        return (
            "- cml_api_call(method, path, body=None, query_params=None):\n"
            "  pre-bound function — your ONLY way to reach Cisco Modeling Labs. Do NOT\n"
            "  use requests, do NOT touch proxmox, do NOT look for env vars or config\n"
            "  files, and do NOT walk the filesystem. CML is already configured and\n"
            "  authenticated (do NOT call /authenticate yourself).\n"
            "  It returns a JSON string; json.loads it. Shape:\n"
            "    {\"status_code\": int, \"data\": <payload>, \"error\": str|None, \"blast_radius\": str}\n"
            "  ONE base URL: https://<host>/api/v0 — all paths are relative to it.\n"
            "  To list labs and inspect one's topology:\n"
            "    import json\n"
            "    labs = json.loads(cml_api_call('GET', '/labs'))\n"
            "    for lab_id in labs['data']:\n"
            "        topo = json.loads(cml_api_call('GET', f'/labs/{lab_id}/topology'))\n"
            "        print(lab_id, topo['status_code'])\n"
            "  Check status_code < 400 / error is None before trusting data. If error\n"
            "  says 'not configured', tell the user to set Settings → CML."
        )
    if cli_package == "catalyst_center":
        return (
            "- catalyst_center_api_call(method, path, body=None, query_params=None):\n"
            "  pre-bound function — your ONLY way to reach Cisco Catalyst Center. Do\n"
            "  NOT use requests, do NOT touch proxmox, do NOT look for env vars or\n"
            "  config files, and do NOT walk the filesystem. Catalyst Center is already\n"
            "  configured and authenticated (do NOT call the auth/token endpoint).\n"
            "  It returns a JSON string; json.loads it. Shape:\n"
            "    {\"status_code\": int, \"data\": <payload>, \"error\": str|None, \"blast_radius\": str}\n"
            "  Pass the FULL path from the host root. Bases: /dna/intent/api/v1 (most\n"
            "  resources), /dna/intent/api/v2, /dna/system/api/v1. List rows are under\n"
            "  data['response']. To list devices:\n"
            "    import json\n"
            "    r = json.loads(catalyst_center_api_call('GET', '/dna/intent/api/v1/network-device',\n"
            "                                            query_params={'limit': 500}))\n"
            "    for d in r['data']['response']:\n"
            "        print(d['hostname'], d['managementIpAddress'])\n"
            "  Check status_code < 400 / error is None before trusting data. If error\n"
            "  says 'not configured', tell the user to set Settings → Catalyst Center."
        )
    if cli_package == "aci":
        return (
            "- aci_api_call(method, path, body=None, query_params=None):\n"
            "  pre-bound function — your ONLY way to reach the Cisco ACI fabric (APIC).\n"
            "  Do NOT use requests, do NOT touch proxmox, do NOT look for env vars or\n"
            "  config files, and do NOT walk the filesystem. ACI is already configured\n"
            "  and authenticated (do NOT call /api/aaaLogin yourself).\n"
            "  It returns a JSON string; json.loads it. Shape:\n"
            "    {\"status_code\": int, \"data\": <payload>, \"error\": str|None, \"blast_radius\": str}\n"
            "  Rooted at https://<host>; every path carries its own prefix. Two styles:\n"
            "  CLASS queries (/api/node/class/<class>.json) and MO queries\n"
            "  (/api/node/mo/<dn>.json). Results are under data['imdata'] (a list of\n"
            "  {className: {attributes: {...}}}). To list tenants:\n"
            "    import json\n"
            "    r = json.loads(aci_api_call('GET', '/api/node/class/fvTenant.json'))\n"
            "    for mo in r['data']['imdata']:\n"
            "        print(mo['fvTenant']['attributes']['name'])\n"
            "  Check status_code < 400 / error is None before trusting data. Writes\n"
            "  (POST/DELETE of a managed object) hit the live fabric. If error says\n"
            "  'not configured', tell the user to set Settings → ACI."
        )
    if cli_package == "gnmi":
        return (
            "- gnmi: pre-bound helper object — your ONLY way to reach devices over\n"
            "  gNMI (gRPC). Do NOT use requests/grpc directly, do NOT touch proxmox,\n"
            "  and do NOT walk the filesystem. gNMI is multi-target: address devices\n"
            "  BY NAME from the configured list. Each method returns a dict:\n"
            "    {\"ok\": bool, \"op\": str, \"data\": <payload>, \"error\": str|None, \"blast_radius\": str}\n"
            "  STEP 1 ALWAYS: list targets, then operate on one by name:\n"
            "    for t in gnmi.targets():\n"
            "        print(t['name'], t['host'], t['vendor'])\n"
            "  Read-only ops: gnmi.capabilities(name), gnmi.get(name, ['openconfig-\n"
            "  interfaces:interfaces']), gnmi.subscribe(name, [path])  # ONCE sample.\n"
            "  WRITE op (changes live config, needs user intent): gnmi.set(name,\n"
            "  update=[(path, value)], replace=[...], delete=[path]).\n"
            "  Check ok / error before trusting data. If targets() is empty, tell the\n"
            "  user to add devices in Settings → gNMI."
        )
    if cli_package == "iosxe_translate":
        return (
            "- iosxe: pre-bound helper for Cisco IOS-XE CLI <-> NETCONF/XML\n"
            "  translation. Do NOT use requests/ncclient directly or walk the\n"
            "  filesystem. Each method returns a dict:\n"
            "    {\"ok\": bool, \"op\": str, \"data\": <payload>, \"error\": str|None,\n"
            "     \"tier\": \"A\"|\"B\"|\"C\", \"blast_radius\": str}\n"
            "  ACCURACY TIERS -- always tell the user which one produced a result:\n"
            "    A = device-verified (authoritative). B = model-grounded, NOT\n"
            "    device-verified. C = cli-rpc envelope (transport, not native).\n"
            "  GROUND EVERYTHING IN FACT -- never invent XML paths or namespaces:\n"
            "    iosxe.models(filter='native')            # what YANG is downloaded (B)\n"
            "    iosxe.schema_tree('Cisco-IOS-XE-native', path='native/interface')\n"
            "                                             # REAL containers/leaves (B)\n"
            "    iosxe.validate_native(xml)               # namespace check (B)\n"
            "    iosxe.cli_to_rpc('interface Lo1\\n description x')  # envelope (C)\n"
            "  For an AUTHORITATIVE answer, round-trip on a real device (needs a\n"
            "  pyATS device name; these WRITE, blast 'high', so confirm intent):\n"
            "    iosxe.cli_to_native(device, cli, restconf_path='native/interface/Loopback=1')\n"
            "    iosxe.native_to_cli(device, native_xml, restconf_path, method='PATCH')\n"
            "  Offline (B/C) is safe for drafting + structural checks, but CLI does\n"
            "  NOT map 1:1 to native XML -- only Tier A is authoritative. If\n"
            "  iosxe.models() is empty, tell the user to download Cisco XE YANG in\n"
            "  the NETCONF tab's YANG browser; if no device, Settings → pyATS."
        )
    if cli_package == "fmc":
        return (
            "- fmc_api_call(method, path, body=None, query_params=None):\n"
            "  pre-bound function — your ONLY way to reach the Cisco Secure Firewall\n"
            "  Management Center (FMC). Do NOT use requests, do NOT touch proxmox, do\n"
            "  NOT look for env vars or config files, and do NOT walk the filesystem.\n"
            "  FMC is already configured and authenticated (do NOT call\n"
            "  /auth/generatetoken). It returns a JSON string; json.loads it. Shape:\n"
            "    {\"status_code\": int, \"data\": <payload>, \"error\": str|None, \"blast_radius\": str}\n"
            "  Config resources live under /api/fmc_config/v1/domain/{domainUUID}/... —\n"
            "  use the LITERAL '{domainUUID}' and it is auto-filled. List rows are under\n"
            "  data['items']; page with query_params {'limit':25,'offset':0} and add\n"
            "  {'expanded':True} for full objects. To list access policies:\n"
            "    import json\n"
            "    r = json.loads(fmc_api_call('GET',\n"
            "        '/api/fmc_config/v1/domain/{domainUUID}/policy/accesspolicies'))\n"
            "    for p in r['data']['items']:\n"
            "        print(p['name'], p['id'])\n"
            "  Check status_code < 400 / error is None before trusting data. Writes\n"
            "  change firewall config. If error says 'not configured', tell the user to\n"
            "  set Settings → FMC."
        )
    if cli_package == "thousandeyes":
        return (
            "- thousandeyes_api_call(method, path, body=None, query_params=None):\n"
            "  pre-bound function — your ONLY way to reach Cisco ThousandEyes. Do NOT\n"
            "  use requests, do NOT touch proxmox, do NOT look for env vars or config\n"
            "  files, and do NOT walk the filesystem. The Bearer token is already\n"
            "  configured. It returns a JSON string; json.loads it. Shape:\n"
            "    {\"status_code\": int, \"data\": <payload>, \"error\": str|None, \"blast_radius\": str}\n"
            "  Base is https://api.thousandeyes.com; pass paths under /v7/... This is\n"
            "  READ-ONLY (method is always 'GET'). To find tests then read results:\n"
            "    import json\n"
            "    r = json.loads(thousandeyes_api_call('GET', '/v7/tests'))\n"
            "    for t in r['data'].get('tests', []):\n"
            "        print(t['testId'], t['testName'])\n"
            "  Check status_code < 400 / error is None before trusting data. If error\n"
            "  says 'not configured', tell the user to set Settings → ThousandEyes."
        )
    if cli_package == "splunk":
        return (
            "- splunk_api_call(method, path, body=None, query_params=None):\n"
            "  pre-bound function — your ONLY way to reach Cisco Splunk. Do NOT use\n"
            "  requests, do NOT touch proxmox, do NOT look for env vars or config\n"
            "  files, and do NOT walk the filesystem. Splunk is already configured\n"
            "  and authenticated (token or Basic — do NOT log in yourself).\n"
            "  It returns a JSON string; json.loads it. Shape:\n"
            "    {\"status_code\": int, \"data\": <payload>, \"error\": str|None, \"blast_radius\": str}\n"
            "  Rooted at https://<host>:8089. output_mode=json is added for you on\n"
            "  GETs. Config objects (indexes, saved searches, server info) are under\n"
            "  data['entry'] (each has 'name' + 'content'). Search results come back\n"
            "  in different shapes depending on endpoint and result count — inspect\n"
            "  data (see 'WORKING WITH UNFAMILIAR API RESPONSES' above) before\n"
            "  indexing rather than assuming dict vs ndjson-string.\n"
            "  List indexes:\n"
            "    import json\n"
            "    r = json.loads(splunk_api_call('GET', '/services/data/indexes'))\n"
            "    for e in r['data']['entry']:\n"
            "        print(e['name'])\n"
            "  SPL RULE (READ FIRST — the #1 cause of failures): the 'search'\n"
            "  string sent to /services/search/jobs and /jobs/export MUST begin\n"
            "  with the literal word 'search ' UNLESS it starts with '|' (a\n"
            "  generating command like '| rest') or is 'savedsearch \"...\"'. A\n"
            "  bare 'index=_internal ...' returns HTTP 400 'Unknown search command\n"
            "  index'. Unlike the Splunk web UI, the REST API does NOT add it for\n"
            "  you. Correct: 'search index=main ...'  Wrong: 'index=main ...'.\n"
            "  Run a one-shot search (synchronous; /export data varies: an ndjson\n"
            "  STRING for many results, a dict for one — handle both):\n"
            "    r = json.loads(splunk_api_call('POST', '/services/search/jobs/export',\n"
            "          body={'search': 'search index=_internal | head 5',\n"
            "                'earliest_time': '-15m', 'output_mode': 'json'}))\n"
            "    d = r['data']\n"
            "    rows = ([json.loads(l)['result'] for l in d.splitlines() if l.strip()]\n"
            "            if isinstance(d, str) else [d['result']] if 'result' in d else d.get('results', []))\n"
            "    for row in rows: print(row)\n"
            "  Check status_code < 400 / error is None before trusting data. If error\n"
            "  says 'not configured', tell the user to set Settings → Splunk."
        )
    if cli_package == "grafana":
        return (
            "- grafana_api_call(method, path, body=None, query_params=None):\n"
            "  pre-bound function — your ONLY way to reach Grafana. Do NOT use\n"
            "  requests or look for env vars. The API token is already configured.\n"
            "  It returns a JSON string; json.loads it. Shape:\n"
            "    {\"status_code\": int, \"data\": <payload>, \"error\": str|None, \"blast_radius\": str}\n"
            "  Rooted at the instance URL; pass paths under /api/... Read methods on\n"
            "  the `grafana` object: grafana.search_dashboards(query),\n"
            "  grafana.list_datasources(), grafana.query(promql, ds_uid),\n"
            "  grafana.health(). Search dashboards:\n"
            "    import json\n"
            "    r = json.loads(grafana_api_call('GET', '/api/search', query_params={'type':'dash-db'}))\n"
            "    for d in r['data']:\n"
            "        print(d['uid'], d['title'])\n"
            "  BUILD dashboards (WRITE, blast_radius medium — will prompt for approval):\n"
            "    grafana.create_dashboard(dashboard_model, folder_uid=None, overwrite=False)\n"
            "    grafana.create_folder(title); grafana.delete_dashboard(uid) (high).\n"
            "  `dashboard_model` is the Grafana dashboard JSON (a dict): {'title': ...,\n"
            "  'panels': [...], 'templating': {...}, 'time': {...}}. Omit id/uid to\n"
            "  create new. Each panel needs a datasource {'uid': ds_uid} and PromQL\n"
            "  targets [{'refId','expr'}]; get ds_uid from list_datasources(). Before\n"
            "  creating, state what you'll build and confirm with the user. Example:\n"
            "    ds = json.loads(grafana_api_call('GET','/api/datasources'))['data']\n"
            "    uid = next(d['uid'] for d in ds if d['type']=='prometheus')\n"
            "    dash = {'title':'Net Health','panels':[{'type':'timeseries','title':'Up',\n"
            "        'datasource':{'uid':uid},'targets':[{'refId':'A','expr':'up'}],\n"
            "        'gridPos':{'h':8,'w':12,'x':0,'y':0}}],'time':{'from':'now-6h','to':'now'}}\n"
            "    print(grafana_api_call('POST','/api/dashboards/db', body={'dashboard':dash,'overwrite':False}))\n"
            "  Check status_code < 400 / error is None before trusting data. If error\n"
            "  says 'not configured', tell the user to set Settings → Grafana."
        )
    if cli_package == "zabbix":
        return (
            "- zabbix_api_call(method, params): read-only Zabbix JSON-RPC helper. Use host.get, problem.get, item.get, history.get, trend.get, template.get, and inventory reads; json.loads its envelope and inspect error before data. Do not use requests or config files. For any allowed monitoring change, first read the target then call zabbix_apply(method, params, rationale). That exact payload pauses for operator approval; never attempt a mutation through zabbix_api_call. Blocked: user, role, token, media, script, and action administration. If unconfigured, say Settings → Zabbix."
        )
    if cli_package == "prometheus":
        return (
            "- prometheus_api_call(method, path, body=None, query_params=None):\n"
            "  pre-bound function — your ONLY way to reach Prometheus. Do NOT use\n"
            "  requests or look for env vars. Auth is already configured.\n"
            "  It returns a JSON string; json.loads it. Shape:\n"
            "    {\"status_code\": int, \"data\": <payload>, \"error\": str|None, \"blast_radius\": str}\n"
            "  This is READ-ONLY. Prefer the convenience methods on `prometheus`:\n"
            "    prometheus.query(promql)                # instant\n"
            "    prometheus.query_range(promql, start, end, step='60s')\n"
            "    prometheus.metrics()                    # all metric names\n"
            "    prometheus.targets()                    # scrape health\n"
            "    prometheus.metadata(metric=None)\n"
            "  Instant query (data.result is a list of {metric, value}):\n"
            "    import json\n"
            "    r = json.loads(prometheus_api_call('GET', '/api/v1/query', query_params={'query':'up'}))\n"
            "    for s in r['data']['data']['result']:\n"
            "        print(s['metric'], s['value'])\n"
            "  NB: Prometheus wraps its payload as {status:'success', data:{...}} INSIDE\n"
            "  our envelope's 'data', so read r['data']['data']. If error says 'not\n"
            "  configured', tell the user to set Settings → Prometheus."
        )
    if cli_package == "netbox":
        return (
            "- netbox_api_call(method, path, body=None, query_params=None):\n"
            "  pre-bound function — your ONLY way to reach NetBox. Do NOT use\n"
            "  requests or look for env vars. The API token is already configured.\n"
            "  It returns a JSON string; json.loads it. Shape:\n"
            "    {\"status_code\": int, \"data\": <payload>, \"error\": str|None, \"blast_radius\": str}\n"
            "  NetBox is READ-WRITE (a source of truth). GET is safe; POST/PATCH/PUT\n"
            "  and DELETE MUTATE records and are gated for approval — only write when\n"
            "  the user explicitly asks, and describe the change first. Rooted at\n"
            "  /api/... List responses paginate under data['results'] (data['count']\n"
            "  total, data['next'] URL). Convenience: netbox.list_devices(**filters),\n"
            "  netbox.list_ip_addresses(**filters), netbox.list_prefixes(**filters).\n"
            "  List devices at a site:\n"
            "    import json\n"
            "    r = json.loads(netbox_api_call('GET', '/api/dcim/devices/', query_params={'site':'nyc'}))\n"
            "    for d in r['data']['results']:\n"
            "        print(d['name'], d['device_type']['model'])\n"
            "  Check status_code < 400 / error is None. If error says 'not configured',\n"
            "  tell the user to set Settings → NetBox."
        )
    if cli_package == "sketchfab":
        return (
            "- sketchfab_api_call(method, path, body=None, query_params=None):\n"
            "  pre-bound function to reach the Sketchfab Data API v3. Do NOT use\n"
            "  requests. A key may be configured (optional; search works anonymously,\n"
            "  downloads need a key). It returns a JSON string; json.loads it. Shape:\n"
            "    {\"status_code\": int, \"data\": <payload>, \"error\": str|None, \"blast_radius\": str}\n"
            "  Rooted at https://api.sketchfab.com/v3. Convenience on `sketchfab`:\n"
            "    sketchfab.search(query, downloadable=True, cc0=False)  # cc0 is OPT-IN\n"
            "    sketchfab.model(uid)      # details + REAL license slug\n"
            "    sketchfab.download(uid)   # time-limited URLs (needs a key)\n"
            "  IMPORTANT: do NOT pass cc0=True by default — the license=cc0 filter is\n"
            "  extremely sparse and returns ZERO for most specific queries (e.g.\n"
            "  'network router'). Search first WITHOUT the filter, then verify each\n"
            "  candidate's license via sketchfab.model(uid) (search results have NO\n"
            "  license slug) and only recommend/download CC0 or permissive ones.\n"
            "    import json\n"
            "    r = json.loads(sketchfab_api_call('GET', '/search', query_params={'type':'models','q':'router','downloadable':'true'}))\n"
            "    for m in r['data'].get('results', []):\n"
            "        print(m['uid'], m['name'])\n"
            "    lic = json.loads(sketchfab_api_call('GET', f\"/models/{m['uid']}\"))['data']['license']['slug']\n"
            "  If error says 'not configured', a key lifts limits (Settings → Sketchfab)."
        )
    if cli_package == "devnet":
        return (
            "- devnet_api_call(method, path, body=None, query_params=None):\n"
            "  pre-bound function to search Cisco DevNet documentation (public, no\n"
            "  auth). Do NOT use requests. It returns a JSON string; json.loads it.\n"
            "  Shape: {\"status_code\", \"data\", \"error\", \"blast_radius\"}. Use the\n"
            "  `devnet.search(query)` convenience method to find Meraki / Catalyst\n"
            "  Center API docs, operation ids, and general DevNet content:\n"
            "    import json\n"
            "    r = json.loads(devnet_api_call('GET', '/search/', query_params={'q':'meraki getNetworkClients'}))\n"
            "    print(r['data'])\n"
            "  Read-only reference lookups — cite the doc links you find."
        )
    if cli_package == "fwrule":
        return (
            "- fwrule: pre-bound OFFLINE firewall/ACL analyzer (no network, no creds,\n"
            "  NOT an _api_call). Detects shadowing, redundancy, duplicates, and\n"
            "  conflicts across the 6 match dimensions. Two input modes:\n"
            "    fwrule.analyze(acl_text, vendor='ios')   # parse Cisco IOS/IOS-XE ACLs\n"
            "    fwrule.analyze(rules=[{...}])             # normalized list, ANY vendor\n"
            "  A normalized rule is {action, protocol, src, dst, src_port, dst_port}\n"
            "  (src/dst are CIDR or 'any'; ports are int, [lo,hi], or 'any'). Returns\n"
            "  {ok, rule_count, findings:[{type, earlier, later, detail}], summary}.\n"
            "  Analyze an ACL:\n"
            "    r = fwrule.analyze('permit tcp any any eq 80\\ndeny tcp any any eq 80', vendor='ios')\n"
            "    print(r['summary']); [print(f['type'], f['detail']) for f in r['findings']]\n"
            "  Call fwrule.help() for the full signature. For non-IOS vendors, pass\n"
            "  rules=[...] (build the normalized list from the device config)."
        )
    # No vendor client bound. If the proxmox code-API is present, steer the model
    # to it explicitly — it is the whole reason the Proxmox agent exists.
    if "proxmox" in sandbox_globals:
        return (
            "- proxmox: pre-loaded Proxmox VE module bound to the configured host.\n"
            "  This is your ONLY way to reach Proxmox — do NOT look for docker,\n"
            "  kubectl, terraform, env vars, or config files, and do NOT walk the\n"
            "  filesystem.\n"
            "  STEP 1 ALWAYS: discover capabilities:\n"
            "    import proxmox\n"
            "    print(proxmox.help())                 # lists every function\n"
            "    print(proxmox.help('vm'))             # signatures for a topic\n"
            "  Then call typed functions, e.g.:\n"
            "    print(proxmox.get_vms())              # {'ok': True, 'vms': [...]}\n"
            "    print(proxmox.get_nodes())\n"
            "  Reads return plain dicts shaped {'ok': bool, ...} — check ['ok'] and\n"
            "  surface ['error'] on failure. Destructive ops need confirm=True after\n"
            "  the user approves. If it reports 'not configured', tell the user to\n"
            "  set host/credentials in Settings → Proxmox."
        )
    return (
        "- A plain Python sandbox (no vendor client bound). Use requests/os "
        "for any HTTP APIs you need."
    )


def _call_llm_with_tools(
    provider: str,
    model: str,
    api_key: Optional[str],
    base_url: Optional[str],
    messages: list[Dict[str, Any]],
    tools: list[dict],
    system_prompt: str,
) -> Dict[str, Any]:
    """
    Call LLM with code execution tool.

    Returns response in unified format:
    {
        "stop_reason": "end_turn" | "tool_use" | "error",
        "content": [{"type": "text"|"tool_use", ...}],
        "error": "..." (only if stop_reason == "error")
    }
    """
    if provider == "anthropic":
        from ccie_sidecar.providers.anthropic import call_with_tools
        return call_with_tools(
            api_key=api_key,
            model=model,
            messages=messages,
            tools=tools,
            system=system_prompt,
        )
    elif provider == "openai":
        from ccie_sidecar.providers.openai import call_with_tools
        return call_with_tools(
            api_key=api_key,
            model=model,
            messages=messages,
            tools=tools,
            system=system_prompt,
        )
    elif provider == "nvidia":
        from ccie_sidecar.providers.nvidia import call_with_tools
        return call_with_tools(
            api_key=api_key,
            model=model,
            messages=messages,
            tools=tools,
            system=system_prompt,
        )
    elif provider == "vllm":
        from ccie_sidecar.providers.vllm import call_with_tools
        return call_with_tools(
            endpoint=base_url,
            model=model,
            messages=messages,
            tools=tools,
            api_key=api_key,
        )
    else:
        return {
            "stop_reason": "error",
            "error": f"Unknown provider: {provider}"
        }


async def react_code_loop(
    agent_def: dict,
    user_msg: str,
    ctx: dict,
    on_event: Callable[[dict], None],
) -> None:
    """
    Execute ReACT loop with code execution as the only tool.

    Args:
        agent_def: Agent definition dict containing system_prompt
        user_msg: User's message/query
        ctx: Context dict (empty for now)
        on_event: Callback function to emit events to frontend

    Events emitted:
        - {"type": "thought_start", "step": int}
        - {"type": "tool_call", "name": "execute_python_code", "args": {"code": "..."}}
        - {"type": "tool_result", "success": bool, "result": str}
        - {"type": "final", "response": str}
        - {"type": "error", "message": str}
    """
    try:
        # Get vault secrets for code sandbox
        vault_secrets = agent_def.get("vault_secrets") or {}

        # Which CLI client to bind into the sandbox. Sent from Rust via the
        # agent's first attached-tool id. Empty/None => plain Python sandbox.
        # This MUST be honored: hardcoding "meraki" here made the pyATS agent
        # call Meraki tools.
        cli_package = agent_def.get("tool_id") or None

        # Wrap on_event so the lessons layer can passively observe tool
        # successes/failures for post-turn distillation. Byte-identical event
        # stream; no-op when the flag is off.
        from ccie_sidecar.agents.lessons import LessonObserver, distill_and_store
        on_event = LessonObserver(on_event)

        # Diagnostic keys only. Secret values must never enter sidecar logs.
        import sys
        print(f"[react_code_loop] vault_secrets keys: {list(vault_secrets.keys())}", file=sys.stderr)

        # Get LLM configuration
        from ccie_sidecar.agent import get_saved_config

        config = get_saved_config()
        if not config:
            on_event({
                "type": "error",
                "message": "No AI provider configured",
            })
            return

        provider = config.get("provider", "anthropic")
        model = config.get("model", "claude-sonnet-4-6")
        api_key = config.get("api_key")
        base_url = config.get("base_url")

        # Allow agent model_override
        if agent_def.get("model_override"):
            override = agent_def["model_override"]
            if isinstance(override, dict) and override.get("model"):
                model = override["model"]

        # Validate API key/endpoint based on provider
        import os
        if provider == "anthropic":
            if not api_key:
                api_key = os.getenv("ANTHROPIC_API_KEY")
            if not api_key:
                on_event({
                    "type": "error",
                    "message": "Anthropic API key not configured",
                })
                return
        elif provider == "openai":
            if not api_key:
                api_key = os.getenv("OPENAI_API_KEY")
            if not api_key:
                on_event({
                    "type": "error",
                    "message": "OpenAI API key not configured",
                })
                return
        elif provider == "google":
            if not api_key:
                api_key = os.getenv("GOOGLE_API_KEY")
            if not api_key:
                on_event({
                    "type": "error",
                    "message": "Google API key not configured",
                })
                return
        elif provider == "nvidia":
            if not api_key:
                api_key = os.getenv("NVIDIA_API_KEY")
            if not api_key:
                on_event({
                    "type": "error",
                    "message": "NVIDIA API key not configured",
                })
                return
        elif provider == "vllm":
            endpoint = base_url or os.getenv("VLLM_ENDPOINT", "http://localhost:8000")
            if not endpoint.rstrip("/").endswith("/v1"):
                endpoint = endpoint.rstrip("/") + "/v1"
            base_url = endpoint
        elif provider == "ollama":
            endpoint = base_url or os.getenv("OLLAMA_HOST", "http://localhost:11434")
            base_url = endpoint
        else:
            on_event({
                "type": "error",
                "message": f"Unsupported provider: {provider}",
            })
            return

        # Log configuration for debugging
        import sys
        print(f"[react_code_loop] Using provider={provider}, model={model}", file=sys.stderr)

        # Build the code execution sandbox bound to the agent's actual client
        # BEFORE the tool description, so the description can reflect whether the
        # vendor SDK client actually got bound (it only binds when a key was
        # delivered). Pass emit=on_event so the injected `drawio` helper streams
        # diagram events to the frontend panel.
        from ccie_sidecar.agents.catalog_grounding import (
            catalog_prompt_hint,
            install_catalog_grounding,
            resolve_agent_catalogs,
        )
        catalogs = resolve_agent_catalogs(agent_def)
        sandbox_globals = _build_sandbox_globals(cli_package, vault_secrets, emit=on_event)
        env_overrides = _build_env_overrides(vault_secrets)

        print(f"[react_code_loop] cli_package={cli_package!r} "
              f"env_overrides keys: {list(env_overrides.keys())} "
              f"pyats_bound={'pyats' in sandbox_globals} "
              f"meraki_bound={'meraki' in sandbox_globals}", file=sys.stderr)

        # .env fallback (Meraki only): if the vault didn't deliver secrets, load
        # the Meraki key from ~/.ccie-terminal/.env. pyATS reads its own
        # testbed .env inside build_pyats_client(), so it needs nothing here.
        import os
        if cli_package == "meraki" and len(vault_secrets) == 0:
            env_path = os.path.expanduser("~/.ccie-terminal/.env")
            if os.path.exists(env_path):
                try:
                    with open(env_path, encoding="utf-8") as f:
                        for line in f:
                            line = line.strip()
                            if not line or line.startswith("#") or "=" not in line:
                                continue
                            k, _, v = line.partition("=")
                            k = k.strip()
                            v = v.strip().strip('"').strip("'")
                            if k:
                                env_overrides[k] = v
                                # Mirror MERAKI_API_KEY variants
                                if k == "MERAKI_API_KEY":
                                    sandbox_globals["meraki_api_key"] = v
                                    env_overrides.setdefault("MERAKI_DASHBOARD_API_KEY", v)
                    print(f"[react_code_loop] Loaded .env, env_overrides now has: {list(env_overrides.keys())}", file=sys.stderr)
                except Exception as e:
                    print(f"[react_code_loop] .env loading failed: {e}", file=sys.stderr)
                    pass

        catalog_index = install_catalog_grounding(sandbox_globals, catalogs)

        # Whether the single-door meraki_api_call helper is bound into the
        # sandbox (true when a key was delivered). Kept for signature parity.
        meraki_client_ready = "meraki_api_call" in sandbox_globals

        # Build the execute_python_code tool description, tailored to whichever
        # client is bound into the sandbox so the model uses the right API.
        client_section = _build_client_section(
            cli_package, sandbox_globals, meraki_client_ready
        )
        # Memory-first line sits ABOVE the vendor "your ONLY way" text (same
        # channel) so the agent checks KNOWN FACTS before a live call. "" off.
        from ccie_sidecar.agents.graph_helper import memory_first_preamble
        _mem = memory_first_preamble()
        if _mem:
            client_section = _mem + "\n" + client_section

        tool_description = f"""Execute Python code to gather information.

You have access to:
- Standard library (json, datetime, collections, os)
- requests library for HTTP calls
- Vault secrets: {', '.join(vault_secrets.keys()) or '(none)'}

Pre-loaded client:
{client_section}

Use this tool to:
1. Query infrastructure / call APIs to gather information
2. Process/filter/transform data
3. Extract specific information needed to answer the user

Use print() to output results — only printed output is visible to you."""

        # Catalog-backed discovery is on demand and bounded; raw catalogs never
        # enter this description. Bare sandboxes retain the older compact hints.
        from ccie_sidecar.agents.sandbox_index import (
            build_method_index,
            build_discovery_hint,
        )
        _catalog_hint = catalog_prompt_hint(catalog_index)
        _method_index = "" if _catalog_hint else build_method_index(cli_package, sandbox_globals)
        _discovery_hint = "" if _catalog_hint else build_discovery_hint(cli_package)
        if _discovery_hint:
            tool_description += f"\n\n{_discovery_hint}"
        if _method_index:
            tool_description += f"\n\n{_method_index}"
        if _catalog_hint:
            tool_description += f"\n\n{_catalog_hint}"

        if provider == "anthropic":
            execute_tool = {
                "name": "execute_python_code",
                "description": tool_description,
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "reasoning": {
                            "type": "string",
                            "description": "Explain in 1-2 sentences what you're about to do and why this step is necessary."
                        },
                        "code": {
                            "type": "string",
                            "description": "Python code to execute. Use print() to output results."
                        }
                    },
                    "required": ["reasoning", "code"]
                }
            }
            tools = [execute_tool]
            if catalog_index is not None:
                tools.insert(0, {
                    "name": "search_api_catalog",
                    "description": (
                        "Mandatory first tool for a live vendor API operation. Search "
                        "the bounded in-memory catalog for the user's exact intent. Once "
                        "a match fits, stop searching and use its exact record in "
                        "execute_python_code."
                    ),
                    "input_schema": {
                        "type": "object",
                        "properties": {
                            "query": {"type": "string"},
                            "catalog_id": {"type": "string"},
                            "limit": {"type": "integer", "default": 5},
                        },
                        "required": ["query", "catalog_id"],
                    },
                })
        else:
            # OpenAI/vLLM format
            execute_tool = {
                "type": "function",
                "function": {
                    "name": "execute_python_code",
                    "description": tool_description,
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "reasoning": {
                                "type": "string",
                                "description": "Explain in 1-2 sentences what you're about to do and why this step is necessary."
                            },
                            "code": {
                                "type": "string",
                                "description": "Python code to execute. Use print() to output results."
                            }
                        },
                        "required": ["reasoning", "code"]
                    }
                }
            }
            tools = [execute_tool]
            if catalog_index is not None:
                tools.insert(0, {
                    "type": "function",
                    "function": {
                        "name": "search_api_catalog",
                        "description": (
                            "Mandatory first tool for a live vendor API operation. Search "
                            "the bounded in-memory catalog for the user's exact intent. Once "
                            "a match fits, stop searching and use its exact record in "
                            "execute_python_code."
                        ),
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "query": {"type": "string"},
                                "catalog_id": {"type": "string"},
                                "limit": {"type": "integer", "default": 5},
                            },
                            "required": ["query", "catalog_id"],
                        },
                    },
                })

        # Build system prompt
        system_prompt = agent_def.get("system_prompt", "")
        # Sandbox agents get the tiny Proxmox discovery hint (the `proxmox` module
        # is injected into every sandbox). Mirrors the deepagents loops.
        from ccie_sidecar.agents.code_exec import (
            BLENDER_SANDBOX_BLURB,
            PROXMOX_SANDBOX_BLURB,
            UTILITY_SANDBOX_BLURB,
            SANDBOX_SHAPE_DISCIPLINE_BLURB,
            graph_sandbox_blurb_suffix,
        )
        from ccie_sidecar.agents.lessons import lessons_blurb
        system_prompt = (
            (system_prompt or "")
            + "\n\n" + PROXMOX_SANDBOX_BLURB
            + "\n\n" + BLENDER_SANDBOX_BLURB
            + "\n\n" + UTILITY_SANDBOX_BLURB
            + "\n\n" + SANDBOX_SHAPE_DISCIPLINE_BLURB
            + graph_sandbox_blurb_suffix(user_msg)
            + lessons_blurb(cli_package)
        )

        # Initialize conversation (prepend prior history for multi-turn context)
        from ccie_sidecar.agents.code_exec import build_history_messages
        messages = build_history_messages(ctx, user_msg)

        # ReACT loop
        for step in range(1, MAX_STEPS + 1):
            # Call LLM
            try:
                response = _call_llm_with_tools(
                    provider=provider,
                    model=model,
                    api_key=api_key,
                    base_url=base_url,
                    messages=messages,
                    tools=tools,
                    system_prompt=system_prompt,
                )

                if response.get("stop_reason") == "error":
                    on_event({
                        "type": "error",
                        "message": f"LLM error: {response.get('error', 'Unknown')}",
                    })
                    return
            except Exception as e:
                on_event({
                    "type": "error",
                    "message": f"LLM request failed: {str(e)}",
                })
                return

            # Check stop reason
            if response.get("stop_reason") == "end_turn":
                # Extract final text
                text_content = ""
                for block in response.get("content", []):
                    if block.get("type") == "text":
                        text_content += block.get("text", "")

                on_event({"type": "final", "response": text_content})
                distill_and_store(on_event, cli_package, user_msg)
                return

            # Process tool calls
            if response.get("stop_reason") == "tool_use":
                # Add assistant message to history
                if provider == "anthropic":
                    messages.append({"role": "assistant", "content": response.get("content", [])})
                else:
                    # OpenAI format
                    tool_calls = []
                    text_parts = []
                    for block in response.get("content", []):
                        if block.get("type") == "text":
                            text_parts.append(block.get("text", ""))
                        elif block.get("type") == "tool_use":
                            tool_calls.append({
                                "id": block.get("id"),
                                "type": "function",
                                "function": {
                                    "name": block.get("name"),
                                    "arguments": json.dumps(block.get("input", {})),
                                }
                            })
                    messages.append({
                        "role": "assistant",
                        "content": "".join(text_parts) if text_parts else None,
                        "tool_calls": tool_calls if tool_calls else None,
                    })

                # Execute tool calls
                tool_results = []
                for block in response.get("content", []):
                    if block.get("type") == "tool_use":
                        tool_call_id = block.get("id")
                        tool_name = block.get("name")
                        tool_input = block.get("input", {})

                        if tool_name == "execute_python_code":
                            reasoning = tool_input.get("reasoning", "")
                            code = tool_input.get("code", "")

                            # Emit thought with reasoning. Guard whitespace-only
                            # reasoning (small models) so the step isn't blank —
                            # fall back to a short summary of the code.
                            thought = reasoning.strip() if isinstance(reasoning, str) else ""
                            if not thought:
                                from ccie_sidecar.agents.deepagents_stream import _describe_tool_calls
                                thought = _describe_tool_calls([
                                    {"name": "execute_python_code", "args": {"code": code}}
                                ])
                            on_event({
                                "type": "thought_start",
                                "step": step,
                                "thought": thought,
                            })

                            # Emit tool call event
                            on_event({
                                "type": "tool_call",
                                "name": tool_name,
                                "args": {"code": code},
                            })

                            # Execute code
                            result = _execute_code_with_timeout(
                                code,
                                sandbox_globals,
                                timeout=30,
                                env_overrides=env_overrides,
                                label=cli_package or "react_code",
                            )

                            success = result.get("success", False)
                            output = result.get("output", "")
                            error = result.get("error", "")

                            result_str = output if success else f"Error: {error}"
                            # Cap what we feed back so an unbounded print (e.g.
                            # os.walk) can't blow past the model's context window.
                            result_str = _truncate_output(result_str)

                            # Emit result event
                            on_event({
                                "type": "tool_result",
                                "success": success,
                                "result": result_str,
                            })

                            # Add to conversation
                            if provider == "anthropic":
                                tool_results.append({
                                    "type": "tool_result",
                                    "tool_use_id": tool_call_id,
                                    "content": result_str,
                                })
                            else:
                                tool_results.append({
                                    "role": "tool",
                                    "tool_call_id": tool_call_id,
                                    "name": tool_name,
                                    "content": result_str,
                                })
                        elif tool_name == "search_api_catalog" and catalog_index is not None:
                            query = str(tool_input.get("query", ""))
                            catalog_id = str(tool_input.get("catalog_id", ""))
                            limit = tool_input.get("limit", 5)
                            on_event({
                                "type": "thought_start",
                                "step": step,
                                "thought": f"Searching {catalog_id} API catalog for {query}",
                            })
                            on_event({
                                "type": "tool_call",
                                "name": tool_name,
                                "args": {
                                    "query": query,
                                    "catalog_id": catalog_id,
                                    "limit": limit,
                                },
                            })
                            try:
                                search_result = catalog_index.search(
                                    query,
                                    catalog_id=catalog_id,
                                    limit=limit,
                                )
                                success = True
                                result_str = json.dumps(
                                    search_result,
                                    ensure_ascii=False,
                                    default=str,
                                )
                            except Exception as exc:
                                success = False
                                result_str = f"Error: {type(exc).__name__}: {exc}"
                            result_str = _truncate_output(result_str)
                            on_event({
                                "type": "tool_result",
                                "success": success,
                                "result": result_str,
                            })
                            if provider == "anthropic":
                                tool_results.append({
                                    "type": "tool_result",
                                    "tool_use_id": tool_call_id,
                                    "content": result_str,
                                    **({"is_error": True} if not success else {}),
                                })
                            else:
                                tool_results.append({
                                    "role": "tool",
                                    "tool_call_id": tool_call_id,
                                    "name": tool_name,
                                    "content": result_str,
                                })

                # Add tool results to messages
                if provider == "anthropic":
                    messages.append({"role": "user", "content": tool_results})
                else:
                    messages.extend(tool_results)

                # Continue loop
                continue

            # max_tokens: the model's reply was truncated mid-generation. Surface
            # whatever text/tool intent we got plus an actionable hint instead of
            # aborting with a cryptic "unexpected stop reason".
            if response.get("stop_reason") == "max_tokens":
                partial = "".join(
                    block.get("text", "")
                    for block in response.get("content", [])
                    if block.get("type") == "text"
                )
                msg = (
                    "Response hit the token limit before finishing. "
                    "Try narrowing the task (e.g. diagram fewer devices, or ask "
                    "for the diagram directly without extra exploration)."
                )
                on_event({
                    "type": "final",
                    "response": (partial + "\n\n" + msg) if partial.strip() else msg,
                })
                distill_and_store(on_event, cli_package, user_msg)
                return

            # Unexpected stop reason
            on_event({
                "type": "error",
                "message": f"Unexpected stop reason: {response.get('stop_reason')}",
            })
            return

        # Max steps reached
        on_event({
            "type": "error",
            "message": f"Maximum steps ({MAX_STEPS}) reached",
        })

    except Exception as e:
        on_event({
            "type": "error",
            "message": f"ReACT-Code loop failed: {str(e)}",
        })
