import { ROLE_MAINTAINER, type Player } from './Account';

/** Builds a Player from a Firebase user and its ID-token claims. Any role other than the exact
 *  maintainer string is a player; the number is the claim only when it is an integer >= 0. */
export function playerFromUser(user: { uid: string; displayName: string | null; providerIds: string[] }, claims: Record<string, unknown>): Player {
  const n = claims.player;
  const playerNumber = typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null;
  const name = (user.displayName ?? '').trim();
  return {
    uid: user.uid,
    playerNumber,
    displayName: name === '' ? 'Player' : name,
    role: claims.role === ROLE_MAINTAINER ? 'maintainer' : 'player',
    providers: user.providerIds,
  };
}
