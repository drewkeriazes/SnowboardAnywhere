# Research: Vail resort facts for validation, labels and lifts (M0 validate, M4)

Researched 2026-11-05. Published figures from Wikipedia (infobox and body disagree slightly; both given). Lift inventory cross-checked against OUR OSM extract (`raw/vail/osm/ski.json`), which is what the pipeline joins on.

## Mountain stats (sanity checks for the DEM and pack)
- Base 2,475 m (8,120 ft) at Vail Village / Lionshead; summit 3,527 m (11,570 ft); vertical 1,052 m (3,450 ft).
- Skiable area 5,289 to 5,317 acres (21.4 to 21.5 km^2); 193 to 195 named runs; 31 lifts.
- Longest run: Riva Ridge, 4 miles (6.5 km). Good end-to-end physics test: top of Mountaintop Express to Vail Village.
- Annual snowfall 354 to 370 in. The Vail Mountain SNOTEL site is at Eagle's Nest (weather reference for M5).
- Location for sun/weather: 39.606 N, 106.374 W (Vail Village). Resort origin is in `pipeline/resorts/vail.json`.

## The three faces
1. Front Side (north-facing, groomed trails through forest, all the base-area lifts). Base areas: Vail Village (Gondola One, Riva Bahn), Lionshead (Eagle Bahn Gondola, Born Free), Golden Peak (Riva Bahn, Golden Peak T-bar, race arena), plus Cascade Village (lift 20).
2. Back Bowls (south-facing, above-treeline open bowls): Sun Down, Sun Up, China, Siberia, Tea Cup, Inner Mongolia, Outer Mongolia, plus Game Creek Bowl on the west end. Served by High Noon (5), Sun Up (9), Sun Down (17), Orient Express (21), Tea Cup (36), Mongolia platter (22), Wapiti platter (24). Treeline runs through them; expect sparse krummholz and wind scour in the masks.
3. Blue Sky Basin (south of the Back Bowls, gladed, 1999 expansion): Pete's Bowl and Earl's Bowl. Served by Skyline Express (37), Earl's Express (38), Pete's Express (39). The glades here are the best test of real tree placement vs Bonvo's procedural scatter.

## Lift inventory: published vs our OSM data
Published (Wikipedia, 27 of 31 rows) vs `ski.json` (33 aerialway ways, 65 station nodes, 428 pylon nodes). Join key: the OSM `ref` tag equals the lift number.

| # | OSM name | OSM type | Published type |
|---|---|---|---|
| 1 | Gondola One | gondola | Gondola (10-passenger) |
| 2 | Avanti Express Lift | chair_lift | High speed six |
| 3 | Wildwood Express Lift | chair_lift | High speed quad |
| 4 | Mountain Top Express Lift | chair_lift | High speed six |
| 5 | High Noon Express Lift | chair_lift | High speed quad |
| 6 | Riva Bahn Express Lift | chair_lift | High speed quad |
| 7 | Game Creek Express Lift | chair_lift | High speed six |
| 8 | Born Free Express Lift | chair_lift | High speed quad |
| 9 | Sun Up Express Lift | chair_lift | High speed quad |
| 10 | Highline Express Lift | chair_lift | High speed quad |
| 11 | Northwoods Express Lift | chair_lift | High speed six |
| 12 | Gopher Hill Lift | chair_lift | Fixed triple |
| 14 | Sourdough Express Lift | chair_lift | High speed quad |
| 15 | Little Eagle | chair_lift | Fixed triple |
| 16 | Golden Peak | t-bar | T-bar |
| 17 | Sun Down Express | chair_lift | High speed quad (realigned 2022) |
| 18, 35 | Surface Lift | magic_carpet | |
| 19 | Eagle Bahn Gondola | gondola | Gondola |
| 20 | Cascade Village Lift | chair_lift | Fixed quad |
| 21 | Orient Express Lift | chair_lift | High speed quad |
| 22 | Mongolia | platter | Platter |
| 24 | Wapiti | platter | Platter |
| 25 | Elvis Bahn | magic_carpet | |
| 26 | Pride Express Lift | chair_lift | High speed quad |
| 27 | Black Forest | platter | Platter |
| 28 | Tubing Hill Lift | magic_carpet | |
| 29 | Rip's Ride Carpet | magic_carpet | |
| 36 | Tea Cup Express Lift | chair_lift | High speed quad |
| 37 | Skyline Express Lift | chair_lift | High speed quad |
| 38 | Earl's Express Lift | chair_lift | High speed quad |
| 39 | Pete's Express Lift | chair_lift | High speed quad |

Gaps: OSM lacks `aerialway:occupancy` on most lifts, so chair model (4 vs 6 seats, bubble) comes from OpenSkiData's `liftType`/`occupancy`/`bubble` or the table above. One unnamed magic carpet in OSM. 428 pylons is roughly 13 per chairlift, which matches real tower counts, so tower placement from OSM is usable directly.

## Pistes in our extract
354 piste ways, 217 distinct names: 109 easy, 122 intermediate, 113 advanced, 10 expert. OpenSkiData has 229 run features for the same area (per the Bonvo capture), so the counts line up.

Runs worth getting right first (recognisable, varied physics): Riva Ridge (long black/blue, Front Side), Born Free (blue cruiser, Eagle's Nest to Lionshead), Lost Boy (blue, rim of Game Creek Bowl), Simba (long blue, Lionshead), Swingsville (blue), Highline and Blue Ox (bump runs, black), Prima / Pronto / Log Chute (steep blacks), Forever (Sun Down Bowl), Poppyfields (China Bowl, easy bowl run), Ptarmigan Loop (Blue Sky cat track), Lover's Leap and Big Rock Park (Blue Sky glades).

## Landmarks for M4 (`built.json` has footprints; names to look for)
- Eagle's Nest (top of Eagle Bahn Gondola; Adventure Ridge), Mid-Vail (top of Gondola One; The 10th), Two Elk Lodge (top of Northwoods / China Bowl rim; large timber lodge), Wildwood Smokehouse (top of Wildwood), Buffalo's (top of Mountaintop Express), Belle's Camp (top of Blue Sky Basin), Sourdough (Sun Up / Tea Cup base), Golden Peak race arena, I-70 and Gore Creek along the whole north edge, Vail Village and Lionshead pedestrian cores.
- Horizon peaks from the top: Mount of the Holy Cross (4,269 m, SW; the signature view from the Back Bowls), the Gore Range north and east (Mount Powell 4,124 m), the Sawatch Range south. All are in `peaks_far.json` and `names/gnis.json`.

## Sources
- [Vail Ski Resort (Wikipedia)](https://en.wikipedia.org/wiki/Vail_Ski_Resort)
- [Vail History and Trail Name Origins (PDF)](https://mountainresortconcierge.com/wp-content/uploads/2020/01/Vail-History-and-Trail-Name-Origins.pdf)
- `raw/vail/osm/ski.json` (our OSM extract, 2026-11-02 Geofabrik data)
