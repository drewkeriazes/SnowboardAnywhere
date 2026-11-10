/**
 * FEAT-181 (?debug, eye camera): Shift+P asks for the menu shot's name and labels, then hands them on (the session
 * posts the pose to the dev server, `/__attract/shot`). A small form over the game: typing in it reaches no
 * riding keys (Controls skips key presses aimed at an input). Enter saves, Esc cancels.
 */
export interface MenuShotLabels { id: string; place: string; region: string }

export function askMenuShot(defaults: MenuShotLabels, onSave: (l: MenuShotLabels) => void): void {
  if (document.getElementById('menu-shot-form')) return;
  const form = document.createElement('form');
  form.id = 'menu-shot-form';
  form.style.cssText = 'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:60;background:rgba(12,16,28,0.94);color:#fff;'
    + 'padding:18px 20px;border-radius:10px;font:14px system-ui,sans-serif;display:grid;grid-template-columns:auto 240px;gap:8px 12px;align-items:center;box-shadow:0 8px 30px rgba(0,0,0,0.5)';
  const title = document.createElement('div');
  title.textContent = 'Use this view as the main menu shot';
  title.style.cssText = 'grid-column:1/3;font-weight:700;margin-bottom:4px';
  form.append(title);
  const field = (label: string, value: string, hint: string): HTMLInputElement => {
    const l = document.createElement('label'); l.textContent = label;
    const i = document.createElement('input'); i.value = value; i.placeholder = hint;
    i.style.cssText = 'font:inherit;padding:5px 7px;border-radius:5px;border:1px solid #556;background:#0b0e18;color:#fff';
    form.append(l, i);
    return i;
  };
  const id = field('Name', defaults.id, 'lower-case-with-dashes');
  const place = field('Place', defaults.place, 'the big title, e.g. Back Bowls');
  const region = field('Region', defaults.region, 'the line above it, e.g. Vail · Colorado');
  const note = document.createElement('div');
  note.textContent = 'Replaces the resort\'s menu shot, and the riders made for the old one. Enter saves, Esc cancels.';
  note.style.cssText = 'grid-column:1/3;opacity:0.7;font-size:12px;max-width:340px';
  const buttons = document.createElement('div');
  buttons.style.cssText = 'grid-column:1/3;display:flex;gap:8px;justify-content:flex-end';
  const save = document.createElement('button'); save.type = 'submit'; save.textContent = 'Save';
  const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
  buttons.append(cancel, save);
  form.append(note, buttons);
  const close = () => form.remove();
  cancel.onclick = close;
  form.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const slug = id.value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug) { id.focus(); return; }
    close();
    onSave({ id: slug, place: place.value.trim(), region: region.value.trim() });
  });
  document.body.append(form);
  if (document.pointerLockElement) document.exitPointerLock();
  id.focus(); id.select();
}
