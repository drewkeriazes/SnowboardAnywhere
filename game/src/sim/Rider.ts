import type { Pack } from '../pack/Pack';
import type { Collider } from './Collider';
import { Rng } from './Rng';
import { rockCover } from '../terrain/rockCover';
import { DEFAULT_SNOW_WORLD, newSnowState, snowAt, type SnowState, type SnowWorld } from './SnowConditions';
import type { Input, SurfaceInfo, Discipline, PressEnd, PressMode } from './rider/types';
import type { JumpMode } from './rider/tuning';
import { EDGE_FULL, LEAN_IN, SQUAT_IN, STAMINA, STEP, STOP_GAMMA, STRAP_SPEED, STRAP_TIME, UNSTRAP_SPEED, UNSTRAP_TIME } from './rider/tuning';
import { rideStep } from './rider/Ride';
import { edgeIn, inclineIn, leanIn } from './rider/EdgeModel';
import { pressStep } from './rider/Press';
import { airStep } from './rider/Jumps';
import { strapStep, walkStep } from './rider/OnFoot';
import { groundAt } from './rider/Collision';
export type { Input, SurfaceInfo, Discipline, PressEnd, PressMode } from './rider/types';
export { EDGE_FULL, PLANE_SPEED, PRESS_MIN_REPORT, PRESS_RANGE, STAMINA, STRAP_TIME, UNSTRAP_TIME } from './rider/tuning';
export { bootSink } from './rider/OnFoot';
export { trickName, spinName, switchName } from './rider/Tricks';

/**
 * Snowboard rider as a point mass with a board heading. Ground contact is a bilinear
 * heightfield lookup, so terrain collision is exact at the data resolution.
 *
 * Edge model (FEAT-127): steer rolls the board onto a real edge angle. The heading follows the
 * carved arc, R = Rsc cos(edge) from the sidecut, opened out at speed to the radius the rider's
 * lean can balance, plus a pivot at low speed. The snow holds lateral force up to a grip limit
 * that rises with the edge and falls off the groomers. Below the limit the velocity turns with
 * the board (a carve). Above it the board skids: the velocity lags the heading and energy is shed.
 *
 * Brake model (FEAT-065, after Komissarov's snow-cutting model of side-slipping and hockey
 * stops): holding brake swings the board yaw across the direction of travel to the angle of
 * attack gamma (about 84 degrees) while the edge angle Psi ramps up. The snow resists the board's
 * slide across its own edge with up to N tan(Psi), pushing at right angles to the board
 * (FEAT-133): the part of that push against the travel direction brakes, a = g cos(alpha) tan(Psi)
 * sin(gamma), and the part across it turns the rider toward the edge, so a partial swing is a
 * skidded turn. Steering while braking modulates both: into the edge squares the board up and
 * digs it in (a harder stop), away opens the swing and softens the edge (a drift down the fall
 * line). On a steep pitch a soft edge cannot hold the slope's pull across the board and the rider
 * side-slips. `heading` is the steering axis and follows the travel direction while the board is
 * swung; `boardYaw` is the board as drawn and as it marks the snow.
 */
