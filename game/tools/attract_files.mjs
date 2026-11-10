// FEAT-181: the main menu's files in game/public/attract, written the same way by the dev server (vite.config.ts:
// /__attract/save, /__attract/shot) and by tools/ghost_lines.mjs. Always into the checkout the caller runs from.
//   index.json        per resort: stills, ghosts (take files), looks (the still's look key), shotGhosts (per shot,
//                     the takes ghost_lines.mjs made for it)
//   <pack>/shots.json the resort's menu shots (the menu uses the first; one per resort for now)
//   <pack>/take-<n>.json  a recorded take; <shot>-<line>-<i>.json  a generated one
import fs from 'node:fs';
import path from 'node:path';

export const SLUG = /^[a-z0-9][a-z0-9_-]*$/;

export function readIndex(dir) {
  const f = path.join(dir, 'index.json');
  return Object.assign(Object.create(null), fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {});
}
export function writeIndex(dir, man) {
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(man, null, 2) + '\n');
}

/**
 * The next recorded take's name: one past the highest take-<n> in the index or the folder, so a number is never
 * reused once files are moved out (they used to fill the first gap: take-6 again and again).
 */
export function nextTakeName(dir, pack) {
  const man = readIndex(dir), d = path.join(dir, pack);
  const names = [...(man[pack]?.ghosts ?? []), ...(fs.existsSync(d) ? fs.readdirSync(d) : [])];
  const n = Math.max(0, ...names.map((f) => /^take-(\d+)\.json$/.exec(f)).filter(Boolean).map((m) => Number(m[1])));
  return `take-${n + 1}.json`;
}

/** Save a recorded take (`take` parsed and checked) and list it; returns the repo-relative path. */
export function saveTake(dir, pack, take) {
  const d = path.join(dir, pack);
  fs.mkdirSync(d, { recursive: true });
  const name = nextTakeName(dir, pack);
  fs.writeFileSync(path.join(d, name), JSON.stringify(take) + '\n');
  const man = readIndex(dir), e = (man[pack] ??= {});
  e.ghosts = [...(e.ghosts ?? []), name];
  writeIndex(dir, man);
  return `game/public/attract/${pack}/${name}`;
}

