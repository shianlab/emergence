# Standalone bootstrap: no Node/npm required. Dot-source exposes helpers for fault-injection tests.
[CmdletBinding()]
param(
    [string]$Version = '1.0.2',
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Emergence'),
    [switch]$NoPath,
    [switch]$Latest,
    [string]$SignedManifest = '',
    [switch]$Update
)

function Read-EmergenceRelease([string]$File) {
    $encodedTrust = 'eyJzY2hlbWEiOjEsImtleXMiOlt7ImlkIjoiZW1lcmdlbmNlLTIwMjYtMDEiLCJzdGF0dXMiOiJhY3RpdmUiLCJwZW0iOiItLS0tLUJFR0lOIFBVQkxJQyBLRVktLS0tLVxuTUlJQm9qQU5CZ2txaGtpRzl3MEJBUUVGQUFPQ0FZOEFNSUlCaWdLQ0FZRUF4bzNNVk9zTFN2TjgrNXlmVEI0d1xub3NVUDUxenArcXA2RTJYMk52NmxTMEl5ZDh6RGQzcFFEbDdEY2FGVzQzNmdSTVdwdHpvR1VtZHFsV3FDaVk3aVxuNG96SWpYTUFHNUhDRkp5ZzBrUUVuZm8rQXBZbWtkeWxxeGxIQWRqM0pLUGl5WTNLeEZkVjRLVE1hWk91MFdwd1xucFVBeEQrdW9zc3VOWXZmSEN1cS9veGtsS09LL2lSMHNmUGFQQm9mOHE3aDhadmhldEFuUzYrdUFtVDliZHFERlxuVnFDQ3hhbE9lY1UzN3RyclRYVHRUcjUvRDVwSnVCUnk3STlVZW1nSU5vRXlMMWxJczhOUi91bGU5VWQ4RmhySlxuYS9TdUZIcUtnazRzT3czVGNmcXlUK0JmYXczRFo4Z21wcUhkYW9UN1dYTTJaWUw0U1l5YzNndU1GS2RnRWxwN1xuVWtzV3VxSUJzb0VXemtORmtTZmMrVVdJb3A1cW9EanhUWm9Od1VWWWQwL0NaRFJFRmZyOHpZcFdlQ3RqaUZZS1xuNlkzTDJwNEplT3VwbXFoeDVvbllIQkVQZ3k1eEZ0cGRhS2F3dnZpRFYyNklsUmtTbWxFbXdBMksxMDlUNUgxelxueFhYWEt2SVAxRnRHSTYzTGUxUWk3NTV3aEJuQkwzV1RzRlVNVmdJWEtQcGpBZ01CQUFFPVxuLS0tLS1FTkQgUFVCTElDIEtFWS0tLS0tXG4iLCJtb2R1bHVzIjoieG8zTVZPc0xTdk44KzV5ZlRCNHdvc1VQNTF6cCtxcDZFMlgyTnY2bFMwSXlkOHpEZDNwUURsN0RjYUZXNDM2Z1JNV3B0em9HVW1kcWxXcUNpWTdpNG96SWpYTUFHNUhDRkp5ZzBrUUVuZm8rQXBZbWtkeWxxeGxIQWRqM0pLUGl5WTNLeEZkVjRLVE1hWk91MFdwd3BVQXhEK3Vvc3N1Tll2ZkhDdXEvb3hrbEtPSy9pUjBzZlBhUEJvZjhxN2g4WnZoZXRBblM2K3VBbVQ5YmRxREZWcUNDeGFsT2VjVTM3dHJyVFhUdFRyNS9ENXBKdUJSeTdJOVVlbWdJTm9FeUwxbElzOE5SL3VsZTlVZDhGaHJKYS9TdUZIcUtnazRzT3czVGNmcXlUK0JmYXczRFo4Z21wcUhkYW9UN1dYTTJaWUw0U1l5YzNndU1GS2RnRWxwN1Vrc1d1cUlCc29FV3prTkZrU2ZjK1VXSW9wNXFvRGp4VFpvTndVVllkMC9DWkRSRUZmcjh6WXBXZUN0amlGWUs2WTNMMnA0SmVPdXBtcWh4NW9uWUhCRVBneTV4RnRwZGFLYXd2dmlEVjI2SWxSa1NtbEVtd0EySzEwOVQ1SDF6eFhYWEt2SVAxRnRHSTYzTGUxUWk3NTV3aEJuQkwzV1RzRlVNVmdJWEtQcGoiLCJleHBvbmVudCI6IkFRQUIifV19'
    $trust = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encodedTrust)) | ConvertFrom-Json
    Assert-EmergencePath $File
    if ((Get-Item -LiteralPath $File).Length -gt 65536) {
        throw 'Release metadata exceeds limit.'
    }
    $envelope = Get-Content -LiteralPath $File -Raw -Encoding UTF8 | ConvertFrom-Json
    $payload = [Convert]::FromBase64String($envelope.payload)
    $valid = $false
    foreach ($signature in $envelope.signatures) {
        foreach ($key in $trust.keys) {
            if ($key.id -eq $signature.keyId -and $key.status -eq 'active') {
                $rsa = New-Object Security.Cryptography.RSACryptoServiceProvider
                $rsa.PersistKeyInCsp = $false
                try {
                    $parameters = New-Object Security.Cryptography.RSAParameters
                    $parameters.Modulus = [Convert]::FromBase64String($key.modulus)
                    $parameters.Exponent = [Convert]::FromBase64String($key.exponent)
                    $rsa.ImportParameters($parameters)
                    if ($rsa.VerifyData($payload, 'SHA256', [Convert]::FromBase64String($signature.signature))) {
                        $valid = $true
                    }
                }
                finally {
                    $rsa.Dispose()
                }
            }
        }
    }
    if (!$valid) {
        throw 'Release signature rejected.'
    }
    $release = [Text.Encoding]::UTF8.GetString($payload) | ConvertFrom-Json
    if ($release.schema -ne 1 -or $release.product -ne 'emergence' -or $release.platform -ne 'win32-x64' -or $release.minimumInstaller -ne 2 -or $release.version -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$' -or $release.sequence -le 0) {
        throw 'Release identity rejected.'
    }
    if ([DateTimeOffset]::Parse($release.expiresAt) -le [DateTimeOffset]::UtcNow -or [DateTimeOffset]::Parse($release.publishedAt) -gt [DateTimeOffset]::UtcNow.AddMinutes(5)) {
        throw 'Release metadata expired or future-dated.'
    }
    $asset = "https://github.com/shianlab/emergence/releases/download/v$($release.version)/Emergence-$($release.version)-win32-x64.zip"
    if ($release.asset.url -cne $asset -or $release.asset.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $release.asset.bytes -le 0 -or $release.asset.bytes -gt 1GB) {
        throw 'Release asset rejected.'
    }
    return $release
}

