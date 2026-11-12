# FEAT-273 Accounts, Guest Play and the Maintainer Role Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A player is either a guest (first-class, rides everything) or signed in with GitHub through Firebase Authentication, and the dev server can tell a `maintainer` account (Drew, player 1) from everyone else, so FEAT-246's Build it can be shown to and accepted from only that account.

**Architecture:** In the browser, one `AccountService` interface (`game/src/account/Account.ts`) with a Firebase implementation (the SDK in a lazy chunk, behind a small `AuthPort` so its logic is testable without a project) and an in-memory `FakeAccount` for tests; the main menu's corner shows the account line. On the dev server only, a `TokenVerifier` interface (Firebase Admin SDK, or a fake) and a `requireAccount` gate that FEAT-246 wraps around `/api/resorts/build`; `/api/account` is the gate's own route and the setup check. The role is a custom claim written only by `game/tools/set_role.mjs` with the Admin SDK, which also writes the `players/<uid>` record.

**Tech Stack:** TypeScript + Vite (game/), Firebase JS SDK `firebase@^13.3.0` (modular `firebase/app`, `firebase/auth`), `firebase-admin@^14.5.1` (Node 22, dev server and one script), esbuild + Node check tools in the repo's `ok / FAIL` style, Playwright through `game/tools/browser.mjs`.

**Spec:** FEAT-273, https://github.com/drewkeriazes/SnowboardAnywhere/issues/600, and MapPacker's design `docs/superpowers/specs/2026-11-12-publish-through-pr-design.md` section 4, "Trust: who may auto-merge", the in-game Build it bullet (https://github.com/drewkeriazes/MapPacker-SnowboardAnywhere/blob/main/docs/superpowers/specs/2026-11-12-publish-through-pr-design.md). Context only, not planned here: FEAT-274 (#603, email and password, must fit `SignInRequest`), FEAT-246 (#566, Build it, consumes `isMaintainer` and `requireAccount`), BUG-110 (#604, `game/tools/same_origin.mjs`, lands first).

**Drew's decisions (2026-11-12), binding on every task:**
1. **Start flow:** no gate screen. The main menu's corner line is the start choice: "Playing as guest · Sign in with GitHub", the name (and number, when there is one) once signed in. RIDE plays as whoever is shown, a guest included.
2. **Player numbers:** assigned only by `game/tools/set_role.mjs` for now (Drew is player 1). A number is a label and can be reassigned by running the script again. Automatic assignment is deferred to FEAT-021 (multiplayer). Until then most accounts have no number, and that is normal: no code path treats a missing number (`null`) as an error, a refusal or a reason to prompt.
3. **Done-when split:** the card's lines "Build it starts a `build-pack` run" and "the publish PR names player 1 as the requester" move to FEAT-246, which adds `/api/resorts/build` and the button, wraps its handler in `requireAccount(devVerifier(), handler, { role: 'maintainer' })` and sends `account.uid` as `requested_by`. FEAT-273 proves the maintainer gate on `GET /api/account` (guest 401, non-maintainer `role: 'player'`, Drew `role: 'maintainer'`) and in `gatecheck.mjs` (guest 401, player 403 on a maintainer route).

## Global Constraints

- Auth service: Firebase Authentication. Provider now: GitHub only (`GithubAuthProvider`, no extra scopes; the GitHub access token in the sign-in result is never read or stored). Email and password is FEAT-274.
- "One account per email address" ON (Firebase console: User account linking > "Link accounts that use the same email"): a sign-in whose email belongs to another account is refused (`auth/account-exists-with-different-credential`), never joined. No code calls `linkWithCredential` / `linkWithPopup` in this card.
- Account id = Firebase uid. `players/<uid>` (Firestore) holds `player` (number), `displayName`, `role`. The player number is a label: compare with `!== null`, never test it for truthiness (player 0 is a valid label). No number (`null`) is the normal state for most accounts (decision 2), never an error.
- Role: custom claim `role: 'maintainer'` (exact string) and `player: <integer>` set only through the Admin SDK (`game/tools/set_role.mjs`). Any other or missing value is role `player` (fail closed), on both sides.
- Guest is first-class: no sign-up prompt, banner, toast or nag anywhere. A guest rides everything. `isMaintainer` is false for a guest, a pending state and any non-maintainer.
- Secrets: the GitHub OAuth client secret lives only in Firebase's console. The service-account key lives at `SBA_FIREBASE_ADMIN_KEY` or, by default, `%USERPROFILE%\.snowboardanywhere\firebase-admin-key.json` (outside every checkout). Neither is ever in `game/src`, the built `dist/`, the launcher bundle, the release zip or the repo. The page holds only the ID token (Firebase's own storage) and the public web config.
- Public web config: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`, from `game/.env.local` (gitignored by `.env.*`), documented in `game/.env.example` (committed, allowed by `!.env.example`); release builds read the same names from GitHub repository variables (`vars.*`).
- Dependencies, both in `game/package.json` (the one package; the dev server and the tools run from `game/`): `firebase` in `dependencies` (bundled into the browser game, only as a lazy chunk); `firebase-admin` in `devDependencies` (imported only by `game/tools/accounts/verifier.mjs`, dynamically, and by `game/tools/set_role.mjs`; never by `game/src/` or anything `game/tools/launcher.mjs` imports).
- The Firebase SDK chunk loads only when the web config is complete and the page is not `?headless`. CI builds have no config, so CI never loads it.
- Firebase app init lives in one place, `game/src/firebase/app.ts` (`firebaseApp()`), so FEAT-021 rider positions reuse it.
- Account routes are dev server only (`configureServer`), never `vite preview` (`npm run host`) or the launcher. Every account route refuses a foreign `Origin` first, with BUG-110's `refuseForeignOrigin(req, res)` from `game/tools/same_origin.mjs`. BUG-110 lands first: merge `origin/main` before Task 5.
- Server verification: `getAuth(app).verifyIdToken(token, true)` (revocation checked). The client sends `Authorization: Bearer <ID token>`.
- BUG-110 is built in parallel (worktree `wt604`) and edits the same `PHYSICS_CHECKS` line and `vite.config.ts`: merge `origin/main` when it lands and keep both sides.
- Repo rules: no em dashes in Markdown or comments; commit messages plain, `FEAT-273: ...`, no trailers; worktree `C:\Users\Drew\git\wt600`, branch `issue-600-accounts`, PR with `Fixes #600`; `cd game && npx tsc --noEmit` before every push; docs travel with the change (README Play, `docs/developer-guide.md`).

## Review Focus

