param([ValidateSet('update', 'repair', 'rollback', 'recover', 'cleanup', 'status')][string]$Action = 'status', [string]$Source, [string]$InstallRoot, [switch]$NoPath)
$ErrorActionPreference = 'Stop'
if (!$InstallRoot) {
    if (!(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'installation.json'))) {
        throw '便携版请指定需要维护的安装目录；开发目录不会自动覆盖。'
    }
    $InstallRoot = $PSScriptRoot
}
if ($Action -in @('update', 'repair') -and !$Source) {
    throw '请用 -Source 指定已下载并解压的完整发行包。在线版本发现将在后续阶段接入。'
}
& (Join-Path $PSScriptRoot 'run-manager.ps1') -Action $Action -InstallRoot $InstallRoot -Source $Source -NoPath:$NoPath
exit $LASTEXITCODE
