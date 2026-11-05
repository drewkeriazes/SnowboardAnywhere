// Resort registry. bbox = [west, south, east, north] in degrees.
// skiAreaId = OpenSkiData ski-area id (from the plan's Bonvo capture for Vail).
// Verify bbox against the OpenSkiData ski-area polygon before a full fetch.
export const RESORTS = {
  vail: {
    name: 'Vail',
    skiAreaId: '88a22ba23468cf120025366ef40f004c9043546e',
    origin: [-106.374, 39.606],            // lon, lat; game origin (Vail Village area)
    bbox: [-106.46, 39.54, -106.27, 39.66], // resort + ~1.5 km buffer
    bgBbox: [-107.3, 38.9, -105.4, 40.3],  // ~80 km background ring
    utmZone: 13,
  },
};
