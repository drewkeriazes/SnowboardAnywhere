// BUG-075: when two cishot.mjs runs disagree, the drawn objects that differ, view by view.
// node tools/cishot_diff.mjs <outDirA> <outDirB>   (each holding a stats.json)
import fs from 'node:fs';
const [a, b] = process.argv.slice(2).map((d) => JSON.parse(fs.readFileSync(`${d}/stats.json`, 'utf8')));
for (let i = 0; i < a.views.length; i++) {
  const va = a.views[i], vb = b.views[i];
  const keys = new Set([...Object.keys(va.drawn ?? {}), ...Object.keys(vb.drawn ?? {})]);
  const d = [...keys].filter((k) => (va.drawn?.[k] ?? 0) !== (vb.drawn?.[k] ?? 0)).map((k) => `   ${va.drawn?.[k] ?? 0} -> ${vb.drawn?.[k] ?? 0}  ${k}`);
  const nums = ['calls', 'triangles', 'lines', 'geometries'].map((f) => `${f} ${va[f]}->${vb[f]}`).join(', ');
  console.log(va.name, nums);
  if (d.length) console.log(d.join('\n'));
}
