// The one Firebase app init (FEAT-273). Everything that talks to Firebase (accounts now, rider positions
// in FEAT-021) goes through firebaseApp(), so the SDK chunk loads once, and only when the web config is
// complete. Unconfigured (CI, a fresh checkout) it resolves null and the SDK is never fetched.
import type { FirebaseApp } from 'firebase/app';
import { readFirebaseConfig } from './config';

let app: Promise<FirebaseApp | null> | null = null;

export function firebaseApp(): Promise<FirebaseApp | null> {
  app ??= (async () => {
    const { config } = readFirebaseConfig(import.meta.env as Record<string, unknown>);
    if (!config) return null;
    const { initializeApp } = await import('firebase/app');
    return initializeApp(config);
  })();
  return app;
}
