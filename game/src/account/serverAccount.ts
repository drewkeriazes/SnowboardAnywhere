// FEAT-273: who the dev server says this player is (GET api/account, tools/accounts/gate.mjs). The game sends its
// Firebase ID token as `Authorization: Bearer`; a guest sends none (the server answers 401). Drew's setup check
// (window.__account.server() in the dev build) and the fetch pattern FEAT-246's Build it copies.
import type { AccountService } from './Account';

export async function serverAccount(account: AccountService, base: string = import.meta.env.BASE_URL): Promise<{ status: number; body: unknown }> {
  const token = await account.idToken();
  const res = await fetch(`${base}api/account`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, cache: 'no-store' });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* not JSON (no account route on this server): the text as it came */ }
  return { status: res.status, body };
}
