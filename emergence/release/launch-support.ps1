# Shared protocol-2 launcher helpers. Keep this file backward compatible with directory-less pointers.
function Quote-NativeArgument([string]$Value) {
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
        return $Value
    }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}
function Assert-ManagedPath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw '安装路径包含链接，请使用完整发行包恢复。'
        }
        $cursor = Split-Path -Parent $cursor
    }
}
function Resolve-VersionDirectory([string]$Root, $Pointer) {
    if (!$Pointer -or $Pointer.product -ne 'emergence' -or $Pointer.version -notmatch '^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$') {
        throw '安装版本记录无效。'
    }
    $directory = if ($Pointer.directory) {
        $Pointer.directory
    }
    else {
        $Pointer.version
    }
    if ($directory -notmatch '^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$') {
        throw '安装版本目录无效。'
    }
    $folder = Join-Path (Join-Path $Root 'versions') $directory
    Assert-ManagedPath $folder
    return $folder
}
function Open-LaunchGate([string]$Root) {
    $file = Join-Path $Root '.launch.lock'
    Assert-ManagedPath $file
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
        try {
            return [IO.File]::Open($file, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        }
        catch [IO.IOException] {
            Start-Sleep -Milliseconds 50
        }
    }
    throw '安装操作正在切换版本，请稍后重新启动涌现。'
}
function Open-VersionLease([string]$Root, [string]$Directory) {
    $usage = Join-Path $Root '.usage'
    Assert-ManagedPath $usage
    New-Item -ItemType Directory -Force -Path $usage | Out-Null
    $file = Join-Path $usage ($Directory + '.lock')
    Assert-ManagedPath $file
    $handle = [IO.File]::Open($file, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
    $started = [Diagnostics.Process]::GetCurrentProcess().StartTime.ToUniversalTime().Ticks.ToString()
    $record = Join-Path $usage ($Directory + '.' + $PID + '.' + $started + '.json')
    try {
        Assert-ManagedPath $record
        [IO.File]::WriteAllText($record, (@{ directory = $Directory; pid = $PID; started = $started; kind = 'terminal' } | ConvertTo-Json -Compress))
        return @{ handle = $handle; record = $record }
    }
    catch {
        $handle.Dispose(); throw
    }
}
