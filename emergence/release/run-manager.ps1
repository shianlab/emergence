param(
    [ValidateSet('install', 'update', 'repair', 'rollback', 'recover', 'cleanup', 'status', 'uninstall')][string]$Action,
    [string]$InstallRoot, [string]$Source, [switch]$NoPath, [switch]$Quiet
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
. (Join-Path $PSScriptRoot 'launch-support.ps1')
$target = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
Assert-ManagedPath $target
$engine = $PSScriptRoot
$runtimeRoot = $engine
if (!(Test-Path -LiteralPath (Join-Path $engine 'release.json'))) {
    $journalFile = Join-Path $target 'install-transaction.json'
    Assert-ManagedPath $journalFile
    $journal = if (Test-Path -LiteralPath $journalFile) {
        Get-Content -LiteralPath $journalFile -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    else {
        $null
    }
    $currentFile = Join-Path $target 'current.json'
    Assert-ManagedPath $currentFile
    $current = if (Test-Path -LiteralPath $currentFile) {
        Get-Content -LiteralPath $currentFile -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    else {
        $null
    }
    $engineName = if ($journal -and $journal.engine) {
        $journal.engine
    }
    elseif ($current -and $current.manager) {
        $current.manager
    }
    elseif ($current) {
        $current.version
    }
    else {
        $null
    }
    if (!$engineName -or $engineName -notmatch '^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$') {
        throw '安装管理器不可用，请重新运行完整发行包的 install.ps1。'
    }
    $engine = Join-Path (Join-Path $target 'versions') $engineName
    Assert-ManagedPath $engine
    $runtimeRoot = $engine
    if ($journal -and $journal.before.'current.json') {
        $previous = $journal.before.'current.json' | ConvertFrom-Json
        $previousRoot = Resolve-VersionDirectory $target $previous
        if (Test-Path -LiteralPath (Join-Path $previousRoot 'runtime\node.exe')) {
            $runtimeRoot = $previousRoot
        }
    }
}
$node = Join-Path $runtimeRoot 'runtime\node.exe'
if (!(Test-Path -LiteralPath $node) -or (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -ne '14319838b3f355e0398c13569a90270bce4fc68f25189f58c59b03dadae0e6d5') {
    throw '运行时校验失败，请从完整发行包执行修复；用户配置不需要删除。'
}
$temporary = $null
try {
    # Maintenance may retire the runtime that started it; execute a private, verified copy.
    if ($Action -ne 'status') {
        $temporary = Join-Path ([IO.Path]::GetTempPath()) ('Emergence-maintenance-' + [guid]::NewGuid().ToString('N'))
        Assert-ManagedPath $temporary
        New-Item -ItemType Directory -Path $temporary | Out-Null
        Copy-Item -LiteralPath $node -Destination (Join-Path $temporary 'node.exe')
        $node = Join-Path $temporary 'node.exe'
    }
    if (!$Source) {
        $Source = $engine
    }
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $node
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
    $start.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
    $arguments = @((Join-Path $engine 'manage.cjs'), $Action, $target, [IO.Path]::GetFullPath($Source))
    if ($NoPath) {
        $arguments += '--no-path'
    }
    $start.Arguments = ($arguments | ForEach-Object { Quote-NativeArgument $_ }) -join ' '
    $process = [System.Diagnostics.Process]::Start($start)
    $errorRead = $process.StandardError.ReadToEndAsync()
    while (!$process.StandardOutput.EndOfStream) {
        $line = $process.StandardOutput.ReadLine()
        if (!$Quiet) {
            [Console]::Out.WriteLine($line)
        }
    }
    $process.WaitForExit()
    $code = $process.ExitCode
    $errorText = $errorRead.GetAwaiter().GetResult()
    if (!$Quiet -or $code -ne 0) {
        [Console]::Error.Write($errorText)
    }
}
finally {
    if ($temporary -and (Test-Path -LiteralPath $temporary)) {
        $resolved = [IO.Path]::GetFullPath($temporary)
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        if (!$resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolved) -notmatch '^Emergence-maintenance-[a-f0-9]{32}$') {
            throw 'Unsafe helper cleanup.'
        }
        Assert-ManagedPath $resolved
        Remove-Item -LiteralPath (Join-Path $resolved 'node.exe') -Force
        Remove-Item -LiteralPath $resolved
    }
}
exit $code
