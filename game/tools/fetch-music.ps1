<#
.SYNOPSIS
  Add a folder of downloaded tracks to one playlist in game/public/music: convert to OGG, update
  playlist.json and regenerate CREDITS.md.
.DESCRIPTION
  Downloads happen in the browser (itch.io, OpenGameArt and FMA need a click). Put one playlist's
  files in one folder, optionally with a tracks.csv next to them:
      file,title,artist,license,url
      Skank the Summer 01.wav,Skank the Summer,DavidKBD,CC BY 4.0,https://davidkbd.itch.io/...
  Then:  .\tools\fetch-music.ps1 -Source "$env:USERPROFILE\Downloads\house" -Playlist "Melodic house"
  The game's built-in playlists are "Ska-punk", "Melodic house", "Metal" and "Lofi hip-hop"; any other
  name becomes an extra playlist (heard under Shuffle all). The named playlist is replaced, the
  others are kept. Only ship CC0 or CC BY tracks, and fill in tracks.csv so the credits are right.
  Needs ffmpeg on PATH (winget install Gyan.FFmpeg).
#>
param(
  [Parameter(Mandatory = $true)] [string] $Source,
  [Parameter(Mandatory = $true)] [string] $Playlist,
  [string] $Out = (Join-Path $PSScriptRoot "..\public\music"),
  [int] $Kbps = 144
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { throw "ffmpeg not found on PATH (winget install Gyan.FFmpeg)" }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$meta = @{}
$csv = Join-Path $Source 'tracks.csv'
if (Test-Path $csv) { Import-Csv $csv | ForEach-Object { $meta[$_.file] = $_ } }
$prefix = ($Playlist.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')

# existing playlists (old flat list = Ska-punk)
$lists = [ordered]@{}
$pj = Join-Path $Out 'playlist.json'
if (Test-Path $pj) {
  $raw = Get-Content $pj -Raw | ConvertFrom-Json
  if ($raw -is [array]) { $lists['Ska-punk'] = @($raw) }
  elseif ($raw.playlists) { $raw.playlists.PSObject.Properties | ForEach-Object { $lists[$_.Name] = @($_.Value) } }
}

$tracks = @()
Get-ChildItem $Source -Include *.wav, *.mp3, *.ogg, *.flac, *.m4a -File -Recurse | Sort-Object Name | ForEach-Object {
  $base = [IO.Path]::GetFileNameWithoutExtension($_.Name)
  $slug = "$prefix-" + ($base.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
  $dest = Join-Path $Out "$slug.ogg"
  Write-Host "  $($_.Name) -> $slug.ogg"
  & ffmpeg -y -loglevel error -i $_.FullName -vn -c:a libvorbis -b:a "${Kbps}k" $dest
  $m = $meta[$_.Name]
  if (-not $m) { Write-Warning "no tracks.csv row for $($_.Name): add title, artist, license and url before shipping" }
  $entry = [ordered]@{ file = "$slug.ogg"; title = $(if ($m) { $m.title } else { $base }) }
  if ($m) { if ($m.artist) { $entry.artist = $m.artist }; if ($m.license) { $entry.license = $m.license }; if ($m.url) { $entry.url = $m.url } }
  $tracks += [pscustomobject]$entry
}
if ($tracks.Count -eq 0) { throw "no audio files found in $Source" }
$lists[$Playlist] = $tracks

[pscustomobject]@{ playlists = [pscustomobject]$lists } | ConvertTo-Json -Depth 5 | Set-Content $pj -Encoding UTF8

$credits = @("# Music credits", "", "Every shipped track, by playlist. Playlists without tracks play the built-in procedural jukebox.", "")
foreach ($name in $lists.Keys) {
  $credits += "## $name", "", "| File | Title | Artist | Licence | Source |", "|---|---|---|---|---|"
  foreach ($t in $lists[$name]) { $credits += "| $($t.file) | $($t.title) | $($t.artist) | $($t.license) | $($t.url) |" }
  $credits += ""
}
$credits += "Jingles (not in a playlist, reserved for timed runs): jingle-victory.ogg, jingle-fail.ogg, DavidKBD, CC BY 4.0."
$credits -join "`n" | Set-Content (Join-Path $Out 'CREDITS.md') -Encoding UTF8
Write-Host "wrote $($tracks.Count) tracks to playlist '$Playlist' in $Out (playlist.json, CREDITS.md)"
