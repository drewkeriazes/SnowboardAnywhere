import type { AccountService } from './Account';
import { FakeAccount } from './fakeAccount';
import { FirebaseAccount, type AuthPort } from './firebaseAccount';
import { readFirebaseConfig } from '../firebase/config';

/** Picks the account: a ?account= fake (not on a hosted build), an unavailable one (headless, no web
 *  config), else the Firebase one. The dynamic import keeps firebase/* in its own chunk. */
export function createAccount(o: { env: Record<string, unknown>; fake: string | null; hosted: boolean; headless: boolean; loadPort?: () => Promise<AuthPort> }): AccountService {
  if (o.fake && !o.hosted) {
    const f = FakeAccount.fromParam(o.fake);
    if (f) return f;
    console.warn(`Unknown ?account=${o.fake}; ignored.`);
  }
  if (o.headless) return new FakeAccount({ reason: 'Sign-in is off on a headless page.' });
  const { config, missing } = readFirebaseConfig(o.env);
  if (!config) {
    if (missing.length > 0 && missing.length < 4) console.warn(`Sign-in is off: the Firebase web config is missing ${missing.join(', ')}.`);
    return FakeAccount.fromParam('unconfigured')!;
  }
  return new FirebaseAccount((o.loadPort ?? (() => import('./firebasePort').then((m) => m.firebaseAuthPort())))());
}