1. **Sign in pressed with a controller.** MenuNav's programmatic click is not a user gesture, so the browser blocks the popup: the line must say "The browser blocked the sign-in window: click Sign in with the mouse." and the button must work again, never hang on "Signing in...". Pinned in Task 2 (`signInFailure('auth/popup-blocked')`) and Task 3 (`popup blocked: button free again`).
2. **The claim changes while a session is open.** Drew is made maintainer after his first sign-in, or a maintainer is demoted: signing in again forces a token refresh so the new role shows; a demotion revokes refresh tokens and the server's `checkRevoked` refuses the old token at once instead of for up to an hour. Pinned in Task 3 (`signIn refreshes claims`) and Task 6 (`needsRevoke`).
3. **Another computer** (`npm run host`, launcher `--lan`: an IP origin Firebase has not authorized). Sign in fails with "Sign-in works only on this PC's own address (localhost). Here you can play as a guest." and guest play is untouched. Pinned in Task 2 (`auth/unauthorized-domain`).
4. **A broken config**: a blank or missing `VITE_FIREBASE_*` value, a wrong API key, or the chunk failing to load. Sign in shows disabled with a one-line reason, a console warning names the missing variables, the menu and guest play work. Pinned in Task 1 (`a blank value counts as missing`) and Task 3 (`port fails to start`).
5. **What GitHub hands us**: a display name with HTML in it, no display name at all, player number 0. Rendered as text, "Player" as the fallback, "player 0" shown. Pinned in Task 2 (`no display name`, `player 0 is kept`) and Task 4 (`name is text`, `player 0 reads`).

---

### Task 1: The public web config and the shared Firebase app

**Files:**
- Create: `game/src/firebase/config.ts`
- Create: `game/src/firebase/app.ts`
- Create: `game/.env.example`
- Create: `game/tools/accountcheck.mjs` (Node check, grows in Tasks 2 to 4)
- Modify: `game/package.json`, `game/package-lock.json` (`npm install firebase@^13.3.0`)
- Modify: `.github/workflows/checks.yml` (`PHYSICS_CHECKS` gains `accountcheck`, alphabetical)

**Interfaces:**
- Produces: `interface FirebaseWebConfig { apiKey: string; authDomain: string; projectId: string; appId: string }`; `readFirebaseConfig(env: Record<string, unknown>): { config: FirebaseWebConfig | null; missing: string[] }` (`missing` lists every one of the four names that is absent or blank; `config` is non-null only when `missing` is empty); `firebaseApp(): Promise<FirebaseApp | null>` (memoized; `await import('firebase/app')` then `initializeApp(config)` once; null when unconfigured). `FIREBASE_ENV_NAMES` (the four names, in the order above).

- [ ] **Step 1: Write the failing test** in `game/tools/accountcheck.mjs`: the header comment and `ok(cond, label)` helper as in `conditionscheck.mjs` (esbuild-bundle each `src/` entry to a temp `.mjs`, import it, exit 1 on a failure).

```js
const full = { VITE_FIREBASE_API_KEY: 'k', VITE_FIREBASE_AUTH_DOMAIN: 'p.firebaseapp.com', VITE_FIREBASE_PROJECT_ID: 'p', VITE_FIREBASE_APP_ID: '1:2:web:3' };
let r = readFirebaseConfig({});
ok(r.config === null && r.missing.length === 4, 'no VITE_FIREBASE_* set: unconfigured');
r = readFirebaseConfig(full);
ok(JSON.stringify(r.config) === JSON.stringify({ apiKey: 'k', authDomain: 'p.firebaseapp.com', projectId: 'p', appId: '1:2:web:3' }) && r.missing.length === 0, 'all four set: a config');
r = readFirebaseConfig({ ...full, VITE_FIREBASE_APP_ID: '  ' });
ok(r.config === null && r.missing.join() === 'VITE_FIREBASE_APP_ID', 'a blank value counts as missing');
r = readFirebaseConfig({ ...full, VITE_FIREBASE_API_KEY: ' k ' });
ok(r.config?.apiKey === 'k', 'values are trimmed');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd game && node tools/accountcheck.mjs`
Expected: esbuild error, `Could not resolve ".../src/firebase/config.ts"`, exit 1.

- [ ] **Step 3: Implement `readFirebaseConfig` in `game/src/firebase/config.ts` and `firebaseApp` in `game/src/firebase/app.ts`**; add `firebase` with `npm install firebase@^13.3.0` in `game/`. `app.ts` reads `import.meta.env` through `readFirebaseConfig`; `config.ts` has no imports (Node-testable). `game/.env.example` lists the four names with empty values and one comment line each: where the value is in the Firebase console (Project settings > Your apps > SDK setup and configuration), that it is public, not a secret, and that the file to fill is `game/.env.local`.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd game && node tools/accountcheck.mjs && npx tsc --noEmit`
Expected: four `ok` lines, exit 0; tsc silent.

- [ ] **Step 5: Commit**

```bash
git add game/src/firebase game/.env.example game/tools/accountcheck.mjs game/package.json game/package-lock.json .github/workflows/checks.yml
git commit -m "FEAT-273: the Firebase web config (VITE_FIREBASE_*, .env.example) and one shared app init"
```

---

### Task 2: The account interface, the in-memory fake, and the claim and error rules

**Files:**
- Create: `game/src/account/Account.ts`
- Create: `game/src/account/claims.ts`
- Create: `game/src/account/errors.ts`
- Create: `game/src/account/fakeAccount.ts`
- Test: `game/tools/accountcheck.mjs`

**Interfaces:**
- Produces, in `Account.ts` (types plus one function, no imports from Firebase):

```ts
export const ROLE_MAINTAINER = 'maintainer';
export type Role = 'maintainer' | 'player';
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
export function isMaintainer(s: AccountState): boolean; // FEAT-246's role check for showing Build it
```

- `claims.ts`: `playerFromUser(user: { uid: string; displayName: string | null; providerIds: string[] }, claims: Record<string, unknown>): Player`. Role is `'maintainer'` only for `claims.role === 'maintainer'`; `playerNumber` is `claims.player` when it is an integer `>= 0`, else null; `displayName` is the trimmed name, or `'Player'` when null or blank.
- `errors.ts`: `signInFailure(code: string): Extract<SignInResult, { ok: false }>`, with this exact copy:

| Firebase code(s) | code | message |
|---|---|---|
| `auth/popup-closed-by-user`, `auth/cancelled-popup-request`, `auth/user-cancelled` | `cancelled` | `''` |
| `auth/popup-blocked` | `popup-blocked` | `The browser blocked the sign-in window: click Sign in with the mouse.` |
| `auth/account-exists-with-different-credential`, `auth/email-already-in-use`, `auth/credential-already-in-use` | `email-in-use` | `That email already belongs to another account. Sign in the way you usually do.` |
| `auth/unauthorized-domain` | `unauthorized-domain` | `Sign-in works only on this PC's own address (localhost). Here you can play as a guest.` |
| `auth/network-request-failed` | `network` | `No connection to the sign-in service. Try again, or play as a guest.` |
| `auth/operation-not-allowed` | `not-enabled` | `GitHub sign-in is not turned on for this game.` |
| anything else | `unknown` | `` `Sign-in failed (${code}).` `` |

