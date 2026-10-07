# Run from unelevated PowerShell on the installed Windows machine. No app files are changed.
# Remote debugging grants OTHER LOCAL PROCESSES unrestricted access to app webviews,
# including private data. Use a controlled machine, never share the target listing,
# and close TerminAI normally when finished to remove the listener.
$ErrorActionPreference = 'Stop'
$port = 9339
$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Use unelevated PowerShell.' }
if (Test-Path Env:\WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS) { throw 'Existing WebView2 arguments: do not overwrite them.' }
if (Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue) { throw 'Debug port already occupied.' }

$running = @(Get-Process -Name TerminAI -ErrorAction SilentlyContinue)
if ($running.Count -ne 1) { throw 'Open exactly one TerminAI instance before running this probe.' }
$exe = $running[0].Path
if (-not (Test-Path -LiteralPath $exe -PathType Leaf) -or
    [IO.Path]::GetFileName($exe) -ine 'TerminAI.exe') { throw 'Expected a verified installed TerminAI.exe.' }
Write-Host "Detected executable (keep this path local): $exe"
if ((Read-Host 'Confirm this is your installed TerminAI v1.1.9; type YES') -cne 'YES') { throw 'Build under test was not confirmed; nothing relaunched.' }
Read-Host 'Save any work and close ALL TerminAI windows normally; press Enter once closed'
if (Get-Process -Name TerminAI -ErrorAction SilentlyContinue) { throw 'TerminAI is still running; nothing was closed by this probe.' }

$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--remote-debugging-address=127.0.0.1 --remote-debugging-port=9339'
try { $app = Start-Process -FilePath $exe -PassThru }
finally { Remove-Item Env:\WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue }

try {
  $listeners = @()
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if ($listeners.Count) { break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $listeners.Count) { throw 'No debug listener: stop; do not assume DevTools is available.' }
  foreach ($listener in $listeners) {
    if ($listener.LocalAddress -notin @('127.0.0.1', '::1')) { throw 'Listener is not loopback-only; do not attach.' }
    $probePid = [int]$listener.OwningProcess
    $owned = $false
    for ($depth = 0; $depth -lt 12 -and $probePid -gt 0; $depth++) {
      if ($probePid -eq $app.Id) { $owned = $true; break }
      $process = Get-CimInstance Win32_Process -Filter "ProcessId=$probePid" -ErrorAction SilentlyContinue
      if (-not $process) { break }
      $probePid = [int]$process.ParentProcessId
    }
    if (-not $owned) { throw 'Debug listener ownership not verified; do not attach.' }
  }
  Write-Host 'Verified app-owned loopback debugger. In Microsoft Edge, open edge://inspect/#devices (do NOT share its target listing).'
  Write-Host 'Under Discover network targets, choose Configure and add 127.0.0.1:9339; inspect only the TerminAI app UI target.'
  Write-Host 'Paste the companion diagnose-windows-monaco-caret.js into that target''s DevTools Console.'
  Write-Host 'Use a nonsensitive scratch buffer. Click in editor, click away, click back; optionally test IME start/end.'
  Write-Host 'After switching modes, paste the collector again in the new editor. Share ONLY caret-probe and caret-csp lines.'
  Write-Host 'Initial sample can show blur because DevTools has focus; post-click samples matter.'
  Read-Host 'After collecting sanitized lines, close TerminAI normally and press Enter'
}
finally {
  Write-Host 'If you added 127.0.0.1:9339 in Edge inspection Configure, remove only that added entry now.'
  Read-Host 'Ensure TerminAI has exited normally (the probe never kills it); press Enter to check cleanup'
  if (Get-Process -Id $app.Id -ErrorAction SilentlyContinue) {
    Write-Warning 'TerminAI is still running; close it normally to end debugging.'
  }
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (-not (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
  if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
    Write-Warning 'Debug listener remains. Do not leave the machine unattended; investigate locally.'
  } else {
    Write-Host 'Debug listener closed.'
  }
}
