-- Trigger keyword for the WhatsApp bridge. When several devices are linked to
-- one WhatsApp number, WhatsApp delivers every message to ALL of them, so a
-- co-existing bot (e.g. Hermes) would answer the same messages. A trigger word
-- lets CCIE act only on messages that start with it. Empty => respond to all
-- allowlisted messages (single-bot mode).
ALTER TABLE whatsapp_config ADD COLUMN trigger_keyword TEXT NOT NULL DEFAULT 'ccie';