export function readShots(dir, pack) {
  const f = path.join(dir, pack, 'shots.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
}

const num = (v) => typeof v === 'number' && Number.isFinite(v);
/** a shot posted by the eye camera, checked and with the drift's defaults filled in */
export function cleanShot(s) {
  if (!s || typeof s !== 'object') throw new Error('no shot');
  const id = String(s.id ?? '').trim().toLowerCase();
  if (!SLUG.test(id) || id.length > 40) throw new Error('the shot name: lower case letters, digits, - and _ (up to 40)');
  for (const k of ['x', 'y', 'h', 'pitch', 'fov', 'eye']) if (!num(s[k])) throw new Error(`the shot's ${k} is not a number`);
  const str = (v, max) => String(v ?? '').slice(0, max);
  const c = s.conditions ?? {};
  const shot = {
    id, x: +s.x.toFixed(1), y: +s.y.toFixed(1), h: +s.h.toFixed(1), pitch: +s.pitch.toFixed(1), fov: +s.fov.toFixed(1), eye: +s.eye.toFixed(2),
    place: str(s.place, 60) || id, region: str(s.region, 60),
    ...(s.elev && num(s.elev.m) ? { elev: { m: Math.round(s.elev.m), where: str(s.elev.where, 60) } } : {}),
    dolly: num(s.dolly) ? s.dolly : 4, pan: num(s.pan) ? s.pan : 1.5, period: num(s.period) ? s.period : 26,
    conditions: {
      clouds: str(c.clouds ?? 'few', 20), timeOfDay: num(c.timeOfDay) ? c.timeOfDay : 'pack', month: num(c.month) ? c.month : 2,
      newSnow: str(c.newSnow ?? 'none', 20), snowDay: str(c.snowDay ?? 'mid', 20), valleyFog: !!c.valleyFog, cloudTime: num(c.cloudTime) ? c.cloudTime : 0,
    },
  };
  if (s.note) shot.note = str(s.note, 400);
  return shot;
}

/** the takes generated for a shot (they were cast for its camera), their files and listings, and its still */
export function removeShotFiles(dir, pack, id) {
  const man = readIndex(dir), e = man[pack];
  if (!e) return [];
  const gen = e.shotGhosts?.[id] ?? [];
  for (const f of gen) fs.rmSync(path.join(dir, pack, f), { force: true });
  if (e.ghosts) e.ghosts = e.ghosts.filter((f) => !gen.includes(f));
  if (e.shotGhosts) delete e.shotGhosts[id];
  const removed = [...gen];
  if (e.stills?.includes(id)) { e.stills = e.stills.filter((s) => s !== id); fs.rmSync(path.join(dir, pack, `${id}.jpg`), { force: true }); removed.push(`${id}.jpg`); }
  if (e.looks) delete e.looks[id];
  writeIndex(dir, man);
  return removed;
}

/**
 * Save the resort's menu shot (one per resort for now: it replaces the one there). The old shot's generated takes
 * and its still go with it (they belong to its camera); a shot posted again unchanged keeps them. Recorded take-*
 * files are never touched. Returns { file, removed }.
 */
export function saveShot(dir, pack, posted) {
  const shot = cleanShot(posted);
  fs.mkdirSync(path.join(dir, pack), { recursive: true });
  const old = readShots(dir, pack)[0];
  const pose = (s) => { const { note, ...rest } = s; return JSON.stringify(rest); }; // the note isn't the camera
  const same = old && pose(cleanShot(old)) === pose(shot);
  const removed = old && !same ? removeShotFiles(dir, pack, old.id) : [];
  fs.writeFileSync(path.join(dir, pack, 'shots.json'), JSON.stringify([shot], null, 2) + '\n');
  // the manifest says the resort has shots, so the game asks for shots.json (and no resort without one 404s)
  const man = readIndex(dir);
  (man[pack] ??= {}).shots = true;
  writeIndex(dir, man);
  return { file: `game/public/attract/${pack}/shots.json`, shot, removed };
}

/** read a JSON POST body (the dev server listens on the home network: the game's own page, JSON, a few MB) */
export function readJsonPost(req, res, max, cb) {
  const origin = req.headers.origin, host = req.headers.host;
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json') || (origin && host && new URL(origin).host !== host)) { res.statusCode = 403; res.end('forbidden'); return; }
  const chunks = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size > max) { res.statusCode = 413; res.end('too big'); req.destroy(); return; } chunks.push(c); });
  req.on('end', () => {
    if (size > max) return;
    try {
      const out = cb(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.statusCode = 200; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out));
    } catch (e) { res.statusCode = 400; res.end(String(e?.message ?? e)); }
  });
}

/** the work folder of tools/ghost_lines.mjs for a resort (gitignored), from the attract folder */
export const workRoot = (dir, pack) => path.resolve(dir, '..', '..', 'shots', 'ghost-lines', pack);
export function readCandidates(dir, pack) {
  const f = path.join(workRoot(dir, pack), 'candidates.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : [];
}
/** Keep a shot as a candidate to compare (the work folder; the menu's shot is untouched). Same name replaces. */
export function saveCandidate(dir, pack, posted) {
  const shot = cleanShot(posted), d = workRoot(dir, pack);
  fs.mkdirSync(d, { recursive: true });
  const all = readCandidates(dir, pack).filter((c) => c.id !== shot.id);
  all.push(shot);
  fs.writeFileSync(path.join(d, 'candidates.json'), JSON.stringify(all, null, 2) + '\n');
  return { file: `game/shots/ghost-lines/${pack}/candidates.json`, shot, candidates: all.length, removed: [] };
}

/** POST /__attract/shot { pack, shot, candidate? } (the eye camera's Shift+P with ?debug) */
export function handleShotPost(dir, req, res) {
  readJsonPost(req, res, 1e5, (body) => {
    if (typeof body.pack !== 'string' || !SLUG.test(body.pack)) throw new Error('bad pack');
    return body.candidate ? saveCandidate(dir, body.pack, body.shot) : saveShot(dir, body.pack, body.shot);
  });
}
/** POST /__attract/save { pack, take } (the replay viewer's L with ?debug) */
export function handleTakePost(dir, req, res) {
  readJsonPost(req, res, 8e6, (body) => {
    if (typeof body.pack !== 'string' || !SLUG.test(body.pack)) throw new Error('bad pack');
    const take = JSON.parse(String(body.take));
    if (take.version !== 1 || !Array.isArray(take.samples) || !take.samples.length || !take.samples.every((s) => num(s.t) && num(s.x) && num(s.y) && num(s.z))) throw new Error('not a take');
    return { file: saveTake(dir, body.pack, take) };
  });
}
