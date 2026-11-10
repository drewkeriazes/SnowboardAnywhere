// FEAT-128: trim a main menu ghost take (game/public/attract/<pack>/take-<n>.json) and set its outfit.
// node tools/trim_take.mjs <take.json> [--from s] [--to s] [--outfit "Neon 90s"] [--info]
//   --from / --to keep that span (seconds into the take) and restart its clock at 0; --info prints the
//   take's span, where it stops and where the rider crashes (flag bit 4) without changing anything.
import fs from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && args[i - 1] !== '--info'));
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const take = JSON.parse(fs.readFileSync(file, 'utf8'));
const s = take.samples;
const speed = (x) => Math.hypot(x.vx ?? 0, x.vy ?? 0);
const crashes = [];
for (let i = 0; i < s.length; i++) if ((s[i].f & 4) && !(i && s[i - 1].f & 4)) crashes.push(+s[i].t.toFixed(2));
const moving = s.filter((x) => speed(x) > 1.5);
console.log(`${file}: ${s.length} samples, ${s.at(-1).t.toFixed(1)} s, ${take.discipline} ${take.stance} in ${take.outfit}; moving ${moving[0]?.t.toFixed(1) ?? '-'}..${moving.at(-1)?.t.toFixed(1) ?? '-'} s; crashes at ${crashes.join(', ') || 'none'} s`);
if (args.includes('--info')) process.exit(0);

const from = opt('from') !== undefined ? Number(opt('from')) : 0;
const to = opt('to') !== undefined ? Number(opt('to')) : Infinity;
const kept = s.filter((x) => x.t >= from && x.t <= to).map((x) => ({ ...x, t: +(x.t - from).toFixed(3) }));
if (kept.length < 2) { console.error('nothing left in that span'); process.exit(1); }
take.samples = kept;
const outfit = opt('outfit');
if (outfit) take.outfit = outfit;
fs.writeFileSync(file, JSON.stringify(take) + '\n');
const left = kept.filter((x) => x.f & 4).length;
console.log(`  kept ${from}..${Math.min(to, s.at(-1).t)} s -> ${kept.length} samples, ${kept.at(-1).t.toFixed(1)} s${outfit ? `, outfit ${outfit}` : ''}${left ? `; still ${(left * 0.05).toFixed(1)} s crashed` : ''}`);
