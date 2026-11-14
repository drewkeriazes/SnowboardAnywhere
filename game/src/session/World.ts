import type * as THREE from 'three';
import type { GameContext } from '../core/GameContext';
import { Terrain } from '../terrain/Terrain';
import { Collider } from '../sim/Collider';
import { buildCourses } from '../sim/Courses';
import { Bridges } from '../world/Bridges';
import { Landmarks } from '../world/Landmarks';
import { Clouds } from '../world/Clouds';
import { Snow } from '../world/Snow';
import { Vegetation, setLod0Reach } from '../world/Vegetation';
import { Shrubs } from '../world/Shrubs';
import { TreeFade } from '../world/TreeFade';
import { Rocks } from '../world/Rocks';
import { LiftLines } from '../world/LiftLines';
import { Lifts } from '../world/Lifts';
import { RunsOverlay } from '../world/RunsOverlay';
import { Environment } from '../world/Sky';
import { RiderView } from '../world/RiderView';
import { TreeBrush } from '../world/TreeBrush';
import { Buildings } from '../world/Buildings';
import { Roads } from '../world/Roads';
import { Tracks } from '../world/Tracks';
import { Bootprints } from '../world/Bootprints';
import { Deform } from '../world/Deform';
import { Monsters } from '../world/Monster';
import { Puffs } from '../world/Puffs';
import { ParticleLight } from '../world/ParticleLight';
import { Eat } from '../world/Eat';
import { RiderChair } from '../world/RiderChair';
import { TrialWorld } from '../world/TrialWorld';

export type World = ReturnType<typeof buildWorld>;

/**
 * FEAT-160: everything a session draws, built into the scene in a fixed order (the order things are added
 * and colliders registered is kept from before the split), with every lit material on the cascaded shadows.
 */
export function buildWorld(ctx: GameContext) {
  const { params, renderer, scene, pack, settings } = ctx;
  const zr = pack.meta.zRange ?? [0, 3000];
  const env = new Environment(scene, renderer, pack.meta.sun.azimuth, pack.meta.sun.elevation, zr[0], (zr[0] + zr[1]) / 2);
  // names show up in the Three.js DevTools scene tree and in scene.getObjectByName()
  const add = (name: string, o: THREE.Object3D) => { o.name = name; scene.add(o); };
  const clouds = new Clouds();
  add('clouds', clouds.mesh);
  const snow = new Snow();
  add('snowfall', snow.points);
  const terrain = new Terrain(pack);
  if (params.debugHud && params.debug === 'moguls') terrain.setMogulDebug(true); // BUG-062
  add('terrain', terrain.group);
  const collider = new Collider();
  const veg = new Vegetation(pack, collider);
  const treeFade = new TreeFade();
  add('trees', veg.group);
  const shrubs = new Shrubs(pack, collider, veg.kit); // FEAT-159: willow, juniper, sagebrush, oak and young conifers, buried by the snowpack
  add('shrubs', shrubs.group);
  const rocks = new Rocks(pack, collider);
  add('rocks', rocks.group);
  const lifts = new Lifts(pack);
  add('lifts', lifts.group);
  const liftLines = new LiftLines(pack, lifts.all, collider); // FEAT-073
  /** FEAT-053: the top of the resort (m): the highest lift unloading point, else the pack's start, else the range's top */
  const resortTop = lifts.all.length ? Math.max(...lifts.all.map((l) => l.top[2])) : (zr[1] ?? 3000);
  liftLines.setEnabled(settings.liftLines);
  add('lift lines', liftLines.group);
  add('lift markers', lifts.markers);
  const runs = new RunsOverlay(pack);
  add('run lines', runs.group);
  const buildings = new Buildings(pack, collider);
  add('buildings', buildings.group);
  const roads = new Roads(pack, settings.roadsOnSnow);
  add('roads', roads.group);
  // BUG-088: props stand at their real heights, so they wait until the terrain under them is real
  rocks.ground = terrain; veg.ground = terrain; buildings.ground = terrain; lifts.ground = terrain;
  const landmarks = new Landmarks(pack, collider); // FEAT-132: hand-placed signs (the Back Bowls gateway)
  add('landmarks', landmarks.group);
  const bridges = new Bridges(pack, collider, params.bridgeguess); // BUG-022: OSM-tagged bridges and creek-bed dips; ?bridgeguess adds segment chords
  add('bridges', bridges.group);
  const tracks = new Tracks(pack);
  add('tracks', tracks.group);
  const bootprints = new Bootprints(pack);
  add('bootprints', bootprints.mesh);
  const riderChair = new RiderChair(lifts.material);
  add('rider chair', riderChair.group);
  // Outrun (FEAT-097 to FEAT-101): the monsters, their big prints, puffs, the eat sequence
  const puffs = new Puffs();
  const particleLight = new ParticleLight();
  add('puffs', puffs.points);
  const bigprints = new Bootprints(pack, 3.2);
  add('monster prints', bigprints.mesh);
  // FEAT-044: the tracks and prints near the rider stamped into a texture the terrain deforms from
  const deform = new Deform();
  deform.scene.add(tracks.stampGroup, bootprints.stampMesh, bigprints.stampMesh);
  deform.cullers.push((x, z, s) => bootprints.cullStamp(x, z, s), (x, z, s) => bigprints.cullStamp(x, z, s));
  const monsters = new Monsters(pack, collider, puffs, bigprints);
  add('monsters', monsters.group);
  const eat = new Eat(pack, puffs);
  add('eat sequence', eat.group);
  // time trials (off unless enabled in Settings > Gameplay, or a course picked in Mode for this session)
  const courses = buildCourses(pack);
  const trialWorld = new TrialWorld(pack, courses);
  add('time trials', trialWorld.group);
  const riderView = new RiderView();
  add('rider', riderView.group);
  add('rider spray', riderView.sprayObject);
  const treeBrush = new TreeBrush(veg, riderView.spray); // FEAT-217: snow off the boughs of a tree the rider brushes, through the spray ring
  // cascaded shadows: every lit material gets the CSM hook
  env.registerMaterial(terrain.material);
  for (const m of Object.values(veg.mat)) env.registerMaterial(m);
  for (const m of Object.values(shrubs.mat)) env.registerMaterial(m);
  env.registerMaterial(tracks.material); // BUG-021: tree and ridge shadows fall on the track like on the snow
  env.registerMaterial(rocks.material); env.registerMaterial(buildings.material); env.registerMaterial(roads.material); env.registerMaterial(lifts.material);
  for (const m of Object.values(riderView.mats)) env.registerMaterial(m);
  for (const m of Object.values(monsters.materials)) env.registerMaterial(m);
  for (const m of eat.materials) env.registerMaterial(m);
  for (const m of landmarks.materials) env.registerMaterial(m);
  veg.enableImpostors(renderer, !params.noimpostors, params.lowgfx ? 1024 : 2048); // FEAT-156: bakes the LOD2 / impostor atlases either way
  if (params.lod0 != null) setLod0Reach(params.lod0); // BUG-107
  if (!params.noclumps) veg.enableClumps(renderer, params.clumpfar ?? undefined); // FEAT-292: the far forest as clump impostors past the drawn trees
  terrain.setTreeShade(veg.shade); // FEAT-171: the drawn trees' shadows past the shadow map
  return {
    zr, env, clouds, snow, terrain, collider, veg, shrubs, treeFade, rocks, lifts, liftLines, resortTop, runs, buildings, roads, landmarks, bridges,
    tracks, bootprints, riderChair, puffs, particleLight, bigprints, deform, monsters, eat, courses, trialWorld, riderView, treeBrush,
  };
}
