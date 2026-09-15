# EpicBloxs V33 - Clothing UV fix

This version fixes the actual root cause of clothing being positioned in a corner on the new ExtrudeGeometry male/female models.

## Root cause
Three.js r128's default ExtrudeGeometry UV generation uses raw model X/Y coordinates. The new bodies use coordinates centered around 0 (for example -0.56..0.56), so the CanvasTexture UVs were outside the 0..1 range. With ClampToEdgeWrapping, the texture collapsed toward an edge/corner. That is why artwork such as the EB logo appeared at the upper-left of the torso instead of centered.

## Fix
- Added `prepareExtrudeClothingGeometry()`.
- Converts indexed extruded clothing geometry to non-indexed geometry when needed.
- Rebuilds proper 0..1 UVs for front cap, back cap and side walls.
- Applied to the new male/female torso and extruded arms.
- Keeps the BoxGeometry clothing adapter for the six-face male/block model.
- Clothing system cache/version bumped to V33.
- JavaScript syntax checked.
