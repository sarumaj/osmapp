/**
 * coverage.js - a boolean raster over a lng/lat box, and the rings around
 * whatever is marked in it.
 *
 * This exists because the shape of "where the buildings actually are" cannot
 * be computed the obvious way. The obvious way is turf.buffer() per building
 * followed by turf.union() over the results, and on a real village that is a
 * few thousand buffers and a few thousand sequential polygon unions - tens of
 * seconds at best, and a browser tab that stops answering at worst. The trim
 * tool needs that shape on every drag of a slider.
 *
 * A raster does the same job in one pass over a fixed number of cells:
 * stamping a disc is arithmetic, the union is free (a cell is either marked or
 * not), and the boundary falls out of a single sweep. The price is that the
 * result is a staircase at cell resolution, which does not matter here - the
 * ring is simplified and then snapped onto streets afterwards, so a ten-meter
 * staircase is finer than the thing that replaces it.
 *
 * Two properties are relied on by App.trim and worth stating:
 *
 *   - The marked region contains the full disc of radius R around every point
 *     that was stamped, so every stamped point is at least R away from the
 *     boundary. That is what lets the trim tool move the boundary afterwards
 *     - onto a street, along a routed path - and still know, without
 *     re-testing, that it has not walked over a building.
 *   - Components are 4-connected, and ringsOf(label) returns exactly one
 *     exterior ring per component. Two clusters of houses that only touch
 *     diagonally are two places, not one, and a boundary that pinches to a
 *     single point is not a boundary anyone can walk.
 *
 * Everything here is plain arithmetic on arrays: no turf, no Leaflet, no DOM.
 */
var App = window.App || {};

