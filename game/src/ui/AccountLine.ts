import type { AccountService, AccountState } from '../account/Account';

/** FEAT-273: what the main menu's corner line shows for an account state. Pure, so the node check can read it. */
export interface AccountLineView { who: string; action: 'sign-in' | 'sign-out' | null; label: string; disabled: boolean; note: string }

export function accountLineView(state: AccountState, available: boolean, reason: string): AccountLineView {
  if (state.kind === 'pending') return { who: '', action: null, label: '', disabled: false, note: '' };
  if (state.kind === 'guest') return { who: 'Playing as guest', action: 'sign-in', label: 'Sign in with GitHub', disabled: !available, note: available ? '' : reason };
  const p = state.player;
  // the player number is a label: 0 is a number, null is none
  const who = [p.displayName, p.playerNumber !== null ? `player ${p.playerNumber}` : '', p.role === 'maintainer' ? 'maintainer' : ''].filter(Boolean).join(' \u00b7 ');
  return { who, action: 'sign-out', label: 'Sign out', disabled: false, note: '' };
}

/**
 * Draws the line into `host` and keeps it current. Everything from the account goes in through textContent,
 * never innerHTML. The button is a plain button.link so MenuNav reaches it. Returns the unsubscribe.
 */
export function mountAccountLine(host: HTMLElement, account: AccountService): () => void {
  const who = document.createElement('span'); who.className = 'who';
  const btn = document.createElement('button'); btn.className = 'link'; btn.type = 'button';
  const note = document.createElement('span'); note.className = 'note';
  host.append(who, btn, note);
  let busy = false, failure = '';
  let action: AccountLineView['action'] = null;

  const draw = () => {
    const v = accountLineView(account.state(), account.available, account.unavailableReason);
    action = v.action;
    host.hidden = v.action === null;
    who.textContent = v.who;
    btn.hidden = v.action === null;
    btn.textContent = busy ? 'Signing in...' : v.label;
    btn.disabled = busy || v.disabled;
    note.textContent = failure || v.note;
    note.hidden = !note.textContent;
  };
  btn.addEventListener('click', async () => {
    if (busy || !action) return;
    failure = '';
    if (action === 'sign-out') { await account.signOut(); draw(); return; }
    busy = true; draw();
    const r = await account.signIn({ method: 'github' });
    busy = false;
    if (!r.ok) failure = r.message; // a cancelled sign-in has an empty message: no note
    draw();
  });
  const off = account.onChange(() => { if (account.state().kind === 'signed-in') failure = ''; draw(); });
  draw();
  return () => { off(); who.remove(); btn.remove(); note.remove(); };
}
