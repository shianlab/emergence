param(
    [string]$BrandDirectory = (Join-Path $PSScriptRoot '../assets/brand')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# This is a pixel mask of the supplied artwork, never a glyph reconstruction.
# System.Drawing keeps this asset-preparation script dependency-free on Windows.
if (-not ('EmergenceBrand.WordmarkExtractor' -as [type])) {
    $drawingReferences = @([System.Drawing.Bitmap].Assembly.Location, [System.Drawing.Color].Assembly.Location, 'System.Collections')
    $drawingReferences += [System.Drawing.Bitmap].GetInterfaces() | ForEach-Object { $_.Assembly.Location } | Where-Object { $_ -notmatch 'System.Private.CoreLib' }
    Add-Type -ReferencedAssemblies ($drawingReferences | Select-Object -Unique) -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

namespace EmergenceBrand {
  public static class WordmarkExtractor {
    public static string Extract(string directory) {
      string source = Path.Combine(directory, "yongxian-handwritten-source.jpg");
      string output = Path.Combine(directory, "yongxian-wordmark.png");
      string preview = Path.Combine(directory, "yongxian-wordmark-preview.png");
      string manifest = Path.Combine(directory, "wordmark-extraction.json");
      foreach (string path in new [] { output, preview, manifest }) {
        if (File.Exists(path)) throw new IOException("Refusing to overwrite: " + path);
      }
      using (var photograph = new Bitmap(source)) {
        if (photograph.Width != 4096 || photograph.Height != 3072)
          throw new InvalidOperationException("Expected the original 4096 x 3072 photograph.");
        // Original photograph coordinates. Excludes the lower paper edge/table.
        int rx = 320, ry = 700, w = 3500, h = 1380, n = w * h;
        byte[] rgb;
        using (var region = photograph.Clone(new Rectangle(rx, ry, w, h), PixelFormat.Format32bppArgb)) {
          var data = region.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
          try {
            if (data.Stride != w * 4) throw new InvalidOperationException("Unexpected bitmap stride.");
            rgb = new byte[n * 4]; Marshal.Copy(data.Scan0, rgb, 0, rgb.Length);
          } finally { region.UnlockBits(data); }
        }
        var raw = new byte[n];
        for (int p = 0; p < n; p++) {
          int q = p * 4;
          int luminance = (77 * rgb[q + 2] + 150 * rgb[q + 1] + 29 * rgb[q] + 128) >> 8;
          raw[p] = (byte)(luminance < 116 ? 1 : 0);
        }
        // Remove only detached photographic specks, with 8-connected components.
        var visited = new bool[n]; var mask = new byte[n]; var queue = new int[n];
        var areas = new List<int>(); int removedComponents = 0, removedPixels = 0;
        for (int seed = 0; seed < n; seed++) {
          if (raw[seed] == 0 || visited[seed]) continue;
          int head = 0, tail = 1; queue[0] = seed; visited[seed] = true;
          while (head < tail) {
            int p = queue[head++], x = p % w, y = p / w;
            for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
              int xx = x + dx, yy = y + dy;
              if (xx < 0 || xx >= w || yy < 0 || yy >= h) continue;
              int next = yy * w + xx;
              if (raw[next] != 0 && !visited[next]) { visited[next] = true; queue[tail++] = next; }
            }
          }
          if (tail < 150) { removedComponents++; removedPixels += tail; continue; }
          areas.Add(tail);
          for (int i = 0; i < tail; i++) mask[queue[i]] = 1;
        }
        // One 3 x 3 majority pass changes the contour by at most one source pixel.
        // This cleans micro-burrs without altering scale, angle, spacing or layout.
        var clean = new byte[n]; int changedPixels = 0, intersection = 0, union = 0;
        int minX = w, minY = h, maxX = 0, maxY = 0;
        for (int y = 1; y < h - 1; y++) for (int x = 1; x < w - 1; x++) {
          int p = y * w + x, count = 0;
          for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) count += mask[p + dy * w + dx];
          clean[p] = (byte)(count >= 5 ? 1 : 0);
          if (clean[p] != mask[p]) changedPixels++;
          if (clean[p] != 0 && mask[p] != 0) intersection++;
          if (clean[p] != 0 || mask[p] != 0) union++;
          if (clean[p] == 0) continue;
          minX = Math.Min(minX, x); maxX = Math.Max(maxX, x);
          minY = Math.Min(minY, y); maxY = Math.Max(maxY, y);
        }
        if (areas.Count < 4 || union < 100000) throw new InvalidOperationException("Unexpected ink segmentation.");
        const int padding = 48;
        int left = minX - padding, top = minY - padding;
        int width = maxX - minX + 1 + 2 * padding, height = maxY - minY + 1 + 2 * padding;
        byte[] pixels = new byte[width * height * 4]; int[] weights = { 1, 2, 1 };
        for (int y = 0; y < height; y++) for (int x = 0; x < width; x++) {
          int xx = left + x, yy = top + y;
          if (xx < 2 || xx >= w - 2 || yy < 2 || yy >= h - 2) continue;
          int p = yy * w + xx, sum = 0;
          for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) sum += weights[dy + 1] * weights[dx + 1] * clean[p + dy * w + dx];
          int alpha = (sum * 255 + 8) / 16;
          if (alpha == 0) continue;
          int color = p * 4;
          if (alpha < 255) {
            // Remove pale paper contamination only at the antialiased boundary.
            int darkest = 1000;
            for (int dy = -2; dy <= 2; dy++) for (int dx = -2; dx <= 2; dx++) {
              int q = (p + dy * w + dx) * 4;
              int brightness = rgb[q] + rgb[q + 1] + rgb[q + 2];
              if (brightness < darkest) { darkest = brightness; color = q; }
            }
          }
          int target = (y * width + x) * 4;
          pixels[target] = rgb[color]; pixels[target + 1] = rgb[color + 1]; pixels[target + 2] = rgb[color + 2]; pixels[target + 3] = (byte)alpha;
        }
        using (var cutout = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
          var data = cutout.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
          try { Marshal.Copy(pixels, 0, data.Scan0, pixels.Length); } finally { cutout.UnlockBits(data); }
          cutout.Save(output, ImageFormat.Png);
          using (var card = new Bitmap(width, height, PixelFormat.Format24bppRgb)) {
            using (var graphics = Graphics.FromImage(card)) { graphics.Clear(Color.White); graphics.DrawImageUnscaled(cutout, 0, 0); }
            card.Save(preview, ImageFormat.Png);
          }
        }
        string json = "{\n" +
          "  \"source\": \"yongxian-handwritten-source.jpg\",\n" +
          "  \"sourceSha256\": \"1a37db1375bdd3f1885e7b1dc1922c423c3f876e8c08883098af89fae13b395a\",\n" +
          "  \"output\": \"yongxian-wordmark.png\",\n" +
          "  \"preview\": \"yongxian-wordmark-preview.png\",\n" +
          "  \"method\": \"Original photograph pixel mask; no generative redrawing\",\n" +
          "  \"cropInSourcePixels\": [" + (rx + left) + ", " + (ry + top) + ", " + width + ", " + height + "],\n" +
          "  \"resize\": false, \"rotate\": false, \"dewarp\": false, \"repositionCharacters\": false,\n" +
          "  \"luminanceThreshold\": 116, \"minimumComponentArea\": 150,\n" +
          "  \"retainedInkComponentAreas\": [" + string.Join(", ", areas) + "],\n" +
          "  \"removedSpeckComponents\": " + removedComponents + ", \"removedSpeckPixels\": " + removedPixels + ",\n" +
          "  \"edgeCleanup\": \"One 3x3 majority pass; 3x3 binomial alpha antialiasing; edge-only paper decontamination\",\n" +
          "  \"contourCleanupChangedPixels\": " + changedPixels + ",\n" +
          "  \"cleanedMaskIntersectionOverUnion\": " + ((double)intersection / union).ToString("R", System.Globalization.CultureInfo.InvariantCulture) + ",\n" +
          "  \"runtimeIntegrated\": false\n" + "}\n";
        File.WriteAllText(manifest, json);
        return json;
      }
    }
  }
}
'@
}

[EmergenceBrand.WordmarkExtractor]::Extract([System.IO.Path]::GetFullPath($BrandDirectory))
