# EGM96 geoid grid

`egm96-15.bin.gz` is the EGM96 geoid undulation on a 15-arc-minute grid, the
data `src/data/geoid.js` interpolates to convert between heights above mean sea
level and heights above the WGS84 ellipsoid.

- 721 rows, from 90°N to 90°S in 15′ steps. Each row has 1440 columns,
  eastward from 0° in 15′ steps.
- Each value is the undulation N in centimetres: the geoid's height above the
  WGS84 ellipsoid.
- Each row is stored as little-endian 16-bit integers holding differences: the
  row's first value is itself, and every later value is its change from the
  one before. The file is gzipped, which takes the 2,076,480-byte grid to
  937,381 bytes.

Source: the EGM96 geopotential model by NGA and NASA (public domain), in the
grid the MIT-licensed `egm96-universal` 1.1.1 npm package embeds. The app used
that package until September 2026; `geoid.js` reproduces its lookup value for
value. Decoded, the grid (its values in row order as little-endian 16-bit
integers) has the SHA-256
`53dc06fa2aff894a841ff59a24bd7c99ddf569a0a97655808d8aea27272a6800`.
