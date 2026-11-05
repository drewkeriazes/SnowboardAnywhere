<#
.SYNOPSIS
  Build game/public/music from a folder of downloaded tracks: convert to OGG, write playlist.json and CREDITS.md.
.DESCRIPTION
  Downloads happen in the browser (itch.io, OpenGameArt and FMA need a click). Put the files in one
  folder, optionally with a tracks.csv next to them:
      file,title,artist,license,url
      Skank the Summer 01.wav,Skank the Summer,DavidKBD,CC BY 4.0,https://davidkbd.itch.io/...
  Then:  .\tools\fetch-music.ps1 -Source "$env:USERPROFILE\Downloads\music"
  Needs ffmpeg on PATH (winget install Gyan.FFmpeg).
#>
param(
  [Parameter(Mandatory = $true)] [string] $Source,
  [string] $Out = (Join-Path $PSScriptRoot "..\public\music"),
  [int] $Kbps = 144
)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) { throw "ffmpeg not found on PATH (winget install Gyan.FFmpeg)" }
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$meta = @{}
$csv = Join-Path $Source 'tracks.csv'
if (Test-Path $csv) { Import-Csv $csv | ForEach-Object { $meta[$_.file] = $_ } }
$playlist = @()
$credits = @("# Music credits", "", "| Title | Artist | Licence | Source |", "|---|---|---|---|")
Get-ChildItem $Source -Include *.wav, *.mp3, *.ogg, *.flac, *.m4a -File -Recurse | Sort-Object Name | ForEach-Object {
  $base = [IO.Path]::GetFileNameWithoutExtension($_.Name)
  $slug = ($base.ToLower() -replace '[^a-z0-9]+', '-').Trim('-')
  $dest = Join-Path $Out "$slug.ogg"
  Write-Host "  $($_.Name) -> $slug.ogg"
  & ffmpeg -y -loglevel error -i $_.FullName -vn -c:a libvorbis -b:a "${Kbps}k" $dest
  $m = $meta[$_.Name]
  $entry = [ordered]@{ file = "$slug.ogg"; title = $(if ($m) { $m.title } else { $base }) }
  if ($m) { if ($m.artist) { $entry.artist = $m.artist }; if ($m.license) { $entry.license = $m.license }; if ($m.url) { $entry.url = $m.url } }
  $playlist += [pscustomobject]$entry
  $credits += "| $($entry.title) | $($entry.artist) | $($entry.license) | $($entry.url) |"
}
if ($playlist.Count -eq 0) { throw "no audio files found in $Source" }
$playlist | ConvertTo-Json -Depth 3 | Set-Content (Join-Path $Out 'playlist.json') -Encoding UTF8
$credits -join "`n" | Set-Content (Join-Path $Out 'CREDITS.md') -Encoding UTF8
Write-Host "wrote $($playlist.Count) tracks to $Out (playlist.json, CREDITS.md)"
