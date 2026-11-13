// FEAT-247 (EPIC-17): what a build-pack run is doing, from the JSON `gh` prints, as one pure function the dev
// server's GET /api/resorts/builds (tools/resort_build_routes.mjs) answers and tools/buildprogresscheck.mjs tests over
// recorded fixtures (tools/fixtures/build-progress.json).
//
// MapPacker's build-pack workflow (.github/workflows/build-pack.yml, FEAT-245) has three jobs, `queue` (waits for the
// builds started before it), `probe` (one request to every data host) and `build`, whose steps named resolve, fetch,
// build, report and publish are the stages. A build ends in a publish PR, head `publish/<slug>-v<N>`, labelled
// `publish`, that publish-merge.yml releases and then merges; a run that publishes nothing (the pack equals the
// published one) opens no PR. The states, in order:
//   queued      the queue job has not finished (an earlier build is running), or no job has started yet
//   probe       the probe job (Checking data hosts)
//   building    the build job; stage is its first stage step not finished (resolve before resolve runs)
//   publishing  the run succeeded and a publish PR for the slug, opened after the run started, is open
//   published   that PR merged
//   no-change   the run succeeded and opened no publish PR
//   failed      the run failed or was cancelled (stage: where; why: the run's conclusion), or the publish PR closed
//               unmerged (why 'pr-closed')

export const STAGES = ['resolve', 'fetch', 'build', 'report', 'publish'];
/** runs started this long ago that have not finished are still listed */
export const OPEN_WINDOW_MS = 2 * 24 * 3600_000;
/** a finished build stays listed this long after it ended */
export const DONE_WINDOW_MS = 3600_000;
const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';
/** the workflow's run-name: `Build pack <slug>` */
export const RUN_TITLE_RE = new RegExp(`^Build pack (${SLUG})$`);
/** a publish PR's head branch: `publish/<slug>-v<N>` */
export const PUBLISH_HEAD_RE = new RegExp(`^publish/(${SLUG})-v(\\d+)$`);

/** @typedef {{ databaseId: number; displayTitle: string; status: string; conclusion: string; createdAt: string; updatedAt?: string; url: string }} GhRun  one row of `gh run list --json` */
/** @typedef {{ name: string; number?: number; status: string; conclusion: string }} GhStep */
/** @typedef {{ name: string; status: string; conclusion: string; steps?: GhStep[] }} GhJob  one of `gh run view --json jobs` */
/** @typedef {{ number: number; url: string; state: 'OPEN' | 'MERGED' | 'CLOSED'; headRefName: string; createdAt: string; mergedAt: string | null; closedAt: string | null }} GhPr  one row of `gh pr list --json` */
/** @typedef {'queued' | 'probe' | 'building' | 'publishing' | 'published' | 'no-change' | 'failed'} BuildState */
/** @typedef {'queue' | 'probe' | 'resolve' | 'fetch' | 'build' | 'report' | 'publish'} BuildStage */
/** @typedef {{ slug: string; runId: number; url: string; state: BuildState; stage?: BuildStage; why?: string; prUrl?: string; at: string; doneAt?: string }} BuildInfo
 *  at: when the run was started; doneAt: when it ended (a finished state only) */

/** a gh time, or null for gh's zero time (0001-01-01: not yet) and anything unreadable */
const ms = (/** @type {string | null | undefined} */ s) => { const v = Date.parse(s ?? ''); return Number.isFinite(v) && v > 0 ? v : null; };
const done = (/** @type {{ status: string }} */ x) => x.status === 'completed';
const passed = (/** @type {{ conclusion: string }} */ x) => x.conclusion === 'success' || x.conclusion === 'skipped';

/** the slug a run builds, from its run-name, or null for a run that is not a build-pack run of one slug
 *  @param {GhRun} run */
export function runSlug(run) {
  const m = RUN_TITLE_RE.exec(run.displayTitle ?? '');
  return m ? m[1] : null;
}

/** the build job's stage: its first stage step that has not finished (publish once all have)
 *  @param {GhJob} job @returns {BuildStage} */
function runningStage(job) {
  const steps = job.steps ?? [];
  for (const s of STAGES) {
    const step = steps.find((x) => x.name === s);
    if (!step || !done(step)) return /** @type {BuildStage} */ (s);
  }
  return 'publish';
}

/** where a finished run that did not succeed stopped: the first job that did not pass, and in the build job the
 *  stage step that did not
 *  @param {GhJob[]} jobs @returns {BuildStage} */
function failedStage(jobs) {
  const by = (/** @type {string} */ n) => jobs.find((j) => j.name === n);
  const q = by('queue'), p = by('probe'), b = by('build');
  if (!q || !passed(q)) return 'queue';
  if (!p || !passed(p)) return 'probe';
  if (!b) return 'probe';
  const steps = b.steps ?? [];
  for (const s of STAGES) {
    const step = steps.find((x) => x.name === s);
    if (!step || !done(step) || !passed(step)) return /** @type {BuildStage} */ (s);
  }
  return 'publish';
}

