import type { PieceReferenceCenter, Vector3Tuple } from '../../domain/model';

export type ReferenceTriangle = readonly [Vector3Tuple, Vector3Tuple, Vector3Tuple];

const subtract = (a: Vector3Tuple, b: Vector3Tuple): Vector3Tuple => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vector3Tuple, b: Vector3Tuple): Vector3Tuple => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vector3Tuple, b: Vector3Tuple) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const addScaled = (total: Vector3Tuple, point: Vector3Tuple, weight: number): Vector3Tuple => [total[0] + point[0] * weight, total[1] + point[1] * weight, total[2] + point[2] * weight];

/**
 * Estimates a stable reference point from mesh triangles.  A signed tetrahedra
 * integral gives the physical centre of mass for a closed mesh of uniform
 * density.  Imported CAD assets are often open or have inconsistent winding,
 * so the mathematically sound fallback is the area-weighted surface centroid.
 */
export const estimatePieceReferenceCenter = (
  triangles: readonly ReferenceTriangle[],
  boundsCenter: Vector3Tuple,
  now = new Date().toISOString(),
): PieceReferenceCenter => {
  if (!triangles.length) {
    return { position: boundsCenter, method: 'bounds-center', confidence: 0.15, triangleCount: 0, updatedAt: now };
  }

  let signedVolume = 0;
  let volumeCentroid: Vector3Tuple = [0, 0, 0];
  let surfaceArea = 0;
  let surfaceCentroid: Vector3Tuple = [0, 0, 0];

  triangles.forEach(([a, b, c]) => {
    const sixVolume = dot(a, cross(b, c));
    const volume = sixVolume / 6;
    signedVolume += volume;
    const tetraCentroid: Vector3Tuple = [(a[0] + b[0] + c[0]) / 4, (a[1] + b[1] + c[1]) / 4, (a[2] + b[2] + c[2]) / 4];
    volumeCentroid = addScaled(volumeCentroid, tetraCentroid, volume);

    const area = Math.hypot(...cross(subtract(b, a), subtract(c, a))) / 2;
    if (area <= 0.000000001) return;
    const triangleCentroid: Vector3Tuple = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
    surfaceArea += area;
    surfaceCentroid = addScaled(surfaceCentroid, triangleCentroid, area);
  });

  // Relative threshold avoids treating an almost-flat/open asset as a solid.
  if (Math.abs(signedVolume) > Math.max(surfaceArea * 0.00001, 0.00000001)) {
    return {
      position: [volumeCentroid[0] / signedVolume, volumeCentroid[1] / signedVolume, volumeCentroid[2] / signedVolume],
      method: 'volume-centroid',
      confidence: 0.9,
      triangleCount: triangles.length,
      updatedAt: now,
    };
  }

  if (surfaceArea > 0.00000001) {
    return {
      position: [surfaceCentroid[0] / surfaceArea, surfaceCentroid[1] / surfaceArea, surfaceCentroid[2] / surfaceArea],
      method: 'surface-centroid',
      confidence: 0.68,
      triangleCount: triangles.length,
      updatedAt: now,
    };
  }

  return { position: boundsCenter, method: 'bounds-center', confidence: 0.15, triangleCount: triangles.length, updatedAt: now };
};
