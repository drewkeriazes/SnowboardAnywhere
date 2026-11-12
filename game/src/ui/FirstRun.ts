import { fillResortPicker } from './ResortPicker';
import { lastInputKind, openScreen, Screen } from './MenuNav';
import { renderHints } from './HintBar';

/**
 * BUG-105: the screen the game opens on when it has no resort to load: no pack in packs/ and no `?pack=` (a fresh
 * clone), or a `?pack=` whose pack is not there (`error` is the load's message, shown as is). It holds the
 * Change resort list (`ui/ResortPicker.ts`): a published resort shows "Download (size)" and opens when it is in.
 * Where the server has no download routes (a plain static host) or is offline, the list stays empty and the
 * screen says how to get one from a terminal.
 */
export interface FirstRunOpts {
  /** the built packs (`availableResorts`), empty on a fresh clone */
  resorts: { slug: string; name: string }[];
  /** the `?pack=` that failed to load, and why */
  error?: { slug: string; message: string };
}

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

/** a resort is its own pack: the page reloads into it (as the main menu's Change resort) */
function go(slug: string): void {
  const u = new URL(location.href);
  u.searchParams.set('pack', slug);
  for (const k of ['x', 'y', 'h']) u.searchParams.delete(k);
  location.href = u.toString();
}

export function showFirstRun(o: FirstRunOpts): void {
  const el = document.createElement('div');
  el.id = 'menu';
  el.className = 'first-run';
  const title = o.error ? 'Resort not found' : 'No resorts yet';
  const facts = o.error ? o.error.message : 'Download a resort to ride. It is saved in packs/ next to the game, so each one downloads once.';
  el.innerHTML = `
    <header class="title">
      <div class="region">Snowboard Anywhere</div>
      <h1>${esc(title)}</h1>
      <div class="facts">${esc(facts)}</div>
    </header>
    <div class="pop">
      <div class="ph">${o.error ? 'Pick a resort' : 'Get a resort'}</div>
      <p data-note>Looking for resorts to download...</p>
      <div class="courses"></div>
      <p>From a clone of the repo you can also run <code>npm run get vail</code> in <code>game/</code>, then reload.</p>
      <button class="link" data-reload>Reload</button>
    </div>
    <footer class="foot"><div class="hintbar"></div></footer>`;
  document.body.appendChild(el);
  document.body.classList.add('in-menu');
  const pop = el.querySelector<HTMLElement>('.pop')!;
  const note = el.querySelector<HTMLElement>('[data-note]')!;
  const hintEl = el.querySelector<HTMLElement>('.hintbar')!;
  el.querySelector('button[data-reload]')!.addEventListener('click', () => location.reload());
  const hints = () => renderHints(hintEl, [['select', 'Select'], ['move', 'Move']], lastInputKind());
  const screen = new Screen(el, {
    primary: () => pop.querySelector<HTMLElement>('button[data-pack]:not([disabled])') ?? pop.querySelector<HTMLElement>('button[data-reload]'),
    onInputKind: () => hints(),
  });
  // current '' so every row loads (or downloads); close has nothing to go back to
  fillResortPicker(pop, '', o.resorts, go, () => {}, () => {
    const any = !!pop.querySelector('button[data-pack]');
    note.textContent = any
      ? 'Pick one: it downloads into packs/ and opens when it is ready.'
      : 'Nothing to download here: this server has no download service, or it is offline.';
    // the rows came in after the screen opened on Reload: the first row takes the focus, unless one already has it
    if (!pop.querySelector('.courses')!.contains(document.activeElement)) screen.focusPrimary();
  });
  openScreen(screen);
  hints();
}
