/**
 * geometry.js - geometry helpers, and the app's only calls to turf's boolean
 * operations.
 *
 * Everything works on GeoJSON. Nothing here reads App.state, so any function
 * can be called from anywhere at any time.
 *
 * The file has four parts:
 *
 *   - **Turf wrappers.** union, intersect and difference are called from here
 *     and nowhere else, so that turf's argument conventions - Features only,
 *     never bare geometries, and both operands in one FeatureCollection since
 *     v7 - are satisfied in one place. unionHealed() is the one to reach for
 *     when merging territories.
 *   - **Polygon normalization.** GeoJSON permits several shapes for the same
 *     thing, and Leaflet produces different ones depending on how a layer was
 *     built. These functions reduce any of them to what a caller wants.
 *   - **Small math helpers.** Plain arithmetic on coordinate arrays.
 *   - **Planar noding.** Splitting a set of lines at their crossings, which is
 *     what the partitioner needs before it can build a street graph.
 *
 * One recurring hazard is worth knowing about before reading further. turf
 * throws on geometry it considers invalid, and invalid geometry is normal
 * here: shapes are dragged around by hand, clipped against each other, and
 * rounded to five decimals on the way through the file format. Functions here
 * therefore tend to catch, fall back, and return something usable rather than
 * propagate the failure.
 */
var App = window.App || {};

