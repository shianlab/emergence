param([string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Emergence'), [switch]$NoPath)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'run-manager.ps1') -Action install -InstallRoot $InstallRoot -NoPath:$NoPath
exit $LASTEXITCODE
