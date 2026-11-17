param(
    [string]$BrandDirectory = (Join-Path $PSScriptRoot '../assets/brand'),
    [ValidateSet('fine', 'balanced', 'bold')][string]$Show
)

$ErrorActionPreference = 'Stop'
$pixelDirectory = Join-Path $BrandDirectory 'pixel'
if ($Show) {
    $wordmark = Get-Content -LiteralPath (Join-Path $pixelDirectory "yongxian-pixel-$Show.txt") -Raw -Encoding UTF8
    $escape = [char]27
    [Console]::Write("${escape}[38;2;230;227;220m${escape}[48;2;12;14;17m$wordmark${escape}[0m")
    return
}

Add-Type -AssemblyName System.Drawing
if (-not ('EmergenceBrand.TerminalWordmark' -as [type])) {
    $drawingReferences = @([System.Drawing.Bitmap].Assembly.Location, [System.Drawing.Color].Assembly.Location, 'System.Collections')
    $drawingReferences += [System.Drawing.Bitmap].GetInterfaces() | ForEach-Object { $_.Assembly.Location } | Where-Object { $_ -notmatch 'System.Private.CoreLib' }
    Add-Type -ReferencedAssemblies ($drawingReferences | Select-Object -Unique) -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace EmergenceBrand {
  public static class TerminalWordmark {
    static readonly Color Background = Color.FromArgb(12, 14, 17);
    static readonly Color Foreground = Color.FromArgb(230, 227, 220);
    public static string Build(string directory) {
      string destination = Path.Combine(directory, "pixel");
      if (Directory.Exists(destination) && Directory.GetFileSystemEntries(destination).Length > 0)
        throw new IOException("Refusing to overwrite existing pixel assets: " + destination);
      Directory.CreateDirectory(destination);
      using (var source = new Bitmap(Path.Combine(directory, "yongxian-wordmark.png"))) {
        int sw = source.Width, sh = source.Height;
        byte[] rgba = new byte[sw * sh * 4];
        var locked = source.LockBits(new Rectangle(0, 0, sw, sh), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try {
          if (locked.Stride != sw * 4) throw new InvalidOperationException("Unexpected bitmap stride.");
          Marshal.Copy(locked.Scan0, rgba, 0, rgba.Length);
        } finally { source.UnlockBits(locked); }
        var metadata = new List<string>();
        string[] ids = { "fine", "balanced", "bold" };
        string[] titles = { "01   细颗粒", "02   均衡", "03   粗颗粒" };
        string[] notes = { "保留更多原稿细节", "笔势与像素感兼顾", "更强的方块颗粒感" };
        int[] widths = { 128, 96, 72 }, scales = { 9, 12, 16 };
        using (var comparison = new Bitmap(1280, 1890, PixelFormat.Format24bppRgb))
        using (var canvas = Graphics.FromImage(comparison))
        using (var ink = new SolidBrush(Foreground))
        using (var muted = new SolidBrush(Color.FromArgb(144, 151, 160)))
        using (var rule = new Pen(Color.FromArgb(43, 48, 55)))
        using (var heading = new Font("Microsoft YaHei UI", 28, FontStyle.Bold, GraphicsUnit.Pixel))
        using (var label = new Font("Microsoft YaHei UI", 23, FontStyle.Regular, GraphicsUnit.Pixel))
        using (var small = new Font("Microsoft YaHei UI", 18, FontStyle.Regular, GraphicsUnit.Pixel)) {
          canvas.Clear(Background);
          canvas.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
          canvas.DrawString("涌现 · 终端 Logo 像素预览", heading, ink, 64, 26);
          canvas.DrawString("同一份手写原稿采样 · 单色块字符 · 等宽对比", small, muted, 64, 76);
          for (int variant = 0; variant < ids.Length; variant++) {
            int cols = widths[variant], scale = scales[variant];
            double step = (double)sw / cols;
            int rows = (int)Math.Ceiling(sh / step);
            if (rows % 2 != 0) rows++;
            var grid = new bool[rows, cols];
            int filled = 0;
            // Area sampling on the source alpha, with a shared square-pixel scale.
            // No per-character repositioning, outline editing or glyph substitution.
            for (int y = 0; y < rows; y++) for (int x = 0; x < cols; x++) {
              double x0 = x * step, x1 = (x + 1) * step;
              double y0 = y * step, y1 = (y + 1) * step, alphaSum = 0;
              for (int yy = (int)y0; yy < Math.Min(sh, (int)Math.Ceiling(y1)); yy++) {
                double dy = Math.Min(yy + 1, y1) - Math.Max(yy, y0);
                for (int xx = (int)x0; xx < Math.Min(sw, (int)Math.Ceiling(x1)); xx++) {
                  double dx = Math.Min(xx + 1, x1) - Math.Max(xx, x0);
                  alphaSum += rgba[(yy * sw + xx) * 4 + 3] * dx * dy;
                }
              }
              grid[y, x] = alphaSum / (255 * step * step) >= 0.42;
              if (grid[y, x]) filled++;
            }
            // Half-blocks encode two square pixels into one terminal character cell.
            var text = new StringBuilder();
            for (int y = 0; y < rows; y += 2) {
              for (int x = 0; x < cols; x++) {
                bool upper = grid[y, x], lower = grid[y + 1, x];
                text.Append(upper ? lower ? '\u2588' : '\u2580' : lower ? '\u2584' : ' ');
              }
              text.Append('\n');
            }
            string name = "yongxian-pixel-" + ids[variant];
            File.WriteAllText(Path.Combine(destination, name + ".txt"), text.ToString());
            int sectionY = 128 + variant * 580;
            canvas.DrawLine(rule, 64, sectionY, 1216, sectionY);
            canvas.DrawString(titles[variant], label, ink, 64, sectionY + 18);
            canvas.DrawString(cols + " 列 / " + (rows / 2) + " 行     ·     " + notes[variant], small, muted, 760, sectionY + 23);
            using (var logo = new Bitmap(cols * scale, rows * scale, PixelFormat.Format32bppArgb))
            using (var pixels = Graphics.FromImage(logo)) {
              pixels.Clear(Color.Transparent);
              pixels.SmoothingMode = SmoothingMode.None;
              for (int y = 0; y < rows; y++) for (int x = 0; x < cols; x++)
                if (grid[y, x]) pixels.FillRectangle(ink, x * scale, y * scale, scale, scale);
              logo.Save(Path.Combine(destination, name + ".png"), ImageFormat.Png);
              canvas.DrawImageUnscaled(logo, 64, sectionY + 78);
            }
            metadata.Add("    {\"id\":\"" + ids[variant] + "\",\"columns\":" + cols + ",\"pixelRows\":" + rows + ",\"terminalRows\":" + (rows / 2) + ",\"pngPixelScale\":" + scale + ",\"occupiedPixels\":" + filled + "}");
          }
          comparison.Save(Path.Combine(destination, "yongxian-pixel-comparison.png"), ImageFormat.Png);
        }
        string json = "{\n  \"source\":\"../yongxian-wordmark.png\",\n  \"method\":\"Square-grid area sampling of original alpha; terminal half-block encoding\",\n  \"coverageThreshold\":0.42,\n  \"foreground\":\"#e6e3dc\",\n  \"previewBackground\":\"#0c0e11\",\n  \"variants\":[\n" + string.Join(",\n", metadata) + "\n  ],\n  \"notes\":\"Preview PNGs use the same binary grid as the TXT assets. Terminal appearance depends on font cell ratio and line spacing. Original master is unchanged.\",\n  \"runtimeIntegrated\":false\n}\n";
        File.WriteAllText(Path.Combine(destination, "pixel-wordmark.json"), json);
        return json;
      }
    }
  }
}
'@
}

[EmergenceBrand.TerminalWordmark]::Build([System.IO.Path]::GetFullPath($BrandDirectory))
