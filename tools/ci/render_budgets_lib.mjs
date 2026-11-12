// FEAT-176 / FEAT-183: the local render-budgets run (CI's `render-budgets` job on Drew's GPU), shared by
// tools/ci/local_render_budgets.mjs (run by hand) and tools/ci/pre_push_render_budgets.mjs (the pre-push hook).
//
//   const ctx = prepare({ repo, sha, pr, mode })   preconditions; throws Stop with a reason on a refusal
//   const res = runCheck(ctx)                       builds, cishot.mjs on both sides, render_report.py
//   post(ctx, res)                                  the `render-budgets/local` status and the PR comment
//
// It builds the merge base with origin/<base> ("before") and the commit ("after") in their own detached
// worktrees, runs the commit's game/tools/cishot.mjs on both with the synthetic pack CI downloads (FEAT-241:
// MapPacker's release, the catalog's synth at this game's PACK_FORMAT, one pack for both sides), then the
// commit's tools/ci/render_report.py: the same commands as the CI job. CI accepts the status only when it was set by the repo owner, on the exact
// head SHA, with the PR's current merge base, the same tools hash (tools/ci/render_budgets_key.sh) and the
// same synthetic pack key, and the PR did not ask for stills.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CATALOG_URL } from '../../game/tools/get_pack.mjs';

export const MARKER = '<!-- ci-stills -->';
export const CONTEXT = 'render-budgets/local';
/** set on the `git push` that local_render_budgets.mjs --push makes, so the pre-push hook doesn't run the check again */
export const PUSH_GUARD = 'SA_RENDER_BUDGETS_PUSH';
/** testing aid for a machine without a GPU (a cloud session testing the tools): the cishot flag, default --gpu.
 *  Never set on Drew's PC: the local run is meant to be the real GPU. */
const SHOT_FLAG = process.env.RB_SHOT_FLAG ?? '--gpu';

export class Stop extends Error {}
const die = (msg) => { throw new Stop(msg); };
export const PYTHON = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');

// a hook runs with git's own variables set; the build worktrees are other checkouts, so drop them
const ENV = { ...process.env };
for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_PREFIX', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR']) delete ENV[k];

export function out(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, env: ENV, ...opts }).trim();
}
export function tryOut(cmd, args, opts = {}) { try { return out(cmd, args, opts); } catch { return null; } }

/**
 * Where child output and progress lines go. `log: 'inherit'` (by hand) prints everything; a file path (the
 * hook) writes the build and browser output there and prints only the step lines.
 */
function makeLog(log) {
  const t0 = Date.now();
  const fd = log === 'inherit' ? null : fs.openSync(log, 'a');
  const secs = () => Math.round((Date.now() - t0) / 1000);
  const write = (s) => { if (fd !== null) fs.writeSync(fd, `${s}\n`); };
  return {
    t0, secs, fd,
    step(title) { const s = `== ${title} (${secs()} s)`; write(s); console.log(fd === null ? `\n${s}` : `  ${s}`); },
    info(s) { write(s); if (fd === null) console.log(s); },
    warn(s) { write(s); console.warn(s); },
    run(cmd, args, opts = {}) {
      const r = spawnSync(cmd, args, { stdio: fd === null ? 'inherit' : ['ignore', fd, fd], env: ENV, ...opts });
      if (r.error) throw r.error;
      return r.status;
    },
    close() { if (fd !== null) fs.closeSync(fd); },
  };
}

// Git Bash, not WSL's bash.exe, on Windows (the .sh helpers need sha256sum, find and a POSIX sort)
function findBash() {
  if (process.env.RB_BASH) return process.env.RB_BASH;
  if (process.platform !== 'win32') return 'bash';
  const exec = out('git', ['--exec-path']); // .../Git/mingw64/libexec/git-core
  for (const c of ['../../../bin/bash.exe', '../../../usr/bin/bash.exe']) {
    const p = path.resolve(exec, c);
    if (fs.existsSync(p)) return p;
  }
  die('could not find Git Bash next to git; set RB_BASH to bash.exe');
}

export function defaultCache() {
  return path.resolve(process.env.RB_CACHE ?? path.join(os.homedir(), '.cache', 'snowboardanywhere-ci'));
}

/**
 * The PR for a number, a branch name, or (no argument) the current branch, or null (no PR, or gh not signed
 * in). REST, not `gh pr view`: GraphQL isn't reachable from cloud sessions.
 */
