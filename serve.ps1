# 房屋修圖器 - 本機測試伺服器 (port 8080)
# 用法：雙擊 start.bat
# 若出現「拒絕存取」無法對外監聽(手機連線)，會自動退回只允許本機 localhost。
# 想讓同網路手機也能連，用「系統管理員」開 PowerShell 執行一次：
#   netsh http add urlacl url=http://+:8080/ user=Everyone
# 並允許防火牆 8080。
# COOP/COEP 標頭用來啟用 WASM 多執行緒；若 CDN 載入壞掉，請刪除 COEP 那行。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$port = 8080

$mime = @{
  '.html' = 'text/html; charset=utf-8'; '.htm' = 'text/html; charset=utf-8'
  '.js' = 'text/javascript; charset=utf-8'; '.mjs' = 'text/javascript; charset=utf-8'
  '.css' = 'text/css; charset=utf-8'; '.json' = 'application/json; charset=utf-8'
  '.webmanifest' = 'application/manifest+json'; '.wasm' = 'application/wasm'
  '.onnx' = 'application/octet-stream'; '.png' = 'image/png'; '.svg' = 'image/svg+xml'
  '.jpg' = 'image/jpeg'; '.jpeg' = 'image/jpeg'; '.ico' = 'image/x-icon'; '.txt' = 'text/plain; charset=utf-8'
}

$listener = New-Object System.Net.HttpListener
$lan = $true
try {
  $listener.Prefixes.Add("http://+:$port/")
  $listener.Start()
} catch {
  $lan = $false
  $listener = New-Object System.Net.HttpListener
  $listener.Prefixes.Add("http://localhost:$port/")
  $listener.Start()
}

Write-Host ''
Write-Host "本機網址:  http://localhost:$port/"
if ($lan) {
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    ForEach-Object { Write-Host "手機同 Wi-Fi: http://$($_.IPAddress):$port/" }
  Write-Host '(手機用 http 無法安裝成 App，僅供預覽；正式使用請放上 HTTPS 空間，見 README)'
} else {
  Write-Host '只能本機使用 (無法對外監聽，見 serve.ps1 開頭說明)'
}
Write-Host '按 Ctrl+C 結束'

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
    if ($rel -eq '') { $rel = 'index.html' }
    $full = [System.IO.Path]::GetFullPath((Join-Path $root $rel))
    $res = $ctx.Response
    $res.Headers.Add('Cross-Origin-Opener-Policy', 'same-origin')
    $res.Headers.Add('Cross-Origin-Embedder-Policy', 'credentialless')
    $res.Headers.Add('Cache-Control', 'no-cache')
    if (-not $full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
      $res.StatusCode = 404
      $b = [Text.Encoding]::UTF8.GetBytes('404 Not Found')
      $res.OutputStream.Write($b, 0, $b.Length)
    } else {
      $ext = [System.IO.Path]::GetExtension($full).ToLower()
      $res.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    }
  } catch {
    Write-Host "錯誤: $_"
  } finally {
    try { $ctx.Response.OutputStream.Close() } catch {}
  }
}
