-- Chat/group the WhatsApp bridge is scoped to. On a single WhatsApp account,
-- every linked device receives every message, so CCIE and a co-existing bot
-- (e.g. Hermes) share one stream. Binding CCIE to a dedicated group chat lets
-- it act on — and send alerts to — only that group, ignoring the self-chat/DMs
-- Hermes uses. Full JID (e.g. 12036...@g.us). Empty => not scoped (act on any
-- allowlisted chat, subject to the trigger keyword).
ALTER TABLE whatsapp_config ADD COLUMN bound_chat_jid TEXT NOT NULL DEFAULT '';
