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
  instances?: InstancesMeta;
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
  height: number;
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