- `fakeAccount.ts`: `class FakeAccount implements AccountService`, `constructor(o: { available?: boolean; reason?: string; signedIn?: Player | null; signInAs?: Player })`; `static fromParam(v: string): FakeAccount | null` for `guest`, `player`, `maintainer`, `unconfigured` (null otherwise). Exported fixed players: `FAKE_MAINTAINER = { uid: 'fake-maintainer', playerNumber: 1, displayName: 'Test maintainer', role: 'maintainer', providers: ['github.com'] }` and `FAKE_PLAYER = { uid: 'fake-player', playerNumber: 0, displayName: 'Test <i>player</i>', role: 'player', providers: ['github.com'] }` (number 0 and the markup are on purpose: Review Focus 5). `guest` signs in as `FAKE_PLAYER`; `unconfigured` has `available: false`, reason `Sign-in is not set up in this build.`, and `signIn` answers `{ ok: false, code: 'unavailable', message: <reason> }`. `idToken()` is `fake:<uid>` signed in, null as a guest.

- [ ] **Step 1: Write the failing tests** (append to `accountcheck.mjs`)

```js
const u = (displayName) => ({ uid: 'u1', displayName, providerIds: ['github.com'] });
let p = playerFromUser(u('Drew'), { role: 'maintainer', player: 1 });
ok(p.role === 'maintainer' && p.playerNumber === 1 && p.displayName === 'Drew', 'maintainer claim: role maintainer, player 1');
p = playerFromUser(u('Drew'), {});
ok(p.role === 'player' && p.playerNumber === null, 'no claims: role player, no number');
ok(['Maintainer', 'admin', true, 1].every((role) => playerFromUser(u('x'), { role }).role === 'player'), 'any other role value is a player');
ok(playerFromUser(u('x'), { player: 0 }).playerNumber === 0, 'player 0 is kept');
ok(['1', 1.5, -1, null].every((player) => playerFromUser(u('x'), { player }).playerNumber === null), 'a string, fraction or negative player is no number');
ok(playerFromUser(u(null), {}).displayName === 'Player' && playerFromUser(u('  '), {}).displayName === 'Player', 'no display name: "Player"');
ok(!isMaintainer({ kind: 'pending' }) && !isMaintainer({ kind: 'guest' }) && !isMaintainer({ kind: 'signed-in', player: FAKE_PLAYER }) && isMaintainer({ kind: 'signed-in', player: FAKE_MAINTAINER }), 'isMaintainer only for the maintainer role');
for (const [fb, code] of [['auth/popup-closed-by-user', 'cancelled'], ['auth/cancelled-popup-request', 'cancelled'], ['auth/popup-blocked', 'popup-blocked'], ['auth/account-exists-with-different-credential', 'email-in-use'], ['auth/unauthorized-domain', 'unauthorized-domain'], ['auth/network-request-failed', 'network'], ['auth/operation-not-allowed', 'not-enabled']])
  ok(signInFailure(fb).code === code, `${fb} maps to ${code}`);
ok(signInFailure('auth/zzz').code === 'unknown' && signInFailure('auth/zzz').message.includes('auth/zzz'), 'an unknown code is named in the message');
ok(signInFailure('auth/popup-closed-by-user').message === '', 'a closed popup says nothing');

const m = FakeAccount.fromParam('maintainer');
ok((await m.ready()).kind === 'signed-in' && isMaintainer(m.state()), 'fake maintainer is signed in');
const seen = []; const off = m.onChange((s) => seen.push(s.kind));
await m.signOut();
ok(m.state().kind === 'guest' && seen.join() === 'guest' && (await m.idToken()) === null, 'sign out: guest, one change, no token');
off(); await m.signIn({ method: 'github' });
ok(seen.length === 1, 'unsubscribe stops the callbacks');
const g = FakeAccount.fromParam('guest');
const res = await g.signIn({ method: 'github' });
ok(res.ok && g.state().kind === 'signed-in' && (await g.idToken()) === 'fake:fake-player', 'fake guest signs in as the test player');
const n = FakeAccount.fromParam('unconfigured');
const nr = await n.signIn({ method: 'github' });
ok(!n.available && n.unavailableReason === 'Sign-in is not set up in this build.' && !nr.ok && nr.code === 'unavailable', 'unconfigured: unavailable with its reason');
ok(FakeAccount.fromParam('bogus') === null, 'an unknown ?account value is no fake');
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd game && node tools/accountcheck.mjs`
Expected: `Could not resolve ".../src/account/claims.ts"` (or the first missing module), exit 1.

- [ ] **Step 3: Implement** `Account.ts`, `claims.ts`, `errors.ts`, `fakeAccount.ts` with the signatures and copy above. None of them imports `firebase/*`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd game && node tools/accountcheck.mjs && npx tsc --noEmit`
Expected: every line `ok`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add game/src/account game/tools/accountcheck.mjs
git commit -m "FEAT-273: the account interface (guest, signed in, maintainer role), its in-memory fake, and the claim and sign-in error rules"
```

---

### Task 3: The Firebase account and `createAccount`

**Files:**
- Create: `game/src/account/firebaseAccount.ts` (the logic, no SDK import)
- Create: `game/src/account/firebasePort.ts` (the only file that imports `firebase/auth`)
- Create: `game/src/account/createAccount.ts`
- Test: `game/tools/accountcheck.mjs`

**Interfaces:**
- Consumes: `firebaseApp()` (Task 1); everything in `Account.ts`, `playerFromUser`, `signInFailure`, `FakeAccount` (Task 2).
- Produces:

```ts
// firebaseAccount.ts
export interface PortUser { uid: string; displayName: string | null; providerIds: string[] }
export interface AuthPort {
  /** Firebase's onAuthStateChanged: the restored session or null, then every change */
  onUser(cb: (u: PortUser | null) => void): void;
  /** signInWithPopup(GithubAuthProvider); rejects with an Error carrying Firebase's `code` */
  signInGithub(): Promise<PortUser>;
  signOut(): Promise<void>;
  /** getIdTokenResult(user, refresh).claims */
  claims(u: PortUser, refresh: boolean): Promise<Record<string, unknown>>;
  /** getIdToken(user): Firebase refreshes an expired token itself */
  token(u: PortUser): Promise<string>;
}
export class FirebaseAccount implements AccountService { constructor(port: Promise<AuthPort>) }
// firebasePort.ts
export function firebaseAuthPort(): Promise<AuthPort>; // firebaseApp(), then getAuth(app); rejects when the app is null
// createAccount.ts
export function createAccount(o: { env: Record<string, unknown>; fake: string | null; hosted: boolean; headless: boolean; loadPort?: () => Promise<AuthPort> }): AccountService;
```