/**
 * The state of one run from its jobs (null when they are not known: then a run that has not finished reads
 * queued). A run that succeeded comes back as `succeeded`: what it became depends on its publish PR.
 * @param {GhRun} run @param {GhJob[] | null | undefined} jobs
 * @returns {{ state: BuildState | 'succeeded'; stage?: BuildStage; why?: string }}
 */
export function runState(run, jobs) {
  const js = jobs ?? [];
  if (!done(run)) {
    const by = (/** @type {string} */ n) => js.find((j) => j.name === n);
    const q = by('queue'), p = by('probe'), b = by('build');
    if (!q || !done(q)) return { state: 'queued' };
    if (!p || !done(p)) return { state: 'probe' };
    // probe finished; the build job starts (queued for a runner, then in progress)
    return { state: 'building', stage: b ? runningStage(b) : 'resolve' };
  }
  if (run.conclusion === 'success') return { state: 'succeeded' };
  return { state: 'failed', stage: failedStage(js), why: run.conclusion || 'failure' };
}

/**
 * Every build worth showing, newest first: the runs started in the last 2 days that have not finished, and those
 * that finished in the last hour (a publish PR still open keeps its run listed; one merged or closed counts from
 * then). Pure: the route hands it what gh printed.
 * @param {{ runs: GhRun[]; jobs?: Record<string, GhJob[] | null | undefined>; prs: GhPr[]; now: number }} o
 *   jobs: `gh run view <id> --json jobs`'s jobs by run id (the route asks for the runs not finished, and once for
 *   each finished run that did not succeed)
 * @returns {BuildInfo[]}
 */
export function buildProgress({ runs, jobs = {}, prs, now }) {
  /** @type {Map<string, GhRun[]>} slug -> its runs, oldest first */
  const bySlug = new Map();
  for (const r of runs) {
    const slug = runSlug(r);
    const at = ms(r.createdAt);
    if (!slug || at === null || !Number.isInteger(r.databaseId)) continue;
    (bySlug.get(slug) ?? bySlug.set(slug, []).get(slug)).push(r);
  }
  /** @type {Map<string, GhPr[]>} slug -> its publish PRs */
  const prsBySlug = new Map();
  for (const p of prs) {
    const m = PUBLISH_HEAD_RE.exec(p.headRefName ?? '');
    if (!m || ms(p.createdAt) === null) continue;
    (prsBySlug.get(m[1]) ?? prsBySlug.set(m[1], []).get(m[1])).push(p);
  }
  /** @type {BuildInfo[]} */
  const out = [];
  for (const [slug, list] of bySlug) {
    list.sort((a, b) => /** @type {number} */ (ms(a.createdAt)) - /** @type {number} */ (ms(b.createdAt)));
    list.forEach((run, i) => {
      const start = /** @type {number} */ (ms(run.createdAt));
      if (now - start > OPEN_WINDOW_MS) return;
      const next = i + 1 < list.length ? /** @type {number} */ (ms(list[i + 1].createdAt)) : Infinity;
      const s = runState(run, jobs[String(run.databaseId)]);
      /** @type {BuildInfo} */
      const b = { slug, runId: run.databaseId, url: run.url, state: 'queued', at: run.createdAt };
      let end = null;
      if (s.state === 'succeeded') {
        // its publish PR: opened after this run started and before the slug's next run did (the latest such)
        const pr = (prsBySlug.get(slug) ?? [])
          .filter((p) => { const t = /** @type {number} */ (ms(p.createdAt)); return t >= start && t < next; })
          .sort((a, c) => /** @type {number} */ (ms(c.createdAt)) - /** @type {number} */ (ms(a.createdAt)))[0];
        if (!pr) { b.state = 'no-change'; end = run.updatedAt ?? null; }
        else {
          b.prUrl = pr.url;
          if (pr.state === 'MERGED' || ms(pr.mergedAt) !== null) { b.state = 'published'; end = pr.mergedAt; }
          else if (pr.state === 'CLOSED') { b.state = 'failed'; b.why = 'pr-closed'; end = pr.closedAt; }
          else b.state = 'publishing';
        }
      } else {
        b.state = s.state;
        if (s.stage) b.stage = s.stage;
        if (s.why) b.why = s.why;
        if (s.state === 'failed') end = run.updatedAt ?? null;
      }
      if (end !== null || b.state === 'no-change' || b.state === 'published' || b.state === 'failed') {
        // a finished build: listed for an hour after it ended (a missing end time counts as the run's start)
        const t = ms(end) ?? start;
        if (now - t > DONE_WINDOW_MS) return;
        b.doneAt = new Date(t).toISOString();
      }
      out.push(b);
    });
  }
  return out.sort((a, b) => /** @type {number} */ (ms(b.at)) - /** @type {number} */ (ms(a.at)) || b.runId - a.runId);
}
