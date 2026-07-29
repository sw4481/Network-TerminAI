-- Add encrypted password storage for SSH connections
ALTER TABLE ssh_connections ADD COLUMN password_encrypted TEXT;

-- Create index for faster lookups
CREATE INDEX idx_ssh_connections_host_user ON ssh_connections(host, user);
