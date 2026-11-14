// FEAT-274: the account panel, opened from the main menu's corner line (ui/AccountLine.ts) into the menu's pop-up.
// A guest signs in with GitHub or with an email and password (or makes a password account). A signed-in player sees
// the account's sign-in methods and adds the missing one from here: a second method joins an account only from a
// session already signed in to it, never because two emails match. Everything from the account goes in through
// textContent or an input's value, never innerHTML.
// FEAT-283: "Forgot your password?" under the sign-in form sends Firebase's reset email to the typed address and
// shows one line whether or not the address has an account. It is a button styled as a link, so the menu's keyboard
// and controller navigation reach it like any other.
import { PROVIDER_GITHUB, PROVIDER_LABEL, PROVIDER_PASSWORD, type AccountService, type AccountState, type ResetResult, type SignInResult } from '../account/Account';
import { whoLine } from './AccountLine';

export type MethodKey = 'github' | 'password';
export interface AccountPanelView {
  kind: 'sign-in' | 'account' | 'none';
  /** the signed-in line (AccountLine's whoLine) */
  who: string;
  /** the account's sign-in methods, by name */
  methods: string[];
  /** the methods it can still add */
  add: MethodKey[];
  /** the account's email, to fill in the add-a-password form */
  email: string;
}

/** Pure, so the node check reads it. */
export function accountPanelView(state: AccountState): AccountPanelView {
  if (state.kind === 'pending') return { kind: 'none', who: '', methods: [], add: [], email: '' };
  if (state.kind === 'guest') return { kind: 'sign-in', who: '', methods: [], add: [], email: '' };
  const p = state.player;
  const add: MethodKey[] = [];
  if (!p.providers.includes(PROVIDER_GITHUB)) add.push('github');
  if (!p.providers.includes(PROVIDER_PASSWORD)) add.push('password');
  return { kind: 'account', who: whoLine(p), methods: p.providers.map((id) => PROVIDER_LABEL[id] ?? id), add, email: p.email ?? '' };
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}
function button(act: string, label: string, cls = 'acct-btn'): HTMLButtonElement {
  const b = el('button', cls, label);
  b.type = 'button';
  b.dataset.act = act;
  return b;
}
/** an email and password pair; Enter in either field presses `submit` (MainMenu's pop-up reads data-submit) */
function fields(submit: string, email: string, newPassword: boolean): { form: HTMLFormElement; email: HTMLInputElement; password: HTMLInputElement } {
  const form = el('form', 'acct-form');
  form.noValidate = true;
  form.addEventListener('submit', (e) => e.preventDefault());
  const em = el('input', '');
  em.type = 'email'; em.name = 'email'; em.autocomplete = 'username'; em.placeholder = 'Email'; em.value = email; em.dataset.submit = submit; em.setAttribute('aria-label', 'Email');
  const pw = el('input', '');
  pw.type = 'password'; pw.name = 'password'; pw.autocomplete = newPassword ? 'new-password' : 'current-password'; pw.placeholder = 'Password'; pw.dataset.submit = submit; pw.setAttribute('aria-label', 'Password');
  form.append(em, pw);
  return { form, email: em, password: pw };
}

/**
 * Fills `host` (the menu's pop-up) and keeps it current. `close` closes the pop-up (after a sign-in or Sign out);
 * `redraw` lets the menu move focus back into the panel after it redraws. Returns the unsubscribe.
 */
