#!/usr/bin/env node
// FEAT-183: started detached by the pre-push hook after a local render-budgets pass. A commit status can only
// be set once GitHub has the commit, and pre-push runs before the push, so this waits until the PR's branch
// on GitHub points at the commit (polling once a second, up to 5 minutes), then sets the `render-budgets/local`
// status and writes the PR comment, as local_render_budgets.mjs does. Logs to post.log next to the job file.
//
//   node tools/ci/render_budgets_post.mjs <post.json>
import fs from 'node:fs';
import path from 'node:path';
import { post, tryOut } from './render_budgets_lib.mjs';

const job = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const logPath = path.join(path.dirname(process.argv[2]), 'post.log');
const log = (s) => fs.appendFileSync(logPath, `${new Date().toISOString()} ${s}\n`);
const TIMEOUT_MS = 5 * 60 * 1000;

log(`waiting for ${job.branch} on GitHub to reach ${job.sha} (hook finished ${job.hookDone}, check took ${job.checkSeconds} s)`);
const t0 = Date.now();
let landed = false;
while (Date.now() - t0 < TIMEOUT_MS) {
  const at = tryOut('gh', ['api', `repos/{owner}/{repo}/branches/${encodeURIComponent(job.branch)}`, '--jq', '.commit.sha'], { cwd: job.repo });
  if (at === job.sha) { landed = true; break; }
  await new Promise((r) => setTimeout(r, 1000));
}
if (!landed) {
  log('gave up: the push did not reach GitHub within 5 minutes (failed, or rejected). Nothing posted; CI runs the check.');
  process.exit(0);
}
log(`on GitHub after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
try {
  const url = post(job);
  log(`status render-budgets/local set (${job.desc}); report: ${url}`);
} catch (e) {
  log(`posting failed, CI runs the check: ${String(e?.message ?? e).split('\n')[0]}`);
}
