// Output-folder guard for the screenshot tools: they only write into a gitignored folder that
// holds no tracked files (game/shots*/), so a check run can never overwrite a committed image.
// Reference renders that should be kept go in docs/renders/<date>-<label>.png by hand.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });

/** Create `dir` and return it, or exit if writing there could clobber something in git. */
export function guardOutDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const fail = (why) => {
    console.error(`refusing to write screenshots to ${dir}: ${why}. Use a game/shots*/ folder (gitignored), e.g. shots-vail.`);
    process.exit(1);
  };
  let tracked, ignored;
  try {
    tracked = git('ls-files', '--', dir).trim();
    // exit 0 means ignored; a probe file name, since the folder rule only matches paths inside it
    try { git('check-ignore', '-q', path.join(dir, '__probe.png')); ignored = true; } catch { ignored = false; }
  } catch {
    return dir; // not a git checkout (cloud copy without .git): nothing to protect
  }
  if (tracked) fail(`it holds tracked files (${tracked.split('\n').slice(0, 3).join(', ')})`);
  if (!ignored) fail('it is not gitignored');
  return dir;
}
