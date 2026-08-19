/**
 * footprints.js — boundaries drawn through buildings, and putting them back
 * on the wall.
 *
 * A territory boundary is meant to be something you can stand on: a street, a
 * railway, a river, the edge of a block. clustering.js routes every Voronoi
 * edge along the street network for exactly that reason. But the routing does
 * not always find a street — no way is snapped within ROUTE_SNAP_MAX_M, A*
 * gives up on the iteration cap, the two endpoints are on different components
 * of the graph — and when it does not, the edge stays the straight line the
 * Voronoi diagram drew. A straight line across a block goes through whatever
 * is standing there, and what is standing there is houses.
 *
 * The result is a house that belongs to two territories. Nobody can walk it:
 * two cards are printed, both show the same building, and the two people
 * holding them each assume the other half is somebody else's. It survives
 * every check the app already makes — the territories are connected, they
 * cover everything, they have buildings in them — because none of those
 * questions is about the building.
 *
 * This module asks that question, and answers it the only way that keeps the
 * ground where it is: the building goes, whole, to the territory that already
 * holds most of it, and the boundary moves onto the building's own outline.
 * Not near it, not a fixed distance from it — *on* it, which is why the plain
 * union is tried before the healed one below. Where the line used to cut
 * across a kitchen it now runs along the wall, and the wall is a thing you can
 * stand next to and point at.
 *
 * ── What counts as crossed ────────────────────────────────────────────────
 *
 * Two territories claiming a piece of the same footprint. Both pieces have to
 * be worth arguing about: a boundary that clips a corner by a hand's breadth
 * is a rounding artefact of the unions that built the territory, not a
 * decision anybody made, and repairing it would rewrite half the map to no
 * visible effect. So a slice counts only when it is at least MIN_SLICE_M2 and
 * at least MIN_SLICE_FRACTION of the building — a metre of a garage and a
 * fiftieth of a warehouse both qualify, a graze does neither.
 *
 * ── Finding them without testing everything ───────────────────────────────
 *
 * The honest test is an intersection per building per territory, and on a
 * city download that is five thousand buildings against fifty territories.
 * turf's clipper is not fast enough for that to happen while somebody waits.
 *
 * But a boundary can only cut a building by crossing one of its walls, and
 * that is a question about two line segments. So the buildings are binned by
 * cell, every territory ring is walked once, and each of its segments is
 * tested against the walls of the buildings in the cells it passes through.
 * What comes out is the handful of footprints a line actually goes through,
 * and only those are worth an intersection. The join is exact — a segment is
 * stamped into every cell its own bounding box spans — so nothing is missed
 * by making the cells bigger or smaller, only made slower.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.footprints = (function () {
  "use strict";

  var s = null;
  var G = null;

  // Below either of these the boundary grazed the footprint rather than cut
  // it. Both, not one: a fraction alone calls a 4 m² shed cut in half a
  // crossing worth two unions, and an absolute alone calls a metre off the
  // corner of a supermarket one.
  var MIN_SLICE_M2 = 1;
  var MIN_SLICE_FRACTION = 0.02;

  // Cell edge for the building-against-boundary join, in degrees — about
  // 110 m north to south and rather less east to west, which is the scale of
  // a city block. The join is exact at any size; this only trades cells
  // walked against candidates filtered.
  var CELL_DEG = 0.001;

  // A segment whose bounding box spans more cells than this is not a street
  // boundary, it is a coordinate that went wrong. Stamping it would key a
  // continent of empty buckets.
  var MAX_CELLS = 10000;

  // The same 0.5 m the rest of the app calls "touching". See autoheal.js.
  var TOUCH_SLACK_M = 0.5;

  // A hundredth of a square meter, which is five hundred times smaller than
  // the smallest piece anything in this app treats as a piece. Ground the
  // owner gains below this is ground it already had.
  var NOTHING_M2 = 0.01;

  // How far a clipping box is grown past the footprint it was taken from, so
  // that the clip cannot land exactly on a wall. Half a millimeter.
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

  // ══════════════════════════════════════════════════════════════════════
  // THE BUILDINGS
  // ══════════════════════════════════════════════════════════════════════

  /** turf.bbox, or null for geometry it refuses. */
  function _bbox(feature) {
    try {
      return turf.bbox(feature);
    } catch (e) {
      return null;
    }
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
   * replaces wholesale and nothing edits in place — so a repair that runs a
   * hundred rehearsals pays for the walk once.
   *
   * Held here rather than stamped onto each feature the way `_centroid` is,
   * and that is not a style preference. A record carries the feature it was
   * derived from, so a field on the feature pointing at the record is a cycle
   * — and data.js writes s.cachedBuildings straight into the saved project,
   * where a cycle is not slow, it is an exception on the way to disk.
   *
   * The cell index is built here too, and for the same reason. Opening the
   * territory list rehearses a repair for every flagged row, and each
   * rehearsal walks one territory's rings against the bins — but rebuilding
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
      var rings = _rings(f);
      if (rings.length === 0) return;
      var box = _bbox(f);
      if (!box) return;
      var area = G.area(f);
      if (area <= 0) return;
      records.push({
        feature: G.feat(f),
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

  // ══════════════════════════════════════════════════════════════════════
  // THE JOIN
  // ══════════════════════════════════════════════════════════════════════

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
   * everything and calls it no crossing at all — the right answer, reached
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
   * @param {Object[]} features the territory outlines whose rings to walk —
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

  // ══════════════════════════════════════════════════════════════════════
  // THE SURVEY
  // ══════════════════════════════════════════════════════════════════════

  /** Does any part of this feature have an interior ring? */
  function _holed(feature) {
    return G.polygonParts(feature).some(function (part) {
      return part.geometry.coordinates.length > 1;
    });
  }

  /**
   * The part of `feature` lying inside this footprint, or null.
   *
   * The straight answer is one call to turf.intersect, and on a real project
   * that is where the whole survey went. turf's clipper walks both outlines,
   * so asking a territory what it holds of one house costs the territory's
   * entire ring — 300 ms apiece against the 11,500-vertex territory in a
   * project export somebody sent in, to decide something about a shape twelve
   * meters across.
   *
   * bboxClip is linear in the ring and throws away every part of the territory
   * that is not in the corner the house stands in; the same intersection
   * against what is left costs nothing. On that export, eight footprints went
   * from 2,520 ms to 17 ms, and every answer agreed to the last centimeter.
   *
   * Three cases go the long way round instead, and the middle one is the
   * reason this is written as a shortcut rather than as the method:
   *
   *   • A territory with a hole in it. bboxClip clips each ring on its own,
   *     and a courtyard ring clipped away from the outline it belongs to
   *     stops being a hole. Rare enough to be worth the full price.
   *   • A clip whose output turf then refuses to intersect. Clipping a
   *     concave outline to a box leaves the pieces joined up along the box
   *     edge, and those seams are exactly the degenerate arrangement polygon
   *     clipping gives up on. Reading that throw as "this territory holds
   *     none of it" lost 58 of 181 crossings on a straight-cut partition of a
   *     real project export — every one a boundary through a building the
   *     list then had nothing to say about — so it is asked again instead,
   *     one piece of the clip at a time. The pieces are disjoint, so the
   *     answers add up, and on those 58 they agreed with the full
   *     intersection to the last square centimeter for a thirtieth of the
   *     time. Quantizing the seams away was tried first and fixed none of
   *     them.
   *   • A clip that throws outright.
   *
   * An empty clip is none of these. Sutherland-Hodgman returns nothing
   * exactly when the subject is outside the box, which is the honest answer
   * and, for a territory whose bounding box reaches a house it does not,
   * the common one.
   */
  function _slice(feature, record) {
    if (!_holed(feature)) {
      var local = null;
      try {
        local = turf.bboxClip(feature, _pad(record.bbox));
      } catch (e) {
        local = null;
      }
      if (local && local.geometry) {
        if (_rings(local).length === 0) return null;
        try {
          return G.intersect(local, record.feature);
        } catch (e) {
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
   *   else — three outcomes because "nothing" and "no idea" are different.
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

  /** A bounding box grown by a hair, so a clip to it cannot graze the edge. */
  function _pad(box) {
    return [box[0] - PAD_DEG, box[1] - PAD_DEG, box[2] + PAD_DEG, box[3] + PAD_DEG];
  }

  /**
   * How much of this footprint each territory holds, largest share first.
   *
   * @returns {Array<{index:number, area:number, slice:Object}>}
   */
  function _shares(features, boxes, record) {
    // Bounding boxes first, and the count is what matters. A footprint only
    // one territory could reach is not a crossing whatever the geometry says,
    // and establishing that with a clip apiece is what made surveying a real
    // project take seconds: of the eleven suspects in that export, ten were
    // one territory's alone and each cost a full intersection to find out.
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
   *   runs against all of them — the owner of a building is whichever
   *   territory holds most of it, and that is not a question one territory can
   *   answer about itself.
   * @returns {Array<{building:Object, area:number, owner:number,
   *                  shares:Array<{index:number, area:number, claim:boolean}>}>}
   */
  function crossings(features, opts) {
    if (!G || !features || features.length < 2) return [];
    var prepared = _prepare();
    if (prepared.records.length === 0) return [];

    var boxes = features.map(function (f) {
      return f ? _bbox(f) : null;
    });

    // Only the named territories' rings are walked. A crossing is a boundary
    // through a footprint, and a boundary belongs to both sides, so every
    // crossing a scoped run cares about is found by walking its own outline —
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

  // ══════════════════════════════════════════════════════════════════════
  // THE REPAIR
  // ══════════════════════════════════════════════════════════════════════

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
   * one shape with a bite out of its edge. What it actually leaves, often
   * enough to matter, is that shape plus a fleck: the boundary and the wall
   * cross at a hair's angle, and the wedge between them survives as a separate
   * polygon of a square meter or two. On a straight-cut partition of a real
   * project export, fourteen of a hundred and eighty-one repairs were turned
   * down over flecks — the largest was 1.31 m², the smallest 0.018 m², about a
   * postcard.
   *
   * Refusing there is the wrong answer twice over. The boundary stays through
   * the building, and the row goes on offering a repair that declines itself.
   * So a part below the size this app already calls a crumb is swept up and
   * handed over with the footprint, and only a genuine second lobe — a piece
   * big enough to be somewhere — still counts as splitting a territory in two.
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

  /** How much ground two shapes already have in common, in square meters. */
  function _sharedArea(a, b) {
    try {
      var shared = G.intersect(a, b);
      return shared ? G.area(shared) : 0;
    } catch (e) {
      // Unmeasurable, so assume none: the union is then held to the stricter
      // of the two thresholds, which refuses rather than loses ground.
      return 0;
    }
  }

  /** The same shape on a one-centimeter grid. See _onto. */
  function _quantize(feature) {
    try {
      return turf.truncate(feature, { precision: 7, mutate: false });
    } catch (e) {
      return feature;
    }
  }

  /**
   * The owner and the ground it is taking over, as one shape.
   *
   * The candidate order is the opposite of autoheal's, and deliberately.
   * There the two shapes are neighbors that only nearly touch, so the healed
   * union — buffer out, union, buffer back — goes first because closing that
   * seam is the whole job. Here they share an exact edge: both were cut from
   * the same footprint by the same boundary, so their common border is the
   * same coordinates in both. A plain union of those dissolves cleanly and
   * leaves the outline sitting on the wall to the last decimal, which is the
   * point of the exercise. The healed union rounds every corner it touches by
   * the slack it buffers with, so it comes last — as the thing that gets an
   * answer out of geometry the exact union choked on, not as the thing that
   * gives the best answer.
   *
   * The acceptance test is autoheal's, for autoheal's reasons: the result has
   * to have gained the ground it was supposed to gain, and it must not have
   * come back in more pieces than it went in as.
   */
  function _onto(host, taken, gain) {
    var floor = G.area(host) + gain * 0.9 - 1;
    var before = _parts(host);

    var candidates = [];
    try {
      candidates.push(G.union(host, taken));
    } catch (e) {
      /* the fallbacks below are what this catch is for */
    }
    try {
      candidates.push(G.union(_quantize(host), _quantize(taken)));
    } catch (e) {
      /* every strategy may fail; the caller treats that as "not repaired" */
    }
    try {
      candidates.push(G.unionHealed([host, taken], TOUCH_SLACK_M));
    } catch (e) {
      /* out of ideas; the crossing keeps its flag */
    }

    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      if (!candidate || !candidate.geometry) continue;
      if (G.area(candidate) < floor) continue;
      if (_parts(candidate) > before) continue;
      return candidate;
    }
    return null;
  }

  /**
   * Every territory this crossing changes, or null when it cannot be repaired.
   *
   * All or nothing. Half a repair is a building handed to nobody, or handed to
   * two territories at once — worse than the crossing it was meant to remove,
   * and invisible afterwards because the flag it would have carried was
   * cleared by the half that worked.
   *
   * @returns {Object|null} feature index -> new feature
   */
  function _resolve(features, crossing) {
    var building = crossing.building;

    // Measured again rather than read off the survey. Footprints in OSM do
    // overlap — a building part drawn over its parent, a garage sharing a
    // wall — so a repair made a moment ago on the neighboring building can
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

    var owner = shares[0];
    var donors = shares.slice(1);
    var next = Object.create(null);
    var swept = [];

    for (var i = 0; i < donors.length; i++) {
      var donor = donors[i];
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

      var trimmed = _sweep(cut, _parts(features[donor.index]));
      // A footprint sitting on a narrow neck can genuinely cut a territory in
      // two. That is the fault autoheal exists to remove, so producing one
      // here is not a repair.
      if (!trimmed) return null;

      next[donor.index] = trimmed.feature;
      swept = swept.concat(trimmed.crumbs);
    }

    var taken = G.unionAll(
      donors
        .map(function (donor) {
          return donor.slice;
        })
        // The crumbs go over with the footprint that stranded them. They are
        // specks, but they are ground, and ground that belongs to nobody is
        // the fault gaps.js exists to report.
        .concat(swept),
    );
    if (!taken) return null;

    // What the owner actually gains: the ground being handed over, less
    // whatever it is already covering. Territories do overlap — the healed
    // union that merges two of them leaves half a meter of one lying inside
    // the other, and on the sample village that was enough for both to claim
    // a slice of the same house.
    //
    // Zero is a legitimate answer, and the owner is then left exactly as it
    // was rather than unioned with ground it already holds. Two reasons, and
    // the second is the one that bites: a union measured against the whole
    // slice refuses a repair that has lost nothing at all, and a shape written
    // back is a shape that has moved — autoheal clears the printed mark on
    // every territory a repair touched, and a card would be thrown away for a
    // boundary that did not shift a centimeter.
    var gain = Math.max(
      0,
      G.area(taken) - _sharedArea(features[owner.index], taken),
    );

    if (gain > NOTHING_M2) {
      var grown = _onto(features[owner.index], taken, gain);
      if (!grown) return null;
      next[owner.index] = grown;
    }
    return next;
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
   *   is named — the other side of it is moved too, because a boundary
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
    // them have already been folded together — so the cheap certain ones are
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
