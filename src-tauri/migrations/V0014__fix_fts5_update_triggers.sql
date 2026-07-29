-- Fix FTS5 external-content UPDATE triggers.
--
-- V0006 created AFTER UPDATE triggers that issued a direct UPDATE against
-- the FTS5 shadow table. That's the wrong idiom for external-content FTS5:
-- SQLite corrupts the virtual table and raises "Content in the virtual
-- table is corrupt" on the NEXT read/write after the trigger fires.
--
-- The correct idiom is delete-then-insert using the special 'delete' /
-- 'insert' commands addressed to the FTS5 table itself.
-- Reference: https://sqlite.org/fts5.html#external_content_tables

DROP TRIGGER IF EXISTS command_blocks_au;
DROP TRIGGER IF EXISTS command_blocks_ad;
DROP TRIGGER IF EXISTS ai_messages_au;
DROP TRIGGER IF EXISTS ai_messages_ad;
DROP TRIGGER IF EXISTS skills_au;
DROP TRIGGER IF EXISTS skills_ad;

CREATE TRIGGER command_blocks_au AFTER UPDATE ON command_blocks BEGIN
  INSERT INTO command_blocks_fts(command_blocks_fts, rowid, cmd, output)
    VALUES ('delete', old.rowid, old.cmd, old.output);
  INSERT INTO command_blocks_fts(rowid, cmd, output)
    VALUES (new.rowid, new.cmd, new.output);
END;

CREATE TRIGGER command_blocks_ad AFTER DELETE ON command_blocks BEGIN
  INSERT INTO command_blocks_fts(command_blocks_fts, rowid, cmd, output)
    VALUES ('delete', old.rowid, old.cmd, old.output);
END;

CREATE TRIGGER ai_messages_au AFTER UPDATE ON ai_messages BEGIN
  INSERT INTO ai_messages_fts(ai_messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
  INSERT INTO ai_messages_fts(rowid, content)
    VALUES (new.rowid, new.content);
END;

CREATE TRIGGER ai_messages_ad AFTER DELETE ON ai_messages BEGIN
  INSERT INTO ai_messages_fts(ai_messages_fts, rowid, content)
    VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER skills_au AFTER UPDATE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, when_to_use, playbook)
    VALUES ('delete', old.rowid, old.name, old.description, old.when_to_use, old.playbook);
  INSERT INTO skills_fts(rowid, name, description, when_to_use, playbook)
    VALUES (new.rowid, new.name, new.description, new.when_to_use, new.playbook);
END;

CREATE TRIGGER skills_ad AFTER DELETE ON skills BEGIN
  INSERT INTO skills_fts(skills_fts, rowid, name, description, when_to_use, playbook)
    VALUES ('delete', old.rowid, old.name, old.description, old.when_to_use, old.playbook);
END;

-- Rebuild the FTS indexes to recover from any corruption that happened
-- before this fix.
INSERT INTO command_blocks_fts(command_blocks_fts) VALUES('rebuild');
INSERT INTO ai_messages_fts(ai_messages_fts) VALUES('rebuild');
INSERT INTO skills_fts(skills_fts) VALUES('rebuild');
