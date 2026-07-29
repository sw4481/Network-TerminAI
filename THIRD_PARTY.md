# Third-Party Prior Art & Attribution

This project contains clean-room implementations informed by publicly documented
techniques from other open-source projects. No source code is copied.

## Graph-compact serialization (`sidecar/src/ccie_sidecar/serialize/graph_compact.py`)

The idea of a token-efficient "graph/tabular compact format" for serializing
LLM tool responses (encoding arrays of uniform records as a header + CSV rows,
and node/edge data with local integer ids and edge arrows) is prior art in the
network-automation space, notably the **GCF (Graph Compact Format)** used by the
Apache-2.0 licensed **NetClaw** project
(https://github.com/automateyournetwork/netclaw).

Our implementation was written independently from the algorithm description; no
NetClaw source is included or derived. Apache-2.0 permits such reuse of ideas;
this note records the lineage.

## Context-graph memory model (`graph_facts` / `graph_decisions`, migration V0072)

The temporal-fact + decision-log schema shape (facts that supersede rather than
delete, decisions carrying context/rationale) is a common knowledge-graph
pattern also used by NetClaw's Memory MCP. Our schema, table names, and code are
original to this project.
