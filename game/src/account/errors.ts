import type { ResetResult, SignInResult } from './Account';

type Failure = Extract<SignInResult, { ok: false }>;

const UNAUTHORIZED_ORIGIN = 'Sign-in works only at http://localhost:5173 on this PC. Here you can play as a guest.';
/** FEAT-274: the one refusal for a method whose email belongs to another account (never joined to it) */
export const EMAIL_IN_USE = 'That email already belongs to another account. Sign in the way you usually do, then add this method from your account.';
/** With email enumeration protection on, Firebase does not say whether the password was wrong or there is no such
 *  account (both are auth/invalid-credential), so this one line covers both and never tells them apart. */
export const BAD_CREDENTIALS = 'That email and password do not open an account. Check them, or sign in the way you usually do and add a password from your account.';

/** FEAT-283: the one line after a reset request that went in. With email enumeration protection on, Firebase answers
 *  the same for an address with no account, so this line never says whether there is one. */
export const RESET_SENT = 'If that email has an account, a reset link is on its way.';

/** Maps a Firebase error from sendPasswordResetEmail. auth/user-not-found (a project with enumeration protection off)
 *  reads as a request that went in, so the panel still never says whether the address has an account. */
export function resetFailure(code: string): ResetResult {
  if (code === 'auth/user-not-found' || code === 'auth/invalid-credential') return { ok: true, note: RESET_SENT };
  const f = signInFailure(code, { method: 'password' });
  if (f.code === 'unknown' || f.code === 'bad-credentials') return { ok: false, code: 'unknown', message: `The reset email did not go out (${code}). Try again in a minute.` };
  return f;
}

/** Maps a Firebase auth error code to our failure code and the line shown to the player. `method` is the method
 *  being used; `adding` is true when it is being added to the signed-in account (linkWithCredential / linkWithPopup). */
export function signInFailure(code: string, o: { method?: 'github' | 'password'; adding?: boolean } = {}): Failure {
  const method = o.method ?? 'github';
  // From an origin the browser key does not allow, the SDK builds this code from Google's message, before any domain check.
  if (code.startsWith('auth/requests-from-referer-')) return { ok: false, code: 'unauthorized-domain', message: UNAUTHORIZED_ORIGIN };
  if (code.startsWith('auth/api-key-not-valid')) return { ok: false, code: 'unavailable', message: 'Sign-in is not set up correctly in this build.' };
  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
    case 'auth/user-cancelled':
      return { ok: false, code: 'cancelled', message: '' };
    case 'auth/popup-blocked':
      return { ok: false, code: 'popup-blocked', message: 'The browser blocked the sign-in window: click the button with the mouse.' };
    case 'auth/account-exists-with-different-credential':
    case 'auth/email-already-in-use':
    case 'auth/credential-already-in-use':
      if (o.adding) return { ok: false, code: 'email-in-use', message: method === 'github' ? 'That GitHub account already belongs to another account, so it cannot be added to this one.' : 'That email already belongs to another account, so it cannot be added to this one.' };
      return { ok: false, code: 'email-in-use', message: EMAIL_IN_USE };
    case 'auth/provider-already-linked':
      return { ok: false, code: 'already-added', message: 'This account already has that sign-in method.' };
    case 'auth/unauthorized-domain':
      return { ok: false, code: 'unauthorized-domain', message: UNAUTHORIZED_ORIGIN };
    case 'auth/network-request-failed':
      return { ok: false, code: 'network', message: 'No connection to the sign-in service. Try again, or play as a guest.' };
    case 'auth/too-many-requests':
      return { ok: false, code: 'too-many-requests', message: 'Too many tries. Wait a few minutes, then try again.' };
    case 'auth/operation-not-allowed':
      return { ok: false, code: 'not-enabled', message: method === 'password' ? 'Email and password sign-in is not turned on for this game.' : 'GitHub sign-in is not turned on for this game.' };
    case 'auth/invalid-email':
    case 'auth/missing-email':
      return { ok: false, code: 'invalid-email', message: 'That is not an email address.' };
    case 'auth/weak-password':
    case 'auth/password-does-not-meet-requirements':
      return { ok: false, code: 'weak-password', message: 'That password is too short or too simple: pick a longer one.' };
  }
  if (method === 'password' && ['auth/invalid-credential', 'auth/invalid-login-credentials', 'auth/wrong-password', 'auth/user-not-found', 'auth/missing-password'].includes(code)) {
    return { ok: false, code: 'bad-credentials', message: BAD_CREDENTIALS };
  }
  return { ok: false, code: 'unknown', message: `Sign-in failed (${code}).` };
}
