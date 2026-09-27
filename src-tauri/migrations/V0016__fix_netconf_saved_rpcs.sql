-- Fix netconf_saved_rpcs schema to match implementation

-- Drop old table and recreate with correct schema
DROP TABLE IF EXISTS netconf_saved_rpcs;

CREATE TABLE netconf_saved_rpcs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL UNIQUE,
  rpc_xml     TEXT    NOT NULL,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL
);
