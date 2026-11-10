#!/usr/bin/env node
// FEAT-176: the CI `render-budgets` check (checks.yml), run on Drew's PC on the real GPU. On a pass it posts
// the report as the PR's `<!-- ci-stills -->` comment and a `render-budgets/local` commit status on the head
// SHA; CI then skips its own run for that exact commit (about 2 minutes per side on SwiftShader). On a fail
// it prints the report and posts nothing, so CI runs and fails the normal way.
//
//   node tools/ci/local_render_budgets.mjs [--push] [--pr N] [--keep] [--cache DIR]
//
// Run it inside the PR's worktree with a clean tree. It builds the merge base with origin/<base> ("before")
// and HEAD ("after") in their own detached worktrees, runs HEAD's game/tools/cishot.mjs --gpu on both with
// the synthetic pack CI would build (tools/ci/synth_key.sh on an LF copy of each pipeline/), then HEAD's
// tools/ci/render_report.py, the same commands as the CI job.
//   default   HEAD must already be the PR's head on GitHub. CI starts render-budgets about 30 s after a
//             push, so a run started after pushing usually helps only re-runs of that commit.
//   --push    HEAD is ahead of the PR's head (committed, not pushed): run first, and only on a pass push
//             HEAD to the PR's branch and post at once, before CI's job reaches its check.
//   --pr N    the PR (default: the PR of the current branch)
//   --keep    keep the two build worktrees (default: removed at the end)
//   --cache   where synthetic packs, worktrees and outputs go (default ~/.cache/snowboardanywhere-ci)
//
// CI accepts the status only when it was set by the repo owner, on the exact head SHA, with the PR's current
// merge base, the same tools hash (tools/ci/render_budgets_key.sh) and the same synthetic pack key, and the
// PR did not ask for stills. Anything else and CI runs the check itself.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MARKER = '<!-- ci-stills -->';
const CONTEXT = 'render-budgets/local';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const PUSH = flag('--push'), KEEP = flag('--keep');
const CACHE = path.resolve(opt('--cache') ?? process.env.RB_CACHE ?? path.join(os.homedir(), '.cache', 'snowboardanywhere-ci'));
const PYTHON = process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
const t0 = Date.now();

