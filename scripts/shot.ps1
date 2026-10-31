# shot.ps1 -- 截一张图，返回路径（给 dsh-senses 的眼睛用）
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File shot.ps1
#   powershell ... -Active                      # 只截当前窗口
#   powershell ... -Region left|right|top|bottom # 只截半个屏（带鱼屏用）
#   powershell ... -X 0 -Y 0 -W 2560 -H 1440    # 自己指定矩形
#
# 为什么要 Region：5120x1440 的屏整个截下来缩到 1280 宽，高度只剩 360，
# 字全糊成一片。只截半屏，同样的宽度下字大两倍。

param(
    [int]$Width = 1280,
    [string]$OutDir = "",
    [switch]$Active,
    [string]$Region = "",
    [int]$X = -2147483648,
    [int]$Y = -2147483648,
    [int]$W = 0,
    [int]$H = 0
)

# 输出必须是 UTF-8 -- Node 那边按 utf8 读，PowerShell 默认吐系统代码页，中文会全变成乱码
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

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
    $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $rect = New-Object System.Drawing.Rectangle($screen.X, $screen.Y, $screen.Width, $screen.Height)

    # 自己指定了矩形
    if ($W -gt 0 -and $H -gt 0) {
        $rx = if ($X -ne -2147483648) { $X } else { $screen.X }
        $ry = if ($Y -ne -2147483648) { $Y } else { $screen.Y }
        $rect = New-Object System.Drawing.Rectangle($rx, $ry, $W, $H)
    }
    elseif ($Region) {
        $hw = [int]($screen.Width / 2)
        $hh = [int]($screen.Height / 2)
        switch ($Region.ToLower()) {
            "left"   { $rect = New-Object System.Drawing.Rectangle($screen.X, $screen.Y, $hw, $screen.Height) }
            "right"  { $rect = New-Object System.Drawing.Rectangle(($screen.X + $hw), $screen.Y, $hw, $screen.Height) }
            "top"    { $rect = New-Object System.Drawing.Rectangle($screen.X, $screen.Y, $screen.Width, $hh) }
            "bottom" { $rect = New-Object System.Drawing.Rectangle($screen.X, ($screen.Y + $hh), $screen.Width, $hh) }
            default  { }
        }
    }
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

$tag = if ($Active) { "win" } elseif ($Region) { "r-$Region" } else { "screen" }
$name = "look-$tag-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".png"
$path = Join-Path $OutDir $name
$shot.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
$shot.Dispose()

Write-Output $path
