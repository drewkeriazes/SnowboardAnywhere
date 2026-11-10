
/** wrap an angle to -PI..PI */
export function wrap(a: number): number { return Math.atan2(Math.sin(a), Math.cos(a)); }
