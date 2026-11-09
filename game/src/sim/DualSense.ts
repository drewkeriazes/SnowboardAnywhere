import { PAD, PAD_BUTTONS, setHidSource, type PadButton, type PadState } from './Pad';

/**
 * FEAT-137: the DualSense extras over WebHID (Chrome and Edge, secure context): the lightbar, the
 * adaptive triggers, rumble on the controller's own motors, the gyro and the touchpad. Nothing happens
 * until the player picks the controller in the browser's device picker (Settings > Controls > Connect
 * DualSense extras); after that `reconnect()` finds it again on later visits without asking.
 *
 * Report layouts follow the Linux hid-playstation driver (drivers/hid/hid-playstation.c):
 *  - input: USB report 0x01 (63 bytes after the id), Bluetooth 0x31 (one extra header byte first; reading
 *    feature report 0x05 switches Bluetooth from the short 0x01 report to the full one);
 *  - output: USB 0x02 (63 bytes after the id), Bluetooth 0x31 (77 bytes: seq, tag 0x10, the same 47-byte
 *    common block, padding, then a CRC-32 over 0xA2, 0x31 and the report);
 *  - adaptive trigger effects in the common block at 10 (R2) and 21 (L2), 11 bytes each, enabled by valid_flag0
 *    bits 2 and 3; the effect encodings (Feedback 0x21, Weapon 0x25) follow Nielk1's DualSense trigger effect notes.
 */

/** minimal WebHID types (not in TypeScript's DOM lib) */
interface HidInputReportEvent extends Event { readonly device: HidDevice; readonly reportId: number; readonly data: DataView }
interface HidCollection { usagePage?: number; usage?: number; outputReports?: { reportId?: number }[]; inputReports?: { reportId?: number }[] }
interface HidDevice extends EventTarget {
  readonly opened: boolean; readonly vendorId: number; readonly productId: number; readonly productName: string; readonly collections: HidCollection[];
  open(): Promise<void>; close(): Promise<void>;
  sendReport(reportId: number, data: Uint8Array): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
}
interface HidApi extends EventTarget {
  getDevices(): Promise<HidDevice[]>;
  requestDevice(o: { filters: { vendorId?: number; productId?: number }[] }): Promise<HidDevice[]>;
}
const hidApi = (): HidApi | null => (typeof navigator !== 'undefined' && (navigator as unknown as { hid?: HidApi }).hid) || null;

const SONY = 0x054c;
const FILTERS = [{ vendorId: SONY, productId: 0x0ce6 }, { vendorId: SONY, productId: 0x0df2 }];
/** gyro: about 16 raw units per degree a second (the driver's uncalibrated scale: 2048 deg/s over the int16 range) */
const GYRO_DEG_PER_UNIT = 2048 / 32767;

// ---------------------------------------------------------------- pure report helpers (padcheck tests these)
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
/** standard CRC-32 (zlib) over the bytes */
export function crc32(bytes: Uint8Array, crc = 0xffffffff): number {
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return crc >>> 0;
}
/** finalised CRC-32 of a byte list (the usual check value: crc32Of("123456789") = 0xCBF43926) */
export function crc32Of(bytes: Uint8Array): number { return (crc32(bytes) ^ 0xffffffff) >>> 0; }

/** Adaptive trigger effect: 11 bytes (mode + 10 parameters). */
export type TriggerEffect = Uint8Array;
export const triggerOff = (): TriggerEffect => { const e = new Uint8Array(11); e[0] = 0x05; return e; };
/** Resistance from zone `position` (0..9, a tenth of the travel each) to the end, `strength` 1..8 (0 is off). */
export function triggerFeedback(position: number, strength: number): TriggerEffect {
  if (strength <= 0) return triggerOff();
  const pos = Math.max(0, Math.min(9, Math.round(position))), force = (Math.max(1, Math.min(8, Math.round(strength))) - 1) & 7;
  let active = 0, forces = 0;
  for (let i = pos; i < 10; i++) { active |= 1 << i; forces = (forces | (force << (3 * i))) >>> 0; }
  const e = new Uint8Array(11);
  e[0] = 0x21; e[1] = active & 0xff; e[2] = (active >> 8) & 0xff;
  e[3] = forces & 0xff; e[4] = (forces >>> 8) & 0xff; e[5] = (forces >>> 16) & 0xff; e[6] = (forces >>> 24) & 0xff;
  return e;
}
/** A click: resistance from zone `start` (2..7) that gives way at `end` (start+1..8), `strength` 1..8. */
export function triggerWeapon(start: number, end: number, strength: number): TriggerEffect {
  if (strength <= 0 || start < 2 || start > 7 || end <= start || end > 8) return triggerOff();
  const zones = (1 << start) | (1 << end);
  const e = new Uint8Array(11);
  e[0] = 0x25; e[1] = zones & 0xff; e[2] = (zones >> 8) & 0xff; e[3] = Math.max(1, Math.min(8, Math.round(strength))) - 1;
  return e;
}

