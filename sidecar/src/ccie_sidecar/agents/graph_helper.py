"""Context-graph helper for the code-execution sandbox.

Gives EVERY agent a queryable, read-only view of the network graph the app
already builds — topology neighbors, per-device config/drift, related knowledge
-base docs — plus the entity/relationship overlay (tables from migration V0071).
Reads the same ``sessions.db`` used by proxmox_api.config, so there is no
per-agent attachment and no lock/unlock step.

Gated by the master ``CCIE_CONTEXT_GRAPH`` flag: ``install_graph`` is a no-op
when the feature is off, so disabling it removes the helper from the sandbox
entirely (rollback lever). All queries fail soft — a missing table (feature
tables not yet migrated) or empty result returns ``{ok: True, ...: []}`` rather
than raising, so agent code never crashes on a cold database.

It also provides temporal memory (migration V0072): facts about entities that
supersede rather than delete, and recorded decisions with rationale — so an
agent can recall "what do we know about R1" and "why was this changed" across
sessions, on any LLM provider.

Exposed to agent code as a pre-imported ``graph`` object:

    graph.find_entity("R1")            -> {ok, matches:[{entity_id, label, ...}]}
    graph.neighbors("R1")              -> {ok, device, neighbors:[{...}]}
    graph.entity_context("R1")         -> {ok, device, config, drift, relations}
    graph.search("OSPF stub area")     -> {ok, results:[{doc, snippet}]}
    graph.record_fact("R1", "bgp_state", "established")
    graph.query_facts("R1")            -> {ok, facts:[{key, value, valid_from, valid_to}]}
    graph.record_decision(ctx, what, why, entities=["R1"])
    graph.recall("hold timer")         -> {ok, decisions:[...]}
"""
from __future__ import annotations

import os
import sqlite3
import sys
import types
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional


def _db_path() -> Path:
    if os.name == "nt":
        config_dir = Path(os.environ.get("APPDATA", "")) / "ccie-terminal"
    elif os.uname().sysname == "Darwin":
        config_dir = Path.home() / "Library" / "Application Support" / "ccie-terminal"
    else:
        config_dir = Path.home() / ".config" / "ccie-terminal"
    return config_dir / "sessions.db"


def _staleness_secs() -> int:
    """Fact staleness window; delegates to feature_flags, 2h fallback."""
    try:
        from ccie_sidecar.feature_flags import staleness_secs
        return staleness_secs()
    except Exception:
        return 7200


def _is_pinned(metadata: Any) -> bool:
    """True if a fact's metadata JSON marks it pinned ('remember forever').

    Pinned facts are exempt from the staleness window. Tolerates None, dict, or
    a JSON string (sqlite stores TEXT).
    """
    if not metadata:
        return False
    try:
        import json as _json
        m = metadata if isinstance(metadata, dict) else _json.loads(metadata)
        return bool(m.get("pinned"))
    except Exception:
        return False


# Memory-first directive placed in the SAME channel as the vendor "your ONLY way
# to reach X" instructions (the execute_python_code tool description). The KNOWN
# FACTS index lives in the system prompt as a conditional and lost to the
# vendor's imperative-with-example; this states the rule imperatively, right
# above the vendor lines, so it competes on equal footing.
MEMORY_FIRST_PREAMBLE = (
    "- MEMORY-FIRST: Facts learned in prior sessions may be available EITHER as a "
    "KNOWN FACTS INDEX in your instructions OR as an ESTABLISHED CONTEXT block "
    "earlier in this conversation. BEFORE calling any vendor `*_api_call`, check "
    "both: if a fresh fact already answers the question, print/use that value and "
    "DO NOT make the vendor call. Call the vendor live ONLY when the needed fact "
    "is missing, or the user explicitly wants a fresher/re-checked value.\n"
    "- USE STORED IDs AS SHORTCUTS: if the INDEX has a resolved identifier (a "
    "network_id, org_id, device serial) for the named entity, use it DIRECTLY in "
    "the next call and SKIP the discovery crawl. E.g. if 'example-branch: network_id "
    "= L_123' is known, call meraki_api_call('GET', '/networks/L_123/devices') "
    "immediately — do NOT re-list /organizations then /networks to re-find the id."
)


