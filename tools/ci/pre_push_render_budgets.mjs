#!/usr/bin/env node
// FEAT-183: the pre-push hook's logic (.githooks/pre-push runs it). On Drew's PC, with
// `git config sa.gpuBudgets true`, a plain `git push` of a PR branch that changes game/ or pipeline/ runs
// CI's render-budgets check on the GPU first (render_budgets_lib.mjs, the same steps as
// local_render_budgets.mjs). On a pass a detached process (render_budgets_post.mjs) waits until GitHub has
// the commit and sets the `render-budgets/local` status and the PR comment, so CI's job skips.
//
// It never blocks a push: a failed check, a refusal or an error prints one line, sets nothing and exits 0,
// and CI runs the budgets as usual. Skipped by `git push --no-verify`, SA_SKIP_GPU_BUDGETS=1, and the push
// that local_render_budgets.mjs --push makes itself (it already ran the check).
//
//   git push arguments: <remote name> <remote url>; stdin: "<local ref> <local sha> <remote ref> <remote sha>" lines
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUDGET_PATHS, PUSH_GUARD, Stop, defaultCache, findPr, prepare, runCheck, tryOut } from './render_budgets_lib.mjs';

const say = (s) => console.log(`render-budgets: ${s}`);

function main() {
  if (process.env[PUSH_GUARD]) return; // local_render_budgets.mjs --push: checked already
  if (process.env.SA_SKIP_GPU_BUDGETS === '1') { say('skipped (SA_SKIP_GPU_BUDGETS=1); CI runs it if needed'); return; }
  if (tryOut('git', ['config', '--type=bool', 'sa.gpuBudgets']) !== 'true') return;

  const [remote, url] = process.argv.slice(2);
  const repo = tryOut('git', ['rev-parse', '--show-toplevel']);
  if (!repo) return;
  const origin = tryOut('git', ['remote', 'get-url', 'origin'], { cwd: repo });
  if (remote !== 'origin' && url !== origin) return; // only pushes to GitHub's copy are checked by CI

  const HEAD = tryOut('git', ['rev-parse', 'HEAD'], { cwd: repo });
  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch { /* no stdin */ }
  // the branch this worktree's HEAD goes to (a push of other refs, a delete or a tag isn't checked)
  const line = input.split('\n').map((l) => l.trim().split(/\s+/))
    .find((f) => f.length === 4 && f[1] === HEAD &&f[2].startsWith('refs/heads/'));
  if (!line) return;
  const branch = line[2].slice('refs/heads/'.length);
  if (branch === 'main') return;

  // CI's `changes` filter: the PR's diff against its merge base with main (local origin/main, no fetch: fast)
  const base = tryOut('git', ['merge-base', 'origin/main', HEAD], { cwd: repo });
  if (!base) { say('no merge base with origin/main; CI runs it'); return; }
  const files = (tryOut('git', ['diff', '--name-only', base, HEAD], { cwd: repo }) ?? '').split('\n').filter(Boolean);
  if (!files.some((f) => BUDGET_PATHS.test(f))) return; // CI doesn't run render-budgets either

  const pr = findPr(repo, branch);
  if (!pr || pr.state !== 'OPEN') { say(`no open PR for ${branch} yet; CI runs it on this push`); return; }
  if (pr.labels.some((l) => l.name === 'stills')) { say(`PR #${pr.number} has the stills label; CI runs it`); return; }

  const cache = defaultCache();
  const runDir = path.join(cache, 'runs', HEAD.slice(0, 12));
  fs.mkdirSync(runDir, { recursive: true });
  const log = path.join(runDir, 'hook.log');
  fs.writeFileSync(log, `pre-push ${new Date().toISOString()} ${branch} ${HEAD}\n`);
  say(`checking ${HEAD.slice(0, 12)} for PR #${pr.number} on the GPU before the push (about 2 min; SA_SKIP_GPU_BUDGETS=1 or --no-verify skips it). Log: ${log}`);

  let ctx;
  try {
    ctx = prepare({ repo, sha: HEAD, pr, mode: 'hook', cache, log });
  } catch (e) {
    if (e instanceof Stop) { say(`not run: ${e.message.split('\n')[0]}; CI runs it`); return; }
    throw e;
  }
  const res = runCheck(ctx);
  ctx.L.close();
  if (!res.pass) { say(`FAILED (${res.why}) after ${ctx.L.secs()} s; nothing posted, CI runs it. Outputs: ${res.outDir}`); return; }

  // GitHub doesn't have the commit until after this hook: a detached process sets the status once it does
  const job = path.join(runDir, 'post.json');
  fs.writeFileSync(job, JSON.stringify({
    repo, sha: HEAD, branch, prNumber: pr.number, prUrl: pr.url, owner: ctx.owner, desc: res.desc, body: res.body,
    checkSeconds: ctx.L.secs(), hookDone: new Date().toISOString(),
  }, null, 2));
  const poster = path.join(path.dirname(fileURLToPath(import.meta.url)), 'render_budgets_post.mjs');
  const child = spawn(process.execPath, [poster, job], { detached: true, stdio: 'ignore', windowsHide: true, cwd: repo });
  child.unref();
  say(`passed on ${res.gpu} in ${ctx.L.secs()} s; the status is set once GitHub has the commit (log: ${path.join(runDir, 'post.log')})`);
}

try { main(); } catch (e) {
  say(`error, push goes ahead and CI runs it: ${String(e?.message ?? e).split('\n')[0]}`);
}
process.exit(0);
