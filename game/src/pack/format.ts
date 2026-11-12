/**
 * FEAT-222: the pack format this client reads, the same number as FORMAT_VERSION in MapPacker-SnowboardAnywhere/pipeline/packwriter.py
 * (its tests/test_contract.py checks against this repo's main). A pack's meta.json carries the format it was
 * built in as `formatVersion` (absent = 0, built before FEAT-222); the resort picker shows an older one as "needs
 * rebuild". Bump rule and spec: MapPacker's docs/pack-format.md > formatVersion; the game's side lands first or together.
 */
export const PACK_FORMAT = 1;
