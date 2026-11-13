// The ?account= fakes and the checks' accounts (FEAT-273, FEAT-274). A signed-in or guest fake is the real
// FirebaseAccount over MemoryAuth, an in-memory stand-in for a Firebase project with "one account per email"
// on and email enumeration protection on, so the checks drive the same sign-in, verification and add-a-method
// logic the game uses, with no network.
import { PROVIDER_GITHUB, PROVIDER_PASSWORD, type AccountService, type AccountState, type Player, type SignInResult } from './Account';
import { playerFromUser } from './claims';
import { FirebaseAccount, type AuthPort, type PortUser } from './firebaseAccount';

/** one account in the fake project */
export interface MemoryUser {
  uid: string; displayName: string | null; role: 'maintainer' | 'player' | null; player: number | null;
  /** the account's email (its GitHub one, or the one it signed up with) */
  email: string | null;
  github: boolean;
  /** the password and the email it signs in with, when the account has the password method */
  password: string | null; passwordEmail: string | null;
  emailVerified: boolean;
}

const SEED: MemoryUser[] = [
  { uid: 'fake-maintainer', displayName: 'Test maintainer', role: 'maintainer', player: 1, email: 'player1@example.test', github: true, password: null, passwordEmail: null, emailVerified: false },
  // Number 0 and the markup in the name are on purpose: they catch truthiness tests and unescaped HTML.
  { uid: 'fake-player', displayName: 'Test <i>player</i>', role: null, player: 0, email: 'player0@example.test', github: true, password: null, passwordEmail: null, emailVerified: false },
  // a password-only account whose email is verified
  { uid: 'fake-rider', displayName: 'Test rider', role: null, player: null, email: 'rider@example.test', github: false, password: 'rider-password', passwordEmail: 'rider@example.test', emailVerified: true },
];
export const FAKE_PASSWORD_RIDER = { email: 'rider@example.test', password: 'rider-password' };

function portUser(r: MemoryUser): PortUser {
  return { uid: r.uid, displayName: r.displayName, providerIds: [...(r.github ? [PROVIDER_GITHUB] : []), ...(r.password !== null ? [PROVIDER_PASSWORD] : [])], email: r.email ?? r.passwordEmail, emailVerified: r.emailVerified };
}
function claimsOf(r: MemoryUser): Record<string, unknown> {
  return { ...(r.role ? { role: r.role } : {}), ...(r.player !== null ? { player: r.player } : {}) };
}
const seedPlayer = (uid: string): Player => { const r = SEED.find((x) => x.uid === uid)!; return playerFromUser(portUser(r), claimsOf(r)); };
export const FAKE_MAINTAINER: Player = seedPlayer('fake-maintainer');
export const FAKE_PLAYER: Player = seedPlayer('fake-player');
export const FAKE_RIDER: Player = seedPlayer('fake-rider');

const fail = (code: string): never => { throw Object.assign(new Error(code), { code }); };
const same = (a: string | null, b: string): boolean => a !== null && a.toLowerCase() === b.toLowerCase();

/**
 * The fake project: an AuthPort with the rules the real one has here. A password sign-in that does not match says
 * auth/invalid-credential whether the account exists or not (enumeration protection); a sign-up or a link whose
 * email another account has is refused, never joined. `github` is the uid whose GitHub identity the "popup" returns,
 * null for a GitHub identity no account has yet. sent lists the verification emails, verify() is clicking one.
 */
export class MemoryAuth implements AuthPort {
  readonly users: MemoryUser[] = SEED.map((r) => ({ ...r }));
  readonly sent: string[] = [];
  private cb: ((u: PortUser | null) => void) | null = null;
  private current: MemoryUser | null;
  private n = 0;

  constructor(o: { session?: string | null; github?: string | null } = {}) {
    this.current = o.session ? this.users.find((r) => r.uid === o.session) ?? null : null;
    this.githubUid = o.github === undefined ? 'fake-player' : o.github;
  }
  githubUid: string | null;

  verify(email: string): void { for (const r of this.users) if (same(r.email, email) || same(r.passwordEmail, email)) r.emailVerified = true; }
  user(uid: string): MemoryUser | undefined { return this.users.find((r) => r.uid === uid); }