export class Rider {
  x = 0; y = 0; z = 0; // position, local metres (z up)
  vx = 0; vy = 0; vz = 0;
  heading = 0; // radians, 0 = north (+y), increasing clockwise (toward +x)
  /** FEAT-139: riding switch (the other foot forward, the tail leading). `heading` stays the steering
   *  axis along the direction of travel and every physics value stays in its frame; the view draws
   *  the board and the body turned round (see toeSign). Snowboard only. */
  switch = false;
  /** FEAT-139: the rider's normal stance has the right foot forward (Settings > Rider > Stance) */
  goofy = false;
  onGround = true;
  airTime = 0;
  jumpCharge = 0;
  /** 0..1 how far into the deep squat (FEAT-111), eased over about 0.25 s */
  squat = 0;
  speed = 0;
  /** FEAT-127: the board's edge angle to the snow (rad), + = the heading's right-hand edge (the toe edge riding regular; see toeSign), rolled toward the steer at a limited rate */
  edge = 0;
  /** the edge as a share of EDGE_FULL (sound, poses, replays and ghosts) */
  get edgeAngle(): number { return this.edge / EDGE_FULL; }
  set edgeAngle(v: number) { this.edge = v * EDGE_FULL; }
  /** BUG-056: the edge angle the steer is rolling toward this step (rad, 0 off the snow), for the rider
   *  view's body lead: the rider knows where the turn is going before the board gets there */
  edgeTarget = 0;
  /** BUG-056: the lean the press input is easing toward (-1 .. 1, 0 off the snow), for the body lead */
  leanTarget = 0;
  /** radius of the turn the heading is following (m, Infinity going straight): speed over the heading rate, so it includes the steer yaw and any slip wash-out (BUG-053; was the arc the edge and lean balance), for the debug HUD and tools */
  turnRadius = Infinity;
  /** BUG-053: heading rate this step (rad/s, + clockwise) and the lateral acceleration the edge and lean
   *  balance (m/s^2), for the debug readout and tools */
  turnRate = 0;
  carveAcc = 0;
  // ---- FEAT-148 hard carve
  /** 0..1 how far into a hard carve (the squat key held while steering on the snow), eased */
  hardCarve = 0;
  /** how far short (g) the edge's hold falls of the turn the press asks for (0 = committed, it bites) */
  carveShort = 0;
  /** 0..1 the washout meter: a big shortfall at speed fills it, full the edge lets go */
  washout = 0;
  /** called when a hard carve washes out: -1 heelside (down on the butt), +1 toeside (onto the hip) */
  onWashout: ((side: number) => void) | null = null;
  /** FEAT-148: which way a crash throws the body sideways, + the heading's right-hand side (a washout falls to the inside of the turn), 0 none */
  crashSide = 0;
  /** FEAT-133: eased steer while braking, -1 away from the edge (open swing, soft edge) .. +1 into it (square, dug in) */
  brakeMod = 0;
  /** edge angle of the brake's snow cut (rad, 0 when not braking), for the board's roll on screen */
  brakePsi = 0;
  spin = 0; // extra yaw while airborne
  /** FEAT-110: pitch rotation in the air (rad, + = front flip, nose down) and its rate */
  flip = 0;
  flipRate = 0;
  /** FEAT-311: the W / S held from an ollie (-1) or nollie (+1) pop, still down: the rider is tucking (Jumps.ts airStep) */
  flipLatch = 0;
  /** FEAT-311: the pitch rate (rad/s) the ollie / nollie pop left, with the body open */
  popPitch = 0;
  /** FEAT-112: the board's lean, eased: -1 nose up (tail loaded) .. +1 tail up (nose loaded) */
  lean = 0;
  // ---- FEAT-140 press balance
  /** Settings > Game > Press balance (main sets it) */
  pressMode: PressMode = 'on';
  /** a press is being held and balanced (|lean| > 0.5 on the snow) */
  pressing = false;
  /** the balance needle, -1 .. 1 (a share of PRESS_RANGE), 0 = the sweet spot, + toward the heading's front end (W) */
  pressBalance = 0;
  /** the loaded end of the press being held: +1 the front (nose press), -1 the back (tail press) */
  pressDir = 0;
  /** seconds and metres the press has been held */
  pressT = 0; pressDist = 0;
  /** called when a press ends (how, which end, s, m, riding switch); one held under PRESS_MIN_REPORT is not reported */
  onPress: ((end: PressEnd, dir: number, t: number, dist: number, switchStance: boolean, from: string) => void) | null = null;
  /** the trick this press was landed into from ('' if none) */
  pressFrom = '';
  /** FEAT-085: skating now, the stroke phase (0..1, a push at 0), and a callback on each push for sound */
  skating = false;
  skatePhase = 0;
  onSkateStroke: (() => void) | null = null;
  /** FEAT-110: called on landing a flip ("Backflip", "Double front flip", "Rodeo 540"), clean or sketchy */
  onTrick: ((name: string) => void) | null = null;
  crashed = 0; // seconds remaining in a crash
  /** FEAT-140: which way the crash throws the body, +1 forward along the heading, -1 back, 0 either (a press slam falls over its loaded end) */
  crashFall = 0;
  surface: SurfaceInfo = { rock: 0, scree: 0, groomed: 0, canopy: 0, moguls: 0, shrub: 0 };
  /** FEAT-053: the snow here (groomed / powder / chop / ice / slush weights and the physics they set) */
  readonly snow: SnowState = newSnowState();
  /** FEAT-053: the day's conditions (main.ts sets the hour, weather, new snow and the setting) */
  readonly snowWorld: SnowWorld = { ...DEFAULT_SNOW_WORLD };
  /** FEAT-053: 0..1 how hard the chop is rattling the board right now (smoothed, for the camera and the view) */
  chop = 0;
  /** FEAT-053: 0..1 the nose sinking into slow powder (for the drag; the view may tip the board) */
  noseSink = 0;
  normal: [number, number, number] = [0, 0, 1];
  slopeDeg = 0;
  skid = 0; // 0..1 how much the board is sliding sideways (for spray)
  /** board yaw (same convention as heading): the heading, swung across the travel direction while braking */
  boardYaw = 0;
  /** 0..1 progress of the brake swing */
  brakeAmt = 0;
  /** brake stance: -1 heelside, +1 toeside, 0 not braking */
  brakeSide = 0;
  /** braking deceleration from the snow cut this step (m/s^2) */
  brakeAcc = 0;
  /** 0..1 braking power (deceleration times speed), smoothed, for spray, sound and the track */
  scrape = 0;
  /** signed angle from the travel direction to the board (radians, 0 when nearly stopped) */
  slip = 0;
  // ---- on foot (FEAT-067)
  /** off the board, walking (the board is carried) */
  onFoot = false;
  /** binding transition in progress: 'off' unstrapping, 'on' strapping in */
  strapState: 'none' | 'off' | 'on' = 'none';
  /** seconds into the current transition */
  strapT = 0;
  /** seconds of sprint left */
  stamina = STAMINA;
  /** ran out of sprint: a run until stamina comes back to STAMINA_RESUME */
  tired = false;
  /** sprinting this step */
  sprinting = false;
  /** 0..1 how hard the rider is working (sprint, climbing), smoothed, for breathing */
  exertion = 0;
  /** boot sink at the current spot (m) */
  sink = 0;
  /** sliding back down a slope too steep to stand on (m/s, pack x/y) */
  slideVx = 0; slideVy = 0;
  /** BUG-045: climbing onto a ledge (mantle): progress 0..1 (0 = not climbing) and its start and end */
  mantle = 0;
  /** scrambling up on all fours (too steep to walk, not too steep to climb) */
  crawling = false;
  /** body-scale slope along the way you are walking (degrees, + = uphill) */
  walkSlopeDeg = 0;
  /** seconds left of a slip back down a face too steep to climb (no walking until it ends) */
  slipT = 0;
  /** lateral acceleration in g, positive toward the board's right-hand side (smoothed, for the rider's lean) */
  lateralG = 0;
  landingShock = 0;
  /** last collision this step: 'ramp' | 'graze' | 'wall' | '' (for sound and effects; cleared each frame) */
  lastHit = '';
  /** FEAT-217: the speed into the trunk, rock or wall of that collision (m/s; cleared with lastHit) */
  hitSpeed = 0;
  /** Outrun boost (FEAT-101): less drag for a few seconds */
  boost = false;
  distance = 0;
  maxSpeed = 0;
  discipline: Discipline = 'board';
  /** FEAT-134: how hard the fall line works on the board: 1 realistic, 0.5 assisted, 0 off (Settings > Rider) */
  fallLine = 1;
  /** FEAT-311 / BUG-055: how high a pop off flat snow goes, Real (lifelike) or Arcade (big air) (Settings > Feel) */
  jumpMode: JumpMode = 'real';
  /** the edge catch's chance per second this step (FEAT-134; ?debug shows it) */
  catchRisk = 0;
  /** sim randomness: seeded on reset so the same inputs replay the same run */
  readonly rng = new Rng(1);
  /** physics steps so far, and how many of them sampled a coarser height set than the point has */
  steps = 0;
  coarseSteps = 0;
  // ---- internal: state the sim/rider/ modules keep between steps. Not part of the API (nothing
  // outside sim/ reads it); public only because TypeScript has no module-private members.
  /** the terrain and the colliders the rider rides on */
  readonly pack: Pack;
  readonly collider: Collider | null;
  /** FEAT-111 (Jumps.ts): s since the squat was let go from deep; a jump right then pops higher */
  squatUp = 9;
  /** FEAT-148 (EdgeModel.ts): 0..1 how far the press has driven the turn in on the current edge */
  hardDrive = 0;
  /** FEAT-053 (EdgeModel.ts): s to the next chop jolt */
  chopT = 0;
  /** Brake.ts: the direction of travel the brake swings the board across (the heading while stopped) */
  travelYaw = 0;
  /** Brake.ts: board angle to travel this brake aims for, fixed when the brake starts (0 = ski snowplough) */
  brakeGamma = STOP_GAMMA;
  /** FEAT-140 (Tricks.ts, Press.ts): the last trick landed and the step it landed on */
  landTrick = ''; landStep = -1e9;
  /** FEAT-140 (Press.ts): lost it: the lean stays flat until the press key (this sign) is let go */
  pressLock = 0;
  /** FEAT-140 (Press.ts): the drift's direction, the random push (next, left, rate), the bump jitter
   *  (value, target, next), the bump measure, the last vertical speed and the eased weight shift */
  pbDrift = 1; pbPushT = 0; pbPushLeft = 0; pbPushV = 0;
  pbNoise = 0; pbNoiseTo = 0; pbNoiseT = 0; pbBump = 0; pbVz = 0; pbCorr = 0;
  /** FEAT-067 (OnFoot.ts): the walk velocity (m/s, pack x/y) and the jump key on the last step (a hop is its press) */
  walkVx = 0; walkVy = 0;
  hopHeld = false;
  /** BUG-045 (OnFoot.ts, Collision.ts): the mantle's or step-up's start and end (pack x, y, z) */
  readonly mantleFrom = [0, 0, 0]; readonly mantleTo = [0, 0, 0];
  /** BUG-045: stepping up onto a low ledge: progress 0..1 (0 = not stepping), from mantleFrom to mantleTo */
  stepT = 0;
  // ---- private to Rider.ts
  private accum = 0;
  private readonly maskTmp = [0, 0, 0, 0];
  private readonly coverTmp = { rock: 0, scree: 0 };
  // render interpolation: pose before the last step, pose after it (to spot external moves), and
  // the sim pose stashed while the interpolated one is applied
  private readonly prev = [0, 0, 0, 0, 0];
  private readonly end = [NaN, NaN, NaN, NaN];
  private readonly stash = [0, 0, 0, 0, 0];
  private alpha = 1;
  private posed = false;
  private lastWarn = -Infinity;