def memory_first_preamble() -> str:
    """The memory-first line when the context-graph feature is on, else "".

    Gated exactly like graph_sandbox_blurb_suffix so the tool description is
    byte-identical to before when the flag is off.
    """
    try:
        from ccie_sidecar.feature_flags import context_graph_enabled
        return MEMORY_FIRST_PREAMBLE if context_graph_enabled() else ""
    except Exception:
        return ""


def known_facts_note(user_msg: str, max_entities: int = 40, max_facts: int = 120) -> str:
    """Return a compact INDEX of everything currently known, for the prompt.

    Index-driven recall (per Karpathy's "LLM wiki" idea): instead of trying to
    string-match the question to stored facts — which is brittle ("secure
    endpoint" != stored `secure_endpoint`, natural phrasing misses) — we inject
    the whole fresh-fact index and let the MODEL decide what's relevant. At this
    scale (a handful of entities) that's cheap and eliminates the matching
    problem entirely. Returns "" only when there is genuinely nothing stored, so
    a fresh DB still adds zero tokens.

    Only CURRENT (valid_to IS NULL), non-stale facts are included. `value` is
    clipped so a bulk blob can't blow up the prompt.
    """
    try:
        db = _db_path()
        if not db.exists():
            return ""
        conn = sqlite3.connect(str(db), timeout=3.0)
        conn.row_factory = sqlite3.Row
        try:
            window = _staleness_secs()
            now = int(conn.execute("SELECT strftime('%s','now')").fetchone()[0])
            # Relevance-first ordering: once the store holds many entities (e.g.
            # 40+ meraki networks/devices), pure recency can bury the entity the
            # question is actually about below unrelated fresh facts and push it
            # past the LIMIT. So float facts whose entity name matches a token in
            # the question to the top; recency breaks ties. Tokens are the
            # alphanumeric words of the question, length>=3, lowercased.
            import re as _re
            tokens = [t for t in _re.split(r"[^a-z0-9]+", (user_msg or "").lower()) if len(t) >= 3]
            def _relevance(entity: str) -> int:
                # Match against the entity-SPECIFIC part only. Entities are keyed
                # "<scope>:<kind>:<name>" (e.g. "meraki:network:example-branch"); the
                # scope/kind words ("meraki", "network") appear on every entity,
                # so counting them would flatten the signal. Score on the last
                # segment (the name) so "example-branch" beats unrelated networks.
                name = entity.lower().rsplit(":", 1)[-1]
                return 1 if any(t in name for t in tokens) else 0
            # Group fresh facts by entity, most-relevant then newest first.
            by_entity: "collections.OrderedDict[str, List[str]]" = __import__(
                "collections"
            ).OrderedDict()
            _all_rows = conn.execute(
                "SELECT entity, key, value, valid_from, metadata FROM graph_facts "
                "WHERE valid_to IS NULL ORDER BY valid_from DESC"
            ).fetchall()
            _all_rows.sort(key=lambda r: _relevance(r["entity"]), reverse=True)
            for row in _all_rows[:max_facts]:
                if not _is_pinned(row["metadata"]):
                    age = now - int(row["valid_from"] or now)
                    if age > window:
                        continue  # stale — omit so the agent re-fetches live
                # pinned facts are exempt from the staleness window (remember-forever)
                ent = row["entity"]
                if ent not in by_entity:
                    if len(by_entity) >= max_entities:
                        continue
                    by_entity[ent] = []
                val = str(row["value"])
                if len(val) > 200:
                    val = val[:200] + "…"
                by_entity[ent].append(f"    - {row['key']}: {val}")
            if not by_entity:
                return ""
            lines: List[str] = []
            for ent, facts in by_entity.items():
                lines.append(f"  {ent}:")
                lines.extend(facts)
            return (
                "\n\nKNOWN FACTS INDEX (persistent memory from prior sessions). "
                "If the user's question is about any entity below and the fact "
                "answers it, USE the stored value instead of making a live/vendor "
                "call. Re-fetch live only if you need a fresher value or the fact "
                "is missing. Entities may be referenced by name, IP, hostname, or "
                "nickname — match loosely.\n"
                + "\n".join(lines)
            )
        finally:
            conn.close()
    except Exception:
        return ""  # never break the loop over recall


