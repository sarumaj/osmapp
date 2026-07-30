/**
 * spatial.js — one uniform-grid index reused everywhere the app currently
 * does a linear scan over every street node or segment.
 *
 * Replaces:
 *   snap.js          buildSnapGrid / getNearbySegmentIndices   (bespoke copy)
 *   editing.js       _nearestStreetNode, _snapToStreetWithKind (O(n) per mousemove)
 *   clustering.js    _nearestGraphNode                         (O(n) per lookup, ×10)
 *
 * Also exports fast planar distance helpers. turf.distance() runs a full
 * haversine plus a unit conversion on every call; inside A* and nearest-node
 * loops that dominates the runtime. Over a city-sized bbox the equirectangular
 * approximation is accurate to well under a metre, which is far below the
 * precision anything here needs.
 */
var App = window.App || {};

App.spatial = (function () {
  "use strict";

  var M_PER_DEG_LAT = 110540;
  var M_PER_DEG_LNG = 111320;

  /** Metres per degree of longitude at a given latitude. */
  function lngScale(lat) {
    return M_PER_DEG_LNG * Math.cos((lat * Math.PI) / 180);
  }

  /** Squared planar distance in metres between two [lng, lat] coords. */
  function distSq(a, b) {
    var kx = lngScale((a[1] + b[1]) / 2);
    var dx = (a[0] - b[0]) * kx;
    var dy = (a[1] - b[1]) * M_PER_DEG_LAT;
    return dx * dx + dy * dy;
  }

  /** Planar distance in metres between two [lng, lat] coords. */
  function dist(a, b) {
    return Math.sqrt(distSq(a, b));
  }

  /** Bearing in degrees from a to b, [lng, lat] coords. */
  function bearing(a, b) {
    var kx = lngScale((a[1] + b[1]) / 2);
    return (
      (Math.atan2((b[0] - a[0]) * kx, (b[1] - a[1]) * M_PER_DEG_LAT) * 180) /
      Math.PI
    );
  }

  /**
   * Uniform grid over lng/lat.
   * @param {number} cellMeters approximate cell edge length
   */
  function Grid(cellMeters) {
    this.cell = (cellMeters || 100) / M_PER_DEG_LAT; // degrees
    this.buckets = new Map();
    this.items = [];
  }

  Grid.prototype._key = function (cx, cy) {
    return cx * 1e7 + cy;
  };

  Grid.prototype._push = function (cx, cy, idx) {
    var k = this._key(cx, cy);
    var b = this.buckets.get(k);
    if (b) b.push(idx);
    else this.buckets.set(k, [idx]);
  };

  /** Index a point payload at [lng, lat]. */
  Grid.prototype.addPoint = function (coord, payload) {
    var idx = this.items.length;
    this.items.push({ coord: coord, payload: payload });
    this._push(
      Math.floor(coord[0] / this.cell),
      Math.floor(coord[1] / this.cell),
      idx,
    );
    return idx;
  };

  /** Index a segment payload spanning a..b, stamping every cell it crosses. */
  Grid.prototype.addSegment = function (a, b, payload) {
    var idx = this.items.length;
    this.items.push({ a: a, b: b, payload: payload });
    var c = this.cell;
    var x0 = Math.floor(Math.min(a[0], b[0]) / c);
    var x1 = Math.floor(Math.max(a[0], b[0]) / c);
    var y0 = Math.floor(Math.min(a[1], b[1]) / c);
    var y1 = Math.floor(Math.max(a[1], b[1]) / c);
    for (var cx = x0; cx <= x1; cx++) {
      for (var cy = y0; cy <= y1; cy++) this._push(cx, cy, idx);
    }
    return idx;
  };

  /**
   * Candidate item indices within `ring` cells of a coord.
   * Deduplicated; order is not meaningful.
   */
  Grid.prototype.candidates = function (coord, ring) {
    ring = ring || 1;
    var c = this.cell;
    var cx = Math.floor(coord[0] / c);
    var cy = Math.floor(coord[1] / c);
    var seen = new Set();
    var out = [];
    for (var dx = -ring; dx <= ring; dx++) {
      for (var dy = -ring; dy <= ring; dy++) {
        var b = this.buckets.get(this._key(cx + dx, cy + dy));
        if (!b) continue;
        for (var i = 0; i < b.length; i++) {
          if (!seen.has(b[i])) {
            seen.add(b[i]);
            out.push(b[i]);
          }
        }
      }
    }
    return out;
  };

  /**
   * Nearest indexed point to `coord`, searching outward in cell rings until
   * something is found or maxMeters is exceeded.
   * @returns {{payload:*, coord:number[], dist:number}|null}
   */
  Grid.prototype.nearestPoint = function (coord, maxMeters) {
    maxMeters = maxMeters || 500;
    var maxRing = Math.max(
      1,
      Math.ceil(maxMeters / (this.cell * M_PER_DEG_LAT)),
    );
    var best = null;
    var bestD2 = maxMeters * maxMeters;

    for (var ring = 1; ring <= maxRing; ring++) {
      var candidates = this.candidates(coord, ring);
      for (var i = 0; i < candidates.length; i++) {
        var it = this.items[candidates[i]];
        if (!it.coord) continue;
        var d2 = distSq(coord, it.coord);
        if (d2 < bestD2) {
          bestD2 = d2;
          best = it;
        }
      }
      // A hit at ring R can still be beaten by something at ring R+1, so
      // widen once more before committing.
      if (best && ring > 1) break;
    }

    return best
      ? { payload: best.payload, coord: best.coord, dist: Math.sqrt(bestD2) }
      : null;
  };

  /** Closest point on segment a-b to p, all [lng, lat]. */
  function closestOnSegment(p, a, b) {
    var kx = lngScale(p[1]);
    var ax = a[0] * kx,
      ay = a[1] * M_PER_DEG_LAT;
    var bx = b[0] * kx,
      by = b[1] * M_PER_DEG_LAT;
    var px = p[0] * kx,
      py = p[1] * M_PER_DEG_LAT;
    var dx = bx - ax,
      dy = by - ay;
    var len2 = dx * dx + dy * dy;
    if (len2 === 0) return { coord: a, dist: dist(p, a) };
    var t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    var qx = ax + t * dx,
      qy = ay + t * dy;
    var ex = px - qx,
      ey = py - qy;
    return {
      coord: [qx / kx, qy / M_PER_DEG_LAT],
      dist: Math.sqrt(ex * ex + ey * ey),
    };
  }

  /**
   * Nearest indexed segment to `coord`.
   * @returns {{payload:*, coord:number[], dist:number}|null}
   */
  Grid.prototype.nearestSegment = function (coord, maxMeters) {
    maxMeters = maxMeters || 200;
    var maxRing = Math.max(
      1,
      Math.ceil(maxMeters / (this.cell * M_PER_DEG_LAT)),
    );
    var best = null;
    var bestD = maxMeters;

    for (var ring = 1; ring <= maxRing; ring++) {
      var candidates = this.candidates(coord, ring);
      for (var i = 0; i < candidates.length; i++) {
        var it = this.items[candidates[i]];
        if (!it.a) continue;
        var hit = closestOnSegment(coord, it.a, it.b);
        if (hit.dist < bestD) {
          bestD = hit.dist;
          best = { payload: it.payload, coord: hit.coord, dist: hit.dist };
        }
      }
      if (best && ring > 1) break;
    }
    return best;
  };

  /**
   * Binary min-heap keyed on `f`. Used by the A* in clustering.js and the
   * Dijkstra in editing.js, both of which previously scanned or re-sorted the
   * whole frontier on every pop.
   */
  function MinHeap() {
    this.a = [];
  }

  MinHeap.prototype.size = function () {
    return this.a.length;
  };

  MinHeap.prototype.push = function (item) {
    var a = this.a;
    a.push(item);
    var i = a.length - 1;
    while (i > 0) {
      var p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      var t = a[p];
      a[p] = a[i];
      a[i] = t;
      i = p;
    }
  };

  MinHeap.prototype.pop = function () {
    var a = this.a;
    if (a.length === 0) return null;
    var top = a[0];
    var last = a.pop();
    if (a.length) {
      a[0] = last;
      var i = 0;
      for (;;) {
        var l = 2 * i + 1,
          r = l + 1,
          m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        var t = a[m];
        a[m] = a[i];
        a[i] = t;
        i = m;
      }
    }
    return top;
  };

  return {
    Grid: Grid,
    MinHeap: MinHeap,
    dist: dist,
    distSq: distSq,
    bearing: bearing,
    lngScale: lngScale,
    closestOnSegment: closestOnSegment,
    M_PER_DEG_LAT: M_PER_DEG_LAT,
    M_PER_DEG_LNG: M_PER_DEG_LNG,
  };
})();

window.App = App;