  constructor(pack: Pack, collider: Collider | null) {
    this.pack = pack;
    this.collider = collider;
  }

  /** FEAT-139: which side of the heading the toe edge is on: +1 the right (regular, or goofy riding
   *  switch), -1 the left (goofy, or regular riding switch; the board and body are drawn turned round) */
  get toeSign(): number { return this.discipline === 'board' && this.switch !== this.goofy ? -1 : 1; }

  /**
   * FEAT-139: turn the steering axis round to the direction of travel and toggle the stance, so the
   * rider as drawn (the board at heading + PI while switch) does not move. The edge, the lean and the
   * lateral g keep their side of the board, which is the other side of the new heading.
   */
  turnRound(): void {
    this.heading += Math.PI; this.boardYaw += Math.PI; // the board was already posed this step
    this.edge = -this.edge; this.edgeTarget = -this.edgeTarget;
    this.lateralG = -this.lateralG; this.lean = -this.lean; this.crashSide = -this.crashSide;
    this.pressBalance = -this.pressBalance; this.pressDir = -this.pressDir; this.pbDrift = -this.pbDrift; this.pressLock = -this.pressLock; // FEAT-140
    if (this.discipline === 'board') this.switch = !this.switch;
  }

  reset(x: number, y: number, heading: number, seed = 1): void {
    this.x = x; this.y = y; this.z = this.pack.groundHeight(x, y) + 0.5;
    this.vx = this.vy = this.vz = 0;
    this.heading = heading; this.switch = false; this.onGround = true; this.airTime = 0; this.jumpCharge = 0;
    this.crashed = 0; this.crashFall = 0; this.spin = 0; this.skid = 0; this.distance = 0; this.maxSpeed = 0;
    this.edge = 0; this.edgeTarget = 0; this.leanTarget = 0; this.lean = 0; this.pressing = false; this.pressBalance = 0; this.pressDir = 0; this.pressLock = 0; this.turnRadius = Infinity; this.turnRate = 0; this.carveAcc = 0; this.lateralG = 0; this.landingShock = 0;
    this.hardCarve = 0; this.hardDrive = 0; this.carveShort = 0; this.washout = 0; this.crashSide = 0; this.catchRisk = 0;
    this.accum = 0; this.alpha = 1; this.steps = 0; this.coarseSteps = 0;
    this.onFoot = false; this.strapState = 'none'; this.strapT = 0; this.stamina = STAMINA; this.tired = false; this.mantle = 0; this.stepT = 0;
    this.sprinting = false; this.crawling = false; this.slipT = 0; this.exertion = 0; this.slideVx = this.slideVy = this.walkVx = this.walkVy = 0;
    this.chop = 0; this.noseSink = 0; this.chopT = 0;
    this.rng.seed(seed);
    this.squareBoard();
    this.snapPose();
  }

