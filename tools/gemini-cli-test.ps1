# 房屋修圖器 - Gemini 一鍵清除 API 實測（電腦端）
# 用法（專案根目錄）：
#   powershell -ExecutionPolicy Bypass -File tools\gemini-cli-test.ps1
#   powershell -ExecutionPolicy Bypass -File tools\gemini-cli-test.ps1 -Image test-photos\xxx.jpg -Size 1K -Model gemini-3.1-flash-image
# 金鑰從專案根目錄的 .gemini-key 讀取（已 gitignore），本腳本絕不印出金鑰。
# 指令文字從 engine/gemini.js 的 /*PROMPT_START*/ ... /*PROMPT_END*/ 之間擷取，和網頁版保持一致。
# 請求格式與 engine/gemini.js 完全相同：v1 generateContent → v1beta generateContent → v1beta interactions。

param(
  [string]$Image = 'test-photos\bedroom-before.jpg',
  [string]$Model = '',
  [ValidateSet('1K', '2K', '4K')][string]$Size = '2K',
  [int]$TimeoutSec = 180
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Web.Extensions

$Root = Split-Path -Parent $PSScriptRoot
$ApiRoot = 'https://generativelanguage.googleapis.com'

# ---- 金鑰 ----
$keyFile = Join-Path $Root '.gemini-key'
if (-not (Test-Path $keyFile)) { Write-Host "找不到 $keyFile（請把 API 金鑰存成這個檔案，只放一行）" -ForegroundColor Red; exit 1 }
$ApiKey = ([IO.File]::ReadAllText($keyFile)).Trim()
if (-not $ApiKey) { Write-Host '.gemini-key 是空的' -ForegroundColor Red; exit 1 }
Write-Host ("金鑰：已讀取（長度 {0}）" -f $ApiKey.Length)

# ---- 從 gemini.js 擷取指令與預設模型 ----
$jsPath = Join-Path $Root 'engine\gemini.js'
$js = [IO.File]::ReadAllText($jsPath, [Text.Encoding]::UTF8)
$m1 = '/*PROMPT_START*/'; $m2 = '/*PROMPT_END*/'
$i1 = $js.IndexOf($m1); $i2 = $js.IndexOf($m2)
if ($i1 -lt 0 -or $i2 -le $i1) { Write-Host '在 gemini.js 找不到 PROMPT_START / PROMPT_END 標記' -ForegroundColor Red; exit 1 }
$Prompt = $js.Substring($i1 + $m1.Length, $i2 - $i1 - $m1.Length).Trim()
$Prompt = $Prompt.Trim([char]0x60)               # 去掉反引號
$Prompt = ($Prompt -replace '\s+', ' ').Trim()   # 與 JS 的 .replace(/\s+/g,' ').trim() 相同
if (-not $Model) {
  $mm = [regex]::Match($js, "GEMINI_MODEL_DEFAULT\s*=\s*'([^']+)'")
  $Model = if ($mm.Success) { $mm.Groups[1].Value } else { 'gemini-nano-banana-2.1' }
}
Write-Host ("指令：{0} 字元，開頭：{1}..." -f $Prompt.Length, $Prompt.Substring(0, [Math]::Min(70, $Prompt.Length)))

# ---- 圖片：縮到長邊 2048（4K 時 3072），JPEG 品質 92，與 gemini.js 相同 ----
$imgPath = if ([IO.Path]::IsPathRooted($Image)) { $Image } else { Join-Path $Root $Image }
$src = [Drawing.Image]::FromFile($imgPath)
$W = $src.Width; $H = $src.Height
$maxSide = if ($Size -eq '4K') { 3072 } else { 2048 }
$s = [Math]::Min(1.0, $maxSide / [Math]::Max($W, $H))
$sw = [int][Math]::Round($W * $s); $sh = [int][Math]::Round($H * $s)
$bmp = New-Object Drawing.Bitmap $sw, $sh
$g = [Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($src, 0, 0, $sw, $sh)
$g.Dispose(); $src.Dispose()
$enc = [Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object Drawing.Imaging.EncoderParameter ([Drawing.Imaging.Encoder]::Quality), ([long]92)
$ms = New-Object IO.MemoryStream
$bmp.Save($ms, $enc, $ep); $bmp.Dispose()
$b64 = [Convert]::ToBase64String($ms.ToArray()); $ms.Dispose()

# 最接近的長寬比（與 gemini.js 的 RATIOS 相同）
$ratios = @(@('1:1', 1.0), @('4:3', (4 / 3)), @('3:4', (3 / 4)), @('3:2', (3 / 2)), @('2:3', (2 / 3)), @('5:4', (5 / 4)), @('4:5', (4 / 5)),
  @('16:9', (16 / 9)), @('9:16', (9 / 16)), @('21:9', (21 / 9)), @('4:1', 4.0), @('1:4', (1 / 4)), @('8:1', 8.0), @('1:8', (1 / 8)))
$r = $W / $H; $Aspect = '1:1'; $best = [double]::MaxValue
foreach ($x in $ratios) { $e = [Math]::Abs([Math]::Log($x[1] / $r)); if ($e -lt $best) { $best = $e; $Aspect = $x[0] } }
Write-Host ("原圖 {0}x{1} → 送出 {2}x{3} JPEG {4} KB，要求 {5} {6}，模型 {7}" -f $W, $H, $sw, $sh, [int]($b64.Length * 3 / 4 / 1024), $Size, $Aspect, $Model)

# ---- 請求（與 gemini.js buildGenerateContentBody / buildInteractionsBody 相同） ----
$gcBody = @{
  contents         = @(@{ role = 'user'; parts = @(@{ text = $Prompt }, @{ inline_data = @{ mime_type = 'image/jpeg'; data = $b64 } }) })
  generationConfig = @{ responseModalities = @('IMAGE'); imageConfig = @{ aspectRatio = $Aspect; imageSize = $Size } }
}
$iaBody = @{
  model           = $Model
  input           = @(@{ type = 'text'; text = $Prompt }, @{ type = 'image'; mime_type = 'image/jpeg'; data = $b64 })
  response_format = @{ type = 'image'; aspect_ratio = $Aspect; image_size = $Size }
}
$attempts = @(
  @{ name = 'v1 generateContent'; url = "$ApiRoot/v1/models/$($Model):generateContent"; body = $gcBody },
  @{ name = 'v1beta generateContent'; url = "$ApiRoot/v1beta/models/$($Model):generateContent"; body = $gcBody },
  @{ name = 'v1beta interactions'; url = "$ApiRoot/v1beta/interactions"; body = $iaBody }
)

$ser = New-Object System.Web.Script.Serialization.JavaScriptSerializer
$ser.MaxJsonLength = [int]::MaxValue

function Find-Images($o, $list) {
  if ($null -eq $o) { return }
  if ($o -is [System.Collections.IDictionary]) {
    if ($o.ContainsKey('thought') -and $o['thought'] -eq $true) { return }
    if ($o.ContainsKey('inlineData')) { $list.Add(@($o['inlineData']['data'], $o['inlineData']['mimeType'])) | Out-Null }
    elseif ($o.ContainsKey('inline_data')) { $list.Add(@($o['inline_data']['data'], $o['inline_data']['mime_type'])) | Out-Null }
    elseif ($o.ContainsKey('type') -and $o['type'] -eq 'image' -and $o.ContainsKey('data')) { $list.Add(@($o['data'], $o['mime_type'])) | Out-Null }
    foreach ($k in @($o.Keys)) { $v = $o[$k]; if ($v -is [System.Collections.IDictionary] -or $v -is [array]) { Find-Images $v $list } }
  }
  elseif ($o -is [array]) { foreach ($v in $o) { Find-Images $v $list } }
}

$sw0 = [Diagnostics.Stopwatch]::StartNew()
foreach ($a in $attempts) {
  $json = $ser.Serialize($a.body)
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  Write-Host ("POST {0}（{1} KB）..." -f $a.url.Replace($ApiRoot, ''), [int]($bytes.Length / 1024))
  $t = [Diagnostics.Stopwatch]::StartNew()
  $status = 0; $content = $null
  try {
    $resp = Invoke-WebRequest -Uri $a.url -Method Post -UseBasicParsing -TimeoutSec $TimeoutSec `
      -Headers @{ 'x-goog-api-key' = $ApiKey } -ContentType 'application/json; charset=utf-8' -Body $bytes
    $status = [int]$resp.StatusCode; $content = $resp.Content
  }
  catch {
    $ex = $_.Exception
    if ($ex.Response) {
      $status = [int]$ex.Response.StatusCode
      if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $content = $_.ErrorDetails.Message }
      else { try { $rd = New-Object IO.StreamReader($ex.Response.GetResponseStream()); $content = $rd.ReadToEnd() } catch { $content = '' } }
    }
    else { Write-Host ("連線失敗：{0}" -f $ex.Message) -ForegroundColor Red; exit 2 }
  }
  $t.Stop()
  Write-Host ("  HTTP {0}，{1:N1} 秒，回應 {2} KB" -f $status, $t.Elapsed.TotalSeconds, [int]($content.Length / 1024))
  $obj = $null; try { $obj = $ser.DeserializeObject($content) } catch {}
  if ($status -ne 200) {
    $msg = if ($obj -and $obj['error']) { "$($obj['error']['status']): $($obj['error']['message'])" } else { $content.Substring(0, [Math]::Min(400, $content.Length)) }
    Write-Host "  錯誤：$msg" -ForegroundColor Yellow
    if ($status -eq 404 -or ($status -eq 400 -and $msg -match 'Unknown name|Invalid JSON payload|Cannot find field|not supported|invalid value at|unknown field')) {
      Write-Host '  → 改試下一種端點'; continue
    }
    exit 3
  }
  $imgs = New-Object System.Collections.ArrayList
  Find-Images $obj $imgs
  $usedModel = if ($obj['modelVersion']) { $obj['modelVersion'] } elseif ($obj['model']) { $obj['model'] } else { $Model }
  if ($imgs.Count -eq 0) {
    $fr = ''; try { $fr = $obj['candidates'][0]['finishReason'] } catch {}
    $br = ''; try { $br = $obj['promptFeedback']['blockReason'] } catch {}
    Write-Host ("沒有回傳圖片：finishReason={0} blockReason={1}" -f $fr, $br) -ForegroundColor Red
    Write-Host $content.Substring(0, [Math]::Min(800, $content.Length))
    exit 4
  }
  $last = $imgs[$imgs.Count - 1]
  $mime = if ($last[1]) { $last[1] } else { 'image/png' }
  $ext = if ($mime -match 'jpe?g') { 'jpg' } elseif ($mime -match 'webp') { 'webp' } else { 'png' }
  $outBytes = [Convert]::FromBase64String($last[0])
  $outPath = Join-Path $Root ("test-photos\out-{0}.{1}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'), $ext)
  [IO.File]::WriteAllBytes($outPath, $outBytes)
  $dim = ''
  try { $oms = New-Object IO.MemoryStream(, $outBytes); $oi = [Drawing.Image]::FromStream($oms); $dim = "$($oi.Width)x$($oi.Height)"; $oi.Dispose(); $oms.Dispose() } catch {}
  $sw0.Stop()
  Write-Host ''
  Write-Host ("成功  HTTP {0}  端點 {1}  模型 {2}" -f $status, $a.name, $usedModel) -ForegroundColor Green
  Write-Host ("輸出 {0} {1}，{2} KB → {3}" -f $dim, $mime, [int]($outBytes.Length / 1024), $outPath)
  Write-Host ("API 耗時 {0:N1} 秒（含退回嘗試總計 {1:N1} 秒）" -f $t.Elapsed.TotalSeconds, $sw0.Elapsed.TotalSeconds)
  if ($obj['usageMetadata']) {
    $u = $obj['usageMetadata']
    Write-Host ("tokens：prompt={0} candidates={1} thoughts={2} total={3}" -f $u['promptTokenCount'], $u['candidatesTokenCount'], $u['thoughtsTokenCount'], $u['totalTokenCount'])
  }
  exit 0
}
Write-Host '所有端點都失敗' -ForegroundColor Red
exit 5
