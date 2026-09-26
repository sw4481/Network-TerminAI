-- Transit rank 6: organized saved-SSH inventory.

CREATE TABLE ssh_folders (
    id TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES ssh_folders(id),
    name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 64),
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO ssh_folders(id, parent_id, name, position)
VALUES ('root', NULL, 'All Devices', 0);

CREATE UNIQUE INDEX idx_ssh_folders_sibling_name
    ON ssh_folders(COALESCE(parent_id, ''), lower(name));
CREATE INDEX idx_ssh_folders_parent_position
    ON ssh_folders(parent_id, position, name COLLATE NOCASE);

-- SQLite cannot add a REFERENCES column with a non-NULL default to an existing
-- table. Command validation enforces the folder relationship for all writes.
ALTER TABLE ssh_connections ADD COLUMN folder_id TEXT NOT NULL DEFAULT 'root';
ALTER TABLE ssh_connections ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ssh_connections ADD COLUMN accent_color TEXT
    CHECK(accent_color IS NULL OR accent_color IN ('blue','cyan','green','amber','orange','red','purple','pink'));
ALTER TABLE ssh_connections ADD COLUMN vendor TEXT NOT NULL DEFAULT 'generic'
    CHECK(vendor IN ('cisco','juniper','arista','meraki','generic'));
ALTER TABLE ssh_connections ADD COLUMN platform TEXT NOT NULL DEFAULT 'generic';

CREATE INDEX idx_ssh_connections_folder ON ssh_connections(folder_id, name COLLATE NOCASE);
CREATE INDEX idx_ssh_connections_vendor_platform ON ssh_connections(vendor, platform);
