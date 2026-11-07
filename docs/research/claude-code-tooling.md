# Claude Code tooling for building this browser game

Researched 2026-11-05. What publicly available Claude Code plugins, skills and MCP servers give us real leverage on SnowboardAnywhere, ranked by payoff, with exact install commands. Everything here is optional; the repo works without any of it. Items marked "catalog" are in the Anthropic plugin directory (install from claude.ai Settings > Plugins, or `/plugin` in Claude Code).

## Tier 1: install these in the VS Code session now

Applied on Drew's PC 2026-11-05: Chrome DevTools MCP, Three.js DevTools MCP and Context7 MCP (user scope), webapp-testing copied into `.claude/skills/`, Playwright 1.64.1 as a `game/` devDependency. parallax-threejs and the Tier 2 skill packs are not installed.

### 1. Chrome DevTools MCP (Google, official)
Gives Claude eyes and a profiler on the running game: screenshots, console, network, `performance_start_trace` / `performance_analyze_insight` (frame time, long tasks, GPU vs CPU), CPU and network throttling emulation, scripted input. This is how a session should verify "60 fps at 1 m LOD with 180k trees" instead of guessing.

```
claude mcp add chrome-devtools --scope user npx chrome-devtools-mcp@latest
```
Or the plugin (adds bundled skills): `/plugin marketplace add ChromeDevTools/chrome-devtools-mcp` then `/plugin install chrome-devtools-mcp@chrome-devtools-plugins`. Flags via args: `--headless=true`, `--isolated=true`, `--viewport=1280x720`, `--channel=stable`. Needs Chrome 144+. It launches its own Chrome by default; `--autoConnect` attaches to a running one but requires a non-default profile with remote debugging enabled.

Use in this repo: `npm run dev` then "open http://localhost:5173/?pack=vail, start a performance trace, ride for 10 seconds with ArrowUp held, stop, analyze". Record the numbers in `docs/research/perf-log.md` (create it) so regressions are visible.

### 2. Three.js DevTools MCP (DmitriyGolub, MIT)
59 tools that talk to the live scene over a WebSocket bridge, no project changes: scene-tree inspection, material and shader inspection, texture memory, FPS and memory-leak checks, draw-call counts. The quickest way to answer "why is this chunk black", "how many instances are visible", "is the shadow map 4096 or 1024".

```
# already defined in the repo's .mcp.json (FEAT-088); no install needed
```
Start the dev server first. The repo's `.mcp.json` pins it with `DEV_PORT=5173` and `BRIDGE_PORT=9222`; without that it reads `package.json` in the folder Claude was started in (the repo root has none) and falls back to port 3000. The bridge and keeps a tab at `localhost:9222` that must stay open. Repo: https://github.com/DmitriyGolub/threejs-devtools-mcp

### 3. parallax-threejs (catalog, community)
Three.js and GLSL debugging plugin that bundles chrome-devtools-mcp, playwright-mcp, Spector (WebGL call capture) and threejs-devtools-mcp, plus `/checkpoint`, `/diff`, `/sweep`, `/ship-check` commands for SHA-indexed visual regression and agents `shader-reviewer`, `visual-debugger`, `scenario-author`. This is the single most relevant plugin for M1, M3 and M5 work on the terrain material and tree shaders. Install from the catalog (search "parallax-threejs"). Overlaps with items 1 and 2; if you install this, you may not need them separately.

### 4. webapp-testing skill (Anthropic, official skills repo)
Playwright-based testing patterns plus `scripts/with_server.py` to start and stop the dev server around a test script. Pairs with our `game/tools/shoot.mjs` headless render check. Copy into the repo so every session has it:

```
git clone --depth 1 https://github.com/anthropics/skills.git /tmp/skills
mkdir -p .claude/skills && cp -r /tmp/skills/skills/webapp-testing .claude/skills/webapp-testing
```

## Tier 2: worth it for specific milestones

### 5. threejs-game-skills (majidmanzarpour, MIT) or Game Forge (efeislekel, MIT + Apache-2.0)
Nine skills: `threejs-game-director`, `threejs-gameplay-systems` (controls, camera, game feel, physics selection), `threejs-aaa-graphics-builder` (shader and material cookbook, LOD, instancing, VFX, a visual scorecard), `threejs-game-ui-designer` (HUD, menus, touch controls), `threejs-debug-profiler`, `threejs-qa-release` (Playwright smoke tests, visual regression baselines, bot playtests, canvas pixel metrics). Game Forge wraps the same six Three.js modules plus eight engine-neutral ones (game feel, performance budgets, camera systems, save systems, procedural generation). Best use for us: the QA/release module for a repeatable "ride the synth pack and compare screenshots" harness, the UI module for the HUD and touch controls, the graphics scorecard for M5.

