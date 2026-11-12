// The only file that imports firebase/auth. createAccount loads it with a dynamic import, so the SDK
// stays in its own chunk and the main bundle carries no Firebase code.
import { GithubAuthProvider, getAuth, getIdToken, getIdTokenResult, onAuthStateChanged, signInWithPopup, signOut, type User } from 'firebase/auth';
import { firebaseApp } from '../firebase/app';
import type { AuthPort, PortUser } from './firebaseAccount';

interface FbPortUser extends PortUser { fb: User }

function wrap(fb: User): FbPortUser {
  return { uid: fb.uid, displayName: fb.displayName, providerIds: fb.providerData.map((p) => p.providerId), fb };
}
const raw = (u: PortUser): User => (u as FbPortUser).fb;

export async function firebaseAuthPort(): Promise<AuthPort> {
  const app = await firebaseApp();
  if (!app) throw Object.assign(new Error('Firebase is not configured'), { code: 'auth/not-configured' });
  const auth = getAuth(app);
  return {
    onUser: (cb) => { onAuthStateChanged(auth, (u) => cb(u ? wrap(u) : null)); },
    signInGithub: async () => wrap((await signInWithPopup(auth, new GithubAuthProvider())).user),
    signOut: () => signOut(auth),
    claims: async (u, refresh) => (await getIdTokenResult(raw(u), refresh)).claims as Record<string, unknown>,
    token: (u) => getIdToken(raw(u)),
  };
}