`FirebaseAccount` rules: `state()` is `pending` until the first `onUser`; a restored user gets `claims(u, false)`; `signIn` gets `claims(u, true)` (a claim set since the last token shows at once); a second `signIn` while one is pending returns the same promise (one popup); a failed sign-in leaves the state as it was and fires no change; a claims read that fails (offline restore) gives `playerFromUser(u, {})` (role player, fail closed); a port that rejects makes `available` false with reason `` `Sign-in could not start (${code ?? message}).` ``, state `guest`, one change. `createAccount` order: `fake` and not `hosted` and `FakeAccount.fromParam(fake)` non-null: that fake (an unknown value: `console.warn` and go on); `headless`: an unavailable fake with reason `Sign-in is off on a headless page.`; `readFirebaseConfig(env).config` null: `FakeAccount.fromParam('unconfigured')`, plus a `console.warn` naming `missing` when some but not all four are set; else `new FirebaseAccount((o.loadPort ?? (() => import('./firebasePort').then((m) => m.firebaseAuthPort())))())`. The dynamic import is what keeps `firebase/*` in its own chunk.

- [ ] **Step 1: Write the failing tests** with a stub `AuthPort` (counts calls, `onUser` callback held so the test fires it, `signInGithub` resolving a user or rejecting `Object.assign(new Error(code), { code })`).

```js
const drew = { uid: 'u-drew', displayName: 'Drew', providerIds: ['github.com'] };
// stubPort({ claims, claimsFail, fail }) -> { port, calls: { signIn: number, claims: boolean[] }, fire(u) }
// `fail` rejects the first signInGithub only (with { code: fail }); later calls resolve `drew`; token(u) is `tok-${u.uid}`
let s = stubPort({ claims: { role: 'maintainer', player: 1 } });
let a = new FirebaseAccount(Promise.resolve(s.port));
ok(a.state().kind === 'pending', 'pending until the first auth state');
s.fire(null); ok((await a.ready()).kind === 'guest', 'then guest');
s = stubPort({ claims: { role: 'maintainer', player: 1 } }); a = new FirebaseAccount(Promise.resolve(s.port)); s.fire(drew);
ok(isMaintainer(await a.ready()) && s.calls.claims[0] === false, 'a restored maintainer session is a maintainer');
s = stubPort({ claims: { role: 'maintainer', player: 1 } }); a = new FirebaseAccount(Promise.resolve(s.port)); s.fire(null); await a.ready();
const changes = []; a.onChange((x) => changes.push(x.kind));
const [r1, r2] = await Promise.all([a.signIn({ method: 'github' }), a.signIn({ method: 'github' })]);
ok(r1.ok && r2.ok && s.calls.signIn === 1, 'two signIn clicks open one popup');
ok(s.calls.claims.at(-1) === true && a.state().kind === 'signed-in' && changes.join() === 'signed-in', 'signIn refreshes claims, one change');
ok((await a.idToken()) === 'tok-u-drew', 'idToken is the port token when signed in');
await a.signOut(); ok(a.state().kind === 'guest' && (await a.idToken()) === null, 'signOut: guest, no token');
for (const [code, want] of [['auth/popup-closed-by-user', 'cancelled'], ['auth/popup-blocked', 'popup-blocked'], ['auth/account-exists-with-different-credential', 'email-in-use']]) {
  s = stubPort({ fail: code }); a = new FirebaseAccount(Promise.resolve(s.port)); s.fire(null); await a.ready();
  let fired = 0; a.onChange(() => fired++);
  const r = await a.signIn({ method: 'github' });
  ok(!r.ok && r.code === want && a.state().kind === 'guest' && fired === 0, `${code}: ${want}, still guest`);
}
s = stubPort({ fail: 'auth/popup-blocked' }); a = new FirebaseAccount(Promise.resolve(s.port)); s.fire(null); await a.ready();
await a.signIn({ method: 'github' }); ok((await a.signIn({ method: 'github' })).ok && s.calls.signIn === 2, 'popup blocked: button free again (a second try opens a popup)');
s = stubPort({ claimsFail: true }); a = new FirebaseAccount(Promise.resolve(s.port)); s.fire(drew);
ok((await a.ready()).player?.role === 'player', 'claims unreadable: role player');
a = new FirebaseAccount(Promise.reject(Object.assign(new Error('bad key'), { code: 'auth/invalid-api-key' })));
ok((await a.ready()).kind === 'guest' && !a.available && a.unavailableReason === 'Sign-in could not start (auth/invalid-api-key).', 'port fails to start: unavailable with the code, guest');

let loads = 0; const loadPort = () => { loads++; return Promise.resolve(stubPort({}).port); };
ok(!createAccount({ env: {}, fake: null, hosted: false, headless: false, loadPort }).available && loads === 0, 'no env: unavailable, no SDK load');
ok(!createAccount({ env: full, fake: null, hosted: false, headless: true, loadPort }).available && loads === 0, 'headless never starts Firebase');
ok(createAccount({ env: {}, fake: 'maintainer', hosted: true, headless: false, loadPort }).available === false, '?account= is ignored on a hosted build');
ok(isMaintainer(await createAccount({ env: {}, fake: 'maintainer', hosted: false, headless: false, loadPort }).ready()), '?account=maintainer gives the fake maintainer');
createAccount({ env: full, fake: null, hosted: false, headless: false, loadPort }); ok(loads === 1, 'full config: the port loads once');
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd game && node tools/accountcheck.mjs`
Expected: `Could not resolve ".../src/account/firebaseAccount.ts"`, exit 1.

- [ ] **Step 3: Implement** `FirebaseAccount`, `firebaseAuthPort` (`getAuth`, `onAuthStateChanged`, `signInWithPopup(auth, new GithubAuthProvider())`, `signOut`, `getIdTokenResult`, `getIdToken`; `PortUser` keeps the Firebase `User` in a private field the port reads back), and `createAccount` as specified. The check bundles `firebaseAccount.ts` and `createAccount.ts` with `loadPort` stubs, so it never imports the SDK.

- [ ] **Step 4: Run to verify they pass**

