// The Firebase-backed account (FEAT-273). The logic lives here and talks to Firebase only through the
// small AuthPort below, so this file has no SDK import and tools/accountcheck.mjs can run it on a stub.
// Fail closed: anything unreadable is a player, never a maintainer; a guest and a pending state never are.
import type { AccountService, AccountState, SignInRequest, SignInResult } from './Account';
import { playerFromUser } from './claims';
import { signInFailure } from './errors';

export interface PortUser { uid: string; displayName: string | null; providerIds: string[] }
export interface AuthPort {
  /** Firebase's onAuthStateChanged: the restored session or null, then every change */
  onUser(cb: (u: PortUser | null) => void): void;
  /** signInWithPopup(GithubAuthProvider); rejects with an Error carrying Firebase's `code` */
  signInGithub(): Promise<PortUser>;
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

  /** A second call while one is pending returns the same promise: one popup. */
  signIn(_req: SignInRequest): Promise<SignInResult> {
    this.inFlight ??= this.doSignIn().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async doSignIn(): Promise<SignInResult> {
    const port = await this.portReady;
    if (!port) return { ok: false, code: 'unavailable', message: this.reason };
    let u: PortUser;
    try {
      u = await port.signInGithub();
    } catch (e) {
      return signInFailure(codeOf(e) ?? (e instanceof Error ? e.message : String(e)));
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
