if (-not $env:CCIE_TERMINAL) { return }

$esc = [char]27
$bel = [char]7
$script:__ccieLastCommand = $null

function global:__ccie_command_start([string]$command) {
  [Console]::Write("$esc]133;C;$command$bel")
}

function global:__ccie_command_end([int]$exitCode) {
  [Console]::Write("$esc]133;D;$exitCode$bel")
}

function global:__ccie_report_cwd {
  $path = (Get-Location).Path.Replace('\', '/')
  [Console]::Write("$esc]7;file://localhost/$path$bel")
}

function global:prompt {
  $commandSucceeded = $?
  $nativeExitCode = $LASTEXITCODE
  if ($script:__ccieLastCommand -ne $null) {
    if ($commandSucceeded) {
      __ccie_command_end 0
    } elseif ($nativeExitCode -is [int] -and $nativeExitCode -ne 0) {
      __ccie_command_end $nativeExitCode
    } else {
      __ccie_command_end 1
    }
    $script:__ccieLastCommand = $null
  }
  __ccie_report_cwd
  [Console]::Write("$esc]133;A$bel")
  "PS $($executionContext.SessionState.Path.CurrentLocation)> "
  [Console]::Write("$esc]133;B$bel")
}

# Older PSReadLine versions invoke AddToHistoryHandler for imported history,
# not just executed input. Track only the command returned by the line editor.
if (-not $script:__ccieOriginalReadLine) {
  $script:__ccieOriginalReadLine = (Get-Command PSConsoleHostReadLine).ScriptBlock
}
function global:PSConsoleHostReadLine {
  $command = & $script:__ccieOriginalReadLine
  if (-not [string]::IsNullOrWhiteSpace($command)) {
    $script:__ccieLastCommand = $command
    __ccie_command_start $command
  }
  return $command
}
