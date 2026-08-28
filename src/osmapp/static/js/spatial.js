/**
 * spatial.js - a spatial index, a priority queue, and fast distance helpers.
 *
 * Two data structures and a handful of arithmetic functions, none of which
 * know anything about the app. Everything here works on plain `[lng, lat]`
 * coordinate pairs: no Leaflet layers, no GeoJSON features, no turf.
 *
 * The grid
 *
 * `Grid` answers "what is near this point" without looking at everything.
 * The alternative is a linear scan, and the questions asked here are asked
 * constantly - snapping a vertex to the nearest street runs on every pointer
 * move, and finding the nearest graph node runs on every step of a route
 * search - so with a city's worth of streets a scan is the dominant cost.
 *
 * The index is a uniform grid rather than a tree because the data is street
 * geometry, which is spread fairly evenly across the area being worked on.
 * That is the case where uniform cells behave well, and they are far simpler
 * to build and cheaper to rebuild than a balanced structure.
 *
 * Distances
 *
 * dist() and distSq() use an equirectangular approximation: latitude and
 * longitude are scaled to meters and then treated as a flat plane. That is
 * accurate to well under a meter over an area the size of a city, which is far
 * finer than anything here needs. turf.distance() computes a full haversine
 * and a unit conversion per call, and inside these loops that cost dominates.
 *
 * Prefer distSq() over dist() when only comparing distances to each other, as
 * it avoids a square root per comparison.
 */
var App = window.App || {};

