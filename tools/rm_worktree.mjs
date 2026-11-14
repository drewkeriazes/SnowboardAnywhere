#!/usr/bin/env node
// BUG-093: remove a git worktree without emptying the folders its links point at.
//
//   node tools/rm_worktree.mjs <worktree> [--force] [--dry-run]
//
// `git worktree remove` (git 2.51 on Windows, checked on Drew's PC) follows a junction inside the
// worktree, such as game/node_modules or a pack under packs/, and deletes the files in the folder it
// points at: the main checkout's node_modules, or a pack. This tool first finds every junction and
// symlink under the worktree (without descending into them), removes only the links (unlink, or a
// non-recursive rmdir on the link itself), checks each is gone, and only then runs
// `git worktree remove` (with --force when given). It refuses the main checkout, a path that is not
// a worktree of a repository, and stops before git if any link is left.
// No dependencies; Node 18+.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function die(msg) { console.error(`rm_worktree: ${msg}`); process.exit(1); }

const args = process.argv.slice(2);
const force = args.includes('--force');
const dryRun = args.includes('--dry-run');
const rest = args.filter(a => a !== '--force' && a !== '--dry-run');
if (rest.length !== 1 || rest[0].startsWith('-')) {
  console.error('usage: node tools/rm_worktree.mjs <worktree> [--force] [--dry-run]');
  process.exit(2);
}
const wt = path.resolve(rest[0]);

function git(cwd, ...a) {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
const norm = p => {
  let r = path.resolve(p);
  try { r = fs.realpathSync.native(r); } catch { /* keep as is */ }
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

// ---- is it a linked worktree, and not the main checkout? --------------------------------------------
let st;
try { st = fs.lstatSync(wt); } catch { die(`${wt} does not exist (to forget a deleted worktree, run git worktree prune)`); }
if (st.isSymbolicLink()) die(`${wt} is itself a link; remove the link, not the folder it points at`);
if (!st.isDirectory()) die(`${wt} is not a folder`);
const top = git(wt, 'rev-parse', '--show-toplevel');
if (top === null) die(`${wt} is not in a git repository`);
if (norm(top) !== norm(wt)) die(`${wt} is not the top of a worktree (its top is ${top})`);
const gitDir = git(wt, 'rev-parse', '--path-format=absolute', '--git-dir');
const commonDir = git(wt, 'rev-parse', '--path-format=absolute', '--git-common-dir');
if (gitDir === null || commonDir === null) die(`could not read the git dirs of ${wt}`);
if (norm(gitDir) === norm(commonDir)) die(`${wt} is the main checkout, not a linked worktree; refusing`);
// run git from the main checkout, so the worktree is not the current folder while it is removed
const listing = git(wt, 'worktree', 'list', '--porcelain');
const mainCheckout = listing?.split(/\r?\n/).find(l => l.startsWith('worktree '))?.slice(9);
if (!mainCheckout) die('could not find the main checkout');
if (norm(mainCheckout) === norm(wt)) die(`${wt} is the main checkout; refusing`);
// Windows cannot delete the folder a shell is in, so git would fail halfway: say so before unlinking
const here = norm(process.cwd()), there = norm(wt);
if (here === there || here.startsWith(there + path.sep)) die(`the current folder is inside ${wt}; cd out of it (for example to ${mainCheckout}) and run again`);

// ---- find the links ---------------------------------------------------------------------------------
// readdir's Dirent and lstat both report a Windows junction as a symbolic link, so a link is never
// descended into. `.git` at the top is a file in a linked worktree; skipped either way.
const links = [];
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { die(`could not read ${dir}: ${e.code || e.message}`); }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (dir === wt && e.name === '.git') continue;
    let s;
    try { s = fs.lstatSync(p); } catch { continue; }
    if (s.isSymbolicLink() || e.isSymbolicLink()) { links.push(p); continue; }
    if (s.isDirectory()) walk(p);
  }
}
walk(wt);

function target(p) { try { return fs.readlinkSync(p); } catch { return '?'; } }
for (const p of links) console.log(`${dryRun ? 'would unlink' : 'unlink'} ${path.relative(wt, p)} -> ${target(p)}`);
if (!links.length) console.log('no junctions or symlinks in the worktree');
if (dryRun) {
  console.log(`would run: git worktree remove${force ? ' --force' : ''} ${wt}`);
  process.exit(0);
}

// ---- remove only the links --------------------------------------------------------------------------
const left = [];
for (const p of links) {
  try { fs.unlinkSync(p); } catch {
    // a Windows directory symlink (mklink /D) can refuse unlink; rmdir without recursive removes the link only
    try { fs.rmdirSync(p); } catch { /* checked below */ }
  }
  let gone = false;
  try { fs.lstatSync(p); } catch (e) { gone = e.code === 'ENOENT'; }
  if (!gone) left.push(p);
}
if (left.length) {
  die(`could not remove ${left.length} link(s), so the worktree is left in place:\n  ${left.join('\n  ')}`);
}

// ---- now git can remove the worktree ----------------------------------------------------------------
const gitArgs = ['worktree', 'remove', ...(force ? ['--force'] : []), wt];
console.log(`git ${gitArgs.join(' ')}`);
const r = spawnSync('git', gitArgs, { cwd: mainCheckout, stdio: 'inherit' });
if (r.status !== 0) {
  console.error(`rm_worktree: git worktree remove failed (exit ${r.status}); the links above are already gone, the rest of the worktree is left${force ? '' : ' (add --force for untracked or changed files)'}`);
  process.exit(r.status ?? 1);
}
console.log(`removed ${wt}`);
