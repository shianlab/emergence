param([string]$InstallRoot, [switch]$NoPath)
$ErrorActionPreference = 'Stop'
if (-not $InstallRoot) {
    $InstallRoot = if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'installation.json')) {
        $PSScriptRoot
    }
    else {
        Join-Path $env:LOCALAPPDATA 'Emergence'
    }
}
& (Join-Path $PSScriptRoot 'run-manager.ps1') -Action uninstall -InstallRoot $InstallRoot -NoPath:$NoPath
exit $LASTEXITCODE
