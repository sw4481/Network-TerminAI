-- Transit rank 9: Postman Collection v2.1 imports.

CREATE TABLE api_request_collections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    source_kind TEXT NOT NULL CHECK(source_kind = 'postman_v2_1'),
    source_file_name TEXT NOT NULL,
    environment TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

ALTER TABLE api_saved_requests ADD COLUMN collection_id TEXT REFERENCES api_request_collections(id) ON DELETE CASCADE;
ALTER TABLE api_saved_requests ADD COLUMN folder_path TEXT NOT NULL DEFAULT '';
ALTER TABLE api_saved_requests ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE api_saved_requests ADD COLUMN auth_json TEXT NOT NULL DEFAULT '{"type":"none"}';

UPDATE api_saved_requests SET display_name = name WHERE display_name = '';

CREATE INDEX idx_api_saved_requests_collection_folder
    ON api_saved_requests(collection_id, folder_path, display_name COLLATE NOCASE);
