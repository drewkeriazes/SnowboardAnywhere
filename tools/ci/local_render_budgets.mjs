#!/usr/bin/env node
// FEAT-176: the CI `render-budgets` check (checks.yml), run on Drew's PC on the real GPU. On a pass it posts
// the report as the PR's `<!-- ci-stills -->` comment and a `render-budgets/local` commit status on the head
// SHA; CI then skips its own run for that exact commit (about 2 minutes per side on SwiftShader). On a fail
// it prints the report and posts nothing, so CI runs and fails the normal way. The work itself is in
// render_budgets_lib.mjs, shared with the pre-push hook (FEAT-183), which does the same on a plain `git push`.
//
//   node tools/ci/local_render_budgets.mjs [--push] [--pr N] [--keep] [--cache DIR]
//
// Run it inside the PR's worktree with a clean tree.
//   default   HEAD must already be the PR's head on GitHub. CI starts render-budgets about 30 s after a
//             push, so a run started after pushing usually helps only re-runs of that commit.
//   --push    HEAD is ahead of the PR's head (committed, not pushed): run first, and only on a pass push
//             HEAD to the PR's branch and post at once, before CI's job reaches its check. With the pre-push
//             hook switched on (`git config sa.gpuBudgets true`) a plain `git push` does the same.
//   --pr N    the PR (default: the PR of the current branch)
//   --keep    keep the two build worktrees (default: removed at the end)
//   --cache   where synthetic packs, worktrees and outputs go (default ~/.cache/snowboardanywhere-ci)
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { PUSH_GUARD, Stop, defaultCache, post, prepare, runCheck, tryOut } from './render_budgets_lib.mjs';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };

try {
  const repo = tryOut('git', ['rev-parse', '--show-toplevel']) ?? (() => { throw new Stop('not inside a git checkout'); })();
  const cache = opt('--cache') ? path.resolve(opt('--cache')) : defaultCache();
  const ctx = prepare({ repo, pr: opt('--pr'), mode: 'manual', push: flag('--push'), cache, keep: flag('--keep') });
  const res = runCheck(ctx);
  if (!res.pass) {
    console.error(`\nlocal render-budgets FAILED (${res.why}); nothing posted, CI will run it. Outputs: ${res.outDir}`);
    console.log(`${ctx.L.secs()} s`);
    process.exit(1);
  }
  if (ctx.needPush) {
    ctx.L.step(`git push origin HEAD:${ctx.pr.headRefName}`);
    // the pre-push hook would run the same check again: tell it this push already passed
    const r = spawnSync('git', ['push', 'origin', `HEAD:${ctx.pr.headRefName}`], { cwd: repo, stdio: 'inherit', env: { ...process.env, [PUSH_GUARD]: '1' } });
    if (r.status !== 0) throw new Stop('git push failed; nothing posted');
  }
  const url = post({ repo, sha: ctx.SHA, prNumber: ctx.pr.number, prUrl: ctx.pr.url, owner: ctx.owner, desc: res.desc, body: res.body });
  console.log(`\nlocal render-budgets passed on ${res.gpu}. Status render-budgets/local on ${ctx.SHA.slice(0, 12)}${ctx.needPush ? ' (pushed)' : ''}; report: ${url}`);
  console.log(`${ctx.L.secs()} s`);
} catch (e) {
  console.error(e instanceof Stop ? `local render-budgets: ${e.message}` : e);
  process.exit(e instanceof Stop ? 2 : 1);
}
