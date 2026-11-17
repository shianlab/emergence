param([ValidateSet('install', 'uninstall')][string]$Action, [string]$InstallRoot, [switch]$NoPath)
$ErrorActionPreference = 'Stop'
function Quote-NativeArgument([string]$Value) {
    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
        return $Value
    }
    $escaped = [regex]::Replace($Value, '(\\*)"', '$1$1\"')
    $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}
$root = $PSScriptRoot
$node = Join-Path $root 'runtime\node.exe'
if (-not (Test-Path -LiteralPath $node)) {
    $current = Get-Content -LiteralPath (Join-Path $root 'current.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($current.product -ne 'emergence' -or $current.version -notmatch '^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$') {
        throw 'Invalid activation manifest. Use uninstall.ps1 from the original release.'
    }
    $node = Join-Path (Join-Path (Join-Path $root 'versions') $current.version) 'runtime\node.exe'
}
if ((Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant() -ne '14319838b3f355e0398c13569a90270bce4fc68f25189f58c59b03dadae0e6d5') {
    throw 'Bundled runtime integrity check failed.'
}
$temporary = $null
try {
    # An installed node.exe cannot remove its own Windows image. Run uninstall from a private temp copy.
    $target = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
    if ($Action -eq 'uninstall' -and [IO.Path]::GetFullPath($node).StartsWith($target + '\', [StringComparison]::OrdinalIgnoreCase)) {
        $temporary = Join-Path ([IO.Path]::GetTempPath()) ('Emergence-uninstall-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $temporary | Out-Null
        Copy-Item -LiteralPath $node -Destination (Join-Path $temporary 'node.exe')
        $node = Join-Path $temporary 'node.exe'
    }
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $node; $start.UseShellExecute = $false; $start.CreateNoWindow = $true
    $arguments = @((Join-Path $root 'manage.cjs'), $Action, $target, $root)
    if ($NoPath) {
        $arguments += '--no-path'
    }
    $start.Arguments = ($arguments | ForEach-Object { Quote-NativeArgument $_ }) -join ' '
    $process = [System.Diagnostics.Process]::Start($start); $process.WaitForExit(); $code = $process.ExitCode
}
finally {
    if ($temporary -and (Test-Path -LiteralPath $temporary)) {
        $resolved = [IO.Path]::GetFullPath($temporary)
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
        if (-not $resolved.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $resolved) -notmatch '^Emergence-uninstall-[a-f0-9]{32}$' -or ((Get-Item -LiteralPath $resolved -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Refusing unsafe helper cleanup.'
        }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
exit $code