App.geometry = (function () {
  "use strict";

  // TURF WRAPPERS - Turf signatures live here and nowhere else

  /**
   * Wrap a bare geometry in a Feature, passing Features through untouched.
   *
   * turf rejects a bare geometry where it expects a Feature, and callers in
   * this app hold both - layer.toGeoJSON() gives a Feature, while a cluster's
   * stored `.geometry` is bare. Every wrapper below normalizes through here so
   * that no caller has to know which it is holding.
   */
  function feat(x) {
    if (!x) return null;
    if (x.type === "Feature" || x.type === "FeatureCollection") return x;
    return turf.feature(x);
  }

  /**
   * Both operands as the FeatureCollection turf v7 wants.
   *
   * v6 took the two shapes as separate arguments; v7 takes one collection and
   * throws "Must have at least 2 geometries" when handed the old form. The
   * throw is the failure mode to watch for, because most callers here are
   * wrapped in a try/catch that treats a throw as "these shapes do not
   * overlap" - so the version mismatch does not surface as an error, it
   * surfaces as a union that never dissolves anything.
   */
  function pair(a, b) {
    return turf.featureCollection([feat(a), feat(b)]);
  }

  function union(a, b) {
    return turf.union(pair(a, b));
  }

  function intersect(a, b) {
    return turf.intersect(pair(a, b));
  }

  function difference(a, b) {
    return turf.difference(pair(a, b));
  }

  /** turf.bbox, or null for geometry it refuses. */
  function bbox(feature) {
    try {
      return turf.bbox(feature);
    } catch (e) {
      return null;
    }
  }

  /**
   * The same shape on a one-centimeter grid.
   *
   * Two polygons dissolve on union only if the edge they share is the same
   * coordinates in both, and a ring that has been through a clip carries
   * fifteen decimals of noise that says otherwise. Quantizing both sides
   * first is what turns an abutting pair into a single shape.
   */
  function quantize(feature) {
    try {
      return turf.truncate(feature, { precision: 7, mutate: false });
    } catch (e) {
      return feature;
    }
  }

  /**
   * Union a list of features into one, skipping any step that throws.
   *
   * Skipping rather than failing means one bad shape costs its own
   * contribution instead of the whole result. Callers use this to combine
   * things that are already known to belong together, where a partial answer
   * is more useful than none.
   *
   * turf unions a whole collection in one pass, and that is three to four
   * times faster than folding pair by pair: the fold re-walks the growing
   * accumulator on every step, so the shape everything has been merged into
   * so far is paid for again each time. Measured on twelve territories of a
   * hundred vertices each, the fold takes about 385 ms against 107 ms for the
   * single call, for a result identical to the last decimal.
   *
   * It is only a fast path, though. One unusable shape fails the whole
   * collection, and the fold below is what turns that into a partial answer --
   * so a failure here is not an error, it is the reason the loop still
   * exists.
   *
   * @returns {Feature|null} null only when the list contributes nothing
   */
  function unionAll(features) {
    var all = [];
    for (var j = 0; j < features.length; j++) {
      var g = feat(features[j]);
      if (g && g.geometry) all.push(g);
    }
    if (!all.length) return null;
    if (all.length === 1) return all[0];

    try {
      var once = turf.union(turf.featureCollection(all));
      if (once && once.geometry) return once;
    } catch (e) {
      /* fall through and fold, which can still salvage most of it */
    }

    var acc = null;
    for (var i = 0; i < all.length; i++) {
      if (!acc) {
        acc = all[i];
        continue;
      }
      try {
        acc = union(acc, all[i]) || acc;
      } catch (e) {
        /* keep the accumulated shape and carry on */
      }
    }
    return acc;
  }

  // Merge artefact repair

  var HEAL_METERS = 0.5; // half the width of the widest gap that gets closed
  var MIN_HOLE_M2 = 1; // below this a hole is a union artefact, not a courtyard

  // Meters per degree, for the one thing here that needs a length rather than
  // a coordinate. spatial.js owns the same two numbers and the projection
  // built on them; this file loads first and needs neither.
  var M_PER_DEG_LAT = 110540;
  var M_PER_DEG_LNG = 111320;

  // The largest tab despike() will remove, in square meters. A hundredth of a
  // square meter is a hand's breadth square: below that a tab is an artefact
  // of the clipping that produced the ring, above it it is ground.
  var SPIKE_MAX_M2 = 0.01;

  /**
   * Does the ring double back at b without enclosing anything?
   *
   * True when the outgoing direction opposes the incoming one and the triangle
   * the three points span is smaller than SPIKE_MAX_M2 - a tab that goes out
   * along a line and returns along the same line.
   */
  function _isTab(a, b, c) {
    var kx = M_PER_DEG_LNG * Math.cos((b[1] * Math.PI) / 180);
    var ax = (b[0] - a[0]) * kx;
    var ay = (b[1] - a[1]) * M_PER_DEG_LAT;
    var bx = (c[0] - b[0]) * kx;
    var by = (c[1] - b[1]) * M_PER_DEG_LAT;
    if (ax * bx + ay * by >= 0) return false;
    return Math.abs(ax * by - ay * bx) / 2 <= SPIKE_MAX_M2;
  }

  /**
   * One ring with its tabs removed, or null when nothing enclosing is left.
   *
   * A stack rather than a scan, because removing a tab can expose the one
   * before it: a ring that goes out, back, out and back again collapses in a
   * single pass this way and needs several the other.
   */
  function _despikeRing(coords) {
    if (!coords || coords.length < 4) return coords;

    var open = coords.slice(0, -1);
    var out = [];
    for (var i = 0; i < open.length; i++) {
      while (
        out.length >= 2 &&
        _isTab(out[out.length - 2], out[out.length - 1], open[i])
      )
        out.pop();
      out.push(open[i]);
    }

    // The seam where the ring closes is a corner like any other, and a tab can
    // straddle it. Bounded because both ends are being eaten.
    var guard = out.length;
    while (out.length >= 3 && guard-- > 0) {
      if (_isTab(out[out.length - 2], out[out.length - 1], out[0])) {
        out.pop();
      } else if (_isTab(out[out.length - 1], out[0], out[1])) {
        out.shift();
      } else {
        break;
      }
    }

    if (out.length < 3) return null;
    out.push(out[0]);
    return out;
  }

  /**
   * The same shape with its zero-width tabs removed.
   *
   * A tab is a ring going out along a line and coming straight back along it,
   * enclosing nothing. Clipping produces them: a difference against a shape
   * that shares an edge leaves the shared edge traversed twice, and rounding
   * coordinates to five decimals on the way through the file format leaves
   * more. They are invisible on the map, turf.booleanValid does not reliably
   * catch them - a 49,164 m2 territory carrying three of them reports valid --
   * and they cost nothing until something asks jsts to buffer them.
   *
   * Then they cost a territory. jsts snaps its input to a precision model
   * first, which welds the two sides of a tab into one edge and leaves the
   * ring self-touching; `buffer(+0.5 m)` on a valid 49,164 m2 territory with
   * three of them returned 40 m2. Everything built on that buffer --
   * unionHealed, and so every merge in the app - then works correctly on a
   * shape that is wrong. Two of the 98 territories in a project export were in
   * that state, and half of the rest carried a tab that had not yet cost
   * anything.
   *
   * Removing a tab moves no ground: SPIKE_MAX_M2 bounds what any one removal
   * can enclose, and over that export the largest shift on any territory was
   * 0.06 m2 out of 49,000.
   *
   * Returns the input untouched when there is nothing to remove, so a caller
   * may compare by identity to find out whether anything happened.
   */
  function despike(x) {
    var f = feat(x);
    if (!f || !f.geometry) return x;
    if (f.geometry.type !== "Polygon" && f.geometry.type !== "MultiPolygon")
      return x;

    var parts = polygonParts(f);
    var kept = [];
    var removed = 0;

    for (var i = 0; i < parts.length; i++) {
      var coords = parts[i].geometry.coordinates;
      var rings = [];
      for (var r = 0; r < coords.length; r++) {
        var ring = _despikeRing(coords[r]);
        removed += coords[r].length - ((ring && ring.length) || 0);
        // An outer ring that collapsed takes its holes with it; a hole that
        // collapsed was never a courtyard.
        if (!ring || ring.length < 4) {
          if (r === 0) {
            rings = null;
            break;
          }
          continue;
        }
        rings.push(ring);
      }
      if (rings && rings.length) kept.push(rings);
    }

    if (removed === 0 || kept.length === 0) return x;

    try {
      return {
        type: "Feature",
        geometry:
          kept.length === 1
            ? { type: "Polygon", coordinates: kept[0] }
            : { type: "MultiPolygon", coordinates: kept },
        properties: f.properties || {},
      };
    } catch (e) {
      return x;
    }
  }

  /**
   * Union features so that the boundaries between them actually disappear.
   *
   * Use this rather than unionAll() when merging territories that are supposed
   * to become one shape.
   *
   * Two adjacent territories almost never share exact vertices: the
   * partitioner clips each one to the outer boundary independently, and
   * coordinates are rounded to five decimals when a cut is applied. A plain
   * union of two shapes whose shared edge differs in the seventh decimal
   * leaves a hairline sliver between them, or returns a MultiPolygon of pieces
   * that merely touch. Leaflet then draws the internal outlines, and the merge
   * looks as though it did not happen.
   *
   * The fix is to grow each input by a small epsilon before unioning, which
   * closes any gap narrower than 2 x epsilon and lets the union genuinely
   * dissolve, then shrink the result back by the same amount. The round trip
   * restores the original footprint to within a few centimeters.
   *
   * @param {Feature[]} features
   * @param {number} [epsMeters] how far to grow and shrink; see HEAL_METERS
   */
  function unionHealed(features, epsMeters) {
    var eps = epsMeters == null ? HEAL_METERS : epsMeters;
    var plain = unionAll(features);

    var grown = [];
    for (var i = 0; i < features.length; i++) {
      try {
        var input = feat(features[i]);
        // Despiked only for the buffer. What is returned still derives from
        // what the caller passed, and a tab is what jsts cannot survive.
        var g = turf.buffer(despike(input), eps, { units: "meters" });
        if (!g || !g.geometry) continue;
        // A grow that lost ground is not a grow.
        //
        // turf.buffer goes through jsts, which snaps its input to a precision
        // model first. A ring carrying a segment shorter than that model can
        // represent - a clip, a union and a round trip through here leave
        // plenty of them, some measured in nanometers - has its endpoints
        // snapped together, the ring self-touches, and what comes back is not
        // the shape half a meter larger but a scattering of slivers around
        // where its outline used to be. On a 11,637 m2 territory from a real
        // project export, `buffer(+0.5 m)` returned 69 m2 in fourteen pieces;
        // deduplicating the near-coincident vertices first does not help.
        //
        // Everything downstream then behaves correctly on a shape that is
        // wrong: the union folds in the slivers, the shrink is compared
        // against the whole footprint and passes because the loss is a
        // fraction of a percent of it, and a territory disappears - its
        // ground uncovered, discovered by whoever was supposed to walk it.
        // Nothing below can catch that, because by then there is nothing left
        // to notice. It has to be caught here, against the one thing that is
        // known for certain: a positive buffer cannot shrink a polygon.
        if (area(g) < area(input)) return plain;
        grown.push(g);
      } catch (e) {
        /* fall back to the ungrown input below */
      }
    }
    if (grown.length !== features.length) return plain;

    var merged = unionAll(grown);
    if (!merged) return plain;

    var shrunk = null;
    try {
      shrunk = turf.buffer(merged, -eps, { units: "meters" });
    } catch (e) {
      shrunk = null;
    }

    // The shrink is only accepted if it did no damage, because a negative
    // buffer erodes every boundary rather than only the artificial ones. Two
    // things can go wrong: a shape narrow somewhere in the middle can be
    // pinched into separate pieces, and a small shape can lose a significant
    // fraction of its area. In either case the un-shrunk union is the safer
    // answer, since half a meter of overshoot on the outline is a much smaller
    // error than a territory that has been cut in two.
    //
    // Both conditions are easy to state incorrectly, so note the exact form:
    //
    //   - The part count must not *grow*. Eroding a polygon can never merge
    //     parts together, so a test that also accepts a larger count accepts
    //     precisely the case being guarded against.
    //   - The area is compared against `plain`, the union of the *ungrown*
    //     inputs, and not against `merged`. `merged` is inflated by eps on
    //     every side by construction, so comparing to it would demand that the
    //     shrink give back less than the grow added - and for a territory
    //     small enough that half a meter is 2% of its area, which a 90 m
    //     square is, that rejects every correct shrink there is.
    var result = merged;
    if (shrunk && shrunk.geometry) {
      try {
        var footprint = plain ? turf.area(plain) : turf.area(merged);
        if (
          polygonParts(shrunk).length <= polygonParts(merged).length &&
          turf.area(shrunk) > footprint * 0.98
        ) {
          result = shrunk;
        }
      } catch (e) {
        /* keep merged */
      }
    }
    return dropSmallHoles(result) || result;
  }

  /**
   * Remove interior rings smaller than minAreaM2.
   *
   * A union of shapes that nearly line up leaves tiny holes along the seam.
   * These are artefacts of the arithmetic rather than real courtyards, and
   * they are visible on a printed card as specks. Anything above the threshold
   * is left alone, since a territory genuinely can enclose a park or a
   * quarry.
   */
  function dropSmallHoles(x, minAreaM2) {
    minAreaM2 = minAreaM2 || MIN_HOLE_M2;
    var parts = polygonParts(x);
    if (parts.length === 0) return null;

    var cleaned = parts.map(function (part) {
      var rings = part.geometry.coordinates;
      var kept = [rings[0]];
      for (var i = 1; i < rings.length; i++) {
        try {
          if (turf.area(turf.polygon([rings[i]])) >= minAreaM2)
            kept.push(rings[i]);
        } catch (e) {
          /* malformed ring: drop it */
        }
      }
      return kept;
    });

    try {
      var props = (feat(x) && feat(x).properties) || {};
      return cleaned.length === 1
        ? turf.polygon(cleaned[0], props)
        : turf.multiPolygon(cleaned, props);
    } catch (e) {
      return null;
    }
  }

  // POLYGON NORMALIZATION

  /**
   * Flatten anything polygonal into a list of single-Polygon Features.
   *
   * Accepts a Feature, a FeatureCollection, a bare geometry, a Polygon or a
   * MultiPolygon, and always returns an array - empty when there is nothing
   * polygonal in the input. This is the usual first step for code that has to
   * handle a territory made of several disconnected pieces, which happens
   * whenever a cut separates one.
   */
  function polygonParts(x) {
    var f = feat(x);
    if (!f) return [];
    if (f.type === "FeatureCollection") {
      return f.features.reduce(function (acc, sub) {
        return acc.concat(polygonParts(sub));
      }, []);
    }
    if (!f.geometry) return [];
    if (f.geometry.type === "Polygon") return [f];
    if (f.geometry.type === "MultiPolygon") {
      return f.geometry.coordinates
        .map(function (rings) {
          try {
            return turf.polygon(rings);
          } catch (e) {
            return null;
          }
        })
        .filter(Boolean);
    }
    return [];
  }

  /**
   * A point guaranteed to lie inside `x`, as a turf Point, or null.
   *
   * Deliberately not the centroid. turf.centroid returns the mean of the
   * vertices, which for an L-shape, a crescent or a ring lies *outside* the
   * polygon - frequently inside a neighboring territory. Those shapes are
   * common here, because a boundary that follows streets bends around blocks
   * and a hand-drawn cut can leave any outline at all.
   *
   * Three separate features depend on this being one shared answer: the
   * partitioner assigns loose pieces by it, labels.js anchors the number chip
   * on it, and naming.js reverse-geocodes it to suggest a locality name. The
   * chip, the assignment and the place name are all meant to refer to the same
   * spot, which they only do if they ask the same question.
   *
   * turf.pointOnFeature guarantees an interior point; centroid appears only as
   * a fallback for geometry that pointOnFeature refuses outright.
   */
  function interiorPoint(x) {
    var f = feat(x);
    if (!f || !f.geometry) return null;
    try {
      return turf.pointOnFeature(f);
    } catch (e) {
      try {
        return turf.centroid(f);
      } catch (e2) {
        return null;
      }
    }
  }

  /** interiorPoint() as a bare [lng, lat] pair, or null. */
  function interiorCoord(x) {
    var point = interiorPoint(x);
    return point ? point.geometry.coordinates : null;
  }

  /**
   * The largest Polygon in x by area, as a Feature<Polygon>, or null.
   *
   * Used where something has to be a single polygon and the rest can be
   * discarded - a boundary, for instance, which the rest of the app assumes is
   * one ring. Do not use it to normalize a territory, which may legitimately
   * consist of several parts; use polygonParts() there.
   */
  function largestPolygon(x) {
    var parts = polygonParts(x);
    if (parts.length === 0) return null;
    if (parts.length === 1) return parts[0];
    var best = parts[0];
    var bestArea = -1;
    parts.forEach(function (p) {
      var a = 0;
      try {
        a = turf.area(p);
      } catch (e) {
        return;
      }
      if (a > bestArea) {
        bestArea = a;
        best = p;
      }
    });
    return best;
  }

  /**
   * turf.area(), and 0 for anything it refuses to measure.
   *
   * Four modules had written out this same try/catch, because every one of
   * them compares areas to decide something - which part is the largest, has
   * the shape grown, is this sliver worth keeping - and none of them has an
   * answer for a ring turf cannot integrate. Zero is that answer everywhere:
   * an unmeasurable shape loses every comparison, which is what each caller
   * wanted from its own catch block.
   *
   * @param {Object} feature GeoJSON feature or geometry
   * @returns {number} square meters
   */
  function area(feature) {
    try {
      return turf.area(feature);
    } catch (e) {
      return 0;
    }
  }

  /**
   * How much ground two features already have in common, in square meters.
   *
   * Unmeasurable counts as none, so a caller weighing this against a
   * threshold refuses rather than acting on a number it could not compute.
   */
  function sharedArea(a, b) {
    try {
      var shared = intersect(a, b);
      return shared ? area(shared) : 0;
    } catch (e) {
      return 0;
    }
  }

  /**
   * Normalize whatever the outer polygon layer produces into a Feature<Polygon>.
   *
   * L.polygon.toGeoJSON() gives a Feature; L.geoJSON().toGeoJSON() gives a
   * FeatureCollection; either may be a MultiPolygon. Invalid geometry is
   * repaired with a zero buffer rather than rejected.
   *
   * @throws when the layer is absent or holds nothing polygonal
   */
  function getOuterFeature(layer) {
    if (!layer) throw new Error("No outer polygon");
    var poly = largestPolygon(layer.toGeoJSON());
    if (!poly) throw new Error("Outer polygon has no polygonal geometry");
    if (!turf.booleanValid || turf.booleanValid(poly)) return poly;
    return turf.buffer(poly, 0) || poly;
  }

  /**
   * Build a Leaflet layer from any polygonal geometry, keeping every part.
   *
   * Note the use of L.geoJSON rather than L.polygon. L.polygon takes a
   * coordinate array, so handing it a MultiPolygon means picking one part and
   * silently discarding the others - which loses pieces of any territory that
   * a cut has separated.
   *
   * @param {Object} geometry GeoJSON geometry
   * @param {Object} [style] path style
   * @param {Object} [options] extra Leaflet layer options, notably `pane`.
   *   These have to go on the L.GeoJSON options object rather than inside
   *   `style`: geometryToLayer() passes the layer options to the constructor,
   *   while `style` is applied afterwards via setStyle(), and `pane` is only
   *   read at construction time.
   */
  function toLayer(geometry, style, options) {
    if (!geometry) return null;
    var opts = { style: style };
    if (options)
      Object.keys(options).forEach(function (key) {
        opts[key] = options[key];
      });
    var layers = L.geoJSON(
      { type: "Feature", geometry: geometry, properties: {} },
      opts,
    ).getLayers();
    return layers.length ? layers[0] : null;
  }

  // SMALL MATH HELPERS

  /**
   * The acute angle between two bearings, ignoring direction.
   *
   * Both the modulo and the fold are needed: bearings 10 deg and 350 deg describe
   * nearly the same line, as do 10 deg and 170 deg, and this returns a small number
   * for each. Used to decide whether two street segments continue one another.
   *
   * @returns {number} degrees, in [0, 90]
   */
  function angleDiff(a, b) {
    var d = Math.abs(a - b) % 180;
    return d > 90 ? 180 - d : d;
  }

  /**
   * Whether two coordinates are the same point, within a tolerance.
   *
   * Never compare coordinates with ===. They arrive from a file, from a
   * rounding step and from turf's own arithmetic, and two values that describe
   * the same corner routinely differ in the last decimal.
   *
   * @param {number} [tolerance] in degrees; the default is far below a
   *   millimeter and only absorbs floating-point noise
   */
  function coordsEqual(c1, c2, tolerance) {
    tolerance = tolerance || 1e-9;
    return (
      Math.abs(c1[0] - c2[0]) < tolerance && Math.abs(c1[1] - c2[1]) < tolerance
    );
  }

  /**
   * Round one coordinate to a number of decimal places.
   *
   * Five decimals, the default, is about a meter of longitude at these
   * latitudes. Rounding is applied before coordinates are used as map keys or
   * written to a file, so that the same corner reached by two different routes
   * produces the same value.
   */
  function roundCoord(c, decimals) {
    decimals = decimals || 5;
    var f = Math.pow(10, decimals);
    return [Math.round(c[0] * f) / f, Math.round(c[1] * f) / f];
  }

  /** roundCoord() over an array of coordinates. */
  function roundCoords(coords, decimals) {
    return coords.map(function (c) {
      return roundCoord(c, decimals);
    });
  }

  /**
   * Drop coordinates that repeat the one immediately before them.
   *
   * Only consecutive duplicates are removed, so a ring that legitimately
   * returns to its start keeps both copies. Rounding a dense line frequently
   * collapses several vertices onto one point, and a zero-length segment
   * makes turf's boolean operations fail.
   */
  function dedupCoords(coords, tolerance) {
    tolerance = tolerance || 1e-7;
    var result = [];
    for (var i = 0; i < coords.length; i++) {
      var last = result[result.length - 1];
      if (
        result.length === 0 ||
        Math.abs(coords[i][0] - last[0]) > tolerance ||
        Math.abs(coords[i][1] - last[1]) > tolerance
      ) {
        result.push(coords[i]);
      }
    }
    return result;
  }

  /**
   * Distance from point p to the segment a-b, in *degrees*, not meters.
   *
   * Degrees are the right unit for the callers here, which compare against a
   * tolerance expressed the same way. Use App.spatial for distances that are
   * meant to be metric.
   *
   * The zero-length case is handled separately because the projection divides
   * by the segment's squared length; a and b coincide often enough in rounded
   * data to make that worth guarding.
   */
  function pointToSegmentDist(p, a, b) {
    var dx = b[0] - a[0],
      dy = b[1] - a[1];
    var len2 = dx * dx + dy * dy;
    if (len2 === 0) {
      var ddx = p[0] - a[0],
        ddy = p[1] - a[1];
      return Math.sqrt(ddx * ddx + ddy * ddy);
    }
    var t = Math.max(
      0,
      Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2),
    );
    var px = a[0] + t * dx,
      py = a[1] + t * dy;
    var ex = p[0] - px,
      ey = p[1] - py;
    return Math.sqrt(ex * ex + ey * ey);
  }

  /**
   * Whether a point lies on the given ring, within a tolerance.
   *
   * Used to tell a territory edge that follows the outer boundary from one
   * that was cut through the middle, which decides whether an edge may be
   * moved. The default tolerance is roughly five meters - generous, because
   * the two rings come from different rounding paths and need not agree
   * exactly.
   *
   * @param {number[][]} outerRing a closed ring, first coordinate repeated
   */
  function isOnOuterBoundary(point, outerRing, toleranceDeg) {
    toleranceDeg = toleranceDeg || 0.00005;
    for (var i = 0; i < outerRing.length - 1; i++) {
      if (
        pointToSegmentDist(point, outerRing[i], outerRing[i + 1]) < toleranceDeg
      )
        return true;
    }
    return false;
  }

  /**
   * Whether two [minX, minY, maxX, maxY] boxes overlap, edges included.
   *
   * A cheap rejection test to run before an expensive one: two shapes whose
   * bounding boxes are apart cannot possibly intersect.
   */
  function bboxOverlap(a, b) {
    return !(b[2] < a[0] || b[0] > a[2] || b[3] < a[1] || b[1] > a[3]);
  }

  /**
   * Whether any vertex of `feature` falls inside any of `polyFeatures`.
   *
   * A hand-written ray-casting test, used as a fallback when turf's boolean
   * operations throw on geometry they consider invalid. It answers a weaker
   * question than a real intersection test - a shape can overlap a polygon
   * while all of its own vertices lie outside - but it never throws, which is
   * what a fallback has to guarantee.
   */
  function anyCoordInPolygons(feature, polyFeatures) {
    var coords = feature.geometry && feature.geometry.coordinates;
    if (!coords || coords.length === 0) return false;

    function testPoint(lng, lat) {
      for (var p = 0; p < polyFeatures.length; p++) {
        var ring = polyFeatures[p].geometry.coordinates[0];
        var inside = false;
        for (var i = 0, j = ring.length - 1; i < ring.length; j = i++) {
          var xi = ring[i][0],
            yi = ring[i][1],
            xj = ring[j][0],
            yj = ring[j][1];
          if (
            yi > lat !== yj > lat &&
            lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
          )
            inside = !inside;
        }
        if (inside) return true;
      }
      return false;
    }

    if (Array.isArray(coords[0][0])) {
      for (var i = 0; i < coords.length; i++) {
        if (Array.isArray(coords[i][0][0])) {
          for (var j = 0; j < coords[i].length; j++)
            if (testPoint(coords[i][j][0], coords[i][j][1])) return true;
        } else if (testPoint(coords[i][0], coords[i][1])) return true;
      }
    } else if (testPoint(coords[0][0], coords[0][1])) return true;
    return false;
  }

  // PLANAR NODING

  var NODE_CELL_DEG = 0.002; // bin size for the pair search, roughly 200 m

  /**
   * Node a set of lines: split them wherever they cross, and deduplicate.
   *
   * "Noding" means converting a pile of lines that happen to overlap into a
   * proper planar graph, where lines only ever meet at shared endpoints.
   * Street data needs this before it can be routed over, because two streets
   * that cross at a junction are usually two independent ways in OSM with no
   * vertex in common at the crossing point - so without noding, a route can
   * never turn from one onto the other.
   *
   * Both T-junctions, where one line ends on another, and X-crossings, where
   * two lines pass through each other, are found.
   *
   * Candidate pairs are found by binning segments into a coarse grid rather
   * than by testing every pair against every other, which on a city-sized
   * street network would be a few million intersection tests.
   *
   * @param {number[][][]} lines coordinate arrays
   * @returns {number[][][]} one entry per edge of the noded graph, each a pair
   *   of coordinates. Undirected duplicates are collapsed, so an edge appears
   *   once however many input lines ran along it.
   */
  function nodeLineSegments(lines) {
    // Clean and deduplicate whole lines
    var cleanLines = [];
    for (var i = 0; i < lines.length; i++) {
      var deduped = dedupCoords(roundCoords(lines[i], 5), 1e-7);
      if (deduped.length >= 2) cleanLines.push(deduped);
    }

    var seenLines = Object.create(null);
    var uniqueLines = [];
    for (i = 0; i < cleanLines.length; i++) {
      var sig = cleanLines[i]
        .map(function (c) {
          return c[0] + "," + c[1];
        })
        .join("|");
      var revSig = cleanLines[i]
        .slice()
        .reverse()
        .map(function (c) {
          return c[0] + "," + c[1];
        })
        .join("|");
      if (!seenLines[sig] && !seenLines[revSig]) {
        seenLines[sig] = true;
        uniqueLines.push(cleanLines[i]);
      }
    }
    cleanLines = uniqueLines;

    // Flatten to segments
    var segments = [];
    for (i = 0; i < cleanLines.length; i++) {
      for (var j = 0; j < cleanLines[i].length - 1; j++) {
        segments.push({
          a: cleanLines[i][j],
          b: cleanLines[i][j + 1],
          lineIdx: i,
          segIdx: j,
        });
      }
    }

    // Bin segments by cell
    var bins = new Map();
    segments.forEach(function (seg, idx) {
      var x0 = Math.floor(Math.min(seg.a[0], seg.b[0]) / NODE_CELL_DEG);
      var x1 = Math.floor(Math.max(seg.a[0], seg.b[0]) / NODE_CELL_DEG);
      var y0 = Math.floor(Math.min(seg.a[1], seg.b[1]) / NODE_CELL_DEG);
      var y1 = Math.floor(Math.max(seg.a[1], seg.b[1]) / NODE_CELL_DEG);
      for (var cx = x0; cx <= x1; cx++) {
        for (var cy = y0; cy <= y1; cy++) {
          var key = cx * 1e7 + cy;
          var bucket = bins.get(key);
          if (bucket) bucket.push(idx);
          else bins.set(key, [idx]);
        }
      }
    });

    // Intersect only within bins
    var splitPoints = Object.create(null);

    function addSplit(li, si, pt) {
      var key = li + "-" + si;
      var list = splitPoints[key];
      if (!list) list = splitPoints[key] = [];
      var rPt = roundCoord(pt, 5);
      for (var k = 0; k < list.length; k++)
        if (coordsEqual(list[k], rPt, 1e-7)) return;
      list.push(rPt);
    }

    function segIntersect(a1, a2, b1, b2) {
      var d1x = a2[0] - a1[0],
        d1y = a2[1] - a1[1];
      var d2x = b2[0] - b1[0],
        d2y = b2[1] - b1[1];
      var denom = d1x * d2y - d1y * d2x;
      if (Math.abs(denom) < 1e-15) return null;
      var sParam = ((b1[0] - a1[0]) * d2y - (b1[1] - a1[1]) * d2x) / denom;
      var tParam = ((b1[0] - a1[0]) * d1y - (b1[1] - a1[1]) * d1x) / denom;
      if (
        sParam < -1e-10 ||
        sParam > 1 + 1e-10 ||
        tParam < -1e-10 ||
        tParam > 1 + 1e-10
      )
        return null;
      return [a1[0] + sParam * d1x, a1[1] + sParam * d1y];
    }

    var tested = new Set();
    bins.forEach(function (bucket) {
      for (var bi = 0; bi < bucket.length; bi++) {
        for (var bj = bi + 1; bj < bucket.length; bj++) {
          var ia = bucket[bi],
            ib = bucket[bj];
          var pairKey = ia < ib ? ia * 1e7 + ib : ib * 1e7 + ia;
          if (tested.has(pairKey)) continue;
          tested.add(pairKey);

          var si = segments[ia],
            sj = segments[ib];
          if (si.lineIdx === sj.lineIdx) {
            if (coordsEqual(si.b, sj.a, 1e-7) || coordsEqual(si.a, sj.b, 1e-7))
              continue;
          }
          if (
            coordsEqual(si.a, sj.a, 1e-7) ||
            coordsEqual(si.a, sj.b, 1e-7) ||
            coordsEqual(si.b, sj.a, 1e-7) ||
            coordsEqual(si.b, sj.b, 1e-7)
          )
            continue;

          var pt = segIntersect(si.a, si.b, sj.a, sj.b);
          if (pt) {
            addSplit(si.lineIdx, si.segIdx, pt);
            addSplit(sj.lineIdx, sj.segIdx, pt);
          }
        }
      }
    });

    // Rebuild lines through their split points
    var newLines = [];
    for (i = 0; i < cleanLines.length; i++) {
      var coords = cleanLines[i];
      var newCoords = [coords[0]];
      for (j = 0; j < coords.length - 1; j++) {
        var splits = splitPoints[i + "-" + j];
        if (splits && splits.length > 0) {
          var origin = coords[j];
          splits.sort(function (p, q) {
            var dp =
              (p[0] - origin[0]) * (p[0] - origin[0]) +
              (p[1] - origin[1]) * (p[1] - origin[1]);
            var dq =
              (q[0] - origin[0]) * (q[0] - origin[0]) +
              (q[1] - origin[1]) * (q[1] - origin[1]);
            return dp - dq;
          });
          for (var k = 0; k < splits.length; k++)
            if (!coordsEqual(splits[k], newCoords[newCoords.length - 1], 1e-7))
              newCoords.push(splits[k]);
        }
        if (!coordsEqual(coords[j + 1], newCoords[newCoords.length - 1], 1e-7))
          newCoords.push(coords[j + 1]);
      }
      if (newCoords.length >= 2) newLines.push(newCoords);
    }

    // Emit unique undirected edges
    var edgeSet = Object.create(null);
    var finalLines = [];
    for (i = 0; i < newLines.length; i++) {
      var line = newLines[i];
      for (j = 0; j < line.length - 1; j++) {
        var a = line[j],
          b = line[j + 1];
        var ek1 = a[0] + "," + a[1] + "->" + b[0] + "," + b[1];
        var ek2 = b[0] + "," + b[1] + "->" + a[0] + "," + a[1];
        if (!edgeSet[ek1] && !edgeSet[ek2]) {
          edgeSet[ek1] = true;
          finalLines.push([a, b]);
        }
      }
    }
    return finalLines;
  }

  return {
    // turf wrappers
    feat: feat,
    union: union,
    unionAll: unionAll,
    intersect: intersect,
    difference: difference,
    unionHealed: unionHealed,
    bbox: bbox,
    quantize: quantize,
    area: area,
    sharedArea: sharedArea,
    dropSmallHoles: dropSmallHoles,

    // polygon normalization
    polygonParts: polygonParts,
    largestPolygon: largestPolygon,
    interiorPoint: interiorPoint,
    interiorCoord: interiorCoord,
    getOuterFeature: getOuterFeature,
    toLayer: toLayer,

    // math
    angleDiff: angleDiff,
    coordsEqual: coordsEqual,
    roundCoords: roundCoords,
    dedupCoords: dedupCoords,
    despike: despike,
    pointToSegmentDist: pointToSegmentDist,
    isOnOuterBoundary: isOnOuterBoundary,
    bboxOverlap: bboxOverlap,
    anyCoordInPolygons: anyCoordInPolygons,

    // noding
    nodeLineSegments: nodeLineSegments,
  };
})();

window.App = App;
