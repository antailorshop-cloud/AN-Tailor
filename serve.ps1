param(
  [string]$Root = (Split-Path -Parent $MyInvocation.MyCommand.Path),
  [int]$Port = 8080
)

# Minimal static file server for local development.
#
# Needed because ES modules and CORS do not work over file://. This machine
# has no Python and no Node, so this uses .NET sockets, which bind to a port
# without needing administrator rights or a URL ACL.

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath $Root).Path

$types = @{
  '.html'        = 'text/html; charset=utf-8'
  '.js'          = 'text/javascript; charset=utf-8'
  '.mjs'         = 'text/javascript; charset=utf-8'
  '.css'         = 'text/css; charset=utf-8'
  '.json'        = 'application/json; charset=utf-8'
  '.webmanifest' = 'application/manifest+json; charset=utf-8'
  '.svg'         = 'image/svg+xml'
  '.png'         = 'image/png'
  '.jpg'         = 'image/jpeg'
  '.jpeg'        = 'image/jpeg'
  '.ico'         = 'image/x-icon'
  '.txt'         = 'text/plain; charset=utf-8'
  '.woff2'       = 'font/woff2'
}

$listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Parse('127.0.0.1'), $Port)
$listener.Start()

Write-Host ''
Write-Host '  AN TAILOR - local dev server' -ForegroundColor Cyan
Write-Host '  -------------------------------------------'
Write-Host "  App   http://127.0.0.1:$Port/"
Write-Host "  Test  http://127.0.0.1:$Port/supabase/tests/"
Write-Host "  Root  $Root"
Write-Host ''
Write-Host '  Keep this window open. Press Ctrl+C to stop.' -ForegroundColor Yellow
Write-Host ''

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $stream = $client.GetStream()
      $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII)

      $requestLine = $reader.ReadLine()
      if (-not $requestLine) { continue }

      while ($true) {
        $header = $reader.ReadLine()
        if ($null -eq $header -or $header -eq '') { break }
      }

      $parts = $requestLine -split '\s+'
      if ($parts.Length -lt 2) { continue }

      $target = ($parts[1] -split '\?')[0]
      $target = [System.Uri]::UnescapeDataString($target)
      if ($target.EndsWith('/')) { $target += 'index.html' }

      $relative = $target.TrimStart('/') -replace '/', '\'
      $full = Join-Path $Root $relative

      $status = '200 OK'
      $body = $null
      $contentType = 'application/octet-stream'

      if (-not $full.StartsWith($Root, [System.StringComparison]::OrdinalIgnoreCase)) {
        $status = '403 Forbidden'
        $body = [System.Text.Encoding]::UTF8.GetBytes('Forbidden')
        $contentType = 'text/plain; charset=utf-8'
      }
      elseif (Test-Path -LiteralPath $full -PathType Leaf) {
        $body = [System.IO.File]::ReadAllBytes($full)
        $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
        if ($types.ContainsKey($ext)) { $contentType = $types[$ext] }
      }
      else {
        $status = '404 Not Found'
        $body = [System.Text.Encoding]::UTF8.GetBytes("Not found: $target")
        $contentType = 'text/plain; charset=utf-8'
      }

      $head = "HTTP/1.1 $status`r`n" +
              "Content-Type: $contentType`r`n" +
              "Content-Length: $($body.Length)`r`n" +
              "Cache-Control: no-store`r`n" +
              "Connection: close`r`n`r`n"

      $headBytes = [System.Text.Encoding]::ASCII.GetBytes($head)
      $stream.Write($headBytes, 0, $headBytes.Length)
      $stream.Write($body, 0, $body.Length)
      $stream.Flush()

      Write-Host ("  {0}  {1}" -f $status, $target) -ForegroundColor DarkGray
    }
    catch {
      Write-Host "  request failed: $_" -ForegroundColor DarkYellow
    }
    finally {
      $client.Close()
    }
  }
}
finally {
  $listener.Stop()
}
