---
name: ghost-lines
description: Give a resort its main menu backdrop and ghost riders with game/tools/ghost_lines.mjs (FEAT-181) - pick the menu shot (Shift+P in the eye camera), render the still, read lines Drew draws on it, ride them with the bot, use Drew's own recorded runs near the camera, check. Use when the user asks for a menu shot, menu riders or ghosts for a resort, to redo or tune them, or mentions ghost_lines, drawn lines on the menu, or takes.
---

# Menu shot and ghost riders for a resort

Read `game/tools/ghost_lines/README.md` first: the recipe step by step, the options, how to read the output and the
gotchas already paid for. It is short on purpose; don't start from the research notes.

The core loop, from `game/` on Drew's PC (GPU and `packs/<pack>` needed; `npx vite build` after any `game/src` change):

```
node tools/ghost_lines.mjs <pack> status
node tools/ghost_lines.mjs <pack> candidates            # after Drew's Shift+P "Keep as a candidate" saves
node tools/ghost_lines.mjs <pack> pick <name>           # menu shot + still + clean drawing frame
node tools/ghost_lines.mjs <pack> lines <img> [<img2>]  # Drew's drawing(s); a later image replaces a colour
node tools/ghost_lines.mjs <pack> ride [--per "red:3,blue:0,green:2:straight"]
node tools/ghost_lines.mjs <pack> takes take-1.json take-2.json   # Drew's own runs near the camera
node tools/ghost_lines.mjs <pack> check --no-open
```

Working with Drew: start a dev server on the worktree and give him `?pack=<pack>&debug&cam=eye` for picking shots and
`?pack=<pack>` to watch the menu (he reloads after each `ride` / `takes`). Ask him to redraw a line rather than tuning
code for one stroke. Ask which bot riders to replace before replacing them. Note what you learn in the Learnings of
`docs/research/ghost-lines-prototype/README.md`.
