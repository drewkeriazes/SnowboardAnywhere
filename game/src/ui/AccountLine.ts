import type { AccountService, AccountState, Player } from '../account/Account';

/** FEAT-273: what the main menu's corner line shows for an account state. Pure, so the node check can read it.
 *  FEAT-274: its button opens the account panel (ui/AccountPanel.ts), where the sign-in methods are. */
export interface AccountLineView { who: string; action: 'open' | null; label: string; disabled: boolean; note: string }

/** the signed-in line: the name, the player number when there is one (0 is a number, null is none), the role */
export function whoLine(p: Player): string {
  return [p.displayName, p.playerNumber !== null ? `player ${p.playerNumber}` : '', p.role === 'maintainer' ? 'maintainer' : ''].filter(Boolean).join(' · ');
}

export function accountLineView(state: AccountState, available: boolean, reason: string): AccountLineView {
  if (state.kind === 'pending') return { who: '', action: null, label: '', disabled: false, note: '' };
  if (state.kind === 'guest') return { who: 'Playing as guest', action: 'open', label: 'Sign in', disabled: !available, note: available ? '' : reason };
  return { who: whoLine(state.player), action: 'open', label: 'Account', disabled: false, note: '' };
}

/**
 * Draws the line into `host` and keeps it current. Everything from the account goes in through textContent,
 * never innerHTML. The button is a plain button.link so MenuNav reaches it; it calls `open` (the menu opens the
 * account panel). Returns the unsubscribe.
 */
export function mountAccountLine(host: HTMLElement, account: AccountService, open: () => void): () => void {
  const who = document.createElement('span'); who.className = 'who';
  const btn = document.createElement('button'); btn.className = 'link'; btn.type = 'button'; btn.dataset.account = 'open';
  const note = document.createElement('span'); note.className = 'note';
  host.append(who, btn, note);

  const draw = () => {
    const v = accountLineView(account.state(), account.available, account.unavailableReason);
    host.hidden = v.action === null;
    who.textContent = v.who;
    btn.hidden = v.action === null;
    btn.textContent = v.label;
    btn.disabled = v.disabled;
    note.textContent = v.note;
    note.hidden = !note.textContent;
  };
  btn.addEventListener('click', () => { if (!btn.disabled) open(); });
  const off = account.onChange(draw);
  draw();
  return () => { off(); who.remove(); btn.remove(); note.remove(); };
}
