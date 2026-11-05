# Research: OpenSkiData schema, lift mechanics, live weather, sun position (M4, M5)

Researched 2026-11-05. Schema facts are read directly from the `openskidata-format` source (MIT, russellporter). Lift mechanics are engineering rules of thumb from the cited pages; "derived" means our own arithmetic.

## 1. OpenSkiData GeoJSON schema (what `tiles.openskimap.org/geojson/*.geojson` and Bonvo's re-hosted files contain)

Source: https://github.com/russellporter/openskidata-format (src/Lift.ts, Run.ts, SkiArea.ts, Spot.ts, ElevationProfile.ts, Status.ts).

### LiftFeature (`geometry`: LineString or MultiLineString of `[lon, lat, ele]`)
```ts
type LiftProperties = {
  type: 'lift'; id: string;
  liftType: 'cable_car' | 'gondola' | 'chair_lift' | 'mixed_lift' | 'drag_lift' | 't-bar' | 'j-bar' | 'platter' | 'rope_tow' | 'magic_carpet' | 'funicular' | 'railway';
  status: 'operating' | 'disused' | 'abandoned' | 'proposed' | 'planned' | 'construction';
  access: 'private' | null;
  name: string | null; ref: string | null; refFRCAIRN: string | null; description: string | null;
  oneway: boolean | null;
  occupancy: number | null;      // seats per carrier (4, 6, 8, 10)
  capacity: number | null;       // persons per hour
  duration: number | null;       // ride time, seconds
  detachable: boolean | null; bubble: boolean | null; heating: boolean | null; tunnel: boolean | null;
  stations: LiftStationSpotFeature[];   // Point features with properties.position 'top' | 'bottom' | 'mid'
  skiAreas: SkiAreaSummaryFeature[]; sources: Source[]; websites: string[]; wikidataID: string | null; places: Place[];
  viewportHint: ViewportHint;
}
```
Helper in the library: `getLiftElevationData(feature)` returns inclined length, vertical, and `speedInMetersPerSecond = inclinedLength / duration` when `duration` is set. Use that for carrier speed when present, else the defaults in section 2.

