/**
 * clustering.js — K-Means auto-partition.
 *
 *   Phase 0  collect sample points (buildings, then streets, then ring samples)
 *   Phase 1  K-Means -> k centroids
 *   Phase 2  Voronoi -> clip each cell to the outer polygon
 *   Phase 3  build the street graph
 *   Phase 4  route each unique cell edge along the street network, once
 *   Phase 5  polygonize, assign, fill gaps, enforce connectivity, render
 *
 * Connectivity
 *   Territories used to come out in two disconnected blobs joined only across
 *   a neighbor. Three separate causes, all fixed here:
 *
 *   1. Pieces were assigned by nearest centroid. Street-routed boundaries
 *      deviate a long way from the Voronoi edges that produced them, so a
 *      piece could be nearest a centroid whose body sits elsewhere. Assignment
 *      is now by containment in the owning Voronoi cell, with distance only as
 *      a fallback.
 *   2. turf.centroid is the vertex mean and can land outside its own polygon —
 *      routinely, for the L and crescent shapes street-following produces.
 *      turf.pointOnFeature is guaranteed inside and is used instead.
 *   3. _fillGaps welded fragments to the nearest occupied slot with no
 *      adjacency test. It now prefers slots the fragment actually touches.
 *
 *   _enforceConnectivity() then makes it a guarantee rather than a likelihood:
 *   any slot that is still multi-part keeps its largest part and hands the
 *   orphans to a touching neighbor.
 *
 * Performance
 *   The street graph stores precomputed edge weights and a grid index.
 *   _nearestGraphNode() used to scan every node, and _findStreetPathForEdge
 *   called it up to ten times per edge because a miss restarted the scan at
 *   the next radius — on a 20k-node graph that dominated the whole run.
 *
 *   A* uses a binary heap and planar distances. The old version did an O(V)
 *   scan of the open set per pop and called turf.distance (haversine plus a
 *   unit conversion) on every relaxation.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.clustering = (function () {
  "use strict";

  var s = null;
  var G = null;
  var SP = null;
  var D = null;
  var T = null;

  var _cancelled = false;
  var _stats = { hits: 0, misses: 0, capped: 0 };

  // Clipping a Voronoi cell can leave slivers. Parts below this contribute no
  // boundary edges, and orphan parts below it are dropped rather than becoming
  // their own territory.
  var MIN_PART_M2 = 25;
  // A territory has to be big enough for someone to walk. 25 m² is a 5x5 m
  // speck — invisible on screen, but still counted in the info panel and still
  // printable as a card. Scale the floor to the partition being produced.
  var MIN_TERRITORY_FRACTION = 0.05;
  // How far apart two slots can be and still count as touching. Adjacent slots
  // share a boundary but rarely share exact vertices — the same reason
  // geometry.unionHealed() exists.
  var TOUCH_SLACK_M = 0.5;
  var CONNECTIVITY_PASSES = 5;

  function init() {
    s = App.state;
    G = App.geometry;
    SP = App.spatial;
    D = App.dom;
    T = App.i18n.t;
    App._loaded.push("clustering");
  }

  function cancelPartition() {
    _cancelled = true;
    App.ui.hideOverlay();
  }

  // ══════════════════════════════════════════════════════════════════════
  // DIALOG
  // ══════════════════════════════════════════════════════════════════════

  function showClusterDialog() {
    if (!s.outerPolygonDrawn || !s.cachedStreets) {
      alert(T("alert.drawAndLoadFirst"));
      return;
    }

    var total = s.cachedBuildings ? s.cachedBuildings.features.length : 0;
    var noBuildings = total === 0;

    var dialog = App.ui.openDialog("tpl-cluster-dialog");
    var calc = D.role(dialog, "calc");
    var bldInput = D.role(dialog, "input-buildings");
    var kInput = D.role(dialog, "input-k");
    var modes = dialog.querySelectorAll('input[name="cluster-mode"]');

    bldInput.value = noBuildings ? 1 : 20;
    bldInput.max = Math.max(1, total);

    if (noBuildings) {
      modes[0].disabled = true;
      D.role(dialog, "label-buildings").classList.add("is-disabled");
    }
    modes[noBuildings ? 1 : 0].checked = true;

    var outerArea = 0;
    try {
      outerArea = turf.area(G.getOuterFeature(s.outerPolygonLayer));
    } catch (e) {
      console.warn(">>> Could not measure outer polygon:", e.message);
    }

    function mode() {
      var checked = dialog.querySelector('input[name="cluster-mode"]:checked');
      return checked ? checked.value : "area";
    }

    /** @returns {number|null} k, or null when the input is not usable */
    function partitionCount() {
      if (mode() === "buildings") {
        var n = parseInt(bldInput.value, 10);
        if (isNaN(n) || n < 1 || n > total) return null;
        return Math.max(2, Math.ceil(total / n));
      }
      var k = parseInt(kInput.value, 10);
      return isNaN(k) || k < 2 ? null : k;
    }

    function sync() {
      var byBuildings = mode() === "buildings";
      D.toggleRole(dialog, "row-buildings", byBuildings);
      D.toggleRole(dialog, "row-area", !byBuildings);

      var k = partitionCount();
      calc.classList.toggle("is-error", k === null);

      if (k === null) {
        calc.textContent = byBuildings
          ? T("partition.errBuildings", { total: total })
          : T("partition.errCount");
        return;
      }
      calc.textContent = byBuildings
        ? T("partition.calcBuildings", { count: k, k: k, each: Math.floor(total / k) })
        : T("partition.calcArea", { k: k, each: Math.round(outerArea / k) });
    }

    Array.prototype.forEach.call(modes, function (radio) {
      radio.addEventListener("change", sync);
    });
    bldInput.addEventListener("input", sync);
    kInput.addEventListener("input", sync);
    sync();

    D.onRole(dialog, "cancel", function () {
      App.ui.closeDialog();
    });
    D.onRole(dialog, "submit", function () {
      var k = partitionCount();
      if (k === null) {
        sync();
        return;
      }
      k = Math.min(s.MAX_PARTITIONS, k);
      if (k > 100 && !confirm(T("partition.confirmMany", { k: k }))) return;
      App.ui.closeDialog();
      runKMeansPartition(k, mode());
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // ENTRY POINT
  // ══════════════════════════════════════════════════════════════════════

  function runKMeansPartition(k, mode) {
    mode = mode || "area";
    _cancelled = false;
    _stats = { hits: 0, misses: 0, capped: 0 };

    if (!s.outerPolygonLayer) {
      alert(T("alert.drawFirst"));
      return;
    }

    console.log(">>> Partition: k=" + k + " mode=" + mode);
    App.ui.showPhases(
      T("loading.partition"),
      T("loading.partitionStatus"),
      cancelPartition,
    );
    _defer(function () {
      _phase0(k, mode);
    }, 30);
  }

  /** setTimeout that bails if the run was cancelled while queued. */
  function _defer(fn, ms) {
    setTimeout(function () {
      if (_cancelled) return;
      try {
        fn();
      } catch (e) {
        // A phase that throws must not leave the overlay spinning forever with
        // no indication that the run is already dead.
        console.error(">>> Partition failed:", e);
        _abort(T("alert.partitionFailed", { message: e.message }));
      }
    }, ms || 0);
  }

  function _abort(message) {
    App.ui.hideOverlay();
    alert(message);
  }

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 0 — sample points
  // ══════════════════════════════════════════════════════════════════════

  function _phase0(k, mode) {
    App.ui.setPhase(0);
    _defer(function () {
      var outerFeature;
      try {
        outerFeature = G.getOuterFeature(s.outerPolygonLayer);
      } catch (e) {
        _abort(T("alert.partitionInvalidOuter", { message: e.message }));
        return;
      }

      var outerRing = outerFeature.geometry.coordinates[0];
      var pts = [];

      if (s.cachedBuildings && s.cachedBuildings.features.length > 0) {
        s.cachedBuildings.features.forEach(function (f) {
          if (!f.geometry) return;
          try {
            pts.push(turf.centroid(G.feat(f.geometry)));
          } catch (e) {
            /* skip malformed building */
          }
        });
      }

      if (pts.length < k * 2 && s.cachedStreets) {
        s.cachedStreets.features.forEach(function (f) {
          if (!f.geometry) return;
          var lines =
            f.geometry.type === "MultiLineString"
              ? f.geometry.coordinates
              : [f.geometry.coordinates];
          lines.forEach(function (coords) {
            for (var i = 0; i < coords.length - 1; i += 5) {
              var c1 = coords[i];
              var c2 = coords[Math.min(i + 1, coords.length - 1)];
              pts.push(turf.point([(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2]));
            }
          });
        });
      }

      if (pts.length < k * 2) {
        var n = Math.max(k * 5, Math.floor(outerRing.length / 2));
        for (var i = 0; i < n; i++) {
          var idx = Math.floor((i / n) * (outerRing.length - 1));
          pts.push(turf.point(outerRing[idx]));
        }
      }

      if (pts.length < k) {
        _abort(T("alert.partitionNoData", { k: k }));
        return;
      }

      _defer(function () {
        _phase1(k, mode, outerFeature, outerRing, pts);
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 1 — K-Means
  // ══════════════════════════════════════════════════════════════════════

  function _phase1(k, mode, outerFeature, outerRing, pts) {
    App.ui.setPhase(1);
    _defer(function () {
      // turf.clustersKmeans measures Euclidean distance on raw degrees. A
      // degree of longitude is only cos(lat) as long as a degree of latitude
      // — 0.61 at 52°N — so unprojected clustering over-weights longitude and
      // produces territories systematically elongated north-south. Scale into
      // a local equirectangular frame, cluster, scale back.
      var latSum = 0;
      pts.forEach(function (p) {
        latSum += p.geometry.coordinates[1];
      });
      var lat0 = pts.length ? latSum / pts.length : 0;
      var kx = SP.lngScale(lat0) / SP.M_PER_DEG_LAT; // ~0.61 at 52°N

      var projected = pts.map(function (p) {
        var c = p.geometry.coordinates;
        return turf.point([c[0] * kx, c[1]]);
      });

      var clustered = turf.clustersKmeans(turf.featureCollection(projected), {
        numberOfClusters: k,
      });

      var centMap = Object.create(null);
      clustered.features.forEach(function (f) {
        var cid = f.properties.cluster;
        if (!centMap[cid]) centMap[cid] = f.properties.centroid;
      });

      var centroids = Object.keys(centMap).map(function (cid) {
        return turf.point([centMap[cid][0] / kx, centMap[cid][1]]);
      });

      console.log(">>> Centroids:", centroids.length, "| lng scale:", kx.toFixed(3));
      _defer(function () {
        _phase2(outerFeature, outerRing, centroids);
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 2 — Voronoi, clipped to the outer polygon
  //
  // Each surviving cell records which centroid owns it. Phase 5 uses that to
  // assign pieces by containment rather than by proximity, which is what keeps
  // a territory in one piece.
  // ══════════════════════════════════════════════════════════════════════

  function _phase2(outerFeature, outerRing, centroids) {
    App.ui.setPhase(2);
    _defer(function () {
      var seen = Object.create(null);
      var deduped = [];
      centroids.forEach(function (c) {
        var key =
          c.geometry.coordinates[0].toFixed(6) +
          "," +
          c.geometry.coordinates[1].toFixed(6);
        if (!seen[key]) {
          seen[key] = true;
          deduped.push(c);
        }
      });

      if (deduped.length < 2) {
        _abort(T("alert.partitionCentroids"));
        return;
      }

      // Pad the bbox so edge centroids get bounded cells.
      var bbox = turf.bbox(outerFeature);
      var pad = Math.max(bbox[2] - bbox[0], bbox[3] - bbox[1]) * 0.1;
      var padded = [bbox[0] - pad, bbox[1] - pad, bbox[2] + pad, bbox[3] + pad];
      var voronoi = turf.voronoi(turf.featureCollection(deduped), {
        bbox: padded,
      });

      var cells = [];
      voronoi.features.forEach(function (cell, i) {
        if (!cell) return;
        var clipped = null;
        try {
          clipped = G.intersect(cell, outerFeature);
        } catch (e) {
          console.warn(">>> Cell", i, "failed to clip:", e.message);
        }
        if (!clipped || !clipped.geometry) return;

        // turf.voronoi returns cells in input order, so index i is the owning
        // centroid. Verified rather than assumed: the cell must contain it.
        // If clipping moved the cell off its centroid, fall back to whichever
        // centroid the clipped cell's interior point is nearest — asking which
        // centroid is nearest to centroid i always answers "i".
        var owner = i;
        try {
          if (!turf.booleanPointInPolygon(deduped[i], clipped)) {
            var probe = _representativePoint(clipped);
            if (probe) {
              var idx = _nearestIndex(
                probe.geometry.coordinates,
                deduped.map(function (c) { return c.geometry.coordinates; }),
              );
              if (idx !== null) owner = idx;
            }
          }
        } catch (e) { /* keep the positional guess */ }

        cells.push({ feature: clipped, centroidIdx: owner });
      });

      console.log(">>> Clipped cells:", cells.length, "of", deduped.length);

      if (cells.length === 0) {
        _abort(T("alert.partitionNoCells"));
        return;
      }

      _defer(function () {
        _phase3(outerFeature, outerRing, cells, deduped);
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 3 — street graph
  // ══════════════════════════════════════════════════════════════════════

  function _phase3(outerFeature, outerRing, cells, centroids) {
    App.ui.setPhase(3);
    _defer(function () {
      var graph = _buildStreetGraph();
      if (graph.count === 0) {
        console.warn(">>> Empty street graph — boundaries will stay straight");
      }
      _defer(function () {
        _phase4(outerFeature, outerRing, cells, centroids, graph);
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 4 — route each unique cell edge exactly once
  //
  // Adjacent Voronoi cells share boundary edges. Routing each cell's copy
  // independently let A* return two different street paths for the same edge,
  // which breaks the planar graph and makes polygonize miss rings. Edges are
  // keyed on their sorted endpoint pair so each is routed once.
  //
  // Every part of a clipped cell contributes edges, not just the largest. When
  // only the largest did, the smaller parts were bounded purely by their
  // neighbors' lines, producing pieces that aligned with no cell at all.
  // ══════════════════════════════════════════════════════════════════════

  function _phase4(outerFeature, outerRing, cells, centroids, graph) {
    App.ui.setPhase(4);
    _defer(function () {
      var PRECISION = 5;

      function coordKey(c) {
        return c[0].toFixed(PRECISION) + "," + c[1].toFixed(PRECISION);
      }

      function edgeKey(p1, p2) {
        var k1 = coordKey(p1),
          k2 = coordKey(p2);
        return k1 < k2 ? k1 + "|" + k2 : k2 + "|" + k1;
      }

      var uniqueEdges = Object.create(null);

      cells.forEach(function (cell) {
        G.polygonParts(cell.feature).forEach(function (part) {
          var area = 0;
          try {
            area = turf.area(part);
          } catch (e) {
            return;
          }

          if (area < MIN_PART_M2) return; // clipping sliver

          var ring = part.geometry.coordinates[0];
          if (!ring || ring.length < 2) return;

          for (var i = 0; i < ring.length - 1; i++) {
            var p1 = ring[i],
              p2 = ring[i + 1];
            var key = edgeKey(p1, p2);
            if (uniqueEdges[key]) continue;
            var mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
            uniqueEdges[key] = {
              p1: p1,
              p2: p2,
              onOuter:
                G.isOnOuterBoundary(p1, outerRing) &&
                G.isOnOuterBoundary(p2, outerRing) &&
                G.isOnOuterBoundary(mid, outerRing),
            };
          }
        });
      });

      var boundaryLines = [];
      var keys = Object.keys(uniqueEdges);
      var CHUNK = 50;   // ~50 A* runs per tick keeps Cancel responsive

      function routeChunk(start) {
        if (_cancelled) return;
        var end = Math.min(start + CHUNK, keys.length);
        for (var n = start; n < end; n++) {
          var e = uniqueEdges[keys[n]];
          if (e.onOuter) {
            boundaryLines.push([e.p1, e.p2]);
            continue;
          }
          var path = _findStreetPathForEdge(e.p1, e.p2, graph);
          boundaryLines.push(path && path.length >= 2 ? path : [e.p1, e.p2]);
        }
        App.ui.setPhaseProgress(4, end / keys.length);
        if (end < keys.length) {
          _defer(function () { routeChunk(end); });
          return;
        }

        for (var i = 0; i < outerRing.length - 1; i++) {
          boundaryLines.push([outerRing[i], outerRing[i + 1]]);
        }

        console.log(
          ">>> Edges routed:", keys.length,
          "| graph hits:", _stats.hits,
          "misses:", _stats.misses,
          "| A* gave up on:", _stats.capped,
        );

        _defer(function () {
          _phase5(outerFeature, outerRing, cells, centroids, boundaryLines);
        });
      }

      routeChunk(0);
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // PHASE 5 — polygonize, assign, gap-fill, enforce connectivity, render
  // ══════════════════════════════════════════════════════════════════════

  function _phase5(outerFeature, outerRing, cells, centroids, boundaryLines) {
    App.ui.setPhase(5);
    _defer(function () {
      var k = centroids.length;

      // ── Polygonize the street-snapped boundary ────────────────────────
      var pieces = [];
      try {
        var noded = G.nodeLineSegments(boundaryLines);
        var lines = noded
          .map(function (coords) {
            var clean = G.dedupCoords(G.roundCoords(coords, 5), 1e-7);
            if (clean.length < 2) return null;
            try {
              return turf.lineString(clean);
            } catch (e) {
              return null;
            }
          })
          .filter(Boolean);

        var polygonized = turf.polygonize(turf.featureCollection(lines));
        pieces =
          polygonized && polygonized.features ? polygonized.features : [];
      } catch (e) {
        console.warn(">>> Polygonize failed:", e.message);
      }

      console.log(">>> Pieces:", pieces.length, "for k =", k);

      // ── Assign each piece to the cell that contains it ─────────────────
      var centroidCoords = centroids.map(function (c) {
        return c.geometry.coordinates;
      });
      var slots = Object.create(null);
      var byDistance = 0;

      pieces.forEach(function (piece) {
        var assignment = _assignPiece(piece, cells, centroidCoords);
        if (assignment === null) return;
        if (assignment.fallback) byDistance++;

        var idx = assignment.index;
        if (!slots[idx]) {
          slots[idx] = G.feat(piece);
        } else {
          try {
            slots[idx] = G.union(slots[idx], piece) || slots[idx];
          } catch (e) {
            /* keep the existing slot */
          }
        }
      });

      if (byDistance > 0) {
        console.log(">>> Pieces assigned by distance fallback:", byDistance);
      }

      // ── Clip every slot to the outer polygon ──────────────────────────
      Object.keys(slots).forEach(function (idx) {
        try {
          var clipped = G.intersect(slots[idx], outerFeature);
          if (clipped && clipped.geometry) slots[idx] = clipped;
        } catch (e) {
          /* leave unclipped rather than dropping the slot */
        }
      });

      console.log(">>> Slots filled:", Object.keys(slots).length, "of", k);

      // ── Fill any uncovered remainder ──────────────────────────────────
      // Must run before _enforceConnectivity, which can add slots that have no
      // matching centroid.
      _fillGaps(slots, outerFeature, centroidCoords);

      // ── Guarantee every territory is a single connected piece ──────────
      _enforceConnectivity(slots);

      // ── Emit ──────────────────────────────────────────────────────────
      var partitions = Object.keys(slots)
        .map(function (idx) {
          var f = G.feat(slots[idx]);
          if (!f || !f.geometry) return null;
          return {
            type: "Feature",
            geometry: f.geometry,
            properties: { cluster: parseInt(idx, 10) },
          };
        })
        .filter(Boolean);

      if (partitions.length === 0) {
        _abort(T("alert.partitionEmpty"));
        return;
      }

      if (App.history) App.history.push();
      App.polygons.setClusters(partitions);
      App.ui.hideOverlay();
      console.log(">>> Partition complete:", partitions.length, "clusters");
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // ASSIGNMENT
  // ══════════════════════════════════════════════════════════════════════

  /**
   * A point guaranteed to lie inside the feature.
   *
   * turf.centroid is the vertex mean, so for the L and crescent shapes that
   * street-following boundaries produce it lands outside the polygon — often
   * inside a neighbor, which is how pieces ended up in the wrong territory.
   */
  function _representativePoint(feature) {
    try {
      return turf.pointOnFeature(feature);
    } catch (e) {
      try {
        return turf.centroid(feature);
      } catch (e2) {
        return null;
      }
    }
  }

  function _nearestIndex(coord, coords) {
    var best = null,
      bestD2 = Infinity;
    for (var i = 0; i < coords.length; i++) {
      var d2 = SP.distSq(coord, coords[i]);
      if (d2 < bestD2) {
        bestD2 = d2;
        best = i;
      }
    }
    return best;
  }

  /**
   * Which territory a polygonized piece belongs to.
   *
   * Containment in the owning Voronoi cell comes first. Nearest centroid is
   * only a fallback, because street-routed boundaries deviate far enough from
   * the Voronoi edges that proximity alone put pieces in territories whose
   * body was somewhere else entirely.
   *
   * @returns {{index: number, fallback: boolean}|null}
   */
  function _assignPiece(piece, cells, centroidCoords) {
    var pt = _representativePoint(piece);
    if (!pt) return null;

    for (var i = 0; i < cells.length; i++) {
      try {
        if (turf.booleanPointInPolygon(pt, cells[i].feature)) {
          return { index: cells[i].centroidIdx, fallback: false };
        }
      } catch (e) {
        /* malformed cell — try the next */
      }
    }

    var idx = _nearestIndex(pt.geometry.coordinates, centroidCoords);
    return idx === null ? null : { index: idx, fallback: true };
  }

  // ══════════════════════════════════════════════════════════════════════
  // GAP FILLING
  // ══════════════════════════════════════════════════════════════════════

  /** outer minus the union of all slots, merged into a touching slot. */
  function _fillGaps(slots, outerFeature, centroidCoords) {
    var keys = Object.keys(slots);
    if (keys.length === 0) return;

    var covered;
    try {
      covered = G.unionAll(
        keys.map(function (idx) {
          return slots[idx];
        }),
      );
    } catch (e) {
      console.warn(">>> Could not union slots:", e.message);
      return;
    }
    if (!covered) return;

    var gap = null;
    try {
      gap = G.difference(outerFeature, covered);
    } catch (e) {
      console.warn(">>> Gap detection failed:", e.message);
      return;
    }
    if (!gap || !gap.geometry) {
      console.log(">>> No gaps — full coverage");
      return;
    }

    var gapArea = turf.area(gap);
    var outerArea = turf.area(outerFeature);
    console.log(
      ">>> Gap:",
      Math.round(gapArea),
      "m² (" + ((gapArea / outerArea) * 100).toFixed(1) + "% of the area)",
    );

    var fragments = G.polygonParts(gap);
    var stranded = 0;

    fragments.forEach(function (fragment) {
      var pt = _representativePoint(fragment);
      if (!pt) return;

      // Prefer slots the fragment actually touches. Ranking purely by centroid
      // distance welded fragments onto territories across the map, which is
      // one of the ways a territory ended up in two pieces.
      var touching = _touchingSlots(slots, fragment, null);
      var candidates = touching.length > 0 ? touching : Object.keys(slots);
      if (touching.length === 0) stranded++;

      var c = pt.geometry.coordinates;
      var best = null,
        bestD2 = Infinity;
      candidates.forEach(function (idx) {
        var centroid = centroidCoords[parseInt(idx, 10)];
        if (!centroid) return;
        var d2 = SP.distSq(c, centroid);
        if (d2 < bestD2) {
          bestD2 = d2;
          best = idx;
        }
      });
      if (best === null) return;

      try {
        slots[best] = G.union(slots[best], fragment) || slots[best];
      } catch (e) {
        /* leave the fragment out rather than corrupting the slot */
      }
    });

    console.log(
      ">>> Gap fragments distributed:",
      fragments.length,
      stranded > 0 ? "(" + stranded + " touched nothing)" : "",
    );
  }

  /**
   * Slot keys whose polygon touches `feature`, ordered by shared area.
   * @param {string|null} exclude a key to skip
   */
  function _touchingSlots(slots, feature, exclude) {
    var probe;
    try {
      probe = turf.buffer(feature, TOUCH_SLACK_M, { units: "meters" });
    } catch (e) {
      probe = feature;
    }

    var hits = [];
    Object.keys(slots).forEach(function (idx) {
      if (idx === exclude) return;
      try {
        var shared = G.intersect(probe, slots[idx]);
        var area = shared ? turf.area(shared) : 0;
        if (area > 0) hits.push({ idx: idx, area: area });
      } catch (e) {
        /* skip an unusable slot */
      }
    });

    hits.sort(function (a, b) {
      return b.area - a.area;
    });
    return hits.map(function (h) {
      return h.idx;
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // CONNECTIVITY
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Make every territory a single connected polygon.
   *
   * Containment-based assignment and adjacency-checked gap filling make split
   * territories unlikely; this makes them impossible. Any slot that is still
   * multi-part keeps its largest part and hands each orphan to the neighbor
   * it shares the most boundary with.
   *
   * An orphan that touches nothing becomes its own territory rather than being
   * welded to a distant slot — that would recreate the exact bug this exists to
   * prevent. Orphans below 5% of an average territory are dropped instead: at
   * that size they are invisible on the map but still counted in the info panel
   * and still printable as a card, which reads as a partition that produced one
   * more territory than it appears to have.
   */
  function _enforceConnectivity(slots) {
    var pass = 0;
    var changed = true;
    var split = 0;
    var promoted = 0;

    var total = 0;
    var n = 0;
    Object.keys(slots).forEach(function (idx) {
      try {
        total += turf.area(slots[idx]);
        n++;
      } catch (e) {
        /* unmeasurable slot */
      }
    });
    var minArea = Math.max(MIN_PART_M2, n ? (total / n) * MIN_TERRITORY_FRACTION : 0);
    var dropped = 0;

    while (changed && pass++ < CONNECTIVITY_PASSES) {
      changed = false;

      Object.keys(slots).forEach(function (idx) {
        var parts = G.polygonParts(slots[idx]);
        if (parts.length < 2) return;

        parts.sort(function (a, b) {
          return turf.area(b) - turf.area(a);
        });

        slots[idx] = parts[0];
        changed = true;
        split++;

        parts.slice(1).forEach(function (orphan) {
          var area = 0;
          try {
            area = turf.area(orphan);
          } catch (e) {
            return;
          }

          var hosts = _touchingSlots(slots, orphan, idx);
          if (hosts.length > 0) {
            try {
              // unionHealed, not union: touching is detected with TOUCH_SLACK_M
              // of slack, so merging must use the same tolerance. A plain union
              // of two nearly-touching polygons returns a MultiPolygon, the
              // host becomes split, and the next pass tries to repair it again.
              var merged = G.unionHealed(
                [slots[hosts[0]], orphan],
                TOUCH_SLACK_M,
              );
              if (merged && merged.geometry) slots[hosts[0]] = merged;
            } catch (e) {
              /* dropping it beats corrupting the host */
            }
            return;
          }

          if (area < minArea) {
            dropped++;
            return;
          }
          slots[_nextSlotKey(slots)] = orphan;
          promoted++;
        });
      });
    }

    // The pass cap is a safety net, not a plan. If anything is still
    // multi-part, split it outright rather than shipping a territory in two
    // places — that is the whole point of this function.
    var forced = 0;
    Object.keys(slots).forEach(function (idx) {
      var parts = G.polygonParts(slots[idx]);
      if (parts.length < 2) return;
      parts.sort(function (a, b) {
        return turf.area(b) - turf.area(a);
      });
      slots[idx] = parts[0];
      parts.slice(1).forEach(function (orphan) {
        var area = 0;
        try {
          area = turf.area(orphan);
        } catch (e) {
          return;
        }
        if (area < minArea) {
          dropped++;
          return;
        }
        slots[_nextSlotKey(slots)] = orphan;
        forced++;
      });
    });

    if (split > 0 || forced > 0 || dropped > 0) {
      console.log(
        ">>> Connectivity: repaired", split, "split territories,",
        promoted + forced, "orphans became their own",
        (forced > 0 ? "(" + forced + " forced)" : ""),
        "| dropped", dropped, "below", Math.round(minArea), "m²",
      );
    }
  }

  function _nextSlotKey(slots) {
    var max = -1;
    Object.keys(slots).forEach(function (idx) {
      var n = parseInt(idx, 10);
      if (!isNaN(n) && n > max) max = n;
    });
    return String(max + 1);
  }

  // ══════════════════════════════════════════════════════════════════════
  // STREET GRAPH
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Build an undirected weighted graph of the street network, plus a grid
   * index for nearest-node lookups.
   * Node: { coords: [lng, lat], adj: { neighborKey: metres } }
   */
  function _buildStreetGraph() {
    var PRECISION = 6;
    var nodes = Object.create(null);

    function nodeKey(c) {
      return c[0].toFixed(PRECISION) + "," + c[1].toFixed(PRECISION);
    }

    function addNode(c) {
      var key = nodeKey(c);
      if (!nodes[key]) {
        nodes[key] = {
          coords: [
            parseFloat(c[0].toFixed(PRECISION)),
            parseFloat(c[1].toFixed(PRECISION)),
          ],
          adj: Object.create(null),
        };
      }
      return key;
    }

    function addPath(coords) {
      for (var i = 0; i < coords.length - 1; i++) {
        var fk = addNode(coords[i]);
        var tk = addNode(coords[i + 1]);
        if (fk === tk || nodes[fk].adj[tk] !== undefined) continue;
        var w = SP.dist(nodes[fk].coords, nodes[tk].coords);
        nodes[fk].adj[tk] = w;
        nodes[tk].adj[fk] = w;
      }
    }

    if (s.streetSegments && s.streetSegments.length > 0) {
      s.streetSegments.forEach(function (seg) {
        addPath(seg.geometry.coordinates);
      });
    } else if (s.cachedStreets && s.cachedStreets.features) {
      s.cachedStreets.features.forEach(function (f) {
        if (!f.geometry) return;
        if (f.geometry.type === "LineString") addPath(f.geometry.coordinates);
        else if (f.geometry.type === "MultiLineString")
          f.geometry.coordinates.forEach(addPath);
      });
    }

    var keys = Object.keys(nodes);
    var grid = new SP.Grid(150);
    keys.forEach(function (key) {
      grid.addPoint(nodes[key].coords, key);
    });

    console.log(">>> Street graph:", keys.length, "nodes");
    return { nodes: nodes, grid: grid, count: keys.length };
  }

  // ── A* ────────────────────────────────────────────────────────────────

  function _astar(graph, startKey, endKey, desiredBearing) {
    if (!startKey || !endKey || startKey === endKey) return null;

    var end = graph.nodes[endKey].coords;
    var gScore = Object.create(null);
    var cameFrom = Object.create(null);
    var closed = Object.create(null);
    var heap = new SP.MinHeap();

    gScore[startKey] = 0;
    heap.push({ k: startKey, f: SP.dist(graph.nodes[startKey].coords, end) });

    var iter = 0;
    while (heap.size() > 0 && iter++ < s.STREET_SEARCH_MAX_ITER) {
      var cur = heap.pop().k;
      if (cur === endKey) return _reconstructPath(cameFrom, cur, graph);
      if (closed[cur]) continue;
      closed[cur] = true;

      var node = graph.nodes[cur];
      for (var nb in node.adj) {
        if (closed[nb] || !graph.nodes[nb]) continue;
        var bearing = SP.bearing(node.coords, graph.nodes[nb].coords);
        var penalty = G.angleDiff(bearing, desiredBearing) / 90;
        var tentative = gScore[cur] + node.adj[nb] * (1 + penalty * 0.3);
        if (gScore[nb] === undefined || tentative < gScore[nb]) {
          cameFrom[nb] = cur;
          gScore[nb] = tentative;
          heap.push({
            k: nb,
            f: tentative + SP.dist(graph.nodes[nb].coords, end),
          });
        }
      }
    }
    if (iter > s.STREET_SEARCH_MAX_ITER) _stats.capped++;
    return null;
  }

  function _reconstructPath(cameFrom, cur, graph) {
    var path = [graph.nodes[cur].coords];
    while (cameFrom[cur] !== undefined) {
      cur = cameFrom[cur];
      path.unshift(graph.nodes[cur].coords);
    }
    return path;
  }

  function _findStreetPathForEdge(p1, p2, graph) {
    if (graph.count === 0) return null;

    var a = graph.grid.nearestPoint(p1, s.ROUTE_SNAP_MAX_M);
    var b = graph.grid.nearestPoint(p2, s.ROUTE_SNAP_MAX_M);
    if (!a || !b) {
      _stats.misses++;
      return null;
    }
    _stats.hits++;

    var bearing = SP.bearing(p1, p2);
    var path = _astar(graph, a.payload, b.payload, bearing);
    if (!path || path.length < 2) path = [a.coord, b.coord];

    var full = [p1];
    if (SP.dist(p1, path[0]) > 2) full.push(path[0]);
    for (var i = 1; i < path.length; i++) full.push(path[i]);
    if (SP.dist(path[path.length - 1], p2) > 2) full.push(p2);

    return full.length >= 2 ? full : null;
  }

  return {
    init: init,
    showClusterDialog: showClusterDialog,
    runKMeansPartition: runKMeansPartition,
    cancelPartition: cancelPartition,
  };
})();

window.App = App;