export function findPr(repo, which) {
  const full = tryOut('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], { cwd: repo })
    ?? tryOut('gh', ['api', 'repos/{owner}/{repo}', '--jq', '.full_name'], { cwd: repo });
  if (!full) return null;
  const shape = '{number, headRefOid: .head.sha, headRefName: .head.ref, baseRefName: .base.ref, labels: [.labels[] | {name}], '
    + 'state: (if .merged_at then "MERGED" else (.state | ascii_upcase) end), url: .html_url, '
    + `isCrossRepository: (.head.repo.full_name != "${full}")}`;
  let json;
  if (which && /^\d+$/.test(String(which))) {
    json = tryOut('gh', ['api', `repos/${full}/pulls/${which}`, '--jq', shape], { cwd: repo });
  } else {
    const branch = which ?? tryOut('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repo });
    const owner = full.split('/')[0];
    json = tryOut('gh', ['api', `repos/${full}/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}`, '--jq', `first(.[] | ${shape}) // empty`], { cwd: repo });
  }
  return json ? JSON.parse(json) : null;
}

/** the paths CI's `changes` filter turns render-budgets on for (checks.yml: the ci and game filters) */
export const BUDGET_PATHS = /^(game\/|tools\/ci\/|\.github\/workflows\/checks\.yml$)/;

/**
 * Preconditions. mode 'manual': the commit is HEAD; it must be the PR's head on GitHub, or (push: true) ahead
 * of it. mode 'hook': the commit is about to be pushed to the PR's branch, so GitHub doesn't have it yet.
 */
export function prepare({ repo, sha = 'HEAD', pr: prArg, mode = 'manual', push = false, cache = defaultCache(), log = 'inherit', keep = false }) {
  const L = makeLog(log);
  const git = (...a) => out('git', a, { cwd: repo });
  const dirty = git('status', '--porcelain');
  if (dirty) die(`the working tree is not clean; commit first:\n${dirty}`);
  const HEAD = git('rev-parse', 'HEAD');
  const SHA = git('rev-parse', `${sha}^{commit}`);
  if (SHA !== HEAD) die(`the commit ${SHA.slice(0, 12)} is not this worktree's HEAD (${HEAD.slice(0, 12)})`);

  const pr = typeof prArg === 'object' && prArg ? prArg : findPr(repo, prArg);
  if (!pr) die('no PR found for this branch (or gh is not signed in). Open the PR first: its first push runs render-budgets in CI as usual.');
  if (pr.state !== 'OPEN') die(`PR #${pr.number} is ${pr.state.toLowerCase()}`);
  if (pr.isCrossRepository) die(`PR #${pr.number} comes from a fork; run it from a branch in this repo`);
  if (pr.labels.some((l) => l.name === 'stills')) die(`PR #${pr.number} has the stills label, so CI runs render-budgets anyway (the local run does not compare stills)`);

  const owner = out('gh', ['repo', 'view', '--json', 'owner', '--jq', '.owner.login'], { cwd: repo });
  const me = out('gh', ['api', 'user', '--jq', '.login'], { cwd: repo });
  if (me !== owner) die(`signed in to gh as ${me}; CI only trusts ${CONTEXT} statuses from ${owner}`);

  let needPush = false;
  if (mode === 'manual' && SHA !== pr.headRefOid) {
    if (!push) die(`HEAD ${SHA.slice(0, 12)} is not the head of PR #${pr.number} on GitHub (${pr.headRefOid.slice(0, 12)}). Push first, or run with --push.`);
    git('fetch', '-q', 'origin', pr.headRefName);
    if (tryOut('git', ['merge-base', '--is-ancestor', pr.headRefOid, 'HEAD'], { cwd: repo }) === null) {
      die(`HEAD does not fast-forward PR #${pr.number}'s branch ${pr.headRefName} (${pr.headRefOid.slice(0, 12)}); pull or rebase first`);
    }
    needPush = true;
  } else if (mode === 'manual') {
    const runs = tryOut('gh', ['api', `repos/{owner}/{repo}/actions/workflows/checks.yml/runs?head_sha=${SHA}`, '--jq', '.total_count'], { cwd: repo });
    if (runs && runs !== '0') L.info(`note: CI already started on ${SHA.slice(0, 12)}, so this pass applies to re-runs of it. Next time commit, then run with --push.`);
  }

  checkInstalled(path.join(repo, 'game'));
  git('fetch', '-q', 'origin', pr.baseRefName);
  const BASE = git('merge-base', 'FETCH_HEAD', SHA);
  const BASH = findBash();
  const TOOLS = out(BASH, ['tools/ci/render_budgets_key.sh', SHA], { cwd: repo });
  L.info(`PR #${pr.number}: before = merge base ${BASE.slice(0, 12)} with origin/${pr.baseRefName}, after = ${SHA.slice(0, 12)}; tools ${TOOLS}; cache ${cache}`);
  return { repo, git, L, pr, owner, SHA, BASE, TOOLS, BASH, needPush, cache, keep };
}

// installed versions must be what the lockfile says, as `npm ci` gives CI: a different three, vite or playwright
// could change the counts. A package that is not installed at all only warns: the build or cishot fails loudly
// if it needed it (game/node_modules is often a junction to the main checkout, shared by every session).
function checkInstalled(gameDir) {
  const lock = JSON.parse(fs.readFileSync(path.join(gameDir, 'package-lock.json'), 'utf8')).packages ?? {};
  const hiddenPath = path.join(gameDir, 'node_modules', '.package-lock.json');
  if (!fs.existsSync(hiddenPath)) die(`${path.join(gameDir, 'node_modules')} is missing or was not installed by npm; run npm ci in game/`);
  const have = JSON.parse(fs.readFileSync(hiddenPath, 'utf8')).packages ?? {};
  const bad = [], missing = [];
  for (const [k, v] of Object.entries(lock)) {
    if (!k.startsWith('node_modules/')) continue;
    if (!have[k]) { if (!v.optional) missing.push(k.slice('node_modules/'.length)); continue; }
    if (v.version && have[k].version !== v.version) bad.push(`${k} ${have[k].version} (lockfile ${v.version})`);
  }
  if (missing.length) console.warn(`warning: not installed in game/node_modules (npm ci would add them): ${missing.slice(0, 10).join(', ')}`);
  if (bad.length) die(`game/node_modules does not match game/package-lock.json; run npm ci in game/:\n  ${bad.slice(0, 10).join('\n  ')}`);
}

/** Builds both sides and runs the check. Returns { pass, outDir, body, gpu, desc }; never posts anything. */
export function runCheck(ctx) {
  const { repo, git, L, SHA, BASE, TOOLS, cache, keep } = ctx;
  // ---- the synthetic pack ----------------------------------------------------------------------------
  /** the packs folder (packs/synth plus index.json) CI's synth-pack job would download, and its cache key: one
   *  read of the catalog for both, the commit's get_pack.mjs for the download, kept in the cache per release */
  function synthPacks() {
    const tool = path.join(repo, 'game', 'tools', 'get_pack.mjs');
    const catalog = path.join(cache, 'catalog.json');
    fs.mkdirSync(cache, { recursive: true });
    const fetchCatalog = "fetch(process.argv[1], { cache: 'no-store' }).then((r) => r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))).then((t) => process.stdout.write(t))";
    const text = tryOut(process.execPath, ['-e', fetchCatalog, CATALOG_URL]);
    if (!text) die(`could not read the catalog ${CATALOG_URL}`);
    fs.writeFileSync(catalog, text);
    const sha = tryOut(process.execPath, [tool, 'synth', '--sha256', '--catalog', catalog]);
    if (!sha) die(`no synthetic pack for this game's pack format in ${CATALOG_URL} (MapPacker: publish_pack.py --synth)`);
    const key = `synth-sha-${sha.slice(0, 16)}`;
    const dir = path.join(cache, 'synth', key);
    if (!fs.existsSync(path.join(dir, '.done'))) {
      L.step(`downloading the synthetic pack ${key}`);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      if (L.run(process.execPath, [tool, 'synth', '--catalog', catalog, '--packs', dir]) !== 0) die('get_pack.mjs synth failed');
      fs.writeFileSync(path.join(dir, 'index.json'), '{"packs":["synth"]}\n');
      fs.writeFileSync(path.join(dir, '.done'), '');
    }
    return { key, dir };
  }
  const synth = synthPacks();

  // ---- builds ----------------------------------------------------------------------------------------
  const runDir = path.join(cache, 'runs', SHA.slice(0, 12));
  const repoModules = fs.realpathSync(path.join(repo, 'game', 'node_modules'));
  const headLock = fs.readFileSync(path.join(repo, 'game', 'package-lock.json'));

  function unlinkModules(wt) {
    const link = path.join(wt, 'game', 'node_modules');
    let st; try { st = fs.lstatSync(link); } catch { return true; }
    if (!st.isSymbolicLink()) return true; // a real npm ci install inside the worktree: removed with it
    try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch { /* checked below */ } }
    return !fs.existsSync(link);
  }
  function removeWorktree(wt) {
    if (!fs.existsSync(wt)) { tryOut('git', ['worktree', 'prune'], { cwd: repo }); return; }
    // never let the removal follow the node_modules link into the main checkout
    if (!unlinkModules(wt)) { L.warn(`warning: could not remove the node_modules link in ${wt}; left the worktree in place`); return; }
    if (tryOut('git', ['worktree', 'remove', '--force', wt], { cwd: repo }) === null) L.warn(`warning: could not remove the worktree ${wt}`);
  }
  function buildAt(sha, wt) {
    removeWorktree(wt);
    git('worktree', 'add', '--detach', wt, sha);
    const game = path.join(wt, 'game');
    if (fs.readFileSync(path.join(game, 'package-lock.json')).equals(headLock)) {
      fs.symlinkSync(repoModules, path.join(game, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      L.step(`npm ci at ${sha.slice(0, 12)} (its lockfile differs)`);
      if (L.run('npm', ['ci'], { cwd: game, shell: process.platform === 'win32' }) !== 0) die(`npm ci failed at ${sha.slice(0, 12)}`);
    }
    L.step(`vite build at ${sha.slice(0, 12)}`);
    if (L.run(process.execPath, [path.join('node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: game }) !== 0) die(`vite build failed at ${sha.slice(0, 12)}`);
    return game;
  }
  const wtBase = path.join(runDir, 'base'), wtHead = path.join(runDir, 'head');
  try {
    const gameBase = buildAt(BASE, wtBase);
    const gameHead = buildAt(SHA, wtHead);

    // ---- render, as the CI job does: the commit's cishot.mjs on both builds ----------------------------
    const outDir = path.join(runDir, 'out');
    fs.rmSync(outDir, { recursive: true, force: true });
    const env = { ...ENV };
    for (const k of ['SHOT_QUERY', 'SHOT_CPU', 'SHOT_HEADED']) delete env[k];
    const cishot = path.join(gameHead, 'tools', 'cishot.mjs');
    L.step('cishot.mjs on the merge base (before)');
    L.run(process.execPath, [cishot, 'synth', path.join(outDir, 'before'), SHOT_FLAG],
      { cwd: gameHead, env: { ...env, SHOT_DIST: path.join(gameBase, 'dist'), SHOT_PACKS: synth.dir } });
    L.step(`cishot.mjs on ${SHA.slice(0, 12)} (after)`);
    const after = L.run(process.execPath, [cishot, 'synth', path.join(outDir, 'after'), SHOT_FLAG],
      { cwd: gameHead, env: { ...env, SHOT_DIST: path.join(gameHead, 'dist'), SHOT_PACKS: synth.dir } });

    L.step('render_report.py');
    const reportDir = path.join(outDir, 'report');
    const rep = L.run(PYTHON, [path.join(wtHead, 'tools', 'ci', 'render_report.py'), path.join(outDir, 'before'), path.join(outDir, 'after'), reportDir,
      '--before-dist', path.join(gameBase, 'dist'), '--after-dist', path.join(gameHead, 'dist')]);
    const reportPath = path.join(reportDir, 'report.md');
    if (after !== 0 || rep !== 0 || !fs.existsSync(reportPath)) {
      return { pass: false, outDir, reportPath: fs.existsSync(reportPath) ? reportPath : null,
        why: after !== 0 ? 'cishot on the commit: shader message, page error or crash' : 'over budget (see the report)' };
    }
    const gpu = JSON.parse(fs.readFileSync(path.join(outDir, 'after', 'stats.json'), 'utf8')).gpu ?? 'unknown GPU';
    const lines = fs.readFileSync(reportPath, 'utf8').split('\n');
    lines.splice(2, 0, '', `**Run locally** on \`${os.hostname()}\` (\`${gpu}\`) with \`tools/ci/local_render_budgets.mjs\` or the pre-push hook: after is ${SHA}, before is the merge base ${BASE}. CI skips its own \`render-budgets\` run for this commit; a new push, a new merge base, a change to the tools or a \`stills\` request runs it again.`);
    const body = path.join(reportDir, 'comment.md');
    fs.writeFileSync(body, lines.join('\n'));
    return { pass: true, outDir, body, gpu, desc: `passed base=${BASE} tools=${TOOLS} synth=${synth.key}` };
  } finally {
    if (!keep) { removeWorktree(wtBase); removeWorktree(wtHead); }
  }
}

/** The `render-budgets/local` status (first: CI's job reads it about 30 s after a push), then the PR comment. */
export function post({ repo, sha, prNumber, prUrl, owner, desc, body }) {
  out('gh', ['api', `repos/{owner}/{repo}/statuses/${sha}`, '-f', 'state=success', '-f', `context=${CONTEXT}`, '-f', `description=${desc}`, '-f', `target_url=${prUrl}`], { cwd: repo });
  const ids = out('gh', ['api', `repos/{owner}/{repo}/issues/${prNumber}/comments?per_page=100`, '--paginate', '--jq',
    `.[] | select((.user.login == "github-actions[bot]" or .user.login == "${owner}") and (.body | startswith("${MARKER}"))) | .id`], { cwd: repo });
  const id = ids.split('\n').filter(Boolean).pop();
  const patched = id && tryOut('gh', ['api', '-X', 'PATCH', `repos/{owner}/{repo}/issues/comments/${id}`, '-F', `body=@${body}`, '--jq', '.html_url'], { cwd: repo });
  return patched || out('gh', ['api', `repos/{owner}/{repo}/issues/${prNumber}/comments`, '-F', `body=@${body}`, '--jq', '.html_url'], { cwd: repo });
}
