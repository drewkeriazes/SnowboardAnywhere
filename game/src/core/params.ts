/**
 * FEAT-160: every URL parameter the client reads at boot, parsed once into a typed object.
 * The table in docs/developer-guide.md (URL parameters) says what each one does.
 * The spawn point (?x= &y= &h=) is not here: it is live state the map and the menu rewrite, so `spawn.ts` reads it when a ride starts.
 */
export interface Params {
  /** ?pack=<slug>, '' for the last played (or first built) resort */
  pack: string;
  /** ?headless: test tools step the loop with window.__step instead of requestAnimationFrame */
  headless: boolean;
  /** FEAT-138: `npm run host` builds for other computers on the home network, FEAT-261 `npm run package` for the
   *  Windows launcher; dev-only tools stay off on both */
  hosted: boolean;
  /** ?debug, ?debug=moguls, ?debug=pad: the value, '' when bare, null when absent */
  debug: string | null;
  /** BUG-053: the extra HUD lines and tuning panels (?debug, not on a hosted build) */
  debugHud: boolean;
  /** ?rider=ski|board */
  rider: 'ski' | 'board' | null;
  /** FEAT-130 ?lens=<id>|auto (checked against the lens table where it is applied) */
  lens: string | null;
  /** FEAT-139 ?stance=regular|goofy */
  stance: 'regular' | 'goofy' | null;
  /** ?lowgfx: the low preset, no shadows, sparse trees (SwiftShader runs) */
  lowgfx: boolean;
  /** FEAT-177 ?menuframe: keep the live frame at the main menu's crossfade in window.__menuFrame (shoot_attract.mjs --compare) */
  menuframe: boolean;
  /** ?cam=eye|fp */
  cam: string | null;
  /** ?pitch= &fov= &eye= for ?cam=eye (DATA-008), null when absent or not a number */
  pitch: number | null;
  fov: number | null;
  eye: number | null;
  /** ?spot=<name>: the compare spot P saves into */
  spot: string;
  /** ?time=now|<hour>, null for the setting */
  time: 'now' | number | null;
  /** FEAT-078 ?weather=<cover> (parsed by Clouds.parseWeather) */
  weather: string | null;
  /** ?touch: force the touch controls */
  touch: boolean;
  bridgeguess: boolean;
  noimpostors: boolean;
  nodeform: boolean;
  valleyfog: boolean;
  csm: boolean;
  nocsm: boolean;
  nomoguls: boolean;
  /** FEAT-159: one snowpack depth everywhere (m) for burying the shrubs, instead of the season's */
  snowdepth: number | null;
}

export function parseParams(search: string, hosted = !!(import.meta.env.VITE_HOST_NAME || import.meta.env.VITE_HOSTED)): Params {
  const p = new URLSearchParams(search);
  const num = (k: string): number | null => { const v = Number(p.get(k)); return p.has(k) && Number.isFinite(v) ? v : null; };
  const rider = p.get('rider'), stance = p.get('stance'), time = p.get('time');
  const debug = p.get('debug');
  return {
    pack: p.get('pack') ?? '',
    headless: p.has('headless'),
    menuframe: p.has('menuframe'),
    hosted,
    debug,
    debugHud: debug !== null && !hosted,
    rider: rider === 'ski' || rider === 'board' ? rider : null,
    lens: p.get('lens') || null,
    stance: stance === 'regular' || stance === 'goofy' ? stance : null,
    lowgfx: p.has('lowgfx'),
    cam: p.get('cam'),
    pitch: num('pitch'),
    fov: num('fov'),
    eye: num('eye'),
    spot: p.get('spot') ?? '',
    time: time === 'now' ? 'now' : time && !Number.isNaN(Number(time)) ? Number(time) : null,
    weather: p.get('weather'),
    touch: p.has('touch'),
    bridgeguess: p.has('bridgeguess'),
    noimpostors: p.has('noimpostors'),
    nodeform: p.has('nodeform'),
    valleyfog: p.has('valleyfog'),
    csm: p.has('csm'),
    nocsm: p.has('nocsm'),
    nomoguls: p.has('nomoguls'),
    snowdepth: num('snowdepth'),
  };
}