  /**
   * 0 = strapped in and riding, 1 = on foot carrying the board; in between during the unstrap and
   * strap-in transitions (the view runs its crouch, step-off and lift animation off this).
   */
  get footU(): number {
    if (this.strapState === 'off') return Math.min(1, this.strapT / UNSTRAP_TIME);
    if (this.strapState === 'on') return Math.max(0, 1 - this.strapT / STRAP_TIME);
    return this.onFoot ? 1 : 0;
  }
  /** off the board or getting on or off it: no board physics, tracks or spray */
  get unstrapped(): boolean { return this.onFoot || this.strapState !== 'none'; }
  /** nearly stopped on the snow, so E (interact) unstraps */
  get canUnstrap(): boolean { return !this.onFoot && this.strapState === 'none' && this.onGround && this.crashed <= 0 && this.speed < UNSTRAP_SPEED; }
  /** standing still on foot, so B straps in */
  get canStrapIn(): boolean { return this.onFoot && this.strapState === 'none' && this.onGround && this.speed < STRAP_SPEED; }

  /** The board key: unstrap or strap in. Returns '' when it started, else why not ('fast', 'moving', 'air', 'busy'). */
  toggleBoard(): string {
    if (this.strapState !== 'none') return 'busy';
    if (!this.onGround) return 'air';
    if (!this.onFoot) {
      if (!this.canUnstrap) return 'fast';
      this.strapState = 'off'; this.strapT = 0;
      // FEAT-139: on foot the body is drawn along the heading, so a rider drawn turned round (switch,
      // or goofy) takes the heading the way they face; nearly stopped, so nothing else moves
      if (this.toeSign < 0) this.heading += Math.PI;
      this.switch = false;
      return '';
    }
    if (!this.canStrapIn) return 'moving';
    this.strapState = 'on'; this.strapT = 0;
    this.vx = this.vy = this.walkVx = this.walkVy = this.slideVx = this.slideVy = 0;
    return '';
  }