export interface DsOutput {
  /** motors 0..1: the left (strong, low) and right (weak, high) */
  strong: number; weak: number;
  /** lightbar 0..255, or null to leave it alone */
  light: [number, number, number] | null;
  left: TriggerEffect; right: TriggerEffect;
  /** firmware 2.21+ takes rumble through valid_flag2 */
  vibrationV2: boolean;
  /** the first report after connecting resets the lightbar (Bluetooth starts on a pulsing animation) */
  setupLightbar?: boolean;
}
/** The 47-byte common output block. */
export function outputCommon(o: DsOutput): Uint8Array {
  const c = new Uint8Array(47);
  c[0] = 0x02 | 0x04 | 0x08; // haptics select (classic rumble), R2 effect, L2 effect
  if (!o.vibrationV2) c[0] |= 0x01; // compatible vibration
  c[2] = Math.round(Math.max(0, Math.min(1, o.weak)) * 255); // motor_right
  c[3] = Math.round(Math.max(0, Math.min(1, o.strong)) * 255); // motor_left
  c.set(o.right, 10); c.set(o.left, 21);
  if (o.vibrationV2) c[38] |= 0x04;
  if (o.setupLightbar) { c[38] |= 0x02; c[41] = 0x02; } // lightbar setup control: light out (ends the start-up animation)
  if (o.light) { c[1] |= 0x04; c[44] = o.light[0]; c[45] = o.light[1]; c[46] = o.light[2]; }
  return c;
}
/** The report body to send (without the id): USB report 0x02, or Bluetooth 0x31 with its sequence and CRC. */
export function outputReport(o: DsOutput, bt: boolean, seq = 0): { id: number; data: Uint8Array } {
  const common = outputCommon(o);
  if (!bt) { const d = new Uint8Array(63); d.set(common, 0); return { id: 0x02, data: d }; }
  const d = new Uint8Array(77);
  d[0] = (seq & 0x0f) << 4; d[1] = 0x10; d.set(common, 2);
  const head = new Uint8Array(2 + 73); head[0] = 0xa2; head[1] = 0x31; head.set(d.subarray(0, 73), 2);
  const crc = crc32Of(head);
  d[73] = crc & 0xff; d[74] = (crc >>> 8) & 0xff; d[75] = (crc >>> 16) & 0xff; d[76] = (crc >>> 24) & 0xff;
  return { id: 0x31, data: d };
}

