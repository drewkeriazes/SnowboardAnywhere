// The Firebase-backed account (FEAT-273). The logic lives here and talks to Firebase only through the
// small AuthPort below, so this file has no SDK import and tools/accountcheck.mjs can run it on a stub.
// Fail closed: anything unreadable is a player, never a maintainer; a guest and a pending state never are.
// FEAT-274: email and password, and a second method added from a signed-in session (never by matching emails).
import { needsVerification, PROVIDER_GITHUB, PROVIDER_PASSWORD, type AccountService, type AccountState, type AddMethodRequest, type SignInRequest, type SignInResult } from './Account';
import { playerFromUser } from './claims';
import { signInFailure } from './errors';

export interface PortUser { uid: string; displayName: string | null; providerIds: string[]; email: string | null; emailVerified: boolean }
export interface AuthPort {
  /** Firebase's onAuthStateChanged: the restored session or null, then every change */
  onUser(cb: (u: PortUser | null) => void): void;
  /** signInWithPopup(GithubAuthProvider); rejects with an Error carrying Firebase's `code` */
  signInGithub(): Promise<PortUser>;
  /** signInWithEmailAndPassword; with email enumeration protection a wrong password and no such account are both auth/invalid-credential */
  signInPassword(email: string, password: string): Promise<PortUser>;
  /** createUserWithEmailAndPassword (signs the new account in); an email another account has is auth/email-already-in-use */
  createPassword(email: string, password: string): Promise<PortUser>;
  /** sendEmailVerification(user) */
  sendVerification(u: PortUser): Promise<void>;
  /** linkWithCredential(user, EmailAuthProvider.credential(email, password)) */
  linkPassword(u: PortUser, email: string, password: string): Promise<PortUser>;
  /** linkWithPopup(user, GithubAuthProvider) */
  linkGithub(u: PortUser): Promise<PortUser>;
  signOut(): Promise<void>;
  /** getIdTokenResult(user, refresh).claims */
  claims(u: PortUser, refresh: boolean): Promise<Record<string, unknown>>;
  /** getIdToken(user): Firebase refreshes an expired token itself */
  token(u: PortUser): Promise<string>;
}

function codeOf(e: unknown): string | undefined {
  const c = (e as { code?: unknown } | null)?.code;
  return typeof c === 'string' ? c : undefined;
}
const codeOrMessage = (e: unknown): string => codeOf(e) ?? (e instanceof Error ? e.message : String(e));

/** The fields of a password request before anything goes to Firebase: the email trimmed, the password as typed. */
function passwordFields(email: string, password: string): { email: string; password: string } | Extract<SignInResult, { ok: false }> {
  const e = email.trim();
  if (e === '') return { ok: false, code: 'invalid-email', message: 'Type your email address.' };
  if (password === '') return { ok: false, code: 'bad-credentials', message: 'Type your password.' };
  return { email: e, password };
}

export class FirebaseAccount implements AccountService {
  private ok = true;
  private reason = '';
  private current: AccountState = { kind: 'pending' };
  private user: PortUser | null = null;
  private port: AuthPort | null = null;
  private seq = 0;
  private inFlight: Promise<SignInResult> | null = null;
  private readonly listeners = new Set<(s: AccountState) => void>();
  private readonly settled: Promise<AccountState>;
  private readonly portReady: Promise<AuthPort | null>;

  constructor(port: Promise<AuthPort>) {
    let resolveSettled!: (s: AccountState) => void;
    this.settled = new Promise((r) => { resolveSettled = r; });
    this.listeners.add((s) => { if (s.kind !== 'pending') resolveSettled(s); });
    this.portReady = port.then((p) => {
      this.port = p;
      p.onUser((u) => { void this.onUser(u); });
      return p;
    }, (e: unknown) => {
      this.ok = false;
      this.reason = `Sign-in could not start (${codeOf(e) ?? (e instanceof Error ? e.message : String(e))}).`;
      this.set({ kind: 'guest' });
      return null;
    });
  }

  get available(): boolean { return this.ok; }
  get unavailableReason(): string { return this.ok ? '' : this.reason; }

  state(): AccountState { return this.current; }

