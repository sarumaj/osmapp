/**
 * geometry.js — pure geometry helpers plus the app's only Turf call sites for
 * boolean ops.
 */
var App = window.App || {};

App.geometry = (function () {
  "use strict";

  // ══════════════════════════════════════════════════════════════════════
  // TURF WRAPPERS — Turf v6 signatures live here and nowhere else
  // ══════════════════════════════════════════════════════════════════════

  /** Wrap a bare geometry in a Feature; pass Features through untouched. */
  function feat(x) {
    if (!x) return null;
    if (x.type === "Feature" || x.type === "FeatureCollection") return x;
    return turf.feature(x);
  }

  function union(a, b) {
    return turf.union(feat(a), feat(b));
  }

  function intersect(a, b) {
    return turf.intersect(feat(a), feat(b));
  }

  function difference(a, b) {
    return turf.difference(feat(a), feat(b));
  }

  /** Union a list of features, skipping any step that fails. */
  function unionAll(features) {
    var acc = null;
    for (var i = 0; i < features.length; i++) {
      var f = feat(features[i]);
      if (!f || !f.geometry) continue;
      if (!acc) {
        acc = f;
        continue;
      }
      try {
        acc = union(acc, f) || acc;
      } catch (e) {
        /* keep what we have and carry on */
      }
    }
    return acc;
  }

  // ── Merge artefact repair ─────────────────────────────────────────────

  var HEAL_METERS = 0.5; // half the width of the widest gap we will close
  var MIN_HOLE_M2 = 1; // anything smaller is a union sliver, not a courtyard

  /**
   * Union features so that shared boundaries actually dissolve.
   *
   * Adjacent clusters rarely share exact vertices — phase 5 clips each slot to
   * the outer polygon independently, and splits round to five decimals — so a
   * plain turf.union leaves hairline slivers or returns a MultiPolygon of
   * pieces that still touch. Leaflet then draws the internal outlines, which is
   * the "edges stay visible after merging" symptom.
   *
   * Growing every input by epsilon closes any gap narrower than 2*epsilon,
   * the union genuinely dissolves, and shrinking back restores the original
   * footprint to within a few centimetres.
   */
  function unionHealed(features, epsMeters) {
    var eps = epsMeters == null ? HEAL_METERS : epsMeters;
    var plain = unionAll(features);

    var grown = [];
    for (var i = 0; i < features.length; i++) {
      try {
        var g = turf.buffer(feat(features[i]), eps, { units: "meters" });
        if (g && g.geometry) grown.push(g);
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

    // A negative buffer erodes every boundary, not just the artificial ones.
    // If it deleted area or split the result, the un-shrunk union is the
    // safer answer — a half-metre of overshoot beats a missing corridor.
    var result = merged;
    if (shrunk && shrunk.geometry) {
      try {
        var before = G.polygonParts(merged).length;
        var after = G.polygonParts(shrunk).length;
        if (after >= before && turf.area(shrunk) > turf.area(merged) * 0.98) {
          result = shrunk;
        }
      } catch (e) { /* keep merged */ }
    }
    return dropSmallHoles(result) || result;
  }

  /** Strip interior rings below minAreaM2 — union slivers, not real holes. */
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

  // ══════════════════════════════════════════════════════════════════════
  // POLYGON NORMALIZATION
  // ══════════════════════════════════════════════════════════════════════

  /** Every Polygon inside a Feature / geometry / MultiPolygon, as Features. */
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

  /** The largest Polygon in x, as a Feature<Polygon>, or null. */
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
   * Normalize whatever the outer polygon layer produces into a Feature<Polygon>.
   * L.polygon.toGeoJSON() gives a Feature; L.geoJSON().toGeoJSON() gives a
   * FeatureCollection; either may be a MultiPolygon.
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
   * L.polygon(extractCoordsArray(g)) silently discards all but the largest
   * ring of a MultiPolygon, which is how undo used to lose cluster fragments.
   */
  function toLayer(geometry, style) {
    if (!geometry) return null;
    var layers = L.geoJSON(
      { type: "Feature", geometry: geometry, properties: {} },
      { style: style },
    ).getLayers();
    return layers.length ? layers[0] : null;
  }

  /** Lossy: largest ring only, as Leaflet [lat, lng] rings. */
  function extractCoordsArray(geometry) {
    function ringToLatLngs(ring) {
      return ring.map(function (c) {
        return [c[1], c[0]];
      });
    }
    if (!geometry) return [[[0, 0]]];
    if (geometry.type === "Polygon")
      return geometry.coordinates.map(ringToLatLngs);
    if (geometry.type === "MultiPolygon") {
      var best = largestPolygon(geometry);
      var coords = best ? best.geometry.coordinates : geometry.coordinates[0];
      return coords.map(ringToLatLngs);
    }
    return [[[0, 0]]];
  }

  // ══════════════════════════════════════════════════════════════════════
  // SMALL MATH HELPERS
  // ══════════════════════════════════════════════════════════════════════

  function angleDiff(a, b) {
    var d = Math.abs(a - b) % 180;
    return d > 90 ? 180 - d : d;
  }

  function coordsEqual(c1, c2, tolerance) {
    tolerance = tolerance || 1e-9;
    return (
      Math.abs(c1[0] - c2[0]) < tolerance && Math.abs(c1[1] - c2[1]) < tolerance
    );
  }

  function roundCoord(c, decimals) {
    decimals = decimals || 5;
    var f = Math.pow(10, decimals);
    return [Math.round(c[0] * f) / f, Math.round(c[1] * f) / f];
  }

  function roundCoords(coords, decimals) {
    return coords.map(function (c) {
      return roundCoord(c, decimals);
    });
  }

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

  /** Do two [minX, minY, maxX, maxY] boxes overlap? */
  function bboxOverlap(a, b) {
    return !(b[2] < a[0] || b[0] > a[2] || b[3] < a[1] || b[1] > a[3]);
  }

  /** Ray-cast fallback used when a Turf boolean op throws on bad geometry. */
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

  // ══════════════════════════════════════════════════════════════════════
  // PLANAR NODING
  // ══════════════════════════════════════════════════════════════════════

  var NODE_CELL_DEG = 0.002; // ~200 m

  /**
   * Node a planar set of line-string coordinate arrays: find every T/X
   * intersection, split lines there, deduplicate edges.
   *
   * The pair search is binned. The previous all-pairs double loop ran a few
   * million intersection tests on a city-sized partition and dominated phase 5.
   */
  function nodeLineSegments(lines) {
    // ── Clean and deduplicate whole lines ────────────────────────────────
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

    // ── Flatten to segments ──────────────────────────────────────────────
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

    // ── Bin segments by cell ─────────────────────────────────────────────
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

    // ── Intersect only within bins ───────────────────────────────────────
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

    // ── Rebuild lines through their split points ─────────────────────────
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

    // ── Emit unique undirected edges ─────────────────────────────────────
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
    dropSmallHoles: dropSmallHoles,

    // polygon normalization
    polygonParts: polygonParts,
    largestPolygon: largestPolygon,
    getOuterFeature: getOuterFeature,
    toLayer: toLayer,
    extractCoordsArray: extractCoordsArray,

    // math
    angleDiff: angleDiff,
    coordsEqual: coordsEqual,
    roundCoord: roundCoord,
    roundCoords: roundCoords,
    dedupCoords: dedupCoords,
    pointToSegmentDist: pointToSegmentDist,
    isOnOuterBoundary: isOnOuterBoundary,
    bboxOverlap: bboxOverlap,
    anyCoordInPolygons: anyCoordInPolygons,

    // noding
    nodeLineSegments: nodeLineSegments,
  };
})();

window.App = App;
