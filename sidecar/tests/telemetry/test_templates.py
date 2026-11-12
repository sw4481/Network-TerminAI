"""Offline, pinned public formats. These are not authorized lab captures."""
import hashlib
import io
import json
from pathlib import Path
import textfsm
import yaml

ROOT = Path(__file__).resolve().parents[3]
ASSETS = ROOT / "src-tauri/telemetry"
FIXTURES = Path(__file__).parent / "fixtures"


def parse(template, raw):
    fsm = textfsm.TextFSM(io.StringIO((ASSETS / "templates" / template).read_text()))
    return [dict(zip((h.lower() for h in fsm.header), record)) for record in fsm.ParseText(raw)]


def test_required_panel_capture_matrix():
    catalog = json.loads((ASSETS / "catalog.json").read_text())
    widgets = yaml.safe_load((ASSETS / "widgets.yaml").read_text())["widgets"]
    manifest = json.loads((FIXTURES / "manifest.json").read_text())
    assert len(widgets) == 28
    assert {w["widget"] for w in widgets} == {p["widget"] for p in catalog["panels"]}
    for sample in manifest["samples"]:
        raw = (FIXTURES / sample["file"]).read_bytes()
        assert hashlib.sha256(raw).hexdigest() == sample["sha256"]
        records = parse(sample["template"], raw.decode())
        assert len(records) == sample["rows"]
        for field, value in sample["first"].items():
            assert records[0][field] == value, sample["file"]
    for asset in catalog["templates"]:
        text = (ASSETS / asset["path"]).read_bytes()
        assert hashlib.sha256(text).hexdigest() == asset["sha256"]
        assert asset["license"] == "Apache-2.0" or asset["license"] == "project-original"
        assert asset["source_url"].startswith("https://") or asset["source_url"] == "independently-authored"
    for w in widgets:
        if w["source"]["kind"] == "ssh":
            assert all((FIXTURES / s["file"]).is_file() for s in manifest["samples"])
            for platform, template_id in w["source"]["templates"].items():
                asset = next(a for a in catalog["templates"] if a["id"] == template_id)
                assert asset["platform"] == platform
                assert asset["command"] == w["source"]["commands"][platform]
                assert any(s["template"] == Path(asset["path"]).name for s in manifest["samples"])


def test_interface_bytes_are_cumulative_not_averaged_cli_rates():
    raw = (FIXTURES / "interfaces.raw").read_text()
    original = parse("cisco_ios_show_interfaces.textfsm", raw)
    counters = parse("ios_interface_bytes.textfsm", raw)
    assert "input_bytes" not in original[0]
    assert counters[0]["input_bytes"] == "48614"
    assert counters[0]["output_bytes"] == "62737"
    assert len(counters) == len(original) == 9


def test_switchport_mode_and_wrapped_vlan_tokens():
    records = parse("cisco_ios_show_interfaces_switchport.textfsm", (FIXTURES / "switchport.raw").read_text())
    assert records[0]["mode"] == "trunk"
    assert records[1]["mode"] == "static access"
    assert records[1]["trunking_vlans"] == ["ALL"]
    wrapped = parse("cisco_ios_show_interfaces_switchport.textfsm", (FIXTURES / "switchport_wrapped.raw").read_text())
    assert len(wrapped[0]["trunking_vlans"]) == 19
    assert wrapped[0]["trunking_vlans"][-1] == "940"


def test_routing_scope_gaps_and_phantom_detail_row_are_explicit():
    summary = parse("cisco_ios_show_ip_bgp_summary.textfsm", (FIXTURES / "bgp_summary.raw").read_text())
    assert len(summary) == 3 and "vrf" not in summary[0]
    peers = parse("cisco_ios_show_ip_bgp_vpnv4_all_neighbors.textfsm", (FIXTURES / "bgp_vrf.raw").read_text())
    repeated = [r for r in peers if r["neighbor"] == "192.0.2.1"]
    assert {r["vrf"] for r in repeated} == {"Client_A", "Client_B"}
    assert any(not r["neighbor"] for r in peers)
    assert "address_family" not in peers[0]


def test_empty_neighbors_do_not_prove_no_configuration():
    for name in ["cisco_ios_show_ip_bgp_summary.textfsm", "cisco_ios_show_ip_ospf_neighbor.textfsm", "cisco_ios_show_ip_eigrp_neighbors.textfsm"]:
        assert parse(name, "") == []
    # No pinned supported-empty capture exists: zero rows remain a parse-mismatch gate.
    assert json.loads((FIXTURES / "manifest.json").read_text())["supported_empty"] == []


