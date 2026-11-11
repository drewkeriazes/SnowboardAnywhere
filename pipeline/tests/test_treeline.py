"""DATA-021: the treeline comes from the resort's own canopy, not Colorado's 3,480 m."""
import os, sys
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import treeline as tl


def mountain(line, seed=0):
    """Elevations 2000..4000 m, forest share 0.7 below `line`, fading to 0 over 100 m above it, plus noise."""
    rng = np.random.default_rng(seed)
    elev = rng.uniform(2000, 4000, 400_000)
    p = np.clip(0.7 * (1 - (elev - line) / 100), 0, 0.7)
    return elev, rng.random(elev.size) < p


def test_finds_a_low_and_a_high_treeline():
    for line in (2950, 3480):
        elev, forest = mountain(line)
        got = tl.derive_treeline(elev, forest)
        assert got is not None and abs(got - (line + 50)) <= 30, (line, got)


def test_isolated_trees_above_do_not_lift_it():
    elev, forest = mountain(2950, seed=1)
    stray = (elev > 3200) & (np.random.default_rng(2).random(elev.size) < 0.03)   # krummholz specks, 3 %
    got = tl.derive_treeline(elev, forest | stray)
    assert got is not None and got < 3100


def test_no_forest_or_tiny_area_gives_none():
    elev = np.linspace(2000, 3400, 100_000)
    assert tl.derive_treeline(elev, np.zeros(elev.size, bool)) is None
    assert tl.derive_treeline(elev[:500], np.ones(500, bool)) is None


def test_valid_mask_and_nan_are_ignored():
    elev, forest = mountain(3000, seed=3)
    elev = elev.copy(); elev[:1000] = np.nan
    valid = np.ones(elev.size, bool); valid[1000:2000] = False
    assert tl.derive_treeline(elev, forest, valid) is not None
