# Contributing to CCIE Terminal

Thank you for your interest in contributing to CCIE Terminal! This guide will help you get started.

## Table of Contents

- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Code Style](#code-style)
- [Testing](#testing)
- [Pull Request Process](#pull-request-process)
- [Commit Guidelines](#commit-guidelines)
- [Development Workflow](#development-workflow)

## Development Setup

### Prerequisites

- **Rust**: Install via [rustup](https://rustup.rs/); this repository pins 1.97.0
- **Node.js**: Version 22+ required
- **Bun**: Install from [bun.sh](https://bun.sh)
- **Python**: Version 3.12 required
- **Git**: For version control

### Initial Setup

1. **Clone the repository:**
   ```bash
   git clone <repo-url>
   cd "CCIE Terminal"
   ```

2. **Install frontend dependencies:**
   ```bash
   bun install
   ```

3. **Set up Python sidecar:**
   ```bash
   cd sidecar
   python3.12 -m venv .venv
   source .venv/bin/activate
   pip install -e '.[dev]'
   cd ..
   ```

4. **Set up API keys for testing:**
   ```bash
   cp .env.example .env
   # Edit .env and add your API keys
   ```

5. **Run in development mode:**
   ```bash
   CCIE_REPO_ROOT="$PWD" bun tauri dev
   ```

### IDE Setup

**VS Code (recommended):**

Install extensions:
- rust-analyzer
- Tauri
- Python
- ESLint
- Prettier

Open the workspace: `code .vscode/ccie-terminal.code-workspace`

**Other IDEs:**

Configuration files are provided for:
- IntelliJ IDEA / RustRover
- Neovim (LSP config)

## Project Structure

```
CCIE Terminal/
├── src/                    # React frontend
│   ├── components/        # React components
│   ├── state/            # Zustand stores
│   ├── hooks/            # Custom React hooks
│   ├── lib/              # Utility functions
│   └── windows/          # Separate windows (Settings)
├── src-tauri/            # Rust backend
│   ├── src/
│   │   ├── main.rs       # Entry point
│   │   ├── commands.rs   # Tauri commands
│   │   ├── pty.rs        # PTY management
│   │   ├── db.rs         # Database utilities
│   │   ├── session.rs    # Session management
│   │   ├── search.rs     # FTS5 search
│   │   ├── mcp/          # MCP client
│   │   └── skills/       # Skills loader
│   ├── migrations/       # SQL migrations
│   └── Cargo.toml        # Rust dependencies
├── sidecar/              # Python AI sidecar
│   ├── src/ccie_sidecar/
│   │   ├── server.py     # NDJSON server
│   │   ├── agent.py      # AI agent logic
│   │   ├── skills.py     # Skills system
│   │   └── mcp_tools.py  # MCP tool handling
│   └── tests/            # Python tests
├── docs/                 # Documentation
├── shell-integration/    # Shell integration scripts
└── dist/                 # Build output
```

## Code Style

### Rust

Follow standard Rust conventions:

- **Formatting**: Use `rustfmt`
  ```bash
  cd src-tauri
  cargo fmt
  ```

- **Linting**: Use `clippy`
  ```bash
  cargo clippy -- -D warnings
  ```

- **Naming**:
  - `snake_case` for functions and variables
  - `PascalCase` for types and structs
  - `SCREAMING_SNAKE_CASE` for constants

- **Documentation**: Add rustdoc comments for public APIs
  ```rust
  /// Spawns a new PTY session.
  ///
  /// # Arguments
  /// * `opts` - PTY configuration options
  /// * `tx` - Channel for sending PTY events
  ///
  /// # Returns
  /// A handle to the spawned PTY
  pub async fn spawn_pty(
      opts: PtyOptions,
      tx: mpsc::Sender<PtyEvent>
  ) -> Result<PtyHandle> {
      // ...
  }
  ```

- **Error handling**: Use `anyhow::Result` for functions that can fail
- **Async**: Use `tokio` for async code, avoid blocking operations

### TypeScript/React

Follow modern React and TypeScript best practices:

- **Formatting**: Use Prettier (automatic with VS Code)
  ```bash
  bun run prettier --write src/
  ```

- **Linting**: Use ESLint
  ```bash
  bun run eslint src/
  ```

- **Naming**:
  - `camelCase` for functions and variables
  - `PascalCase` for components and types
  - `UPPER_SNAKE_CASE` for constants

- **Components**: Use functional components with hooks
  ```typescript
  export function MyComponent({ prop1, prop2 }: Props) {
    const [state, setState] = useState(initial);
    
    useEffect(() => {
      // side effects
    }, [dependencies]);
    
    return <div>...</div>;
  }
  ```

- **State management**: Use Zustand stores for global state
- **Type safety**: Avoid `any`, use proper types
- **JSDoc**: Add JSDoc comments for utility functions
  ```typescript
  /**
   * Converts bytes array to UTF-8 string.
   * 
   * @param bytes - Array of byte values
   * @returns Decoded string
   */
  export function bytesToString(bytes: number[]): string {
    return new TextDecoder().decode(new Uint8Array(bytes));
  }
  ```

### Python

Follow PEP 8 with modern Python 3.12 features:

- **Formatting**: Use `ruff` (included in dev dependencies)
  ```bash
  cd sidecar
  ruff format src/ tests/
  ```

- **Linting**: Use `ruff check`
  ```bash
  ruff check src/ tests/
  ```

- **Type hints**: Use type annotations
  ```python
  from typing import Any

  def handle_request(req: dict[str, Any]) -> dict[str, Any]:
      """Handle a single NDJSON request."""
      # ...
  ```

- **Docstrings**: Use Google-style docstrings
  ```python
  def nl_to_command(
      nl_query: str,
      shell: str = "bash",
      cwd: str = "",
      profile: str = "default"
  ) -> str:
      """Convert natural language to a shell command.
      
      Args:
          nl_query: Natural language description
          shell: Shell type (bash, zsh, etc.)
          cwd: Current working directory for context
          profile: LLM profile to use
          
      Returns:
          Generated shell command string
          
      Raises:
          ValueError: If query is empty
          APIError: If LLM API call fails
      """
      # ...
  ```

## Testing

### Rust Tests

Run all Rust tests:
```bash
cd src-tauri
cargo test
```

Run specific test:
```bash
cargo test test_name
```

Run with output:
```bash
cargo test -- --nocapture
```

**Writing tests:**
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_feature() {
        let result = my_function();
        assert_eq!(result, expected);
    }

    #[tokio::test]
    async fn test_async_feature() {
        let result = my_async_function().await;
        assert!(result.is_ok());
    }
}
```

### Python Tests

Run all Python tests:
```bash
cd sidecar
source .venv/bin/activate
pytest
```

Run with coverage:
```bash
pytest --cov=src/ccie_sidecar --cov-report=html
```

Run specific test:
```bash
pytest tests/test_agent.py::test_nl_to_command
```

**Writing tests:**
```python
import pytest
from ccie_sidecar.agent import nl_to_command

def test_nl_to_command():
    """Test natural language to command conversion."""
    result = nl_to_command(
        nl_query="list files",
        shell="bash",
        profile="fast"
    )
    assert isinstance(result, str)
    assert len(result) > 0

@pytest.mark.asyncio
async def test_streaming():
    """Test streaming responses."""
    chunks = []
    async for chunk in chat_stream(messages=[...]):
        chunks.append(chunk)
    assert len(chunks) > 0
```

### TypeScript Tests

Run all frontend tests:
```bash
bun test
```

Watch mode:
```bash
bun test:watch
```

**Writing tests:**
```typescript
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MyComponent } from './MyComponent';

describe('MyComponent', () => {
  it('renders correctly', () => {
    render(<MyComponent value="test" />);
    expect(screen.getByText('test')).toBeInTheDocument();
  });

  it('handles user interaction', async () => {
    const { user } = render(<MyComponent />);
    await user.click(screen.getByRole('button'));
    expect(screen.getByText('clicked')).toBeInTheDocument();
  });
});
```

### Integration Tests

Integration tests span multiple components:

**Rust integration test:**
```rust
// src-tauri/tests/integration_test.rs
#[tokio::test]
async fn test_pty_spawn_and_write() {
    let (tx, mut rx) = mpsc::channel(256);
    
    let handle = spawn_pty(
        PtyOptions {
            shell: "/bin/sh".to_string(),
            args: vec![],
            cwd: "/tmp".to_string(),
            cols: 80,
            rows: 24,
        },
        tx,
    ).await.unwrap();
    
    handle.write(b"echo test\n").unwrap();
    
    // Collect output events
    let mut output = Vec::new();
    while let Some(event) = rx.recv().await {
        if let PtyEvent::Output { bytes } = event {
            output.extend(bytes);
        }
        if output.len() > 100 {
            break;
        }
    }
    
    let text = String::from_utf8_lossy(&output);
    assert!(text.contains("test"));
}
```

## Pull Request Process

### Before Submitting

1. **Create a feature branch:**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes:**
   - Write clean, documented code
   - Add tests for new functionality
   - Update documentation if needed

3. **Run all tests:**
   ```bash
   # Rust
   cd src-tauri && cargo test && cargo clippy
   
   # Python
   cd sidecar && pytest
   
   # TypeScript
   bun test
   ```

4. **Format code:**
   ```bash
   cd src-tauri && cargo fmt
   cd sidecar && ruff format src/ tests/
   bun run prettier --write src/
   ```

5. **Commit your changes** (see [Commit Guidelines](#commit-guidelines))

### Submitting the PR

1. **Push your branch:**
   ```bash
   git push origin feature/your-feature-name
   ```

2. **Open a Pull Request:**
   - Use the PR template
   - Provide a clear description
   - Reference related issues
   - Add screenshots for UI changes

3. **PR checklist:**
   - [ ] Tests pass locally
   - [ ] Code is formatted
   - [ ] Documentation updated
   - [ ] CHANGELOG.md updated (if applicable)
   - [ ] No merge conflicts
   - [ ] PR description is clear

### Review Process

1. **Automated checks** run on your PR:
   - Rust tests and clippy
   - Python tests and linting
   - TypeScript tests and linting
   - Build verification

2. **Code review** by maintainers:
   - Reviews typically within 2-3 days
   - Address feedback with new commits
   - Discussion in PR comments

3. **Merge:**
   - Once approved, a maintainer will merge
   - Squash merge for feature branches
   - Merge commit for release branches

## Commit Guidelines

Follow [Conventional Commits](https://www.conventionalcommits.org/):

### Format

```
<type>(<scope>): <subject>

<body>

<footer>
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `style`: Code style (formatting, missing semicolons, etc.)
- `refactor`: Code change that neither fixes a bug nor adds a feature
- `perf`: Performance improvement
- `test`: Adding or updating tests
- `chore`: Maintenance tasks (dependencies, build, etc.)

### Examples

```
feat(pty): add support for PTY resize events

Implement resize handling for terminal tabs using portable-pty
resize API. Updates terminal dimensions and notifies shell.

Closes #123
```

```
fix(search): correct FTS5 query escaping

Escape special characters in search queries to prevent
FTS5 syntax errors. Adds tests for edge cases.
```

```
docs(api): add JSDoc comments to utility functions

Add comprehensive JSDoc comments for all functions in
src/lib/utils.ts to improve IDE autocomplete.
```

### Scope

Use the component/area being modified:
- `pty` - PTY management
- `ai` - AI agent features
- `mcp` - MCP integration
- `skills` - Skills system
- `search` - Search functionality
- `ui` - Frontend components
- `db` - Database changes
- `sidecar` - Python sidecar

## Development Workflow

### Feature Development

1. **Plan the feature:**
   - Discuss in an issue first
   - Get feedback on approach
   - Define success criteria

2. **Implement:**
   - Start with tests (TDD when possible)
   - Write minimal code to pass tests
   - Refactor and document

3. **Test thoroughly:**
   - Unit tests for individual functions
   - Integration tests for component interaction
   - Manual testing for UI features

4. **Document:**
   - Update relevant docs
   - Add code comments
   - Update API docs if needed

### Bug Fixes

1. **Reproduce the bug:**
   - Write a failing test
   - Document steps to reproduce

2. **Fix:**
   - Make minimal changes
   - Ensure test passes
   - Verify no regressions

3. **Add regression test:**
   - Prevent future recurrence

### Debugging

**Rust debugging:**
```bash
# Enable debug logging
RUST_LOG=debug CCIE_REPO_ROOT="$PWD" bun tauri dev

# Use rust-lldb or rust-gdb
rust-lldb target/debug/ccie-terminal
```

**Python debugging:**
```python
# Add breakpoints
import pdb; pdb.set_trace()

# Or use your IDE's debugger
```

**Frontend debugging:**
- Use Chrome DevTools
- React DevTools extension
- Console logging

### Performance Profiling

**Rust:**
```bash
cargo install flamegraph
cargo flamegraph --bin ccie-terminal
```

**Python:**
```python
import cProfile
cProfile.run('function_to_profile()')
```

**Frontend:**
- Chrome DevTools Performance tab
- React Profiler

## Getting Help

- **Documentation**: Check docs/ directory
- **Issues**: Search existing issues or create new one
- **Discussions**: Use GitHub Discussions for questions
- **Community**: Join our community channels (TBD)

## Code of Conduct

Be respectful and constructive. We're all here to build something great together.

Thank you for contributing to CCIE Terminal!
