# Research: an indexed pack archive read with HTTP Range (FEAT-231)

FEAT-231 (#539) asks whether a pack should be one file with an offset table, read tile by tile with HTTP Range, the way Steep's `.tbf` terrain files are (`docs/research/steep-reference.md` section 2), for the day a hosted page fetches packs directly instead of `get_pack` downloading and unzipping them in Node. Measured 2026-11-11 and 12 on Drew's PC (RTX 2070 SUPER, Playwright Chromium 156 headless on the GPU, ANGLE D3D11) against Vail (`packs/vail`, read only) and main at 8256231. Nothing in `game/` or the pipeline changed.

**Verdict.** Go on the layout, built when a hosted page is on the board (EPIC-15 rule 4; there is no such card yet): keep the release asset a **stored zip**, put an **index entry first** so one Range read finds every file, order the entries **boot first, then each set row-major**, and serve it from **Cloudflare R2** on a custom domain. Card: FEAT-252 (#576). Separately, the height tile codec is worth changing for every download, hosted or not: lossless delta tiles make fine 39% and mid 29% smaller than the Terrarium PNGs (Vail 241 MB to about 181 MB), but they decode on the calling thread, so they want a worker (FEAT-064, #97). Card: FEAT-253 (#577). Locally neither changes load or frame time: the load is set by shader compile, chunk builds and the main thread (`perf-log.md` > FEAT-229 step 1), not by the number of files.

## 1. Vail on disk

`packs/vail`, counted with `find` (MB = 10^6 bytes):

| set | files | MB | what |
|---|---|---|---|
| fine | 529 | 143.27 | 1 m heights, 512 x 512 Terrarium PNG (RGB), 23 x 23 grid |
| trees | 144 | 30.50 | tree cells (`.bin`, 1 km) |
| cover | 4 | 17.61 | forest cover levels (PNG) |
| mask | 144 | 17.34 | surface mask (RGBA PNG, 2 m) |
| mid | 25 | 12.02 | 16 m heights (PNG) |
| ao | 144 | 9.27 | sky visibility (PNG, 2 m) |
| features.json | 1 | 3.47 | lifts, runs, buildings |
| far | 16 | 2.79 | 128 m heights (PNG) |
| shrubs | 144 | 2.66 | shrub cells (`.bin`) |
| debug | 1 | 0.76 | `species.png`, not published (`SKIP_DIRS`) |
| rocks | 141 | 0.66 | rock cells (`.bin`) |
| dir | 144 | 0.44 | piste direction (PNG) |
| moguls | 144 | 0.34 | mogul amplitude (PNG) |
| meta.json | 1 | 0.01 | |
| **total** | **1,582** | **241.12** | |

The published `vail-v1` zip is 235.87 MB (catalog; an older build than the pack on disk). Fine tiles are 59% of the pack. Of the 529 fine tiles 45 have voids (2.95 M void samples in all), the largest height range inside one tile is 533.8 m, and the Terrarium blue channel is fully used (1/256 m steps), so the PNGs carry real 1/256 m precision.

## 2. What the client requests

Every pack request the game makes, logged at a local server: from page load until the load settles (the `tileperf.mjs` load loop: warm-up budgets, back-to-back frames until nothing is in flight or building; 172 frames, 8.7 s), then a 60 s straight tuck from the start (1,079 m). Headless, GPU, one run.

| | requests | MB |
|---|---|---|
| load | 488 | 90.4 |
| of which | trees 144 (30.5 MB), ao 137 (9.1), fine 46 (12.6), moguls 45, rocks 35, mid 25 (12.0), far 16 (2.8), mask 15, dir 15, cover 4 (17.6), shrubs 4, meta, features (3.5) | |
| 60 s ride after it | 38 | 3.6 |
| of which | fine 12, moguls 9, rocks 5, ao 4, mask 3, dir 3, shrubs 2 | |

Two things follow. The load reads more than a third of the pack (all of `trees/`, nearly all of `ao/`, all of mid, far and cover), so FEAT-230's boot zip, estimated at about 40 MB, would leave the client asking for 140 tree cells and about 130 ao tiles that are not there yet (comment on #538). And after the load the client asks for very little: 38 files a minute at a fast tuck.

## 3. Layout

### A stored zip with an index entry first

`publish_pack.py` already writes the release zip with every entry stored, in sorted order, with no data descriptors: the first local header of `boston-mills-v2/boston-mills.zip` (a 300-byte ranged read) has flag 0, method 0 and the sizes filled in. So each file's bytes already sit at a fixed offset, and the only thing a ranged reader lacks is a way to find them without the central directory at the end. Reading the end needs a suffix range (`bytes=-N`), and in Chromium 156 that is not CORS-safelisted (measured below), so it would cost a preflight on top of two reads. The fix is a first entry:

```
zip entry 0: index.bin (stored)
  magic 'SBPI', u32 version, u32 bootEnd (zip byte where the boot range ends), u32 setCount
  per set: name (u8 length + ascii), u16 tilesX, u16 tilesY, u8 ext id (png | bin | d16 ...)
           then tilesX * tilesY entries, row-major (ty * tilesX + tx): u32 data offset in the zip, u32 length (0 = absent)
  then the single files (meta.json, features.json, cover/*.png): name, offset, length
zip entries 1..n: the pack files, boot first, then each set row-major
```

About 8 bytes per tile slot: Vail's 1,582 files are about 13 KB of index, so one Range read of the first 64 KB holds the zip header, the whole index and `meta.json`. Offsets point at the data, past each local header, so a tile is exactly one ranged read. u32 offsets cover a 4 GiB zip; every pack so far is under 250 MB (Steep stores u64). Unzip tools see an ordinary zip with one extra small file; `get_pack` skips it.

Prototyped for Vail's fine tiles alone (`SBAT`: a 24-byte header and a u32 offset and length per tile, row-major, then the payloads): the index is 4,256 bytes for 529 slots, and the archive is 143,269,838 bytes against 143,265,582 in the folder.

### Order: boot first, then row-major

What the load reads (section 2), sorted by set and row-major, is 482 tiles in **40 contiguous runs** (Morton order: 57; row-major wins because the request windows are boxes a few tiles wide). The 60 s ride adds 38 tiles in 29 runs. So a reader that merges adjacent entries requested in the same frame into one Range read needs about 40 reads for the load; one that knows the boot range (`bootEnd`, the entries the load reads, put first in the zip) needs one or two. That boot range is FEAT-230's boot zip as a prefix of the one zip: `get_pack` streaming the zip can mark the pack playable at `bootEnd` (stored entries extract in order as they arrive), and a hosted page reads `[0, bootEnd)` and then ranges the rest. One release asset per build stays one file.

### Per pack, not per set

One archive per set would give 13 files per build and 13 index reads, and still need the boot range to cut across sets. Per pack keeps one URL, one sha256 and one cache entry per build, which is what the catalog already tracks.

## 4. Tile codec

Vail's 529 fine tiles in seven `SBAT` archives (one per codec), then read in the browser with one Range request for the index and one per tile from a local server, decoded to the `Float32Array` that `HeightSet` keeps (row 0 north, NaN void). Codecs, all on the Terrarium integer `v = (h + 32768) * 256`:

- **png**: the pack's PNG, decoded as `HeightSet.load` does (`createImageBitmap`, OffscreenCanvas `getImageData`, the Terrarium sum).
- **u16**: `(v - tile minimum) / 4`, so 1/64 m, 0xFFFF void, no compression (lossy, at most 7.8 mm off). **u16.df**: the same, deflate-raw.
- **d16** (lossless): voids filled from the previous sample, MED (LOCO-I) prediction (left, up, up-left) residuals in 1/256 m, zigzag to u16, split into a low byte plane and a high byte plane, then a 1-bit void mask only when the tile has voids; compressed with deflate-raw (**d16.df**), brotli 11 (**d16.br**) or zstd 19 (**d16.zs**). A 5-byte tile header holds the first sample and the void flag. Decode: `DecompressionStream('deflate-raw')`, then the MED loop.
- **q16.df**: d16 on the 1/64 m quantisation (lossy, as u16).

Bytes (archive size, index included) and decode per tile, ranges over runs (wall: 3 runs; main-thread blocked: 2 runs, a MessageChannel heartbeat summing every gap over 0.5 ms while the 529 tiles decode one after another, so it includes the fetch and `arrayBuffer` of the local read, about 1.5 to 2.5 ms a tile for 512 KB):

| codec | fine MB | vs PNG | wall per tile, median (p95) ms | main thread blocked per tile ms | in a worker, median ms | exact |
|---|---|---|---|---|---|---|
| png | 143.27 | | 6.3 to 7.9 (9.8 to 12.9) | 4.2 to 5.4 | 5.5 to 6.9 | |
| u16 | 277.35 | +94% | 0.7 to 1.0 (1.1 to 1.7) | 2.2 to 3.3 | 0.6 to 3.0 | 7.8 mm |
| u16.df | 205.85 | +44% | 3.9 (5.7), 1 run | | 6.1 | 7.8 mm |
| **d16.df** | **86.92** | **-39%** | 5.4 to 6.3 (7.4 to 8.1) | 6.6 to 7.5 | 5.0 to 6.1 | **yes** |
| d16.br | 78.31 | -45% | no browser decoder | | | yes |
| d16.zs | 84.68 | -41% | no browser decoder | | | yes |
| q16.df | 71.86 | -50% | 5.2 to 6.4 (7.4 to 8.6) | 6.5 to 7.7 | 5.3 to 6.8 | 7.8 mm |

- **d16.df is byte-exact**: on 59 tiles spread over the grid, the decoded heights equal the PNG decode with 0 error and identical voids (348,160 void samples).
- **Decode cost moves to the calling thread.** PNG's image decode runs off the main thread in Chromium; `DecompressionStream` and the MED loop run on the thread that calls them. On the main thread d16 costs about 2 ms more per tile (blocked 6.6 to 7.5 ms against 4.2 to 5.4); in a worker both are 5 to 7 ms and none of it lands on the main thread. At 46 fine tiles a load and 12 a minute while riding that is about 100 ms more main-thread work at load and under 30 ms a minute riding: small, but it is the kind of block BUG-087 (#542) removed, so d16 belongs with FEAT-064's worker decode.
- **Raw 16-bit is no good on its own**: uncompressed it is nearly twice the PNG, and 1/64 m only fits because fine tiles span less than 1,024 m (mid overflowed it in 20 of 25 tiles).
- **Brotli and zstd** would save another 2 to 10% but Chromium 156's `DecompressionStream` supports only `gzip`, `deflate` and `deflate-raw` (checked: `brotli` and `zstd` throw), so they would need a WASM decoder. Not worth it.
- **Lossy q16.df** saves another 15 MB for a 7.8 mm error. Not worth a lossy step.
- **Other height sets**: d16.df on mid is 8.51 MB against 12.02 (-29%, all 25 tiles). On far (128 m samples) a MED residual overflowed 16 bits, so far stays PNG or needs an escape code; it is 2.8 MB.
- Whole pack with fine and mid in d16.df: 241.12 - 143.27 - 12.02 + 86.92 + 8.51 = about 181 MB, -25%; the load's 90.4 MB becomes about 82 MB.

## 5. Hosting

**GitHub release assets: no CORS.** `curl -I -H "Origin: https://example.com"` on `releases/download/boston-mills-v2/boston-mills.zip` (2026-11-12): `github.com` answers `302 Found` with no `Access-Control-Allow-Origin`, and the redirect target (`release-assets.githubusercontent.com`, Azure Blob behind Varnish) answers `200` with `Accept-Ranges: bytes` and no CORS headers either; a ranged GET there returns `206 Partial Content`. An `OPTIONS` preflight to `github.com` returns 404. The target URL is signed and expires after about an hour (`se=`). So `get_pack` in Node can range and resume, but a page cannot read a release asset at all, archive or not.

**Cloudflare R2: Range and CORS, both documented.**
- Range: the S3 API compatibility table lists `Range` as supported on GetObject, and the release notes say R2 returns 206 on ranged requests (2022-11-17) and adds CORS headers on public buckets (2022-09-27).
- CORS: set per bucket in the dashboard, with `wrangler r2 bucket cors set <bucket> --file cors.json`, or S3 `PutBucketCors`; fields `AllowedOrigins`, `AllowedMethods`, `AllowedHeaders`, `ExposeHeaders`, `MaxAgeSeconds`. Custom domains on a bucket with a CORS policy return the headers on their own. CORS headers only come back on requests with an `Origin`; after a policy change, purge the cache.
- Public access: the `r2.dev` URL is rate-limited and for development only, without caching; production goes through a custom domain on a Cloudflare zone, which gets Cloudflare's cache.
- Cache: Cloudflare serves single ranges from a cached file as `206`; the free-plan limit is 512 MB per cached file (Vail's zip fits); caching is by extension and `.zip` (and `.bin`) are on the default list, so the archive caches without a rule.
- Cost: 10 GB-month storage, 1 M Class A and 10 M Class B operations a month free, no egress charge. GetObject is Class B; the pricing page does not say whether a ranged read or a cached hit counts as one.

**Range across origins, measured in Chromium 156** (a page on one origin, a server on another that answers GET with `Access-Control-Allow-Origin: *` and refuses `OPTIONS`): `bytes=0-23` and `bytes=100-` go straight through as a `206` with no preflight; `bytes=-100` (suffix) and `bytes=0-9,20-29` (two ranges) send a preflight and fail. `Content-Range` is not readable without `ExposeHeaders`, which the reader does not need (it knows the offsets). So a front index plus single ranges needs nothing but `AllowedOrigins` and GET on R2; list `range` in `AllowedHeaders` anyway for browsers that preflight it.

**A folder on R2 also works**, with per-object CORS from the same bucket policy. What the archive adds over 1,582 objects per build: one object to upload, replace and delete per build (and the same file as the release asset), one cache entry, and the boot range as one read.

## 6. Request counts for Vail

From section 2's log (488 pack files at load, 38 more in a 60 s ride):

| layout | load | 60 s ride after |
|---|---|---|
| folder (today; or a folder on R2) | 488 | 38 |
| release zip from GitHub, in a page | impossible (no CORS) | |
| indexed zip, one Range read per file | 488 (the index read brings `meta.json` with it) | 38 |
| indexed zip, adjacent entries asked for in the same frame merged | about 45 (40 tile runs, index, meta, features, cover) | up to 29 |
| indexed zip with a boot range | 2 (index, then `[0, bootEnd)`) | 29 to 38 |

On a local dev server none of this shows up in load time (FEAT-229 step 1 found the load bound by the first frame and the main thread). Over the internet the count matters less on HTTP/2 or 3 (a Cloudflare custom domain multiplexes) than the bytes do, and on R2 it is the Class B count: 488 a session on the folder layout against 2 plus about 30 a riding minute.

## 7. Client

Every pack read today is a `fetch` of `${baseUrl}/<path>`: 12 call sites in `Pack.ts` (meta, features), `HeightSet`, `MaskSet`, `CoverSet` (2), `Vegetation` (trees cells, stands), `Rocks` and `Shrubs`. They become one interface:

```ts
interface PackSource {
  /** the file's bytes, or null when the pack has no such file */
  get(path: string): Promise<ArrayBuffer | null>;
}
class FolderSource implements PackSource { /* fetch(`${base}/${path}`), 404 -> null: today's behaviour */ }
class ZipSource implements PackSource {
  static async open(url: string): Promise<ZipSource>; // one Range read of the first 64 KB: index.bin and meta.json
  // get(): looks the path up in the index; reads asked for in the same frame that touch neighbouring entries go
  // out as one Range read and are split; a boot range already read is served from memory
}
```

`Pack.load(source)` builds the sets with the source and the set name instead of `${baseUrl}/fine`; `HeightSet.load` becomes `const buf = await this.source.get(`${this.name}/${tx}_${ty}.png`)` then the same decode (`TileStats` takes `buf.byteLength`). The picker chooses `FolderSource` for a pack on disk (dev server, `npm run host`) and `ZipSource` for a catalog entry with an R2 URL. Vite's `/packs/` middleware does not answer Range today, so local play keeps folders; that is fine, since the archive only pays off over the network.

**FEAT-064 (#97, workers).** `get()` returns an `ArrayBuffer`, which transfers to a worker without a copy, and workers can `fetch` with Range and CORS like a page. The clean split is a decode worker that owns the source and the codecs: the main thread asks for `(set, tx, ty)` and gets the `Float32Array` or `Uint8Array` back as a transfer. That is also where d16 (FEAT-253) should decode.

**FEAT-230 (#538, boot zip, being built now).** Its client change, "a missing tile in a partial pack means not yet, ask again when rest arrives", is the same with either source. Later, FEAT-252's boot-first order makes the boot zip a prefix of one zip: the catalog keeps one URL plus `bootEnd`, `get_pack` streams the one zip and flips `partial` off at the end, and a hosted page reads the boot range in one request. Nothing in FEAT-230 needs to change for that now. One measured number for it: the current client's load reads 90.4 MB (section 2), including every tree cell and nearly every ao tile.

## 8. Cards

- **FEAT-252 (#576)**: indexed pack zip read with HTTP Range: the `index.bin`-first, boot-first zip in `publish_pack.py` (MapPacker half), `PackSource` with `FolderSource` and `ZipSource` in the game, an R2 bucket on a custom domain with CORS. Backlog until a hosted page is on the board.
- **FEAT-253 (#577)**: lossless delta height tiles (d16) for fine and mid, a `formatVersion` bump, decoded in a worker. Backlog, after or with FEAT-064 (#97). Worth it without hosting: about 60 MB off every Vail download.
- Comment on FEAT-230 (#538) with the load's request list.

## How it was measured

Scratch scripts on Drew's PC (not in the repo): a minimal PNG decoder in Node (`zlib.inflateSync` and the five filters) read every fine tile and wrote the seven archives (deflate level 9, brotli quality 11, zstd level 19 from Node 24's `zlib`); a page served from a local Range-capable server read each archive's index with one Range request and every tile with one more, through the decoders above, once on the main thread with the heartbeat and once in a module worker, after a 20-tile warm-up; 59 tiles were decoded through PNG and each other codec and compared. Request counts: a copy of the `tileperf.mjs` server and load loop that logs every `/packs/` request, then 240 batches of 15 frames with ArrowUp held. The CORS checks: `curl -I` and a 300-byte ranged GET against the `boston-mills-v2` asset, and two local servers on different origins for the Range forms. All browser runs: `launchBrowser(['--gpu'])` from `game/tools/browser.mjs`.

## Sources

- [Cloudflare R2: configure CORS](https://developers.cloudflare.com/r2/buckets/cors/)
- [Cloudflare R2: public buckets](https://developers.cloudflare.com/r2/buckets/public-buckets/)
- [Cloudflare R2: S3 API compatibility](https://developers.cloudflare.com/r2/api/s3/api/) (GetObject `Range`)
- [Cloudflare R2: release notes](https://developers.cloudflare.com/r2/platform/release-notes/) (206 on ranged reads, CORS on public buckets)
- [Cloudflare R2: pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare cache: range requests](https://developers.cloudflare.com/cache/reference/range-requests/)
- [Cloudflare cache: default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/) (512 MB, cached extensions)
- [GitHub community discussion #45446: CORS for release assets](https://github.com/orgs/community/discussions/45446)
