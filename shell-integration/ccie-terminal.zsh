# CCIE Terminal shell integration for zsh (OSC 133 + OSC 7).
# Sourced from your ~/.zshrc when CCIE_TERMINAL=1.

if [[ -z "$CCIE_TERMINAL" ]]; then
  return
fi

__ccie_command_start()   { printf '\e]133;C;%s\a' "$1"; }
__ccie_command_end()     { printf '\e]133;D;%s\a' "$1"; }
__ccie_prompt_start()    { printf '\e]133;A\a'; }
__ccie_prompt_end()      { printf '\e]133;B\a'; }
# OSC 7 — report the working directory so the terminal tracks `cd` live.
__ccie_report_cwd()      { printf '\e]7;file://%s%s\a' "${HOST:-localhost}" "$PWD"; }

# Track whether a command was actually run (so we don't emit D on the initial prompt)
__ccie_cmd_active=0

# preexec fires before command runs - send the actual command and mark active
__ccie_preexec() {
  __ccie_cmd_active=1
  __ccie_command_start "$1"
}

# precmd fires before each prompt - capture $? IMMEDIATELY, then emit D if a command ran
__ccie_precmd() {
  local exit_code=$?
  if [[ "$__ccie_cmd_active" == "1" ]]; then
    __ccie_command_end "$exit_code"
    __ccie_cmd_active=0
  fi
  __ccie_report_cwd
  __ccie_prompt_start
}

# Also report cwd whenever the directory changes (covers the initial prompt too).
chpwd_functions=(__ccie_report_cwd $chpwd_functions)
__ccie_report_cwd

preexec_functions=(__ccie_preexec $preexec_functions)
precmd_functions=(__ccie_precmd $precmd_functions)

# B marker at the END of the prompt so prompt text is visible
PROMPT="$PROMPT%{$(__ccie_prompt_end)%}"
