import type { AccountService, AccountState, Player, SignInRequest, SignInResult } from './Account';

export const FAKE_MAINTAINER: Player = { uid: 'fake-maintainer', playerNumber: 1, displayName: 'Test maintainer', role: 'maintainer', providers: ['github.com'] };
// Number 0 and the markup in the name are on purpose: they catch truthiness tests and unescaped HTML.
export const FAKE_PLAYER: Player = { uid: 'fake-player', playerNumber: 0, displayName: 'Test <i>player</i>', role: 'player', providers: ['github.com'] };

/** In-memory AccountService for tests and the ?account= param. */
export class FakeAccount implements AccountService {
  readonly available: boolean;
  readonly unavailableReason: string;
  private current: AccountState;
  private readonly signInAs: Player;
  private readonly listeners = new Set<(s: AccountState) => void>();

  constructor(o: { available?: boolean; reason?: string; signedIn?: Player | null; signInAs?: Player } = {}) {
    this.available = o.available ?? true;
    this.unavailableReason = this.available ? '' : (o.reason ?? 'Sign-in is not available.');
    this.signInAs = o.signInAs ?? FAKE_PLAYER;
    this.current = o.signedIn ? { kind: 'signed-in', player: o.signedIn } : { kind: 'guest' };
  }

  static fromParam(v: string): FakeAccount | null {
    switch (v) {
      case 'guest': return new FakeAccount({});
      case 'player': return new FakeAccount({ signedIn: FAKE_PLAYER });
      case 'maintainer': return new FakeAccount({ signedIn: FAKE_MAINTAINER, signInAs: FAKE_MAINTAINER });
      case 'unconfigured': return new FakeAccount({ available: false, reason: 'Sign-in is not set up in this build.' });
      default: return null;
    }
  }

  state(): AccountState { return this.current; }

  onChange(cb: (s: AccountState) => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  ready(): Promise<AccountState> { return Promise.resolve(this.current); }

  async signIn(_req: SignInRequest): Promise<SignInResult> {
    if (!this.available) return { ok: false, code: 'unavailable', message: this.unavailableReason };
    this.set({ kind: 'signed-in', player: this.signInAs });
    return { ok: true, player: this.signInAs };
  }

  async signOut(): Promise<void> { this.set({ kind: 'guest' }); }

  async idToken(): Promise<string | null> {
    return this.current.kind === 'signed-in' ? `fake:${this.current.player.uid}` : null;
  }

  private set(s: AccountState): void {
    this.current = s;
    for (const cb of [...this.listeners]) cb(s);
  }
}
