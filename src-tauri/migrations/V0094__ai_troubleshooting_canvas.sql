CREATE TABLE canvas_cases (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 240),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  layout_revision INTEGER NOT NULL DEFAULT 0 CHECK (layout_revision >= 0),
  layout_viewport_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_canvas_cases_recent ON canvas_cases(updated_at DESC);

CREATE TABLE canvas_runs (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES canvas_cases(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('running','finished','failed','cancelled')),
  active_turn_id TEXT,
  submitted_message_id TEXT UNIQUE REFERENCES canvas_messages(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at TEXT,
  UNIQUE(case_id,id)
);
CREATE INDEX idx_canvas_runs_case ON canvas_runs(case_id);
CREATE UNIQUE INDEX idx_canvas_one_running_run ON canvas_runs(case_id) WHERE status='running';

CREATE TABLE canvas_messages (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES canvas_cases(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('operator','assistant')),
  blocks_json TEXT NOT NULL,
  focus_json TEXT NOT NULL DEFAULT '[]',
  submission_json TEXT,
  run_id TEXT,
  turn_id TEXT,
  created_at TEXT NOT NULL,
  delivery_state TEXT,
  applied_turn_id TEXT,
  FOREIGN KEY (case_id,run_id) REFERENCES canvas_runs(case_id,id) ON DELETE CASCADE
);
CREATE INDEX idx_canvas_messages_case ON canvas_messages(case_id,created_at);

CREATE TABLE canvas_cards (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES canvas_cases(id) ON DELETE CASCADE,
  origin TEXT NOT NULL CHECK (origin IN ('operator','model')),
  title TEXT NOT NULL,
  content_json TEXT NOT NULL,
  evidence_ids_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('current','revised','rejected')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  collected_at TEXT,
  updated_at TEXT NOT NULL,
  turn_id TEXT,
  layout_x REAL, layout_y REAL, layout_width REAL, layout_height REAL
);
CREATE INDEX idx_canvas_cards_case ON canvas_cards(case_id);

CREATE TABLE canvas_evidence (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES canvas_cases(id) ON DELETE CASCADE,
  run_id TEXT,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (case_id,run_id) REFERENCES canvas_runs(case_id,id) ON DELETE CASCADE
);
CREATE INDEX idx_canvas_evidence_case ON canvas_evidence(case_id);

CREATE TABLE canvas_attachments (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES canvas_cases(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  width INTEGER, height INTEGER,
  import_state TEXT NOT NULL DEFAULT 'ready',
  extraction_state TEXT NOT NULL DEFAULT 'pending',
  request_inclusion_state TEXT NOT NULL DEFAULT 'pending',
  analysis_state TEXT NOT NULL DEFAULT 'pending',
  storage_key TEXT NOT NULL UNIQUE,
  cleanup_pending INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_pending IN (0,1))
);
CREATE INDEX idx_canvas_attachments_case ON canvas_attachments(case_id);

CREATE TABLE canvas_durable_events (
  event_id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES canvas_cases(id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq >= 1),
  payload_hash TEXT NOT NULL,
  ack_json TEXT NOT NULL,
  FOREIGN KEY (case_id,run_id) REFERENCES canvas_runs(case_id,id) ON DELETE CASCADE,
  UNIQUE(run_id,seq)
);
CREATE INDEX idx_canvas_events_case ON canvas_durable_events(case_id);
