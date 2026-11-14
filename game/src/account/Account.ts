// The account interface (FEAT-273): guest, signed in, the maintainer role. No Firebase imports here.
export const ROLE_MAINTAINER = 'maintainer';
export type Role = 'maintainer' | 'player';
/** playerNumber is a label: null is normal, 0 is valid. Compare with !== null, never test truthiness.
 *  providers are Firebase's provider ids ('github.com', 'password'); email is the account's, null when it has none. */
export interface Player { uid: string; playerNumber: number | null; displayName: string; role: Role; providers: string[]; email: string | null }
export type AccountState = { kind: 'pending' } | { kind: 'guest' } | { kind: 'signed-in'; player: Player };
/** FEAT-274: a second way in. `create` is a sign-up (a new account), else a sign-in to an existing one. */
export type SignInRequest = { method: 'github' } | { method: 'password'; email: string; password: string; create: boolean };
/** A sign-in method added to the signed-in account (FEAT-274): never a sign-in, never a new account. */
export type AddMethodRequest = { method: 'github' } | { method: 'password'; email: string; password: string };
export type SignInFailureCode = 'cancelled' | 'popup-blocked' | 'email-in-use' | 'unauthorized-domain' | 'network' | 'not-enabled' | 'unavailable'
  | 'bad-credentials' | 'unverified' | 'weak-password' | 'invalid-email' | 'already-added' | 'too-many-requests' | 'not-signed-in' | 'unknown';
export type SignInResult = { ok: true; player: Player; note?: string } | { ok: false; code: SignInFailureCode; message: string };
/** FEAT-283: a password reset request. `ok` says the request went in, never whether the address has an account. */
export type ResetResult = { ok: true; note: string } | { ok: false; code: SignInFailureCode; message: string };
export const PROVIDER_GITHUB = 'github.com';
export const PROVIDER_PASSWORD = 'password';
/** the providers' names, as the account screen lists them */
export const PROVIDER_LABEL: Record<string, string> = { [PROVIDER_GITHUB]: 'GitHub', [PROVIDER_PASSWORD]: 'Email and password' };
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
  /** FEAT-274: links a second method to the signed-in account; 'not-signed-in' for a guest. A method whose
   *  email or identity belongs to another account is refused ('email-in-use'), never joined. */
  addMethod(req: AddMethodRequest): Promise<SignInResult>;
  /** FEAT-283: Firebase's password reset email to `email`. The same line whether or not the address has an account. */
  sendPasswordReset(email: string): Promise<ResetResult>;
  signOut(): Promise<void>;
  /** the current ID token for `Authorization: Bearer`, null for a guest */
  idToken(): Promise<string | null>;
}
/** FEAT-246's role check for showing Build it. Fails closed: only a signed-in maintainer. */
export function isMaintainer(s: AccountState): boolean {
  return s.kind === 'signed-in' && s.player.role === ROLE_MAINTAINER;
}
/** FEAT-274: an account whose only way in is an email and password that was never verified does not sign in
 *  (it could be anyone's address). An account with another method was opened by that method, so it is not held back. */
export function needsVerification(u: { providerIds: string[]; emailVerified: boolean }): boolean {
  return !u.emailVerified && u.providerIds.length > 0 && u.providerIds.every((p) => p === PROVIDER_PASSWORD);
}
