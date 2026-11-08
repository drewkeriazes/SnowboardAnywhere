/** Plain-text unit formatting shared by the HUD and the run card. Input is always metres or m/s. */
export const fmtSpeed = (ms: number, metric: boolean): string =>
  metric ? `${(ms * 3.6).toFixed(0)} km/h` : `${(ms * 2.23694).toFixed(0)} mph`;

/** Heights and altitudes. */
export const fmtHeight = (m: number, metric: boolean): string =>
  metric ? `${m.toFixed(0)} m` : `${(m * 3.28084).toLocaleString('en-US', { maximumFractionDigits: 0 })} ft`;

/** Distances: km or m, mi or ft. */
export const fmtDistance = (m: number, metric: boolean): string =>
  metric ? (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(0)} m`) : (m >= 1609 * 0.25 ? `${(m / 1609.34).toFixed(2)} mi` : `${(m * 3.28084).toFixed(0)} ft`);
