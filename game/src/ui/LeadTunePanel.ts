import type { RiderView } from '../world/RiderView';

type LeadKey = 'leadUpper' | 'leadHips' | 'boardLag';

/** BUG-056 ?debug: sliders for the body lead / board lag chain, to tune it by eye */
export function mountLeadTunePanel(riderView: RiderView): void {
  const rows: [string, LeadKey, number][] = [['Upper lead', 'leadUpper', 0.4], ['Hips lead', 'leadHips', 0.3], ['Board lag', 'boardLag', 0.3]];
  const panel = document.createElement('div');
  panel.id = 'lead-tune';
  panel.style.cssText = 'position:fixed;right:16px;top:50%;transform:translateY(-50%);background:rgba(0,0,0,.5);color:#fff;font:12px system-ui;padding:8px 10px;border-radius:6px;z-index:20';
  panel.innerHTML = rows.map(([label, k, max]) => `<label style="display:block;margin:4px 0">${label} <span data-v="${k}">${riderView[k].toFixed(2)}</span> s<br><input type="range" data-k="${k}" min="0" max="${max}" step="0.01" value="${riderView[k]}" style="width:140px"></label>`).join('');
  panel.querySelectorAll<HTMLInputElement>('input').forEach((i) => {
    const k = i.dataset.k as LeadKey;
    i.oninput = () => { riderView[k] = +i.value; panel.querySelector(`[data-v="${k}"]`)!.textContent = (+i.value).toFixed(2); };
    i.onpointerup = () => i.blur(); // give the arrow keys back to the rider
  });
  document.body.appendChild(panel);
}