export interface DsInput { buttons: PadButton[]; axes: number[]; gyro: [number, number, number]; touch: { active: boolean; x: number; y: number }; battery: number }
/** Parse a full input report (`data` excludes the report id; `o` is 0 on USB, 1 on Bluetooth) into `out`. */
export function parseInput(data: DataView, o: number, out: DsInput): boolean {
  if (data.byteLength < o + 53) return false;
  const u = (i: number) => data.getUint8(o + i);
  const stick = (i: number) => Math.max(-1, (u(i) - 128) / 127);
  out.axes[0] = stick(0); out.axes[1] = stick(1); out.axes[2] = stick(2); out.axes[3] = stick(3);
  const b0 = u(7), b1 = u(8), b2 = u(9);
  const set = (i: number, p: boolean, v = p ? 1 : 0) => { out.buttons[i].pressed = p; out.buttons[i].value = v; };
  set(PAD.X, !!(b0 & 0x10)); set(PAD.A, !!(b0 & 0x20)); set(PAD.B, !!(b0 & 0x40)); set(PAD.Y, !!(b0 & 0x80));
  set(PAD.LB, !!(b1 & 0x01)); set(PAD.RB, !!(b1 & 0x02));
  set(PAD.LT, !!(b1 & 0x04) || u(4) > 30, u(4) / 255); set(PAD.RT, !!(b1 & 0x08) || u(5) > 30, u(5) / 255);
  set(PAD.SELECT, !!(b1 & 0x10)); set(PAD.START, !!(b1 & 0x20)); set(PAD.L3, !!(b1 & 0x40)); set(PAD.R3, !!(b1 & 0x80));
  set(PAD.HOME, !!(b2 & 0x01)); set(PAD.TOUCH, !!(b2 & 0x02));
  const hat = b0 & 0x0f; // 0 N, 1 NE, 2 E ... 7 NW, 8 centred
  set(PAD.UP, hat === 7 || hat === 0 || hat === 1); set(PAD.RIGHT, hat >= 1 && hat <= 3); set(PAD.DOWN, hat >= 3 && hat <= 5); set(PAD.LEFT, hat >= 5 && hat <= 7);
  for (let i = 0; i < 3; i++) out.gyro[i] = data.getInt16(o + 15 + 2 * i, true) * GYRO_DEG_PER_UNIT;
  const c = u(32);
  out.touch.active = !(c & 0x80);
  out.touch.x = u(33) | ((u(34) & 0x0f) << 8);
  out.touch.y = (u(34) >> 4) | (u(35) << 4);
  out.battery = Math.min(100, (u(52) & 0x0f) * 10 + 5);
  return true;
}

// ---------------------------------------------------------------- the device
export class DualSenseHID {
  private device: HidDevice | null = null;
  bt = false;
  private vibrationV2 = true;
  private lastReport = 0;
  reports = 0;
  private readonly input: DsInput = { buttons: Array.from({ length: PAD_BUTTONS }, () => ({ pressed: false, value: 0 })), axes: [0, 0, 0, 0], gyro: [0, 0, 0], touch: { active: false, x: 0, y: 0 }, battery: 0 };
  readonly state: PadState = { id: 'DualSense (WebHID)', kind: 'ps', buttons: this.input.buttons, axes: this.input.axes, source: 'hid', gp: null };
  /** gyro in degrees a second (x pitch, y yaw, z roll), the touchpad's first finger (0..1919, 0..1079), battery % */
  get gyro(): readonly number[] { return this.input.gyro; }
  get touch(): { readonly active: boolean; readonly x: number; readonly y: number } { return this.input.touch; }
  get battery(): number { return this.input.battery; }
  /** status for the settings panel */
  onStatus: ((s: string) => void) | null = null;
  status = '';

  private out: DsOutput = { strong: 0, weak: 0, light: null, left: triggerOff(), right: triggerOff(), vibrationV2: true };
  private dirty = false;
  private sending = false;
  private seq = 0;
  private lastSend = 0;
  private needSetup = false;

  static get supported(): boolean { return !!hidApi() && (typeof window === 'undefined' || window.isSecureContext); }
  get connected(): boolean { return !!this.device?.opened; }
  /** connected and reporting (half a second of silence counts as gone) */
  get live(): boolean { return this.connected && performance.now() - this.lastReport < 500; }

  constructor() {
    const api = hidApi();
    api?.addEventListener('disconnect', (e) => { if ((e as unknown as { device: HidDevice }).device === this.device) { this.device = null; this.setStatus('Disconnected'); } });
    api?.addEventListener('connect', () => { void this.reconnect(); });
  }
  private setStatus(s: string): void { this.status = s; this.onStatus?.(s); }

