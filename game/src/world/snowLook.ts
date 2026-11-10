/**
 * The snow's look, shared by everything that draws snow so it all matches: the terrain's typical snow
 * albedo (linear; BUG-021) and the cool tint its sky light takes in shade (TerrainMaterial). Used by
 * the tracks, the snow cover on the rider (FEAT-152) and the snow on the trees (FEAT-157).
 */
export const SNOW_ALBEDO: readonly [number, number, number] = [0.83, 0.86, 0.94];
/** the sky fill on shaded snow: cool blue, not grey */
export const SNOW_SHADE_TINT: readonly [number, number, number] = [0.80, 0.93, 1.22];