  /** Back on the board at once (boarding a lift on foot). */
  strapInNow(): void {
    if (!this.unstrapped) return;
    this.onFoot = false; this.strapState = 'none'; this.strapT = 0;
    this.walkVx = this.walkVy = this.slideVx = this.slideVy = 0;
    this.squareBoard();
  }

  /** End any brake swing: the board lines up with the heading again (internal: the rider modules call it). */
  squareBoard(): void {
    this.boardYaw = this.travelYaw = this.heading;
    this.brakeAmt = 0; this.brakeSide = 0; this.brakeAcc = 0; this.brakePsi = 0; this.brakeMod = 0; this.scrape = 0; this.slip = 0;
  }

  /**
   * Advance the sim by real time dt in fixed 1/120 s steps. Catch-up is capped at 0.1 s per call
   * (12 steps), so a tab switch or a long hitch drops time instead of fast-forwarding the run.
   */
  update(dt: number, input: Input): void {
    // moved from outside since the last step (lift, reset, teleport): nothing to interpolate from
    if (this.x !== this.end[0] || this.y !== this.end[1] || this.z !== this.end[2] || this.heading !== this.end[3]) { this.squareBoard(); this.snapPose(); }
    this.accum += Math.min(dt, 0.1);
    while (this.accum >= STEP) {
      this.prev[0] = this.x; this.prev[1] = this.y; this.prev[2] = this.z; this.prev[3] = this.heading; this.prev[4] = this.boardYaw;
      const fb = this.pack.coarseFallbacks;
      // FEAT-124: the squat key grabs in the air and sprints on foot, so it only squats riding on the snow
      this.easeSquat(STEP, !!input.squat && this.onGround && !this.onFoot);
      // FEAT-140: a lost press keeps the board flat until the press key is let go. In the air a press
      // key held (not the lean a jump charge's W / S sets) sets the board up to land into the press.
      const want = input.lean ?? 0;
      if (this.pressLock && Math.sign(want) !== this.pressLock) this.pressLock = 0;
      this.leanTarget = (this.onGround || !input.jumpHeld) && !this.pressLock ? want : 0;
      this.lean += (this.leanTarget - this.lean) * Math.min(1, STEP / LEAN_IN); // snaps back level in the air
      pressStep(this, STEP, input);
      this.step(STEP, input);
      this.steps++;
      if (this.pack.coarseFallbacks !== fb) this.onCoarse();
      this.accum -= STEP;
      input.jumpReleased = false; // consume the release edge
    }
    this.end[0] = this.x; this.end[1] = this.y; this.end[2] = this.z; this.end[3] = this.heading;
    this.alpha = this.accum / STEP;
  }

