# Developer tools only. Does not change the application's Python environment or system modules.
[CmdletBinding()]
param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')
$sdk = (Get-Content global.json -Raw | ConvertFrom-Json).sdk.version
if ((& dotnet --version) -ne $sdk) {
    throw "Install .NET SDK $sdk for source formatting."
}
if (-not (Test-Path '.quality-tools/python/Scripts/python.exe')) {
    & $Python -I -m venv .quality-tools/python
    if ($LASTEXITCODE -ne 0) {
        throw 'Cannot create the isolated quality environment.'
    }
}
& .quality-tools/python/Scripts/python.exe -I -m pip install --require-hashes --only-binary=:all: -r quality/requirements.txt
if ($LASTEXITCODE -ne 0) {
    throw 'Cannot install the locked Python checker.'
}
$version = (Get-Content quality/toolchain.json -Raw | ConvertFrom-Json).scriptAnalyzer
Save-Module -Name PSScriptAnalyzer -RequiredVersion $version -Path .quality-tools/modules -Repository PSGallery -Force
Write-Output 'Development quality tools are ready. Run npm run check.'
