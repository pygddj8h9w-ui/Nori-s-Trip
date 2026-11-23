param(
  [int]$Port = 5178,
  [switch]$Fresh
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$webRoot = Join-Path $root 'web'
$dataFile = Join-Path $PSScriptRoot 'data.json'
$codeAlphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.svg'  = 'image/svg+xml'
  '.png'  = 'image/png'
  '.ico'  = 'image/x-icon'
}

function Now-Iso { (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ss.fffZ") }

function New-Code {
  $s = ''
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $b = New-Object byte[] 8
  $rng.GetBytes($b)
  foreach ($i in $b) { $s += $codeAlphabet[$i % $codeAlphabet.Length] }
  return $s
}

function Load-Store {
  if (-not $Fresh -and (Test-Path $dataFile)) {
    $raw = [System.IO.File]::ReadAllText($dataFile, [System.Text.Encoding]::UTF8)
    if ($raw.Trim()) {
      $parsed = $raw | ConvertFrom-Json
      return @{
        trips    = [System.Collections.ArrayList]@($parsed.trips)
        points   = [System.Collections.ArrayList]@($parsed.points)
        comments = [System.Collections.ArrayList]@($parsed.comments)
      }
    }
  }
  return @{
    trips    = [System.Collections.ArrayList]::new()
    points   = [System.Collections.ArrayList]::new()
    comments = [System.Collections.ArrayList]::new()
  }
}

function Save-Store($store) {
  $payload = @{ trips = @($store.trips); points = @($store.points); comments = @($store.comments) }
  $json = $payload | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText($dataFile, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function Send-Json($ctx, $status, $object) {
  $body = [System.Text.Encoding]::UTF8.GetBytes(($object | ConvertTo-Json -Depth 8 -Compress))
  $ctx.Response.StatusCode = $status
  $ctx.Response.ContentType = 'application/json; charset=utf-8'
  $ctx.Response.ContentLength64 = $body.Length
  $ctx.Response.OutputStream.Write($body, 0, $body.Length)
}

function Send-Error($ctx, $code, $status) {
  Send-Json $ctx $status @{ error = @{ code = $code } }
}

function Read-Body($ctx) {
  $reader = New-Object System.IO.StreamReader($ctx.Request.InputStream, [System.Text.Encoding]::UTF8)
  $text = $reader.ReadToEnd()
  $reader.Close()
  if (-not $text.Trim()) { return $null }
  return $text | ConvertFrom-Json
}

function Trip-Row($store, $code) {
  return $store.trips | Where-Object { $_.code -eq $code } | Select-Object -First 1
}

function Handle-Api($ctx, $store, $path, $query) {
  $method = $ctx.Request.HttpMethod

  if ($path -eq '/api/health' -and $method -eq 'GET') { return Send-Json $ctx 200 @{ ok = $true } }

  if ($path -eq '/api/trip' -and $method -eq 'POST') {
    $body = Read-Body $ctx
    if (-not $body -or -not $body.name) { return Send-Error $ctx 'invalid_input' 400 }
    $days = if ($body.days) { [int]$body.days } else { 3 }
    $row = [ordered]@{
      code       = New-Code
      name       = [string]$body.name
      days       = [Math]::Max(1, [Math]::Min(30, $days))
      author     = if ($body.author) { [string]$body.author } else { '' }
      created_at = Now-Iso
      updated_at = Now-Iso
    }
    [void]$store.trips.Add([pscustomobject]$row)
    Save-Store $store
    return Send-Json $ctx 201 ([pscustomobject]@{ code = $row.code; name = $row.name; days = $row.days })
  }

  if ($path -eq '/api/trip' -and $method -eq 'GET') {
    $code = ($query['code'] -as [string])
    $trip = Trip-Row $store $code
    if (-not $trip) { return Send-Error $ctx 'trip_not_found' 404 }
    $points = @($store.points | Where-Object { $_.trip_code -eq $code } | Sort-Object created_at)
    $comments = @($store.comments | Where-Object { $_.trip_code -eq $code } | Sort-Object created_at)
    return Send-Json $ctx 200 @{ trip = $trip; points = $points; comments = $comments }
  }

  if ($path -match '^/api/trip/([A-Z0-9]{6,12})$' -and $method -eq 'PATCH') {
    $trip = Trip-Row $store $Matches[1]
    if (-not $trip) { return Send-Error $ctx 'trip_not_found' 404 }
    $body = Read-Body $ctx
    if ($body.name) { $trip.name = [string]$body.name }
    if ($body.days) { $trip.days = [Math]::Max(1, [Math]::Min(30, [int]$body.days)) }
    $trip.updated_at = Now-Iso
    Save-Store $store
    return Send-Json $ctx 200 $trip
  }

  if ($path -eq '/api/point' -and $method -eq 'POST') {
    $body = Read-Body $ctx
    if (-not $body -or -not $body.title -or $null -eq $body.lat -or $null -eq $body.lng) { return Send-Error $ctx 'invalid_input' 400 }
    if (-not (Trip-Row $store $body.trip_code)) { return Send-Error $ctx 'trip_not_found' 404 }
    $row = [pscustomobject][ordered]@{
      id         = [guid]::NewGuid().ToString()
      trip_code  = [string]$body.trip_code
      title      = [string]$body.title
      address    = if ($body.address) { [string]$body.address } else { '' }
      lat        = [double]$body.lat
      lng        = [double]$body.lng
      category   = if ($body.category) { [string]$body.category } else { 'sight' }
      day        = if ($null -ne $body.day) { [int]$body.day } else { 0 }
      note       = if ($body.note) { [string]$body.note } else { '' }
      cost       = if ($body.cost) { [string]$body.cost } else { '' }
      author     = if ($body.author) { [string]$body.author } else { '' }
      created_at = Now-Iso
      updated_at = Now-Iso
    }
    [void]$store.points.Add($row)
    Save-Store $store
    return Send-Json $ctx 201 @{ id = $row.id }
  }

  if ($path -match '^/api/point/([0-9a-fA-F-]{36})$') {
    $id = $Matches[1]
    $point = $store.points | Where-Object { $_.id -eq $id } | Select-Object -First 1
    if (-not $point) { return Send-Error $ctx 'not_found' 404 }
    if ($method -eq 'DELETE') {
      $store.points.Remove($point) | Out-Null
      foreach ($c in @($store.comments | Where-Object { $_.point_id -eq $id })) { $store.comments.Remove($c) | Out-Null }
      Save-Store $store
      return Send-Json $ctx 200 @{ ok = $true }
    }
    if ($method -eq 'PATCH') {
      $body = Read-Body $ctx
      foreach ($field in 'title', 'address', 'category', 'note', 'cost', 'author') {
        if ($null -ne $body.$field) { $point.$field = [string]$body.$field }
      }
      if ($null -ne $body.day) { $point.day = [int]$body.day }
      if ($null -ne $body.lat) { $point.lat = [double]$body.lat }
      if ($null -ne $body.lng) { $point.lng = [double]$body.lng }
      $point.updated_at = Now-Iso
      Save-Store $store
      return Send-Json $ctx 200 @{ ok = $true; id = $id }
    }
    return Send-Error $ctx 'not_found' 404
  }

  if ($path -eq '/api/comment' -and $method -eq 'POST') {
    $body = Read-Body $ctx
    if (-not $body -or -not $body.text -or -not $body.author) { return Send-Error $ctx 'invalid_input' 400 }
    if (-not (Trip-Row $store $body.trip_code)) { return Send-Error $ctx 'trip_not_found' 404 }
    $pointId = $null
    if ($body.point_id) {
      $point = $store.points | Where-Object { $_.id -eq [string]$body.point_id } | Select-Object -First 1
      if (-not $point) { return Send-Error $ctx 'not_found' 404 }
      $pointId = [string]$body.point_id
    }
    $row = [pscustomobject][ordered]@{
      id         = [guid]::NewGuid().ToString()
      trip_code  = [string]$body.trip_code
      point_id   = $pointId
      author     = [string]$body.author
      text       = [string]$body.text
      created_at = Now-Iso
    }
    [void]$store.comments.Add($row)
    Save-Store $store
    return Send-Json $ctx 201 @{ id = $row.id }
  }

  if ($path -match '^/api/comment/([0-9a-fA-F-]{36})$' -and $method -eq 'DELETE') {
    $comment = $store.comments | Where-Object { $_.id -eq $Matches[1] } | Select-Object -First 1
    if (-not $comment) { return Send-Error $ctx 'not_found' 404 }
    $body = Read-Body $ctx
    if ([string]$body.author -ne $comment.author) { return Send-Error $ctx 'forbidden' 403 }
    $store.comments.Remove($comment) | Out-Null
    Save-Store $store
    return Send-Json $ctx 200 @{ ok = $true }
  }

  return Send-Error $ctx 'not_found' 404
}

function Handle-Static($ctx, $path) {
  $relative = if ($path -eq '/' -or -not $path) { 'index.html' } else { $path.TrimStart('/') }
  $full = [System.IO.Path]::GetFullPath((Join-Path $webRoot $relative))
  if (-not $full.StartsWith([System.IO.Path]::GetFullPath($webRoot), [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $full -PathType Leaf)) {
    $ctx.Response.StatusCode = 404
    $ctx.Response.ContentType = 'text/plain; charset=utf-8'
    $bytes = [System.Text.Encoding]::UTF8.GetBytes('not found')
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    return
  }
  $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
  $ctx.Response.ContentType = if ($mime.ContainsKey($ext)) { $mime[$ext] } else { 'application/octet-stream' }
  if ($ext -ne '.html') { $ctx.Response.Headers.Add('Cache-Control', 'no-cache') }
  else { $ctx.Response.Headers.Add('Cache-Control', 'no-store') }
  $bytes = [System.IO.File]::ReadAllBytes($full)
  $ctx.Response.ContentLength64 = $bytes.Length
  $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
}

$store = Load-Store
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()
Write-Output ("tripmap dev server http://127.0.0.1:" + $Port + "/  data=" + $dataFile)

while ($listener.IsListening) {
  try {
    $ctx = $listener.GetContext()
    $path = $ctx.Request.Url.AbsolutePath
    $query = @{}
    foreach ($key in $ctx.Request.QueryString.AllKeys) { if ($key) { $query[$key] = $ctx.Request.QueryString[$key] } }

    try {
      if ($path -match '^(?:/functions/v1)?/app/api(/.*)?$') {
        Handle-Api $ctx $store ('/api' + $Matches[1]) $query
      } else {
        Handle-Static $ctx $path
      }
    } catch {
      try { Send-Error $ctx 'server_error' 500 } catch {}
      Write-Output ("error: " + $_.Exception.Message)
    } finally {
      $ctx.Response.Close()
    }
  } catch {
    Write-Output ("listen: " + $_.Exception.Message)
    Start-Sleep -Milliseconds 200
  }
}
