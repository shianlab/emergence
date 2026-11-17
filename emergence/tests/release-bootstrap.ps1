# Requires a locally built release ZIP. Network responses are mocked only inside this test process.
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
$workspace = Split-Path -Parent $project
$record = Get-Content -LiteralPath (Join-Path $workspace 'artifacts\phase6\release-path.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$testRoot = Join-Path $workspace ('artifacts\bootstrap-test-' + [guid]::NewGuid().ToString('N'))
$target = Join-Path $testRoot 'Installed app'
New-Item -ItemType Directory -Path $testRoot | Out-Null
$global:EmergenceBootstrapArchive = $record.archive
$global:EmergenceBootstrapBadHash = $false
$global:EmergenceBootstrapRequests = @()
function Invoke-WebRequest {
    param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile, [int]$TimeoutSec)
    $expected = 'https://github.com/shianlab/emergence/releases/download/v' + $record.version + '/Emergence-' + $record.version + '-win32-x64.zip'
    if ($Uri -ne $expected -and $Uri -ne ($expected + '.sha256')) {
        throw 'Unexpected network destination in bootstrap test'
    }
    $global:EmergenceBootstrapRequests += $Uri
    if ($Uri.EndsWith('.sha256')) {
        $hash = if ($global:EmergenceBootstrapBadHash) {
            '0' * 64
        }
        else {
            (Get-FileHash -LiteralPath $global:EmergenceBootstrapArchive -Algorithm SHA256).Hash
        }
        [IO.File]::WriteAllText($OutFile, "$hash  Emergence-$($record.version)-win32-x64.zip`n")
    }
    else {
        Copy-Item -LiteralPath $global:EmergenceBootstrapArchive -Destination $OutFile
    }
}
$bootstrap = Join-Path $workspace 'install.ps1'
$beforePath = [Environment]::GetEnvironmentVariable('Path', 'User')
$checks = [ordered]@{}
Write-Output 'Testing bootstrap download, hash verification and isolated install...'
& $bootstrap -Version $record.version -InstallRoot $target -NoPath
if (!(Test-Path -LiteralPath (Join-Path $target 'current.json'))) {
    throw 'Bootstrap did not install'
}
$version = & (Join-Path $target 'bin\emergence.cmd') --version
if ($LASTEXITCODE -ne 0 -or $version.Trim() -ne $record.version) {
    throw 'Installed CLI version mismatch'
}
$checks.installedWithBundledRuntime = $true
$checks.versionedDownloadUrls = $global:EmergenceBootstrapRequests.Count -eq 2
if ([Environment]::GetEnvironmentVariable('Path', 'User') -ne $beforePath) {
    throw 'NoPath changed user PATH'
}
$checks.noPathRespected = $true
$global:EmergenceBootstrapBadHash = $true
$rejected = $false
try {
    & $bootstrap -Version $record.version -InstallRoot $target -NoPath
}
catch {
    if ($_.Exception.Message -notmatch 'checksum mismatch') {
        throw
    }; $rejected = $true
}
if (!$rejected) {
    throw 'Corrupt checksum accepted'
}
$checks.badHashRejected = $true
$after = & (Join-Path $target 'bin\emergence.cmd') --version
if ($after.Trim() -ne $record.version) {
    throw 'Failed download changed active version'
}
$checks.failedDownloadPreservesInstallation = $true
$global:EmergenceBootstrapBadHash = $false
$global:EmergenceBootstrapArchive = Join-Path $testRoot 'unsafe.zip'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open($global:EmergenceBootstrapArchive, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($name in @('../escape.txt', 'a', 'b', 'c', 'd', 'e')) {
        $zip.CreateEntry($name) | Out-Null
    }
}
finally {
    $zip.Dispose()
}
$rejected = $false
try {
    & $bootstrap -Version $record.version -InstallRoot $target -NoPath
}
catch {
    if ($_.Exception.Message -notmatch 'Unsafe release archive path') {
        throw
    }; $rejected = $true
}
if (!$rejected) {
    throw 'Unsafe archive accepted'
}
$checks.unsafeArchiveRejected = $true
& (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -NoProfile -ExecutionPolicy Bypass -File (Join-Path $target 'uninstall.ps1') -NoPath
if ($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath $target)) {
    throw 'Isolated uninstall failed'
}
$checks.uninstallPassed = $true
$report = @{passed = $true; checks = $checks; testRoot = $testRoot; note = 'Mocked HTTPS downloads; actual ZIP, installer and bundled runtime. Public download is verified separately after publishing.' }
$report | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $workspace 'artifacts\phase6\bootstrap-validation.json') -Encoding UTF8
$checks | ConvertTo-Json -Compress