class Stop extends Error {}
let cleanup = () => {};
/** stop with a message (exit code 2); the build worktrees are still removed */
function die(msg) { throw new Stop(msg); }
process.on('uncaughtException', (e) => {
  try { cleanup(); } catch { /* best effort */ }
  console.error(e instanceof Stop ? `local render-budgets: ${e.message}` : e);
  process.exit(e instanceof Stop ? 2 : 1);
});
function out(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20, ...opts }).trim();
}
function tryOut(cmd, args, opts = {}) { try { return out(cmd, args, opts); } catch { return null; } }
function step(title) { console.log(`\n== ${title} (${Math.round((Date.now() - t0) / 1000)} s)`); }
function runInherit(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  return r.status;
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

const REPO = tryOut('git', ['rev-parse', '--show-toplevel']) ?? die('not inside a git checkout');
const git = (...a) => out('git', a, { cwd: REPO });
const BASH = findBash();
// Windows' own bsdtar: Git Bash's GNU tar reads `C:` in a path as a remote host
const winTar = process.platform === 'win32' && path.join(process.env.SystemRoot ?? 'C:\Windows', 'System32', 'tar.exe');
const TAR = winTar && fs.existsSync(winTar) ? winTar : 'tar';

// ---- preconditions ----------------------------------------------------------------------------------
const dirty = git('status', '--porcelain');
if (dirty) die(`the working tree is not clean; commit first:\n${dirty}`);
const HEAD = git('rev-parse', 'HEAD');

const prJson = tryOut('gh', ['pr', 'view', ...(opt('--pr') ? [opt('--pr')] : []), '--json',
  'number,headRefOid,headRefName,baseRefName,labels,state,url,isCrossRepository'], { cwd: REPO });
if (!prJson) die('no PR found for this branch (or gh is not signed in). Open the PR first: its first push runs render-budgets in CI as usual.');
const pr = JSON.parse(prJson);
if (pr.state !== 'OPEN') die(`PR #${pr.number} is ${pr.state.toLowerCase()}`);
if (pr.isCrossRepository) die(`PR #${pr.number} comes from a fork; run it from a branch in this repo`);
if (pr.labels.some((l) => l.name === 'stills')) die(`PR #${pr.number} has the stills label, so CI runs render-budgets anyway (the local run does not compare stills)`);

const owner = out('gh', ['repo', 'view', '--json', 'owner', '--jq', '.owner.login'], { cwd: REPO });
const me = out('gh', ['api', 'user', '--jq', '.login'], { cwd: REPO });
if (me !== owner) die(`signed in to gh as ${me}; CI only trusts ${CONTEXT} statuses from ${owner}`);

let needPush = false;
if (HEAD !== pr.headRefOid) {
  if (!PUSH) die(`HEAD ${HEAD.slice(0, 12)} is not the head of PR #${pr.number} on GitHub (${pr.headRefOid.slice(0, 12)}). Push first, or run with --push.`);
  git('fetch', '-q', 'origin', pr.headRefName);
  if (tryOut('git', ['merge-base', '--is-ancestor', pr.headRefOid, 'HEAD'], { cwd: REPO }) === null) {
    die(`HEAD does not fast-forward PR #${pr.number}'s branch ${pr.headRefName} (${pr.headRefOid.slice(0, 12)}); pull or rebase first`);
  }
  needPush = true;
} else {
  const runs = tryOut('gh', ['api', `repos/{owner}/{repo}/actions/workflows/checks.yml/runs?head_sha=${HEAD}`, '--jq', '.total_count'], { cwd: REPO });
  if (runs && runs !== '0') console.log(`note: CI already started on ${HEAD.slice(0, 12)}, so this pass applies to re-runs of it. Next time commit, then run with --push.`);
}

// node_modules must be what the lockfile says, as `npm ci` gives CI
function checkInstalled(gameDir) {
  const lock = JSON.parse(fs.readFileSync(path.join(gameDir, 'package-lock.json'), 'utf8')).packages ?? {};
  const hiddenPath = path.join(gameDir, 'node_modules', '.package-lock.json');
  if (!fs.existsSync(hiddenPath)) die(`${path.join(gameDir, 'node_modules')} is missing or was not installed by npm; run npm ci in game/`);
  const have = JSON.parse(fs.readFileSync(hiddenPath, 'utf8')).packages ?? {};
  const bad = [];
  for (const [k, v] of Object.entries(lock)) {
    if (!k.startsWith('node_modules/')) continue;
    if (!have[k]) { if (!v.optional) bad.push(`${k} missing`); continue; }
    if (v.version && have[k].version !== v.version) bad.push(`${k} ${have[k].version} (lockfile ${v.version})`);
  }
  if (bad.length) die(`game/node_modules does not match game/package-lock.json; run npm ci in game/:\n  ${bad.slice(0, 10).join('\n  ')}`);
}
checkInstalled(path.join(REPO, 'game'));

git('fetch', '-q', 'origin', pr.baseRefName);
const BASE = git('merge-base', 'FETCH_HEAD', 'HEAD');
const TOOLS = out(BASH, ['tools/ci/render_budgets_key.sh', 'HEAD'], { cwd: REPO });
console.log(`PR #${pr.number}: before = merge base ${BASE.slice(0, 12)} with origin/${pr.baseRefName}, after = HEAD ${HEAD.slice(0, 12)}; tools ${TOOLS}; cache ${CACHE}`);

// ---- synthetic packs ---------------------------------------------------------------------------------
const posix = (p) => p.split(path.sep).join('/');
/** the synth key of <sha>'s pipeline/ as CI computes it: synth_key.sh on an LF checkout */
function synthKey(sha) {
  const src = path.join(CACHE, 'src', sha);
  if (!fs.existsSync(path.join(src, '.done'))) {
    fs.rmSync(src, { recursive: true, force: true });
    fs.mkdirSync(src, { recursive: true });
    const tarFile = path.join(src, 'pipeline.tar');
    git('-c', 'core.autocrlf=false', '-c', 'core.eol=lf', 'archive', '--format=tar', '-o', tarFile, sha, 'pipeline');
    out(TAR, ['-xf', tarFile, '-C', src]);
    fs.rmSync(tarFile);
    fs.writeFileSync(path.join(src, '.done'), '');
  }
  return { key: out(BASH, ['tools/ci/synth_key.sh', posix(path.join(src, 'pipeline'))], { cwd: REPO }), src };
}
/** the packs folder (packs/synth plus index.json) for a synth key, built once and kept in the cache */
function synthPacks({ key, src }) {
  const dir = path.join(CACHE, 'synth', key);
  if (!fs.existsSync(path.join(dir, '.done'))) {
    step(`building the synthetic pack ${key} (about 2 minutes)`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    if (runInherit(PYTHON, [path.join(src, 'pipeline', 'synth_pack.py'), path.join(dir, 'synth')]) !== 0) die('synth_pack.py failed');
    fs.writeFileSync(path.join(dir, 'index.json'), '{"packs":["synth"]}\n');
    fs.writeFileSync(path.join(dir, '.done'), '');
  }
  return dir;
}
const synthBase = synthKey(BASE), synthHead = synthKey(HEAD);
const packsBase = synthPacks(synthBase), packsHead = synthPacks(synthHead);

// ---- builds ------------------------------------------------------------------------------------------
const runDir = path.join(CACHE, 'runs', HEAD.slice(0, 12));
const repoModules = fs.realpathSync(path.join(REPO, 'game', 'node_modules'));
const headLock = fs.readFileSync(path.join(REPO, 'game', 'package-lock.json'));

function unlinkModules(wt) {
  const link = path.join(wt, 'game', 'node_modules');
  let st; try { st = fs.lstatSync(link); } catch { return true; }
  if (!st.isSymbolicLink()) return true; // a real npm ci install inside the worktree: removed with it
  try { fs.unlinkSync(link); } catch { try { fs.rmdirSync(link); } catch { /* checked below */ } }
  return !fs.existsSync(link);
}
function removeWorktree(wt) {
  if (!fs.existsSync(wt)) { tryOut('git', ['worktree', 'prune'], { cwd: REPO }); return; }
  // never let the removal follow the node_modules link into the main checkout
  if (!unlinkModules(wt)) { console.warn(`warning: could not remove the node_modules link in ${wt}; left the worktree in place`); return; }
  if (tryOut('git', ['worktree', 'remove', '--force', wt], { cwd: REPO }) === null) console.warn(`warning: could not remove the worktree ${wt}`);
}
function buildAt(sha, wt) {
  removeWorktree(wt);
  git('worktree', 'add', '--detach', wt, sha);
  const game = path.join(wt, 'game');
  if (fs.readFileSync(path.join(game, 'package-lock.json')).equals(headLock)) {
    fs.symlinkSync(repoModules, path.join(game, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  } else {
    step(`npm ci at ${sha.slice(0, 12)} (its lockfile differs)`);
    if (runInherit('npm', ['ci'], { cwd: game, shell: process.platform === 'win32' }) !== 0) die(`npm ci failed at ${sha.slice(0, 12)}`);
  }
  step(`vite build at ${sha.slice(0, 12)}`);
  if (runInherit(process.execPath, [path.join('node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: game }) !== 0) die(`vite build failed at ${sha.slice(0, 12)}`);
  return game;
}
const wtBase = path.join(runDir, 'base'), wtHead = path.join(runDir, 'head');
cleanup = () => { if (!KEEP) { removeWorktree(wtBase); removeWorktree(wtHead); } };
let exitCode = 1;
try {
  const gameBase = buildAt(BASE, wtBase);
  const gameHead = buildAt(HEAD, wtHead);

  // ---- render, as the CI job does: the PR's cishot.mjs on both builds --------------------------------
  const outDir = path.join(runDir, 'out');
  fs.rmSync(outDir, { recursive: true, force: true });
  const env = { ...process.env };
  for (const k of ['SHOT_QUERY', 'SHOT_CPU', 'SHOT_HEADED']) delete env[k];
  const cishot = path.join(gameHead, 'tools', 'cishot.mjs');
  step('cishot.mjs on the merge base (before)');
  runInherit(process.execPath, [cishot, 'synth', path.join(outDir, 'before'), '--gpu'],
    { cwd: gameHead, env: { ...env, SHOT_DIST: path.join(gameBase, 'dist'), SHOT_PACKS: packsBase } });
  step('cishot.mjs on HEAD (after)');
  const after = runInherit(process.execPath, [cishot, 'synth', path.join(outDir, 'after'), '--gpu'],
    { cwd: gameHead, env: { ...env, SHOT_DIST: path.join(gameHead, 'dist'), SHOT_PACKS: packsHead } });

  step('render_report.py');
  const reportDir = path.join(outDir, 'report');
  const rep = runInherit(PYTHON, [path.join(wtHead, 'tools', 'ci', 'render_report.py'), path.join(outDir, 'before'), path.join(outDir, 'after'), reportDir,
    '--before-dist', path.join(gameBase, 'dist'), '--after-dist', path.join(gameHead, 'dist')]);
  const reportPath = path.join(reportDir, 'report.md');
  if (after !== 0 || rep !== 0 || !fs.existsSync(reportPath)) {
    console.error(`\nlocal render-budgets FAILED${after !== 0 ? ' (cishot on HEAD: shader message, page error or crash)' : ''}; nothing posted, CI will run it. Outputs: ${outDir}`);
    exitCode = 1;
  } else {
    const gpu = JSON.parse(fs.readFileSync(path.join(outDir, 'after', 'stats.json'), 'utf8')).gpu ?? 'unknown GPU';
    const lines = fs.readFileSync(reportPath, 'utf8').split('\n');
    lines.splice(2, 0, '', `**Run on Drew's PC** (\`${gpu}\`) with \`tools/ci/local_render_budgets.mjs\`: after is ${HEAD}, before is the merge base ${BASE}. CI skips its own \`render-budgets\` run for this commit; a new push, a new merge base, a change to the tools or a \`stills\` request runs it again.`);
    const body = path.join(reportDir, 'comment.md');
    fs.writeFileSync(body, lines.join('\n'));

    if (needPush) {
      step(`git push origin HEAD:${pr.headRefName}`);
      if (runInherit('git', ['push', 'origin', `HEAD:${pr.headRefName}`], { cwd: REPO }) !== 0) die('git push failed; nothing posted');
    }
    // the status first: CI's job reads it about 30 s after a push
    const desc = `passed base=${BASE} tools=${TOOLS} synth=${synthHead.key}`;
    out('gh', ['api', `repos/{owner}/{repo}/statuses/${HEAD}`, '-f', 'state=success', '-f', `context=${CONTEXT}`, '-f', `description=${desc}`, '-f', `target_url=${pr.url}`], { cwd: REPO });
    const ids = out('gh', ['api', `repos/{owner}/{repo}/issues/${pr.number}/comments?per_page=100`, '--paginate', '--jq',
      `.[] | select((.user.login == "github-actions[bot]" or .user.login == "${owner}") and (.body | startswith("${MARKER}"))) | .id`], { cwd: REPO });
    const id = ids.split('\n').filter(Boolean).pop();
    const patched = id && tryOut('gh', ['api', '-X', 'PATCH', `repos/{owner}/{repo}/issues/comments/${id}`, '-F', `body=@${body}`, '--jq', '.html_url'], { cwd: REPO });
    const url = patched || out('gh', ['api', `repos/{owner}/{repo}/issues/${pr.number}/comments`, '-F', `body=@${body}`, '--jq', '.html_url'], { cwd: REPO });
    console.log(`\nlocal render-budgets passed on ${gpu}. Status ${CONTEXT} on ${HEAD.slice(0, 12)}${needPush ? ' (pushed)' : ''}; report: ${url}`);
    exitCode = 0;
  }
} finally {
  cleanup();
  cleanup = () => {};
}
console.log(`${Math.round((Date.now() - t0) / 1000)} s`);
process.exit(exitCode);
