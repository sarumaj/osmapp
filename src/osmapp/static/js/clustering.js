/**
 * clustering.js - K-Means auto-partition.
 *
 *   Phase 0  collect sample points (buildings, then streets, then ring samples)
 *   Phase 1  K-Means -> k centroids
 *   Phase 2  Voronoi -> clip each cell to the outer polygon
 *   Phase 3  build the street graph
 *   Phase 4  route each unique cell edge along the street network, once
 *   Phase 5  polygonize, assign, balance the building counts, fill gaps,
 *            enforce connectivity, take the boundaries off the buildings they
 *            run through, render
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
  // Which of the two splits is running. Read in phase 0, to choose what
  // k-means is seeded with, and in phase 5, to choose what the balance pass
  // evens out - the two ends of the pipeline that make the modes differ. Run
  // state rather than a parameter because everything in between is indifferent
  // to it, and threading it through five signatures that never read it is how
  // it came to be ignored in the first place.
  var _mode = "area";

  // Clipping a Voronoi cell can leave slivers. Parts below this contribute no
  // boundary edges, and orphan parts below it are dropped rather than becoming
  // their own territory.
  var MIN_PART_M2 = 25;
  // A territory has to be big enough for someone to walk. 25 m2 is a 5x5 m
  // speck - invisible on screen, but still counted in the info panel and still
  // printable as a card. Scale the floor to the partition being produced.
  var MIN_TERRITORY_FRACTION = 0.05;
  // How far apart two slots can be and still count as touching. Adjacent slots
  // share a boundary but rarely share exact vertices - the same reason
  // geometry.unionHealed() exists.
  var TOUCH_SLACK_M = 0.5;
  var CONNECTIVITY_PASSES = 5;
  // How far a cell corner may be pulled to land on the street network. About
  // half a block: far enough to reach the street the corner belongs to,
  // near enough that a corner is never teleported past the street beside it
  // onto the next one over. A corner with nothing this close is in open
  // ground, where a straight line crosses nobody's garden anyway.
  var VERTEX_SNAP_MAX_M = 60;

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

  // DIALOG

  /**
   * Open the partition dialog: how many territories, or how many buildings in
   * each. Warns and does nothing until a boundary is drawn and streets are
   * downloaded, since both phases below read them.
   */
  function showClusterDialog() {
    if (!s.outerPolygonDrawn || !s.cachedStreets) {
      alert(T("alert.drawAndLoadFirst"));
      return;
    }

    // The area the run will actually split, measured once: `total` and
    // `outerArea` both have to describe it, and _phase0 clusters the same
    // points. Counting every cached building instead - the whole download -
    // sizes k for three villages when the run splits one of them, and the
    // "about {each} buildings" the dialog prints is then a promise about a
    // population that is never partitioned.
    var outerFeature = null;
    try {
      outerFeature = App.polygons.workingOuter();
    } catch (e) {
      console.warn(">>> Could not read the outer polygon:", e.message);
    }

    var total = outerFeature ? _buildingPoints(outerFeature).length : 0;
    var noBuildings = total === 0;

    var dialog = App.ui.openDialog("tpl-cluster-dialog", function () {
      App.shortcuts.pop("partition");
    });
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
    if (outerFeature) {
      try {
        outerArea = turf.area(outerFeature);
      } catch (e) {
        console.warn(">>> Could not measure outer polygon:", e.message);
      }
    }

    function mode() {
      var checked = dialog.querySelector('input[name="cluster-mode"]:checked');
      return checked ? checked.value : "area";
    }

    /**
     * @returns {number|null} k, or null when the input is not usable
     *
     * Capped here rather than on the way out of the dialog, because the line
     * under the field is computed from whatever this returns. Capping after
     * it was printed makes the dialog offer "600 territories, about 20
     * buildings each" and the run produce 200 territories of 60.
     */
    function partitionCount() {
      var k;
      if (mode() === "buildings") {
        var n = parseInt(bldInput.value, 10);
        if (isNaN(n) || n < 1 || n > total) return null;
        k = Math.max(2, Math.ceil(total / n));
      } else {
        k = parseInt(kInput.value, 10);
        if (isNaN(k) || k < 2) return null;
      }
      return Math.min(s.MAX_PARTITIONS, k);
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

    function submit() {
      var k = partitionCount();
      if (k === null) {
        sync();
        return;
      }
      if (k > 100 && !confirm(T("partition.confirmMany", { k: k }))) return;
      App.ui.closeDialog();
      runKMeansPartition(k, mode());
    }

    D.onRole(dialog, "submit", submit);

    /**
     * Type a number, press Enter.
     *
     * The dialog is two number fields and a pair of radios, so Enter is the
     * one gesture every form in the world answers and the only way out that
     * does not take a hand off the keyboard. `whileTyping`, because the field
     * is exactly where you are when you mean it.
     */
    App.shortcuts.push({
      id: "partition",
      titleKey: "shortcuts.groupPartition",
      exclusive: true,
      entries: [
        {
          combos: ["Enter"],
          labelKey: "shortcuts.partitionGo",
          whileTyping: true,
          when: function () {
            return partitionCount() !== null;
          },
          run: submit,
        },
        {
          combos: ["Escape"],
          labelKey: "shortcuts.partitionCancel",
          whileTyping: true,
          run: function () {
            App.ui.closeDialog();
          },
        },
        { combos: ["Tab"], labelKey: "shortcuts.dialogFields", note: true },
      ],
    });
  }

  // ENTRY POINT

  function runKMeansPartition(k, mode) {
    _mode = mode === "buildings" ? "buildings" : "area";
    _cancelled = false;
    _stats = { hits: 0, misses: 0, capped: 0 };

    if (!s.outerPolygonLayer) {
      alert(T("alert.drawFirst"));
      return;
    }

    console.log(">>> Partition: k=" + k + " mode=" + _mode);
    App.ui.showPhases(
      T("loading.partition"),
      T("loading.partitionStatus"),
      cancelPartition,
    );
    _defer(function () {
      _phase0(k);
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

  // PHASE 0 - sample points

  /**
   * Whether a sample point belongs to the area being split.
   *
   * The download covers the whole boundary, so on a project assembled from
   * several imports the building list holds every village at once. Seeding
   * k-means with points from the others produces centroids outside the area,
   * and a centroid outside the area is a territory that clips away to nothing.
   *
   * The bounding box first: this runs once per building, and on a town that is
   * twelve thousand point-in-polygon tests otherwise.
   */
  function _within(point, area, box) {
    var c = point.geometry.coordinates;
    if (c[0] < box[0] || c[0] > box[2] || c[1] < box[1] || c[1] > box[3]) {
      return false;
    }
    try {
      return turf.booleanPointInPolygon(point, area);
    } catch (e) {
      return false;
    }
  }

  /**
   * Building centroids inside `area`, in cached-download order.
   *
   * The centroid is memoized on the feature under the same `_centroid` key
   * autoheal.js uses, so opening the dialog, running the partition and
   * healing afterwards all pay for it once between them. The cache is safe
   * because a download, an import or a reset replaces the whole collection
   * rather than editing features in place.
   */
  function _buildingPoints(area) {
    var features = (s.cachedBuildings && s.cachedBuildings.features) || null;
    if (!features || features.length === 0) return [];

    var box;
    try {
      box = turf.bbox(area);
    } catch (e) {
      return [];
    }

    var pts = [];
    features.forEach(function (f) {
      if (!f.geometry) return;
      var centroid = f._centroid;
      if (!centroid) {
        try {
          centroid = f._centroid = turf.centroid(G.feat(f.geometry));
        } catch (e) {
          return; // malformed building
        }
      }
      if (_within(centroid, area, box)) pts.push(centroid);
    });
    return pts;
  }

  /**
   * An even scatter of points over the ground inside `area`.
   *
   * What "split by area" has to be clustered on. K-means converges on cells of
   * equal area only when the points it is given are spread evenly over the
   * ground - feed it the buildings and it converges on the buildings, however
   * the dialog labelled the run.
   *
   * The spacing is chosen from the area rather than fixed, so a hamlet and a
   * city both get about the same number of samples per territory. Twenty-five
   * is enough for the cells to come out even and few enough that a 200-way
   * split of a city stays a five-thousand-point clustering rather than a
   * hundred-thousand-point one.
   *
   * @returns {Object[]} sample points, empty when the area cannot be measured
   */
  function _groundSample(area, k) {
    var SAMPLES_PER_TERRITORY = 25;
    try {
      var m2 = turf.area(area);
      if (!(m2 > 0)) return [];
      var spacing = Math.sqrt(m2 / (k * SAMPLES_PER_TERRITORY));
      var grid = turf.pointGrid(turf.bbox(area), spacing, {
        units: "meters",
        mask: area,
      });
      return (grid && grid.features) || [];
    } catch (e) {
      // The street and ring fallbacks in _phase0 pick it up from here rather
      // than the run dying on a polygon turf would not grid.
      console.warn(">>> Could not sample the ground:", e.message);
      return [];
    }
  }

  function _phase0(k) {
    App.ui.setPhase(0);
    _defer(function () {
      var outerFeature;
      try {
        // One area, not the whole boundary: k territories drawn across three
        // villages is not a division anybody asked for, and every phase below
        // walks `outerRing` as a single ring besides.
        outerFeature = App.polygons.workingOuter();
      } catch (e) {
        _abort(T("alert.partitionInvalidOuter", { message: e.message }));
        return;
      }

      var outerRing = outerFeature.geometry.coordinates[0];
      var outerBox = turf.bbox(outerFeature);

      var buildingPts = _buildingPoints(outerFeature);

      // What k-means is asked to divide up, and the first place the two modes
      // part company. Splitting by buildings clusters the buildings; splitting
      // by area clusters the ground itself, sampled evenly, because k-means
      // over a uniform sample converges on cells of equal area and k-means
      // over the buildings converges on something else entirely - which is
      // what made "about {each} m2 each" a number the run never honored.
      var pts =
        _mode === "buildings"
          ? buildingPts.slice()
          : _groundSample(outerFeature, k);

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
              var mid = turf.point([(c1[0] + c2[0]) / 2, (c1[1] + c2[1]) / 2]);
              if (_within(mid, outerFeature, outerBox)) pts.push(mid);
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
        _phase1(k, outerFeature, outerRing, pts, buildingPts);
      });
    });
  }

  // PHASE 1 - K-Means

  function _phase1(k, outerFeature, outerRing, pts, buildingPts) {
    App.ui.setPhase(1);
    _defer(function () {
      // turf.clustersKmeans measures Euclidean distance on raw degrees. A
      // degree of longitude is only cos(lat) as long as a degree of latitude
      // - 0.61 at 52 deg N - so unprojected clustering over-weights longitude and
      // produces territories systematically elongated north-south. Scale into
      // a local equirectangular frame, cluster, scale back.
      var latSum = 0;
      pts.forEach(function (p) {
        latSum += p.geometry.coordinates[1];
      });
      var lat0 = pts.length ? latSum / pts.length : 0;
      var kx = SP.lngScale(lat0) / SP.M_PER_DEG_LAT; // ~0.61 at 52 deg N

      var projected = pts.map(function (p) {
        var c = p.geometry.coordinates;
        return turf.point([c[0] * kx, c[1]]);
      });

      // turf.clustersKmeans seeds skmeans with `coordAll(points).slice(0, k)`
      // - the first k features in array order, not a sample and not k-means++.
      // Overpass hands buildings back in OSM id order, and ids run in
      // contiguous blocks per import, so those k seeds all land in one corner
      // of the map. Lloyd's iteration cannot walk a centroid across a town it
      // has no points in, so it settles with whole neighborhoods served by one
      // centroid: on a 3000-building fixture asking for 20 per territory, the
      // median territory came out at 4 buildings and the largest at 434.
      //
      // Shuffling makes that slice a uniform sample of the buildings, which is
      // the initialization the algorithm assumes. Sampling proportional to
      // density is also what count balance wants - k-means++ deliberately
      // spreads seeds by distance and over-serves empty outskirts, and scored
      // worse here than plain sampling (max 74 against 52 on the same
      // fixture). A fixed seed keeps the same input producing the same map.
      var clustered = turf.clustersKmeans(
        turf.featureCollection(_shuffled(projected, 0x5eed)),
        { numberOfClusters: k },
      );

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
        _phase2(outerFeature, outerRing, centroids, buildingPts);
      });
    });
  }

  /**
   * A copy of `list` in a shuffled order, from a seed rather than Math.random.
   *
   * Deterministic on purpose: a partition that comes out differently every
   * time it is run over the same download is one nobody can check, redo after
   * an undo, or report a bug against.
   */
  function _shuffled(list, seed) {
    var out = list.slice();
    var state = seed >>> 0 || 1;
    for (var i = out.length - 1; i > 0; i--) {
      // xorshift32 - a few lines, no dependency, and far better distributed
      // than the LCG-on-a-float this would otherwise be written as.
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      var j = (state >>> 0) % (i + 1);
      var tmp = out[i];
      out[i] = out[j];
      out[j] = tmp;
    }
    return out;
  }

  // PHASE 2 - Voronoi, clipped to the outer polygon
  //
  // Each surviving cell records which centroid owns it. Phase 5 uses that to
  // assign pieces by containment rather than by proximity, which is what keeps
  // a territory in one piece.

  function _phase2(outerFeature, outerRing, centroids, buildingPts) {
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
        // centroid the clipped cell's interior point is nearest - asking which
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
        _phase3(outerFeature, outerRing, cells, deduped, buildingPts);
      });
    });
  }

  // PHASE 3 - street graph

  function _phase3(outerFeature, outerRing, cells, centroids, buildingPts) {
    App.ui.setPhase(3);
    _defer(function () {
      var graph = _buildStreetGraph();
      if (graph.count === 0) {
        console.warn(">>> Empty street graph — boundaries will stay straight");
      }
      _defer(function () {
        _phase4(outerFeature, outerRing, cells, centroids, graph, buildingPts);
      });
    });
  }

  // PHASE 4 - route each unique cell edge exactly once
  //
  // Adjacent Voronoi cells share boundary edges. Routing each cell's copy
  // independently lets A* return two different street paths for the same edge,
  // which breaks the planar graph and makes polygonize miss rings. Edges are
  // keyed on their sorted endpoint pair so each is routed once.
  //
  // Every part of a clipped cell contributes edges, not just the largest. With
  // only the largest contributing, the smaller parts are bounded purely by
  // their neighbors' lines and come out aligned with no cell at all.
  //
  // The corners are pulled onto the network before any of that. A Voronoi
  // vertex falls wherever three cells happen to meet, which is generally the
  // middle of a block, and routing from the vertex meant emitting the straight
  // line from it to the first street node as part of the boundary. Measured on
  // a 100 m street grid that is 16 m at each end of every edge - a boundary
  // that runs along a road, then cuts between two houses to reach a corner in
  // somebody's garden. Snapping the corner instead costs the cell a few tens
  // of metres of shape and buys a boundary that is street all the way.
  //
  // Once per corner, not once per edge: the three cells meeting at a vertex
  // have to agree on where it went, or their rings no longer close and
  // polygonize returns fewer faces than there are territories.

  function _phase4(outerFeature, outerRing, cells, centroids, graph, buildingPts) {
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

      // isOnOuterBoundary walks the whole ring, and phase 4 asks it three
      // times for every unique cell edge. On a Nominatim city boundary - two
      // thousand vertices after simplification - against four thousand edges,
      // that is 24 million segment distances and about 200 ms of the run.
      // Stamping the ring into the grid index turns each question into a
      // lookup over the handful of segments in the neighboring cells.
      var BOUNDARY_TOLERANCE_DEG = 0.00005;
      var ringIndex = new SP.Grid(25);
      for (var ri = 0; ri < outerRing.length - 1; ri++) {
        ringIndex.addSegment(outerRing[ri], outerRing[ri + 1], ri);
      }

      function isOnRing(point) {
        var near = ringIndex.candidates(point, 1);
        for (var i = 0; i < near.length; i++) {
          var seg = ringIndex.items[near[i]];
          if (
            G.pointToSegmentDist(point, seg.a, seg.b) < BOUNDARY_TOLERANCE_DEG
          )
            return true;
        }
        return false;
      }

      // Corner -> the point the boundary should actually turn at.
      var anchors = Object.create(null);
      var pulled = 0;

      /**
       * Where a cell corner belongs, memoized so every edge meeting there
       * agrees.
       *
       * A corner on the outer ring is left exactly where it is: it is the
       * point at which a territory meets the edge of the area, and moving it
       * would either open a gap along the boundary or push a territory out
       * past it.
       */
      function anchor(point, onRing) {
        if (onRing || graph.count === 0) return point;
        var key = coordKey(point);
        var known = anchors[key];
        if (known !== undefined) return known;

        var hit = graph.grid.nearestPoint(point, VERTEX_SNAP_MAX_M);
        if (hit) pulled++;
        anchors[key] = hit ? hit.coord : point;
        return anchors[key];
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
            var ring1 = isOnRing(p1);
            var ring2 = isOnRing(p2);
            uniqueEdges[key] = {
              a: anchor(p1, ring1),
              b: anchor(p2, ring2),
              onOuter: ring1 && ring2 && isOnRing(mid),
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
            boundaryLines.push([e.a, e.b]);
            continue;
          }
          // Both ends are already graph nodes wherever one was near enough to
          // pull, so the connector _findStreetPathForEdge would otherwise add
          // has nothing to span and the whole edge comes back as street.
          var path = _findStreetPathForEdge(e.a, e.b, graph);
          boundaryLines.push(path && path.length >= 2 ? path : [e.a, e.b]);
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
          "| corners pulled onto a street:", pulled, "of", Object.keys(anchors).length,
          "| graph hits:", _stats.hits,
          "misses:", _stats.misses,
          "| A* gave up on:", _stats.capped,
        );

        _defer(function () {
          _phase5(
            outerFeature,
            outerRing,
            cells,
            centroids,
            boundaryLines,
            buildingPts,
          );
        });
      }

      routeChunk(0);
    });
  }

  // PHASE 5 - polygonize, assign, balance, gap-fill, enforce connectivity,
  // render

  function _phase5(
    outerFeature,
    outerRing,
    cells,
    centroids,
    boundaryLines,
    buildingPts,
  ) {
    App.ui.setPhase(5);
    _defer(function () {
      var k = centroids.length;

      // Polygonize the street-snapped boundary
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

      // Assign each piece to the cell that contains it
      var centroidCoords = centroids.map(function (c) {
        return c.geometry.coordinates;
      });
      var byDistance = 0;

      // Which territory each piece belongs to, kept as an index per piece
      // rather than unioned straight away. App.balance trades pieces between
      // territories, and a piece is only tradeable while it is still a piece:
      // once the shapes are welded together, moving one block from a
      // fifty-building territory to a five-building neighbor is a difference
      // and a union against outlines that no longer record where the blocks
      // were.
      var owner = pieces.map(function (piece) {
        var assignment = _assignPiece(piece, cells, centroidCoords);
        if (assignment === null) return -1;
        if (assignment.fallback) byDistance++;
        return assignment.index;
      });

      if (byDistance > 0) {
        console.log(">>> Pieces assigned by distance fallback:", byDistance);
      }

      // The second place the modes part company: even out the houses, or even
      // out the ground, whichever the dialog promised.
      var balanced =
        _mode === "buildings"
          ? App.balance.byBuildings(pieces, owner, buildingPts)
          : App.balance.byArea(pieces, owner);

      if (balanced) {
        var unit = _mode === "buildings" ? " buildings" : " m2";
        console.log(
          ">>> Balance: target", Math.round(balanced.target) + unit, "|",
          balanced.moves, "blocks traded in", balanced.passes, "passes |",
          "spread", Math.round(balanced.before.min) + "-" + Math.round(balanced.before.max),
          "->", Math.round(balanced.after.min) + "-" + Math.round(balanced.after.max),
        );
      }

      var slots = Object.create(null);
      pieces.forEach(function (piece, i) {
        var idx = owner[i];
        if (idx < 0) return;
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

      // Clip every slot to the outer polygon
      Object.keys(slots).forEach(function (idx) {
        try {
          var clipped = G.intersect(slots[idx], outerFeature);
          if (clipped && clipped.geometry) slots[idx] = clipped;
        } catch (e) {
          /* leave unclipped rather than dropping the slot */
        }
      });

      console.log(">>> Slots filled:", Object.keys(slots).length, "of", k);

      // Fill any uncovered remainder
      // Must run before _enforceConnectivity, which can add slots that have no
      // matching centroid.
      _fillGaps(slots, outerFeature, centroidCoords);

      // Guarantee every territory is a single connected piece
      _enforceConnectivity(slots, buildingPts);

      // Take every boundary off the buildings it runs through
      // Last, because the two passes above both weld shapes together with
      // unionHealed, which buffers out and back by half a meter and rounds
      // whatever outline it touches - including one already sitting on a
      // wall. Going the other way round would put boundaries back into
      // buildings after this had taken them out. Nothing here can undo the
      // connectivity pass in return: a footprint handed over is refused
      // outright if it would leave a territory in more pieces than it found
      // it in.
      _detachBuildings(slots);

      // Emit
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

      // Territories that belong to the boundary's other areas are carried
      // through untouched, printed marks and all. setClusters replaces the
      // whole list, so splitting the second of three villages would otherwise
      // wipe the two nobody touched.
      var elsewhere = App.polygons.clusterFeatures().filter(function (feature) {
        var coord = G.interiorCoord(feature);
        if (!coord) return false;
        try {
          return !turf.booleanPointInPolygon(turf.point(coord), outerFeature);
        } catch (e) {
          return false;
        }
      });

      if (App.history) App.history.push();
      App.polygons.setClusters(elsewhere.concat(partitions));
      App.ui.hideOverlay();
      console.log(
        ">>> Partition complete:",
        partitions.length,
        "clusters,",
        elsewhere.length,
        "kept from the other areas",
        "|", _spreadOf(partitions, buildingPts),
      );
    });
  }

  /**
   * What the run is about to hand over, in the unit it was asked for.
   *
   * Measured on the finished territories rather than reported from the balance
   * pass, because three passes move ground after it: gap fragments go to the
   * nearest touching centroid, connectivity orphans to the neighbor they share
   * the most boundary with, and footprints on a boundary go whole to whoever
   * holds most of them. None of the three measures anything, so the spread
   * App.balance reports is a statement about the middle of phase 5 and this is
   * the one about its output - the territories the tooltip will describe and
   * the cards will be printed from.
   *
   * @returns {string} "buildings 14-26 (avg 20.0)", or the same in m2
   */
  function _spreadOf(partitions, buildingPts) {
    if (partitions.length === 0) return "no territories";

    var byBuildings = _mode === "buildings";
    if (byBuildings && (!buildingPts || buildingPts.length === 0)) {
      return "no buildings";
    }

    var weights = byBuildings
      ? App.balance.counts(partitions, buildingPts)
      : partitions.map(function (f) {
          try {
            return turf.area(f);
          } catch (e) {
            return 0;
          }
        });

    var min = Infinity;
    var max = -Infinity;
    var sum = 0;
    weights.forEach(function (w) {
      if (w < min) min = w;
      if (w > max) max = w;
      sum += w;
    });

    var avg = sum / weights.length;
    return byBuildings
      ? "buildings " + min + "-" + max + " (avg " + avg.toFixed(1) + ")"
      : "m2 " + Math.round(min) + "-" + Math.round(max) +
        " (avg " + Math.round(avg) + ")";
  }

  // ASSIGNMENT

  /**
   * A point guaranteed to lie inside the feature.
   *
   * turf.centroid is the vertex mean, so for the L and crescent shapes that
   * street-following boundaries produce it lands outside the polygon - often
   * inside a neighbor, which is how a piece lands in the wrong territory.
   * Shared with labels.js and naming.js through G.interiorPoint: the number
   * chip, the piece assignment and the reverse lookup have to agree on where
   * the inside of a territory is.
   */
  function _representativePoint(feature) {
    return G.interiorPoint(feature);
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
   * the Voronoi edges that proximity alone puts pieces in territories whose
   * body is somewhere else entirely.
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
        /* malformed cell - try the next */
      }
    }

    var idx = _nearestIndex(pt.geometry.coordinates, centroidCoords);
    return idx === null ? null : { index: idx, fallback: true };
  }

  // GAP FILLING

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
      // distance welds fragments onto territories across the map, which is one
      // of the ways a territory ends up in two pieces.
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

    var probeBox;
    try {
      probeBox = turf.bbox(probe);
    } catch (e) {
      probeBox = null;
    }

    var hits = [];
    Object.keys(slots).forEach(function (idx) {
      if (idx === exclude) return;
      try {
        if (probeBox && !G.bboxOverlap(probeBox, turf.bbox(slots[idx]))) return;
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

  // BUILDINGS ON THE BOUNDARY

  /**
   * Move any boundary that runs through a building onto that building's wall.
   *
   * Phase 4 routes every cell edge along the street network, and where it
   * succeeds this pass finds nothing to do - a street is not inside a house.
   * Where it fails the edge stays the straight Voronoi line, and a straight
   * line across a block goes through whatever is built on it. Those are the
   * ones this repairs, and it repairs them the same way autoheal does later:
   * the footprint goes whole to whichever territory already holds most of it,
   * so the boundary comes to rest on the outline instead of across the middle.
   *
   * Not a substitute for the routing. A boundary along a wall is a boundary
   * you can point at but not one you can walk; a street is both. This is what
   * happens when there is no street to be had.
   */
  function _detachBuildings(slots) {
    if (!App.footprints) return;

    var keys = Object.keys(slots);
    if (keys.length < 2) return;

    var result = App.footprints.detach(
      keys.map(function (idx) {
        return slots[idx];
      }),
    );
    if (result.resolved === 0 && result.unresolved === 0) return;

    result.changed.forEach(function (position) {
      slots[keys[position]] = result.features[position];
    });

    console.log(
      ">>> Buildings on a boundary:",
      result.resolved,
      "moved onto the wall",
      result.unresolved > 0
        ? "| " + result.unresolved + " could not be, and stay flagged"
        : "",
    );
  }

  // CONNECTIVITY

  /**
   * Make every territory a single connected polygon.
   *
   * Containment-based assignment and adjacency-checked gap filling make split
   * territories unlikely; this makes them impossible. Any slot that is still
   * multi-part keeps its largest part and hands each orphan to the neighbor
   * it shares the most boundary with.
   *
   * An orphan that touches nothing becomes its own territory rather than being
   * welded to a distant slot - that would recreate the exact bug this exists to
   * prevent. Empty orphans below 5% of an average territory are dropped
   * instead: at that size they are invisible on the map but still counted in
   * the info panel and still printable as a card, which reads as a partition
   * that produced one more territory than it appears to have.
   *
   * Empty, and only empty. A dropped orphan is in no territory at all, so a
   * house standing on one gets no card and turns up on nobody's round - and
   * unlike the speck the rule is aimed at, that is a fault nothing downstream
   * reports. A tiny territory somebody has to walk to is the better of the two
   * outcomes, and the one the size test was never meant to rule out.
   */
  function _enforceConnectivity(slots, buildingPts) {
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

          if (area < minArea && _holdsNothing(orphan, buildingPts)) {
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
    // places - that is the whole point of this function.
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
        if (area < minArea && _holdsNothing(orphan, buildingPts)) {
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

  /** Whether no building stands on `feature`. */
  function _holdsNothing(feature, buildingPts) {
    if (!buildingPts || buildingPts.length === 0) return true;
    return App.balance.counts([feature], buildingPts)[0] === 0;
  }

  function _nextSlotKey(slots) {
    var max = -1;
    Object.keys(slots).forEach(function (idx) {
      var n = parseInt(idx, 10);
      if (!isNaN(n) && n > max) max = n;
    });
    return String(max + 1);
  }

  // STREET GRAPH

  /**
   * Build an undirected weighted graph of the street network, plus a grid
   * index for nearest-node lookups.
   * Node: { coords: [lng, lat], adj: { neighborKey: meters } }
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

  // A*

  /**
   * Shortest street path between two graph nodes, biased toward one heading.
   *
   * `desiredBearing` is the straight line the Voronoi edge would have taken.
   * A step is charged up to 30% extra for turning away from it, which is
   * enough to prefer the road that runs alongside the edge over an equally
   * short detour at right angles to it, and not enough to reject a genuine
   * dogleg. Gives up after STREET_SEARCH_MAX_ITER pops so a partition cannot
   * stall on two endpoints in different components.
   *
   * @returns {number[][]|null} coordinates, endpoints included
   */
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
  };
})();

window.App = App;
