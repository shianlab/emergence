param([string]$Python, [string]$ConfigHome, [string]$WheelDirectory, [switch]$Offline, [switch]$Force)
$ErrorActionPreference = 'Stop'
$application = Split-Path -Parent $PSScriptRoot
if (-not $Python) {
    $Python = (Get-Command python -ErrorAction Stop).Source
}
$node = Join-Path $application 'node_modules/node/bin/node.exe'
$entry = Join-Path $application 'bin/emergence.cjs'
$arguments = @($entry, 'data-init', '--python', $Python)
if ($ConfigHome) {
    $arguments += @('--home', $ConfigHome)
}
if ($WheelDirectory) {
    $arguments += @('--wheel-dir', $WheelDirectory)
}
if ($Offline) {
    $arguments += '--offline'
}
if ($Force) {
    $arguments += '--force-data-init'
}
& $node @arguments
if ($LASTEXITCODE -ne 0) {
    throw '数据环境未切换，旧环境保留；请检查诊断输出。'
}
