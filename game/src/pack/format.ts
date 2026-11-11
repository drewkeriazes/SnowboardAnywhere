/**
 * FEAT-222: the pack format this client reads, the same number as FORMAT_VERSION in pipeline/packwriter.py
 * (pipeline/tests/test_publish_pack.py checks they match). A pack's meta.json carries the format it was built in
 * as `formatVersion` (absent = 0, built before FEAT-222); the resort picker shows an older one as "needs rebuild".
 * Bump both on any pack-format change and add a line to docs/pack-format.md > formatVersion.
 */
export const PACK_FORMAT = 1;