  /** FEAT-111: blend into or out of the squat, and time how long ago a deep squat was released */
  private easeSquat(dt: number, held: boolean): void {
    const was = this.squat;
    this.squat = held ? Math.min(1, was + dt / SQUAT_IN) : Math.max(0, was - dt / SQUAT_IN);
    if (!held && was >= 0.6 && this.squatUp > 1) this.squatUp = 0; // let go from deep: the spring window opens
    else this.squatUp += dt;
  }

  private snapPose(): void {
    this.prev[0] = this.end[0] = this.x; this.prev[1] = this.end[1] = this.y;
    this.prev[2] = this.end[2] = this.z; this.prev[3] = this.end[3] = this.heading; this.prev[4] = this.boardYaw;
  }

  private onCoarse(): void {
    this.coarseSteps++;
    const now = performance.now();
    if (now - this.lastWarn < 2000) return;
    this.lastWarn = now;
    console.warn(`physics: 1 m terrain not loaded at ${this.x.toFixed(0)}, ${this.y.toFixed(0)}; riding on a coarser set (${this.coarseSteps}/${this.steps} steps so far)`);
  }

  /**
   * Swap in the pose interpolated between the last two physics steps for drawing (call
   * restoreSimPose after). Without it the rider judders when the frame rate does not divide
   * 120 Hz evenly. Big heading jumps (fakie flip, landing snap) are not blended.
   */
  applyRenderPose(): void {
    if (this.posed) return;
    this.posed = true;
    const s = this.stash, p = this.prev, a = this.alpha;
    s[0] = this.x; s[1] = this.y; s[2] = this.z; s[3] = this.heading; s[4] = this.boardYaw;
    if (this.x !== this.end[0] || this.y !== this.end[1] || this.z !== this.end[2] || this.heading !== this.end[3]) return; // moved outside the sim
    this.x = p[0] + (s[0] - p[0]) * a; this.y = p[1] + (s[1] - p[1]) * a; this.z = p[2] + (s[2] - p[2]) * a;
    const dh = s[3] - p[3];
    if (Math.abs(dh) < 1) this.heading = p[3] + dh * a;
    const db = s[4] - p[4];
    if (Math.abs(db) < 1) this.boardYaw = p[4] + db * a;
  }

