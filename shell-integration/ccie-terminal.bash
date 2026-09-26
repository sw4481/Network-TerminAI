# CCIE Terminal shell integration for bash (OSC 133 + OSC 7).
# Sourced from your ~/.bashrc when CCIE_TERMINAL=1.

[[ -z "$CCIE_TERMINAL" ]] && return

__ccie_prompt_start()  { printf '\e]133;A\a'; }
__ccie_prompt_end()    { printf '\e]133;B\a'; }
__ccie_command_start() { printf '\e]133;C\a'; }
__ccie_command_end()   { printf '\e]133;D;%s\a' "${1:-0}"; }
# OSC 7 — report the working directory so the terminal tracks `cd` live.
__ccie_report_cwd()    { printf '\e]7;file://%s%s\a' "${HOSTNAME:-localhost}" "$PWD"; }

PS1="\[$(__ccie_prompt_start)\]$PS1\[$(__ccie_prompt_end)\]"

# DEBUG trap fires right before each command executes.
trap '__ccie_command_start' DEBUG
# PROMPT_COMMAND runs before each prompt — capture $? first, report cwd, then mark end.
PROMPT_COMMAND='__ccie_command_end $?; __ccie_report_cwd; '"$PROMPT_COMMAND"
