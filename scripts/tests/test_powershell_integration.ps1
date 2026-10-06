param(
  [string]$IntegrationPath = (Join-Path $PSScriptRoot '../../shell-integration/ccie-terminal.ps1')
)

$ErrorActionPreference = 'Stop'
$env:CCIE_TERMINAL = '1'
$global:starts = [System.Collections.Generic.List[string]]::new()
$global:ends = [System.Collections.Generic.List[int]]::new()
$global:acceptedCommand = ''
$global:readLineCalls = 0
$global:historyCalls = 0
$global:historyHandler = { param($command) $global:historyCalls++; return $true }
$originalHistoryHandler = $global:historyHandler

# PSReadLine <= 2.2.6 invokes this callback while importing history in ReadLine.
# Stub only the editor boundary: no real user history is read or executed.
function global:Set-PSReadLineOption {
  param([scriptblock]$AddToHistoryHandler)
  $global:historyHandler = $AddToHistoryHandler
}
function global:PSConsoleHostReadLine {
  $global:readLineCalls++
  foreach ($command in @('Get-Date', 'ftp admin@example.invalid')) {
    $null = & $global:historyHandler $command
  }
  return $global:acceptedCommand
}

. $IntegrationPath
. $IntegrationPath # Re-sourcing must not wrap our wrapper or duplicate events.
function global:__ccie_command_start([string]$command) { $global:starts.Add($command) }
function global:__ccie_command_end([int]$exitCode) { $global:ends.Add($exitCode) }
function global:__ccie_report_cwd { }

$null = PSConsoleHostReadLine
if ($starts.Count -ne 0) { throw 'Imported history/blank input must not emit CommandStart' }
if ($global:historyHandler -ne $originalHistoryHandler) { throw 'User history filter must remain unchanged' }

$commands = @('Write-Output hello', 'Write-Output world', "Write-Output 'café 路由器'", "Write-Output one`nWrite-Output two")
foreach ($command in $commands) {
  $global:acceptedCommand = $command
  $returnedCommand = PSConsoleHostReadLine
  if ($returnedCommand -ne $command) { throw 'ReadLine must return accepted input unchanged' }
  if ($starts.Count -ne $ends.Count + 1 -or $starts[-1] -ne $command) {
    throw 'Accepted input must emit exactly one CommandStart with the accepted command'
  }
  $promptOutput = [System.IO.StringWriter]::new()
  $consoleOutput = [Console]::Out
  try {
    [Console]::SetOut($promptOutput)
    $null = prompt
    if ($ends.Count -ne $starts.Count -or $ends[-1] -ne 0) { throw 'Prompt must complete accepted command successfully' }
    $null = prompt
    if ($ends.Count -ne $starts.Count) { throw 'Prompt redraw must not emit duplicate CommandEnd' }
  } finally {
    [Console]::SetOut($consoleOutput)
  }
  $markers = "$([char]27)]133;A$([char]7)$([char]27)]133;B$([char]7)"
  if ($promptOutput.ToString() -ne "$markers$markers") { throw 'Every prompt must still emit OSC133 A/B markers' }
}

$global:acceptedCommand = '  '
$null = PSConsoleHostReadLine
$global:acceptedCommand = $null # A cancelled edit returns no accepted command.
$null = PSConsoleHostReadLine
if ($starts.Count -ne $commands.Count -or $ends.Count -ne $commands.Count) { throw 'Whitespace/cancelled input must remain idle' }
if ($global:readLineCalls -ne 7 -or $global:historyCalls -ne 14) { throw 'Original ReadLine and history filtering must still run' }
'PASS: history/blank/cancel stays idle; UTF-8/multiline input has one start/end; prompt markers and idempotent sourcing preserved'