  restoreSimPose(): void {
    if (!this.posed) return;
    this.posed = false;
    const s = this.stash;
    this.x = s[0]; this.y = s[1]; this.z = s[2]; this.heading = s[3]; this.boardYaw = s[4];
  }

  private step(dt: number, input: Input): void {
    const pack = this.pack;
    const n = pack.groundNormal(this.x, this.y, this.normal, this.z) as [number, number, number];
    const ground = groundAt(this, this.x, this.y, this.z);
    this.slopeDeg = Math.acos(Math.min(1, n[2])) * 57.2958;
    if (pack.mask) {
      const m = pack.mask.sample(this.x, this.y, this.maskTmp);
      // BUG-043: rock and scree as the terrain shader draws them (crisp patches), not the soft mask
      const cov = rockCover(m[0], m[1], this.x, this.z, -this.y, n[2], this.coverTmp);
      this.surface.rock = cov.rock; this.surface.scree = cov.scree; this.surface.groomed = m[2]; this.surface.canopy = m[3];
    }
    this.surface.moguls = pack.mogulAmp?.(this.x, this.y) ?? 0; // FEAT-059 (test planes may lack the method)
    this.surface.shrub = this.collider?.brushAt?.(this.x, this.y, this.z, 0.35) ?? 0; // FEAT-159
    snowAt(this.surface, n, this.z, this.snowWorld, this.snow); // FEAT-053
    this.chop *= Math.exp(-dt * 6);
    if (this.strapState !== 'none') { strapStep(this, dt, ground); return; }
    if (this.onFoot) { walkStep(this, dt, input, n, ground); return; }
    if (this.crashed > 0) {
      this.crashed -= dt;
      if (this.crashed <= 0) { this.crashFall = 0; this.crashSide = 0; }
      this.hardCarve = this.hardDrive = this.carveShort = this.washout = 0;
      // tumble: slide to a stop
      const f = Math.exp(-dt * 2.5);
      this.vx *= f; this.vy *= f;
      this.x += this.vx * dt; this.y += this.vy * dt;
      this.z = groundAt(this, this.x, this.y, this.z);
      this.vz = 0;
      this.speed = Math.hypot(this.vx, this.vy);
      this.squareBoard();
      return;
    }
    // ---------------------------------------------------------------- airborne (rider/Jumps.ts), else on the snow (rider/Ride.ts)
    if (!this.onGround) { airStep(this, dt, input); return; }
    rideStep(this, dt, input, n, ground);
  }

  /** On foot and sliding down the snow (a slip): the boots skid instead of stepping. */
  get slipping(): boolean { return this.onFoot && this.onGround && (this.slipT > 0 || this.slideSpeed > 0.6); }

  /** Sliding speed (m/s) when slipping down a slope too steep to climb. */
  get slideSpeed(): number { return Math.hypot(this.slideVx, this.slideVy); }

  /** BUG-056: where the edge will be `lead` seconds from now if the steer holds (visual only; rider/EdgeModel.ts) */
  predictEdge(lead: number): number { return edgeIn(this, lead); }

  /** BUG-056: the inclination (rad, + toward the toe edge) that balances the edge `lead` seconds from now (visual only) */
  predictIncline(lead: number): number { return inclineIn(this, lead); }

  /** BUG-056: where the press lean will be `lead` seconds from now if the input holds (visual only) */
  predictLean(lead: number): number { return leanIn(this, lead); }
}