export function fillAccountPanel(host: HTMLElement, account: AccountService, o: { close: () => void; redraw?: () => void }): () => void {
  let busy = false;
  let note = '';
  let noteOk = false;
  let keepEmail: string | null = null;

  const run = async (act: string, go: () => Promise<SignInResult | ResetResult | void>, closeOnOk: boolean) => {
    if (busy) return;
    busy = true; note = ''; draw(act);
    const r = await go();
    busy = false;
    if (closeOnOk && (!r || r.ok)) { o.close(); return; }
    if (r) { note = r.ok ? (r.note ?? '') : r.message; noteOk = r.ok || (r.code === 'unverified' && act === 'signup'); } // a cancelled popup has an empty message: no note
    if (!host.isConnected || host.hidden) return;
    // a reset request: focus stays on the link, or goes to the email field when that is what needs fixing
    if (act === 'forgot') { draw(null, r && !r.ok && r.code === 'invalid-email' ? 'input[name=email]' : 'button[data-act=forgot]'); return; }
    // a refused password: back to its field to try again
    draw(null, r && !r.ok && act !== 'github' && act !== 'add-github' ? 'input[name=password]' : null);
  };

  const draw = (pressed: string | null, focus: string | null = null) => {
    const v = accountPanelView(account.state());
    const typed = host.querySelector<HTMLInputElement>('input[name=email]')?.value;
    if (typed !== undefined) keepEmail = typed;
    host.replaceChildren();
    if (v.kind === 'none') { host.append(el('div', 'ph', 'Account'), el('p', 'dim', 'Checking your sign-in...')); return; }
    const busyLabel = (act: string, label: string) => (busy && pressed === act ? 'Working...' : label);
    if (v.kind === 'sign-in') {
      host.append(el('div', 'ph', 'Sign in'), el('p', '', 'Signing in is optional: a guest rides everything.'));
      const gh = button('github', busyLabel('github', 'Sign in with GitHub'), 'primary');
      gh.addEventListener('click', () => run('github', () => account.signIn({ method: 'github' }), true));
      const f = fields('signin', keepEmail ?? '', false);
      const signin = button('signin', busyLabel('signin', 'Sign in'));
      const signup = button('signup', busyLabel('signup', 'Make an account'));
      const req = (create: boolean) => ({ method: 'password' as const, email: f.email.value, password: f.password.value, create });
      signin.addEventListener('click', () => run('signin', () => account.signIn(req(false)), true));
      signup.addEventListener('click', () => run('signup', () => account.signIn(req(true)), true));
      const row = el('div', 'acct-row'); row.append(signin, signup);
      const forgot = button('forgot', busyLabel('forgot', 'Forgot your password?'), 'acct-link');
      forgot.addEventListener('click', () => run('forgot', () => account.sendPasswordReset(f.email.value), false));
      f.form.append(row, forgot);
      host.append(gh, el('div', 'acct-or', 'or with email and password'), f.form);
    } else {
      host.append(el('div', 'ph', 'Account'), el('div', 'acct-who', v.who), el('p', '', `Signs in with: ${v.methods.join(', ')}.`));
      if (v.add.length) {
        host.append(el('div', 'acct-sub', 'Add a sign-in method'));
        if (v.add.includes('github')) {
          const b = button('add-github', busyLabel('add-github', 'Add GitHub'));
          b.addEventListener('click', () => run('add-github', () => account.addMethod({ method: 'github' }), false));
          host.append(b);
        }
        if (v.add.includes('password')) {
          const f = fields('add-password', keepEmail ?? v.email, true);
          const b = button('add-password', busyLabel('add-password', 'Add email and password'));
          b.addEventListener('click', () => run('add-password', () => account.addMethod({ method: 'password', email: f.email.value, password: f.password.value }), false));
          f.form.append(b);
          host.append(f.form);
        }
      }
      const out = button('signout', 'Sign out', 'acct-btn acct-out');
      out.addEventListener('click', () => run('signout', async () => { await account.signOut(); keepEmail = null; }, true));
      host.append(out);
    }
    const n = el('p', `acct-note${noteOk ? ' ok' : ''}`, note);
    n.setAttribute('role', 'status');
    n.hidden = !note;
    host.append(n);
    host.querySelectorAll<HTMLButtonElement>('button').forEach((b) => { b.disabled = busy; });
    host.querySelectorAll<HTMLInputElement>('input').forEach((i) => { i.disabled = busy; });
    if (focus) host.querySelector<HTMLElement>(focus)?.focus({ preventScroll: true });
    o.redraw?.();
  };

  let lastKind = account.state().kind;
  const off = account.onChange((s) => {
    if (s.kind !== lastKind) { lastKind = s.kind; if (!busy) { note = ''; keepEmail = null; } }
    if (!busy) draw(null);
  });
  draw(null);
  return off;
}
