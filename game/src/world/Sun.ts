/**
 * Solar position for a date and local clock time at a lon/lat (degrees). Standard NOAA
 * low-precision algorithm, good to about 0.5 degrees, which is plenty for lighting.
 * Returns azimuth clockwise from north and elevation above the horizon, both in degrees.
 * The time is taken as local solar-ish time: `utcOffsetHours` converts the clock to UTC.
 */
export function sunPosition(lonDeg: number, latDeg: number, date: Date, hourLocal: number, utcOffsetHours: number): { azimuth: number; elevation: number } {
  const rad = Math.PI / 180;
  const dayOfYear = Math.floor((Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - Date.UTC(date.getUTCFullYear(), 0, 0)) / 86400000);
  const hourUtc = hourLocal - utcOffsetHours;
  const gamma = (2 * Math.PI / 365) * (dayOfYear - 1 + (hourUtc - 12) / 24);
  const eqtime = 229.18 * (0.000075 + 0.001868 * Math.cos(gamma) - 0.032077 * Math.sin(gamma) - 0.014615 * Math.cos(2 * gamma) - 0.040849 * Math.sin(2 * gamma));
  const decl = 0.006918 - 0.399912 * Math.cos(gamma) + 0.070257 * Math.sin(gamma) - 0.006758 * Math.cos(2 * gamma) + 0.000907 * Math.sin(2 * gamma) - 0.002697 * Math.cos(3 * gamma) + 0.00148 * Math.sin(3 * gamma);
  const timeOffset = eqtime + 4 * lonDeg; // minutes, relative to UTC
  const tst = hourUtc * 60 + timeOffset; // true solar time, minutes
  const ha = (tst / 4 - 180) * rad; // hour angle
  const lat = latDeg * rad;
  const cosZen = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  const zen = Math.acos(Math.max(-1, Math.min(1, cosZen)));
  // angle from due south toward the sun; morning (ha < 0) is east of south, afternoon west
  const a = Math.acos(Math.max(-1, Math.min(1, (Math.sin(lat) * Math.cos(zen) - Math.sin(decl)) / (Math.cos(lat) * Math.sin(zen) || 1e-9))));
  const az = ha > 0 ? Math.PI + a : Math.PI - a;
  return { azimuth: az / rad, elevation: 90 - zen / rad };
}

/** Rough UTC offset for a longitude when nothing better is known (15 degrees per hour). */
export function guessUtcOffset(lonDeg: number): number { return Math.round(lonDeg / 15); }
