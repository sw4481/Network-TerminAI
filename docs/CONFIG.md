# Configuration System

CCIE Terminal uses a dual-file configuration system for managing LLM provider profiles.

## File Locations

- **Config file**: `~/.config/ccie-terminal/config.toml`
- **Secrets file**: `~/.config/ccie-terminal/.env`

Both files are created automatically on first run if they don't exist.

## Configuration Format

### config.toml

Define model profiles with provider and model information:

```toml
[profiles.fast]
provider = "anthropic"
model = "claude-sonnet-4-6"

[profiles.smart]
provider = "anthropic"
model = "claude-opus-4-7"

[profiles.openai-gpt4]
provider = "openai"
model = "gpt-4-turbo"
```

### .env

Store API keys and secrets (automatically created with `chmod 600` on Unix):

```bash
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
```

## Live Reloading

Both files are watched for changes. When you edit them, the configuration is automatically reloaded without restarting the application.

## Tauri Commands

The following commands are available for the frontend:

### get_profiles()
Returns all configured profiles.

```typescript
const profiles = await invoke('get_profiles');
```

### get_profile(name: string)
Returns a specific profile by name.

```typescript
const profile = await invoke('get_profile', { name: 'fast' });
```

### save_profile(name: string, profile: ModelProfile)
Saves or updates a profile.

```typescript
await invoke('save_profile', {
  name: 'custom',
  profile: { provider: 'anthropic', model: 'claude-sonnet-4-6' }
});
```

### get_env_var(key: string)
Retrieves an environment variable.

```typescript
const apiKey = await invoke('get_env_var', { key: 'ANTHROPIC_API_KEY' });
```

### set_env_var(key: string, value: string)
Sets an environment variable and writes it to `.env`.

```typescript
await invoke('set_env_var', {
  key: 'ANTHROPIC_API_KEY',
  value: 'sk-ant-...'
});
```

## Database Integration

The `profiles` table tracks which profiles have been used:

```sql
CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
```

Tabs can reference profiles via `tabs.profile_id`.

## Security

- The `.env` file is automatically created with `0600` permissions on Unix systems
- API keys are never exposed in logs or error messages
- The configuration directory is created in the OS-standard config location