Run: `cd game && node tools/accountcheck.mjs && npx tsc --noEmit`
Expected: every line `ok`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add game/src/account game/tools/accountcheck.mjs
git commit -m "FEAT-273: the Firebase account behind a small auth port (one popup, claims refreshed on sign-in, fail closed) and createAccount"
```

---

### Task 4: The account line on the main menu

**Files:**
- Create: `game/src/ui/AccountLine.ts`
- Modify: `game/src/ui/MainMenu.ts` (`MainMenuOpts.account`, a `<div class="account">` first in `nav.corner`, mounted in the constructor, unmounted in `destroy`)
- Modify: `game/src/core/Game.ts` (create the account before the menu; pass it in)
- Modify: `game/src/core/params.ts` (`account: string | null`, `?account=`, null on a hosted build)
- Modify: `game/src/ui/theme.css` (`.corner .account`, using the existing tokens)
- Create: `game/tools/accountmenucheck.mjs` (browser check)
- Modify: `.github/workflows/checks.yml` (`BROWSER_CHECKS` gains `accountmenucheck`)
- Test: `game/tools/accountcheck.mjs` (the view table)

**Interfaces:**
- Consumes: `AccountService`, `AccountState`, `createAccount` (Tasks 2, 3).
- Produces: `interface AccountLineView { who: string; action: 'sign-in' | 'sign-out' | null; label: string; disabled: boolean; note: string }`; `accountLineView(state: AccountState, available: boolean, reason: string): AccountLineView` (pure); `mountAccountLine(host: HTMLElement, account: AccountService): () => void` (writes only `textContent`, never `innerHTML`, for anything from the account; the button is a plain `button.link` so MenuNav reaches it; while a sign-in runs the button is disabled and reads `Signing in...`; a failure's `message` goes in the note until the next press; returns the unsubscribe). `Params.account`. `MainMenuOpts.account: AccountService`. Game.ts: `const account = createAccount({ env: import.meta.env, fake: params.account, hosted: params.hosted, headless })`.

The views, exact copy (the separator is ` · `, as the menu's facts line):

| state | `who` | `action` / `label` | `disabled` | `note` |
|---|---|---|---|---|
| pending | `''` | `null` / `''` (the line is hidden) | false | `''` |
| guest, available | `Playing as guest` | `sign-in` / `Sign in with GitHub` | false | `''` |
| guest, unavailable | `Playing as guest` | `sign-in` / `Sign in with GitHub` | true | the reason |
| signed in | name, then ` · player N` when `playerNumber !== null`, then ` · maintainer` for the role | `sign-out` / `Sign out` | false | `''` |

- [ ] **Step 1: Write the failing tests.** In `accountcheck.mjs`:

```js
let v = accountLineView({ kind: 'guest' }, true, '');
ok(v.who === 'Playing as guest' && v.action === 'sign-in' && v.label === 'Sign in with GitHub' && !v.disabled, 'guest, sign-in set up: an enabled Sign in with GitHub');
v = accountLineView({ kind: 'guest' }, false, 'Sign-in is not set up in this build.');
ok(v.disabled && v.note === 'Sign-in is not set up in this build.', 'guest, not set up: disabled, the reason as the note');
ok(accountLineView({ kind: 'signed-in', player: FAKE_PLAYER }, true, '').who === 'Test <i>player</i> · player 0', 'player 0 reads "· player 0"');
ok(accountLineView({ kind: 'signed-in', player: { ...FAKE_PLAYER, playerNumber: null } }, true, '').who === 'Test <i>player</i>', 'no number: just the name');
ok(accountLineView({ kind: 'signed-in', player: FAKE_MAINTAINER }, true, '').who === 'Test maintainer · player 1 · maintainer', 'maintainer: "· maintainer"');
ok(accountLineView({ kind: 'pending' }, true, '').action === null, 'pending: hidden');
```

`game/tools/accountmenucheck.mjs` (static server and page setup as `menucheck.mjs`; run after `npx vite build` with no `.env.local` values, as CI; `node tools/accountmenucheck.mjs [pack] [--gpu | --headed | --cpu]`; each case loads `?pack=<pack>&lowgfx` plus its query and waits for `#menu .account` to be visible, never for the session; `text(sel)` is its `textContent`, `btn` its button, `click(label)` clicks the button with that text and waits for the line to change, `requests` every URL the page fetched, `distFiles()` every file under `dist/`):

```js
// no query (CI's unconfigured build)
check('unconfigured: guest line', text('#menu .account') .includes('Playing as guest'));
check('unconfigured: Sign in disabled with its reason', await btn.isDisabled() && text('#menu .account').includes('Sign-in is not set up in this build.'));
check('unconfigured: no Firebase chunk requested', !requests.some((u) => /firebasePort-/.test(u)));
// &account=maintainer
check('maintainer line', text('#menu .account').includes('Test maintainer · player 1 · maintainer'));
await click('Sign out'); check('Sign out: guest line', text('#menu .account').includes('Playing as guest'));
// &account=guest
await click('Sign in with GitHub');
check('player 0 reads', text('#menu .account').includes('· player 0'));
check('name is text', text('#menu .account').includes('<i>player</i>') && (await page.$('#menu .account i')) === null);
// the built bundle
check('no Admin SDK or key in dist', !distFiles().some((f) => /firebase-admin|-----BEGIN PRIVATE KEY-----|"type":\s*"service_account"/.test(read(f))));
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd game && node tools/accountcheck.mjs; npx vite build && node tools/accountmenucheck.mjs synth`
Expected: accountcheck: `Could not resolve ".../src/ui/AccountLine.ts"`; accountmenucheck: `FAIL unconfigured: guest line` (no `.account`), exit 1.

- [ ] **Step 3: Implement** `AccountLine.ts`, the `MainMenu` and `Game` wiring, `params.account` (values `guest | player | maintainer | unconfigured`, anything else passes through to `createAccount`, which warns), and the CSS. The menu paints as today: the line starts hidden (pending) and fills in on `onChange`, so no await is added before `menu.show()`. No account line on the first-run screen (`FirstRun.ts`) and none in pause.

- [ ] **Step 4: Run to verify they pass**

Run: `cd game && node tools/accountcheck.mjs && npx tsc --noEmit && npx vite build && node tools/accountmenucheck.mjs synth --cpu`
Expected: every line `ok`, exit 0. Note the accountmenucheck time under `--cpu`; if it is over 2 minutes, move it from `BROWSER_CHECKS` to the `BROWSER_LOCAL` comment and say so in the PR.

- [ ] **Step 5: Commit**

```bash
git add game/src/ui/AccountLine.ts game/src/ui/MainMenu.ts game/src/core/Game.ts game/src/core/params.ts game/src/ui/theme.css game/tools/accountcheck.mjs game/tools/accountmenucheck.mjs .github/workflows/checks.yml
git commit -m "FEAT-273: the main menu's account line: Playing as guest or Sign in with GitHub, the name and player number once signed in"
```

---

### Task 5: The dev server's token gate and `/api/account`

