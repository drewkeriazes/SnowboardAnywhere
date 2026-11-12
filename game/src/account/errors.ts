import type { SignInResult } from './Account';

type Failure = Extract<SignInResult, { ok: false }>;

/** Maps a Firebase auth error code to our failure code and the line shown to the player. */
export function signInFailure(code: string): Failure {
  switch (code) {
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
    case 'auth/user-cancelled':
      return { ok: false, code: 'cancelled', message: '' };
    case 'auth/popup-blocked':
      return { ok: false, code: 'popup-blocked', message: 'The browser blocked the sign-in window: click Sign in with the mouse.' };
    case 'auth/account-exists-with-different-credential':
    case 'auth/email-already-in-use':
    case 'auth/credential-already-in-use':
      return { ok: false, code: 'email-in-use', message: 'That email already belongs to another account. Sign in the way you usually do.' };
    case 'auth/unauthorized-domain':
      return { ok: false, code: 'unauthorized-domain', message: "Sign-in works only on this PC's own address (localhost). Here you can play as a guest." };
    case 'auth/network-request-failed':
      return { ok: false, code: 'network', message: 'No connection to the sign-in service. Try again, or play as a guest.' };
    case 'auth/operation-not-allowed':
      return { ok: false, code: 'not-enabled', message: 'GitHub sign-in is not turned on for this game.' };
    default:
      return { ok: false, code: 'unknown', message: `Sign-in failed (${code}).` };
  }
}
