[CmdletBinding()]
param([switch]$Write, [Parameter(Mandatory)][string]$FileList)
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$version = (Get-Content quality/toolchain.json -Raw | ConvertFrom-Json).scriptAnalyzer
Import-Module "./.quality-tools/modules/PSScriptAnalyzer/$version/PSScriptAnalyzer.psd1" -Force
$files = Get-Content -LiteralPath $FileList -Raw | ConvertFrom-Json
$failures = 0
foreach ($file in $files) {
    $source = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $file).Path)
    $tokens = $null
    $parseErrors = $null
    [Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors) | Out-Null
    if ($parseErrors) {
        $parseErrors | ForEach-Object { Write-Output "$file : $($_.Message)" }
        $failures++
        continue
    }
    $normalized = $source -replace "`r?`n", "`r`n"
    $formatted = (Invoke-Formatter -ScriptDefinition $normalized -Settings ./quality/powershell.psd1).TrimEnd()
    $formatted = [regex]::Replace($formatted, '(?m)[ \t]+(?=\r?$)', '')
    # Windows PowerShell 5.1 needs a BOM to read UTF-8 Chinese literals reliably.
    $path = (Resolve-Path -LiteralPath $file).Path
    $bytes = [IO.File]::ReadAllBytes($path)
    $bom = $bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191
    $formatted = ($formatted -replace "`r?`n", "`r`n") + "`r`n"
    if ($source -cne $formatted -or -not $bom) {
        if ($Write) {
            [IO.File]::WriteAllText($path, $formatted, [Text.UTF8Encoding]::new($true))
        }
        else {
            Write-Output "Format required: $file"; $failures++
        }
    }
    if (-not $Write) {
        $issues = @(Invoke-ScriptAnalyzer -Path $file -Settings ./quality/powershell.psd1)
        foreach ($issue in $issues) {
            Write-Output "$file`:$($issue.Line) $($issue.RuleName): $($issue.Message)"
        }
        $failures += $issues.Count
    }
}
Write-Output "$($files.Count) owned PowerShell files checked; $failures violations"
if ($failures) {
    exit 1
}
