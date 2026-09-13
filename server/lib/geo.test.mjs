import assert from 'node:assert/strict';
import test from 'node:test';
import { haversineKm } from './geo.mjs';

test('haversineKm measures great-circle distance in kilometers', () => {
  assert.equal(haversineKm(10, 20, 10, 20), 0);
  // One degree of latitude on a 6,371 km sphere is about 111.19 km.
  assert.ok(Math.abs(haversineKm(0, 0, 1, 0) - 111.19) < 0.01);
  const austinToLondon = haversineKm(30.2672, -97.7431, 51.5074, -0.1278);
  assert.ok(
    austinToLondon > 7800 && austinToLondon < 8000,
    `${austinToLondon} km`,
  );
});
