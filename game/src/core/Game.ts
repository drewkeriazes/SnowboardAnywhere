import * as THREE from 'three';
import { Pack } from '../pack/Pack';
import { GameAudio } from '../audio/Audio';
import { availableResorts } from '../resorts';
import { landmarkStart } from '../world/Landmarks';
import { LENSES, type LensSetting } from '../world/Lens';
import { attractShot, loadAttractManifest, resortNumbers } from '../world/AttractShots';
import { MainMenu } from '../ui/MainMenu';
import { LoadingScreen } from '../ui/Loading';
import { applyUiScale, loadSettings } from '../ui/Settings';
import { startPadNav } from '../ui/PadNav';
import { createSession } from '../session/Session';
import type { Params } from './params';
import { Events } from './Events';

/**
 * FEAT-160: boot. Picks and loads the pack, applies the URL overrides to the saved settings, creates the
 * renderer and the main menu, paints the menu or the loading screen, then runs the session.
 */
export class Game {
  constructor(private readonly params: Params) {}

  /** Resolves when the player quits with no main menu to go back to (never, with one: Quit returns to it). */
  async start(): Promise<void> {
    const { params } = this;
    const { headless } = params;
    const status = document.getElementById('status')!;
    // no ?pack: last resort played if it is built, else the first built real resort, else the synthetic mountain
    const resorts = await availableResorts(import.meta.env.BASE_URL);
    let packSlug = params.pack;
    if (!packSlug) {
      let last = ''; try { last = localStorage.getItem('lastPack') ?? ''; } catch { /* ignore */ }
      packSlug = resorts.find((r) => r.slug === last)?.slug ?? resorts.find((r) => r.slug !== 'synth')?.slug ?? 'synth';
    }
    try { localStorage.setItem('lastPack', packSlug); } catch { /* ignore */ }
    status.textContent = `Loading ${packSlug}...`;
    const pack = await Pack.load(`${import.meta.env.BASE_URL}packs/${packSlug}`);
    document.title = `${pack.meta.name} - snowboard sim`;
    const audio = new GameAudio();
    const settings = loadSettings();
    if (params.rider) settings.discipline = params.rider;
    const lp = params.lens; if (lp && (lp === 'auto' || lp in LENSES)) settings.goggleLens = lp as LensSetting; // FEAT-130: ?lens=yellow for render checks
    if (params.stance) settings.stance = params.stance; // FEAT-139
    if (params.lowgfx) { settings.quality = 'low'; settings.shadows = false; settings.treeDensity = 0.3; settings.pixelRatio = 1; }
    applyUiScale(settings); // FEAT-128: UI scale and Reduce motion (Accessibility)
    // before the menu, so the first song comes from the saved source and playlist
    audio.source = settings.musicSource;
    audio.playlist = settings.playlist;
    status.textContent = '';
    if (!headless) startPadNav(); // FEAT-137: menus on a controller, and the DualSense extras if picked before

    // one renderer for the whole page; sessions build and tear down their scene
    const canvas = document.getElementById('c') as HTMLCanvasElement;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    // FEAT-128: the main menu is a state inside the session ("attract"). It shows at once over a still of its
    // backdrop shot while the session loads behind it, then the still crossfades into the live view. Quit to
    // main menu goes back to it without tearing the session down. An eye link (?cam=eye) opens straight at its view.
    const skipMenu = params.cam === 'eye';
    const shot = attractShot(pack, landmarkStart(pack.meta.slug) ?? pack.meta.start);
    const attractFiles = headless ? {} : await loadAttractManifest(import.meta.env.BASE_URL);
    const mine = attractFiles[pack.meta.slug] ?? {};
    const menu = headless ? null : new MainMenu({
      slug: pack.meta.slug, resortName: pack.meta.name, shot, numbers: resortNumbers(pack),
      still: mine.stills?.includes(shot.id) ? `${import.meta.env.BASE_URL}attract/${pack.meta.slug}/${shot.id}.jpg` : '', resorts, audio, settings, credits: () => audio.credits,
    });
    // BUG-063: whatever shows first (the menu over its still, or the loading screen) paints before the session's heavy setup
    let loading: LoadingScreen | null = null;
    if (headless) status.textContent = `Loading ${packSlug}...`;
    else if (menu && !skipMenu) { status.textContent = ''; menu.show(); await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))); }
    else { status.textContent = ''; loading = new LoadingScreen(pack.meta.name); await loading.painted(); }
    const scene = new THREE.Scene();
    const events = new Events();
    const session = createSession({ params, canvas, renderer, scene, pack, settings, audio, events }, { menu, attract: !!menu && !skipMenu, loading, attractFiles });
    await session.quit;
  }
}
