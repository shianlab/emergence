$ErrorActionPreference = 'Stop'
# CRT quoting preserves JSON, quotes, spaces and trailing backslashes in Windows PowerShell 5.1 too.
function Quote-NativeArgument([string]$Value) {
  if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') { return $Value }
  $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
  $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
  return '"' + $escaped + '"'
}
$releaseRoot = $PSScriptRoot
if (-not (Test-Path -LiteralPath (Join-Path $releaseRoot 'release.json'))) {
  $installRoot = Split-Path -Parent $PSScriptRoot
  $current = Get-Content -LiteralPath (Join-Path $installRoot 'current.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($current.product -ne 'emergence' -or $current.version -notmatch '^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$') { throw 'Invalid Emergence activation manifest.' }
  $releaseRoot = Join-Path (Join-Path $installRoot 'versions') $current.version
}
$node = Join-Path $releaseRoot 'runtime\node.exe'
$entry = Join-Path $releaseRoot 'app\bin\emergence.cjs'
if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $entry)) { throw 'Incomplete Emergence installation. Run install.ps1 from a complete release.' }
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $node
$start.UseShellExecute = $false
$nativeArguments = @($entry) + @($args | ForEach-Object { [string]$_ })
$start.Arguments = ($nativeArguments | ForEach-Object { Quote-NativeArgument $_ }) -join ' '
$process = [System.Diagnostics.Process]::Start($start)
$process.WaitForExit()
exit $process.ExitCode
