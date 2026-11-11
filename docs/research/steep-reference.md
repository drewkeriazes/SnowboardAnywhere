# Research: Steep's terrain files and what applies here (FEAT-229 to FEAT-231)

Steep (Ubisoft Annecy, 2016) is the closest commercial relative of this game: open mountains, free ride, a streamed terrain much larger than the play area. This note records what a study of its shipped PC files showed, compares it with what this game already does, and lists the three cards that came out of it.

How it was studied (2026-11-11, on Drew's PC, a copy Drew owns): read-only inspection of the installed files with REA (`rea-agents` 6.8.0) and short scripts that read file headers and index tables. One RenderDoc frame-capture attempt was made and captured nothing (section 5). Nothing was unpacked, patched or modified, and the protection was not worked around. The working notes with every command, hash and Evidence id are kept on Drew's PC with the REA checkout, not here.

Labels: **observed** is read straight from the shipped bytes, **derived** is computed from them, **inferred** is a reading that was not proven.

## 1. What the install holds

- `Steep.exe` (31.7 MB): the engine is in the executable. On disk it is packed: its code and data sections have no bytes, and one section holds 31.4 MB at 7.98 bits per byte (observed). So no engine code or strings could be read, and searches for snow, trail, terrain, LOD, fog and impostor found nothing in plain text.
- Libraries it loads (observed in the import table): Direct3D 11, NVIDIA HBAO+ ambient occlusion, the HLSL compiler, Bink video.
- Data: about 19 GB of `.forge` archives per region, and the terrain in separate `.tbf` files, two per map (Alps, Alaska, Japan).

## 2. The terrain files (`.tbf`)

Each map has `PC<Map>_terrainlin0.tbf` (7 to 9 MB) and `PC<Map>_terrainlin1.tbf` (1.1 to 1.7 GB). Both share one layout (observed in all six files; the derived rows were checked against every file):

| offset | type | value | meaning |
|---|---|---|---|
| 0x00 | 4 bytes | `FBT\0` | magic |
| 0x04 | u32 | 1 | version (inferred) |
| 0x08 to 0x14 | u32, u32, u32, f32 | 16, 2048, 1024, 6800.0 | unknown; the same on all three maps |
| 0x18 | u32 | 87,381 | node count |
| 0x1C | u64 x 87,381 | | file offset of each node's data, 0 = absent |

- 87,381 = 1 + 4 + 16 + ... + 4^8: a **complete 9-level quadtree**, from one root tile down to 256 x 256 leaves, each level twice the resolution of the one above (derived).
- The first offset equals the end of the table, so the data follows the index directly. Within a level the table is **row-major** (derived).
- Every node is **compressed on its own**: 0.25 to 42 KB, entropy 7.0 to 7.9 bits per byte, a 4-byte header `ED FE 0C` plus a flag. The codec and what a tile holds (heights, normals, materials) are unknown.
- Bytes per level grow 3.4 to 4.9 times per level, so the leaves are most of the file (Alps: 879 MB of 1.2 GB).
- `lin1` holds every node. `lin0` holds levels 0 and 1, all of level 4 (16 x 16), and **exactly 9 nodes at each other level: a 3 x 3 window at the centre of the map** (at the leaves, tiles 127 to 129 of 256 in both directions). Its level 4 data is byte-identical to `lin1`'s (derived).

Inferred: `lin1` is streamed by quadtree level round the camera, and `lin0` is a small set kept resident or loaded first: the whole map coarse, one complete middle level so the full horizon can always be drawn, and full detail at one default point.

## 3. Install chunks

`streaminginstall.ini` (observed) maps files to install chunks: chunk 0 is the main data, the two first maps and their terrain files, needed "to go to main menu and start game"; chunk 1 adds the third map and the character data. The game is playable before the whole install arrives.

## 4. Graphics settings

The settings file the game writes (`Documents\My Games\STEEP\Default\STEEP.ini`, observed) has `TerrainTesselationQuality`, `Environment Quality`, `ShadowQuality`, `TextureQuality`, `AmbientOcclusion`, `AntiAliasingMode`, `MultisampleMode`, `PerSampleShading`, `Anisotropy` and `PixelScale`. Inferred: terrain detail near the camera comes from GPU tessellation with its own quality tier. WebGL 2 has no tessellation stage; this game's equivalent is the 1 m chunks with the mogul bumps in their geometry and the near split from FEAT-044.

## 5. The frame capture that captured nothing

RenderDoc 1.47 was launched through Steam's launch options with child-process hooking. It followed the chain `steep.exe` -> `UbisoftGameLauncher.exe` -> `steep.exe -uplay_steam_mode` and loaded into the game, but saw only one short-lived D3D11 device (feature level below 11_0, probably a capability check) and never the device that draws the game: no overlay, no capture (observed in the RenderDoc log). The attempt stopped there. So nothing here says how Steep draws snow trails, fog, LOD transitions or far trees.

## 6. What this game already does

Steep's features that have a counterpart on `main` (presence only; how Steep implements them is unknown, section 5):

| Steep | here |
|---|---|
| quadtree terrain streamed round the camera | M1 (#32), `game/src/terrain/Terrain.ts` (CDLOD, skirts) |
| terrain tessellation tier | 1 m chunks, moguls in the geometry (FEAT-059, FEAT-147), FEAT-044's near split |
| render scale (`PixelScale`) | adaptive quality, render resolution first (FEAT-062) |
| HBAO+ screen-space AO | baked terrain AO tiles (`ao/`, FEAT-047) |
| trails in the snow | ribbons and the deformation target (FEAT-031, FEAT-044) |
| distant trees | impostors (FEAT-009, FEAT-157), cover levels (FEAT-153) |

None of these needs a card from this study.

## 7. What transfers (the cards)

| finding | here today | card |
|---|---|---|
| Every 2 x level is stored (section 2) | Chunks at 8 m or finer request the 1 m fine tiles (`Terrain.ts:254`); the next set is mid at 16 m. Replaying the chunk selection (`N = 32`, `SPLIT_K = 2.6`, `Terrain.ts:16`, `:48`, `:313`) at the Born Free start: 4 m chunks sit about 350 to 830 m from the camera and 8 m chunks about 670 to 1,690 m (box distance; a chunk exists while its parent is within the split distance, so it can lie up to one parent width further out). 46 fine tiles (261 KB PNG, 1 MB decoded each) are requested, 42 of them only by 4 and 8 m chunks, which keep 1 sample in 16 or 64. At 40 other points inside the fine set: 41 to 51 tiles, 37 to 43 of them only for 4 to 8 m chunks (derived from the selection rule with the camera inside the pack's height range, not measured) | FEAT-229 (#537, EPIC-11): measure, then a 4 m set if the numbers say so |
| A small first set: whole map coarse, one complete middle level, a 3 x 3 full-detail window (sections 2 and 3) | `get_pack` downloads the whole zip (Vail 233 MB) before the resort loads | FEAT-230 (#538, EPIC-15): a boot zip round `meta.start`, about 40 MB for Vail (estimate), the rest in the background |
| One file per terrain with an offset per tile, each tile compressed alone (section 2) | A pack is 1,582 files (Vail) in a folder, zipped per release; GitHub release assets send no CORS headers | FEAT-231 (#539, EPIC-15): research an indexed archive read with HTTP Range, for when a hosted page fetches packs directly |

## 8. Unknown

- What a `.tbf` tile holds, its codec, and the header values 16, 2048, 1024 and 6800.0.
- Everything Steep does at run time: snow deformation, fog and atmosphere, LOD blending, impostors.
- Whether Steep's `lin0` window centre is a spawn point.
