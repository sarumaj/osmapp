/**
 * editing.js — street-snapped split lines, merge mode, cluster cleanup.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.editing = (function () {
  "use strict";

  var s = null;
  var G = null;
  var SP = null;
  var D = null;

  // ── Draw state ────────────────────────────────────────────────────────
  var _points = []; // [{ latlng, t }]
  var _previewLine = null;
  var _rubberBand = null;
  var _snapDot = null;
  var _hintBanner = null;
  var _mergeToolbar = null;

  var _pendingMove = null;
  var _moveQueued = false;

  // ── Snap index ────────────────────────────────────────────────────────
  var _segments = []; // { p1: LatLng, p2: LatLng, kind }
  var _nodes = Object.create(null); // key -> LatLng
  var _adj = Object.create(null); // key -> [{ key, dist }]
  var _segGrid = null;
  var _nodeGrid = null;

  var STREET_SNAP_THRESHOLD_M = 30;
  var DBLCLICK_MS = 300;
  var T = null;

  function init() {
    s = App.state;
    G = App.geometry;
    SP = App.spatial;
    D = App.dom;
    T = App.i18n.t;
    document.addEventListener("keydown", _onKeyDown);
    App._loaded.push("editing");
  }

  // ══════════════════════════════════════════════════════════════════════
  // SNAP INDEX
  // ══════════════════════════════════════════════════════════════════════

  function rebuildSnapIndex() {
    _segments = [];
    _nodes = Object.create(null);
    _adj = Object.create(null);

    if (s.cachedStreets && s.cachedStreets.features) {
      s.cachedStreets.features.forEach(function (feature) {
        if (!feature.geometry) return;
        var lines =
          feature.geometry.type === "MultiLineString"
            ? feature.geometry.coordinates
            : [feature.geometry.coordinates];

        lines.forEach(function (line) {
          for (var i = 0; i < line.length - 1; i++) {
            var p1 = L.latLng(line[i][1], line[i][0]);
            var p2 = L.latLng(line[i + 1][1], line[i + 1][0]);
            var k1 = _nodeKey(p1),
              k2 = _nodeKey(p2);
            if (k1 === k2) continue;

            var d = p1.distanceTo(p2);
            _segments.push({ p1: p1, p2: p2, kind: "street" });
            _nodes[k1] = p1;
            _nodes[k2] = p2;
            (_adj[k1] || (_adj[k1] = [])).push({ key: k2, dist: d });
            (_adj[k2] || (_adj[k2] = [])).push({ key: k1, dist: d });
          }
        });
      });
    }

    // Existing cluster and outer boundaries are snap targets too, so split
    // lines meet them cleanly.
    App.polygons.clusterLayers().forEach(_addLayerEdges);
    if (s.outerPolygonLayer) _addLayerEdges(s.outerPolygonLayer);

    _segGrid = new SP.Grid(120);
    _segments.forEach(function (seg) {
      _segGrid.addSegment(
        [seg.p1.lng, seg.p1.lat],
        [seg.p2.lng, seg.p2.lat],
        seg,
      );
    });

    _nodeGrid = new SP.Grid(120);
    Object.keys(_nodes).forEach(function (key) {
      _nodeGrid.addPoint([_nodes[key].lng, _nodes[key].lat], key);
    });

    console.log(
      ">>> Snap index:",
      _segments.length,
      "segments,",
      Object.keys(_nodes).length,
      "nodes",
    );
  }

  function _nodeKey(latlng) {
    return latlng.lat.toFixed(5) + "," + latlng.lng.toFixed(5);
  }

  function _addLayerEdges(layer) {
    if (!layer || !layer.getLatLngs) return;
    (function walk(arr) {
      if (!Array.isArray(arr) || arr.length === 0) return;
      if (arr[0] instanceof L.LatLng) {
        for (var i = 0; i < arr.length; i++) {
          _segments.push({
            p1: arr[i],
            p2: arr[(i + 1) % arr.length],
            kind: "edge",
          });
        }
      } else {
        arr.forEach(walk);
      }
    })(layer.getLatLngs());
  }

  function _snapToStreet(latlng) {
    if (!_segGrid) return { point: latlng, kind: "street" };
    var hit = _segGrid.nearestSegment(
      [latlng.lng, latlng.lat],
      s.STREET_SNAP_MAX_M,
    );
    if (!hit) return { point: latlng, kind: "street" };
    return {
      point: L.latLng(hit.coord[1], hit.coord[0]),
      kind: hit.payload.kind || "street",
    };
  }

  function _nearestStreetNode(latlng) {
    if (!_nodeGrid) return null;
    var hit = _nodeGrid.nearestPoint(
      [latlng.lng, latlng.lat],
      s.ROUTE_SNAP_MAX_M,
    );
    if (!hit) return null;
    return { key: hit.payload, latlng: _nodes[hit.payload], dist: hit.dist };
  }

  // ══════════════════════════════════════════════════════════════════════
  // ROUTING
  // ══════════════════════════════════════════════════════════════════════

  function _dijkstra(startKey, endKey) {
    if (startKey === endKey) return [_nodes[startKey]];
    if (!_adj[startKey] || !_adj[endKey]) return null;

    var dist = Object.create(null);
    var prev = Object.create(null);
    var visited = Object.create(null);
    var heap = new SP.MinHeap();

    dist[startKey] = 0;
    heap.push({ k: startKey, f: 0 });

    while (heap.size() > 0) {
      var cur = heap.pop().k;
      if (visited[cur]) continue;
      visited[cur] = true;
      if (cur === endKey) break;

      var neighbors = _adj[cur] || [];
      for (var i = 0; i < neighbors.length; i++) {
        var nb = neighbors[i];
        if (visited[nb.key]) continue;
        var alt = dist[cur] + nb.dist;
        if (dist[nb.key] === undefined || alt < dist[nb.key]) {
          dist[nb.key] = alt;
          prev[nb.key] = cur;
          heap.push({ k: nb.key, f: alt });
        }
      }
    }

    if (prev[endKey] === undefined && startKey !== endKey) return null;

    var path = [];
    var node = endKey;
    while (node !== undefined) {
      path.unshift(_nodes[node]);
      node = prev[node];
    }
    return path.length > 0 ? path : null;
  }

  function _routeAlongStreets(points) {
    if (points.length < 2) return points;
    var result = [];

    for (var i = 0; i < points.length - 1; i++) {
      var a = points[i],
        b = points[i + 1];
      var nodeA = _nearestStreetNode(a);
      var nodeB = _nearestStreetNode(b);
      var straight = a.distanceTo(b);
      var canRoute =
        nodeA &&
        nodeB &&
        (nodeA.dist < STREET_SNAP_THRESHOLD_M ||
          nodeB.dist < STREET_SNAP_THRESHOLD_M);

      if (canRoute) {
        var path = _dijkstra(nodeA.key, nodeB.key);
        if (path && path.length >= 2) {
          var routed = 0;
          for (var p = 0; p < path.length - 1; p++)
            routed += path[p].distanceTo(path[p + 1]);
          // Reject wild detours; a straight segment is better than a
          // four-times-longer loop around the block.
          if (routed <= straight * 4) {
            for (var j = i === 0 ? 0 : 1; j < path.length; j++)
              result.push(path[j]);
            continue;
          }
        }
      }

      if (i === 0) result.push(a);
      result.push(b);
    }
    return result;
  }

  // ── Extend the split line out to the nearest boundaries ───────────────

  function _boundarySegments() {
    var segments = [];
    function add(layer) {
      if (!layer || !layer.getLatLngs) return;
      (function walk(arr) {
        if (!Array.isArray(arr) || arr.length === 0) return;
        if (arr[0] instanceof L.LatLng) {
          for (var i = 0; i < arr.length; i++)
            segments.push({ p1: arr[i], p2: arr[(i + 1) % arr.length] });
        } else {
          arr.forEach(walk);
        }
      })(layer.getLatLngs());
    }
    App.polygons.clusterLayers().forEach(add);
    if (s.outerPolygonLayer) add(s.outerPolygonLayer);
    return segments;
  }

  function _extendToBoundaries(points) {
    if (points.length < 2) return points;
    var segments = _boundarySegments();

    var extDeg = 1.0;
    if (s.outerPolygonLayer) {
      var b = s.outerPolygonLayer.getBounds();
      var dLat = b.getNorth() - b.getSouth();
      var dLng = b.getEast() - b.getWest();
      extDeg = Math.sqrt(dLat * dLat + dLng * dLng) * 2;
    }

    function extend(from, to) {
      var dLat = to.lat - from.lat,
        dLng = to.lng - from.lng;
      var len = Math.sqrt(dLat * dLat + dLng * dLng);
      if (len === 0) return to;
      var far = L.latLng(
        to.lat + (dLat / len) * extDeg,
        to.lng + (dLng / len) * extDeg,
      );
      var bestDist = Infinity,
        best = null;
      segments.forEach(function (seg) {
        var hit = _segmentIntersection(to, far, seg.p1, seg.p2);
        if (!hit) return;
        var d = to.distanceTo(hit);
        if (d < bestDist) {
          bestDist = d;
          best = hit;
        }
      });
      return best || to;
    }

    var out = points.slice();
    out[0] = extend(out[1], out[0]);
    out[out.length - 1] = extend(out[out.length - 2], out[out.length - 1]);
    return out;
  }

  function _segmentIntersection(a, b, c, d) {
    var r = { lat: b.lat - a.lat, lng: b.lng - a.lng };
    var t2 = { lat: d.lat - c.lat, lng: d.lng - c.lng };
    var denom = r.lat * t2.lng - r.lng * t2.lat;
    if (Math.abs(denom) < 1e-12) return null;
    var diff = { lat: c.lat - a.lat, lng: c.lng - a.lng };
    var t = (diff.lat * t2.lng - diff.lng * t2.lat) / denom;
    var u = (diff.lat * r.lng - diff.lng * r.lat) / denom;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1)
      return L.latLng(a.lat + t * r.lat, a.lng + t * r.lng);
    return null;
  }

  // ══════════════════════════════════════════════════════════════════════
  // DRAW MODE
  // ══════════════════════════════════════════════════════════════════════

  function toggleEditMode() {
    var next = !s.editMode;

    if (next) {
      if (!s.outerPolygonDrawn) {
        alert(T("alert.drawAndLoadFirst"));
        return;
      }
      if (s.mergeMode) toggleMergeMode();
    }

    s.editMode = next;
    var btn = document.querySelector(".tb-btn.edit-mode-btn");
    if (btn) btn.classList.toggle("is-active", next);

    if (next) _startDraw();
    else _stopDraw();
  }

  function _startDraw() {
    _points = [];
    rebuildSnapIndex();

    // The cursor belongs to the split line from here on: no tooltip trailing
    // it, no hover highlight lifting a cluster over the preview.
    App.polygons.setTooltipMode("off");
    App.polygons.clearHover();

    _previewLine = L.polyline([], {
      color: "#e74c3c",
      weight: 3,
      dashArray: "6 4",
      opacity: 0.9,
    }).addTo(s.leafletMap);

    _rubberBand = L.polyline([], {
      color: "#e74c3c",
      weight: 2,
      dashArray: "3 6",
      opacity: 0.6,
    }).addTo(s.leafletMap);

    _snapDot = L.circleMarker([0, 0], {
      radius: 6,
      color: "#e74c3c",
      fillColor: "#fff",
      fillOpacity: 1,
      weight: 2,
    }).addTo(s.leafletMap);

    _hintBanner = D.mountOnMap("tpl-draw-hint", s.leafletMap);

    s.leafletMap.doubleClickZoom.disable();
    s.leafletMap.dragging.disable();
    s.leafletMap.on("mousemove", _onDrawMouseMove);
    s.leafletMap.on("click", _onDrawClick);
    s.leafletMap.on("dblclick", _onDrawDblClick);
  }

  function _stopDraw() {
    App.polygons.setTooltipMode(s.mergeMode ? "anchored" : "full");

    s.leafletMap.off("mousemove", _onDrawMouseMove);
    s.leafletMap.off("click", _onDrawClick);
    s.leafletMap.off("dblclick", _onDrawDblClick);

    try {
      s.leafletMap.doubleClickZoom.enable();
      s.leafletMap.dragging.enable();
    } catch (e) {
      /* map may already be gone */
    }

    [_previewLine, _rubberBand, _snapDot].forEach(function (layer) {
      if (layer) s.leafletMap.removeLayer(layer);
    });
    _previewLine = _rubberBand = _snapDot = null;
    _hintBanner = D.remove(_hintBanner);
    _points = [];
    _pendingMove = null;
    _moveQueued = false;
  }

  function _onDrawMouseMove(e) {
    _pendingMove = e.latlng;
    if (_moveQueued) return;
    _moveQueued = true;
    requestAnimationFrame(function () {
      _moveQueued = false;
      if (!s.editMode || !_pendingMove) return;
      _applySnapPreview(_pendingMove);
    });
  }

  function _applySnapPreview(latlng) {
    var hit = _snapToStreet(latlng);
    if (_snapDot) {
      _snapDot.setLatLng(hit.point);
      _snapDot.setStyle({
        color: hit.kind === "edge" ? "#2980b9" : "#e74c3c",
        fillColor: "#fff",
      });
    }
    if (_rubberBand && _points.length > 0) {
      _rubberBand.setLatLngs([_points[_points.length - 1].latlng, hit.point]);
    }
  }

  function _onDrawClick(e) {
    L.DomEvent.stopPropagation(e);
    L.DomEvent.preventDefault(e);
    var snapped = _snapToStreet(e.latlng).point;
    _points.push({ latlng: snapped, t: Date.now() });
    if (_previewLine) _previewLine.setLatLngs(_latlngs());
    if (_points.length === 1 && _rubberBand)
      _rubberBand.setLatLngs([snapped, snapped]);
  }

  function _latlngs() {
    return _points.map(function (p) {
      return p.latlng;
    });
  }

  /**
   * Leaflet fires click, click, dblclick. Both trailing clicks belong to the
   * double-click, so drop anything placed inside the threshold and put a
   * single vertex at the double-click position instead. The old code popped
   * exactly one point, which left the vertex count off by one.
   */
  function _onDrawDblClick(e) {
    L.DomEvent.stopPropagation(e);
    L.DomEvent.preventDefault(e);

    var now = Date.now();
    while (
      _points.length &&
      now - _points[_points.length - 1].t < DBLCLICK_MS
    ) {
      _points.pop();
    }
    _points.push({ latlng: _snapToStreet(e.latlng).point, t: now });

    var pts = _latlngs();
    s.editMode = false;
    _stopDraw();
    var btn = document.querySelector(".tb-btn.edit-mode-btn");
    if (btn) btn.classList.remove("is-active");

    if (pts.length < 2) {
      console.warn(">>> Need at least two vertices to split");
      return;
    }

    var routed = _extendToBoundaries(_routeAlongStreets(pts));

    var preview = L.polyline(routed, {
      color: "#27ae60",
      weight: 3,
      opacity: 0.9,
    }).addTo(s.leafletMap);
    setTimeout(function () {
      s.leafletMap.removeLayer(preview);
    }, 2000);

    App.ui.showBusy(T("loading.cutting"));
    setTimeout(function () {
      _splitWithLine(routed);
    }, 30);
  }

  function _onKeyDown(e) {
    if (e.key !== "Escape") return;
    if (s.editMode) {
      toggleEditMode();
      return;
    }
    if (s.mergeMode) toggleMergeMode();
  }

  // ══════════════════════════════════════════════════════════════════════
  // SPLIT
  // ══════════════════════════════════════════════════════════════════════

  function _splitWithLine(points) {
    if (s.clusters.length === 0) {
      App.ui.hideOverlay();
      alert(T("alert.cutNothing"));
      return;
    }

    var line = turf.lineString(
      points.map(function (p) {
        return [p.lng, p.lat];
      }),
    );

    var features = App.polygons.clusterFeatures();
    var result = [];
    var splitCount = 0;
    var index = 0;

    function step() {
      var deadline = performance.now() + 16; // stay under one frame

      while (index < features.length && performance.now() < deadline) {
        var feature = features[index];
        var intersects = false;
        try {
          intersects = turf.booleanIntersects(line, G.feat(feature.geometry));
        } catch (e) {
          /* treat as no intersection */
        }

        if (!intersects) {
          result.push(feature);
        } else {
          var pieces = _cutWithLine(feature, line);
          if (!pieces) {
            result.push(feature);
          } else {
            splitCount++;
            pieces.forEach(function (geometry) {
              result.push({
                type: "Feature",
                geometry: geometry,
                properties: {},
              });
            });
          }
        }
        index++;
      }

      App.ui.setOverlayStatus(
        T("loading.progress", { index: index, total: features.length }),
      );

      if (index < features.length) {
        setTimeout(step, 0);
        return;
      }

      if (splitCount > 0) {
        if (App.history) App.history.push();
        App.polygons.setClusters(result);
      }
      App.ui.hideOverlay();
      console.log(
        ">>> Split:",
        splitCount,
        "clusters cut ->",
        s.clusters.length,
        "total",
      );
      if (splitCount === 0) {
        alert(T("alert.cutMissed"));
      }
    }

    step();
  }

  /**
   * Subtract a thin buffer around `line` from every polygonal part of
   * `feature`. Returns geometries only when the part count actually grew —
   * otherwise a MultiPolygon that was merely trimmed would look like a split.
   */
  function _cutWithLine(feature, line) {
    var OFFSET_KM = 0.000015;
    var parts = G.polygonParts(feature);
    if (parts.length === 0) return null;

    var knife;
    try {
      knife = turf.buffer(G.feat(line), OFFSET_KM, {
        units: "kilometers",
        steps: 1,
      });
    } catch (e) {
      console.warn(">>> Could not build the cutting buffer:", e.message);
      return null;
    }
    if (!knife || !knife.geometry) return null;

    var out = [];
    parts.forEach(function (part) {
      var cut = null;
      try {
        cut = G.difference(part, knife);
      } catch (e) {
        cut = null;
      }
      if (!cut || !cut.geometry) {
        out.push(part.geometry);
        return;
      }
      G.polygonParts(cut).forEach(function (piece) {
        out.push(piece.geometry);
      });
    });

    return out.length > parts.length ? out : null;
  }

  // ══════════════════════════════════════════════════════════════════════
  // MERGE MODE
  // ══════════════════════════════════════════════════════════════════════

  function toggleMergeMode() {
    s.mergeMode = !s.mergeMode;
    var btn = document.querySelector(".tb-btn.merge-mode-btn");
    if (btn) btn.classList.toggle("is-active", s.mergeMode);

    if (s.mergeMode) {
      if (s.editMode) toggleEditMode();
      s.selectedClusters = [];
      // Selecting means clicking the shape, so the tooltip is pinned above it
      // rather than sitting under the pointer — the count still reads, the
      // click target stays clear.
      App.polygons.setTooltipMode("anchored");
      _showMergeToolbar();
    } else {
      App.polygons.setTooltipMode("full");
      _clearSelection();
      _hideMergeToolbar();
    }
  }

  function handleClusterSelectClick(layer, feature) {
    var idx = -1;
    for (var i = 0; i < s.selectedClusters.length; i++) {
      if (s.selectedClusters[i].layer === layer) {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      App.polygons.selectCluster(layer, false);
      s.selectedClusters.splice(idx, 1);
    } else {
      s.selectedClusters.push({ layer: layer, feature: feature });
      App.polygons.selectCluster(layer, true);
    }
    _updateMergeCount();
  }

  function mergeSelectedClusters() {
    if (s.selectedClusters.length < 2) {
      alert(T("alert.mergeTooFew"));
      return;
    }

    var selected = s.selectedClusters.slice();
    _hideMergeToolbar();
    App.ui.showBusy(T("loading.merging"));

    setTimeout(function () {
      var merged;
      try {
        App.ui.setOverlayStatus(T("loading.dissolving"));
        // unionHealed grows each input by half a metre before unioning, so
        // boundaries that only nearly coincide still dissolve. A plain union
        // left hairline slivers, and Leaflet drew the internal outlines.
        merged = G.unionHealed(
          selected.map(function (item) {
            return item.feature;
          }),
        );
        if (!merged || !merged.geometry)
          throw new Error("union returned nothing");
      } catch (e) {
        App.ui.hideOverlay();
        console.error(">>> Merge failed:", e);
        alert(T("alert.mergeFailed", { message: e.message }));
        toggleMergeMode();
        return;
      }

      if (s.outerPolygonLayer) {
        try {
          var clipped = G.intersect(
            merged,
            G.getOuterFeature(s.outerPolygonLayer),
          );
          if (clipped && clipped.geometry) merged = clipped;
        } catch (e) {
          console.warn(
            ">>> Could not clip the merge to the outer polygon:",
            e.message,
          );
        }
      }

      if (App.history) App.history.push();

      var kept = App.polygons.clusterFeatures().filter(function (f) {
        return !selected.some(function (sel) {
          return sel.feature === f;
        });
      });
      kept.push({
        type: "Feature",
        geometry: merged.geometry,
        properties: {},
      });

      App.polygons.setClusters(kept);
      App.ui.hideOverlay();
      toggleMergeMode();
      console.log(">>> Merged into", s.clusters.length, "clusters");
    }, 30);
  }

  function _showMergeToolbar() {
    _hideMergeToolbar();
    _mergeToolbar = D.mountOnMap("tpl-merge-toolbar", s.leafletMap);
    D.onRole(_mergeToolbar, "merge", mergeSelectedClusters);
    D.onRole(_mergeToolbar, "cancel", toggleMergeMode);
    _updateMergeCount();
  }

  function _hideMergeToolbar() {
    _mergeToolbar = D.remove(_mergeToolbar);
  }

  function _updateMergeCount() {
    if (_mergeToolbar)
      D.text(_mergeToolbar, "count", s.selectedClusters.length + " selected");
  }

  function _clearSelection() {
    s.selectedClusters.forEach(function (item) {
      App.polygons.selectCluster(item.layer, false);
    });
    s.selectedClusters = [];
    _updateMergeCount();
  }

  // ══════════════════════════════════════════════════════════════════════
  // CLEANUP — absorb clusters that contain no buildings
  // ══════════════════════════════════════════════════════════════════════

  function cleanupClusters() {
    if (s.clusters.length === 0) {
      alert(T("alert.cleanupNothing"));
      return;
    }
    if (!s.cachedBuildings || s.cachedBuildings.features.length === 0) {
      alert(T("alert.cleanupNoBuildings"));
      return;
    }

    App.ui.showBusy(T("loading.cleanup"), T("loading.cleanupStatus"));
    setTimeout(_runCleanup, 30);
  }

  function _runCleanup() {
    var outerFeature = null;
    try {
      outerFeature = s.outerPolygonLayer
        ? G.getOuterFeature(s.outerPolygonLayer)
        : null;
    } catch (e) {
      outerFeature = null;
    }

    var features = App.polygons.clusterFeatures().slice();
    var pass = 0;
    var MAX_PASSES = 20;

    while (pass < MAX_PASSES) {
      pass++;
      App.ui.setOverlayStatus(T("loading.pass", { n: pass }));

      var counts = _countBuildingsPerCluster(features);
      var emptyIdx = counts.indexOf(0);
      if (emptyIdx < 0) break;

      var empty = G.feat(features[emptyIdx]);
      var emptyCentroid = turf.centroid(empty).geometry.coordinates;

      // Nearest touching neighbor absorbs it; if nothing touches, drop it.
      var bestIdx = -1,
        bestD2 = Infinity;
      for (var j = 0; j < features.length; j++) {
        if (j === emptyIdx) continue;
        var neighbor = G.feat(features[j]);
        var touches = false;
        try {
          touches = !!G.intersect(empty, neighbor);
        } catch (e) {
          touches = false;
        }
        if (!touches) continue;
        var d2 = SP.distSq(
          emptyCentroid,
          turf.centroid(neighbor).geometry.coordinates,
        );
        if (d2 < bestD2) {
          bestD2 = d2;
          bestIdx = j;
        }
      }

      if (bestIdx >= 0) {
        try {
          var merged = G.union(features[bestIdx], empty);
          if (merged && outerFeature) {
            var clipped = G.intersect(merged, outerFeature);
            if (clipped && clipped.geometry) merged = clipped;
          }
          if (merged && merged.geometry) {
            features[bestIdx] = {
              type: "Feature",
              geometry: merged.geometry,
              properties: features[bestIdx].properties || {},
            };
          }
        } catch (e) {
          console.warn(">>> Absorb failed:", e.message);
        }
      }

      features.splice(emptyIdx, 1);
    }

    if (App.history) App.history.push();
    App.polygons.setClusters(features);
    App.ui.hideOverlay();
    console.log(
      ">>> Cleanup finished in",
      pass,
      "passes:",
      features.length,
      "clusters",
    );
  }

  /**
   * One pass over the buildings assigning each to at most one cluster, with a
   * bbox reject first. The previous version tested every building against
   * every cluster inside a 20-iteration loop.
   */
  function _countBuildingsPerCluster(features) {
    var feats = features.map(G.feat);
    var boxes = feats.map(function (f) {
      return turf.bbox(f);
    });
    var counts = feats.map(function () {
      return 0;
    });

    s.cachedBuildings.features.forEach(function (b) {
      if (!b.geometry) return;
      var centroid = b._centroid;
      if (!centroid) {
        try {
          centroid = b._centroid = turf.centroid(G.feat(b.geometry));
        } catch (e) {
          return;
        }
      }
      var c = centroid.geometry.coordinates;
      for (var i = 0; i < feats.length; i++) {
        if (
          c[0] < boxes[i][0] ||
          c[0] > boxes[i][2] ||
          c[1] < boxes[i][1] ||
          c[1] > boxes[i][3]
        )
          continue;
        try {
          if (turf.booleanPointInPolygon(centroid, feats[i])) {
            counts[i]++;
            return;
          }
        } catch (e) {
          /* try the next cluster */
        }
      }
    });

    return counts;
  }

  return {
    init: init,
    toggleEditMode: toggleEditMode,
    toggleMergeMode: toggleMergeMode,
    handleClusterSelectClick: handleClusterSelectClick,
    mergeSelectedClusters: mergeSelectedClusters,
    cleanupClusters: cleanupClusters,
    rebuildSnapIndex: rebuildSnapIndex,
  };
})();

window.App = App;
