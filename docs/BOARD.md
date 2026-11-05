# SnowboardAnywhere board

The kanban lives in GitHub Projects: https://github.com/users/drewkeriazes/projects/2
(also under the repo's Projects tab). One issue per card: https://github.com/drewkeriazes/SnowboardAnywhere/issues

## How it works

- Card ids stay in the issue title (`FEAT-013: Roads drawn as draped ribbons`). Tell Claude "build FEAT-013" or "work on #8"; either works.
- Columns: **Backlog** (idea) -> **Ready** (specced, data available) -> **In Progress** -> **Done**.
- Labels: `type: feature | bug | data`, `milestone`. `status: ready` / `status: backlog` mirror the column for issue-list filtering.
- `type: data` cards are pipeline or raw-data work that runs on Drew's PC; they are Done only when the pack is rebuilt.
- Ids never get reused. Next ids: FEAT-031, BUG-009, DATA-008.

## What Claude does with a card

1. New ask from Drew -> create the issue with the next id and the right labels, put it in Ready (or Backlog if it needs data first).
2. "Build X" -> move the card to In Progress, build, commit with the id in the message, comment the commit hash on the issue, close it (closing moves it to Done).
3. Found a bug while building -> new BUG card, not a silent fix.

From the cloud sandbox, issues and labels work through `gh api repos/drewkeriazes/SnowboardAnywhere/issues` (REST). The project board itself is GraphQL only, which the sandbox cannot reach, so column moves beyond open/close happen in the browser or by Drew; closing an issue is what moves it to Done.
