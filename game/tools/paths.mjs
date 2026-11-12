// Folder locations for the tools, resolved from this file so they work from any working directory (BUG-039).
// FEAT-261: in the Windows launcher (SnowboardAnywhere.exe, bundled by tools/package.mjs, which defines
// SBA_LAUNCHER) they are next to the exe instead: the prebuilt game in game/, the packs in packs/.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/* global SBA_LAUNCHER */
export const LAUNCHER = typeof SBA_LAUNCHER !== 'undefined';
const EXE_DIR = LAUNCHER ? path.dirname(process.execPath) : null;

export const GAME = EXE_DIR ? path.join(EXE_DIR, 'game') : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = EXE_DIR ?? path.resolve(GAME, '..');
// SHOT_DIST: another build to serve (an A/B against main, FEAT-154)
export const DIST = EXE_DIR ? GAME : process.env.SHOT_DIST ? path.resolve(process.env.SHOT_DIST) : path.join(GAME, 'dist');
// SHOT_PACKS: another packs folder (the local render-budgets run's downloaded synthetic pack, FEAT-176 / FEAT-241)
export const PACKS = EXE_DIR ? path.join(EXE_DIR, 'packs') : process.env.SHOT_PACKS ? path.resolve(process.env.SHOT_PACKS) : path.join(REPO, 'packs');
