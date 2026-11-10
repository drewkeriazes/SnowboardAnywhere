// Folder locations for the tools, resolved from this file so they work from any working directory (BUG-039).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GAME = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO = path.resolve(GAME, '..');
// SHOT_DIST: another build to serve (an A/B against main, FEAT-154)
export const DIST = process.env.SHOT_DIST ? path.resolve(process.env.SHOT_DIST) : path.join(GAME, 'dist');
export const PACKS = path.join(REPO, 'packs');
