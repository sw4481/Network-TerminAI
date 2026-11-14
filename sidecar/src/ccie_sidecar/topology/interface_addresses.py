"""Unique default-VRF IPv4 subnet evidence; never physical cable resolution."""
from dataclasses import dataclass
from ipaddress import IPv4Interface, IPv4Address
import re


@dataclass(frozen=True)
class InterfaceAddress:
    interface: str
    address: IPv4Interface


class InterfaceAddressEvidence:
    command = "show ip interface"

    def __init__(self, envelope: dict):
        if not isinstance(envelope, dict) or envelope.get("parser") != "genie":
            raise ValueError("interface evidence requires Genie")
        data = envelope.get("data")
        if not isinstance(data, dict) or not data or len(data) > 2000:
            raise ValueError("invalid interface evidence")
        self.addresses = []
        for name, row in data.items():
            if not isinstance(name, str) or not name or len(name) > 256 or not isinstance(row, dict):
                raise ValueError("invalid interface row")
            # Unnumbered, loopback and tunnel ownership cannot establish a link interface.
            if re.match(r"^(?:lo(?:opback)?|tu(?:nnel)?|nu(?:ll)?)\s*\d", name, re.IGNORECASE) or row.get("vrf", "default") != "default":
                continue
            if row.get("enabled") is not True or row.get("oper_status") != "up":
                continue
            ipv4 = row.get("ipv4", {})
            if not isinstance(ipv4, dict) or len(ipv4) > 2000:
                raise ValueError("invalid interface addresses")
            for entry in ipv4.values():
                if not isinstance(entry, dict):
                    raise ValueError("invalid interface address")
                prefix = entry.get("prefix_length")
                if prefix is None:
                    continue  # Genie unnumbered/DHCP projection has no prefix ownership.
                if isinstance(prefix, bool) or not str(prefix).isdigit() or not 1 <= int(prefix) <= 32:
                    raise ValueError("invalid interface prefix")
                address = IPv4Interface(f"{entry.get('ip')}/{prefix}")
                self.addresses.append(InterfaceAddress(name, address))
                if len(self.addresses) > 2000:
                    raise ValueError("interface evidence limit")

    def associate(self, record: dict) -> None:
        routing = record.get("routing")
        if not isinstance(routing, dict) or routing.get("established") is not True or routing.get("scope_supported") is not True:
            return
        if routing.get("vrf") != "default" or routing.get("address_family") != "ipv4 unicast":
            return
        try:
            peer = IPv4Address(routing.get("peer_address"))
        except (ValueError, TypeError):
            return
        if peer.is_unspecified or peer.is_multicast or peer.is_loopback or any(peer == row.address.ip for row in self.addresses):
            return
        candidates = [row for row in self.addresses if peer in row.address.network and
                      (row.address.network.prefixlen >= 31 or peer not in (row.address.network.network_address, row.address.network.broadcast_address))]
        if len(candidates) != 1:
            return  # Includes overlapping prefixes and duplicate address owners.
        owner = candidates[0]
        if record.get("local_port") and record["local_port"] != owner.interface:
            return
        routing["interface_association"] = {
            "interface": owner.interface,
            "local_address": str(owner.address.ip),
            "prefix_length": owner.address.network.prefixlen,
            "source_command": self.command,
            "relationship": "same_subnet_unverified",
        }