App.spatial = (function () {
  "use strict";

  var M_PER_DEG_LAT = 110540;
  var M_PER_DEG_LNG = 111320;

  /**
   * Meters per degree of longitude at a given latitude.
   *
   * Meridians converge toward the poles, so a degree of longitude is about
   * 111 km at the equator and shrinks with the cosine of the latitude. A
   * degree of latitude does not vary in the same way, hence the single
   * M_PER_DEG_LAT constant.
   */
  function lngScale(lat) {
    return M_PER_DEG_LNG * Math.cos((lat * Math.PI) / 180);
  }

  /**
   * Squared distance in meters between two [lng, lat] coords.
   *
   * The longitude scale is taken at the midpoint latitude of the pair, which
   * keeps the approximation symmetric - d(a, b) and d(b, a) agree exactly.
   */
  function distSq(a, b) {
    var kx = lngScale((a[1] + b[1]) / 2);
    var dx = (a[0] - b[0]) * kx;
    var dy = (a[1] - b[1]) * M_PER_DEG_LAT;
    return dx * dx + dy * dy;
  }

  /** Distance in meters between two [lng, lat] coords. */
  function dist(a, b) {
    return Math.sqrt(distSq(a, b));
  }

  /**
   * Bearing from a to b in degrees, measured clockwise from north.
   *
   * @returns {number} in the range (-180, 180]
   */
  function bearing(a, b) {
    var kx = lngScale((a[1] + b[1]) / 2);
    return (
      (Math.atan2((b[0] - a[0]) * kx, (b[1] - a[1]) * M_PER_DEG_LAT) * 180) /
      Math.PI
    );
  }

  /**
   * A uniform grid index over lng/lat coordinates.
   *
   * Items are added with addPoint() or addSegment(). Each carries the caller's
   * own payload, returned by the nearest* queries; candidates() and shell()
   * return insertion indices into `items` instead.
   *
   * Cells are keyed lazily in a plain object, so an empty region costs
   * nothing and the grid needs no bounds up front.
   *
   * Cell size is the one tuning decision: too small and a query walks many
   * cells, too large and each cell holds too many items to filter. A cell of
   * roughly the spacing of the data is a good default.
   *
   * @param {number} cellMeters approximate cell edge length
   */
  function Grid(cellMeters) {
    this.cell = (cellMeters || 100) / M_PER_DEG_LAT; // degrees
    this.buckets = new Map();
    this.items = [];
  }

  /**
   * How far, in meters, scanning shells 0..ring is guaranteed to have
   * reached: nothing left unscanned is nearer than this.
   *
   * Cells are square in degrees, and a degree of longitude is shorter than a
   * degree of latitude everywhere but the equator - a 120 m cell is 74 m wide
   * at 52 degrees north. A ring is therefore worth its narrowest side, and
   * measuring it by the latitude side alone stops an outward search short of
   * maxMeters to the east and to the west.
   */
  Grid.prototype._ringReachM = function (lat) {
    return this.cell * Math.min(M_PER_DEG_LAT, lngScale(lat));
  };

  Grid.prototype._key = function (cx, cy) {
    return cx * 1e7 + cy;
  };

  Grid.prototype._push = function (cx, cy, idx) {
    var k = this._key(cx, cy);
    var b = this.buckets.get(k);
    if (b) b.push(idx);
    else this.buckets.set(k, [idx]);
  };

  /**
   * Index a payload at one coordinate.
   *
   * @returns {number} the item's index, as returned by the query methods
   */
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

  /**
   * Index a payload spanning the segment a..b.
   *
   * The segment is stamped into every cell of its bounding box rather than
   * only into the cells holding its endpoints, so a street longer than a cell
   * is still found from a point in the middle of it. A diagonal is therefore
   * indexed in cells it does not actually cross, which costs a query some
   * candidates to reject and never costs it an answer.
   *
   * @returns {number} the item's index
   */
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
   * Every item indexed within `ring` cells of a coord, in any direction.
   *
   * These are candidates rather than answers: an item in a neighboring cell
   * may still be farther away than the cell size, so the caller is expected to
   * measure. Results are deduplicated and their order carries no meaning.
   *
   * @returns {number[]} item indices
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
   * The nearest indexed point to `coord`.
   *
   * Searches outward one cell ring at a time and stops as soon as it can, so
   * the cost depends on how far away the nearest item is rather than on how
   * many items exist.
   *
   * @param {number[]} coord [lng, lat]
   * @param {number} maxMeters give up beyond this distance
   * @returns {{payload:*, coord:number[], dist:number}|null} null when nothing
   *   is indexed within maxMeters
   */
  Grid.prototype.nearestPoint = function (coord, maxMeters) {
    maxMeters = maxMeters || 500;
    var reach = this._ringReachM(coord[1]);
    // The nearest side of the first unscanned cell is one ring closer than
    // its index suggests, because the query point sits somewhere inside its
    // own cell rather than at the center of it. The extra ring is what makes
    // maxMeters a distance rather than an approximation of one.
    var maxRing = Math.ceil(maxMeters / reach) + 1;
    var best = null;
    var bestD2 = maxMeters * maxMeters;
    var seen = new Set();

    for (var ring = 0; ring <= maxRing; ring++) {
      var candidates = this.shell(coord, ring);
      for (var i = 0; i < candidates.length; i++) {
        if (seen.has(candidates[i])) continue;
        seen.add(candidates[i]);
        var it = this.items[candidates[i]];
        if (!it.coord) continue;
        var d2 = distSq(coord, it.coord);
        if (d2 < bestD2) {
          bestD2 = d2;
          best = it;
        }
      }
      // A hit found in ring R is not necessarily the nearest one: the
      // diagonal corner of ring R is farther away than the near side of ring
      // R + 1, so an item out there can still win. Only a hit inside the
      // reach of the rings already scanned can be committed to.
      var bound = ring * reach;
      if (best && bestD2 <= bound * bound) break;
    }
    return best ? { payload: best.payload, coord: best.coord, dist: Math.sqrt(bestD2) } : null;
  };

  /**
   * The point on segment a-b closest to p, all as [lng, lat].
   *
   * Used both for measuring how far a point lies from a street and for finding
   * where on that street to place a snapped vertex.
   *
   * @returns {{coord:number[], dist:number}}
   */
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
   * The nearest indexed segment to `coord`, and the point on it.
   *
   * @param {number[]} coord [lng, lat]
   * @param {number} maxMeters give up beyond this distance
   * @returns {{payload:*, coord:number[], dist:number}|null} `coord` is the
   *   closest point on the segment, not one of its endpoints
   */
  Grid.prototype.nearestSegment = function (coord, maxMeters) {
    maxMeters = maxMeters || 200;
    var reach = this._ringReachM(coord[1]);
    var maxRing = Math.ceil(maxMeters / reach) + 1;
    var best = null;
    var bestD = maxMeters;

    // The search starts at ring 0, which is the single cell containing the
    // coord. shell(coord, 1) is the eight cells *around* that one, so starting
    // at 1 would miss any segment lying entirely within the centre cell.
    // Street segments are usually long enough to stamp neighboring cells as
    // well and would be found regardless, but a chain of short segments - a
    // traced boundary ring, for instance - would not be.
    for (var ring = 0; ring <= maxRing; ring++) {
      var candidates = this.shell(coord, ring);
      for (var i = 0; i < candidates.length; i++) {
        var it = this.items[candidates[i]];
        if (!it.a) continue;
        var hit = closestOnSegment(coord, it.a, it.b);
        if (hit.dist < bestD) {
          bestD = hit.dist;
          best = { payload: it.payload, coord: hit.coord, dist: hit.dist };
        }
      }
      // Same stopping rule as nearestPoint: a farther ring can hold a nearer
      // segment until the best hit is inside the reach already scanned.
      if (best && bestD <= ring * reach) break;
    }
    return best;
  };

  /**
   * Every item indexed in the cells the segment a-b could touch, widened by
   * `pad` cells.
   *
   * Where nearestSegment() asks "what is close to this point", this asks "what
   * could this segment possibly cross", which is the question an intersection
   * test needs answered. Doing it without a grid means either sampling points
   * along the segment and querying each, or scanning everything.
   *
   * The bounding box of the segment is used, so a long diagonal returns items
   * near the corners it does not actually pass through; as with candidates(),
   * these are candidates the caller must still test.
   *
   * @returns {number[]} item indices, deduplicated and unordered
   */
  Grid.prototype.segmentCandidates = function (a, b, pad) {
    pad = pad || 0;
    var c = this.cell;
    var x0 = Math.floor(Math.min(a[0], b[0]) / c) - pad;
    var x1 = Math.floor(Math.max(a[0], b[0]) / c) + pad;
    var y0 = Math.floor(Math.min(a[1], b[1]) / c) - pad;
    var y1 = Math.floor(Math.max(a[1], b[1]) / c) + pad;
    var seen = new Set();
    var out = [];
    for (var cx = x0; cx <= x1; cx++) {
      for (var cy = y0; cy <= y1; cy++) {
        var bucket = this.buckets.get(this._key(cx, cy));
        if (!bucket) continue;
        for (var i = 0; i < bucket.length; i++) {
          if (seen.has(bucket[i])) continue;
          seen.add(bucket[i]);
          out.push(bucket[i]);
        }
      }
    }
    return out;
  };

  /**
   * Item indices in exactly the ring-th square shell of cells around coord.
   *
   * Ring 0 is the single cell containing the coord, ring 1 the eight cells
   * surrounding it, and so on. Only the shell is returned, not its interior,
   * so an outward search does not revisit cells it has already examined.
   */
  Grid.prototype.shell = function (coord, ring) {
    var c = this.cell;
    var cx = Math.floor(coord[0] / c);
    var cy = Math.floor(coord[1] / c);
    var self = this;
    var out = [];
    function take(kx, ky) {
      var b = self.buckets.get(self._key(kx, ky));
      if (b) for (var i = 0; i < b.length; i++) out.push(b[i]);
    }
    if (ring === 0) {
      take(cx, cy);
      return out;
    }
    for (var d = -ring; d <= ring; d++) {
      take(cx + d, cy - ring);
      take(cx + d, cy + ring);
      if (d > -ring && d < ring) {
        take(cx - ring, cy + d);
        take(cx + ring, cy + d);
      }
    }
    return out;
  };

  /**
   * A binary min-heap of `{ f, ... }` objects, ordered by the `f` property.
   *
   * This is the frontier for the route searches in network.js and
   * clustering.js, where `f` is the estimated total cost of a path. Both push and
   * pop are logarithmic in the size of the frontier, whereas keeping the
   * frontier in a sorted array costs a scan or a re-sort on every step, and
   * those searches pop thousands of times.
   *
   * Entries are not compared beyond `f`, so ties break arbitrarily.
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
      for (; ;) {
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
  };
})();

window.App = App;
