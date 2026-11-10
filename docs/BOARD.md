# SnowboardAnywhere board

The kanban lives in GitHub Projects: https://github.com/users/drewkeriazes/projects/2
(also under the repo's Projects tab). One issue per card: https://github.com/drewkeriazes/SnowboardAnywhere/issues

## How it works

- Card ids stay in the issue title (`FEAT-013: Roads drawn as draped ribbons`). Tell Claude "build FEAT-013" or "work on #8"; either works.
- Two numbers per card: the card id (`FEAT-067`) counts per type (FEAT / BUG / DATA), while the GitHub issue number (`#101`) is one shared sequence for every issue in the repo, so they never line up. Both point at the same card.
- Columns: **Backlog** (idea) -> **Ready** (specced, data available) -> **In Progress** -> **Done**.
- Labels: `type: feature | bug | data`, `milestone`. `status: ready` / `status: backlog` mirror the column for issue-list filtering.
- `type: data` cards are pipeline or raw-data work that runs on Drew's PC; they are Done only when the pack is rebuilt.
- Ids never get reused. There is no stored "next id". Run `python tools/card_id.py` right before creating a card: it reads every issue (all pages, open and closed, pull requests skipped) and prints the next FEAT / BUG / DATA id plus any id two issues share. Run it again after creating the card, because a parallel session may have taken the same id; on a clash the newer issue gets a new id. Do not commit a counter to this file; every bump conflicted with open PRs.
- Pull requests carry the card id in their title too (`FEAT-097 to FEAT-101: Outrun mode`). That is not a duplicate card; the checker ignores PRs.

## What Claude does with a card

1. New ask from Drew -> create the issue with the next id and the right labels, put it in Ready (or Backlog if it needs data first).
2. "Build X" -> branch `issue-<number>-<slug>` from `main`, build, commit with the id in the message, update `README.md` and `docs/developer-guide.md` if the change is user-facing (see CLAUDE.md, Docs travel with the change), open a PR with `Fixes #<number>` and notes on what changed and how it was checked. Before pushing, run only the fast typecheck for what changed; CI (`.github/workflows/checks.yml`) runs the full set of checks on the PR, and the PR notes list only what was run locally because CI can't (real-pack stills, `perf-check`, GPU-only checks). The reviewer bot comments on the PR once the checks finish, and treats a failed check as blocking; Drew marks the ones he wants (thumbs up, or a reply) and the session applies them with the `pr-feedback` skill. Drew reviews and merges; merging closes the issue (Done). The PR's link moves the card to In Progress. Do not push to `main` directly.
3. Found a problem while working (a failing check, a bug in a tool, something broken on `main`) that is not the card in hand -> file it on the board, without asking first, and not as a silent fix (FEAT-173):
   - Search first: `gh issue list --state all --search "<keywords>"` with the symptom, the file or tool name and any error text; read the close matches, open and closed.
   - The same problem is already on a card: comment on it with what was seen (where, which build or commit, the output) instead of opening a new one. A closed card whose problem is back: reopen it, or open a new BUG card that links it.
   - A related card but a different problem: open a new card and link the two both ways (a line in the new card, a comment on the old one).
   - Nothing on the board: open a new card the usual way (`python tools/card_id.py` before and after, labels, the column; usually a BUG in Ready).
   - Name the cards opened or commented on in the reply to Drew and in the PR notes.

## Parallel sessions (FEAT-089)

Several sessions run at once, so each one keeps its hands off the others' files:
- **One worktree per card**, never the shared checkout: `git worktree add ../wt<number> -b issue-<number>-<slug> origin/main`. Build, typecheck and commit there; remove it with `git worktree remove ../wt<number>` once the PR is open. `node_modules` can be a symlink to the main checkout's (`ln -s` / `mklink /D`), but delete the link before `git add -A`.
- **No stash round-trips.** To set work aside, commit it on the card's branch (a WIP commit is fine; the PR is squashed or reviewed as a whole).
- **Land through a PR**, rebased on `origin/main` if it falls behind. Never force-push someone else's branch.
- **Two cards that change the same lines**: base the second PR on the first card's branch instead of `main` and say so at the top of the PR ("stacked on #N, merge that first"). GitHub retargets it to `main` when the first merges. Until then the second card is not linked (links need a PR to `main`), so comment the PR on its issue.
- **Card ids**: `python tools/card_id.py` before and after creating a card (see above).

New issues reach the board only through the project's **Auto-add to project** workflow (project menu > Workflows, filter `is:issue,pr is:open`, repo drewkeriazes/SnowboardAnywhere); without it, add them with **+ Add item** and `#<number>`. Closed cards carry no `status:` label.

From the cloud sandbox, issues and labels work through `gh api repos/drewkeriazes/SnowboardAnywhere/issues` (REST). The project board itself is GraphQL only, which the sandbox cannot reach, so column moves beyond open/close happen in the browser or by Drew; closing an issue is what moves it to Done.