### RunFeature (`geometry`: LineString for a run line, Polygon for a piste area)
```ts
type RunProperties = {
  type: 'run'; id: string;
  uses: ('downhill' | 'nordic' | 'skitour' | 'sled' | 'hike' | 'sleigh' | 'ice_skate' | 'snow_park' | 'playground' | 'connection' | 'fatbike')[];
  name: string | null; ref: string | null; status: Status; description: string | null;
  difficulty: 'novice' | 'easy' | 'intermediate' | 'advanced' | 'expert' | 'freeride' | 'extreme' | null;
  difficultyConvention: 'europe' | 'japan' | 'north_america';
  oneway, lit, gladed, patrolled, snowmaking, snowfarming, tunnel: boolean | null;
  grooming: 'classic' | 'mogul' | 'classic+skating' | 'skating' | 'scooter' | 'backcountry' | null;
  skiAreas: SkiAreaSummaryFeature[];
  elevationProfile: { heights: number[]; resolution: number; targetResolution: number } | null;
  sources: Source[]; websites: string[]; wikidataID: string | null; places: Place[]; snowCoverHistory?: ...; viewportHint: ViewportHint;
}
```
- `elevationProfile.heights` are sampled every `resolution` metres along the LineString (Bonvo's Vail data showed resolution 24.963), last sample at the endpoint. Reconstruct positions with `turf.lineChunk(geometry, resolution, {units: 'meters'})`.
- North America colour convention (`RunDifficultyConvention.NORTH_AMERICA`): green = novice/easy, blue = intermediate, black = advanced/expert, orange = freeride/extreme. Library colours: green `hsl(125,100%,33%)`, blue `hsl(208,100%,33%)`, black `hsl(0,0%,0%)`, orange `hsl(34,100%,50%)`, red `hsl(359,94%,53%)` (Europe only), grey `hsl(0,0%,35%)` (unknown). Use these for the trail-map UI and piste tinting so it matches OpenSkiMap.
- `grooming: 'mogul'` is the flag for bump runs; `gladed: true` for tree runs. Both drive surface masks and physics modifiers.
- `uses` includes `'connection'` for cat tracks and lift-access traverses; Bonvo marks the same with `isConnector`.

### SkiAreaFeature
`properties`: `type: 'skiArea'`, `id`, `name`, `activities: ('downhill' | 'nordic')[]`, `status`, `sources`, `runConvention`, `statistics?: { runs: { minElevation, maxElevation, byActivity: {downhill: {byDifficulty: {easy: {count, lengthInKm}, ...}}} }, lifts: { minElevation, maxElevation, byType: {chair_lift: {count, lengthInKm}, ...} }, minElevation, maxElevation }`. Vail's id: `88a22ba23468cf120025366ef40f004c9043546e` (from the Bonvo capture). Geometry is the resort polygon: use it (buffered 1.5 km) as the resort bbox in `pipeline/resorts/<slug>.json` for the next resort.

### Spots
`LiftStationSpotFeature`: Point with `properties.position` top/bottom/mid, linked from `LiftProperties.stations`. Other `SpotType`s: crossing, avalanche_transceiver_training, avalanche_transceiver_checkpoint, halfpipe.

## 2. Lift mechanics for rideable lifts

Line speeds (haul rope)
| Lift type | Line speed | Loading speed | Source |
|---|---|---|---|
| Detachable chair (our "Express" lifts) | ~5 m/s (1,000 ft/min typical; up to 5.6 m/s) | ~1 m/s in the terminal (200 ft/min) | Wikipedia, Detachable chairlift |
| Fixed-grip chair (Gopher Hill, Little Eagle, Cascade Village) | ~2.5 m/s (500 ft/min) | same as line | Wikipedia |
| Gondola (Gondola One, Eagle Bahn) | 5 to 6 m/s | ~0.3 m/s in terminal | typical; derived |
| T-bar / platter | 2 to 3 m/s | n/a | typical |
| Magic carpet | 0.5 to 1 m/s | n/a | typical |

Carrier spacing (derived): `interval_s = occupancy * 3600 / capacity_pph`; spacing along the rope `= interval_s * line_speed`. A detachable quad at 2,400 pph: 6 s, 30 m between chairs at 5 m/s. A six-pack at 3,000 to 3,600 pph: 6 to 7.2 s, 30 to 36 m. A fixed quad at 1,800 pph: 8 s, 20 m. Field reports confirm 6 to 7 s spacing on a modern detachable (Lift Blog comments). Number of carriers on the loop `= 2 * inclined_length / spacing` (up and down sides).

Towers: positions come straight from OSM `aerialway=pylon` nodes (428 at Vail, ~13 per chairlift, which is realistic: towers every 100 to 250 m, closer on steep or convex ground). Tower height above ground 8 to 15 m; use 10 m default, 14 m where the span crosses a run (rope clearance). Terminals: OSM `aerialway=station` nodes (65 at Vail) and OpenSkiData `stations`.

Cable geometry between towers (derived, good enough for rendering): the rope hangs as a catenary; for spans under 300 m a parabola is visually identical. For a span of horizontal length L between sheave points A and B, sag at the midpoint `s = k * L` with `k` 0.02 to 0.04 (2 to 4 %), lower on short steep spans. Point at parameter t in [0,1]: `P(t) = lerp(A, B, t) - up * 4 * s * t * (1 - t)`. Up-side and down-side ropes are offset laterally by the sheave assembly width (~1.5 m for a chair, ~2 m for a gondola... derived). Chairs hang vertically from the rope, swing damped with ~2 s period; animate carriers by advancing a single scalar `distance_along_loop` at line speed and sampling the polyline of spans.

Ride animation: entering a terminal, decelerate to loading speed over the last 15 m, hold for 2 s (loading), accelerate over 20 m back to line speed. Ride time check: Gondola One, ~2.1 km and 750 m vertical, should take 7 to 8 minutes at 5.5 m/s; compare with OpenSkiData `duration` where present.

## 3. Live weather: Open-Meteo (same source Bonvo uses)

No API key for non-commercial use; no stated rate limits on the free tier (be polite: one call per session start and every 15 min).

```
https://api.open-meteo.com/v1/forecast?latitude=39.606&longitude=-106.374&elevation=3000
  &current=temperature_2m,weather_code,snowfall,cloud_cover,wind_speed_10m,wind_direction_10m,is_day
  &hourly=snowfall,snow_depth,cloud_cover,temperature_2m&timezone=America/Denver&wind_speed_unit=ms
```
- `elevation=` matters: default downscaling uses a 90 m DEM at the point; set it to the mid-mountain elevation (3,000 m) or make two calls (base 2,475, summit 3,527) and interpolate by rider altitude.
- Units: temperature C, snowfall cm per preceding hour (divide by 7 for mm water), snow_depth m, cloud_cover %, wind km/h unless `wind_speed_unit=ms`.
- WMO `weather_code` to render state:

| Codes | Meaning | Render |
|---|---|---|
| 0, 1 | clear, mainly clear | full sun, sparkle on |
| 2 | partly cloudy | cloud layer alpha 0.4, soft shadows |
| 3 | overcast | flat light, no sparkle, shadows off, sky grey |
| 45, 48 | fog, rime fog | visibility 150 to 400 m, desaturate |
| 71, 73, 75, 77 | snowfall slight/moderate/heavy, snow grains | particles 200/600/1500 per m^3 column, visibility 1500/800/400 m |
| 85, 86 | snow showers | as 71/75 but intermittent |
| 51 to 67, 80 to 82 | drizzle/rain (spring) | wet snow look, slush physics, no particles |
| 95 to 99 | thunderstorm | dark overcast, lifts closed |

`is_day` plus the sun position below decide night mode (Vail has no night skiing except Adventure Ridge, so night is a free-ride novelty).

## 4. Sun position (for shadows, sky, and the time-of-day slider)

NOAA's simplified solar position algorithm is accurate to well under a degree, which is more than shadows need. Implementation (TypeScript, UTC in, radians out):

```ts
export function sunPosition(date: Date, latDeg: number, lonDeg: number) {
  const rad = Math.PI / 180;
  const jd = date.getTime() / 86400000 + 2440587.5;          // Julian day
  const T = (jd - 2451545) / 36525;                            // Julian centuries from J2000
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = (357.52911 + T * (35999.05029 - 0.0001537 * T)) * rad;
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = (1.914602 - T * (0.004817 + 0.000014 * T)) * Math.sin(M)
          + (0.019993 - 0.000101 * T) * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M);
  const trueLong = L0 + C;
  const omega = (125.04 - 1934.136 * T) * rad;
  const lambda = (trueLong - 0.00569 - 0.00478 * Math.sin(omega)) * rad; // apparent longitude
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = (eps0 + 0.00256 * Math.cos(omega)) * rad;                   // obliquity
  const decl = Math.asin(Math.sin(eps) * Math.sin(lambda));
  const y = Math.tan(eps / 2) ** 2;
  const eqTime = 4 / rad * (y * Math.sin(2 * L0 * rad) - 2 * e * Math.sin(M) + 4 * e * y * Math.sin(M) * Math.cos(2 * L0 * rad)
               - 0.5 * y * y * Math.sin(4 * L0 * rad) - 1.25 * e * e * Math.sin(2 * M)); // minutes
  const minutesUTC = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const trueSolarMin = (minutesUTC + eqTime + 4 * lonDeg + 1440) % 1440;
  const ha = ((trueSolarMin / 4) - 180) * rad;                            // hour angle
  const lat = latDeg * rad;
  const cosZen = Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZen)));
  const theta = Math.acos(Math.min(1, Math.max(-1, (Math.sin(lat) * cosZen - Math.sin(decl)) / (Math.cos(lat) * Math.sin(zenith)))));
  const az = ha > 0 ? Math.PI + theta : Math.PI - theta;                 // from north, clockwise; afternoon is west of south
  return { elevation: Math.PI / 2 - zenith, azimuth: az };
}
// Three.js (Y up, our +Z = south, +X = east): sunDir = (sin(az)*cos(el), sin(el), -cos(az)*cos(el))
```
Verified outputs for Vail (39.606, -106.374), assert these in a unit test (tolerance 0.5 deg):

| UTC instant | Local | Elevation | Azimuth |
|---|---|---|---|
| 2026-01-15T19:00Z | Jan 15 12:00 MST | 29.3 | 176.0 |
| 2026-01-15T22:00Z | Jan 15 15:00 MST | 18.2 | 220.4 |
| 2026-03-15T15:00Z | Mar 15 09:00 MDT | 18.7 | 109.1 |
| 2026-06-21T19:00Z | Jun 21 13:00 MDT | 73.8 | 173.9 |

In mid-winter the sun never gets above ~30 deg, so the north-facing Front Side is lit at a grazing angle and the valley floor is in shadow well before the lifts close: a recognisable Vail detail the CSM setup should reproduce (long tree shadows across the pistes).

## Sources
- [openskidata-format source](https://github.com/russellporter/openskidata-format) (src/*.ts)
- [Detachable chairlift (Wikipedia)](https://en.wikipedia.org/wiki/Detachable_chairlift)
- [Chairlift (Wikipedia)](https://en.wikipedia.org/wiki/Chairlift)
- [Lift Blog: Hood River Express](https://liftblog.com/hood-river-express-mt-hood-meadows/) (carrier spacing field report)
- [Open-Meteo docs](https://open-meteo.com/en/docs)
- NOAA solar calculator equations (General Solar Position Calculations, NOAA ESRL)