  /** Open the browser's picker (needs a click). */
  async connect(): Promise<boolean> {
    const api = hidApi();
    if (!api) { this.setStatus('WebHID needs Chrome or Edge over https or localhost'); return false; }
    try {
      const [d] = await api.requestDevice({ filters: FILTERS });
      if (!d) { this.setStatus('No controller picked'); return false; }
      return await this.open(d);
    } catch (e) { this.setStatus(`Could not connect (${(e as Error).message}); click the button with the mouse`); return false; }
  }
  /** A controller picked on an earlier visit, without the picker. */
  async reconnect(): Promise<boolean> {
    const api = hidApi();
    if (!api || this.connected) return this.connected;
    try {
      const d = (await api.getDevices()).find((x) => x.vendorId === SONY && FILTERS.some((f) => f.productId === x.productId));
      return d ? await this.open(d) : false;
    } catch { return false; }
  }
  async disconnect(): Promise<void> {
    const d = this.device;
    if (!d) return;
    this.out = { ...this.out, strong: 0, weak: 0, left: triggerOff(), right: triggerOff() };
    await this.send(true).catch(() => undefined);
    this.device = null;
    await d.close().catch(() => undefined);
    this.setStatus('Disconnected');
  }

  private async open(d: HidDevice): Promise<boolean> {
    if (!d.opened) await d.open();
    this.device = d;
    this.bt = d.collections.some((c) => c.outputReports?.some((r) => r.reportId === 0x31));
    // Bluetooth sends a short report until the calibration feature report is read; the firmware report tells the rumble style
    await d.receiveFeatureReport(0x05).catch(() => undefined);
    try {
      const fw = await d.receiveFeatureReport(0x20);
      const off = fw.byteLength >= 64 && fw.getUint8(0) === 0x20 ? 0 : -1; // Chrome keeps the id byte on feature reports
      const ver = fw.getUint16(44 + off, true);
      this.vibrationV2 = d.productId === 0x0df2 || ver >= 0x0215; // 2.21
    } catch { this.vibrationV2 = true; }
    this.out.vibrationV2 = this.vibrationV2;
    d.addEventListener('inputreport', (e) => this.onReport(e as HidInputReportEvent));
    this.needSetup = true; this.dirty = true;
    this.setStatus(`Connected over ${this.bt ? 'Bluetooth' : 'USB'}`);
    return true;
  }

  private onReport(e: HidInputReportEvent): void {
    let o = -1;
    if (e.reportId === 0x01 && e.data.byteLength >= 63) o = 0; // USB (a short Bluetooth 0x01 is ignored)
    else if (e.reportId === 0x31) { o = 1; this.bt = true; }
    if (o < 0 || !parseInput(e.data, o, this.input)) return;
    this.lastReport = performance.now();
    this.reports++;
  }

  // ---- output: set what you want, flush() sends it at most every 25 ms when it changed
  setRumble(strong: number, weak: number): void {
    const s = Math.round(strong * 255) / 255, w = Math.round(weak * 255) / 255;
    if (s !== this.out.strong || w !== this.out.weak) { this.out.strong = s; this.out.weak = w; this.dirty = true; }
  }
  setLight(rgb: [number, number, number] | null): void {
    const a = this.out.light;
    if (rgb === null ? a !== null : !a || a[0] !== rgb[0] || a[1] !== rgb[1] || a[2] !== rgb[2]) { this.out.light = rgb ? [rgb[0], rgb[1], rgb[2]] : null; this.dirty = true; }
  }
  setTriggers(left: TriggerEffect, right: TriggerEffect): void {
    const same = (a: Uint8Array, b: Uint8Array) => a.every((v, i) => v === b[i]);
    if (!same(left, this.out.left) || !same(right, this.out.right)) { this.out.left = left; this.out.right = right; this.dirty = true; }
  }
  flush(): void {
    if (!this.dirty || this.sending || !this.connected || performance.now() - this.lastSend < 25) return;
    void this.send(false);
  }
  private async send(force: boolean): Promise<void> {
    const d = this.device;
    if (!d || (this.sending && !force)) return;
    this.sending = true; this.dirty = false; this.lastSend = performance.now();
    // the lightbar reset goes out on its own (as the Linux driver does it), the colour in the next report
    const setup = this.needSetup;
    const r = outputReport(setup ? { ...this.out, light: null, setupLightbar: true } : this.out, this.bt, this.seq);
    this.seq = (this.seq + 1) & 0x0f;
    if (setup) { this.needSetup = false; this.dirty = true; }
    try { await d.sendReport(r.id, r.data); } catch { this.dirty = true; } finally { this.sending = false; }
  }
}

export const dualSense = new DualSenseHID();
setHidSource(dualSense);
