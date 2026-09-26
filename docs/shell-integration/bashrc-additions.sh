# CCIE Terminal - Command Blocks Integration for Bash
# Add these lines to your ~/.bashrc

# Emit OSC 133 sequences for command tracking
__ccie_prompt_command() {
  local exit_code=$?
  printf '\e]133;D;%s\a' "$exit_code"
  printf '\e]133;A\a'
  printf '\e]7;file://%s%s\a' "$HOSTNAME" "$PWD"
}

__ccie_preexec() {
  printf '\e]133;C\a'
  printf '\e]133;E;%s\a' "$BASH_COMMAND"
}

# Install hooks
PROMPT_COMMAND="__ccie_prompt_command"
trap '__ccie_preexec' DEBUG