  onChange(cb: (s: AccountState) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  ready(): Promise<AccountState> { return this.settled; }

  /** A second call (sign-in or add) while one is pending returns the same promise: one popup. */
  signIn(req: SignInRequest): Promise<SignInResult> {
    this.inFlight ??= this.doSignIn(req).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  addMethod(req: AddMethodRequest): Promise<SignInResult> {
    this.inFlight ??= this.doAdd(req).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async doSignIn(req: SignInRequest): Promise<SignInResult> {
    const port = await this.portReady;
    if (!port) return { ok: false, code: 'unavailable', message: this.reason };
    let u: PortUser;
    if (req.method === 'password') {
      const f = passwordFields(req.email, req.password);
      if ('ok' in f) return f;
      try {
        u = req.create ? await port.createPassword(f.email, f.password) : await port.signInPassword(f.email, f.password);
      } catch (e) {
        return signInFailure(codeOrMessage(e), { method: 'password' });
      }
      if (needsVerification(u)) return this.holdForVerification(port, u, f.email, req.create);
    } else {
      try {
        u = await port.signInGithub();
      } catch (e) {
        return signInFailure(codeOrMessage(e));
      }
    }
    const mine = ++this.seq;
    let claims: Record<string, unknown> = {};
    try { claims = await port.claims(u, true); } catch { /* unreadable: a player */ }
    // A sign-out seen while the claims were read wins: report no sign-in rather than one that is not there.
    if (mine !== this.seq) return { ok: false, code: 'cancelled', message: '' };
    const player = playerFromUser(u, claims);
    this.user = u;
    this.set({ kind: 'signed-in', player });
    return { ok: true, player };
  }

  /** A password-only account with an unverified email: a (new) verification link goes out and the session ends, so
   *  the account never opens until the link is used. The SDK's own echo of the sign-in is ignored while in flight. */
  private async holdForVerification(port: AuthPort, u: PortUser, typed: string, created: boolean): Promise<SignInResult> {
    const to = u.email ?? typed;
    let sent = true;
    try { await port.sendVerification(u); } catch { sent = false; }
    try { await port.signOut(); } catch { /* the account is held back here regardless */ }
    this.seq++;
    this.user = null;
    this.set({ kind: 'guest' });
    const message = created
      ? (sent ? `Account made. We sent a link to ${to}: open it, then sign in here.` : `Account made, but the verification email to ${to} did not go out. Sign in again to get a new link.`)
      : (sent ? `Verify your email first: we sent a new link to ${to}. Open it, then sign in here.` : `Verify your email first: open the link we sent to ${to}, then sign in here.`);
    return { ok: false, code: 'unverified', message };
  }

  private async doAdd(req: AddMethodRequest): Promise<SignInResult> {
    const port = await this.portReady;
    if (!port) return { ok: false, code: 'unavailable', message: this.reason };
    const u0 = this.user;
    if (!u0 || this.current.kind !== 'signed-in') return { ok: false, code: 'not-signed-in', message: 'Sign in first, then add a sign-in method from your account.' };
    if (u0.providerIds.includes(req.method === 'github' ? PROVIDER_GITHUB : PROVIDER_PASSWORD)) return { ok: false, code: 'already-added', message: 'This account already has that sign-in method.' };
    const start = this.seq;
    let u: PortUser;
    let typed = '';
    if (req.method === 'password') {
      const f = passwordFields(req.email, req.password);
      if ('ok' in f) return f;
      typed = f.email;
      try { u = await port.linkPassword(u0, f.email, f.password); } catch (e) { return signInFailure(codeOrMessage(e), { method: 'password', adding: true }); }
    } else {
      try { u = await port.linkGithub(u0); } catch (e) { return signInFailure(codeOrMessage(e), { method: 'github', adding: true }); }
    }
    // signed out (here or in another tab) while the link ran: report nothing added to a session that is gone
    if (this.seq !== start || this.user?.uid !== u0.uid) return { ok: false, code: 'cancelled', message: '' };
    let note = 'Added: you can sign in either way now.';
    if (req.method === 'password' && !u.emailVerified) {
      // not a gate here (the account was opened by its other method); it proves the address for later
      try { await port.sendVerification(u); note = `Added. We sent a link to ${u.email ?? typed} to verify the address.`; } catch { /* the method is added either way */ }
    }
    const mine = ++this.seq;
    let claims: Record<string, unknown> = {};
    try { claims = await port.claims(u, true); } catch { /* unreadable: a player */ }
    if (mine !== this.seq) return { ok: false, code: 'cancelled', message: '' };
    const player = playerFromUser(u, claims);
    this.user = u;
    this.set({ kind: 'signed-in', player });
    return { ok: true, player, note };
  }

  async signOut(): Promise<void> {
    const port = await this.portReady;
    if (port) {
      try { await port.signOut(); } catch { /* signed out here regardless */ }
    }
    this.seq++;
    this.user = null;
    this.set({ kind: 'guest' });
  }

  async idToken(): Promise<string | null> {
    const u = this.user;
    if (!u || this.current.kind !== 'signed-in' || !this.port) return null;
    let token: string;
    try { token = await this.port.token(u); } catch { return null; }
    // FEAT-246: a sign-out (or another user) during the await: never hand out the previous user's token
    return this.user === u && this.current.kind === 'signed-in' ? token : null;
  }

  private async onUser(u: PortUser | null): Promise<void> {
    if (u && this.inFlight) return; // a sign-in in progress owns the transition, with fresh claims
    const mine = ++this.seq;
    if (!u) {
      this.user = null;
      this.set({ kind: 'guest' });
      return;
    }
    if (this.user?.uid === u.uid && this.current.kind === 'signed-in') return;
    if (needsVerification(u)) {
      // a restored session of an unverified password-only account (the tab closed mid sign-up): never opened
      this.user = null;
      this.set({ kind: 'guest' });
      try { await this.port!.signOut(); } catch { /* guest here regardless */ }
      return;
    }
    let claims: Record<string, unknown> = {};
    try { claims = await this.port!.claims(u, false); } catch { /* offline restore: a player */ }
    if (mine !== this.seq) return;
    this.user = u;
    this.set({ kind: 'signed-in', player: playerFromUser(u, claims) });
  }

  private set(s: AccountState): void {
    if (this.current.kind === s.kind && s.kind !== 'signed-in') return;
    this.current = s;
    for (const cb of [...this.listeners]) cb(s);
  }
}
