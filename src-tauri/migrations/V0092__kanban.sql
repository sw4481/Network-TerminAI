CREATE TABLE kanban_tasks (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  details          TEXT NOT NULL DEFAULT '',
  pane_context     TEXT,
  completion_mode  TEXT NOT NULL DEFAULT 'autonomous' CHECK (completion_mode IN ('autonomous','human_review')),
  status           TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','running','blocked','review','done','cancelled')),
  assigned_agent   TEXT,
  result           TEXT,
  retry_generation INTEGER NOT NULL DEFAULT 0,
  next_attempt_at  INTEGER NOT NULL DEFAULT 0,
  created_at       INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at       INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX idx_kanban_tasks_dispatch ON kanban_tasks(status, next_attempt_at, created_at);

CREATE TABLE kanban_runs (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES kanban_tasks(id) ON DELETE CASCADE,
  generation   INTEGER NOT NULL,
  attempt      INTEGER NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('running','done','review','failed','cancelled')),
  started_at   INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  finished_at  INTEGER,
  error        TEXT
);

CREATE INDEX idx_kanban_runs_task ON kanban_runs(task_id, attempt DESC);

CREATE TABLE kanban_activity (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES kanban_tasks(id) ON DELETE CASCADE,
  run_id      TEXT REFERENCES kanban_runs(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  message     TEXT NOT NULL,
  metadata    TEXT NOT NULL DEFAULT '{}',
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE INDEX idx_kanban_activity_task ON kanban_activity(task_id, created_at);
