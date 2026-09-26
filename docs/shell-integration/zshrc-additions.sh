# CCIE Terminal - Command Blocks Integration for Zsh
# Add these lines to your ~/.zshrc

# Emit OSC 133 sequences for command tracking
precmd() {
  # Command completed - send exit code
  printf '\e]133;D;%s\a' "$?"

  # New prompt starting - begin new block
  printf '\e]133;A\a'
}

preexec() {
  # About to execute command
  printf '\e]133;C\a'

  # Send command text
  printf '\e]133;E;%s\a' "$1"
}

# Get current working directory for block context
_ccie_get_cwd() {
  printf '\e]7;file://%s%s\a' "$HOSTNAME" "$PWD"
}

# Emit CWD on directory change
chpwd_functions+=(_ccie_get_cwd)
