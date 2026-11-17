$ErrorActionPreference = 'Stop'
$portable = Test-Path -LiteralPath (Join-Path $PSScriptRoot 'release.json')
$root = if ($portable) {
    $PSScriptRoot
}
else {
    Split-Path -Parent $PSScriptRoot
}
$pinnedRelease = $null
if ($portable -and (Split-Path -Leaf (Split-Path -Parent $PSScriptRoot)) -eq 'versions') {
    $managedRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
    if (Test-Path -LiteralPath (Join-Path $managedRoot 'installation.json')) {
        $pinnedRelease = $PSScriptRoot
        $root = $managedRoot
        $portable = $false
    }
}
. (Join-Path $root 'launch-support.ps1')
$gate = $null
$lease = $null
try {
    $releaseRoot = $root
    if (!$portable) {
        Assert-ManagedPath $root
        $transaction = Join-Path $root 'install-transaction.json'
        Assert-ManagedPath $transaction
        if (Test-Path -LiteralPath $transaction) {
            & (Join-Path $root 'run-manager.ps1') -Action recover -InstallRoot $root -NoPath -Quiet
            if ($LASTEXITCODE -ne 0) {
                throw '安装恢复未完成；请重新运行完整发行包中的 install.ps1。'
            }
        }
        $gate = Open-LaunchGate $root
        $pointerFile = Join-Path $root 'current.json'
        Assert-ManagedPath $pointerFile
        $current = Get-Content -LiteralPath $pointerFile -Raw -Encoding UTF8 | ConvertFrom-Json
        $releaseRoot = Resolve-VersionDirectory $root $current
        if ($pinnedRelease) {
            Assert-ManagedPath $pinnedRelease; $releaseRoot = $pinnedRelease
        }
        $lease = Open-VersionLease $root (Split-Path -Leaf $releaseRoot)
    }
    $node = Join-Path $releaseRoot 'runtime\node.exe'
    $entry = Join-Path $releaseRoot 'app\bin\emergence.cjs'
    if (!(Test-Path -LiteralPath $node) -or !(Test-Path -LiteralPath $entry)) {
        throw '应用文件缺失，请使用完整发行包执行修复安装。'
    }
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $node
    $start.UseShellExecute = $false
    $nativeArguments = @($entry) + @($args | ForEach-Object { [string]$_ })
    $start.Arguments = ($nativeArguments | ForEach-Object { Quote-NativeArgument $_ }) -join ' '
    $process = [System.Diagnostics.Process]::Start($start)
    if ($gate) {
        $gate.Dispose(); $gate = $null
    }
    $process.WaitForExit()
    $code = $process.ExitCode
}
finally {
    if ($gate) {
        $gate.Dispose()
    }
    if ($lease) {
        $lease.handle.Dispose()
        Remove-Item -LiteralPath $lease.record -Force -ErrorAction SilentlyContinue
    }
}
exit $code