function Assert-EmergencePath([string]$Path) {
    $cursor = [IO.Path]::GetFullPath($Path)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Managed paths cannot contain links or junctions.'
            }
        }
        $cursor = Split-Path -Parent $cursor
    }
}

# Streaming transport is separate from orchestration so real HTTP failures can be tested locally.
# The public entry point supplies only fixed official HTTPS URLs.
function Receive-EmergenceFile {
    param(
        [uri]$Uri, [string]$Destination, [long]$MaximumBytes = 1GB,
        [int]$Attempts = 3, [int]$TimeoutSeconds = 30, [int]$TotalSeconds = 900,
        [int]$RetryDelaySeconds = 2, [string]$ExpectedHash = ''
    )
    Assert-EmergencePath $Destination
    $watch = [Diagnostics.Stopwatch]::StartNew()
    for ($attempt = 1; $attempt -le $Attempts; $attempt++) {
        $response = $null
        $inputStream = $null
        $outputStream = $null
        $request = $null
        $failure = 'transport'
        try {
            if ($watch.Elapsed.TotalSeconds -ge $TotalSeconds) {
                throw 'Download time limit reached.'
            }
            $offset = 0L
            if (Test-Path -LiteralPath $Destination) {
                $offset = (Get-Item -LiteralPath $Destination).Length
                if ($offset -gt $MaximumBytes) {
                    throw 'Cached file exceeds size limit.'
                }
                if ($ExpectedHash -and (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ieq $ExpectedHash) {
                    return
                }
                # Files without a trusted digest (such as the checksum response) must restart.
                if (!$ExpectedHash) {
                    $offset = 0L
                }
            }
            $next = $Uri
            for ($redirect = 0; $redirect -le 5; $redirect++) {
                $request = [Net.HttpWebRequest]::Create($next)
                $request.AllowAutoRedirect = $false
                $request.Timeout = [Math]::Max(1, [Math]::Min($TimeoutSeconds * 1000, ($TotalSeconds - $watch.Elapsed.TotalSeconds) * 1000))
                $request.ReadWriteTimeout = $request.Timeout
                $request.UserAgent = 'Emergence-Installer/1'
                if ($offset -gt 0) {
                    $request.AddRange($offset)
                }
                $response = $request.GetResponse()
                $status = [int]$response.StatusCode
                if ($status -notin @(301, 302, 303, 307, 308)) {
                    break
                }
                $next = [uri]::new($next, $response.Headers['Location'])
                $response.Dispose()
                $response = $null
                $official = $Uri.Scheme -eq 'https' -and $Uri.Host -eq 'github.com'
                $allowed = $next.Scheme -eq $Uri.Scheme -and !$next.UserInfo -and (
                    $next.Authority -eq $Uri.Authority -or (
                        $official -and $next.Host -in @('github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com')
                    )
                )
                if (!$allowed -or $redirect -eq 5) {
                    throw 'Download redirect rejected.'
                }
            }
            if ($status -eq 206) {
                $range = $response.Headers['Content-Range']
                if ($range -notmatch '^bytes (\d+)-(\d+)/(\d+)$' -or [long]$Matches[1] -ne $offset -or [long]$Matches[3] -gt $MaximumBytes) {
                    throw 'Invalid resume response.'
                }
                $total = [long]$Matches[3]
            }
            elseif ($status -eq 200) {
                # Servers ignoring Range are supported: replace, never append a full response.
                $offset = 0L
                $total = $response.ContentLength
            }
            else {
                throw 'Unexpected download status.'
            }
            if ($total -gt $MaximumBytes) {
                throw 'Download exceeds size limit.'
            }
            $mode = if ($offset -gt 0) {
                [IO.FileMode]::Append
            }
            else {
                [IO.FileMode]::Create
            }
            $outputStream = [IO.File]::Open($Destination, $mode, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $inputStream = $response.GetResponseStream()
            $buffer = New-Object byte[] 131072
            $received = $offset
            $lastProgress = -1
            while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $received += $count
                if ($received -gt $MaximumBytes -or $watch.Elapsed.TotalSeconds -ge $TotalSeconds) {
                    throw 'Download size or time limit reached.'
                }
                $outputStream.Write($buffer, 0, $count)
                $second = [int]$watch.Elapsed.TotalSeconds
                if ($second -ne $lastProgress) {
                    $percent = if ($total -gt 0) {
                        [Math]::Min(100, [int](100 * $received / $total))
                    }
                    else {
                        -1
                    }
                    Write-Progress -Id 71 -Activity '涌现：下载发行包' -Status ("{0:N1} MB，尝试 {1}/{2}" -f ($received / 1MB), $attempt, $Attempts) -PercentComplete $percent
                    $lastProgress = $second
                }
            }
            $outputStream.Dispose()
            $outputStream = $null
            if ($total -ge 0 -and $received -ne $total) {
                throw 'Incomplete download.'
            }
            if ($ExpectedHash -and (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ine $ExpectedHash) {
                $failure = 'checksum'
                Remove-Item -LiteralPath $Destination -Force
                throw 'Download checksum mismatch.'
            }
            return
        }
        catch {
            # 416 can mean a stale/invalid partial download. Restart from zero, with a bounded retry.
            if ($_.Exception -is [Net.WebException] -and $_.Exception.Response) {
                $httpError = $_.Exception.Response
                $failure = 'http-' + [int]$httpError.StatusCode
                if ([int]$httpError.StatusCode -eq 416 -and (Test-Path -LiteralPath $Destination)) {
                    Remove-Item -LiteralPath $Destination -Force
                }
                $httpError.Dispose()
            }
            if ($attempt -eq $Attempts -or $watch.Elapsed.TotalSeconds -ge $TotalSeconds) {
                throw "下载失败（$failure，尝试 $attempt 次）。可重新执行安装；有效的部分下载会保留。"
            }
            Write-Host "下载未完成（$failure），正在重试 $($attempt + 1)/$Attempts…"
        }
        finally {
            if ($outputStream) {
                $outputStream.Dispose()
            }
            if ($inputStream) {
                $inputStream.Dispose()
            }
            if ($response) {
                $response.Dispose()
            }
            if ($request) {
                $request.Abort()
            }
            Write-Progress -Id 71 -Activity '涌现：下载发行包' -Completed
        }
        Start-Sleep -Seconds ($RetryDelaySeconds * $attempt)
    }
}

function Test-EmergenceArchive([string]$Archive, [string]$Version) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        if ($zip.Entries.Count -lt 5 -or $zip.Entries.Count -gt 100000) {
            throw 'Invalid release archive size.'
        }
        $prefix = "Emergence-$Version-win32-x64/"
        $seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        [long]$expandedBytes = 0
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            if (!$name.StartsWith($prefix, [StringComparison]::Ordinal) -or $name.Contains('//') -or $name.Contains(':') -or $name -match '(^|/)\.\.?(/|$)' -or $name.Contains([char]0) -or !$seen.Add($name)) {
                throw 'Unsafe or duplicate release archive path.'
            }
            foreach ($segment in $name.Split('/')) {
                if ($segment -match '[. ]$|[<>\"|?*\x00-\x1f]' -or $segment -match '^(?i:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)') {
                    throw 'Unsafe Windows archive name.'
                }
            }
            $unixType = ($entry.ExternalAttributes -shr 16) -band 61440
            if ($unixType -ne 0 -and $unixType -ne 32768 -and $unixType -ne 16384) {
                throw 'Archive links and special files are not permitted.'
            }
            $expandedBytes += $entry.Length
            if ($expandedBytes -gt 3GB) {
                throw 'Release exceeds the extraction limit.'
            }
        }
        return $expandedBytes
    }
    finally {
        $zip.Dispose()
    }
}

