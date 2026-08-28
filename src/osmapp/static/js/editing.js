/**
 * editing.js - the cut tool (street-snapped split lines) and merge mode.
 *
 * Cut tool design notes
 *
 * What gets cut has to be what was drawn: a tool that snaps generously and
 * only reveals the routed, extended line after the cut is committed leaves
 * the two routinely different. Three rules keep them the same:
 *
 *   1. Snapping reaches CUT_SNAP_PX pixels, not a fixed number of meters, so
 *      it grabs what is under the cursor and nothing else. Holding Alt turns
 *      it off for a single vertex; the toolbar turns it off for good.
 *   2. Street routing only replaces a segment when both of its vertices
 *      actually landed on the street network, and only when the detour is
 *      small. A hand-placed vertex is always joined by a straight line.
 *   3. Everything that will happen to the line - routing, extension to the
 *      surrounding boundaries - is drawn live, in green, while you draw. The
 *      toolbar counts how many territories the line currently separates, so a
 *      cut that cannot work is visible before it is committed rather than
 *      after it fails.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.editing = (function () {
  "use strict";

  var s = null;
  var G = null;
  var SP = null;
  var N = null;
  var D = null;
  var T = null;

  // Draw state
  var _points = []; // [{ latlng, t, snapped: boolean }]
  var _previewLine = null; // red dashes: the vertices as clicked
  var _ghostLine = null; // green: what will actually be cut
  var _snapDot = null;
  var _vertexLayer = null;
  var _hintBanner = null;
  var _cutToolbar = null;
  var _mergeToolbar = null;
  var _mergeHint = null;
  var _deselected = []; // territories dropped from the selection - the redo stack

  var _pendingMove = null;
  var _moveQueued = false;
  var _altHeld = false;
  var _rightPan = null; // { x, y, moved } while the right button drags the map
  var _routedPrefix = []; // routed geometry through the committed vertices
  var _undonePoints = []; // vertices taken back, newest last - the redo stack

  // Snap index
  //
  // Streets live in App.network now - the trim tool needs the same graph, and
  // the routing heuristics have to be one implementation or they are two.
  // What is still local is the boundary grid: a cut is allowed to snap onto
  // the outlines it is cutting, which is a cut-tool rule and nobody else's.
  var _edgeGrid = null; // territory and outer boundary edges, payload { ci }

  var DBLCLICK_MS = 300;

  function init() {
    s = App.state;
    G = App.geometry;
    SP = App.spatial;
    N = App.network;
    D = App.dom;
    T = App.i18n.t;
    // Alt is a live modifier rather than a shortcut - it suspends snapping for
    // as long as it is down - so it stays here, next to the pointer state it
    // changes. Everything discrete is registered with App.shortcuts.
    document.addEventListener("keydown", _onModifierDown);
    document.addEventListener("keyup", _onModifierUp);
    App._loaded.push("editing");
  }

  // SNAP INDEX

  /**
   * Streets and boundaries go into separate grids rather than one, so that a
   * territory outline 150 m away cannot outrank the street under the cursor. A
   * cut line snapped onto the outline of the territory being cut runs along it
   * instead of across it, which presents as "this cluster will not split".
   */
  function rebuildSnapIndex() {
    N.build();

    _edgeGrid = new SP.Grid(120);
    App.polygons.clusterLayers().forEach(function (layer, index) {
      _addLayerEdges(layer, index);
    });
    if (s.outerPolygonLayer) _addLayerEdges(s.outerPolygonLayer, -1);

    console.log(">>> Snap index:", _edgeGrid.items.length, "boundary edges");
  }

  /** @param {number} clusterIndex index into s.clusters, or -1 for the outer ring */
  function _addLayerEdges(layer, clusterIndex) {
    if (!layer || !layer.getLatLngs) return;
    (function walk(arr) {
      if (!Array.isArray(arr) || arr.length === 0) return;
      if (arr[0] instanceof L.LatLng) {
        for (var i = 0; i < arr.length; i++) {
          var a = arr[i];
          var b = arr[(i + 1) % arr.length];
          _edgeGrid.addSegment([a.lng, a.lat], [b.lng, b.lat], {
            ci: clusterIndex,
          });
        }
      } else {
        arr.forEach(walk);
      }
    })(layer.getLatLngs());
  }

  // Snapping

  /**
   * The cut tool's magnet, in meters at the current zoom.
   *
   * The conversion itself belongs to App.network, which every snapping tool
   * asks the same question; what is the cut tool's own is which two constants
   * go into it.
   */
  function _snapRadiusM() {
    return N.pixelRadiusM(s.CUT_SNAP_PX, s.CUT_SNAP_MAX_M);
  }

  /** Alt inverts the toolbar setting for as long as it is held. */
  function _snapActive() {
    return _altHeld ? !s.cutSnap : s.cutSnap;
  }

  /**
   * @returns {{point: L.LatLng, kind: "node"|"street"|"edge"|"free"}}
   *   "free" means the point is taken exactly as clicked, which is what makes
   *   a territory with no usable streets nearby still cuttable.
   */
  function _snap(latlng) {
    if (!_snapActive()) return { point: latlng, kind: "free" };

    var radius = _snapRadiusM();
    var coord = [latlng.lng, latlng.lat];
    var best = null;

    function offer(coordinate, kind, distance, weight) {
      var score = distance * weight;
      if (best && score >= best.score) return;
      best = {
        point: L.latLng(coordinate[1], coordinate[0]),
        kind: kind,
        score: score,
      };
    }

    // Intersections carry a bonus: landing exactly on a junction is almost
    // always what was meant, and it gives routing a clean node to start from.
    var node = N.nearestNode(coord, radius);
    if (node) offer(node.coord, "node", node.dist, s.CUT_NODE_BONUS);

    var seg = N.nearestSegmentPoint(coord, radius);
    if (seg) offer(seg.coord, "street", seg.dist, 1);

    if (s.cutSnapEdges) {
      var edge = _edgeGrid && _edgeGrid.nearestSegment(coord, radius);
      if (edge) offer(edge.coord, "edge", edge.dist, s.CUT_EDGE_PENALTY);
    }

    return best
      ? { point: best.point, kind: best.kind }
      : { point: latlng, kind: "free" };
  }

  function _nearestStreetNode(latlng, maxMeters) {
    return N.nearestNodeAt(latlng, maxMeters);
  }

  // ROUTING

  /**
   * Replace the straight hop a->b with a street path, but only when doing so
   * cannot surprise anyone: both ends must have been snapped onto the street
   * network, both must sit on a graph node within the snap radius, and the
   * detour must be small. Anything else stays a straight line, because a
   * vertex placed by hand is a statement about where the cut should go.
   *
   * @param {{latlng: L.LatLng, snapped: boolean}} a
   * @param {{latlng: L.LatLng, snapped: boolean}} b
   * @returns {L.LatLng[]|null} the intermediate path, or null to go straight
   */
  function _routeSegment(a, b) {
    if (!s.cutFollow) return null;
    if (!a.snapped || !b.snapped) return null;

    var radius = _snapRadiusM();
    var nodeA = _nearestStreetNode(a.latlng, radius);
    var nodeB = _nearestStreetNode(b.latlng, radius);
    if (!nodeA || !nodeB) return null;

    var path = N.route(nodeA.key, nodeB.key);
    if (!path || path.length < 2) return null;

    var routed = N.pathLength(path);
    var straight = a.latlng.distanceTo(b.latlng);

    // Both a ratio and an absolute cap: the ratio alone lets a 10 m hop turn
    // into a 17 m loop around a corner, and the cap alone lets a long
    // cross-town segment wander.
    if (routed > straight * s.CUT_ROUTE_MAX_DETOUR) return null;
    if (routed - straight > s.CUT_ROUTE_MAX_EXTRA_M) return null;

    return path;
  }

  /** Full geometry for a vertex list: routed where allowed, straight otherwise. */
  function _routeAll(points) {
    if (points.length < 2)
      return points.map(function (p) {
        return p.latlng;
      });

    var out = [points[0].latlng];
    for (var i = 0; i < points.length - 1; i++)
      _appendSegment(out, points[i], points[i + 1]);
    return out;
  }

  /** Append the geometry for one hop onto `out`, which already ends at a. */
  function _appendSegment(out, a, b) {
    var path = _routeSegment(a, b);
    if (path) {
      // The graph path starts and ends on nodes, which may sit a few meters
      // from the clicked points; keeping the clicked ends avoids a visible
      // kink at every vertex.
      for (var j = 1; j < path.length - 1; j++) out.push(path[j]);
    }
    out.push(b.latlng);
    return out;
  }

  // Extend the split line out to the nearest boundaries

  /**
   * A cut only separates a territory if the line crosses right out of it.
   * Each end is pushed along its own direction until it meets a boundary, and
   * then a little past it.
   *
   * The overshoot is the important part. The ray starts a fraction of a meter
   * beyond the endpoint, so a boundary the endpoint has already snapped onto
   * is not reported as a zero-distance hit and taken as the stopping place;
   * the result is then pushed CUT_EXTEND_OVERSHOOT_M further still. A line
   * terminating exactly on the outline makes a hairline knife a coin flip.
   */
  function _extendToBoundaries(latlngs) {
    if (latlngs.length < 2 || !_edgeGrid) return latlngs;

    var reach = 1.0; // degrees; replaced below by the boundary's own extent
    if (s.outerPolygonLayer) {
      try {
        var b = s.outerPolygonLayer.getBounds();
        var dLat = b.getNorth() - b.getSouth();
        var dLng = b.getEast() - b.getWest();
        reach = Math.sqrt(dLat * dLat + dLng * dLng) * 1.2;
      } catch (e) {
        /* keep the default */
      }
    }

    var out = latlngs.slice();
    out[0] = _pushOut(out[1], out[0], reach);
    out[out.length - 1] = _pushOut(
      out[out.length - 2],
      out[out.length - 1],
      reach,
    );
    return out;
  }

  function _pushOut(from, to, reach) {
    var dLat = to.lat - from.lat;
    var dLng = to.lng - from.lng;
    var len = Math.sqrt(dLat * dLat + dLng * dLng);
    if (len === 0) return to;
    var uLat = dLat / len;
    var uLng = dLng / len;

    // A degree of longitude is shorter than a degree of latitude, so one unit
    // of this direction is less than M_PER_DEG_LAT meters on the ground
    // wherever the line runs east or west - two thirds of it at 52 degrees.
    // Dividing by the ground length is what makes the two offsets below the
    // number of meters they are named for.
    var kx = SP.lngScale(to.lat);
    var perUnit = Math.sqrt(
      uLat * uLat * SP.M_PER_DEG_LAT * SP.M_PER_DEG_LAT + uLng * uLng * kx * kx,
    );

    // Start the ray just past the endpoint so a boundary the endpoint is
    // already sitting on is not reported as a zero-distance hit.
    var epsDeg = 0.2 / perUnit;
    var start = L.latLng(to.lat + uLat * epsDeg, to.lng + uLng * epsDeg);
    var far = L.latLng(to.lat + uLat * reach, to.lng + uLng * reach);

    var best = null;
    var bestDist = Infinity;
    var candidates = _edgeGrid.segmentCandidates(
      [start.lng, start.lat],
      [far.lng, far.lat],
    );
    for (var i = 0; i < candidates.length; i++) {
      var item = _edgeGrid.items[candidates[i]];
      if (!item.a) continue;
      var hit = _segmentIntersection(
        start,
        far,
        L.latLng(item.a[1], item.a[0]),
        L.latLng(item.b[1], item.b[0]),
      );
      if (!hit) continue;
      var d = to.distanceTo(hit);
      if (d < bestDist) {
        bestDist = d;
        best = hit;
      }
    }

    // Overshoot unconditionally: past the boundary it met, or past the
    // endpoint itself when there was nothing to meet.
    var anchor = best || to;
    var overDeg = s.CUT_EXTEND_OVERSHOOT_M / perUnit;
    return L.latLng(anchor.lat + uLat * overDeg, anchor.lng + uLng * overDeg);
  }

  function _segmentIntersection(a, b, c, d) {
    var r = { lat: b.lat - a.lat, lng: b.lng - a.lng };
    var t2 = { lat: d.lat - c.lat, lng: d.lng - c.lng };
    var denom = r.lat * t2.lng - r.lng * t2.lat;
    if (Math.abs(denom) < 1e-14) return null;
    var diff = { lat: c.lat - a.lat, lng: c.lng - a.lng };
    var t = (diff.lat * t2.lng - diff.lng * t2.lat) / denom;
    var u = (diff.lat * r.lng - diff.lng * r.lat) / denom;
    if (t >= 0 && t <= 1 && u >= 0 && u <= 1)
      return L.latLng(a.lat + t * r.lat, a.lng + t * r.lng);
    return null;
  }

  // Live "will this actually cut anything" check

  /**
   * Count boundary crossings per territory. Two or more crossings means the
   * line goes in one side and out another, which is the necessary condition
   * for a separation; one crossing means it stops inside.
   *
   * This is a cheap approximation - a line that leaves and re-enters through
   * the same edge also scores two - but it is right often enough to warn
   * before committing, which is the whole point.
   *
   * @returns {{separates: number, touches: number}}
   */
  function _crossingReport(latlngs) {
    if (!_edgeGrid || latlngs.length < 2) return { separates: 0, touches: 0 };

    var counts = Object.create(null);
    for (var i = 0; i < latlngs.length - 1; i++) {
      var a = latlngs[i];
      var b = latlngs[i + 1];
      var candidates = _edgeGrid.segmentCandidates(
        [a.lng, a.lat],
        [b.lng, b.lat],
      );
      for (var j = 0; j < candidates.length; j++) {
        var item = _edgeGrid.items[candidates[j]];
        if (!item.a) continue;
        if (item.payload.ci < 0) continue; // the outer ring is not a territory
        if (
          !_segmentIntersection(
            a,
            b,
            L.latLng(item.a[1], item.a[0]),
            L.latLng(item.b[1], item.b[0]),
          )
        )
          continue;
        counts[item.payload.ci] = (counts[item.payload.ci] || 0) + 1;
      }
    }

    var separates = 0;
    var touches = 0;
    Object.keys(counts).forEach(function (key) {
      touches++;
      if (counts[key] >= 2) separates++;
    });
    return { separates: separates, touches: touches };
  }

  // DRAW MODE

  function toggleEditMode() {
    var next = !s.editMode;

    if (next) {
      if (!s.outerPolygonDrawn) {
        alert(T("alert.drawAndLoadFirst"));
        return;
      }
      if (s.mergeMode) toggleMergeMode();
      if (s.trimMode) App.trim.toggle();
      if (s.outlineMode) App.outline.toggle();
      if (s.noteMode) App.notes.toggle();
    }

    s.editMode = next;
    App.controls.setActive("cut", next);

    if (next) _startDraw();
    else _stopDraw();
  }

  function _startDraw() {
    _points = [];
    _routedPrefix = [];
    _undonePoints = [];
    _altHeld = false;
    App.history.pushScope(CUT_SCOPE);
    App.shortcuts.push(CUT_KEYS);
    rebuildSnapIndex();

    // The cursor belongs to the split line from here on: no tooltip trailing
    // it, no hover highlight lifting a cluster over the preview.
    App.polygons.setTooltipMode("off");
    App.polygons.clearHover();
    App.gaps.schedule(0);

    // Drawn first so it sits under the red vertices.
    _ghostLine = L.polyline([], {
      color: "#27ae60",
      weight: 6,
      opacity: 0.45,
      interactive: false,
    }).addTo(s.leafletMap);

    _previewLine = L.polyline([], {
      color: "#e74c3c",
      weight: 2,
      dashArray: "6 4",
      opacity: 0.95,
      interactive: false,
    }).addTo(s.leafletMap);

    _snapDot = L.circleMarker([0, 0], {
      radius: 6,
      color: "#e74c3c",
      fillColor: "#fff",
      fillOpacity: 1,
      weight: 2,
      interactive: false,
    }).addTo(s.leafletMap);

    _vertexLayer = L.layerGroup().addTo(s.leafletMap);

    _hintBanner = D.mountOnMap("tpl-draw-hint", s.leafletMap);
    _showCutToolbar();

    // Dragging stays enabled: Leaflet suppresses the click that follows a drag
    // (_draggableMoved), so panning cannot place a stray vertex, and a split
    // line often runs past the edge of the screen.
    s.leafletMap.doubleClickZoom.disable();
    _bindRightPan();
    s.leafletMap.on("mousemove", _onDrawMouseMove);
    s.leafletMap.on("click", _onDrawClick);
    s.leafletMap.on("dblclick", _onDrawDblClick);
    s.leafletMap.on("zoomend", _refreshPreview);
  }

  function _stopDraw() {
    App.polygons.setTooltipMode(s.mergeMode ? "anchored" : "full");
    App.gaps.schedule(0);

    _unbindRightPan();
    s.leafletMap.off("mousemove", _onDrawMouseMove);
    s.leafletMap.off("click", _onDrawClick);
    s.leafletMap.off("dblclick", _onDrawDblClick);
    s.leafletMap.off("zoomend", _refreshPreview);

    try {
      s.leafletMap.doubleClickZoom.enable();
    } catch (e) {
      /* map may already be gone */
    }

    [_previewLine, _ghostLine, _snapDot, _vertexLayer].forEach(function (
      layer,
    ) {
      if (layer) s.leafletMap.removeLayer(layer);
    });
    _previewLine = _ghostLine = _snapDot = _vertexLayer = null;
    _hintBanner = D.remove(_hintBanner);
    _hideCutToolbar();
    _points = [];
    _routedPrefix = [];
    _undonePoints = [];
    App.history.popScope("cut");
    App.shortcuts.pop("cut");
    App.ui.closeContextMenu();
    _pendingMove = null;
    _moveQueued = false;
    _altHeld = false;
  }

  // Right-button panning

  /**
   * Left-drag panning already works while drawing, but it costs the click
   * that would have placed a vertex: Leaflet suppresses the click that ends a
   * drag, so a long line has to be drawn in alternating bursts of panning and
   * clicking, and a pan that only moves a pixel or two silently eats a
   * vertex. The right button pans without ever touching the line.
   *
   * Leaflet's own drag handler ignores every button but the primary one, so the
   * panning is done from a handler here rather than through map.dragging. Right
   * click has no other job in this mode - the territory context menu already
   * bows out while s.editMode is set.
   */
  function _bindRightPan() {
    var container = s.leafletMap.getContainer();
    L.DomEvent.on(container, "mousedown", _onRightPanDown);
    L.DomEvent.on(container, "contextmenu", _swallowContextMenu);
  }

  function _unbindRightPan() {
    _endRightPan();
    if (!s.leafletMap) return;
    var container = s.leafletMap.getContainer();
    L.DomEvent.off(container, "mousedown", _onRightPanDown);
    L.DomEvent.off(container, "contextmenu", _swallowContextMenu);
  }

  function _swallowContextMenu(e) {
    L.DomEvent.preventDefault(e);
  }

  function _onRightPanDown(e) {
    if (e.button !== 2) return;
    // Without this the browser starts a selection drag, and on the platforms
    // that raise the context menu on mousedown, raises it mid-pan.
    L.DomEvent.preventDefault(e);
    _rightPan = { x: e.clientX, y: e.clientY, moved: false };
    L.DomUtil.addClass(s.leafletMap.getContainer(), "is-right-panning");
    // The button may well be released outside the map, so the rest of the
    // gesture is followed on the document.
    L.DomEvent.on(document, "mousemove", _onRightPanMove);
    L.DomEvent.on(document, "mouseup", _onRightPanUp);
  }

  function _onRightPanMove(e) {
    if (!_rightPan) return;
    // The ground follows the pointer, so the view moves the opposite way.
    var dx = _rightPan.x - e.clientX;
    var dy = _rightPan.y - e.clientY;
    if (!dx && !dy) return;
    _rightPan.x = e.clientX;
    _rightPan.y = e.clientY;
    _rightPan.moved = true;
    s.leafletMap.panBy([dx, dy], { animate: false });
  }

  function _onRightPanUp(e) {
    if (!_rightPan) return;
    if (e.button !== 2) return;
    var moved = _rightPan.moved;
    _endRightPan();
    if (!s.editMode) return;

    // The cursor has not moved but the ground under it has, so what it is
    // pointing at - and therefore the snap dot and the green preview - has to
    // be worked out again.
    if (moved) {
      _pendingMove = s.leafletMap.mouseEventToLatLng(e);
      _refreshPreview();
      return;
    }

    // A right button pressed and released without travelling is a click, and
    // a click on the right button asks for a menu everywhere else in the app.
    // Panning does not lose anything by ceding the stationary case.
    _showCutMenu(s.leafletMap.mouseEventToContainerPoint(e));
  }

  function _endRightPan() {
    if (!_rightPan) return;
    _rightPan = null;
    L.DomEvent.off(document, "mousemove", _onRightPanMove);
    L.DomEvent.off(document, "mouseup", _onRightPanUp);
    if (s.leafletMap)
      L.DomUtil.removeClass(s.leafletMap.getContainer(), "is-right-panning");
  }

  function _onDrawMouseMove(e) {
    // While the map is being dragged the pointer is a hand, not a pen: the
    // snap dot would otherwise chase the streets sliding underneath it.
    if (_rightPan) return;
    _pendingMove = e.latlng;
    var alt = !!(e.originalEvent && e.originalEvent.altKey);
    if (alt !== _altHeld) _altHeld = alt;
    if (_moveQueued) return;
    _moveQueued = true;
    requestAnimationFrame(function () {
      _moveQueued = false;
      if (!s.editMode || !_pendingMove) return;
      _refreshPreview();
    });
  }

  /**
   * Redraw the snap dot, the committed line and the green preview of the
   * finished cut. Only the tail segment is routed here; everything up to the
   * last committed vertex is cached in _routedPrefix, so the cost per frame
   * is one A* over a short hop rather than one over the whole line.
   */
  function _refreshPreview() {
    if (!s.editMode) return;

    var hit = _pendingMove ? _snap(_pendingMove) : null;
    if (_snapDot && hit) {
      _snapDot.setLatLng(hit.point);
      _snapDot.setStyle(_snapDotStyle(hit.kind));
    }

    var full = _routedPrefix.slice();
    if (hit) {
      if (_points.length === 0) {
        full = [];
      } else {
        _appendSegment(full, _points[_points.length - 1], {
          latlng: hit.point,
          snapped: hit.kind !== "free",
        });
      }
    }

    if (_previewLine) {
      var raw = _latlngs();
      if (hit && raw.length) raw = raw.concat([hit.point]);
      _previewLine.setLatLngs(raw);
    }

    var finished = full.length >= 2 ? _extendToBoundaries(full) : [];
    if (_ghostLine) _ghostLine.setLatLngs(finished);
    _updateCutStatus(finished);
  }

  function _snapDotStyle(kind) {
    if (kind === "node")
      return {
        color: "#e67e22",
        fillColor: "#fff",
        fillOpacity: 1,
        dashArray: null,
        radius: 7,
      };
    if (kind === "edge")
      return {
        color: "#2980b9",
        fillColor: "#fff",
        fillOpacity: 1,
        dashArray: null,
        radius: 6,
      };
    if (kind === "free")
      return {
        color: "#7f8c8d",
        fillColor: "#fff",
        fillOpacity: 0,
        dashArray: "2 2",
        radius: 5,
      };
    return {
      color: "#e74c3c",
      fillColor: "#fff",
      fillOpacity: 1,
      dashArray: null,
      radius: 6,
    };
  }

  function _onDrawClick(e) {
    L.DomEvent.stopPropagation(e);
    L.DomEvent.preventDefault(e);
    _altHeld = !!(e.originalEvent && e.originalEvent.altKey);

    var hit = _snap(e.latlng);
    _addPoint(hit.point, hit.kind !== "free");
    if (!_pendingMove) _pendingMove = e.latlng;
    _refreshPreview();
  }

  function _addPoint(latlng, snapped) {
    var point = { latlng: latlng, t: Date.now(), snapped: !!snapped };
    if (_points.length === 0) _routedPrefix = [latlng];
    else _appendSegment(_routedPrefix, _points[_points.length - 1], point);
    _points.push(point);
    // A new vertex branches off the timeline, exactly as a new edit does for
    // cluster geometry.
    _undonePoints = [];
    _renderVertices();
    App.history.sync();
  }

  /** Recompute the cached routed prefix from scratch, after an undo. */
  function _rebuildPrefix() {
    _routedPrefix = _points.length ? _routeAll(_points) : [];
  }

  function _renderVertices() {
    if (!_vertexLayer) return;
    _vertexLayer.clearLayers();
    _points.forEach(function (point, i) {
      L.circleMarker(point.latlng, {
        radius: 4,
        // Hollow means hand-placed: that vertex is joined by straight lines
        // and will not be re-routed, which is worth being able to see.
        color: point.snapped ? "#e74c3c" : "#7f8c8d",
        fillColor: i === _points.length - 1 ? "#e74c3c" : "#fff",
        fillOpacity: point.snapped ? 1 : 0.35,
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
    _undonePoints.push(_points.pop());
    _rebuildPrefix();
    _renderVertices();
    _refreshPreview();
    App.history.sync();
    return true;
  }

  /**
   * Put back a vertex undoPoint() removed.
   *
   * The point is restored verbatim rather than re-snapped: `snapped` decides
   * whether the segment is routed along streets or drawn straight, so
   * re-deriving it from the latlng would silently change the line's shape
   * when the redone vertex happened to be an Alt-placed free one.
   *
   * @returns {boolean} whether anything was restored
   */
  function redoPoint() {
    if (!s.editMode || _undonePoints.length === 0) return false;
    var point = _undonePoints.pop();
    if (_points.length === 0) _routedPrefix = [point.latlng];
    else _appendSegment(_routedPrefix, _points[_points.length - 1], point);
    _points.push(point);
    _renderVertices();
    _refreshPreview();
    App.history.sync();
    return true;
  }

  /** Undo/redo belong to the split line while one is being drawn. */
  var CUT_SCOPE = {
    id: "cut",
    undo: undoPoint,
    redo: redoPoint,
    canUndo: function () {
      return _points.length > 0;
    },
    canRedo: function () {
      return _undonePoints.length > 0;
    },
    undoDepth: function () {
      return _points.length;
    },
    redoDepth: function () {
      return _undonePoints.length;
    },
    undoKey: "toolbar.undoVertex",
    redoKey: "toolbar.redoVertex",
  };

  function _latlngs() {
    return _points.map(function (p) {
      return p.latlng;
    });
  }

  /**
   * Leaflet fires click, click, dblclick. Both trailing clicks belong to the
   * double-click, so everything placed inside the threshold is dropped and a
   * single vertex goes at the double-click position instead. Popping exactly
   * one point leaves the vertex count off by one.
   */
  function _onDrawDblClick(e) {
    L.DomEvent.stopPropagation(e);
    L.DomEvent.preventDefault(e);

    var now = Date.now();
    // At most the two trailing clicks belong to this gesture. Popping
    // everything inside the window would eat real vertices from anyone
    // placing points quickly along a street.
    var popped = 0;
    while (
      popped < 2 &&
      _points.length &&
      now - _points[_points.length - 1].t < DBLCLICK_MS
    ) {
      _points.pop();
      _undonePoints = [];
      popped++;
    }
    if (popped) _rebuildPrefix();

    _altHeld = !!(e.originalEvent && e.originalEvent.altKey);
    var hit = _snap(e.latlng);
    _addPoint(hit.point, hit.kind !== "free");
    _finishLine();
  }

  /** Close the line and hand it to the splitter. */
  function _finishLine() {
    if (_points.length < 2) {
      console.warn(">>> Need at least two vertices to split");
      return;
    }

    var cut = _extendToBoundaries(_routeAll(_points));

    s.editMode = false;
    _stopDraw();
    App.controls.setActive("cut", false);

    App.ui.showBusy(T("loading.cutting"));
    setTimeout(function () {
      _splitWithLine(cut);
    }, 30);
  }

  /**
   * Leave the line on the map so a failed cut can be seen rather than
   * guessed at. Green when it worked, red when it did not, and the failed one
   * lingers because that is the case worth looking at.
   */
  function _flashLine(latlngs, ok) {
    if (!latlngs || latlngs.length < 2) return;
    var line = L.polyline(latlngs, {
      color: ok ? "#27ae60" : "#e74c3c",
      weight: ok ? 3 : 4,
      opacity: 0.9,
      dashArray: ok ? null : "8 5",
      interactive: false,
    }).addTo(s.leafletMap);
    setTimeout(
      function () {
        if (s.leafletMap) s.leafletMap.removeLayer(line);
      },
      ok ? 2000 : 8000,
    );
  }

  function _onModifierDown(e) {
    if (e.key !== "Alt" || _altHeld || !s.editMode) return;
    _altHeld = true;
    _refreshPreview();
  }

  function _onModifierUp(e) {
    if (e.key === "Alt" && _altHeld) {
      _altHeld = false;
      if (s.editMode) _refreshPreview();
    }
  }

  // SHORTCUT CONTEXTS

  /**
   * Every key the cut tool answers, in one list, plus the two gestures that are
   * not keys at all. The list is what makes a missing half visible: Backspace
   * steps back and Shift+Backspace steps forward, and a pair with one member is
   * obvious here and invisible in the handlers.
   */
  var CUT_KEYS = {
    id: "cut",
    titleKey: "shortcuts.groupCut",
    entries: [
      {
        combos: ["Enter"],
        labelKey: "shortcuts.cutFinish",
        when: function () {
          return _points.length >= 2;
        },
        run: _finishLine,
      },
      {
        combos: ["Backspace", "Delete"],
        labelKey: "shortcuts.cutBack",
        when: function () {
          return _points.length > 0;
        },
        run: undoPoint,
      },
      {
        combos: ["Shift+Backspace", "Shift+Delete"],
        labelKey: "shortcuts.cutForward",
        when: function () {
          return _undonePoints.length > 0;
        },
        run: redoPoint,
      },
      {
        combos: ["S"],
        labelKey: "cut.snap",
        run: function () {
          _setToggle("cutSnap", !s.cutSnap);
        },
      },
      {
        combos: ["B"],
        labelKey: "cut.edges",
        run: function () {
          _setToggle("cutSnapEdges", !s.cutSnapEdges);
        },
      },
      {
        combos: ["F"],
        labelKey: "cut.follow",
        run: function () {
          _setToggle("cutFollow", !s.cutFollow);
        },
      },
      {
        combos: ["Escape"],
        labelKey: "shortcuts.cutCancel",
        run: function () {
          if (s.editMode) toggleEditMode();
        },
      },
      { combos: ["Alt"], labelKey: "shortcuts.cutAlt", note: true },
      { combos: ["Right-drag"], labelKey: "shortcuts.panRight", note: true },
      { combos: ["Right-click"], labelKey: "shortcuts.menu", note: true },
    ],
  };

  var MERGE_KEYS = {
    id: "merge",
    titleKey: "shortcuts.groupMerge",
    entries: [
      {
        // Cut commits on Enter and so does trim; merge is the third of the
        // three and answers the same key rather than only its own button.
        combos: ["Enter"],
        labelKey: "shortcuts.mergeApply",
        when: canMerge,
        run: mergeSelectedClusters,
      },
      {
        combos: ["Backspace", "Delete"],
        labelKey: "shortcuts.mergeBack",
        when: function () {
          return s.selectedClusters.length > 0;
        },
        run: deselectLast,
      },
      {
        combos: ["Shift+Backspace", "Shift+Delete"],
        labelKey: "shortcuts.mergeForward",
        when: function () {
          return _deselected.length > 0;
        },
        run: reselectLast,
      },
      {
        combos: ["C"],
        labelKey: "shortcuts.mergeClear",
        when: function () {
          return s.selectedClusters.length > 0;
        },
        run: _clearSelection,
      },
      {
        combos: ["Escape"],
        labelKey: "shortcuts.mergeCancel",
        run: function () {
          if (s.mergeMode) toggleMergeMode();
        },
      },
      { combos: ["Click"], labelKey: "shortcuts.mergePick", note: true },
      { combos: ["Right-click"], labelKey: "shortcuts.menu", note: true },
    ],
  };

  // Cut context menu

  /**
   * The cut toolbar sits in a corner; the drawing happens under the cursor.
   * Right-click already had to be watched here for panning, and a right
   * button that was released without moving is a click asking for a menu --
   * so the toolbar's actions are available where the hand already is.
   */
  function _showCutMenu(point) {
    App.ui.showContextMenu(point, [
      {
        labelKey: "cut.finish",
        icon: "fa-scissors",
        disabled: _points.length < 2,
        onClick: _finishLine,
      },
      {
        labelKey: "cut.undo",
        icon: "fa-rotate-left",
        disabled: _points.length === 0,
        onClick: undoPoint,
      },
      {
        labelKey: "cut.redo",
        icon: "fa-rotate-right",
        disabled: _undonePoints.length === 0,
        onClick: redoPoint,
      },
      { separator: true },
      {
        labelKey: "cut.snap",
        icon: s.cutSnap ? "fa-square-check" : "fa-square",
        checked: !!s.cutSnap,
        onClick: function () {
          _setToggle("cutSnap", !s.cutSnap);
        },
      },
      {
        labelKey: "cut.edges",
        icon: s.cutSnapEdges ? "fa-square-check" : "fa-square",
        checked: !!s.cutSnapEdges,
        onClick: function () {
          _setToggle("cutSnapEdges", !s.cutSnapEdges);
        },
      },
      {
        labelKey: "cut.follow",
        icon: s.cutFollow ? "fa-square-check" : "fa-square",
        checked: !!s.cutFollow,
        onClick: function () {
          _setToggle("cutFollow", !s.cutFollow);
        },
      },
      { separator: true },
      {
        labelKey: "cut.cancel",
        icon: "fa-xmark",
        danger: true,
        onClick: function () {
          if (s.editMode) toggleEditMode();
        },
      },
    ]);
  }

  /**
   * The merge toolbar's own actions, under the cursor, with the one entry a
   * toolbar cannot offer at the top: the territory being pointed at, named as
   * something to pick or drop right here.
   */
  function _showMergeMenu(point, layer, feature) {
    var selected = layer ? _selectionIndex(layer) >= 0 : false;
    App.ui.showContextMenu(point, [
      layer && {
        labelKey: selected ? "merge.deselect" : "merge.select",
        icon: selected ? "fa-square-minus" : "fa-square-plus",
        checked: selected,
        onClick: function () {
          handleClusterSelectClick(layer, feature);
        },
      },
      layer && { separator: true },
      {
        labelKey: "merge.action",
        icon: "fa-code-merge",
        disabled: !canMerge(),
        onClick: mergeSelectedClusters,
      },
      {
        labelKey: "merge.clear",
        icon: "fa-eraser",
        disabled: s.selectedClusters.length === 0,
        onClick: _clearSelection,
      },
      {
        labelKey: "merge.deleteSelected",
        icon: "fa-trash",
        danger: true,
        disabled: s.selectedClusters.length === 0,
        onClick: deleteSelectedClusters,
      },
      { separator: true },
      {
        labelKey: "merge.cancel",
        icon: "fa-xmark",
        danger: true,
        onClick: function () {
          if (s.mergeMode) toggleMergeMode();
        },
      },
    ]);
  }

  /**
   * Called by polygons.js for a right-click on a territory while a mode owns
   * the map, so the menu that opens is the one belonging to the mode rather
   * than the territory menu that would have been meaningless there.
   * @returns {boolean} whether a menu was opened
   */
  function handleModeContextMenu(point, layer, feature) {
    if (s.mergeMode) {
      _showMergeMenu(point, layer, feature);
      return true;
    }
    if (s.editMode) {
      _showCutMenu(point);
      return true;
    }
    return false;
  }

  // Cut toolbar

  function _showCutToolbar() {
    _hideCutToolbar();
    _cutToolbar = D.mountOnMap("tpl-cut-toolbar", s.leafletMap);

    _wireToggle("snap", "cutSnap");
    _wireToggle("follow", "cutFollow");
    _wireToggle("edges", "cutSnapEdges");

    D.onRole(_cutToolbar, "finish", function () {
      if (_points.length >= 2) _finishLine();
    });
    D.onRole(_cutToolbar, "undo", undoPoint);
    D.onRole(_cutToolbar, "redo", redoPoint);
    D.onRole(_cutToolbar, "cancel", function () {
      if (s.editMode) toggleEditMode();
    });

    _updateCutStatus([]);
  }

  /** Grey what cannot fire, the same way the main toolbar does. */
  function _syncCutButtons() {
    if (!_cutToolbar) return;
    [
      ["finish", _points.length >= 2],
      ["undo", _points.length > 0],
      ["redo", _undonePoints.length > 0],
    ].forEach(function (pair) {
      var node = D.role(_cutToolbar, pair[0]);
      if (!node) return;
      D.toggleClass(node, "is-disabled", !pair[1]);
      node.setAttribute("aria-disabled", String(!pair[1]));
    });
  }

  function _wireToggle(role, flag) {
    var box = D.role(_cutToolbar, role);
    if (!box) return;
    box.checked = !!s[flag];
    box.addEventListener("change", function () {
      s[flag] = !!box.checked;
      // Routing depends on which vertices count as snapped, and that does not
      // change retroactively - but the geometry between them does, so the
      // whole prefix has to be rebuilt rather than just the tail.
      _rebuildPrefix();
      _refreshPreview();
    });
  }

  function _setToggle(flag, value) {
    s[flag] = value;
    if (_cutToolbar) {
      var role = flag === "cutSnap" ? "snap" : flag === "cutFollow" ? "follow" : "edges";
      var box = D.role(_cutToolbar, role);
      if (box) box.checked = value;
    }
    _rebuildPrefix();
    _refreshPreview();
  }

  function _updateCutStatus(finished) {
    if (!_cutToolbar) return;
    D.text(_cutToolbar, "count", T("cut.vertices", { count: _points.length }));
    _syncCutButtons();

    if (_points.length < 2) {
      D.text(_cutToolbar, "status", T("cut.needMore"));
      D.toggleClass(_cutToolbar, "is-ready", false);
      return;
    }

    var report = _crossingReport(finished || []);
    D.text(
      _cutToolbar,
      "status",
      report.separates > 0
        ? T("cut.willCut", { count: report.separates })
        : report.touches > 0
          ? T("cut.willTouch")
          : T("cut.willMiss"),
    );
    D.toggleClass(_cutToolbar, "is-ready", report.separates > 0);
  }

  function _hideCutToolbar() {
    _cutToolbar = D.remove(_cutToolbar);
  }

  // SPLIT

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

      _flashLine(points, splitCount > 0);

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
   * `feature`. Returns geometries only when the part count actually grew --
   * otherwise a MultiPolygon that was merely trimmed would look like a split.
   *
   * The knife width escalates on failure, and no test has yet produced a case
   * where the wider blade helps: over zig-zag lines, 60-vertex irregular cells
   * and lines flush with an edge, every cut the narrowest blade missed was a
   * line that did not go all the way across, which no width rescues. The escalation
   * is insurance against floating-point cases nobody has reproduced; it runs
   * only after a real failure, and it costs one extra difference() on a line
   * that was going to be reported as broken anyway.
   *
   * The widths are capped below geometry.unionHealed's 1 m healing reach, so
   * two halves cut apart here can still be merged back together later without
   * leaving a visible seam. That is the actual constraint on how wide the
   * blade may get.
   */
  function _cutWithLine(feature, line) {
    var parts = G.polygonParts(feature);
    if (parts.length === 0) return null;

    var widths = s.CUT_KNIFE_M;
    for (var i = 0; i < widths.length; i++) {
      var pieces = _cutOnce(parts, line, widths[i]);
      if (pieces) {
        if (i > 0)
          console.log(">>> Cut needed a", widths[i], "m knife to separate");
        return pieces;
      }
    }
    return null;
  }

  function _cutOnce(parts, line, meters) {
    var knife;
    try {
      // steps controls the arc resolution of the caps and joins. 8 rounds
      // them properly rather than collapsing them to a point; on the cases
      // tested it made no difference to whether a cut succeeded, so this is
      // correctness for its own sake, not a fix for anything observed.
      knife = turf.buffer(G.feat(line), meters, {
        units: "meters",
        steps: 8,
      });
    } catch (e) {
      console.warn(">>> Could not build the cutting buffer:", e.message);
      return null;
    }
    if (!knife || !knife.geometry) return null;

    var out = [];
    var grew = false;

    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      var cut = null;
      try {
        cut = G.difference(part, knife);
      } catch (e) {
        cut = null;
      }
      // A null difference means the knife swallowed the part whole. Keeping
      // the original is the conservative reading; deleting territory is not
      // something a cut should ever do by accident.
      if (!cut || !cut.geometry) {
        out.push(part.geometry);
        continue;
      }

      var pieces = G.polygonParts(cut).filter(function (piece) {
        try {
          return turf.area(piece) >= s.CUT_MIN_PIECE_M2;
        } catch (e) {
          return true;
        }
      });
      if (pieces.length === 0) {
        out.push(part.geometry);
        continue;
      }
      if (pieces.length > 1) grew = true;
      pieces.forEach(function (piece) {
        out.push(piece.geometry);
      });
    }

    return grew && out.length > parts.length ? out : null;
  }

  // MERGE MODE

  function toggleMergeMode() {
    s.mergeMode = !s.mergeMode;
    App.controls.setActive("merge", s.mergeMode);

    if (s.mergeMode) {
      if (s.editMode) toggleEditMode();
      if (s.trimMode) App.trim.toggle();
      if (s.outlineMode) App.outline.toggle();
      if (s.noteMode) App.notes.toggle();
      s.selectedClusters = [];
      _deselected = [];
      // Selecting means clicking the shape, so the tooltip is pinned above it
      // rather than sitting under the pointer - the count still reads, the
      // click target stays clear.
      App.polygons.setTooltipMode("anchored");
      App.gaps.schedule(0);
      _showMergeToolbar();
      _mergeHint = D.mountOnMap("tpl-merge-hint", s.leafletMap);
      App.shortcuts.push(MERGE_KEYS);
      // Without a scope of its own, Ctrl+Z in merge mode reached past the
      // selection being built and undid the last change to the territories
      // themselves - the exact failure history.js's scope stack was written
      // to stop, in the one mode that never registered one.
      App.history.pushScope(MERGE_SCOPE);
    } else {
      App.polygons.setTooltipMode("full");
      App.gaps.schedule(0);
      _clearSelection();
      _hideMergeToolbar();
      _mergeHint = D.remove(_mergeHint);
      _deselected = [];
      App.shortcuts.pop("merge");
      App.history.popScope("merge");
    }
    App.ui.closeContextMenu();
  }

  /** Enter merge mode with one territory already picked. */
  function startMergeWith(layer, feature) {
    if (!s.mergeMode) toggleMergeMode();
    if (!s.mergeMode) return;
    if (_selectionIndex(layer) < 0) handleClusterSelectClick(layer, feature);
  }

  /**
   * Hold a selection that was built somewhere else - the territory list.
   *
   * The list is a far better place to pick fourteen territories out of ninety-
   * nine than the map is, and merge mode is where a live selection already
   * lives: it paints the shapes, counts them, gives Ctrl+Z something to walk
   * back and puts the actions within reach. So the list does the picking and
   * hands the result here rather than growing a second selection of its own,
   * which would be two ideas of "selected" and one of them wrong.
   *
   * Replaces whatever was selected rather than adding to it: the list showed a
   * set and the map should show that set, not the union of two answers taken
   * minutes apart.
   *
   * @param {{layer: Object, feature: Object}[]} items
   * @returns {boolean} whether anything is now selected
   */
  function selectClusters(items) {
    var picked = (items || []).filter(function (item) {
      return item && item.layer && item.feature;
    });
    if (picked.length === 0) {
      // An empty hand-over is still a hand-over: the list is authoritative at
      // the moment it closes, so clearing the selection in there clears it
      // here. What it must not do is open a mode to hold nothing.
      if (s.mergeMode) _clearSelection();
      return false;
    }

    if (!s.mergeMode) toggleMergeMode();
    if (!s.mergeMode) return false;

    _clearSelection();
    picked.forEach(function (item) {
      if (_selectionIndex(item.layer) >= 0) return;
      s.selectedClusters.push({ layer: item.layer, feature: item.feature });
      App.polygons.selectCluster(item.layer, true);
    });
    // Arriving from the list is a fresh start, not a step in the walk the
    // undo stack is keeping - there is nothing behind it to go back to.
    _deselected = [];
    _updateMergeCount();
    return s.selectedClusters.length > 0;
  }

  /**
   * Delete everything currently selected, as one undoable step.
   *
   * No confirmation, for the reason gaps.js gives for adopting without one: it
   * is one click to make and one Ctrl+Z to take back, and a prompt in front of
   * a gesture that cheap teaches people to click through prompts. The single
   * delete in the territory's own context menu has never asked either, and two
   * answers to the same question would be worse than both.
   */
  function deleteSelectedClusters() {
    if (s.selectedClusters.length === 0) return 0;
    var layers = s.selectedClusters.map(function (item) {
      return item.layer;
    });
    App.ui.busy("loading.deleting", function () {
      var gone = App.polygons.deleteClusters(layers);
      // setClusters has already put the selection down and rebuilt every
      // layer, so there is nothing left for the mode to hold on to.
      if (gone > 0 && s.mergeMode) toggleMergeMode();
    });
    return layers.length;
  }

  function _selectionIndex(layer) {
    for (var i = 0; i < s.selectedClusters.length; i++) {
      if (s.selectedClusters[i].layer === layer) return i;
    }
    return -1;
  }

  function canMerge() {
    return s.selectedClusters.length >= 2;
  }

  function handleClusterSelectClick(layer, feature) {
    var idx = _selectionIndex(layer);
    if (idx >= 0) {
      App.polygons.selectCluster(layer, false);
      s.selectedClusters.splice(idx, 1);
    } else {
      s.selectedClusters.push({ layer: layer, feature: feature });
      App.polygons.selectCluster(layer, true);
    }
    // Picking or dropping by hand branches off the timeline, exactly as
    // placing a vertex does for the cut tool.
    _deselected = [];
    _updateMergeCount();
  }

  /** Take back the most recent pick. @returns {boolean} whether anything moved */
  function deselectLast() {
    if (!s.mergeMode || s.selectedClusters.length === 0) return false;
    var item = s.selectedClusters.pop();
    App.polygons.selectCluster(item.layer, false);
    _deselected.push(item);
    _updateMergeCount();
    return true;
  }

  /** Put back what deselectLast() took. */
  function reselectLast() {
    if (!s.mergeMode || _deselected.length === 0) return false;
    var item = _deselected.pop();
    s.selectedClusters.push(item);
    App.polygons.selectCluster(item.layer, true);
    _updateMergeCount();
    return true;
  }

  /** Undo/redo belong to the selection while one is being collected. */
  var MERGE_SCOPE = {
    id: "merge",
    undo: deselectLast,
    redo: reselectLast,
    canUndo: function () {
      return s.selectedClusters.length > 0;
    },
    canRedo: function () {
      return _deselected.length > 0;
    },
    undoDepth: function () {
      return s.selectedClusters.length;
    },
    redoDepth: function () {
      return _deselected.length;
    },
    undoKey: "toolbar.undoSelect",
    redoKey: "toolbar.redoSelect",
  };

  /**
   * Is essentially all of `part` inside `whole`?
   *
   * A percent of slack, because unionHealed rounds an outline by the few
   * centimeters it buffers with and a territory is allowed to come back a
   * hair smaller than it went in. A territory that came back missing is not
   * a hair.
   */
  function _isCovered(part, whole) {
    try {
      var shared = G.intersect(whole, part);
      if (!shared || !shared.geometry) return false;
      return G.area(shared) >= G.area(part) * 0.99;
    } catch (e) {
      // Unmeasurable. Treated as covered, because refusing every merge whose
      // arithmetic this check cannot do is worse than the fault it looks for.
      return true;
    }
  }

  function mergeSelectedClusters() {
    if (!canMerge()) {
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
        // unionHealed grows each input by half a meter before unioning, so
        // boundaries that only nearly coincide still dissolve. A plain union
        // leaves hairline slivers, and Leaflet draws the internal outlines.
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

      // Did the union actually take all of them?
      //
      // This is the one failure that cannot be seen on the map. What comes
      // back is a perfectly ordinary-looking territory, and the ground that
      // went missing is only discovered by whoever was sent to walk it --
      // weeks later, as a hole in the coverage. It happens: unionAll answers
      // a throw with a partial union by design, because for its other callers
      // most of an outline beats none of it, and geometry.unionHealed can be
      // handed a shape that turf's buffer has already destroyed. Both are
      // guarded at their own end; this is the check that does not depend on
      // knowing how it went wrong.
      //
      // Before the clip to the outer boundary, which is entitled to take
      // ground away, and against each input separately rather than against
      // the total, because a small territory swallowed whole is a rounding
      // error in a sum and the whole of somebody's afternoon on the ground.
      var lost = selected.filter(function (item) {
        return !_isCovered(item.feature, merged);
      });
      if (lost.length > 0) {
        App.ui.hideOverlay();
        console.error(
          ">>> Merge dropped", lost.length, "of", selected.length,
          "territories — refusing rather than losing the ground",
        );
        alert(T("alert.mergeIncomplete", { n: lost.length }));
        toggleMergeMode();
        return;
      }

      if (s.outerPolygonLayer) {
        try {
          var clipped = G.intersect(
            merged,
            G.outerFeature(s.outerPolygonLayer),
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
    D.onRole(_mergeToolbar, "merge", function () {
      if (canMerge()) mergeSelectedClusters();
    });
    D.onRole(_mergeToolbar, "delete", function () {
      if (s.selectedClusters.length > 0) deleteSelectedClusters();
    });
    D.onRole(_mergeToolbar, "clear", _clearSelection);
    D.onRole(_mergeToolbar, "cancel", toggleMergeMode);
    _updateMergeCount();
  }

  function _hideMergeToolbar() {
    _mergeToolbar = D.remove(_mergeToolbar);
  }

  function _updateMergeCount() {
    App.history.sync();
    if (!_mergeToolbar) return;
    D.text(
      _mergeToolbar,
      "count",
      T("merge.selected", { count: s.selectedClusters.length }),
    );

    // Disabled with a reason rather than clickable-into-an-alert, which is how
    // every button in the main toolbar behaves. A mode's own bar is no
    // exception.
    var merge = D.role(_mergeToolbar, "merge");
    if (merge) {
      var ready = canMerge();
      D.toggleClass(merge, "is-disabled", !ready);
      merge.setAttribute("aria-disabled", String(!ready));
      merge.title = T(ready ? "merge.action" : "merge.needsTwo");
    }
    var clear = D.role(_mergeToolbar, "clear");
    if (clear) {
      var any = s.selectedClusters.length > 0;
      D.toggleClass(clear, "is-disabled", !any);
      clear.setAttribute("aria-disabled", String(!any));
    }
  }

  function _clearSelection() {
    // Kept on the redo stack newest-last, so Shift+Backspace walks a cleared
    // selection back one territory at a time rather than all-or-nothing.
    s.selectedClusters.forEach(function (item) {
      App.polygons.selectCluster(item.layer, false);
      _deselected.push(item);
    });
    s.selectedClusters = [];
    _updateMergeCount();
  }

  return {
    init: init,
    toggleEditMode: toggleEditMode,
    toggleMergeMode: toggleMergeMode,
    startMergeWith: startMergeWith,
    handleClusterSelectClick: handleClusterSelectClick,
    handleModeContextMenu: handleModeContextMenu,
    selectClusters: selectClusters,
  };
})();

window.App = App;
