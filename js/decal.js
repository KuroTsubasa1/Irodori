// Image-decal projection: tangent frame at a picked point, model→decal UV
// mapping, and B&W mask sampling. Pure geometry, no Cleanup/Viewer deps.
(function () {
  "use strict";
  const EPS = 1e-9;
  const dot = (ax, ay, az, bx, by, bz) => ax * bx + ay * by + az * bz;
  const norm = (x, y, z) => { const l = Math.hypot(x, y, z) || 1; return [x / l, y / l, z / l]; };
  const cross = (ax, ay, az, bx, by, bz) => [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];

  function frame(px, py, pz, nx, ny, nz, upx, upy, upz, rotRad) {
    const [Nx, Ny, Nz] = norm(nx, ny, nz);
    // project refUp onto the tangent plane
    let d = dot(upx, upy, upz, Nx, Ny, Nz);
    let ux = upx - d * Nx, uy = upy - d * Ny, uz = upz - d * Nz;
    if (ux * ux + uy * uy + uz * uz < EPS) {
      // refUp parallel to N: fall back to world +X, then +Y
      d = dot(1, 0, 0, Nx, Ny, Nz);
      ux = 1 - d * Nx; uy = -d * Ny; uz = -d * Nz;
      if (ux * ux + uy * uy + uz * uz < EPS) {
        d = dot(0, 1, 0, Nx, Ny, Nz);
        ux = -d * Nx; uy = 1 - d * Ny; uz = -d * Nz;
      }
    }
    [ux, uy, uz] = norm(ux, uy, uz);
    // rotate u about N by rotRad (Rodrigues, u ⟂ N so simplifies)
    const c = Math.cos(rotRad || 0), s = Math.sin(rotRad || 0);
    const [kx, ky, kz] = cross(Nx, Ny, Nz, ux, uy, uz); // N × u, unit
    let ru = [ux * c + kx * s, uy * c + ky * s, uz * c + kz * s];
    [ux, uy, uz] = norm(ru[0], ru[1], ru[2]);
    const [rx, ry, rz] = norm(...cross(Nx, Ny, Nz, ux, uy, uz)); // r = N × u
    return { ox: px, oy: py, oz: pz, rx, ry, rz, ux, uy, uz, nx: Nx, ny: Ny, nz: Nz };
  }

  function uv(f, px, py, pz, w, h) {
    const dx = px - f.ox, dy = py - f.oy, dz = pz - f.oz;
    return {
      u: dot(dx, dy, dz, f.rx, f.ry, f.rz) / w + 0.5,
      v: dot(dx, dy, dz, f.ux, f.uy, f.uz) / h + 0.5,
    };
  }

  function sampleMask(mask, u, v) {
    if (u < 0 || u > 1 || v < 0 || v > 1) return false;
    let px = Math.floor(u * mask.w); if (px >= mask.w) px = mask.w - 1; if (px < 0) px = 0;
    let py = Math.floor((1 - v) * mask.h); if (py >= mask.h) py = mask.h - 1; if (py < 0) py = 0;
    const lum = mask.data[py * mask.w + px];
    return mask.invert ? lum >= mask.threshold : lum < mask.threshold;
  }

  window.Decal = { frame, uv, sampleMask };
})();
