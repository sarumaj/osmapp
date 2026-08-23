/**
 * footprints.js - boundaries drawn through buildings, and putting them back
 * on the wall.
 *
 * clustering.js routes every Voronoi edge along the street network so that a
 * territory boundary is something you can stand on. The routing does not
 * always find one - no way snapped within ROUTE_SNAP_MAX_M, A* stopped on the
 * iteration cap, the endpoints on different components of the graph - and the
 * edge then stays the straight line the Voronoi diagram drew, across whatever
 * is standing there.
 *
 * A house split between two territories survives every check the app already
 * makes: the territories are connected, they cover everything, they have
 * buildings in them. None of those questions is about the building. Two cards
 * get printed showing the same roof, and each of the two people holding one
 * assumes the other half is somebody else's.
 *
 * The repair gives the building whole to one of the territories already
 * holding a piece of it and moves the boundary onto the building's own
 * outline - on it rather than near it, which is why the plain union is tried
 * before the healed one below. Which territory is a preference rather than a
 * rule: the one holding most of it, unless that would break the territory on
 * the other side. See _resolve.
 *
 * A footprint here means the building's outline with courtyards filled in,
 * since a boundary through a light well is no more walkable than one through
 * a wall. See _filled.
 *
 * What counts as crossed
 *
 * Two territories claiming a piece of the same footprint, where both pieces
 * are worth arguing about. A boundary that clips a corner by a hand's breadth
 * is a rounding artefact of the unions that built the territory, and repairing
 * it would rewrite half the map to no visible effect. A slice therefore counts
 * only at MIN_SLICE_M2 or more *and* MIN_SLICE_FRACTION or more of the
 * building: a metre of a garage and a fiftieth of a warehouse both qualify, a
 * graze does neither.
 *
 * Finding them without testing everything
 *
 * The direct test is an intersection per building per territory, which on a
 * city download is five thousand buildings against fifty territories - more
 * than turf's clipper can do while somebody waits.
 *
 * A boundary can only cut a building by crossing one of its walls, which is a
 * question about two line segments. So the buildings are binned by cell,
 * every territory ring is walked once, and each of its segments is tested
 * against the walls of the buildings in the cells it passes through. Only the
 * handful of footprints a line actually goes through are worth an
 * intersection. The join is exact - a segment is stamped into every cell its
 * own bounding box spans - so cell size trades speed only, never correctness.
 *
 * The intersections that remain are cut down before they are made: a whole
 * territory clipped against one house costs the territory's whole ring, and
 * almost none of that ring is anywhere near the house. See _slice.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.footprints = (function () {
  "use strict";

  var s = null;
  var G = null;

  // Below either of these the boundary grazed the footprint rather than cut
  // it. Both, not one: a fraction alone calls a 4 m2 shed cut in half a
  // crossing worth two unions, and an absolute alone calls a metre off the
  // corner of a supermarket one.
  var MIN_SLICE_M2 = 1;
  var MIN_SLICE_FRACTION = 0.02;

  // Cell edge for the building-against-boundary join, in degrees - about
  // 110 m north to south and rather less east to west, which is the scale of
  // a city block. The join is exact at any size; this only trades cells
  // walked against candidates filtered.
  var CELL_DEG = 0.001;

  // A bounding box spanning more cells than this - about 11 km square - is not
  // a building or a stretch of boundary, it is a coordinate that went wrong.
  // Stamping it would key a continent of empty buckets.
  var MAX_CELLS = 10000;

  // The same 0.5 m the rest of the app calls "touching". See autoheal.js.
  var TOUCH_SLACK_M = 0.5;

  // A hundredth of a square meter, which is five hundred times smaller than
  // the smallest piece anything in this app treats as a piece. Ground the
  // owner gains below this is ground it already had.
  var NOTHING_M2 = 0.01;

  // How far a clipping box is grown past the footprint it was taken from, so
  // that the clip cannot land exactly on a wall. About half a meter, which is
  // far more than the rounding it guards against and costs nothing: the box is
  // a scratch shape, and a larger one only carries a few more vertices.
  var PAD_DEG = 0.000005;

  // Fallback for state.CUT_MIN_PIECE_M2, which is the same number: what the
  // knife is allowed to shave off without anybody calling it a piece.
  var CRUMB_M2 = 5;

  // Prepared footprints and the cell index over them, plus the collection
  // they were taken from. See _prepare.
  var _prepared = null;
  var _preparedFor = null;

  function init() {
    s = App.state;
    G = App.geometry;
    App._loaded.push("footprints");
  }

  // THE BUILDINGS

  /**
   * A footprint with its courtyards filled in.
   *
   * What a boundary must not run through is the building's outline, and a
   * courtyard is inside it.
   *
   * Leaving the holes in also breaks the repair. Taking the footprint out of
   * the territory beside it leaves every courtyard behind as a polygon of its
   * own, so the territory comes back in several pieces and the repair is
   * refused for splitting it - as happened on a real project to a building
   * with three courtyards of about 300 m2 each.
   *
   * Filled once, in _prepare, so that the survey, the ownership and the repair
   * are all talking about one shape. A footprint with no hole in it is
   * returned as it stands, which is nearly all of them.
   */
  function _filled(feature) {
    var parts = G.polygonParts(feature);
    var holed = parts.some(function (part) {
      return part.geometry.coordinates.length > 1;
    });
    if (!holed) return feature;

    var solid = [];
    parts.forEach(function (part) {
      try {
        solid.push(turf.polygon([part.geometry.coordinates[0]]));
      } catch (e) {
        /* a ring turf will not take is one this footprint does without */
      }
    });
    if (solid.length === 0) return feature;
    if (solid.length === 1) return solid[0];
    // Outer rings can nest - a building part drawn inside its parent - and a
    // MultiPolygon of overlapping parts measures its overlap twice.
    return G.unionAll(solid) || feature;
  }

  /** Every ring in a polygonal feature, holes included. */
  function _rings(feature) {
    var out = [];
    G.polygonParts(feature).forEach(function (part) {
      part.geometry.coordinates.forEach(function (ring) {
        // Three points and a repeat of the first: anything shorter encloses
        // nothing and has no wall to cross.
        if (ring && ring.length > 3) out.push(ring);
      });
    });
    return out;
  }

  /**
   * The downloaded buildings as {feature, bbox, area, rings}.
   *
   * Keyed on the collection object, which a download, an import or a reset
   * replaces wholesale and nothing edits in place - so a repair that runs a
   * hundred rehearsals pays for the walk once.
   *
   * Held here rather than stamped onto each feature the way `_centroid` is,
   * and that is not a style preference. A record carries the feature it was
   * derived from, so a field on the feature pointing at the record is a cycle
   * - and data.js writes s.cachedBuildings straight into the saved project,
   * where a cycle is not slow, it is an exception on the way to disk.
   *
   * The cell index is built here too, and for the same reason. Opening the
   * territory list rehearses a repair for every flagged row, and each
   * rehearsal walks one territory's rings against the bins - but rebuilding
   * the bins each time would walk every building in the download instead.
   *
   * @returns {{records: Object[], bins: Object}} records is empty when
   *   nothing has been downloaded
   */
  function _prepare() {
    var collection = (s && s.cachedBuildings) || null;
    var features = (collection && collection.features) || null;
    if (!features) return { records: [], bins: Object.create(null) };
    if (_preparedFor === collection) return _prepared;

    var records = [];
    features.forEach(function (f) {
      if (!f.geometry) return;
      var solid = _filled(G.feat(f));
      var rings = _rings(solid);
      if (rings.length === 0) return;
      var box = G.bbox(solid);
      if (!box) return;
      var area = G.area(solid);
      if (area <= 0) return;
      records.push({
        feature: solid,
        bbox: box,
        area: area,
        rings: rings,
      });
    });

    var bins = Object.create(null);
    records.forEach(function (record, i) {
      var keys = _cells(record.bbox);
      if (!keys) return;
      keys.forEach(function (key) {
        var bucket = bins[key];
        if (bucket) bucket.push(i);
        else bins[key] = [i];
      });
    });

    _preparedFor = collection;
    _prepared = { records: records, bins: bins };
    return _prepared;
  }

  // THE JOIN

  /**
   * Every cell key a bounding box covers, or null when it covers absurdly
   * many.
   */
  function _cells(box) {
    var x0 = Math.floor(box[0] / CELL_DEG);
    var x1 = Math.floor(box[2] / CELL_DEG);
    var y0 = Math.floor(box[1] / CELL_DEG);
    var y1 = Math.floor(box[3] / CELL_DEG);
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > MAX_CELLS) return null;

    var keys = [];
    for (var x = x0; x <= x1; x++) {
      for (var y = y0; y <= y1; y++) keys.push(x * 1e7 + y);
    }
    return keys;
  }

  /** Twice the signed area of the triangle abc: >0 left of ab, <0 right. */
  function _turn(a, b, c) {
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  }

  /** With c known to be collinear with ab, does it lie between a and b? */
  function _between(a, b, c) {
    return (
      c[0] >= Math.min(a[0], b[0]) &&
      c[0] <= Math.max(a[0], b[0]) &&
      c[1] >= Math.min(a[1], b[1]) &&
      c[1] <= Math.max(a[1], b[1])
    );
  }

  /**
   * Do the segments p1p2 and p3p4 meet?
   *
   * The textbook orientation test, with the collinear cases kept rather than
   * dropped. A boundary that runs *along* a wall reports true here and is
   * then measured properly by the intersection, which finds one side holding
   * everything and calls it no crossing at all - the right answer, reached
   * the slow way, for a case rare enough that the slow way costs nothing.
   * Dropping it instead would mean a boundary that grazes a wall and then
   * turns into the building is never looked at.
   */
  function _segmentsMeet(p1, p2, p3, p4) {
    var d1 = _turn(p3, p4, p1);
    var d2 = _turn(p3, p4, p2);
    var d3 = _turn(p1, p2, p3);
    var d4 = _turn(p1, p2, p4);

    if (
      ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
    )
      return true;

    if (d1 === 0 && _between(p3, p4, p1)) return true;
    if (d2 === 0 && _between(p3, p4, p2)) return true;
    if (d3 === 0 && _between(p1, p2, p3)) return true;
    if (d4 === 0 && _between(p1, p2, p4)) return true;
    return false;
  }

  /** Does the segment a-b cross any wall of this footprint? */
  function _cutsWall(a, b, record) {
    var minX = Math.min(a[0], b[0]);
    var maxX = Math.max(a[0], b[0]);
    var minY = Math.min(a[1], b[1]);
    var maxY = Math.max(a[1], b[1]);
    var box = record.bbox;
    if (maxX < box[0] || minX > box[2] || maxY < box[1] || minY > box[3])
      return false;

    for (var r = 0; r < record.rings.length; r++) {
      var ring = record.rings[r];
      for (var i = 0; i < ring.length - 1; i++) {
        if (_segmentsMeet(a, b, ring[i], ring[i + 1])) return true;
      }
    }
    return false;
  }

  /**
   * Which footprints a territory boundary passes through at all.
   *
   * The cheap half of the search. Everything it returns still has to be
   * measured; everything it leaves out is a building no line goes near, which
   * on a city download is almost all of them.
   *
   * @param {Object} prepared the footprints and the cell index over them
   * @param {Object[]} features the territory outlines whose rings to walk --
   *   the ones a scoped run is asking about, not necessarily all of them
   * @returns {Object} record index -> true
   */
  function _suspects(prepared, features) {
    var records = prepared.records;
    var bins = prepared.bins;
    var hit = Object.create(null);

    features.forEach(function (feature) {
      if (!feature) return;
      _rings(feature).forEach(function (ring) {
        for (var i = 0; i < ring.length - 1; i++) {
          var a = ring[i];
          var b = ring[i + 1];
          var keys = _cells([
            Math.min(a[0], b[0]),
            Math.min(a[1], b[1]),
            Math.max(a[0], b[0]),
            Math.max(a[1], b[1]),
          ]);
          if (!keys) continue;

          for (var c = 0; c < keys.length; c++) {
            var bucket = bins[keys[c]];
            if (!bucket) continue;
            for (var n = 0; n < bucket.length; n++) {
              var idx = bucket[n];
              if (hit[idx]) continue;
              if (_cutsWall(a, b, records[idx])) hit[idx] = true;
            }
          }
        }
      });
    });

    return hit;
  }

  // THE SURVEY

  /** Does any part of this feature have an interior ring? */
  function _holed(feature) {
    return G.polygonParts(feature).some(function (part) {
      return part.geometry.coordinates.length > 1;
    });
  }

  /**
   * The part of `feature` lying inside this footprint, or null.
   *
   * Cut down to the footprint's neighborhood before intersecting. turf's
   * clipper walks both outlines, so the straight answer costs the territory's
   * entire ring to decide something about a shape twelve meters across - 300 ms
   * apiece against the 11,500-vertex territory in a project export, and the
   * whole of what a survey spent. bboxClip is linear in the ring and keeps only
   * the corner the house stands in. On that export eight footprints went from
   * 2,520 ms to 17 ms, agreeing to the last centimeter.
   *
   * The shortcut stands aside where it would be wrong or unusable; the paths
   * below say where and why.
   */
  function _slice(feature, record) {
    // bboxClip clips each ring on its own, so a courtyard ring clipped away
    // from the outline it belongs to stops being a hole and the territory
    // appears to hold ground it does not.
    if (!_holed(feature)) {
      var local = null;
      try {
        local = turf.bboxClip(feature, _pad(record.bbox));
      } catch (e) {
        local = null;
      }
      if (local && local.geometry) {
        // Nothing survived the clip, which is the honest answer rather than a
        // failure: Sutherland-Hodgman returns nothing exactly when the subject
        // is outside the box, and a territory whose bounding box reaches a
        // house it does not is the common case here.
        if (_rings(local).length === 0) return null;
        try {
          return G.intersect(local, record.feature);
        } catch (e) {
          // Clipping a concave outline to a box leaves the pieces joined up
          // along the box edge, and those seams are the degenerate arrangement
          // polygon clipping gives up on. Reading the throw as "holds none of
          // it" lost 58 of 181 crossings on a straight-cut partition of a real
          // project, so the pieces are asked one at a time instead. Quantizing
          // the seams does not close them.
          var apart = _pieceWise(local, record.feature);
          if (apart !== undefined) return apart;
        }
      }
    }

    try {
      return G.intersect(feature, record.feature);
    } catch (e) {
      // A shape turf refuses to clip claims nothing rather than failing the
      // survey. It keeps whatever flag its own geometry has earned it.
      return null;
    }
  }

  /**
   * `a` clipped to `b`, one polygon of `a` at a time.
   *
   * For the case where the whole of `a` is unclippable but its parts are not.
   * The parts of a polygonal feature do not overlap, so the union of the
   * per-part answers is the answer.
   *
   * @returns {Object|null|undefined} the slice, null for no overlap, or
   *   undefined when a part failed too and the caller should try something
   *   else - three outcomes because "nothing" and "no idea" are different.
   */
  function _pieceWise(a, b) {
    var parts = G.polygonParts(a);
    if (parts.length < 2) return undefined;

    var pieces = [];
    for (var i = 0; i < parts.length; i++) {
      try {
        var piece = G.intersect(parts[i], b);
        if (piece && piece.geometry) pieces.push(piece);
      } catch (e) {
        return undefined;
      }
    }
    return pieces.length ? G.unionAll(pieces) : null;
  }

  /** A bounding box grown by PAD_DEG, so a clip to it cannot graze the edge. */
  function _pad(box) {
    return [
      box[0] - PAD_DEG,
      box[1] - PAD_DEG,
      box[2] + PAD_DEG,
      box[3] + PAD_DEG,
    ];
  }

  /**
   * How much of this footprint each territory holds, largest share first.
   *
   * @returns {Array<{index:number, area:number, slice:Object}>}
   */
  function _shares(features, boxes, record) {
    // Bounding boxes first, and the count is what matters. A footprint only
    // one territory could reach is not a crossing whatever the geometry says,
    // and settling that with a clip apiece is what made a real project's
    // survey take seconds: ten of its eleven suspects were one territory's
    // alone, and each cost a full intersection to find out.
    var candidates = [];
    for (var i = 0; i < features.length; i++) {
      if (!features[i] || !boxes[i]) continue;
      if (G.bboxOverlap(boxes[i], record.bbox)) candidates.push(i);
    }
    if (candidates.length < 2) return [];

    var out = [];
    for (var c = 0; c < candidates.length; c++) {
      var idx = candidates[c];
      var slice = _slice(features[idx], record);
      if (!slice || !slice.geometry) continue;

      var area = G.area(slice);
      if (area > 0) out.push({ index: idx, area: area, slice: slice });
    }

    out.sort(function (a, b) {
      return b.area - a.area;
    });
    return out;
  }

  /** The smallest slice of this footprint that is a claim on it. */
  function _floor(record) {
    return Math.max(MIN_SLICE_M2, record.area * MIN_SLICE_FRACTION);
  }

  /**
   * Buildings more than one of these territories claims a piece of.
   *
   * @param {Object[]} features territory polygons, in list order. Holes are
   *   allowed; a null entry is a slot nothing occupies and is skipped.
   * @param {{only?: number[]}} [opts] look only for crossings on the outlines
   *   of the territories at these indices. The survey of who holds what still
   *   runs against all of them - which territory holds most of a building is
   *   not a question one territory can answer about itself.
   * @returns {Array<{building:Object, area:number, owner:number,
   *                  shares:Array<{index:number, area:number, claim:boolean}>}>}
   *   `building` is the footprint with its courtyards filled (see _filled),
   *   and `owner` is the largest share - the repair's first choice of who
   *   should take it, not always who does.
   */
  function crossings(features, opts) {
    if (!G || !features || features.length < 2) return [];
    var prepared = _prepare();
    if (prepared.records.length === 0) return [];

    var boxes = features.map(function (f) {
      return f ? G.bbox(f) : null;
    });

    // Only the named territories' rings are walked. A crossing is a boundary
    // through a footprint, and a boundary belongs to both sides, so every
    // crossing a scoped run cares about is found by walking its own outline --
    // and walking the other forty is what made the rehearsal expensive.
    var walk = features;
    if (opts && opts.only && opts.only.length) {
      walk = opts.only
        .map(function (i) {
          return features[i];
        })
        .filter(Boolean);
    }

    var suspects = _suspects(prepared, walk);
    var out = [];

    Object.keys(suspects).forEach(function (key) {
      var record = prepared.records[key];
      var shares = _shares(features, boxes, record);
      if (shares.length < 2) return;

      var floor = _floor(record);
      var claims = 0;
      shares.forEach(function (share) {
        if (share.area >= floor) claims++;
      });
      if (claims < 2) return;

      out.push({
        building: record.feature,
        area: record.area,
        owner: shares[0].index,
        shares: shares.map(function (share) {
          return {
            index: share.index,
            area: share.area,
            // Whether this territory is a party to the argument or merely
            // holds the few centimeters the union left it. The flag on a row
            // is drawn from this: a territory that gives up a graze is not one
            // with a boundary through a building.
            claim: share.area >= floor,
          };
        }),
      });
    });

    return out;
  }

  // THE REPAIR

  function _parts(feature) {
    try {
      return G.polygonParts(feature).length;
    } catch (e) {
      return 0;
    }
  }

  /**
   * A territory with the specks a difference shaved off it swept up.
   *
   * Subtracting a footprint from the territory beside it is supposed to leave
   * one shape with a bite out of its edge. What it leaves often enough to
   * matter is that shape plus a fleck: the boundary and the wall cross at a
   * hair's angle, and the wedge between them survives as a polygon of its own.
   * On a straight-cut partition of a real project, fourteen of a hundred and
   * eighty-one repairs were turned down over one - the largest 1.31 m2, the
   * smallest 0.018 m2.
   *
   * Refusing there is wrong twice over: the boundary stays through the
   * building, and the row goes on offering a repair that declines itself. So a
   * part below the size this app already calls a crumb is swept up and handed
   * over with the footprint, and only a piece big enough to be somewhere still
   * counts as splitting a territory in two.
   *
   * @param {Object} cut what the difference returned
   * @param {number} before how many parts the territory had going in
   * @returns {{feature: Object, crumbs: Object[]}|null} null when sweeping
   *   cannot settle it, which is the case this exists to keep refusing
   */
  function _sweep(cut, before) {
    var parts = G.polygonParts(cut);
    if (parts.length <= before) return { feature: cut, crumbs: [] };

    var floor = (s && s.CUT_MIN_PIECE_M2) || CRUMB_M2;
    var keep = [];
    var crumbs = [];
    parts.forEach(function (part) {
      (G.area(part) < floor ? crumbs : keep).push(part);
    });

    // Sweeping has to actually settle it, and it must not be what empties the
    // territory: a shape made only of crumbs is one this repair would delete.
    if (keep.length === 0 || keep.length > before) return null;

    var feature = keep.length === 1 ? keep[0] : G.unionAll(keep);
    return feature && feature.geometry
      ? { feature: feature, crumbs: crumbs }
      : null;
  }

  /**
   * A territory with the pieces the footprint cut off from it handed over.
   *
   * _sweep's rule is a size: below a crumb it is arithmetic, above one it is a
   * place, and a place is not something to move without a reason. This is the
   * reason. It runs only after every way of avoiding the severance has been
   * tried - including giving the footprint to the other side, which is what
   * settles this in most cases - and what it does is not a loss: a piece the
   * footprint cuts off can no longer be reached from the rest of its own
   * territory, and the only territory it can be reached from is the one taking
   * the footprint. Leaving it where it is would produce the split territory
   * autoheal exists to remove; leaving it uncovered would produce the hole
   * gaps.js exists to report.
   *
   * The largest pieces stay, as many as the territory had to begin with, and
   * the rest go over. That keeps a territory that was already in two parts in
   * two parts, rather than reading its second part as something to hand away.
   *
   * @returns {{feature: Object, crumbs: Object[]}|null} null when there is
   *   nothing left to keep, which would be a territory deleted rather than a
   *   boundary moved
   */
  function _strand(cut, before) {
    var parts = G.polygonParts(cut);
    if (parts.length <= before) return { feature: cut, crumbs: [] };

    parts.sort(function (a, b) {
      return G.area(b) - G.area(a);
    });

    var keep = parts.slice(0, before);
    var feature = keep.length === 1 ? keep[0] : G.unionAll(keep);
    return feature && feature.geometry
      ? { feature: feature, crumbs: parts.slice(before) }
      : null;
  }

  /**
   * The owner with the footprint folded into it, or null.
   *
   * What is unioned in is the whole footprint, not the slices being handed
   * over, and that is the difference between a repair that works and one that
   * declines itself. A donor's slice meets the owner only along the boundary
   * being moved - they abut, they do not overlap - and two polygons sharing an
   * edge dissolve only if that edge is the same coordinates in both. It very
   * often is not: two of the three crossings in a 98-territory project export
   * came back from that union in two pieces and were refused for it. The
   * footprint overlaps the owner by whatever the owner already holds of it,
   * which is real two-dimensional overlap, and unions cleanly.
   *
   * `spare` is the part of the footprint no territory holds, and subtracting
   * it is what keeps the union honest. Usually there is none. When there is,
   * it is a building standing across the edge of the downloaded area, and
   * taking the whole footprint would push a territory out past the boundary
   * everything else is clipped to.
   *
   * The candidate order is the opposite of autoheal's, and deliberately.
   * There the two shapes are neighbors that only nearly touch, so the healed
   * union - buffer out, union, buffer back - goes first because closing that
   * seam is the whole job. Here the exact union is the one that leaves the
   * outline sitting on the wall to the last decimal, which is the point of the
   * exercise. The healed union rounds every corner it touches by the slack it
   * buffers with, so it comes last - as the thing that gets an answer out of
   * geometry the exact union choked on, not as the thing that gives the best
   * answer.
   *
   * The acceptance test is autoheal's, for autoheal's reasons: the result has
   * to have gained the ground it was supposed to gain, and it must not have
   * come back in more pieces than it went in as.
   *
   * @param {Object|null} spare the part of the footprint no territory holds
   * @param {Object[]} extra pieces the footprint stranded, to be folded in
   *   alongside it
   * @param {number} gain the ground the owner is expected to end up with that
   *   it did not have, in square meters
   */
  function _onto(host, building, spare, extra, gain) {
    var floor = G.area(host) + gain * 0.9 - 1;
    var before = _parts(host);

    var candidates = [];
    _fold(candidates, function () {
      return G.union(host, building);
    });
    _fold(candidates, function () {
      return G.union(G.quantize(host), G.quantize(building));
    });
    _fold(candidates, function () {
      return G.unionHealed([host, building], TOUCH_SLACK_M);
    });

    for (var i = 0; i < candidates.length; i++) {
      var candidate = _trim(candidates[i], spare);
      candidate = _addAll(candidate, extra);
      if (!candidate || !candidate.geometry) continue;
      if (G.area(candidate) < floor) continue;
      if (_parts(candidate) > before) continue;
      return candidate;
    }
    return null;
  }

  /** Run one union strategy, keeping what it returns and dropping any throw. */
  function _fold(candidates, strategy) {
    try {
      var result = strategy();
      if (result && result.geometry) candidates.push(result);
    } catch (e) {
      /* every strategy may fail; the caller treats no candidate as no repair */
    }
  }

  /** `shape` less the ground nobody holds, or `shape` when there is none. */
  function _trim(shape, spare) {
    if (!shape || !spare) return shape;
    try {
      return G.difference(shape, spare);
    } catch (e) {
      return null;
    }
  }

  /** `shape` with each of `extra` folded in, or null if one will not go. */
  function _addAll(shape, extra) {
    var out = shape;
    for (var i = 0; out && i < extra.length; i++) {
      try {
        out = G.union(out, extra[i]);
      } catch (e) {
        return null;
      }
    }
    return out;
  }

  /**
   * The part of the footprint that no territory holds.
   *
   * Taken away one claimant at a time rather than by unioning their slices and
   * subtracting once, because the slices are exactly the shapes that will not
   * union - see _onto, which exists because of that. Successive differences
   * need no such luck, and each one is a footprint against a piece of itself.
   *
   * Almost always nothing, and nothing is returned as null rather than as an
   * empty shape so the caller can skip the trimming entirely. A speck is
   * nothing too - trimming one off cost a repair on a real project, because
   * subtracting a hundredth of a square meter split the shape it was cut from.
   *
   * @param {Array<{slice: Object}>} claimants everyone holding a piece of it
   * @returns {Object|null}
   */
  function _unheld(building, claimants) {
    var rest = building;
    for (var i = 0; i < claimants.length; i++) {
      try {
        rest = G.difference(rest, claimants[i].slice);
      } catch (e) {
        return null;
      }
      if (!rest || !rest.geometry) return null;
    }
    return G.area(rest) > CRUMB_M2 ? rest : null;
  }

  /**
   * One attempt at a repair, with `owner` as the territory taking the
   * footprint.
   *
   * All or nothing: a null return leaves `features` untouched, so _resolve can
   * try the next owner without undoing anything.
   *
   * @param {Object} building the footprint, courtyards already filled
   * @param {Array<{index:number, slice:Object}>} shares everyone holding a
   *   piece of it, largest first
   * @param {Object} owner the member of `shares` taking the footprint
   * @param {Object|null} spare the part of the footprint no territory holds
   * @param {boolean} mayStrand whether a donor may lose a piece the footprint
   *   cuts off from it. See _resolve for when that is permitted.
   * @returns {Object|null} feature index -> new feature, or null when this
   *   owner does not work
   */
  function _attempt(features, building, shares, owner, spare, mayStrand) {
    var next = Object.create(null);
    var extra = [];
    var gain = 0;

    for (var i = 0; i < shares.length; i++) {
      var donor = shares[i];
      if (donor === owner) continue;

      var cut = null;
      try {
        cut = G.difference(features[donor.index], building);
      } catch (e) {
        return null;
      }
      // Nothing left of it. The footprint was the whole territory, and giving
      // it away is not moving a boundary onto a wall, it is deleting a
      // territory nobody asked to delete.
      if (!cut || !cut.geometry) return null;

      var before = _parts(features[donor.index]);
      var trimmed = _sweep(cut, before);
      if (!trimmed && mayStrand) trimmed = _strand(cut, before);
      if (!trimmed) return null;

      next[donor.index] = trimmed.feature;
      extra = extra.concat(trimmed.crumbs);

      // What the owner has to pick up: the ground this donor gives up, less
      // whatever the owner already covers of it. Measuring the loss on the
      // shapes counts the crumbs and the stranded pieces without counting them
      // twice, and subtracting the overlap is what makes the sum the owner's
      // gain rather than the donor's loss - territories do overlap, so a donor
      // can give up ground the owner has held all along.
      var loss = null;
      try {
        loss = G.difference(features[donor.index], trimmed.feature);
      } catch (e) {
        return null;
      }
      if (loss && loss.geometry) {
        // The losses are pieces of different territories, so they do not
        // overlap each other and the sum needs no union to be honest.
        gain += Math.max(
          0,
          G.area(loss) - G.sharedArea(features[owner.index], loss),
        );
      }
    }

    // Zero is a legitimate answer: a footprint wholly inside the owner
    // already, claimed by a neighbor only because that neighbor overlaps the
    // owner. The owner is then left exactly as it was, and not only to save
    // the work - autoheal clears the printed mark on every territory a repair
    // touched, so writing back an unmoved shape throws away its card.
    if (gain > NOTHING_M2) {
      var grown = _onto(features[owner.index], building, spare, extra, gain);
      if (!grown) return null;
      next[owner.index] = grown;
    }
    return next;
  }

  /**
   * Every territory this crossing changes, or null when it cannot be repaired.
   *
   * All or nothing. Half a repair is a building handed to nobody, or handed to
   * two territories at once - worse than the crossing it was meant to remove,
   * and invisible afterwards because the flag it would have carried was
   * cleared by the half that worked.
   *
   * Every claimant is offered the footprint in turn, largest share first, and
   * the first arrangement that works is taken. Then, if none did, every
   * claimant again - this time allowing a donor to lose a piece the footprint
   * cuts off from the rest of it.
   *
   * Both loops earn their place. Majority is a preference rather than a rule:
   * where giving the footprint to the largest holder would break the territory
   * on the other side of it and giving it the other way would not, the other
   * way is simply better, and that is what settled a crossing on a building
   * standing across a neck of its neighbor in a 98-territory project. And a
   * stranded piece is not a loss - it goes over with the footprint, to the
   * only territory it can still be reached from - but it moves ground nobody
   * asked to move, so it is what is tried after everything else.
   *
   * If nothing works the crossing keeps its flag, and the report says so
   * rather than the button claiming a repair it did not make.
   *
   * @returns {Object|null} feature index -> new feature
   */
  function _resolve(features, crossing) {
    var building = crossing.building;

    // Measured again rather than read off the survey. Footprints in OSM do
    // overlap - a building part drawn over its parent, a garage sharing a
    // wall - so a repair made a moment ago on the neighboring building can
    // have moved these very shapes, and a stale slice would hand the same
    // ground over twice.
    var shares = [];
    crossing.shares.forEach(function (share) {
      var slice = null;
      try {
        slice = G.intersect(features[share.index], building);
      } catch (e) {
        return;
      }
      if (!slice || !slice.geometry) return;
      var area = G.area(slice);
      if (area > 0)
        shares.push({ index: share.index, area: area, slice: slice });
    });
    if (shares.length < 2) return null;

    shares.sort(function (a, b) {
      return b.area - a.area;
    });

    var spare = _unheld(building, shares);

    for (var pass = 0; pass < 2; pass++) {
      for (var i = 0; i < shares.length; i++) {
        var attempt = _attempt(
          features,
          building,
          shares,
          shares[i],
          spare,
          pass === 1,
        );
        if (attempt) return attempt;
      }
    }
    return null;
  }

  /**
   * Move every boundary that cuts a building onto that building's outline.
   *
   * Pure: the input array is not touched and the features in it are not
   * modified, so a caller can rehearse the repair and throw it away. That is
   * what autoheal's wand does to decide whether to offer itself.
   *
   * @param {Object[]} features territory polygons, in list order
   * @param {{only?: number[]}} [opts] indices the run is allowed to repair. A
   *   crossing is repaired when *any* of the territories sharing the building
   *   is named - the other side of it is moved too, because a boundary
   *   belongs to both of the territories it separates.
   * @returns {{features:Object[], resolved:number, unresolved:number,
   *            changed:number[]}}
   */
  function detach(features, opts) {
    var out = (features || []).slice();
    var found = crossings(out, opts);
    var result = {
      features: out,
      resolved: 0,
      unresolved: 0,
      changed: [],
    };
    if (found.length === 0) return result;

    var only = null;
    if (opts && opts.only && opts.only.length) {
      only = Object.create(null);
      opts.only.forEach(function (i) {
        only[i] = true;
      });
    }

    // Smallest footprint first. A repair can be refused because the shapes it
    // produced were unusable, and the shapes get harder to clip the more of
    // them have already been folded together - so the cheap certain ones are
    // banked before the awkward ones are attempted.
    found.sort(function (a, b) {
      return a.area - b.area;
    });

    var changed = Object.create(null);

    found.forEach(function (crossing) {
      if (
        only &&
        !crossing.shares.some(function (share) {
          return only[share.index];
        })
      )
        return;

      var repair = _resolve(out, crossing);
      if (!repair) {
        result.unresolved++;
        return;
      }
      Object.keys(repair).forEach(function (idx) {
        out[idx] = repair[idx];
        changed[idx] = true;
      });
      result.resolved++;
    });

    result.changed = Object.keys(changed).map(function (idx) {
      return parseInt(idx, 10);
    });
    return result;
  }

  return {
    init: init,
    crossings: crossings,
    detach: detach,
  };
})();

window.App = App;