Merge `origin/main` first (BUG-110's `game/tools/same_origin.mjs` and the localhost-only dev server).

**Files:**
- Create: `game/tools/accounts/verifier.mjs`
- Create: `game/tools/accounts/gate.mjs`
- Create: `game/src/account/serverAccount.ts`
- Modify: `game/vite.config.ts` (an `accountRoutes()` plugin, `configureServer` only)
- Modify: `game/src/core/Game.ts` (`window.__account` when `import.meta.env.DEV`)
- Modify: `game/package.json`, `game/package-lock.json` (`npm install -D firebase-admin@^14.5.1`)
- Create: `game/tools/gatecheck.mjs` (Node check)
- Modify: `.github/workflows/checks.yml` (`PHYSICS_CHECKS` gains `gatecheck`)

**Interfaces:**
- Consumes: `refuseForeignOrigin(req, res): boolean` (BUG-110); `AccountService.idToken()` (Task 2).
- Produces (JSDoc-typed `.mjs`):
  - `verifier.mjs`: `KEY_PATH_DEFAULT = path.join(os.homedir(), '.snowboardanywhere', 'firebase-admin-key.json')`; `keyPath(env = process.env): string` (`SBA_FIREBASE_ADMIN_KEY` when set); `accountFromClaims(decoded: { uid: string; role?: unknown; player?: unknown }): VerifiedAccount` with `VerifiedAccount = { uid: string; role: 'maintainer' | 'player'; player: number | null }` (same rule as `playerFromUser`); `TokenVerifier = { configured: boolean; verify(token: string): Promise<VerifiedAccount> }` (verify rejects on any bad token); `firebaseVerifier(file = keyPath()): TokenVerifier` (`configured` is `fs.existsSync(file)`; the first `verify` does `await import('firebase-admin/app')` and `firebase-admin/auth`, `initializeApp({ credential: cert(<parsed file>) }, 'sba-dev-server')`, then `verifyIdToken(token, true)`); `fakeVerifier(tokens: Record<string, VerifiedAccount>): TokenVerifier`; `devVerifier(): TokenVerifier` (one memoized `firebaseVerifier()`; FEAT-246 uses this instance).
  - `gate.mjs`: `bearerToken(req): string | null`; `requireAccount(verifier, handler: (req, res, account: VerifiedAccount) => void, opts?: { role?: 'maintainer' }): (req, res, next) => void`; `accountRoute(verifier): (req, res, next) => void` (`GET /api/account` only, else `next()`; replies `{ uid, role, player }`). Order and replies, all JSON with `cache-control: no-store`: foreign `Origin` 403 (BUG-110's reply); no bearer token 401 `{"error":"sign in first"}`; `!verifier.configured` 503 `{"error":"accounts are not set up on this dev server"}` (the key path logged once to the server console, never sent); `verify` rejects 401 `{"error":"sign in again: the session was not accepted"}`; `opts.role` set and not matched 403 `{"error":"only a maintainer can do this"}`; else `handler(req, res, account)`.
  - `serverAccount.ts`: `serverAccount(account: AccountService, base = import.meta.env.BASE_URL): Promise<{ status: number; body: unknown }>` (GET `${base}api/account`, `Authorization: Bearer <token>` when there is one). `window.__account = { state: () => account.state(), server: () => serverAccount(account) }` in DEV only: Drew's setup check, and the fetch pattern FEAT-246 copies.

- [ ] **Step 1: Write the failing tests** in `game/tools/gatecheck.mjs` (Node: an `http` server on port 0 mounting `accountRoute(fakeVerifier(T))` and a maintainer-only test route `requireAccount(fakeVerifier(T), recordingHandler, { role: 'maintainer' })` at `/t/build`; `T = { 'tok-drew': { uid: 'u-drew', role: 'maintainer', player: 1 }, 'tok-p': { uid: 'u-p', role: 'player', player: null }, 'tok-m': { uid: 'u-m', role: 'maintainer', player: null } }`; `/u/build` the same route over `{ configured: false, verify: () => Promise.reject() }`; `get(path, token?, headers?)` fetches with `Authorization: Bearer <token>` when given, keeps the response in `last` and its JSON in `body`; `fetch` sends no `Origin` unless set; `handled` is the recording handler's accounts):

```js
ok((await get('/t/build')).status === 401 && body.error === 'sign in first', 'no Authorization header: 401 sign in first');
ok((await get('/t/build', 'tok-nope')).status === 401, 'an unknown token: 401');
ok((await get('/t/build', 'tok-p')).status === 403 && handled.length === 0, 'player token on a maintainer route: 403');
ok((await get('/t/build', 'tok-m')).status === 200 && handled.shift()?.player === null, 'a maintainer with no player number passes (a missing number is never a refusal)');
ok((await get('/t/build', 'tok-drew')).status === 200 && handled[0]?.uid === 'u-drew', 'maintainer token: handler runs with uid u-drew');
ok((await get('/t/build', 'tok-drew', { origin: 'https://example.com' })).status === 403 && handled.length === 1, 'foreign Origin with a maintainer token: 403, handler not run');
ok((await get('/u/build', 'tok-drew')).status === 503, 'verifier not configured: 503');
ok(JSON.stringify((await get('/api/account', 'tok-p')).body) === '{"uid":"u-p","role":"player","player":null}', '/api/account: uid, role, player');
ok(last.headers.get('cache-control') === 'no-store', 'replies are no-store');
ok(bearerToken({ headers: { authorization: 'bearer abc' } }) === 'abc' && bearerToken({ headers: { authorization: 'Basic abc' } }) === null && bearerToken({ headers: { authorization: 'Bearer ' } }) === null, 'bearerToken: Bearer only, not empty');
ok(accountFromClaims({ uid: 'x', role: 'maintainer', player: 0 }).player === 0 && accountFromClaims({ uid: 'x', role: 'admin' }).role === 'player' && accountFromClaims({ uid: 'x', player: '1' }).player === null, 'accountFromClaims: exact role, integer player');
ok(firebaseVerifier(path.join(tmp, 'missing.json')).configured === false, 'no key file: not configured');
ok(keyPath({ SBA_FIREBASE_ADMIN_KEY: 'D:\\k.json' }) === 'D:\\k.json' && keyPath({}) === KEY_PATH_DEFAULT, 'SBA_FIREBASE_ADMIN_KEY overrides the default key path');
// the launcher bundled as package.mjs bundles it (esbuild, platform node, cjs, node22, SBA_LAUNCHER defined), into a temp file
ok(!/firebase-admin|tools[\\/]accounts/.test(launcherBundle), 'the launcher bundle has no Admin SDK and no account routes');
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd game && node tools/gatecheck.mjs`
Expected: `Cannot find module '.../tools/accounts/gate.mjs'`, exit 1.

- [ ] **Step 3: Implement** `verifier.mjs`, `gate.mjs`, `serverAccount.ts`, the DEV hook, and in `vite.config.ts` `accountRoutes(): Plugin` with only `configureServer(server) { server.middlewares.use(accountRoute(devVerifier())); }` and a comment: dev server only, so `npm run host` and the launcher have no account routes; FEAT-246 mounts `/api/resorts/build` here through `requireAccount(devVerifier(), ..., { role: 'maintainer' })`. Install `firebase-admin` as a devDependency. `verifier.mjs` imports only `node:fs`, `node:os`, `node:path` statically.

- [ ] **Step 4: Run to verify they pass, then check the servers by hand**

Run: `cd game && node tools/gatecheck.mjs && npx tsc --noEmit`
Expected: every line `ok`, exit 0.
Run: `cd game && npx vite --port 5181 --strictPort` (background), then `curl -s -i http://localhost:5181/api/account`
Expected: `HTTP/1.1 401` and `{"error":"sign in first"}`; with `-H "Origin: https://example.com"`: 403. Stop the server.
Run: `cd game && npm run host -- --port 5182` (background), then `curl -s -o /dev/null -w "%{content_type}\n" http://localhost:5182/api/account`
Expected: `text/html` (the preview's page fallback, no account route). Stop it.

- [ ] **Step 5: Commit**

```bash
git add game/tools/accounts game/tools/gatecheck.mjs game/src/account/serverAccount.ts game/src/core/Game.ts game/vite.config.ts game/package.json game/package-lock.json .github/workflows/checks.yml
git commit -m "FEAT-273: the dev server verifies the session token with the Admin SDK (requireAccount, /api/account); fake verifier for the checks; nothing of it in the launcher"
```

---

### Task 6: The role script, the Firestore rules, release variables and the docs

**Files:**
- Create: `game/tools/set_role.mjs`
- Create: `game/firebase/firestore.rules`
- Modify: `.github/workflows/release.yml` (the `npm run package` step's `env:` gains the four `VITE_FIREBASE_*: ${{ vars.VITE_FIREBASE_* }}`)
- Modify: `README.md` (Play: one short paragraph), `docs/developer-guide.md` (Code layout: `src/account/`, `src/firebase/`, `tools/accounts/`; Test tools: `accountcheck`, `accountmenucheck`, `gatecheck`, `set_role.mjs`; Checks in CI lists; URL parameters: `account=`; a new section "Accounts (FEAT-273)")
- Test: `game/tools/gatecheck.mjs`

**Interfaces:**
- Consumes: `keyPath()` (Task 5).
- Produces: `node tools/set_role.mjs (--uid <uid> | --email <email>) [--role maintainer|player] [--player <n>] [--name <display name>]` and `node tools/set_role.mjs --check`. Exports (pure, tested): `parseRoleArgs(argv: string[]): { uid?: string; email?: string; role?: 'maintainer' | 'player'; player?: number; name?: string; check?: boolean } | { error: string }`; `claimsFor(existing: Record<string, unknown>, a: { role?: 'maintainer' | 'player'; player?: number }): Record<string, unknown>` (keeps unrelated claims; `maintainer` sets `role`, `player` deletes `role`; `player` sets `player`); `needsRevoke(existing: Record<string, unknown>, next: Record<string, unknown>): boolean` (true when `existing.role === 'maintainer'` and `next.role !== 'maintainer'`). The run (only when the file is the entry script): load the key from `keyPath()` (missing: exit 2 naming the path and `SBA_FIREBASE_ADMIN_KEY`); find the user; refuse `--player n` when another `players/*` document has `player == n` (exit 1 naming that uid; to move a number, rerun the script for that uid with another number first); rerunning for the same uid replaces its number; `setCustomUserClaims(uid, claimsFor(...))`; `players/<uid>` set with merge `{ player, displayName, role, updatedAt }` (`player` null when none, `displayName` from `--name` or the user's); `revokeRefreshTokens(uid)` when `needsRevoke`; print `uid <uid>: role <role>, player <n|none>. Sign out and back in to pick it up.` `--check` prints `key ok: project <projectId>` and one line per user whose claims have a `role`.
- `firestore.rules`: `rules_version = '2'`, everything denied (`match /{document=**} { allow read, write: if false; }`), a comment that the Admin SDK bypasses rules and that FEAT-205 opens `players/<uid>` reads when the game first reads it.

- [ ] **Step 1: Write the failing tests** (append to `gatecheck.mjs`)

```js
ok(JSON.stringify(parseRoleArgs(['--email', 'a@b.c', '--role', 'maintainer', '--player', '1'])) === JSON.stringify({ email: 'a@b.c', role: 'maintainer', player: 1 }), 'parseRoleArgs: email, role, player');
ok('error' in parseRoleArgs(['--uid', 'x', '--role', 'admin']), 'an unknown role is refused');
ok('error' in parseRoleArgs(['--role', 'maintainer']), 'no --uid or --email is refused');
ok(['-1', '1.5', 'one'].every((n) => 'error' in parseRoleArgs(['--uid', 'x', '--player', n])), 'a player number must be an integer 0 or more');
ok(parseRoleArgs(['--uid', 'x', '--player', '0']).player === 0, 'player 0 is allowed');
ok(JSON.stringify(claimsFor({ foo: 1 }, { role: 'maintainer', player: 1 })) === '{"foo":1,"role":"maintainer","player":1}', 'claimsFor keeps other claims');
ok(JSON.stringify(claimsFor({ role: 'maintainer', player: 1 }, { role: 'player' })) === '{"player":1}', 'demotion drops the role, keeps the number');
ok(needsRevoke({ role: 'maintainer' }, { player: 1 }) && !needsRevoke({}, { role: 'maintainer' }) && !needsRevoke({ role: 'maintainer' }, { role: 'maintainer' }), 'needsRevoke only on a demotion');
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd game && node tools/gatecheck.mjs`
Expected: `Cannot find module '.../tools/set_role.mjs'`, exit 1.

- [ ] **Step 3: Implement** `set_role.mjs`, `firestore.rules`, the `release.yml` env lines, and the docs. Developer guide "Accounts (FEAT-273)": the two sides and their interfaces, where each secret lives (the table from Global Constraints), `game/.env.local` per checkout (a worktree without it shows Sign in disabled), the repository variables for release builds, `set_role.mjs` usage, that sign-in works on `localhost` only, and Task 7's console settings in brief. README Play: signing in is optional and changes nothing about riding; Sign in with GitHub works on this PC (the launcher or `npm run dev`), not from another computer.

- [ ] **Step 4: Run to verify they pass**

Run: `cd game && node tools/gatecheck.mjs && node tools/accountcheck.mjs && npx tsc --noEmit && python ../tools/ci/repo_rules.py --base origin/main --head HEAD`
Expected: every check line `ok`, exit 0; repo rules pass (no em dashes).
Run: `cd game && node tools/set_role.mjs --check` with no key file present
Expected: exit 2, message naming `%USERPROFILE%\.snowboardanywhere\firebase-admin-key.json` and `SBA_FIREBASE_ADMIN_KEY`.

- [ ] **Step 5: Commit, push, open the PR**

```bash
git add game/tools/set_role.mjs game/firebase/firestore.rules game/tools/gatecheck.mjs .github/workflows/release.yml README.md docs/developer-guide.md
git commit -m "FEAT-273: set_role.mjs (the maintainer claim and players/<uid>, revoke on demotion), deny-all Firestore rules, release builds read the web config from repo variables, docs"
git push -u origin issue-600-accounts
gh pr create --title "FEAT-273: accounts with guest play and Sign in with GitHub (Firebase); the maintainer role for Build it" --body "Fixes #600 ..."
```

The PR body says the main menu changed (ask for `stills`), what ran locally (accountmenucheck on the GPU), and that the live check (Task 7) needs Drew's Firebase project.

---

### Task 7: Drew only: the Firebase project, the GitHub provider, the keys and the maintainer claim

Not code; nothing here goes in git. Each step ends with its check. Steps 9 to 12 are the card's Done-when as far as this card reaches (the `build-pack` lines follow with FEAT-246).

- [ ] **Step 1: Create the project.** https://console.firebase.google.com > Add project, name `SnowboardAnywhere` (Google Analytics off). Plan Spark (free) is enough: Auth, custom claims and Firestore all work on it.
Check: Project settings shows the project id (call it `<id>`).

- [ ] **Step 2: Register the web app and write `game/.env.local`.** Project settings > General > Your apps > Web, nickname `game`, Firebase Hosting unticked. Copy `apiKey`, `authDomain`, `projectId`, `appId` into `game/.env.local` (start from `game/.env.example`) in the main checkout, and in any worktree where sign-in is tested.
Check: `git status` lists no `.env.local`; `cd game && npx vite --port 5181 --strictPort` shows an enabled "Sign in with GitHub" on the main menu.

- [ ] **Step 3: GitHub provider with a GitHub OAuth App.** Firebase > Authentication > Get started > Sign-in method > GitHub: copy the callback URL it shows (`https://<id>.firebaseapp.com/__/auth/handler`). On GitHub: Settings > Developer settings > OAuth Apps > New OAuth App: name `SnowboardAnywhere`, homepage `https://github.com/drewkeriazes/SnowboardAnywhere`, callback URL the one copied. Generate a client secret; paste the client id and secret into Firebase's GitHub provider and Enable. The secret goes nowhere else (no file, no repo secret, no chat).
Check: Sign-in method lists GitHub Enabled and nothing else enabled (Anonymous stays off: a guest is not a Firebase user).

- [ ] **Step 4: One account per email address.** Authentication > Settings > "User account linking: Link accounts that use the same email". This is the one-account-per-email mode: a sign-in whose email matches an existing account is refused with `auth/account-exists-with-different-credential`, and the two are joined only by a deliberate link from a session already signed in to that account (FEAT-274). Do not choose the other option, "Create multiple accounts for each identity provider".
Check: "Link accounts that use the same email" is selected and saved.

- [ ] **Step 5: Authorized domains.** Authentication > Settings > Authorized domains: `localhost` (it covers the dev server and the launcher on any port) and `<id>.firebaseapp.com` stay; add nothing else (no LAN IPs: sign-in is for this PC); remove `<id>.web.app` (no Hosting).
Check: the list is exactly `localhost` and `<id>.firebaseapp.com`.

- [ ] **Step 6: Restrict the browser API key.** Google Cloud console for `<id>` > APIs and Services > Credentials > "Browser key (auto created by Firebase)": Application restrictions: Websites `http://localhost:*/*` (if the console refuses the port wildcard, add `http://localhost:5173/*` to `http://localhost:5192/*`, the launcher's range, and the dev ports used) and `https://<id>.firebaseapp.com/*`; API restrictions: Identity Toolkit API, Token Service API, Cloud Firestore API.
Check: `curl -s "https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=<apiKey>" -d "{}"` answers an error naming the referrer (`API_KEY_HTTP_REFERRER_BLOCKED`); after 5 minutes, sign-in still works on `http://localhost:5181`.

- [ ] **Step 7: Firestore, deny by default.** Build > Firestore Database > Create database, production mode, location `nam5` (permanent). Rules tab: paste `game/firebase/firestore.rules`, Publish. Do not create a Realtime Database or Storage.
Check: Rules Playground, `get /players/anyone` as an authenticated user: Denied.

- [ ] **Step 8: The service-account key, outside every checkout.** Project settings > Service accounts > Generate new private key. Save it as `%USERPROFILE%\.snowboardanywhere\firebase-admin-key.json` (or anywhere outside a repo, with `SBA_FIREBASE_ADMIN_KEY` set to its path); delete the copy in Downloads. Never in the launcher folder, a release, a repo secret or a checkout.
Check: `cd game && node tools/set_role.mjs --check` prints `key ok: project <id>`; `git status` is clean in the main checkout and in `wt600`.

- [ ] **Step 9: Sign in once as Drew.** On the dev server (`npx vite --port 5181 --strictPort`, main checkout), Sign in with GitHub.
Check: the line reads `<your name>` (no number yet); Authentication > Users shows one user, provider GitHub; DevTools console `await __account.server()` gives `{ status: 200, body: { uid: '<uid>', role: 'player', player: null } }`.

- [ ] **Step 10: Make Drew player 1, maintainer.** `cd game && node tools/set_role.mjs --email <your GitHub email> --role maintainer --player 1 --name Drew`.
Check: it prints `uid <uid>: role maintainer, player 1. ...`; Firestore shows `players/<uid>` `{ player: 1, displayName: 'Drew', role: 'maintainer' }`; Sign out, Sign in again: the line reads `Drew · player 1 · maintainer`; `await __account.server()` gives `role: 'maintainer', player: 1`.

- [ ] **Step 11: A non-maintainer and a guest.** Sign out; in a private window sign in with a second GitHub account (any account that is not Drew's).
Check: its line has no `· maintainer`; `await __account.server()` gives `role: 'player'`. Signed out (guest): `await __account.server()` gives `status: 401`. Signing in with a GitHub account whose email already has an account by another provider is refused with "That email already belongs to another account. Sign in the way you usually do." (testable once FEAT-274 adds a second provider).

- [ ] **Step 12: Release builds.** GitHub, SnowboardAnywhere > Settings > Secrets and variables > Actions > Variables: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID` (variables, not secrets: the values are public).
Check: the next Release's zip, unzipped and launched, shows an enabled "Sign in with GitHub" and signs in on `http://localhost:5173`.
