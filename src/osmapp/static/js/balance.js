/**
 * balance.js - making the partition even out the thing it was asked to.
 *
 * The dialog offers two splits and this module is what tells them apart.
 * byBuildings() evens out the houses in each territory; byArea() evens out the
 * ground each one covers. Both are the same trade over a different number, and
 * neither is something the phases before this one deliver on their own.
 *
 * For buildings: k-means minimizes squared distance, which in two dimensions
 * settles at a centroid density of sqrt(building density) - so a territory
 * over a dense core holds the square root of the density ratio more buildings
 * than one over the outskirts, and that is the *converged* answer, not a
 * failure to converge.
 *
 * For area: k-means over a uniform sample of the ground does converge on equal
 * areas, but only over the Voronoi cells. Routing those cell edges onto the
 * street network moves every boundary by up to a block in whichever direction
 * the streets happen to run, and gap filling and the connectivity repair move
 * more ground again.
 *
 * Either way the number the dialog printed is a guess right up until this
 * runs, because nothing before it has measured the finished territories.
 *
 * The currency is the polygonized piece - a city block bounded by the streets
 * the partition routed along - so a trade moves a block from a full territory
 * to a thin neighbor and leaves both still bounded by streets, which is the
 * property the whole pipeline exists to produce. Nothing here creates or
 * reshapes geometry: it rewrites which territory owns which block, and the
 * caller unions the blocks afterwards.
 *
 * Hill climbing on the total deviation from the target. A trade is taken only
 * when it strictly reduces `sum |load - target|`, so the objective falls
 * monotonically and the loop cannot cycle.
 *
 * Two invariants hold every trade back, and both matter more than balance: a
 * territory never gives away its last block, and never gives away a block that
 * would leave it in more parts than it was already in. Splitting a territory
 * to even out a count would hand the connectivity repair that runs afterwards
 * a mess to fix, and undo the balance in the process.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.balance = (function () {
  "use strict";

  var G = null;
  var SP = null;

  // The pass stops on its own when no trade improves the spread. The caps are
  // there so a pathological adjacency graph costs a bounded amount of time
  // rather than the tab, and both sit well above what a real town needs: a
  // 3000-building partition settles in three passes and a few hundred trades.
  var BALANCE_PASSES = 12;
  var BALANCE_MOVE_CAP = 5000;

  function init() {
    G = App.geometry;
    SP = App.spatial;
    App._loaded.push("balance");
  }

  /**
   * Trade blocks until the territories hold equal numbers of buildings.
   *
   * Mutates `owner` in place. See _trade for the machinery.
   *
   * @param {Object[]} pieces polygonized faces
   * @param {number[]} owner piece index -> territory index, -1 for unassigned
   * @param {Object[]} buildingPts building centroids inside the area
   * @returns {Report|null} null when no buildings were downloaded
   */
  function byBuildings(pieces, owner, buildingPts) {
    if (!buildingPts || buildingPts.length === 0) return null;
    return _trade(pieces, owner, counts(pieces, buildingPts));
  }

  /**
   * Trade blocks until the territories cover equal ground.
   *
   * The other half of what the partition dialog offers. Splitting by area is
   * the mode for ground where the buildings are a poor guide to the walking -
   * a village of scattered farms, a district that is mostly allotments - and
   * it has to be measured in the unit it promises, or the two radio buttons
   * are one algorithm wearing two labels.
   *
   * Mutates `owner` in place.
   *
   * @param {Object[]} pieces polygonized faces
   * @param {number[]} owner piece index -> territory index, -1 for unassigned
   * @returns {Report|null} null when there is nothing to balance
   */
  function byArea(pieces, owner) {
    return _trade(
      pieces,
      owner,
      pieces.map(function (piece) {
        try {
          return turf.area(piece);
        } catch (e) {
          return 0; // a shape turf cannot measure is never worth trading
        }
      }),
    );
  }

  /**
   * The trade itself, over whatever weight the caller is evening out.
   *
   * Buildings and square metres are the same problem in different units: each
   * block carries a number, each territory carries the sum of its blocks, and
   * the pass moves blocks across territory borders until no single move brings
   * the totals closer together. Nothing below reads what the number means.
   *
   * @typedef {{target:number, moves:number, passes:number,
   *            before:{min:number,max:number},
   *            after:{min:number,max:number}}} Report
   *
   * @param {Object[]} pieces polygonized faces - Polygon features that tile
   *   the area and meet along shared edges, as turf.polygonize returns them
   * @param {number[]} owner piece index -> territory index, -1 for unassigned
   * @param {number[]} perPiece what each piece is worth, in the caller's unit
   * @returns {Report|null} null when fewer than two territories carry anything
   */
  function _trade(pieces, owner, perPiece) {
    var adj = _pieceAdjacency(pieces);

    var members = Object.create(null);
    var load = Object.create(null);
    var carried = 0;
    var i;

    for (i = 0; i < pieces.length; i++) {
      var slot = owner[i];
      if (slot < 0) continue;
      if (!members[slot]) {
        members[slot] = new Set();
        load[slot] = 0;
      }
      members[slot].add(i);
      load[slot] += perPiece[i];
      carried += perPiece[i];
    }

    var keys = Object.keys(members);
    if (keys.length < 2 || carried === 0) return null;

    var target = carried / keys.length;
    var before = _loadSpread(load, keys);

    // What counts as an improvement worth making, in whatever unit this is.
    // A fixed epsilon cannot serve both: 1e-9 of a building is every real
    // trade, and 1e-9 of a square metre is float noise that lets two blocks
    // swap back and forth until the move cap stops them. One part in a
    // million of the target is below any trade either unit can express.
    var minGain = Math.max(1e-9, target * 1e-6);

    function pairCost(a, b) {
      return Math.abs(a - target) + Math.abs(b - target);
    }

    var moves = 0;
    var pass = 0;
    var changed = true;

    while (changed && pass++ < BALANCE_PASSES && moves < BALANCE_MOVE_CAP) {
      changed = false;

      for (i = 0; i < pieces.length && moves < BALANCE_MOVE_CAP; i++) {
        var from = owner[i];
        if (from < 0 || members[from].size < 2) continue;
        if (perPiece[i] === 0) continue; // trading empty ground changes nothing

        var best = -1;
        var bestGain = minGain;
        var neighbors = adj[i];

        for (var n = 0; n < neighbors.length; n++) {
          var to = owner[neighbors[n]];
          if (to < 0 || to === from) continue;
          var gain =
            pairCost(load[from], load[to]) -
            pairCost(load[from] - perPiece[i], load[to] + perPiece[i]);
          if (gain > bestGain) {
            bestGain = gain;
            best = to;
          }
        }

        if (best < 0) continue;
        if (
          _componentCount(members[from], i, adj) >
          _componentCount(members[from], -1, adj)
        )
          continue;

        members[from].delete(i);
        members[best].add(i);
        load[from] -= perPiece[i];
        load[best] += perPiece[i];
        owner[i] = best;
        moves++;
        changed = true;
      }
    }

    return {
      target: target,
      moves: moves,
      passes: pass - 1,
      before: before,
      after: _loadSpread(load, keys),
    };
  }

  /** @returns {{min:number,max:number}} the emptiest and fullest territory */
  function _loadSpread(load, keys) {
    var min = Infinity;
    var max = -Infinity;
    keys.forEach(function (key) {
      if (load[key] < min) min = load[key];
      if (load[key] > max) max = load[key];
    });
    return { min: min === Infinity ? 0 : min, max: max === -Infinity ? 0 : max };
  }

  /**
   * How many buildings stand in each of `features`.
   *
   * The features are indexed by bounding box and the points asked once each,
   * rather than every feature being tested against every point: a town is
   * twelve thousand buildings against a few thousand blocks, and the
   * exhaustive form is forty million box comparisons before a single
   * point-in-polygon test.
   *
   * A building lands in exactly one feature - the first that contains it - by
   * the centroid, which is the rule autoheal.js and the territory tooltip both
   * use. All three have to agree or the pass that evens the counts out is
   * evening out a different number from the one on screen. Blocks tile the
   * area, so "the first" and "the only" are the same block except on a shared
   * edge, where some one territory has to have it.
   *
   * @param {Object[]} features polygons to count in
   * @param {Object[]} points building centroids
   * @returns {number[]} one count per feature, in the order given
   */
  function counts(features, points) {
    var out = [];
    var grid = new SP.Grid(100);

    features.forEach(function (feature, i) {
      out.push(0);
      var box = G.bbox(feature);
      if (box) grid.addSegment([box[0], box[1]], [box[2], box[3]], i);
    });

    (points || []).forEach(function (point) {
      var c = point.geometry.coordinates;
      var candidates = grid.candidates(c, 1);
      for (var n = 0; n < candidates.length; n++) {
        var item = grid.items[candidates[n]];
        if (
          c[0] < item.a[0] || c[0] > item.b[0] ||
          c[1] < item.a[1] || c[1] > item.b[1]
        )
          continue;
        try {
          if (turf.booleanPointInPolygon(point, features[item.payload])) {
            out[item.payload]++;
            return;
          }
        } catch (e) {
          /* a shape turf cannot test holds nothing rather than failing the pass */
        }
      }
    });

    return out;
  }

  /**
   * Which pieces share a boundary, keyed on the boundary itself.
   *
   * turf.polygonize builds its faces out of the noded line set the caller
   * hands it, and clustering.js rounds that set to five decimals first, so two
   * faces meeting along an edge carry the same two coordinates for it.
   * Matching on the edge is therefore exact and costs one pass over the
   * vertices. Measuring adjacency with buffers and intersections - what
   * clustering.js and autoheal.js both have to do for territories that were
   * never cut from the same graph - would be thousands of turf calls for an
   * answer already written in the coordinates.
   *
   * @returns {number[][]} piece index -> neighboring piece indices
   */
  function _pieceAdjacency(pieces) {
    var byEdge = new Map();
    var adj = [];
    var sets = [];

    pieces.forEach(function () {
      adj.push([]);
      sets.push(new Set());
    });

    function link(a, b) {
      if (a === b || sets[a].has(b)) return;
      sets[a].add(b);
      sets[b].add(a);
      adj[a].push(b);
      adj[b].push(a);
    }

    pieces.forEach(function (piece, i) {
      var ring =
        piece.geometry &&
        piece.geometry.coordinates &&
        piece.geometry.coordinates[0];
      if (!ring) return;

      for (var v = 0; v < ring.length - 1; v++) {
        var a = ring[v];
        var b = ring[v + 1];
        var ka = a[0].toFixed(5) + "," + a[1].toFixed(5);
        var kb = b[0].toFixed(5) + "," + b[1].toFixed(5);
        var key = ka < kb ? ka + "|" + kb : kb + "|" + ka;
        var first = byEdge.get(key);
        if (first === undefined) byEdge.set(key, i);
        else link(first, i);
      }
    });

    return adj;
  }

  /**
   * How many connected groups `members` falls into, ignoring `exclude`.
   *
   * @param {Set<number>} members piece indices
   * @param {number} exclude a piece to leave out, or -1 for none
   * @param {number[][]} adj the piece adjacency
   */
  function _componentCount(members, exclude, adj) {
    var seen = new Set();
    var count = 0;

    members.forEach(function (start) {
      if (start === exclude || seen.has(start)) return;
      count++;
      seen.add(start);
      var queue = [start];
      while (queue.length > 0) {
        var current = queue.pop();
        var neighbors = adj[current];
        for (var i = 0; i < neighbors.length; i++) {
          var next = neighbors[i];
          if (next === exclude || seen.has(next) || !members.has(next)) continue;
          seen.add(next);
          queue.push(next);
        }
      }
    });

    return count;
  }

  return {
    init: init,
    byBuildings: byBuildings,
    byArea: byArea,
    counts: counts,
  };
})();

window.App = App;