function Initialize-EmergenceCache([string]$Root) {
    Assert-EmergencePath $Root
    $marker = Join-Path $Root 'owner.json'
    Assert-EmergencePath $marker
    Assert-EmergencePath (Join-Path $Root 'download.lock')
    if (Test-Path -LiteralPath $Root) {
        if (!(Test-Path -LiteralPath $marker)) {
            if (@(Get-ChildItem -LiteralPath $Root -Force).Count) {
                throw 'Cache directory is not owned by Emergence.'
            }
        }
        else {
            $owner = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
            if ($owner.product -ne 'emergence-downloads' -or $owner.schema -ne 1) {
                throw 'Invalid cache ownership marker.'
            }
        }
    }
    New-Item -ItemType Directory -Force -Path $Root | Out-Null
    if (!(Test-Path -LiteralPath $marker)) {
        [IO.File]::WriteAllText($marker, '{"product":"emergence-downloads","schema":1}')
    }
}

function Clear-EmergenceDownloads([string]$Root, [string]$Keep) {
    # Caller holds the cache lock. Only flat, digest-named payload files are eligible.
    [long]$retained = 0
    $files = Get-ChildItem -LiteralPath $Root -Force | Sort-Object LastWriteTimeUtc -Descending
    foreach ($file in $files) {
        if ($file.Name -notmatch '^[a-f0-9]{64}\.(zip|part)$') {
            continue
        }
        Assert-EmergencePath $file.FullName
        if ($file.PSIsContainer) {
            throw 'Invalid cache payload.'
        }
        $retained += $file.Length
        if ($file.FullName -ne $Keep -and ($file.LastWriteTimeUtc -lt [DateTime]::UtcNow.AddDays(-7) -or $retained -gt 1GB)) {
            Remove-Item -LiteralPath $file.FullName -Force
        }
    }
}