```
npx skills add majidmanzarpour/threejs-game-skills --skill '*' -a claude-code -g -y
# or
npx skills add efeislekel/game-forge-claude-skill -a claude-code
```
Three of the nine skills call paid APIs (Tripo 3D generation, Gemini images, ElevenLabs audio); skip those.

### 6. GeoAI Skills (catalog, community, 18 skills)
`point-cloud-lidar`, `terrain-hydrology`, `remote-sensing-analysis`, `geo-data-engineering`, `cartography-geoviz`. Relevant to `pipeline/build_pack.py`: canopy height model from EPT nodes, NDVI classification of NAIP, slope and aspect products, projection handling. Install from the catalog when iterating on tree detection or masks (M0, M3).

### 7. awesome-gamedev-agent-skills (gamedev-skills, Apache-2.0, 77 skills)
Only `threejs-scene-setup`, `threejs-gltf-loading`, `threejs-materials-lighting`, `procedural-gen`, `performance-optimization`, `camera-systems`, `physics-tuning`, `game-feel` and `shader-programming` apply to us; the rest is Godot, Unity, Unreal, Roblox. Install the router plus the web bundle rather than everything:

```
claude plugin marketplace add gamedev-skills/awesome-gamedev-agent-skills
claude plugin install gamedev@awesome-gamedev-agent-skills
```

### 8. Context7 MCP (Upstash)
Pulls current library docs into context so Claude stops guessing Three.js r172 API details (BatchedMesh, CSM, Sky, InstancedMesh2 from three.ez). Add once, then say "use context7" when asking about an API.

```
claude mcp add context7 -- npx -y @upstash/context7-mcp
```

### 9. Playwright MCP (Microsoft, catalog, partner tier)
Browser automation as an MCP server. Our headless tool already uses Playwright directly, so this is only needed if you want Claude to drive a real browser interactively instead of through `tools/shoot.mjs`. parallax-threejs bundles it.

## Not worth installing for this project
- Unity official plugin, Godot/Unreal/Roblox skills: wrong engine.
- claudedesignskills `threejs-webgl`: boilerplate scaffolding we are past; `react-three-fiber` does not apply (no React).
- fe-rail, shipwright, audit-suite: generic frontend process harnesses; CLAUDE.md plus the repo skills below cover our workflow with less ceremony.
- TypeScript Patterns Enforcer, API Drift Detector: no API surface to drift yet.

## Repo-local skills (checked in under `.claude/skills/`)
Project-specific know-how belongs in the repo, not in a global install, so every session gets it on `git pull`:
- `pack-build`: how to run and validate `build_pack.py` for a resort, expected stage outputs and sizes, what to check in the pack before loading it.
- `render-check`: how to run the headless render and ride test, the `lowgfx` rule for software GPUs, what a good `01_start.png` looks like, where to put screenshots.
- `perf-check`: how to profile the game with Chrome DevTools MCP and what the budgets are (frame time, chunk count, instance count, memory).
Add more as patterns recur (for example `add-resort` once the second resort is done).

## Sources
- [threejs-game-skills](https://github.com/majidmanzarpour/threejs-game-skills)
- [Game Forge Claude skill](https://github.com/efeislekel/game-forge-claude-skill)
- [awesome-gamedev-agent-skills wiki](https://github.com/gamedev-skills/awesome-gamedev-agent-skills/wiki)
- [claudedesignskills](https://github.com/freshtechbro/claudedesignskills)
- [Three.js DevTools MCP listing](https://skillselion.com/mcp/tool/io.github.DmitriyGolub/threejs-devtools)
- [Chrome DevTools MCP listing](https://skillselion.com/mcp/tool/io.github.ChromeDevTools/chrome-devtools-mcp)
- [Chrome DevTools MCP setup notes](https://samwize.com/2026/03/26/how-to-set-up-chrome-devtools-mcp-for-claude-code/)
- [Anthropic webapp-testing skill](https://www.typingmind.com/skills/anthropics-webapp-testing)
- [Context7](https://github.com/upstash/context7)
