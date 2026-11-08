-- Graph/reference identity matches the single rendered node, not legacy node kind.
CREATE TABLE topology_node_positions (
    graph_id TEXT NOT NULL REFERENCES topology_graphs(id) ON DELETE CASCADE,
    device_ref TEXT NOT NULL,
    x REAL NOT NULL CHECK (x BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308),
    y REAL NOT NULL CHECK (y BETWEEN -1.7976931348623157e308 AND 1.7976931348623157e308),
    PRIMARY KEY (graph_id, device_ref)
);
