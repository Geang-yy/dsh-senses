# ocr.ps1 -- 用 Windows 自带的 OCR 把图片里的字提出来
#
# 为什么要它：截一张屏，你要的往往只是"那行报错写了什么"。
# 把整张 1920x1080 的图丢给模型，和只丢 40 个字，价钱差几十倍。
#
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 -Path shot.png
#   powershell ... -Path shot.png -Lang zh-Hans-CN
#
# 输出：识别出的文字（换行分隔）。识别不出来就输出空、退出码 0（不报错）。
# 原理：Windows.Media.Ocr，系统自带，不要网络、不要 API key。

param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$Lang = ""
)

if (-not (Test-Path $Path)) {
    Write-Error "找不到图片：$Path"
    exit 2
}

try {
    # WinRT 类型要先加载，否则后面全是"找不到类型"
    Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
    $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
    $null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]

    # 选语言：没指定就用系统的
    if ($Lang) {
        $language = New-Object Windows.Globalization.Language($Lang)
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
    } else {
        $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    }
    if ($null -eq $engine) {
        Write-Error "这台机器上没有可用的 OCR 语言包"
        exit 3
    }

    # WinRT 的异步方法在 PowerShell 里要手动等
    $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
            $_.Name -eq 'AsTask' -and
            $_.GetParameters().Count -eq 1 -and
            $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
        })[0]

    function Await($op, $type) {
        $m = $asTaskGeneric.MakeGenericMethod($type)
        $task = $m.Invoke($null, @($op))
        $task.Wait(-1) | Out-Null
        $task.Result
    }

    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync((Resolve-Path $Path).Path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

    $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

    # 按行输出，保留原文的换行结构
    foreach ($line in $result.Lines) {
        Write-Output $line.Text
    }
    exit 0
} catch {
    Write-Error ("OCR 失败：" + $_.Exception.Message)
    exit 4
}
