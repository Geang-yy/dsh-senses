# shot.ps1 -- 截一张图，返回路径（给 dsh-look 插件用）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File shot.ps1 [-Active] [-Width 1280] [-OutDir <dir>]

param(
    [int]$Width = 1280,
    [string]$OutDir = "",
    [switch]$Active
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

if (-not $OutDir) {
    $OutDir = Join-Path $env:USERPROFILE ".dsh\look\shots"
}
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

$rect = $null

if ($Active) {
    $sig = @"
using System;
using System.Runtime.InteropServices;
public class ForegroundWin {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
"@
    try {
        Add-Type -TypeDefinition $sig -ErrorAction Stop
        $h = [ForegroundWin]::GetForegroundWindow()
        $r = New-Object ForegroundWin+RECT
        if ([ForegroundWin]::GetWindowRect($h, [ref]$r)) {
            $w = $r.Right - $r.Left
            $hh = $r.Bottom - $r.Top
            if ($w -gt 200 -and $hh -gt 150) {
                $rect = New-Object System.Drawing.Rectangle($r.Left, $r.Top, $w, $hh)
            }
        }
    } catch { }
}

if ($null -eq $rect) {
    $rect = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
}

$shot = New-Object System.Drawing.Bitmap($rect.Width, $rect.Height)
$g = [System.Drawing.Graphics]::FromImage($shot)
$g.CopyFromScreen($rect.X, $rect.Y, 0, 0, $shot.Size)
$g.Dispose()

if ($rect.Width -gt $Width) {
    $ratio = $Width / $rect.Width
    $newW = [int]$Width
    $newH = [int]($rect.Height * $ratio)
    $small = New-Object System.Drawing.Bitmap($newW, $newH)
    $gg = [System.Drawing.Graphics]::FromImage($small)
    $gg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $gg.DrawImage($shot, 0, 0, $newW, $newH)
    $gg.Dispose()
    $shot.Dispose()
    $shot = $small
}

$tag = if ($Active) { "win" } else { "screen" }
$name = "look-$tag-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".png"
$path = Join-Path $OutDir $name
$shot.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$shot.Dispose()

Write-Output $path
