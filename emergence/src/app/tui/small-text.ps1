$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing
while ($null -ne ($line = [Console]::ReadLine())) {
    try {
        $request = $line | ConvertFrom-Json
        $results = @()
        foreach ($label in $request.labels) {
            $bitmap = New-Object System.Drawing.Bitmap([int]$label.width, [int]$label.height)
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            $font = New-Object System.Drawing.Font('Cascadia Mono', [single]$label.fontPixels, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
            $brush = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml([string]$label.foreground))
            $format = [System.Drawing.StringFormat]::GenericTypographic.Clone()
            $stream = New-Object System.IO.MemoryStream
            try {
                $graphics.Clear([System.Drawing.ColorTranslator]::FromHtml([string]$label.background))
                $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
                $format.FormatFlags = [System.Drawing.StringFormatFlags]::NoWrap
                $format.LineAlignment = [System.Drawing.StringAlignment]::Center
                $format.Trimming = [System.Drawing.StringTrimming]::EllipsisCharacter
                $rect = New-Object System.Drawing.RectangleF(0, 0, $bitmap.Width, $bitmap.Height)
                $graphics.DrawString([string]$label.text, $font, $brush, $rect, $format)
                $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
                $results += @{ id = $label.id; png = [Convert]::ToBase64String($stream.ToArray()) }
            }
            finally {
                $stream.Dispose()
                $format.Dispose()
                $brush.Dispose()
                $font.Dispose()
                $graphics.Dispose()
                $bitmap.Dispose()
            }
        }
        [Console]::WriteLine((ConvertTo-Json -Compress -Depth 4 -InputObject @{ labels = $results }))
    }
    catch {
        # Do not echo UI text, paths or exception messages into the terminal.
        [Console]::WriteLine('{"error":true}')
    }
}
