# Split Robustness Round 2 (Batch J) — Design

**Date:** 2026-06-10
**Status:** Approved (ready for implementation plan)

## Summary

Three exact fixes for the post-Liepa split regression cluster, each root-caused
by reproduction on the reference model (evidence: neck-ring part with **5,754
directed-edge violations and negative signed volume** — both caps inverted;
synthetic island region capped with area 40 instead of 32 — per-loop overlay;
near-axis parts displaced along the body axis into the head):

1. **F1 — exact per-component cap orientation** (`js/split.js`). The global
   best-fit-plane + centroid flip is replaced by the orientability condition
   itself: the surface's directed boundary edges (`bEdge`, first-seen = surface
   winding) demand the cap traverse each rim edge in the OPPOSITE direction.
   Split the cap into connected components (shared refs), majority-vote each
   component's rim-edge directions against the surface, flip components that
   agree. Ties (no decisive rim sample) are left untouched with a
   `console.warn`. The old heuristic block is deleted.
2. **F2 — nesting-aware Liepa** (`js/caps.js`). The coplanarity-gated
   outer/hole classifier (today only in the earcut/cdt path) also feeds the
   `liepa` method: hole-less groups → `Liepa.fillLoop` (unchanged); groups
   with holes → the earcut group emission (incl. its degenerate centroid
   fallback). Kills the membrane laid over enclosed islands.
3. **F3 — clear-the-model explode** (`js/viewer.js`). Keep the proportional
   direction; floor the magnitude so the part's bounding sphere clears the
   model's bounding sphere along its ray:
   `dist = max(K·|pc−c|, r + 1.05·partR + 0.05·r − |pc−c|)`. Well-placed parts
   keep today's distances; rings pop out past the head instead of through it.

## Testing

- New harness helpers `directedViolations(indices)` and
  `signedVolume(indices, positions)`. The open-tube and tetra-bowl
  all-methods tests additionally assert **zero directed violations and
  positive signed volume** for every method (the suite was previously
  winding-blind at the solid level — this is the missing directed-watertight
  check; fails before F1 on the tube).
- New caps test: coplanar 6×6 outer + 2×2 island through method `liepa` →
  cap area ≈ 32 (pre-F2: 40), boundary edges = 8.
- Controller verification: re-run the regression evidence script (ring
  violations drop to sliver residue, volume positive; island area 32) and a
  browser pass on the real neck ring (caps visible from outside, explode
  clears the head, no membrane artifacts).

## Non-goals

- Interlocking-part explode paths beyond the bounding-sphere floor (a ring
  around a limb fundamentally must travel past the limb's end).
- The micro-sliver fold residue at fractal rims (documented Batch I
  limitation; the tip/band's ~66–136 residual violations are this).
