# Music

Two ways the game gets a soundtrack:

1. **Built-in jukebox** (default when this folder has no playlist): procedural ska-punk generated
   in Web Audio (`src/audio/Jukebox.ts`). N skips to a new song (new seed: tempo, key, progression, lead).
2. **Your playlist**: drop audio files here and list them in `playlist.json`. The game plays them in
   order and loops. N skips. Volume and source (playlist / jukebox / off) are in Settings > Audio.

## playlist.json

Plain filenames work, but credited entries show up in the menu and the now-playing toast:

```json
[
  { "file": "skank-the-summer-01.ogg", "title": "Skank the Summer", "artist": "DavidKBD", "license": "CC BY 4.0", "url": "https://davidkbd.itch.io/skank-the-summer-ska-punk-summer-music-pack" },
  "my-own-track.mp3"
]
```

Keep files under about 3 MB each (128 to 160 kbps OGG or MP3). `tools/fetch-music.ps1` converts a
folder of downloads with ffmpeg and writes `playlist.json` plus `CREDITS.md` for you.

## Licensing

Only ship tracks you have the rights to: your own, CC0, or CC BY (which needs the credit the menu
shows). Nothing from the actual 1080 or Tony Hawk soundtracks; those are commercial. Sources that
fit the late-90s snowboard-game vibe:

- DavidKBD, Skank the Summer ska-punk pack (CC BY 4.0, name your price): https://davidkbd.itch.io/skank-the-summer-ska-punk-summer-music-pack
- OpenGameArt rock collections (check each track's licence): https://opengameart.org/content/rock-music and https://opengameart.org/content/cc0-music-1
- Kevin MacLeod / incompetech rock tracks (CC BY 4.0): https://incompetech.com/music/royalty-free/
- Free Music Archive filtered to CC BY or CC0, genres punk and ska: https://freemusicarchive.org/

Audio files are gitignored by default (`*.mp3`, `*.ogg` under this folder); commit `playlist.json`
and `CREDITS.md` only, unless the set is small and you want it in the repo.