App.coverage = (function () {
  "use strict";

  var M_PER_DEG_LAT = 110540;
  var M_PER_DEG_LNG = 111320;

  function lngScale(lat) {
    return M_PER_DEG_LNG * Math.cos((lat * Math.PI) / 180);
  }

  /**
   * @param {number[]} bbox [west, south, east, north]
   * @param {Object} [opts]
   * @param {number} [opts.cell=10] target cell edge in meters
   * @param {number} [opts.pad=0] meters of margin added around the bbox, so a
   *   stamp near the edge closes its own ring instead of being clipped into a
   *   straight artefact along the raster border
   * @param {number} [opts.maxCells=400000] budget; the cell grows until the
   *   raster fits, because a coarser answer now beats a finer one that arrives
   *   after the slider has moved again
   */
  function Raster(bbox, opts) {
    opts = opts || {};
    var maxCells = opts.maxCells || 400000;
    var pad = opts.pad || 0;
    var cell = Math.max(1, opts.cell || 10);

    var midLat = (bbox[1] + bbox[3]) / 2;
    this.kx = lngScale(midLat) || M_PER_DEG_LNG;

    var widthM = Math.max(0, (bbox[2] - bbox[0]) * this.kx) + 2 * pad;
    var heightM = Math.max(0, (bbox[3] - bbox[1]) * M_PER_DEG_LAT) + 2 * pad;

    var w, h;
    for (;;) {
      w = Math.max(1, Math.ceil(widthM / cell));
      h = Math.max(1, Math.ceil(heightM / cell));
      if (w * h <= maxCells) break;
      cell *= 1.5;
    }

    this.cell = cell;
    this.w = w;
    this.h = h;
    this.dLng = cell / this.kx;
    this.dLat = cell / M_PER_DEG_LAT;
    this.west = bbox[0] - pad / this.kx;
    this.south = bbox[1] - pad / M_PER_DEG_LAT;

    this.mask = new Uint8Array(w * h);
    this.marked = 0;
    this.labels = null;
    this.sizes = null;
  }

  // Writing

  Raster.prototype.cellOf = function (coord) {
    return [
      Math.floor((coord[0] - this.west) / this.dLng),
      Math.floor((coord[1] - this.south) / this.dLat),
    ];
  };

  Raster.prototype.get = function (x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.mask[y * this.w + x];
  };

  Raster.prototype.set = function (x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    var i = y * this.w + x;
    if (this.mask[i]) return false;
    this.mask[i] = 1;
    this.marked++;
    this.labels = null;
    return true;
  };

  /**
   * Mark every cell whose center lies within radiusM of coord, plus the cell
   * the coord itself falls in - a radius under half a cell must still leave a
   * mark, or a lone building would vanish from its own shape.
   */
  Raster.prototype.stampDisc = function (coord, radiusM) {
    var c = this.cellOf(coord);
    this.set(c[0], c[1]);

    var r = (radiusM || 0) / this.cell;
    if (r <= 0) return;
    var rr = r * r;
    var span = Math.ceil(r) + 1;

    // Where the coord sits inside its own cell, in cell units.
    var fx = (coord[0] - this.west) / this.dLng - c[0];
    var fy = (coord[1] - this.south) / this.dLat - c[1];

    for (var dy = -span; dy <= span; dy++) {
      var ey = dy + 0.5 - fy;
      var rowLimit = rr - ey * ey;
      if (rowLimit < 0) continue;
      var reach = Math.sqrt(rowLimit);
      var from = Math.ceil(fx - 0.5 - reach);
      var to = Math.floor(fx - 0.5 + reach);
      for (var dx = from; dx <= to; dx++) this.set(c[0] + dx, c[1] + dy);
    }
  };

  /**
   * Mark a corridor along a polyline.
   *
   * Stamped as overlapping discs rather than as a swept rectangle, because a
   * disc is the one primitive here that is already known to be correct and the
   * corners of a polyline are where a swept quad would leave a notch. The step
   * is half a cell, so consecutive discs always share cells and the corridor
   * comes out 4-connected - which is the entire reason to draw one.
   *
   * The taper is a single linear ramp from one end of the path to the other,
   * which is what makes the corridor read as a wedge rather than as plumbing.
   * A cone from the settlement down to the building it reaches is the shape a
   * peninsula actually has; widening both ends instead leaves a long link
   * looking like a wire with a trumpet soldered to each end, three shapes
   * where the ground has one.
   *
   * @param {number[][]} coords [lng, lat] pairs
   * @param {number} radiusM the default width; never less than a cell, or the
   *   corridor would be a dotted line the component labeler reads as separate
   *   places
   * @param {{start: number, end: number}} [taper] radius at coords[0] and at
   *   the last coord, interpolated by distance traveled in between
   */
  Raster.prototype.stampPath = function (coords, radiusM, taper) {
    if (!coords || coords.length === 0) return;
    var narrow = Math.max(radiusM || 0, this.cell);
    var step = this.cell / 2;

    var total = this.pathLength(coords);
    var self = this;

    function radiusAt(traveled) {
      if (!taper || total <= 0) return narrow;
      var t = Math.max(0, Math.min(1, traveled / total));
      return Math.max(narrow, taper.start + (taper.end - taper.start) * t);
    }

    this.stampDisc(coords[0], radiusAt(0));
    var traveled = 0;

    for (var i = 0; i < coords.length - 1; i++) {
      var a = coords[i];
      var b = coords[i + 1];
      var length = this.meters(a, b);
      var steps = Math.max(1, Math.ceil(length / step));
      for (var t = 1; t <= steps; t++) {
        var at = [
          a[0] + ((b[0] - a[0]) * t) / steps,
          a[1] + ((b[1] - a[1]) * t) / steps,
        ];
        self.stampDisc(at, radiusAt(traveled + (length * t) / steps));
      }
      traveled += length;
    }
  };

  /** Ground distance between two [lng, lat] coords, on this raster's scale. */
  Raster.prototype.meters = function (a, b) {
    var dx = (b[0] - a[0]) * this.kx;
    var dy = (b[1] - a[1]) * M_PER_DEG_LAT;
    return Math.sqrt(dx * dx + dy * dy);
  };

  Raster.prototype.pathLength = function (coords) {
    var total = 0;
    for (var i = 0; i < coords.length - 1; i++)
      total += this.meters(coords[i], coords[i + 1]);
    return total;
  };

  // Filling and routing

  /**
   * Mark every cell whose center falls inside a polygon.
   *
   * Scanline with the even-odd rule, so holes come out unmarked without being
   * treated as a special case - an interior ring is just more crossings on the
   * rows it spans.
   *
   * This exists so a corridor can be asked to stay inside the working
   * boundary. Testing cells one at a time with a point-in-polygon call is a
   * few hundred thousand ring walks; a scanline is one pass over the edges per
   * row.
   *
   * @param {number[][][]} rings GeoJSON Polygon coordinates: exterior first
   */
  Raster.prototype.fillPolygon = function (rings) {
    if (!rings || !rings.length) return;

    // Edges in cell space, so the row loop is integer arithmetic.
    var edges = [];
    var self = this;
    rings.forEach(function (ring) {
      for (var i = 0; i < ring.length - 1; i++) {
        var ax = (ring[i][0] - self.west) / self.dLng;
        var ay = (ring[i][1] - self.south) / self.dLat;
        var bx = (ring[i + 1][0] - self.west) / self.dLng;
        var by = (ring[i + 1][1] - self.south) / self.dLat;
        if (ay === by) continue; // horizontal edges cross no scanline
        edges.push({ ax: ax, ay: ay, bx: bx, by: by });
      }
    });
    if (!edges.length) return;

    for (var row = 0; row < this.h; row++) {
      var y = row + 0.5;
      var crossings = [];
      for (var e = 0; e < edges.length; e++) {
        var edge = edges[e];
        var lo = Math.min(edge.ay, edge.by);
        var hi = Math.max(edge.ay, edge.by);
        if (y < lo || y >= hi) continue;
        crossings.push(
          edge.ax + ((y - edge.ay) * (edge.bx - edge.ax)) / (edge.by - edge.ay),
        );
      }
      if (crossings.length < 2) continue;
      crossings.sort(function (a, b) {
        return a - b;
      });
      for (var c = 0; c + 1 < crossings.length; c += 2) {
        var from = Math.ceil(crossings[c] - 0.5);
        var to = Math.floor(crossings[c + 1] - 0.5);
        for (var x = from; x <= to; x++) this.set(x, row);
      }
    }
  };

  /**
   * Shortest 4-connected path between two coords, travelling only over marked
   * cells.
   *
   * A breadth-first search rather than anything cleverer: the grid is uniform,
   * so every step costs the same and BFS is already optimal, and the whole
   * point is to have an answer that cannot fail when one exists. Which is the
   * property being bought here - a corridor drawn as a straight line stops at
   * the first place the working boundary bends away from it, and the group it
   * was meant to reach is left stranded outside.
   *
   * Endpoints are snapped to the nearest marked cell, because a building whose
   * center sits a meter outside the fill is still a building inside the area.
   *
   * @returns {number[][]|null} cell centers as [lng, lat], endpoints included
   */
  Raster.prototype.route = function (fromCoord, toCoord) {
    var start = this._snapCell(fromCoord);
    var goal = this._snapCell(toCoord);
    if (start < 0 || goal < 0) return null;
    if (start === goal) return [this._center(start)];

    var w = this.w;
    var size = w * this.h;
    var prev = new Int32Array(size).fill(-1);
    var queue = new Int32Array(size);
    var head = 0;
    var tail = 0;

    queue[tail++] = start;
    prev[start] = start;

    while (head < tail) {
      var i = queue[head++];
      if (i === goal) break;
      var x = i % w;

      if (x > 0) tail = this._step(i - 1, i, prev, queue, tail);
      if (x < w - 1) tail = this._step(i + 1, i, prev, queue, tail);
      if (i >= w) tail = this._step(i - w, i, prev, queue, tail);
      if (i + w < size) tail = this._step(i + w, i, prev, queue, tail);
    }

    if (prev[goal] < 0) return null;

    var path = [];
    var node = goal;
    for (;;) {
      path.unshift(this._center(node));
      if (node === start) break;
      node = prev[node];
    }
    return path;
  };

  Raster.prototype._step = function (next, from, prev, queue, tail) {
    if (this.mask[next] && prev[next] < 0) {
      prev[next] = from;
      queue[tail++] = next;
    }
    return tail;
  };

  /**
   * Is the straight line from a to b entirely over marked cells?
   *
   * Sampled every half cell rather than walked exactly. A supercover line
   * would be exact, but the answer is being used to decide whether a corridor
   * may go straight, and a corridor is stamped as discs at least a cell wide --
   * so a single cell of disagreement at a corner cannot change the outcome.
   */
  Raster.prototype.visible = function (a, b) {
    var length = this.meters(a, b);
    var steps = Math.max(1, Math.ceil((length * 2) / this.cell));
    for (var i = 0; i <= steps; i++) {
      var t = i / steps;
      var c = this.cellOf([
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
      ]);
      if (!this.get(c[0], c[1])) return false;
    }
    return true;
  };

  /**
   * Pull a path straight wherever it can see past its own corners.
   *
   * A grid search returns a staircase: every turn is a right angle and every
   * leg is one cell long. Stamped as a corridor that is a visibly synthetic
   * shape, and simplifying it afterwards with Douglas-Peucker would cut the
   * corners it was routed around in the first place.
   *
   * String-pulling instead: walk forward from each kept vertex to the furthest
   * one still in line of sight over marked ground, and drop everything
   * between. What comes back is the same route expressed as the few straight
   * legs a person would have described it in.
   */
  Raster.prototype.simplifyPath = function (coords) {
    if (!coords || coords.length < 3) return coords || [];
    var out = [coords[0]];
    var anchor = 0;

    while (anchor < coords.length - 1) {
      var furthest = anchor + 1;
      for (var i = coords.length - 1; i > anchor + 1; i--) {
        if (this.visible(coords[anchor], coords[i])) {
          furthest = i;
          break;
        }
      }
      out.push(coords[furthest]);
      anchor = furthest;
    }
    return out;
  };

  Raster.prototype._center = function (index) {
    var x = index % this.w;
    var y = (index - x) / this.w;
    return [
      this.west + (x + 0.5) * this.dLng,
      this.south + (y + 0.5) * this.dLat,
    ];
  };

  /** Index of the marked cell nearest a coord, searching outward a little. */
  Raster.prototype._snapCell = function (coord) {
    var c = this.cellOf(coord);
    for (var ring = 0; ring <= 4; ring++) {
      for (var dy = -ring; dy <= ring; dy++) {
        for (var dx = -ring; dx <= ring; dx++) {
          if (ring > 0 && Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          var x = c[0] + dx;
          var y = c[1] + dy;
          if (x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
          if (this.mask[y * this.w + x]) return y * this.w + x;
        }
      }
    }
    return -1;
  };

  // Components

  /**
   * Label 4-connected components, 1..n. Unmarked cells get 0.
   * @returns {{labels: Int32Array, sizes: number[]}} sizes is indexed by label
   */
  Raster.prototype.components = function () {
    if (this.labels) return { labels: this.labels, sizes: this.sizes };

    var w = this.w;
    var h = this.h;
    var labels = new Int32Array(w * h);
    var sizes = [0];
    var stack = new Int32Array(w * h);

    for (var start = 0; start < labels.length; start++) {
      if (!this.mask[start] || labels[start]) continue;
      var label = sizes.length;
      var size = 0;
      var top = 0;
      stack[top++] = start;
      labels[start] = label;

      while (top > 0) {
        var i = stack[--top];
        size++;
        var x = i % w;
        var y = (i - x) / w;
        if (x > 0 && this.mask[i - 1] && !labels[i - 1]) {
          labels[i - 1] = label;
          stack[top++] = i - 1;
        }
        if (x < w - 1 && this.mask[i + 1] && !labels[i + 1]) {
          labels[i + 1] = label;
          stack[top++] = i + 1;
        }
        if (y > 0 && this.mask[i - w] && !labels[i - w]) {
          labels[i - w] = label;
          stack[top++] = i - w;
        }
        if (y < h - 1 && this.mask[i + w] && !labels[i + w]) {
          labels[i + w] = label;
          stack[top++] = i + w;
        }
      }
      sizes.push(size);
    }

    this.labels = labels;
    this.sizes = sizes;
    return { labels: labels, sizes: sizes };
  };

  /** Component label under a coord, or 0 for unmarked or off the raster. */
  Raster.prototype.labelAt = function (coord) {
    var c = this.cellOf(coord);
    if (c[0] < 0 || c[1] < 0 || c[0] >= this.w || c[1] >= this.h) return 0;
    return this.components().labels[c[1] * this.w + c[0]];
  };

  // Rings

  /**
   * Trace the boundary of the marked region as closed rings of [lng, lat].
   *
   * Each marked cell contributes one directed edge per side whose neighbor is
   * unmarked, oriented so the marked side is on the left. Chaining those edges
   * gives counter-clockwise exteriors (positive shoelace area) and clockwise
   * holes.
   *
   * At a vertex where two components touch corner to corner there are two ways
   * to continue. Taking the most counter-clockwise turn keeps the two apart,
   * which is what makes components 4-connected; taking the other one would
   * fuse them into a single ring pinched to a point.
   *
   * @param {number} [label] restrict to one component from components()
   * @returns {{exteriors: Array<Array<number[]>>, holes: Array<Array<number[]>>}}
   */
  Raster.prototype.ringsOf = function (label) {
    var w = this.w;
    var h = this.h;
    var vw = w + 1;
    var mask = this.mask;
    var labels = label ? this.components().labels : null;

    function on(x, y) {
      if (x < 0 || y < 0 || x >= w || y >= h) return false;
      var i = y * w + x;
      return labels ? labels[i] === label : !!mask[i];
    }

    var edges = new Map();

    function add(ax, ay, bx, by) {
      var key = ay * vw + ax;
      var list = edges.get(key);
      if (!list) edges.set(key, (list = []));
      list.push({ x: bx, y: by, dx: bx - ax, dy: by - ay, used: false });
    }

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (!on(x, y)) continue;
        if (!on(x, y - 1)) add(x, y, x + 1, y);
        if (!on(x + 1, y)) add(x + 1, y, x + 1, y + 1);
        if (!on(x, y + 1)) add(x + 1, y + 1, x, y + 1);
        if (!on(x - 1, y)) add(x, y + 1, x, y);
      }
    }

    /** The most counter-clockwise unused continuation at (x, y). */
    function next(x, y, dx, dy) {
      var list = edges.get(y * vw + x);
      if (!list) return null;
      var best = null;
      var bestTurn = -Infinity;
      for (var i = 0; i < list.length; i++) {
        var e = list[i];
        if (e.used) continue;
        var cross = dx * e.dy - dy * e.dx;
        var dot = dx * e.dx + dy * e.dy;
        // atan2 ordered CCW from straight-on; a reversal scores highest and is
        // never the intended continuation, so it is pushed to the bottom.
        var turn = dot === -1 && cross === 0 ? -Infinity : Math.atan2(cross, dot);
        if (turn > bestTurn) {
          bestTurn = turn;
          best = e;
        }
      }
      return best;
    }

    var self = this;
    var exteriors = [];
    var holes = [];
    var limit = 0;
    edges.forEach(function (list) {
      limit += list.length;
    });

    edges.forEach(function (list, key) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].used) continue;
        var ring = walk(key, list[i]);
        if (!ring) continue;
        (signedArea(ring) > 0 ? exteriors : holes).push(self._toCoords(ring));
      }
    });

    function walk(startKey, first) {
      var sx = startKey % vw;
      var sy = (startKey - sx) / vw;
      var points = [[sx, sy]];
      var e = first;
      var guard = 0;

      while (e && guard++ <= limit) {
        e.used = true;
        points.push([e.x, e.y]);
        if (e.x === sx && e.y === sy) return points.length >= 4 ? points : null;
        e = next(e.x, e.y, e.dx, e.dy);
      }
      return null;
    }

    return { exteriors: exteriors, holes: holes };
  };

  /** Cell-vertex ring to [lng, lat], with collinear runs collapsed. */
  Raster.prototype._toCoords = function (ring) {
    var kept = collapse(ring);
    var west = this.west;
    var south = this.south;
    var dLng = this.dLng;
    var dLat = this.dLat;
    return kept.map(function (p) {
      return [west + p[0] * dLng, south + p[1] * dLat];
    });
  };

  /**
   * Drop the middle of every straight run. A staircase ring has four vertices
   * per step and only the corners carry information; leaving them in makes
   * every downstream simplify and point-in-polygon test several times the work
   * for a shape that is identical.
   */
  function collapse(ring) {
    var closed =
      ring.length > 1 &&
      ring[0][0] === ring[ring.length - 1][0] &&
      ring[0][1] === ring[ring.length - 1][1];
    var body = closed ? ring.slice(0, -1) : ring.slice();
    if (body.length < 3) return ring.slice();

    var out = [];
    for (var i = 0; i < body.length; i++) {
      var prev = body[(i - 1 + body.length) % body.length];
      var cur = body[i];
      var nxt = body[(i + 1) % body.length];
      var ax = cur[0] - prev[0];
      var ay = cur[1] - prev[1];
      var bx = nxt[0] - cur[0];
      var by = nxt[1] - cur[1];
      if (ax * by - ay * bx !== 0) out.push(cur);
    }
    if (out.length < 3) out = body;
    out.push(out[0]);
    return out;
  }

  /** Shoelace, in whatever units the ring is in. Positive is counter-clockwise. */
  function signedArea(ring) {
    var sum = 0;
    for (var i = 0; i < ring.length - 1; i++) {
      sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    return sum / 2;
  }

  return {
    Raster: Raster,
    signedArea: signedArea,
    collapse: collapse,
    lngScale: lngScale,
    M_PER_DEG_LAT: M_PER_DEG_LAT,
  };
})();

window.App = App;