def test_every_panel_alias_and_unit_is_grounded_in_its_actual_template():
    catalog = json.loads((ASSETS / "catalog.json").read_text())
    widgets = yaml.safe_load((ASSETS / "widgets.yaml").read_text())["widgets"]
    local_fields = {
        "local.cpu": {"core", "label", "usage", "logical_cores"},
        "local.memory": {"total_bytes", "available_bytes", "used_bytes", "swap_total_bytes", "swap_used_bytes"},
        "local.filesystems": {"mount", "filesystem", "total_bytes", "available_bytes", "used_bytes"},
        "local.network": {"interface", "received_bytes", "transmitted_bytes", "received_packets", "transmitted_packets", "received_errors", "transmitted_errors"},
        "local.processes": {"pid", "start_time", "name", "cpu_percent", "memory_bytes"},
    }
    for widget in widgets:
        source = widget["source"]
        if source["kind"] == "local":
            assert set(widget["fields"]) == local_fields[source["collector"]]
            headers = local_fields[source["collector"]]
        else:
            asset = next(a for a in catalog["templates"] if a["id"] == source["templates"]["ios"])
            fsm = textfsm.TextFSM(io.StringIO((ASSETS / asset["path"]).read_text()))
            headers = {h.lower() for h in fsm.header}
        for aliases in widget["fields"].values():
            assert aliases and all(alias.lower() in headers for alias in aliases), widget["widget"]
        available = set(widget["fields"]) | set(widget.get("rates", {})) | set(widget.get("computes", {}))
        assert all(c["field"] in available for c in widget["view"]["columns"])
    by_id = {w["widget"]: w for w in widgets}
    for widget_id, field, alias, unit in [
        ("cpu", "cpu_5s_percent", "cpu_usage_5_sec", "%"),
        ("memory", "total_bytes", "memory_total", "B"),
        ("interfaces", "input_cli_bit_s", "input_rate", "bit/s (CLI average)"),
        ("interfaces", "input_drops", "queue_drops", "packets"),
        ("interface_traffic", "input_bytes", "input_bytes", "B"),
        ("interface_traffic", "capacity_kbit_s", "capacity_kbit_s", "kbit/s"),
        ("bgp_peers", "prefixes_received", "state_or_prefixes_received", "prefixes"),
        ("eigrp_neighbors", "hold", "hold", "s"),
        ("eigrp_neighbors", "srtt", "srtt", "ms"),
        ("local_cpu", "usage", "usage", "%"),
        ("local_memory", "used_bytes", "used_bytes", "B"),
        ("local_filesystems", "available_bytes", "available_bytes", "B"),
        ("local_processes", "cpu_percent", "cpu_percent", "% of whole machine"),
        ("local_processes", "memory_bytes", "memory_bytes", "B"),
        ("local_network", "received_bytes", "received_bytes", "B"),
    ]:
        widget = by_id[widget_id]
        assert widget["fields"][field][0] == alias
        assert next(c["unit"] for c in widget["view"]["columns"] if c["field"] == field) == unit
    assert by_id["local_processes"]["key"] == ["pid", "start_time"]
    assert by_id["bgp_vrf_peers"]["key"] == ["vrf", "neighbor"]
    assert by_id["ospf_neighbors"]["key"] == ["neighbor", "address", "interface"]
    assert by_id["eigrp_neighbors"]["key"] == ["as_number", "neighbor", "interface"]


def test_explicit_cpu_memory_and_stp_values_from_public_raw_lines():
    cpu = parse("cisco_ios_show_processes_cpu.textfsm", (FIXTURES / "show_processes_cpu.raw").read_text())
    assert (cpu[0]["cpu_usage_5_sec"], cpu[0]["cpu_usage_1_min"], cpu[0]["cpu_usage_5_min"]) == ("4", "6", "5")
    assert cpu[0]["process_pid"] == "1" and cpu[0]["process_name"] == "Chunk Manager"
    memory = parse("cisco_ios_show_processes_memory_sorted.textfsm", (FIXTURES / "show_processes_memory_sorted.raw").read_text())
    assert (memory[0]["memory_total"], memory[0]["memory_used"], memory[0]["memory_free"]) == ("919638648", "236752096", "682886552")
    stp = parse("cisco_ios_show_spanning-tree.textfsm", (FIXTURES / "show_spanning-tree.raw").read_text())
    assert any(r["role"] == "Altn" and r["status"] == "BLK" for r in stp)


def test_full_interface_sample_retains_contradictory_duplicate_identity():
    raw = (FIXTURES / "interfaces.raw").read_text()
    for template in ["cisco_ios_show_interfaces.textfsm", "ios_interface_bytes.textfsm"]:
        records = parse(template, raw)
        assert [r["interface"] for r in records].count("GigabitEthernet0/2") == 2
    excerpt = (FIXTURES / "interfaces_one.raw").read_text()
    assert len(parse("ios_interface_bytes.textfsm", excerpt)) == 1
    assert len(parse("cisco_ios_show_interfaces.textfsm", excerpt)) == 1
