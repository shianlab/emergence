param([Parameter(Mandatory=$true)][string]$Request)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$spec = Get-Content -LiteralPath $Request -Raw -Encoding UTF8 | ConvertFrom-Json
foreach ($label in $spec.labels) {
    $bitmap = New-Object System.Drawing.Bitmap([int]$spec.width, [int]$spec.height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $font = New-Object System.Drawing.Font('Cascadia Mono', [single]$spec.fontPixels, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#a3a3a3'))
    $format = [System.Drawing.StringFormat]::GenericTypographic.Clone()
    try {
        $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml('#111111'))
        $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $format.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
        $format.LineAlignment = [System.Drawing.StringAlignment]::Center
        $format.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter
        $rect = New-Object System.Drawing.RectangleF(0, 0, $bitmap.Width, $bitmap.Height)
        $graphics.DrawString([string]$label.text, $font, $brush, $rect, $format)
        $bitmap.Save([string]$label.path, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $format.Dispose(); $brush.Dispose(); $font.Dispose(); $graphics.Dispose(); $bitmap.Dispose() }
}
