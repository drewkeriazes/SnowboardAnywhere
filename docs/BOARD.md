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
2. "Build X" -> move the card to In Progress, build, commit with the id in the message, comment the commit hash on the issue, close it (closing moves it to Done).
3. Found a bug while building -> new BUG card, not a silent fix.

New issues reach the board only through the project's **Auto-add to project** workflow (project menu > Workflows, filter `is:issue,pr is:open`, repo drewkeriazes/SnowboardAnywhere); without it, add them with **+ Add item** and `#<number>`. Closed cards carry no `status:` label.

From the cloud sandbox, issues and labels work through `gh api repos/drewkeriazes/SnowboardAnywhere/issues` (REST). The project board itself is GraphQL only, which the sandbox cannot reach, so column moves beyond open/close happen in the browser or by Drew; closing an issue is what moves it to Done.
