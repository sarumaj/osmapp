/**
 * network.js — the street graph, shared by everything that has to follow one.
 *
 * The cut tool and the trim tool ask this the same two questions: given a
 * point, which street is under it, and given two points on the network, what
 * is the route between them. One graph answers both, because two copies of a
 * routing heuristic is two sets of detour limits and two definitions of
 * "snapped", one of which drifts — the same reason spatial.js exists.
 *
 * The boundary-edge grid is deliberately *not* here. That one indexes territory
 * outlines rather than streets and belongs to the cut tool alone: a cut may
 * snap onto the shape it is cutting, a trimmed boundary may not.
 *
 * The graph is built from s.cachedStreets and cached until invalidate(), so a
 * mouse-move handler and a slider drag can both ask for it every frame.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.network = (function () {
  "use strict";

  var s = null;
  var SP = null;

  var _nodes = Object.create(null); // key -> L.LatLng
  var _adj = Object.create(null); // key -> [{ key, dist }]
  var _segGrid = null; // street center-lines
  var _nodeGrid = null; // intersections and shape points
  var _built = false;
  var _stamp = null; // the feature collection the graph was built from

  function init() {
    s = App.state;
    SP = App.spatial;
    App._loaded.push("network");
  }

  // ══════════════════════════════════════════════════════════════════════
  // BUILD
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Index the downloaded streets. Cheap to call: the work is skipped when the
   * same feature collection has already been indexed.
   * @param {boolean} [force] rebuild even if the cache looks current
   */
  function build(force) {
    var streets = s && s.cachedStreets;
    if (!force && _built && _stamp === streets) return _built;

    _nodes = Object.create(null);
    _adj = Object.create(null);
    _segGrid = new SP.Grid(120);
    _nodeGrid = new SP.Grid(120);
    _stamp = streets;

    if (streets && streets.features) {
      streets.features.forEach(function (feature) {
        if (!feature.geometry) return;
        var lines =
          feature.geometry.type === "MultiLineString"
            ? feature.geometry.coordinates
            : [feature.geometry.coordinates];

        lines.forEach(function (line) {
          for (var i = 0; i < line.length - 1; i++) {
            var p1 = L.latLng(line[i][1], line[i][0]);
            var p2 = L.latLng(line[i + 1][1], line[i + 1][0]);
            var k1 = nodeKey(p1);
            var k2 = nodeKey(p2);
            if (k1 === k2) continue;

            var d = p1.distanceTo(p2);
            _segGrid.addSegment([p1.lng, p1.lat], [p2.lng, p2.lat], null);
            _nodes[k1] = p1;
            _nodes[k2] = p2;
            (_adj[k1] || (_adj[k1] = [])).push({ key: k2, dist: d });
            (_adj[k2] || (_adj[k2] = [])).push({ key: k1, dist: d });
          }
        });
      });
    }

    Object.keys(_nodes).forEach(function (key) {
      _nodeGrid.addPoint([_nodes[key].lng, _nodes[key].lat], key);
    });

    _built = true;
    console.log(
      ">>> Street network:",
      _segGrid.items.length,
      "segments,",
      Object.keys(_nodes).length,
      "nodes",
    );
    return _built;
  }

  /** Forget the graph, e.g. after a fresh download. */
  function invalidate() {
    _built = false;
    _stamp = null;
  }

  function isReady() {
    return _built && _segGrid !== null;
  }

  /** Five decimals is about a meter — the precision OSM ways are noded at. */
  function nodeKey(latlng) {
    return latlng.lat.toFixed(5) + "," + latlng.lng.toFixed(5);
  }

  function nodeLatLng(key) {
    return _nodes[key] || null;
  }

  function stats() {
    return {
      segments: _segGrid ? _segGrid.items.length : 0,
      nodes: Object.keys(_nodes).length,
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // QUERIES
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Nearest point anywhere on a street center-line.
   * @param {number[]} coord [lng, lat]
   * @returns {{coord: number[], dist: number}|null}
   */
  function nearestSegmentPoint(coord, maxMeters) {
    if (!_segGrid) return null;
    return _segGrid.nearestSegment(coord, maxMeters);
  }

  /**
   * Nearest graph node — an intersection or a shape point.
   * @returns {{key: string, coord: number[], latlng: L.LatLng, dist: number}|null}
   */
  function nearestNode(coord, maxMeters) {
    if (!_nodeGrid) return null;
    var hit = _nodeGrid.nearestPoint(coord, maxMeters);
    if (!hit) return null;
    return {
      key: hit.payload,
      coord: hit.coord,
      latlng: _nodes[hit.payload],
      dist: hit.dist,
    };
  }

  /** The same, taking and returning Leaflet types. */
  function nearestNodeAt(latlng, maxMeters) {
    return nearestNode([latlng.lng, latlng.lat], maxMeters);
  }

  // ══════════════════════════════════════════════════════════════════════
  // ROUTING
  // ══════════════════════════════════════════════════════════════════════

  /**
   * A* over the street graph. The straight-line heuristic is admissible, so
   * the path is optimal; the pop budget is what keeps a live preview from
   * stalling on a graph whose two endpoints are in different components.
   *
   * @returns {L.LatLng[]|null} the full path, endpoints included
   */
  function route(startKey, endKey, budget) {
    if (startKey === endKey) return _nodes[startKey] ? [_nodes[startKey]] : null;
    if (!_adj[startKey] || !_adj[endKey]) return null;

    var goal = _nodes[endKey];
    var goalCoord = [goal.lng, goal.lat];

    var g = Object.create(null);
    var prev = Object.create(null);
    var visited = Object.create(null);
    var heap = new SP.MinHeap();
    var pops = 0;
    var cap = budget || (s && s.CUT_ROUTE_MAX_POPS) || 30000;
    var found = false;

    g[startKey] = 0;
    heap.push({ k: startKey, f: 0 });

    while (heap.size() > 0 && pops++ < cap) {
      var cur = heap.pop().k;
      if (visited[cur]) continue;
      visited[cur] = true;
      if (cur === endKey) {
        found = true;
        break;
      }

      var neighbors = _adj[cur] || [];
      for (var i = 0; i < neighbors.length; i++) {
        var nb = neighbors[i];
        if (visited[nb.key]) continue;
        var alt = g[cur] + nb.dist;
        if (g[nb.key] !== undefined && alt >= g[nb.key]) continue;
        g[nb.key] = alt;
        prev[nb.key] = cur;
        var n = _nodes[nb.key];
        heap.push({ k: nb.key, f: alt + SP.dist([n.lng, n.lat], goalCoord) });
      }
    }

    if (!found) return null;

    var path = [];
    var node = endKey;
    while (node !== undefined) {
      path.unshift(_nodes[node]);
      node = prev[node];
    }
    return path.length >= 2 ? path : null;
  }

  /** Ground length of a path, in meters. */
  function pathLength(path) {
    var total = 0;
    for (var i = 0; i < path.length - 1; i++)
      total += path[i].distanceTo(path[i + 1]);
    return total;
  }

  return {
    init: init,
    build: build,
    invalidate: invalidate,
    isReady: isReady,
    nodeKey: nodeKey,
    nodeLatLng: nodeLatLng,
    nearestSegmentPoint: nearestSegmentPoint,
    nearestNode: nearestNode,
    nearestNodeAt: nearestNodeAt,
    route: route,
    pathLength: pathLength,
    stats: stats,
  };
})();

window.App = App;
