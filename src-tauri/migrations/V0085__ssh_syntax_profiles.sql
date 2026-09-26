-- Transit rank 7: presentation-only syntax highlighting profiles.

ALTER TABLE ssh_connections ADD COLUMN syntax_highlighting_enabled INTEGER NOT NULL DEFAULT 0
    CHECK(syntax_highlighting_enabled IN (0, 1));
ALTER TABLE ssh_connections ADD COLUMN syntax_profile TEXT NOT NULL DEFAULT 'auto'
    CHECK(syntax_profile IN ('auto', 'cisco', 'junos', 'arista', 'generic'));
