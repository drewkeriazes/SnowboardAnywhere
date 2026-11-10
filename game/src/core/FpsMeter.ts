/** The frame rate over the last half second (the HUD line and Settings' live readout). */
export class FpsMeter {
  fps = 0;
  /** frames counted in the current half second (the map redraws on every few of them) */
  n = 0;
  private acc = 0;

  tick(dt: number): void {
    this.acc += dt; this.n++;
    if (this.acc > 0.5) { this.fps = this.n / this.acc; this.acc = 0; this.n = 0; }
  }
}