function Invoke-EmergenceInstall([string]$Version, [string]$InstallRoot, [bool]$NoPath, [string]$SignedManifest = '', [bool]$Latest = $false, [bool]$Update = $false) {
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version 2.0
    if ($env:OS -ne 'Windows_NT' -or ![Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
        throw 'Emergence requires Windows x64.'
    }
    if ($PSVersionTable.PSVersion -lt [version]'5.1') {
        throw 'PowerShell 5.1 or newer is required.'
    }
    if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$') {
        throw 'Invalid release version.'
    }
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (!(Test-Path -LiteralPath $tar -PathType Leaf)) {
        throw 'Windows tar.exe is required. Update Windows or use manual ZIP installation.'
    }
    $framework = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -ErrorAction SilentlyContinue
    if (!$framework -or $framework.Release -lt 528040) {
        throw '.NET Framework 4.8 or newer is required for model configuration.'
    }

    $cache = Join-Path $env:LOCALAPPDATA 'EmergenceCache\downloads'
    Initialize-EmergenceCache $cache
    $lock = $null
    $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('Emergence-download-' + [Guid]::NewGuid().ToString('N'))
    $previousTls = [Net.ServicePointManager]::SecurityProtocol
    $stage = '准备'
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $events = New-Object Collections.ArrayList
    $log = Join-Path $cache ('install-' + [Guid]::NewGuid().ToString('N') + '.json')
    try {
        $lock = [IO.File]::Open((Join-Path $cache 'download.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        Clear-EmergenceDownloads $cache ''
        Assert-EmergencePath $temporaryRoot
        New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
        [Net.ServicePointManager]::SecurityProtocol = $previousTls -bor [Net.SecurityProtocolType]::Tls12
        $release = $null
        if ($SignedManifest) {
            $release = Read-EmergenceRelease $SignedManifest
        }
        elseif ($Latest -or [version]($Version.Split('-')[0]) -ge [version]'1.0.2') {
            $metadataFile = Join-Path $temporaryRoot 'release.json'
            $metadataUrl = if ($Latest) {
                'https://raw.githubusercontent.com/shianlab/emergence/main/releases/stable.json'
            }
            else {
                "https://github.com/shianlab/emergence/releases/download/v$Version/update.json"
            }
            Receive-EmergenceFile -Uri $metadataUrl -Destination $metadataFile -MaximumBytes 65536 -TotalSeconds 15
            $release = Read-EmergenceRelease $metadataFile
            if (!$Latest -and $release.version -ne $Version) {
                throw 'Release version mismatch.'
            }
        }
        if ($release) {
            $Version = $release.version
        }
        if ($Update -and !$release) {
            throw 'Online updates require signed metadata.'
        }
        $asset = "Emergence-$Version-win32-x64.zip"
        $base = "https://github.com/shianlab/emergence/releases/download/v$Version"
        $stage = '获取校验信息'
        Write-Host "涌现 $Version：获取发行信息…"
        $checksum = Join-Path $temporaryRoot 'checksum.txt'
        if ($release) {
            [IO.File]::WriteAllText($checksum, "$($release.asset.sha256)  $asset")
        }
        else {
            Receive-EmergenceFile -Uri "$base/$asset.sha256" -Destination $checksum -MaximumBytes 4096 -TotalSeconds 120
        }
        $checksumText = (Get-Content -LiteralPath $checksum -Raw).Trim()
        $pattern = '^([a-fA-F0-9]{64})\s+\*?' + [regex]::Escape($asset) + '$'
        if ($checksumText -notmatch $pattern) {
            throw 'Invalid release checksum file.'
        }
        $expected = $Matches[1].ToLowerInvariant()
        $archive = Join-Path $cache "$expected.zip"
        $partial = Join-Path $cache "$expected.part"
        Assert-EmergencePath $archive
        $stage = '下载'
        $started = $watch.ElapsedMilliseconds
        if ((Test-Path -LiteralPath $archive) -and (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $expected) {
            Remove-Item -LiteralPath $archive -Force
        }
        if (!(Test-Path -LiteralPath $archive)) {
            Write-Host '正在下载；中断后可重新运行续传，请勿关闭此窗口。'
            Receive-EmergenceFile -Uri "$base/$asset" -Destination $partial -ExpectedHash $expected
            Move-Item -LiteralPath $partial -Destination $archive
        }
        else {
            Write-Host '已复用校验通过的下载缓存。'
        }
        [void]$events.Add(@{ stage = $stage; milliseconds = $watch.ElapsedMilliseconds - $started; bytes = (Get-Item -LiteralPath $archive).Length })
        $stage = '校验与解压'
        $started = $watch.ElapsedMilliseconds
        if ($release -and (Get-Item -LiteralPath $archive).Length -ne $release.asset.bytes) {
            throw 'Release size mismatch.'
        }
        $expanded = Test-EmergenceArchive $archive $Version
        $targetDrive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot([IO.Path]::GetFullPath($InstallRoot)))
        $tempDrive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($temporaryRoot))
        $needed = if ($targetDrive.Name -eq $tempDrive.Name) {
            2 * $expanded + 256MB
        }
        else {
            $expanded + 256MB
        }
        if ($targetDrive.AvailableFreeSpace -lt $needed -or $tempDrive.AvailableFreeSpace -lt ($expanded + 256MB)) {
            throw 'Insufficient disk space for verified installation.'
        }
        Write-Host '下载校验通过，正在解压…'
        & $tar -xf $archive -C $temporaryRoot
        if ($LASTEXITCODE -ne 0) {
            throw 'Release extraction failed.'
        }
        [void]$events.Add(@{ stage = $stage; milliseconds = $watch.ElapsedMilliseconds - $started })
        $stage = '部署与启动检查'
        $started = $watch.ElapsedMilliseconds
        $source = Join-Path $temporaryRoot "Emergence-$Version-win32-x64"
        $identity = Get-Content -LiteralPath (Join-Path $source 'release.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($identity.product -ne 'emergence' -or $identity.version -ne $Version) {
            throw 'Extracted release identity mismatch.'
        }
        $installer = if ($Update) {
            Join-Path $InstallRoot 'maintenance.ps1'
        }
        else {
            Join-Path $source 'install.ps1'
        }
        $arguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer, '-InstallRoot', $InstallRoot)
        if ($Update) {
            $arguments += @('-Action', 'update', '-Source', $source)
        }
        if ($NoPath) {
            $arguments += '-NoPath'
        }
        & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') @arguments
        if ($LASTEXITCODE -ne 0) {
            throw '安装程序失败。请查看上方阶段信息；用户配置未被清理。'
        }
        [void]$events.Add(@{ stage = $stage; milliseconds = $watch.ElapsedMilliseconds - $started })
        if (!$NoPath) {
            $env:PATH = (Join-Path $InstallRoot 'bin') + ';' + $env:PATH
            $resolved = Get-Command emergence -ErrorAction SilentlyContinue
            if (!$resolved -or [IO.Path]::GetDirectoryName($resolved.Source) -ine (Join-Path $InstallRoot 'bin')) {
                Write-Warning '当前终端存在同名命令，请重新打开终端或使用安装目录 bin 中的 emergence.cmd。'
            }
        }
        Clear-EmergenceDownloads $cache $archive
        $stage = '完成'
        Write-Host "涌现 $Version 已安装。运行 emergence；首次使用 /model-config 配置模型与 API 密钥。"
    }
    catch {
        [void]$events.Add(@{ stage = $stage; failed = $true; errorType = $_.Exception.GetType().Name })
        throw "涌现安装在【$stage】阶段失败。$($_.Exception.Message) 诊断记录：$log"
    }
    finally {
        [Net.ServicePointManager]::SecurityProtocol = $previousTls
        try {
            Assert-EmergencePath $log
            $report = @{ version = $Version; stage = $stage; elapsedMilliseconds = $watch.ElapsedMilliseconds; events = @($events); timestamp = [DateTime]::UtcNow.ToString('o') }
            [IO.File]::WriteAllText($log, ($report | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
            # Retain only the newest 20 installer diagnostics; never record URLs, credentials or environment.
            Get-ChildItem -LiteralPath $cache -Filter 'install-*.json' | Where-Object { $_.Name -match '^install-[a-f0-9]{32}\.json$' } | Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip 20 | ForEach-Object {
                Assert-EmergencePath $_.FullName
                if (!$_.PSIsContainer) {
                    Remove-Item -LiteralPath $_.FullName -Force
                }
            }
        }
        catch {
            Write-Warning '无法保存安装诊断记录。'
        }
        if ($lock) {
            $lock.Dispose()
        }
        $safeTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        $resolvedDownload = [IO.Path]::GetFullPath($temporaryRoot)
        if ($resolvedDownload.StartsWith($safeTemp, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedDownload) -match '^Emergence-download-[a-f0-9]{32}$' -and (Test-Path -LiteralPath $resolvedDownload)) {
            try {
                Assert-EmergencePath $resolvedDownload
                [IO.Directory]::Delete(('\\?\' + $resolvedDownload), $true)
            }
            catch {
                Write-Warning "解压临时目录清理失败，保留在 $resolvedDownload；下载缓存仍可复用。"
            }
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $useLatest = $Latest -or (!$PSBoundParameters.ContainsKey('Version') -and !$SignedManifest)
    Invoke-EmergenceInstall $Version ([IO.Path]::GetFullPath($InstallRoot)) $NoPath $SignedManifest $useLatest $Update
}
