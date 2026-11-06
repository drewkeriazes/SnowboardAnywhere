# Music

Four playlists, picked on the main menu or in Settings > Audio (plus Shuffle all, which mixes
every playlist): **Ska-punk**, **Melodic house**, **Metal**, **Hip-hop**. N skips within the playlist.

1. **Files**: tracks listed under the playlist's name in `playlist.json` play in order and loop.
2. **Built-in jukebox**: a playlist with no files (or Music set to "Built-in jukebox") plays
   procedural music in that style, generated in Web Audio (`src/audio/Jukebox.ts`): ska-punk,
   four-on-the-floor melodic house, palm-muted metal, swung boom-bap with jazzy electric piano.

## playlist.json

```json
{
  "playlists": {
    "Ska-punk": [
      { "file": "01-beach-ska.ogg", "title": "Beach Ska", "artist": "DavidKBD", "license": "CC BY 4.0", "url": "https://davidkbd.itch.io/skank-the-summer-ska-punk-summer-music-pack" }
    ],
    "Metal": ["my-own-riff.ogg"]
  }
}
```

Credited entries show up in the menu credits and the now-playing toast; plain filenames work too.
An older flat list (`[ ... ]`) still loads as the Ska-punk playlist. Other playlist names are allowed
and are heard under Shuffle all.

Keep files under about 3 MB each (128 to 160 kbps OGG or MP3). To add a playlist, put its downloads
(and a `tracks.csv` with file,title,artist,license,url) in one folder and run
`tools/fetch-music.ps1 -Source <folder> -Playlist "Melodic house"`: it converts with ffmpeg, replaces
that playlist in `playlist.json`, keeps the others, and regenerates `CREDITS.md`.

## Licensing

Only ship tracks you have the rights to: your own, CC0, or CC BY (which needs the credit the menu
shows). Nothing from the actual 1080 or Tony Hawk soundtracks; those are commercial. Sources that
fit the late-90s snowboard-game vibe:

- DavidKBD, Skank the Summer ska-punk pack (CC BY 4.0, name your price): https://davidkbd.itch.io/skank-the-summer-ska-punk-summer-music-pack
- OpenGameArt rock collections (check each track's licence): https://opengameart.org/content/rock-music and https://opengameart.org/content/cc0-music-1
- Kevin MacLeod / incompetech rock tracks (CC BY 4.0): https://incompetech.com/music/royalty-free/
- Free Music Archive filtered to CC BY or CC0 (punk, ska, deep house, metal, hip-hop instrumentals): https://freemusicarchive.org/
- Melodic house candidates (check the licence): Tomality Deep House Music Pack https://tomality.itch.io/deep-house-music-pack, fardifferent ESCAPE https://fardifferent.itch.io/escape
- No tracks by commercial artists (Nora En Pure, Lupe Fiasco and so on); only the feel.

Audio files are gitignored by default (`*.mp3`, `*.ogg` under this folder); commit `playlist.json`
and `CREDITS.md` only, unless the set is small and you want it in the repo.
