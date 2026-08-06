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
  var _vertexLayer = null;
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

  // ── Waste segmentation ────────────────────────────────────────────────
  var WASTE_TOUCH_SLACK_M = 0.5; // adjacency probe width
  var WASTE_MIN_CONTACT_M2 = 1; // below this is point contact, not an edge
  var WASTE_MIN_BLOCK_M2 = 200; // ignore slivers
  var WASTE_MIN_AREA_M2 = 500; // not worth carving a territory for less

  // ── Dwelling detection ────────────────────────────────────────────────
  // Land is disposable when it holds no dwellings. "No dwellings" is stricter
  // than "no buildings": a block of barns, garages and silos has plenty of
  // buildings and not one door to knock on.
  var WASTE_SMALL_FOOTPRINT_M2 = 45; // under this, an untagged building is an outbuilding
  var WASTE_MAX_UNSURE_PER_HA = 1.5; // ambiguous buildings this sparse read as a farmstead
  var WASTE_MIN_LEVELS = 2; // two storeys or more is a dwelling, not a shed
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

  /**
   * @returns {{point: L.LatLng, kind: "street"|"edge"|"free"}}
   *   "free" means nothing was within STREET_SNAP_MAX_M and the point is being
   *   taken as clicked. The preview dot says so, because a vertex that only
   *   looks snapped produces a split line that wanders off the street grid.
   */
  function _snapToStreet(latlng) {
    if (!_segGrid) return { point: latlng, kind: "free" };
    var hit = _segGrid.nearestSegment(
      [latlng.lng, latlng.lat],
      s.STREET_SNAP_MAX_M,
    );
    if (!hit) return { point: latlng, kind: "free" };
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

    _vertexLayer = L.layerGroup().addTo(s.leafletMap);

    _hintBanner = D.mountOnMap("tpl-draw-hint", s.leafletMap);

    // Dragging stays enabled: Leaflet suppresses the click that follows a drag
    // (_draggableMoved), so panning cannot place a stray vertex, and a split
    // line often runs past the edge of the screen.
    s.leafletMap.doubleClickZoom.disable();
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
    } catch (e) {
      /* map may already be gone */
    }

    [_previewLine, _rubberBand, _snapDot, _vertexLayer].forEach(
      function (layer) {
        if (layer) s.leafletMap.removeLayer(layer);
      },
    );
    _previewLine = _rubberBand = _snapDot = _vertexLayer = null;
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
      // red on a street, blue on an existing boundary, hollow grey when the
      // point is free-floating.
      _snapDot.setStyle({
        color:
          hit.kind === "edge"
            ? "#2980b9"
            : hit.kind === "free"
              ? "#95a5a6"
              : "#e74c3c",
        fillColor: hit.kind === "free" ? "transparent" : "#fff",
        dashArray: hit.kind === "free" ? "2 2" : null,
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
    _renderPoints();
    if (_points.length === 1 && _rubberBand)
      _rubberBand.setLatLngs([snapped, snapped]);
  }

  /** Redraw the committed part of the line and its vertex dots. */
  function _renderPoints() {
    if (_previewLine) _previewLine.setLatLngs(_latlngs());
    if (!_vertexLayer) return;
    _vertexLayer.clearLayers();
    _points.forEach(function (point, i) {
      L.circleMarker(point.latlng, {
        radius: 4,
        color: "#e74c3c",
        fillColor: i === _points.length - 1 ? "#e74c3c" : "#fff",
        fillOpacity: 1,
        weight: 2,
        interactive: false,
      }).addTo(_vertexLayer);
    });
  }

  /**
   * Take back the last vertex. Without this the only ways out of a misplaced
   * click are finishing a line you do not want or Escaping the whole thing.
   * @returns {boolean} whether anything was removed
   */
  function undoPoint() {
    if (!s.editMode || _points.length === 0) return false;
    _points.pop();
    _renderPoints();
    if (_rubberBand) {
      _rubberBand.setLatLngs(
        _points.length && _pendingMove
          ? [
              _points[_points.length - 1].latlng,
              _snapToStreet(_pendingMove).point,
            ]
          : [],
      );
    }
    return true;
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
    // At most the two trailing clicks belong to this gesture. The old loop
    // popped everything inside the window, which ate real vertices from anyone
    // placing points quickly along a street.
    var popped = 0;
    while (
      popped < 2 &&
      _points.length &&
      now - _points[_points.length - 1].t < DBLCLICK_MS
    ) {
      _points.pop();
      popped++;
    }
    _points.push({ latlng: _snapToStreet(e.latlng).point, t: now });
    _finishLine();
  }

  /** Close the line and hand it to the splitter. */
  function _finishLine() {
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
    var tag = ((e.target || {}).tagName || "").toUpperCase();
    var typing = tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";

    if (s.editMode) {
      if (e.key === "Escape") {
        toggleEditMode();
        return;
      }
      // Enter matches the outer-boundary tool, where a double-click is the
      // fiddliest part of the gesture.
      if (e.key === "Enter" && !typing) {
        e.preventDefault();
        if (_points.length >= 2) _finishLine();
        return;
      }
      if ((e.key === "Backspace" || e.key === "Delete") && !typing) {
        e.preventDefault();
        undoPoint();
      }
      return;
    }

    if (e.key === "Escape" && s.mergeMode) toggleMergeMode();
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
    var touchedCount = 0;
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
          touchedCount++;
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
        // Crossing a territory and separating it are different things: a line
        // that enters and leaves through the same edge, or that stops short of
        // the far side, touches without cutting. Saying "did not cross any
        // boundaries" in that case sends people looking for the wrong mistake.
        alert(
          T(touchedCount > 0 ? "alert.cutNoSeparation" : "alert.cutMissed"),
        );
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
  // WASTE SEGMENTATION
  //
  // Rather than eroding a territory's outline geometrically, cut the empty
  // land out along streets and leave it as its own territory. Two things fall
  // out of that: the new edge follows a street because the cut lines are
  // streets, and the empty piece is then just an ordinary building-free
  // territory, which the cleanup pass below already knows how to dispose of.
  // ══════════════════════════════════════════════════════════════════════

  /** A point guaranteed to lie inside the feature. */
  function _repPoint(feature) {
    try {
      return turf.pointOnFeature(G.feat(feature));
    } catch (e) {
      try {
        return turf.centroid(G.feat(feature));
      } catch (e2) {
        return null;
      }
    }
  }

  function _contactArea(probe, feature) {
    try {
      var hit = G.intersect(probe, feature);
      return hit ? turf.area(hit) : 0;
    } catch (e) {
      return 0;
    }
  }

  /** Total rings across every part — used to reject newly punched holes. */
  function _ringCount(feature) {
    return G.polygonParts(feature).reduce(function (n, part) {
      return n + part.geometry.coordinates.length;
    }, 0);
  }

  /**
   * A thin band along the outer boundary. Measuring area overlap against this
   * is far more robust than testing line-polygon intersection at floating
   * point, where a shared edge may or may not register.
   */
  function _outerEdgeBand(outerFeature) {
    try {
      return turf.buffer(
        turf.polygonToLine(outerFeature),
        WASTE_TOUCH_SLACK_M,
        { units: "meters" },
      );
    } catch (e) {
      console.warn(">>> Could not build the outer edge band:", e.message);
      return null;
    }
  }

  function _touchesEdge(feature, edgeBand) {
    if (!edgeBand) return false;
    var probe;
    try {
      probe = turf.buffer(G.feat(feature), WASTE_TOUCH_SLACK_M, {
        units: "meters",
      });
    } catch (e) {
      return false;
    }
    return probe
      ? _contactArea(probe, edgeBand) >= WASTE_MIN_CONTACT_M2
      : false;
  }

  /** Buildings inside a feature — used to report what a discard threw away. */
  function _buildingsIn(feature) {
    if (!s.cachedBuildings || !s.cachedBuildings.features.length) return 0;
    var box;
    try {
      box = turf.bbox(G.feat(feature));
    } catch (e) {
      return 0;
    }

    var count = 0;
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
      if (c[0] < box[0] || c[0] > box[2] || c[1] < box[1] || c[1] > box[3])
        return;
      try {
        if (turf.booleanPointInPolygon(centroid, G.feat(feature))) count++;
      } catch (e) {
        /* malformed territory */
      }
    });
    return count;
  }

  // ── Dwelling classification ───────────────────────────────────────────

  /** OSM building values that are unambiguously somewhere people live. */
  var DWELLING_TAGS = {
    apartments: 1,
    residential: 1,
    house: 1,
    detached: 1,
    semidetached_house: 1,
    terrace: 1,
    terraced_house: 1,
    bungalow: 1,
    dormitory: 1,
    cabin: 1,
    houseboat: 1,
    static_caravan: 1,
    farm: 1, // building=farm is the farmhouse itself
  };

  /** Values that are unambiguously not. */
  var NON_DWELLING_TAGS = {
    garage: 1,
    garages: 1,
    carport: 1,
    shed: 1,
    hut: 1,
    barn: 1,
    stable: 1,
    sty: 1,
    cowshed: 1,
    farm_auxiliary: 1,
    greenhouse: 1,
    silo: 1,
    storage_tank: 1,
    slurry_tank: 1,
    digester: 1,
    bunker: 1,
    roof: 1,
    canopy: 1,
    ruins: 1,
    construction: 1,
    transformer_tower: 1,
    water_tower: 1,
    service: 1,
    container: 1,
    tent: 1,
    allotment_house: 1,
    boathouse: 1,
    kiosk: 1,
    toilets: 1,
    shelter: 1,
  };

  /**
   * How likely a building is to hold someone's front door.
   *
   * @returns {number} 1 = dwelling, 0 = not, 0.5 = unclear
   *
   * Most OSM buildings carry nothing but building=yes, so the tag alone
   * decides only the clear cases. An address is treated as a dwelling even
   * when it is really a shop: for door-to-door work an address is a door, and
   * erring that way keeps land rather than discarding it.
   */
  function _dwellingScore(building) {
    if (building._dwelling !== undefined) return building._dwelling;

    var props = building.properties || {};
    var score;

    if (props["addr:housenumber"]) {
      score = 1;
    } else {
      var tag = String(props.building || "").toLowerCase();
      if (DWELLING_TAGS[tag]) {
        score = 1;
      } else if (NON_DWELLING_TAGS[tag]) {
        score = 0;
      } else {
        var levels = parseFloat(props["building:levels"]);
        if (!isNaN(levels) && levels >= WASTE_MIN_LEVELS) {
          score = 1;
        } else {
          // Nothing but building=yes. Footprint is the last signal left: a
          // garage is small, an apartment block is not.
          var footprint = building._footprint;
          if (footprint === undefined) {
            try {
              footprint = building._footprint = turf.area(G.feat(building.geometry));
            } catch (e) {
              footprint = building._footprint = 0;
            }
          }
          score = footprint < WASTE_SMALL_FOOTPRINT_M2 ? 0 : 0.5;
        }
      }
    }

    building._dwelling = score;
    return score;
  }

  /**
   * @returns {{dwellings: number, unsure: number, buildings: number, hectares: number}}
   */
  function _dwellingStats(feature) {
    var stats = { dwellings: 0, unsure: 0, buildings: 0, hectares: 0 };
    var poly = G.feat(feature);

    try {
      stats.hectares = turf.area(poly) / 10000;
    } catch (e) {
      return stats;
    }
    if (!s.cachedBuildings || !s.cachedBuildings.features.length) return stats;

    var box;
    try {
      box = turf.bbox(poly);
    } catch (e) {
      return stats;
    }

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
      if (c[0] < box[0] || c[0] > box[2] || c[1] < box[1] || c[1] > box[3]) return;
      try {
        if (!turf.booleanPointInPolygon(centroid, poly)) return;
      } catch (e) {
        return;
      }

      stats.buildings++;
      var score = _dwellingScore(b);
      if (score === 1) stats.dwellings++;
      else if (score === 0.5) stats.unsure++;
    });

    return stats;
  }

  /**
   * Land is disposable when it holds no confirmed dwelling, and any ambiguous
   * buildings are sparse enough to read as outbuildings rather than a hamlet.
   *
   * A confirmed dwelling always wins: no threshold can discard one.
   */
  function _isDisposable(stats) {
    if (stats.dwellings > 0) return false;
    if (stats.unsure === 0) return true;
    if (stats.hectares <= 0) return false;
    return stats.unsure / stats.hectares <= WASTE_MAX_UNSURE_PER_HA;
  }

  /**
   * Polygonize the street network plus the outer ring into blocks.
   *
   * Done once for the whole area rather than per territory: noding a town's
   * street network is the expensive part, while assigning the resulting blocks
   * to territories is a cheap point-in-polygon test.
   */
  function _streetBlocks(outerFeature) {
    if (!s.cachedStreets || !s.cachedStreets.features.length) return [];

    var lines = [];
    s.cachedStreets.features.forEach(function (f) {
      if (!f.geometry) return;
      var parts =
        f.geometry.type === "MultiLineString"
          ? f.geometry.coordinates
          : [f.geometry.coordinates];
      parts.forEach(function (coords) {
        if (coords && coords.length >= 2) lines.push(coords);
      });
    });

    // Without the ring, blocks at the edge never close and polygonize drops them.
    var ring = outerFeature.geometry.coordinates[0];
    for (var i = 0; i < ring.length - 1; i++) lines.push([ring[i], ring[i + 1]]);

    try {
      var noded = G.nodeLineSegments(lines);
      var fc = noded
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

      var polygonized = turf.polygonize(turf.featureCollection(fc));
      return polygonized && polygonized.features ? polygonized.features : [];
    } catch (e) {
      console.warn(">>> Block polygonize failed:", e.message);
      return [];
    }
  }

  /**
   * Index the blocks: who owns each, which touch the outer boundary, and which
   * are adjacent to which.
   *
   * Adjacency is exact rather than geometric. Every block came out of the same
   * noded planar graph, so two blocks share a boundary exactly when they share
   * an edge with identical endpoints — a hash lookup instead of a buffer and
   * intersect per pair. That also makes "borders another territory" free: it
   * is simply whether a neighboring block has a different owner.
   *
   * @returns {Array<{feature, owner, outer, adj: number[], disposable: boolean}>}
   */
  function _indexBlocks(blocks, outerRing, features) {
    var PRECISION = 5;

    function coordKey(c) {
      return c[0].toFixed(PRECISION) + "," + c[1].toFixed(PRECISION);
    }

    function edgeKey(a, b) {
      var ka = coordKey(a),
        kb = coordKey(b);
      return ka < kb ? ka + "|" + kb : kb + "|" + ka;
    }

    var feats = features.map(G.feat);
    var boxes = feats.map(function (f) {
      return turf.bbox(f);
    });

    var meta = [];
    var edges = Object.create(null); // edgeKey -> [block index]

    blocks.forEach(function (block, i) {
      var entry = {
        feature: block,
        owner: -1,
        outer: false,
        adj: [],
        disposable: false,
      };
      meta.push(entry);

      var ring = block.geometry.coordinates[0];
      var area = 0;
      try {
        area = turf.area(block);
      } catch (e) {
        return;
      }
      if (!ring || ring.length < 3 || area < WASTE_MIN_BLOCK_M2) return;

      for (var e = 0; e < ring.length - 1; e++) {
        var key = edgeKey(ring[e], ring[e + 1]);
        (edges[key] || (edges[key] = [])).push(i);

        if (!entry.outer) {
          var mid = [
            (ring[e][0] + ring[e + 1][0]) / 2,
            (ring[e][1] + ring[e + 1][1]) / 2,
          ];
          if (G.isOnOuterBoundary(mid, outerRing)) entry.outer = true;
        }
      }

      var pt = _repPoint(block);
      if (!pt) return;
      var c = pt.geometry.coordinates;
      for (var t = 0; t < feats.length; t++) {
        if (c[0] < boxes[t][0] || c[0] > boxes[t][2]) continue;
        if (c[1] < boxes[t][1] || c[1] > boxes[t][3]) continue;
        try {
          if (turf.booleanPointInPolygon(pt, feats[t])) {
            entry.owner = t;
            break;
          }
        } catch (e2) {
          /* try the next territory */
        }
      }

      if (entry.owner >= 0) {
        entry.disposable = _isDisposable(_dwellingStats(block));
      }
    });

    Object.keys(edges).forEach(function (key) {
      var shared = edges[key];
      if (shared.length !== 2) return; // outer edge, or a degenerate overlap
      meta[shared[0]].adj.push(shared[1]);
      meta[shared[1]].adj.push(shared[0]);
    });

    return meta;
  }

  /**
   * Carve building-free land out of its parent territory and emit it as
   * separate features tagged properties.waste.
   *
   * The carve is a flood fill running inward from the outer boundary through
   * disposable blocks of the same territory. Testing each block against the
   * outer ring on its own only ever shaved one block deep, which left most of
   * a wide empty margin behind.
   *
   * Two invariants keep it safe:
   *   • the fill starts at the outer boundary and grows only through
   *     neighbors, so the removed region stays connected to the outside — a
   *     notch, never an interior hole;
   *   • a block bordering another territory is never entered, so no seam
   *     between two territories can be cut. That is self-enforcing: if block X
   *     of territory A borders block Y of territory B, X sees a different
   *     owner and the fill stops.
   *
   * @returns {{features: Array, carved: number, area: number}}
   */
  function _segmentWaste(features, outerFeature, edgeBand) {
    var unchanged = { features: features, carved: 0, area: 0 };

    var blocks = _streetBlocks(outerFeature);
    if (blocks.length < 2) return unchanged;

    var outerRing = outerFeature.geometry.coordinates[0];
    var meta = _indexBlocks(blocks, outerRing, features);

    function bordersAnotherTerritory(i) {
      var owner = meta[i].owner;
      for (var n = 0; n < meta[i].adj.length; n++) {
        var other = meta[meta[i].adj[n]].owner;
        if (other >= 0 && other !== owner) return true;
      }
      return false;
    }

    function fillable(i) {
      return (
        meta[i].disposable && meta[i].owner >= 0 && !bordersAnotherTerritory(i)
      );
    }

    var carvedFlags = [];
    var queue = [];
    meta.forEach(function (entry, i) {
      if (entry.outer && fillable(i)) {
        carvedFlags[i] = true;
        queue.push(i);
      }
    });

    while (queue.length) {
      var cur = queue.pop();
      meta[cur].adj.forEach(function (nb) {
        if (carvedFlags[nb]) return;
        if (meta[nb].owner !== meta[cur].owner) return;
        if (!fillable(nb)) return;
        carvedFlags[nb] = true;
        queue.push(nb);
      });
    }

    var claims = Object.create(null);
    carvedFlags.forEach(function (flag, i) {
      if (!flag) return;
      var owner = meta[i].owner;
      (claims[owner] || (claims[owner] = [])).push(meta[i].feature);
    });

    var out = features.slice();
    var carved = 0;
    var carvedArea = 0;
    var waste = [];

    Object.keys(claims).forEach(function (key) {
      var idx = parseInt(key, 10);
      var parent = G.feat(out[idx]);
      var baseParts = G.polygonParts(parent).length;
      var baseRings = _ringCount(parent);
      var kept = parent;
      var taken = [];

      claims[key].forEach(function (block) {
        var candidate;
        try {
          candidate = G.difference(kept, block);
        } catch (e) {
          return;
        }
        if (!candidate || !candidate.geometry) return;

        // Never split the parent and never punch a hole in it. Both are
        // possible when a block reaches into a concave shape, and both are
        // silent corruptions if left unchecked.
        if (G.polygonParts(candidate).length !== baseParts) return;
        if (_ringCount(candidate) > baseRings) return;
        if (turf.area(candidate) <= 0) return;

        kept = candidate;
        taken.push(block);
      });

      if (taken.length === 0) return;

      var lump = G.unionAll(taken);
      if (!lump) return;
      var lumpArea = 0;
      try {
        lumpArea = turf.area(lump);
      } catch (e) {
        return;
      }
      if (lumpArea < WASTE_MIN_AREA_M2) return;

      out[idx] = {
        type: "Feature",
        geometry: kept.geometry,
        properties: out[idx].properties || {},
      };
      carved++;
      carvedArea += lumpArea;

      // Each disconnected lump becomes its own territory, so the user can see
      // exactly what is about to be discarded and keep any of it by hand.
      G.polygonParts(lump).forEach(function (part) {
        waste.push({
          type: "Feature",
          geometry: part.geometry,
          properties: { waste: true },
        });
      });
    });

    console.log(
      ">>> Waste fill:",
      carvedFlags.filter(Boolean).length,
      "of",
      blocks.length,
      "blocks across",
      carved,
      "territories",
    );

    return { features: out.concat(waste), carved: carved, area: carvedArea };
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
    setTimeout(function () {
      // Without this the overlay spins forever on any geometry error and the
      // app looks hung, with the real cause only in the console.
      try {
        _runCleanup();
      } catch (e) {
        console.error(">>> Cleanup failed:", e);
        App.ui.hideOverlay();
        alert(T("alert.cleanupFailed", { message: e.message }));
      }
    }, 30);
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
    var edgeBand = outerFeature ? _outerEdgeBand(outerFeature) : null;

    // ── Stage 1: cut empty land at the outer edge into its own territories ──
    var carved = 0;
    var carvedArea = 0;
    if (outerFeature && edgeBand) {
      App.ui.setOverlayStatus(T("loading.segmenting"));
      var segmented = _segmentWaste(features, outerFeature, edgeBand);
      features = segmented.features;
      carved = segmented.carved;
      carvedArea = segmented.area;
    }

    // ── Stage 2: dispose of the empties ────────────────────────────────────
    // An empty territory touching the outer boundary is discarded outright:
    // removing it leaves a notch in the outside edge, which is the point.
    // An empty territory in the interior is absorbed by a neighbor instead,
    // because deleting that would leave a hole between territories.
    var discarded = 0;
    var absorbed = 0;
    var droppedBuildings = 0;

    App.ui.setOverlayStatus(T("loading.cleanupStatus"));

    // Edge removals are independent of each other, so one sweep is enough.
    var stats = _territoryStats(features);
    for (var i = features.length - 1; i >= 0; i--) {
      if (!_isDisposable(stats[i])) continue;
      if (features.length <= 1) break;
      if (!_touchesEdge(features[i], edgeBand)) continue;
      droppedBuildings += stats[i].buildings;
      features.splice(i, 1);
      discarded++;
    }

    // Absorption changes geometry, so this part has to re-measure each pass.
    var pass = 0;
    var MAX_PASSES = 40;

    while (pass < MAX_PASSES && features.length > 1) {
      pass++;
      App.ui.setOverlayStatus(T("loading.pass", { n: pass }));

      stats = _territoryStats(features);
      var emptyIdx = -1;
      for (var q = 0; q < stats.length; q++) {
        if (_isDisposable(stats[q])) {
          emptyIdx = q;
          break;
        }
      }
      if (emptyIdx < 0) break;

      var empty = G.feat(features[emptyIdx]);
      var emptyCentroid = _repPoint(empty);
      if (!emptyCentroid) {
        features.splice(emptyIdx, 1);
        discarded++;
        continue;
      }
      var emptyCoords = emptyCentroid.geometry.coordinates;

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
        var seed = _repPoint(neighbor);
        if (!seed) continue;
        var d2 = SP.distSq(emptyCoords, seed.geometry.coordinates);
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
            absorbed++;
          }
        } catch (e) {
          console.warn(">>> Absorb failed:", e.message);
        }
      } else {
        discarded++;
      }

      features.splice(emptyIdx, 1);
    }

    if (App.history) App.history.push();
    App.polygons.setClusters(features);
    App.ui.hideOverlay();

    console.log(
      ">>> Cleanup: carved",
      carved,
      "| discarded",
      discarded,
      "(" + droppedBuildings + " non-dwelling buildings)",
      "| absorbed",
      absorbed,
      "->",
      features.length,
      "territories",
    );

    alert(
      T("alert.cleanupDone", {
        carved: carved,
        discarded: discarded,
        absorbed: absorbed,
        saved: Math.round(carvedArea),
        dropped: droppedBuildings,
        remaining: features.length,
      }),
    );
  }

  /**
   * Dwelling stats for every territory in one pass over the buildings, with a
   * bbox reject first. Replaces the old plain building count: a territory of
   * barns has buildings but nobody to visit.
   */
  function _territoryStats(features) {
    var feats = features.map(G.feat);
    var boxes = feats.map(function (f) {
      return turf.bbox(f);
    });
    var out = feats.map(function (f) {
      var hectares = 0;
      try {
        hectares = turf.area(f) / 10000;
      } catch (e) {
        hectares = 0;
      }
      return { dwellings: 0, unsure: 0, buildings: 0, hectares: hectares };
    });

    if (!s.cachedBuildings || !s.cachedBuildings.features.length) return out;

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
        if (c[0] < boxes[i][0] || c[0] > boxes[i][2]) continue;
        if (c[1] < boxes[i][1] || c[1] > boxes[i][3]) continue;
        try {
          if (!turf.booleanPointInPolygon(centroid, feats[i])) continue;
        } catch (e) {
          continue;
        }

        out[i].buildings++;
        var score = _dwellingScore(b);
        if (score === 1) out[i].dwellings++;
        else if (score === 0.5) out[i].unsure++;
        return;
      }
    });

    return out;
  }

  return {
    // Pure decision logic, exposed for tests. Nothing else should call these;
    // they are private to the cleanup pipeline.
    _test: {
      dwellingScore: _dwellingScore,
      isDisposable: _isDisposable,
      indexBlocks: _indexBlocks,
      ringCount: _ringCount,
    },

    init: init,
    toggleEditMode: toggleEditMode,
    toggleMergeMode: toggleMergeMode,
    undoPoint: undoPoint,
    handleClusterSelectClick: handleClusterSelectClick,
    mergeSelectedClusters: mergeSelectedClusters,
    cleanupClusters: cleanupClusters,
    rebuildSnapIndex: rebuildSnapIndex,
  };
})();

window.App = App;