class GraphHelper:
    """Sandbox-facing read-only context-graph helper."""

    def _connect(self) -> Optional[sqlite3.Connection]:
        db = _db_path()
        if not db.exists():
            return None
        try:
            conn = sqlite3.connect(str(db), timeout=5.0)
            conn.row_factory = sqlite3.Row
            return conn
        except Exception:
            return None

    # -- input coercion / identity bridging ------------------------------

    @staticmethod
    def _coerce_ref(value: Any) -> str:
        """Coerce a caller argument into a device_ref string.

        Agents frequently pass the whole find_entity() result, a single match
        dict, or an entity_id like 'ssh:device.example.test' instead of the bare ref.
        Accept all of those gracefully instead of crashing on .strip().
        """
        if value is None:
            return ""
        if isinstance(value, str):
            return value.strip()
        if isinstance(value, dict):
            # find_entity() result envelope -> first match
            if isinstance(value.get("matches"), list) and value["matches"]:
                return GraphHelper._coerce_ref(value["matches"][0])
            for k in ("device_ref", "mgmt_ip", "label", "device", "host", "name"):
                if value.get(k):
                    return str(value[k]).strip()
            ent = value.get("entity_id")
            if ent:  # 'ssh:device.example.test' -> 'device.example.test'
                return str(ent).split(":", 1)[-1].strip()
        if isinstance(value, list) and value:
            return GraphHelper._coerce_ref(value[0])
        return str(value).strip()

    def _aliases_for(self, conn: sqlite3.Connection, ref: str) -> List[str]:
        """Return every known alias of a device (IP, hostname, label).

        Topology edges are keyed by whatever name CDP/LLDP reported (often the
        hostname, e.g. 'Onprem01'), while a user asks by mgmt IP ('device.example.test').
        This bridges the two so neighbors()/entity_context() work regardless of
        which identifier the caller used.
        """
        aliases = {ref}
        for sql in (
            "SELECT host, name FROM ssh_connections WHERE host = ? OR name = ?",
            "SELECT host, name FROM netconf_devices WHERE host = ? OR name = ?",
        ):
            try:
                for row in conn.execute(sql, (ref, ref)):
                    for v in (row[0], row[1]):
                        if v:
                            aliases.add(str(v))
            except sqlite3.Error:
                continue
        try:
            for row in conn.execute(
                "SELECT device_ref, label, mgmt_ip FROM topology_nodes "
                "WHERE device_ref = ? OR label = ? OR mgmt_ip = ?",
                (ref, ref, ref),
            ):
                for v in (row["device_ref"], row["label"], row["mgmt_ip"]):
                    if v:
                        aliases.add(str(v))
        except sqlite3.Error:
            pass
        return [a for a in aliases if a]

    # -- entity resolution ------------------------------------------------

    def find_entity(self, query: str) -> Dict[str, Any]:
        """Resolve a name / hostname / mgmt IP to matching device entities.

        Searches topology_nodes, ssh_connections, and netconf_devices (the
        ad-hoc join sources), de-duplicated by device_ref.
        """
        q = (query or "").strip()
        if not q:
            return {"ok": False, "matches": [], "error": "empty query"}
        conn = self._connect()
        if conn is None:
            return {"ok": True, "matches": [], "error": None}
        like = f"%{q}%"
        matches: Dict[str, Dict[str, Any]] = {}
        try:
            for sql, params in (
                (
                    "SELECT device_ref, device_kind, label, vendor, platform, mgmt_ip "
                    "FROM topology_nodes WHERE device_ref LIKE ? OR label LIKE ? OR mgmt_ip LIKE ?",
                    (like, like, like),
                ),
                (
                    "SELECT host AS device_ref, 'ssh' AS device_kind, name AS label, "
                    "NULL AS vendor, NULL AS platform, host AS mgmt_ip "
                    "FROM ssh_connections WHERE host LIKE ? OR name LIKE ?",
                    (like, like),
                ),
                (
                    "SELECT host AS device_ref, 'netconf' AS device_kind, name AS label, "
                    "NULL AS vendor, platform, host AS mgmt_ip "
                    "FROM netconf_devices WHERE host LIKE ? OR name LIKE ?",
                    (like, like),
                ),
            ):
                try:
                    for row in conn.execute(sql, params):
                        ref = row["device_ref"]
                        key = f"{row['device_kind']}:{ref}"
                        if key not in matches:
                            matches[key] = {
                                "entity_id": key,
                                "device_ref": ref,
                                "device_kind": row["device_kind"],
                                "label": row["label"] or ref,
                                "vendor": row["vendor"],
                                "platform": row["platform"],
                                "mgmt_ip": row["mgmt_ip"],
                            }
                except sqlite3.Error:
                    continue  # table absent — skip that source
        finally:
            conn.close()
        self._materialize(list(matches.values()))
        return {"ok": True, "matches": list(matches.values()), "error": None}

    # -- topology traversal ----------------------------------------------

    def neighbors(
        self, device_ref: str, protocol: Optional[str] = None, depth: int = 1
    ) -> Dict[str, Any]:
        """Return adjacent devices/links for a device from topology_edges.

        depth=1 returns direct neighbors; depth>1 does a breadth-first walk.
        """
        ref = self._coerce_ref(device_ref)
        if not ref:
            return {"ok": False, "device": ref, "neighbors": [], "error": "empty device_ref"}
        conn = self._connect()
        if conn is None:
            return {"ok": True, "device": ref, "neighbors": [], "error": None}
        try:
            depth = max(1, min(int(depth), 4))
        except (TypeError, ValueError):
            depth = 1

        # Seed the walk with EVERY alias of the requested device, so a query by
        # mgmt IP still matches edges keyed by hostname (and vice versa).
        aliases = self._aliases_for(conn, ref)
        seen: set[str] = set(aliases)
        frontier: List[str] = list(aliases)
        collected: List[Dict[str, Any]] = []
        try:
            for _ in range(depth):
                next_frontier: List[str] = []
                for node in frontier:
                    sql = (
                        "SELECT a_device_ref, a_port, b_device_ref, b_port, protocol, captured_at "
                        "FROM topology_edges WHERE (a_device_ref = ? OR b_device_ref = ?)"
                    )
                    params: List[Any] = [node, node]
                    if protocol:
                        sql += " AND protocol = ?"
                        params.append(protocol)
                    try:
                        rows = conn.execute(sql, tuple(params)).fetchall()
                    except sqlite3.Error:
                        rows = []
                    for row in rows:
                        # Orient the edge so 'node' is the local side.
                        if row["a_device_ref"] == node:
                            other, local_port, remote_port = row["b_device_ref"], row["a_port"], row["b_port"]
                        else:
                            other, local_port, remote_port = row["a_device_ref"], row["b_port"], row["a_port"]
                        collected.append({
                            "from": node,
                            "local_port": local_port,
                            "neighbor": other,
                            "neighbor_port": remote_port,
                            "protocol": row["protocol"],
                            "captured_at": row["captured_at"],
                        })
                        if other not in seen:
                            seen.add(other)
                            next_frontier.append(other)
                frontier = next_frontier
                if not frontier:
                    break
        finally:
            conn.close()
        return {"ok": True, "device": ref, "neighbors": collected, "error": None}

    # -- one-shot device context -----------------------------------------

    def entity_context(self, device_ref: str) -> Dict[str, Any]:
        """Assemble everything the graph knows about a device in one call:
        latest config snapshot, open/recent drift, and overlay relations.
        """
        ref = self._coerce_ref(device_ref)
        if not ref:
            return {"ok": False, "device": ref, "error": "empty device_ref"}
        conn = self._connect()
        if conn is None:
            return {"ok": True, "device": ref, "config": None, "drift": [], "relations": [], "error": None}
        config: Optional[Dict[str, Any]] = None
        drift: List[Dict[str, Any]] = []
        relations: List[Dict[str, Any]] = []
        try:
            # config/drift/relations may be keyed by IP or hostname — match any alias.
            aliases = self._aliases_for(conn, ref)
            ph = ",".join("?" for _ in aliases)
            try:
                row = conn.execute(
                    f"SELECT id, vendor, platform, label, source, captured_at "
                    f"FROM config_snapshots WHERE device_id IN ({ph}) "
                    f"ORDER BY captured_at DESC LIMIT 1",
                    tuple(aliases),
                ).fetchone()
                if row:
                    config = {k: row[k] for k in row.keys()}
            except sqlite3.Error:
                pass
            try:
                for row in conn.execute(
                    f"SELECT id, status, severity, captured_at FROM drift_reports "
                    f"WHERE device_id IN ({ph}) ORDER BY captured_at DESC LIMIT 5",
                    tuple(aliases),
                ):
                    drift.append({k: row[k] for k in row.keys()})
            except sqlite3.Error:
                pass
            try:
                for row in conn.execute(
                    f"SELECT subject, predicate, object, captured_at FROM entity_relations "
                    f"WHERE subject IN ({ph}) OR object IN ({ph}) ORDER BY captured_at DESC LIMIT 20",
                    tuple(aliases) + tuple(aliases),
                ):
                    relations.append({k: row[k] for k in row.keys()})
            except sqlite3.Error:
                pass
        finally:
            conn.close()
        return {"ok": True, "device": ref, "config": config, "drift": drift,
                "relations": relations, "error": None}

    # -- knowledge base keyword search -----------------------------------

    def search(self, query: str, limit: int = 5) -> Dict[str, Any]:
        """Keyword search over ingested RAG documents (chunk text LIKE match).

        This is the lightweight, provider-agnostic path available from the
        sandbox; full semantic (embedding) retrieval remains the app's RAG UI
        path. Returns doc title + matching snippet.
        """
        q = (query or "").strip()
        if not q:
            return {"ok": False, "results": [], "error": "empty query"}
        conn = self._connect()
        if conn is None:
            return {"ok": True, "results": [], "error": None}
        try:
            limit = max(1, min(int(limit), 20))
        except (TypeError, ValueError):
            limit = 5
        results: List[Dict[str, Any]] = []
        try:
            rows = conn.execute(
                "SELECT d.title AS title, d.source_path AS source_path, c.text AS text "
                "FROM rag_chunks c JOIN rag_documents d ON d.id = c.document_id "
                "WHERE c.text LIKE ? LIMIT ?",
                (f"%{q}%", limit),
            ).fetchall()
            for row in rows:
                text = row["text"] or ""
                results.append({
                    "doc": row["title"],
                    "source": row["source_path"],
                    "snippet": text[:400],
                })
        except sqlite3.Error:
            results = []
        finally:
            conn.close()
        return {"ok": True, "results": results, "error": None}

    # -- temporal memory: facts ------------------------------------------

    def record_fact(
        self, entity: str, key: str, value: str,
        metadata: Optional[Dict[str, Any]] = None, forever: bool = False,
    ) -> Dict[str, Any]:
        """Record a fact about an entity, superseding any current same-key fact.

        Temporal: the prior current fact (valid_to IS NULL) for this
        (entity, key) has its valid_to stamped instead of being deleted, so
        history is preserved. Entity is normalized to lowercase for matching.

        forever=True PINS the fact (metadata.pinned): it is exempt from the
        staleness window and stays available for recall indefinitely, until
        explicitly superseded. Use for durable identifiers the user asked to
        keep "forever/permanently/always" (org/network ids, serials, tenants).
        """
        ent = self._coerce_ref(entity).lower()
        k = (key or "").strip() if isinstance(key, str) else str(key or "").strip()
        if not ent or not k or value is None:
            return {"ok": False, "error": "entity, key and value are required"}
        if forever:
            metadata = {**(metadata or {}), "pinned": True}
        conn = self._connect()
        if conn is None:
            return {"ok": False, "error": "database unavailable"}
        import json as _json
        try:
            now = self._now(conn)
            # Ensure valid_from strictly increases per (entity, key) so rapid
            # same-second writes don't collide on UNIQUE(entity, key, valid_from).
            prev_from = conn.execute(
                "SELECT MAX(valid_from) FROM graph_facts WHERE entity = ? AND key = ?",
                (ent, k),
            ).fetchone()[0]
            new_from = now if prev_from is None else max(now, int(prev_from) + 1)
            # Supersede the current fact: its valid_to meets the new fact's
            # valid_from, giving a clean, gap-free timeline.
            conn.execute(
                "UPDATE graph_facts SET valid_to = ? "
                "WHERE entity = ? AND key = ? AND valid_to IS NULL",
                (new_from, ent, k),
            )
            conn.execute(
                "INSERT INTO graph_facts (entity, key, value, metadata, valid_from, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (ent, k, str(value), _json.dumps(metadata) if metadata else None, new_from, now),
            )
            conn.commit()
            return {"ok": True, "entity": ent, "key": k, "value": str(value), "error": None}
        except sqlite3.Error as e:
            return {"ok": False, "error": str(e)}
        finally:
            conn.close()

    def remember(self, entity: str, key: str, value: str,
                 metadata: Optional[Dict[str, Any]] = None,
                 forever: bool = False) -> Dict[str, Any]:
        """Friendly alias for record_fact — remember ANY fact about ANY entity.

        Works for a client IP, a device hostname, a VLAN, a doc topic — anything
        the agent learns and should recall later. Same supersede semantics.
        forever=True pins the fact so it never goes stale (see record_fact).
        """
        return self.record_fact(entity, key, value, metadata=metadata, forever=forever)

    def query_facts(self, entity: str, include_history: bool = False) -> Dict[str, Any]:
        """Return facts for an entity. Current only unless include_history=True."""
        ref = self._coerce_ref(entity)
        if not ref:
            return {"ok": False, "facts": [], "error": "empty entity"}
        conn = self._connect()
        if conn is None:
            return {"ok": True, "facts": [], "error": None}
        facts: List[Dict[str, Any]] = []
        try:
            # A fact recorded under one alias (e.g. the mgmt IP) is recallable by
            # any other (e.g. the hostname). Resolve aliases on the ORIGINAL case
            # (device tables are case-sensitive), then lowercase for the match
            # since facts are stored lowercased.
            aliases = {a.lower() for a in self._aliases_for(conn, ref)} | {ref.lower()}
            ph = ",".join("?" for _ in aliases)
            sql = (
                f"SELECT entity, key, value, metadata, valid_from, valid_to "
                f"FROM graph_facts WHERE entity IN ({ph})"
            )
            if not include_history:
                sql += " AND valid_to IS NULL"
            sql += " ORDER BY key, valid_from DESC"
            now = self._now(conn)
            window = _staleness_secs()
            for row in conn.execute(sql, tuple(aliases)):
                f = {k: row[k] for k in row.keys()}
                # Age + staleness so the agent knows whether to trust memory or
                # re-pull live. Based on valid_from (when the fact was recorded).
                try:
                    age = max(0, now - int(f.get("valid_from") or now))
                except (TypeError, ValueError):
                    age = 0
                f["age_seconds"] = age
                # Pinned facts ("remember forever") never go stale.
                pinned = _is_pinned(f.get("metadata"))
                f["pinned"] = pinned
                f["stale"] = (not pinned) and age > window
                facts.append(f)
        except sqlite3.Error:
            facts = []
        finally:
            conn.close()
        # Convenience flags so the model can branch without recomputing.
        any_fresh = any(not f.get("stale") for f in facts)
        return {"ok": True, "facts": facts, "any_fresh": any_fresh,
                "staleness_window_secs": _staleness_secs(), "error": None}

    # -- temporal memory: decisions --------------------------------------

    def record_decision(
        self,
        context: str,
        decision: str,
        rationale: str,
        entities: Optional[List[str]] = None,
        cr_ref: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Record an operational decision (context + what + why) for later recall."""
        if not (context and decision and rationale):
            return {"ok": False, "error": "context, decision and rationale are required"}
        conn = self._connect()
        if conn is None:
            return {"ok": False, "error": "database unavailable"}
        import json as _json
        ents = [str(e).strip().lower() for e in (entities or []) if str(e).strip()]
        try:
            conn.execute(
                "INSERT INTO graph_decisions (context, decision, rationale, entities_json, cr_ref) "
                "VALUES (?, ?, ?, ?, ?)",
                (context, decision, rationale, _json.dumps(ents), cr_ref),
            )
            conn.commit()
            return {"ok": True, "error": None}
        except sqlite3.Error as e:
            return {"ok": False, "error": str(e)}
        finally:
            conn.close()

    def recall(self, query: str, limit: int = 5) -> Dict[str, Any]:
        """Recall past decisions relevant to a query (keyword over context/decision/rationale).

        Provider-agnostic keyword recall from the sandbox; the app's semantic
        (embedding) path remains the RAG UI. Returns most-recent-first matches.
        """
        q = (query or "").strip()
        if not q:
            return {"ok": False, "decisions": [], "error": "empty query"}
        conn = self._connect()
        if conn is None:
            return {"ok": True, "decisions": [], "error": None}
        try:
            limit = max(1, min(int(limit), 20))
        except (TypeError, ValueError):
            limit = 5
        decisions: List[Dict[str, Any]] = []
        like = f"%{q}%"
        try:
            for row in conn.execute(
                "SELECT context, decision, rationale, entities_json, cr_ref, created_at "
                "FROM graph_decisions "
                "WHERE context LIKE ? OR decision LIKE ? OR rationale LIKE ? OR entities_json LIKE ? "
                "ORDER BY created_at DESC LIMIT ?",
                (like, like, like, like, limit),
            ):
                decisions.append({k: row[k] for k in row.keys()})
        except sqlite3.Error:
            decisions = []
        finally:
            conn.close()
        return {"ok": True, "decisions": decisions, "error": None}

    @staticmethod
    def _now(conn: sqlite3.Connection) -> int:
        """Unix seconds from SQLite so timestamps match DEFAULT (strftime) rows."""
        return int(conn.execute("SELECT strftime('%s','now')").fetchone()[0])

    # -- overlay materialization -----------------------------------------

    def _materialize(self, entities: List[Dict[str, Any]]) -> None:
        """Best-effort upsert of resolved devices into the `entities` overlay.

        Fails silently: the overlay is a cache, not the source of truth, and a
        locked DB or absent table must never break a read-only agent query.
        """
        if not entities:
            return
        conn = self._connect()
        if conn is None:
            return
        import json
        try:
            for e in entities:
                try:
                    conn.execute(
                        "INSERT INTO entities (entity_id, kind, device_ref, label, vendor, platform, mgmt_ip, sources, updated_at) "
                        "VALUES (?, 'device', ?, ?, ?, ?, ?, ?, strftime('%s','now')) "
                        "ON CONFLICT(entity_id) DO UPDATE SET "
                        "label=excluded.label, vendor=excluded.vendor, platform=excluded.platform, "
                        "mgmt_ip=excluded.mgmt_ip, updated_at=excluded.updated_at",
                        (
                            e["entity_id"], e["device_ref"], e["label"], e.get("vendor"),
                            e.get("platform"), e.get("mgmt_ip"),
                            json.dumps([e["device_kind"]]),
                        ),
                    )
                except sqlite3.Error:
                    continue
            conn.commit()
        except sqlite3.Error:
            pass
        finally:
            conn.close()

    def help(self) -> str:
        return (
            "graph.find_entity(query) -> {ok, matches:[{entity_id, device_ref, label, vendor, platform}]}; "
            "graph.neighbors(device_ref, protocol=None, depth=1) -> {ok, neighbors:[{neighbor, local_port, neighbor_port, protocol}]}; "
            "graph.entity_context(device_ref) -> {ok, config, drift, relations}; "
            "graph.search(query, limit=5) -> {ok, results:[{doc, snippet}]} (keyword search over knowledge base); "
            "graph.remember(entity, key, value) -> persist a fact about ANYTHING (client IP, device, vlan, topic); "
            "graph.query_facts(entity) -> {ok, facts:[{key, value, age_seconds, stale}], any_fresh, staleness_window_secs}; "
            "graph.record_decision(context, decision, rationale, entities=None, cr_ref=None) -> record the WHY; "
            "graph.recall(query, limit=5) -> {ok, decisions:[...]} past decisions by keyword. "
            "Use find_entity first to resolve a name, then neighbors/entity_context with the device_ref. "
            "Record a fact when you learn a device state, and a decision when a change is approved."
        )


def install_graph(
    globals_dict: Dict[str, Any],
    emit: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> "GraphHelper":
    """Register a `graph` helper as a sandbox global AND an importable module.

    Mirrors install_drawio/install_proxmox. `emit` is accepted for signature
    parity (the graph helper streams no events).
    """
    helper = GraphHelper()
    globals_dict["graph"] = helper

    module = types.ModuleType("graph")
    module.find_entity = helper.find_entity
    module.neighbors = helper.neighbors
    module.entity_context = helper.entity_context
    module.search = helper.search
    module.record_fact = helper.record_fact
    module.remember = helper.remember
    module.query_facts = helper.query_facts
    module.record_decision = helper.record_decision
    module.recall = helper.recall
    module.help = helper.help
    module.graph = helper
    sys.modules["graph"] = module

    return helper
