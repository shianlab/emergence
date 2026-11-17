# Emergence 1.00 bootstrap. Downloads only this repository's versioned release.
# Review this file before running: https://github.com/shianlab/emergence/blob/main/install.ps1
[CmdletBinding()]
param(
    [string]$Version = '1.0.0',
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Emergence'),
    [switch]$NoPath
)
& {
    param([string]$Version, [string]$InstallRoot, [bool]$NoPath)
    $ErrorActionPreference = 'Stop'
    Set-StrictMode -Version 2.0
    if ($env:OS -ne 'Windows_NT' -or ![Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
        throw 'Emergence 1.00 requires Windows x64. ARM64, macOS and Linux releases are not available yet.'
    }
    if ($PSVersionTable.PSVersion -lt [version]'5.1') {
        throw 'PowerShell 5.1 or newer is required.'
    }
    if ($Version -notmatch '^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$') {
        throw 'Invalid release version.'
    }
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (!(Test-Path -LiteralPath $tar -PathType Leaf)) {
        throw 'Windows tar.exe is required. Update Windows or use the manual ZIP installation.'
    }
    $framework = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' -ErrorAction SilentlyContinue
    if (!$framework -or $framework.Release -lt 528040) {
        throw '.NET Framework 4.8 or newer is required for the native model configuration tool.'
    }

    $asset = "Emergence-$Version-win32-x64.zip"
    $base = "https://github.com/shianlab/emergence/releases/download/v$Version"
    $temporaryRoot = Join-Path ([IO.Path]::GetTempPath()) ('Emergence-download-' + [Guid]::NewGuid().ToString('N'))
    $previousProgress = $ProgressPreference
    $previousTls = [Net.ServicePointManager]::SecurityProtocol
    try {
        $ProgressPreference = 'SilentlyContinue'
        [Net.ServicePointManager]::SecurityProtocol = $previousTls -bor [Net.SecurityProtocolType]::Tls12
        New-Item -ItemType Directory -Path $temporaryRoot | Out-Null
        $archive = Join-Path $temporaryRoot $asset
        $checksum = "$archive.sha256"
        Write-Host "Downloading Emergence $Version for Windows x64..."
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset" -OutFile $archive -TimeoutSec 600
        Invoke-WebRequest -UseBasicParsing -Uri "$base/$asset.sha256" -OutFile $checksum -TimeoutSec 60
        $checksumText = (Get-Content -LiteralPath $checksum -Raw).Trim()
        $expectedPattern = '^([a-fA-F0-9]{64})\s+\*?' + [regex]::Escape($asset) + '$'
        if ($checksumText -notmatch $expectedPattern) {
            throw 'Invalid release checksum file.'
        }
        $expected = $Matches[1]
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ine $expected) {
            throw 'Download checksum mismatch. Nothing was installed.'
        }

        # Validate every archive path and size before passing the archive to Windows tar.
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        $zip = [IO.Compression.ZipFile]::OpenRead($archive)
        try {
            if ($zip.Entries.Count -lt 5 -or $zip.Entries.Count -gt 100000) {
                throw 'Invalid release archive size.'
            }
            $prefix = "Emergence-$Version-win32-x64/"
            [long]$expandedBytes = 0
            foreach ($entry in $zip.Entries) {
                $name = $entry.FullName.Replace('\', '/')
                if (!$name.StartsWith($prefix, [StringComparison]::Ordinal) -or $name.Contains(':') -or $name -match '(^|/)\.\.?(/|$)' -or $name.Contains([char]0)) {
                    throw 'Unsafe release archive path.'
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
        }
        finally {
            $zip.Dispose()
        }
        Write-Host 'Checksum verified. Installing for the current user...'
        & $tar -xf $archive -C $temporaryRoot
        if ($LASTEXITCODE -ne 0) {
            throw 'Release extraction failed.'
        }
        $installer = Join-Path $temporaryRoot "Emergence-$Version-win32-x64\install.ps1"
        $arguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer, '-InstallRoot', $InstallRoot)
        if ($NoPath) {
            $arguments += '-NoPath'
        }
        & (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') @arguments
        if ($LASTEXITCODE -ne 0) {
            throw 'Installation failed. The previous installation and user data are retained.'
        }
        if (!$NoPath) {
            $env:PATH = (Join-Path $InstallRoot 'bin') + ';' + $env:PATH
        }
        Write-Host "Emergence $Version installed. Run: emergence"
        Write-Host 'First run: /model-config to configure your model and API key.'
    }
    finally {
        $ProgressPreference = $previousProgress
        [Net.ServicePointManager]::SecurityProtocol = $previousTls
        # Only this invocation's newly created download directory may be removed.
        $safeTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        $resolvedDownload = [IO.Path]::GetFullPath($temporaryRoot)
        if ($resolvedDownload.StartsWith($safeTemp, [StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedDownload) -match '^Emergence-download-[a-f0-9]{32}$' -and (Test-Path -LiteralPath $resolvedDownload)) {
            # .NET's literal extended path handles npm's deep tree on Windows PowerShell 5.1.
            # The directory is a fresh UUID owned by this invocation and the archive rejects links.
            try {
                [IO.Directory]::Delete(('\\?\' + $resolvedDownload), $true)
            }
            catch {
                Write-Warning "Installation files retained at $resolvedDownload; cleanup failed: $($_.Exception.Message)"
            }
        }
    }
} $Version $InstallRoot $NoPath
