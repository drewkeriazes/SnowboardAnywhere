import type { Rider } from '../sim/Rider';
import { STAMINA } from '../sim/Rider';
import type { RunStats } from '../sim/RunStats';
import { snowLabel } from '../sim/SnowConditions';
import { fmtSpeed, fmtHeight, fmtDistance } from './Units';
import { conditionsText } from './Conditions';

export interface HudState {
  rider: Rider;
  runStats: RunStats;
  metric: boolean;
  fps: number;
  /** terrain chunks and triangles, tree instances, camera mode */
  chunks: number;
  triangles: number;
  trees: number;
  camMode: string;
  /** BUG-053 ?debug: the edge model's numbers */
  debug: boolean;
}

/** The top-left HUD: speed, height, slope, the snow, the run so far, the frame rate; with ?debug the edge model and snow numbers. */
export function hudLine(s: HudState): string {
  const { rider, runStats, metric } = s;
  const speedStr = (ms: number) => metric ? `${(ms * 3.6).toFixed(0)}</b> km/h` : `${(ms * 2.23694).toFixed(0)}</b> mph`;
  const altStr = (m: number) => fmtHeight(m, metric);
  return `<b>${speedStr(rider.speed)} &nbsp; ${altStr(rider.z)} &nbsp; slope ${rider.slopeDeg.toFixed(0)}&deg;` +
    // FEAT-053: what the snow is here; on foot, how deep the boots sink in it
    (rider.onFoot ? ` &nbsp; <span class="dim">snow</span> ${snowLabel(rider.snow.kind).toLowerCase()} &middot; <span class="dim">sink</span> ${metric ? (rider.sink * 100).toFixed(0) + ' cm' : (rider.sink * 39.37).toFixed(0) + ' in'}` : rider.onGround && !rider.unstrapped ? ` &nbsp; <span class="dim">${conditionsText(rider, metric)}</span>` : '') + // FEAT-221: the snow and what it is doing to you
    (rider.onFoot ? ` &nbsp; ${rider.crawling ? 'SCRAMBLING' : 'ON FOOT'} &nbsp; <span class="dim">sprint</span> ${'&#9646;'.repeat(Math.ceil(rider.stamina / STAMINA * 5))}${'&#9647;'.repeat(5 - Math.ceil(rider.stamina / STAMINA * 5))}` : '') +
    (rider.switch && !rider.unstrapped ? ' &nbsp; SWITCH' : '') + // FEAT-139
    (rider.onGround || rider.onFoot ? '' : ` &nbsp; AIR ${rider.airTime.toFixed(1)}s`) + (rider.crashed > 0 ? ' &nbsp; CRASH' : '') +
    // FEAT-055: the run so far
    (runStats.active ? `</b><br><span class="dim">${runStats.current ? runStats.current + ' &middot; ' : ''}top ${fmtSpeed(runStats.topSpeed, metric)} &middot; ${altStr(runStats.vertical)} vert &middot; ${fmtDistance(runStats.distance, metric)}</span><b>` : '') +
    `<br><span class="dim">${s.fps.toFixed(0)} fps &middot; ${s.chunks} chunks &middot; ${(s.triangles / 1000).toFixed(0)}k tris &middot; trees ${s.trees} &middot; cam ${s.camMode}` +
    ` &middot; pos ${rider.x.toFixed(0)}, ${rider.y.toFixed(0)}</span>` +
    // BUG-053 ?debug: the edge model's numbers for tuning (edge angle, the lateral acceleration it balances, turn radius and rate, the brake's cut and swing)
    (s.debug ? `<br><span class="dim">edge ${(rider.edge * 180 / Math.PI).toFixed(0)}&deg; &middot; aLat ${rider.carveAcc.toFixed(1)} m/s&sup2; (${rider.lateralG.toFixed(2)} g) &middot; R ${Number.isFinite(rider.turnRadius) ? rider.turnRadius.toFixed(0) + ' m' : '&infin;'} &middot; ${(rider.turnRate * 180 / Math.PI).toFixed(0)}&deg;/s` +
      (rider.hardCarve > 0 ? ` &middot; hard ${rider.hardCarve.toFixed(2)} short ${rider.carveShort.toFixed(2)} g wash ${rider.washout.toFixed(2)}` : '') + // FEAT-148
      // FEAT-134: the heading's angle off the fall line, the slope, and the edge catch's chance per second
      ` &middot; fall ${(Math.abs(Math.atan2(Math.sin(Math.atan2(rider.normal[0], rider.normal[1]) - rider.heading), Math.cos(Math.atan2(rider.normal[0], rider.normal[1]) - rider.heading))) * 180 / Math.PI).toFixed(0)}&deg; of ${rider.slopeDeg.toFixed(0)}&deg; &middot; catch ${rider.catchRisk.toFixed(1)}/s` +
      (rider.brakeAmt > 0 ? ` &middot; brake &Psi; ${(rider.brakePsi * 180 / Math.PI).toFixed(0)}&deg; &gamma; ${(Math.abs(rider.slip) * 180 / Math.PI).toFixed(0)}&deg; ${rider.brakeAcc.toFixed(1)} m/s&sup2; mod ${rider.brakeMod.toFixed(2)}` : '') +
      // FEAT-053: the snow weights and what they set
      `<br>snow groomed ${rider.snow.groomed.toFixed(2)} powder ${rider.snow.powder.toFixed(2)} chop ${rider.snow.chop.toFixed(2)} ice ${rider.snow.ice.toFixed(2)} slush ${rider.snow.slush.toFixed(2)} rock ${rider.snow.rock.toFixed(2)} &middot; depth ${(rider.snow.depth * 100).toFixed(0)} cm &middot; grip x${rider.snow.grip.toFixed(2)} &middot; turn x${rider.snow.turn.toFixed(2)} &middot; drag ${rider.snow.drag0.toFixed(2)} + ${rider.snow.drag1.toFixed(4)}v &middot; chop ${rider.chop.toFixed(2)} &middot; sink ${rider.noseSink.toFixed(2)}</span>` : '');
}