  onUser(cb: (u: PortUser | null) => void): void {
    this.cb = cb;
    const c = this.current;
    queueMicrotask(() => cb(c ? portUser(c) : null));
  }
  private signInAs(r: MemoryUser): PortUser {
    this.current = r;
    const u = portUser(r);
    queueMicrotask(() => this.cb?.(u)); // the SDK's own echo of a sign-in
    return u;
  }
  private taken(email: string, except: string | null): boolean {
    return this.users.some((r) => r.uid !== except && (same(r.email, email) || same(r.passwordEmail, email)));
  }
  private checkNew(email: string, password: string): void {
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) fail('auth/invalid-email');
    if (password.length < 6) fail('auth/weak-password');
  }

  async signInGithub(): Promise<PortUser> {
    let r = this.githubUid ? this.user(this.githubUid) : undefined;
    if (!r) {
      r = { uid: `fake-new-${++this.n}`, displayName: 'New GitHub rider', role: null, player: null, email: null, github: true, password: null, passwordEmail: null, emailVerified: false };
      this.users.push(r);
      this.githubUid = r.uid;
    }
    return this.signInAs(r);
  }
  async signInPassword(email: string, password: string): Promise<PortUser> {
    const r = this.users.find((x) => x.password !== null && same(x.passwordEmail, email));
    if (!r || r.password !== password) fail('auth/invalid-credential');
    return this.signInAs(r!);
  }
  async createPassword(email: string, password: string): Promise<PortUser> {
    if (this.taken(email, null)) fail('auth/email-already-in-use');
    this.checkNew(email, password);
    const r: MemoryUser = { uid: `fake-new-${++this.n}`, displayName: null, role: null, player: null, email, github: false, password, passwordEmail: email, emailVerified: false };
    this.users.push(r);
    return this.signInAs(r);
  }
  async sendVerification(u: PortUser): Promise<void> { const r = this.user(u.uid); if (r) this.sent.push(r.passwordEmail ?? r.email ?? ''); }
  async linkPassword(u: PortUser, email: string, password: string): Promise<PortUser> {
    const r = this.user(u.uid) ?? fail('auth/user-not-found');
    if (r.password !== null) fail('auth/provider-already-linked');
    if (this.taken(email, r.uid)) fail('auth/email-already-in-use');
    this.checkNew(email, password);
    r.password = password; r.passwordEmail = email; r.email ??= email;
    return portUser(r);
  }
  async linkGithub(u: PortUser): Promise<PortUser> {
    const r = this.user(u.uid) ?? fail('auth/user-not-found');
    if (r.github) fail('auth/provider-already-linked');
    if (this.githubUid !== null && this.githubUid !== r.uid) fail('auth/credential-already-in-use');
    r.github = true;
    this.githubUid = r.uid;
    return portUser(r);
  }
  async signOut(): Promise<void> { this.current = null; queueMicrotask(() => this.cb?.(null)); }
  async claims(u: PortUser): Promise<Record<string, unknown>> { const r = this.user(u.uid); return r ? claimsOf(r) : {}; }
  async token(u: PortUser): Promise<string> { return `fake:${u.uid}`; }
}

/** A fake over MemoryAuth: the real account logic on the fake project. auth is there for the checks. */
export function memoryAccount(o: { session?: string | null; github?: string | null } = {}): AccountService & { auth: MemoryAuth } {
  const auth = new MemoryAuth(o);
  return Object.assign(new FirebaseAccount(Promise.resolve(auth)), { auth });
}

/** An AccountService that cannot sign in (no config, a headless page). */
export class FakeAccount implements AccountService {
  readonly available = false;
  readonly unavailableReason: string;
  constructor(o: { reason?: string } = {}) { this.unavailableReason = o.reason ?? 'Sign-in is not available.'; }

  /** ?account=guest|player|maintainer|rider|unconfigured; null for anything else */
  static fromParam(v: string): AccountService | null {
    switch (v) {
      case 'guest': return memoryAccount({ session: null, github: 'fake-player' });
      case 'player': return memoryAccount({ session: 'fake-player', github: 'fake-player' });
      case 'maintainer': return memoryAccount({ session: 'fake-maintainer', github: 'fake-maintainer' });
      // a password-only account; the GitHub "popup" returns an identity no account has, so Add GitHub links it
      case 'rider': return memoryAccount({ session: 'fake-rider', github: null });
      case 'unconfigured': return new FakeAccount({ reason: 'Sign-in is not set up in this build.' });
      default: return null;
    }
  }

  state(): AccountState { return { kind: 'guest' }; }
  onChange(_cb: (s: AccountState) => void): () => void { return () => {}; }
  ready(): Promise<AccountState> { return Promise.resolve({ kind: 'guest' }); }
  async signIn(): Promise<SignInResult> { return { ok: false, code: 'unavailable', message: this.unavailableReason }; }
  async addMethod(): Promise<SignInResult> { return { ok: false, code: 'unavailable', message: this.unavailableReason }; }
  async signOut(): Promise<void> {}
  async idToken(): Promise<string | null> { return null; }
}
