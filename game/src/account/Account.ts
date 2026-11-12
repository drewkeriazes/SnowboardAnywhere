// The account interface (FEAT-273): guest, signed in, the maintainer role. No Firebase imports here.
export const ROLE_MAINTAINER = 'maintainer';
export type Role = 'maintainer' | 'player';
/** playerNumber is a label: null is normal, 0 is valid. Compare with !== null, never test truthiness. */
export interface Player { uid: string; playerNumber: number | null; displayName: string; role: Role; providers: string[] }
export type AccountState = { kind: 'pending' } | { kind: 'guest' } | { kind: 'signed-in'; player: Player };
/** FEAT-274 adds { method: 'password'; email: string; password: string; create: boolean } */
export type SignInRequest = { method: 'github' };
export type SignInFailureCode = 'cancelled' | 'popup-blocked' | 'email-in-use' | 'unauthorized-domain' | 'network' | 'not-enabled' | 'unavailable' | 'unknown';
export type SignInResult = { ok: true; player: Player } | { ok: false; code: SignInFailureCode; message: string };
export interface AccountService {
  /** false when sign-in can't work here (no config, the SDK failed to start, a headless page) */
  readonly available: boolean;
  /** one line saying why, '' when available */
  readonly unavailableReason: string;
  state(): AccountState;
  /** called on every state or availability change; returns the unsubscribe */
  onChange(cb: (s: AccountState) => void): () => void;
  /** resolves with the first settled state (never 'pending') */
  ready(): Promise<AccountState>;
  signIn(req: SignInRequest): Promise<SignInResult>;
  signOut(): Promise<void>;
  /** the current ID token for `Authorization: Bearer`, null for a guest */
  idToken(): Promise<string | null>;
}
/** FEAT-246's role check for showing Build it. Fails closed: only a signed-in maintainer. */
export function isMaintainer(s: AccountState): boolean {
  return s.kind === 'signed-in' && s.player.role === ROLE_MAINTAINER;
}
