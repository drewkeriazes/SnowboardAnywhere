export interface HeightSetMeta {
  res: number;
  tileSize: number;
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  tilesX: number;
  tilesY: number;
}

export interface MaskMeta {
  res: number;
  tileSize: number;
  minX: number;
  minY: number;
  tilesX: number;
  tilesY: number;
}

/** FEAT-153: one forest cover level, a single RGBA PNG over a rectangle (pack-format.md) */
export interface CoverLevelMeta {
  name: string;
  res: number;
  /** lower-left corner (pack metres); the image's row 0 is the north edge */
  minX: number;
  minY: number;
  w: number;
  h: number;
  file: string;
}

export interface CoverMeta {
  /** canopy height at G = 255 (m) */
  heightMax: number;
  /** a finer level fades in over this many metres inside its edges */
  blend: number;
  levels: CoverLevelMeta[];
}

export interface InstancesMeta {
  cellSize: number;
  minX: number;
  minY: number;
  cellsX: number;
  cellsY: number;
  treeCount?: number;
  rockCount?: number;
  /** cells that have a file, as "cx_cy"; absent in packs built before BUG-036 (then every cell is requested) */
  treeCells?: string[];
  rockCells?: string[];
  /** DATA-020: shrubs/<cx>_<cy>.bin, Float32 records x, y, z, height, radius, kind; absent in older packs */
  shrubCount?: number;
  shrubCells?: string[];
}

export interface PackMeta {
  version: number;
  slug: string;
  name: string;
  crs: string;
  origin: [number, number];
  lonlat: [number, number];
  bounds: { minX: number; minY: number; maxX: number; maxY: number };
  zRange: [number, number];
  terrain: { fine?: HeightSetMeta; mid?: HeightSetMeta; far?: HeightSetMeta };
  mask?: MaskMeta;
  /** baked sky visibility (greyscale PNG tiles, same layout as the mask), FEAT-047 */
  ao?: MaskMeta;
  /** piste direction (DATA-002): greyscale tiles on the mask grid, byte 0 = none, 1..255 = groomed run axis (byte - 1) / 254 * 180 deg from east toward north */
  dir?: MaskMeta;
  /** mogul amplitude 0..1 m (greyscale PNG tiles, same layout as the mask), FEAT-059; absent in older packs */
  moguls?: MaskMeta;
  /** FEAT-153: forest cover levels for the terrain at a distance; absent in older packs */
  cover?: CoverMeta;
  instances?: InstancesMeta;
  /** DATA-020: 2 = tree species ids 0..7 (see docs/pack-format.md); absent = 0..2 */
  treeSpecies?: number;
  start: { x: number; y: number; heading: number; run?: string };
  sun: { azimuth: number; elevation: number };
  attribution: string[];
}

export type Difficulty = 'easy' | 'intermediate' | 'advanced' | 'expert' | 'freeride' | 'extreme' | 'novice';

export interface RunFeature {
  name: string | null;
  difficulty: Difficulty | null;
  groomed: boolean;
  gladed: boolean;
  osmId?: number | string | null;
  area?: boolean;
  /** OSM bridge=*: the way spans a gap the bare-earth DEM does not show */
  bridge?: boolean;
  /** nights the resort's grooming reports groomed this run; absent when never or no reports */
  groomNights?: number;
  /** FEAT-059: how likely the run carries a mogul field, 0..1; absent in older packs */
  mogulScore?: number;
  points: [number, number, number][];
}

export interface LiftFeature {
  name: string | null;
  type: string;
  capacity?: number | null;
  stations: [number, number, number][];
  towers: [number, number, number, number][]; // x, y, zGround, height
  cable: [number, number, number][];
}

export interface BuildingFeature {
  name?: string | null;
  points: [number, number][];
  zBase: number;
  /** highest ground under the footprint (BUG-024); absent in packs built before it */
  zMax?: number;
  height: number;
  /** true when the pipeline had no height or levels tag and used its fallback; absent in older packs */
  heightDefault?: boolean;
  kind?: string;
}

export interface RoadFeature {
  name?: string | null;
  kind: string;
  points: [number, number, number][];
  width: number;
  bridge?: boolean;
}

export interface PeakFeature {
  name: string;
  x: number;
  y: number;
  z: number;
}

export interface Features {
  lifts: LiftFeature[];
  runs: RunFeature[];
  buildings: BuildingFeature[];
  roads: RoadFeature[];
  water: { name?: string; points: [number, number][]; z: number }[];
  peaks: PeakFeature[];
  labels: { name: string; kind: string; x: number; y: number; z: number }[];
}
