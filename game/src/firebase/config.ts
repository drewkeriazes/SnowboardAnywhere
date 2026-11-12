// The public Firebase web config (FEAT-273). These four values identify the project to the browser and
// are public, not secrets. No imports here, so the Node checks can bundle this file alone.

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

/** The env names, in the order of FirebaseWebConfig's fields. */
export const FIREBASE_ENV_NAMES = [
  'VITE_FIREBASE_API_KEY',
  'VITE_FIREBASE_AUTH_DOMAIN',
  'VITE_FIREBASE_PROJECT_ID',
  'VITE_FIREBASE_APP_ID',
] as const;

/**
 * Read the config from an env object. `missing` lists every name that is absent or blank; `config` is
 * non-null only when none is missing. Values are trimmed.
 */
export function readFirebaseConfig(env: Record<string, unknown>): { config: FirebaseWebConfig | null; missing: string[] } {
  const v = FIREBASE_ENV_NAMES.map((n) => (typeof env[n] === 'string' ? (env[n] as string).trim() : ''));
  const missing = FIREBASE_ENV_NAMES.filter((_, i) => v[i] === '');
  if (missing.length > 0) return { config: null, missing };
  return { config: { apiKey: v[0], authDomain: v[1], projectId: v[2], appId: v[3] }, missing };
}
