/**
 * gaps.js — the parts of the area that belong to no territory.
 *
 * ── Why ───────────────────────────────────────────────────────────────────
 *
 * The partitioner tessellates: every square meter inside the boundary ends up
 * in exactly one territory, so for a long time "uncovered" was not a state the
 * app could be in. Four things changed that, and all four leave holes that
 * nothing on screen points at:
 *
 *   • Growing the boundary. Reshaping the outline outward adds ground that no
 *     territory has ever covered, and the map looks finished — the new area is
 *     inside the blue outline, it just is not in any card.
 *   • Deleting a territory. The hole is exactly the shape that was deleted.
 *   • Cutting. A split that shaves a piece below CUT_MIN_PIECE_M2 discards it.
 *   • Drawing a territory by hand inside the whole-area cluster, where the
 *     remainder falls below MIN_REMAINDER_M2 and belongs to nobody.
 *
 * The failure mode they share is the quiet one: nothing is wrong on screen,
 * and you find out when a street is on no card. So the gaps are drawn, they
 * say what they are on hover, and clicking one turns it into a territory.
 *
 * ── Why the seams are not gaps ────────────────────────────────────────────
 *
 * A tessellation's internal edges coincide only to floating-point precision,
 * so subtracting the union of the territories from the boundary returns a
 * hairline sliver along every shared edge — hundreds of them, each a few
 * centimeters wide and none of them a gap in any sense that matters.
 *
 * Each remaining piece is therefore *opened*: shrunk by half a meter and, if
 * anything survives, grown back. A seam does not survive. A strip left by
 * dragging the boundary outward is meters wide and does. See _open below for
 * why this is done per piece rather than by subtracting a healed union, which
 * is the obvious move and produces a self-touching ring.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.gaps = (function () {
  "use strict";

  var s = null;
  var G = null;
  var D = null;
  var T = null;

  var _features = []; // the uncovered pieces, largest first
  var _timer = null;
  var _visible = true;
  var _hovered = null;

  var PANE = "gapsPane";

  // Above the outer boundary, below the territories. It cannot overlap a
  // territory by construction, so the only thing this ordering decides is
  // that a gap wins over the boundary spanning it — which is the whole point,
  // since the boundary would otherwise swallow the hover.
  var STYLE = {
    color: "#e67e22",
    weight: 2,
    dashArray: "6 4",
    fillColor: "#f39c12",
    fillOpacity: 0.18,
    pane: PANE,
  };

  var STYLE_HOVER = {
    color: "#b9770e",
    weight: 3,
    dashArray: null,
    fillColor: "#f39c12",
    fillOpacity: 0.42,
    pane: PANE,
  };

  function init() {
    s = App.state;
    G = App.geometry;
    D = App.dom;
    T = App.i18n.t;
    App._loaded.push("gaps");
  }

  // ══════════════════════════════════════════════════════════════════════
  // VISIBILITY
  // ══════════════════════════════════════════════════════════════════════

  function isVisible() {
    return _visible;
  }

  /**
   * Driven by the layer control's checkbox.
   *
   * Switching it off stops the computation as well as the drawing: the
   * subtraction underneath this is the most expensive thing on the page after
   * the partitioner, and paying for it to render nothing would be the kind of
   * cost that only shows up on somebody else's laptop. Switching it back on
   * recomputes rather than redrawing what was cached, because the territories
   * have very likely moved in the meantime.
   */
  function setVisible(on) {
    var next = !!on;
    if (next === _visible) return;
    _visible = next;
    if (_visible) schedule(0);
    else {
      _features = [];
      _render();
      if (App.controls) App.controls.refresh();
    }
  }

  /**
   * A modal tool owns the map while it runs, and a click that silently turns
   * an empty patch into a territory in the middle of drawing a split line is
   * the kind of surprise that costs more than the feature is worth. Hidden
   * rather than merely non-interactive: a dashed orange shape under a cut
   * preview is noise even when it cannot be clicked.
   */
  function _suppressed() {
    return !!(s.editMode || s.mergeMode || s.trimMode || s.outlineMode);
  }

  // ══════════════════════════════════════════════════════════════════════
  // COMPUTE
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Recompute soon, coalescing bursts.
   *
   * Everything that changes the answer goes through setClusters(), and a
   * partition run calls it once — but a session restore, an import and an undo
   * can all land within a frame of each other, and the union underneath this
   * is the most expensive thing on the page after the partitioner itself.
   */
  function schedule(delay) {
    clearTimeout(_timer);
    _timer = setTimeout(recompute, delay == null ? 200 : delay);
  }

  function recompute() {
    clearTimeout(_timer);
    _timer = null;
    // Both guards produce the same empty answer, and both mean "nobody can
    // act on this right now" — so neither should pay for the subtraction.
    _features = _visible && !_suppressed() ? _find() : [];
    _render();
    if (App.controls) App.controls.refresh();
  }

  function _find() {
    if (!s.outerPolygonLayer) return [];

    var outer;
    try {
      outer = G.getOuterFeature(s.outerPolygonLayer);
    } catch (e) {
      return [];
    }
    if (!outer || !outer.geometry) return [];

    var covered = null;
    var features = App.polygons.clusterFeatures();
    if (features.length) {
      try {
        covered = G.unionAll(features);
      } catch (e) {
        covered = null;
      }
    }

    // Nothing covered at all is not a gap, it is an empty area — and
    // ensureDefaultCluster already has an opinion about that case.
    if (!covered || !covered.geometry) return [];

    var rest = null;
    try {
      rest = G.difference(outer, covered);
    } catch (e) {
      rest = null;
    }
    if (!rest || !rest.geometry) return [];

    var minimum = s.GAP_MIN_M2 || 1000;
    var out = [];
    G.polygonParts(rest).forEach(function (part) {
      var piece = _open(part);
      if (piece && _area(piece) >= minimum) out.push(piece);
    });
    return out.sort(function (a, b) {
      return _area(b) - _area(a);
    });
  }

  /**
   * Morphological opening: shrink by half a meter, and if anything survives,
   * grow it back. What does not survive was never a gap.
   *
   * This replaced subtracting a *healed* union, which was the obvious move and
   * was wrong in a way worth recording. G.unionHealed grows each territory,
   * unions, then shrinks the result back — and the shrink erodes the union's
   * real outer edge along with the artificial internal ones. So the remainder
   * came back as the genuine gap joined to a two-centimeter frame running
   * around the entire boundary: one region, pinched at the corners, with a
   * self-touching ring that turf.buffer collapses to a few square meters. The
   * area test passed because the frame is attached to something big.
   *
   * Opening asks the question directly instead. A seam between two territories
   * is a few centimeters wide and vanishes; so does a frame; a strip left by
   * dragging the boundary outward is meters or hundreds of meters wide and
   * does not.
   *
   * @returns {Feature|null}
   */
  function _open(part) {
    var eps = s.GAP_OPEN_M || 0.5;
    var core = null;
    try {
      core = turf.buffer(part, -eps, { units: "meters" });
    } catch (e) {
      core = null;
    }
    if (!core || !core.geometry || _area(core) <= 0) return null;

    var grown = null;
    try {
      grown = turf.buffer(core, eps, { units: "meters" });
    } catch (e) {
      grown = null;
    }
    if (!grown || !grown.geometry) return core;

    // Growing back must not reach into a territory, so the result is clipped
    // to the region it came from. Without this an adopted gap would overlap
    // its neighbours by half a meter.
    var clipped = null;
    try {
      clipped = G.intersect(grown, part);
    } catch (e) {
      clipped = null;
    }
    var piece = clipped && clipped.geometry ? clipped : core;
    return G.largestPolygon(piece) || piece;
  }

  function _area(feature) {
    try {
      return turf.area(feature);
    } catch (e) {
      return 0;
    }
  }

  function count() {
    return _features.length;
  }

  function totalArea() {
    return _features.reduce(function (sum, feature) {
      return sum + _area(feature);
    }, 0);
  }

  /** For tests and for the info panel; the geometry is not handed out live. */
  function features() {
    return _features.slice();
  }

  // ══════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════

  function _render() {
    var group = s.gapsLayerGroup;
    if (!group) return;
    group.clearLayers();
    _hovered = null;
    if (!_visible || _suppressed()) return;

    _features.forEach(function (feature, index) {
      var layer = G.toLayer(feature.geometry, STYLE, { pane: PANE });
      if (!layer) return;
      _bind(layer, feature, index);
      group.addLayer(layer);
    });
  }

  function _bind(layer, feature, index) {
    layer.bindTooltip(
      function () {
        return _tooltip(feature);
      },
      {
        direction: "top",
        className: "feature-tooltip",
        opacity: 0.95,
        sticky: true,
      },
    );

    layer.on("mouseover", function () {
      _hovered = index;
      layer.setStyle(STYLE_HOVER);
    });

    layer.on("mouseout", function () {
      _hovered = null;
      layer.setStyle(STYLE);
    });

    layer.on("click", function (e) {
      // Otherwise the map sees the click too, and in the one mode where that
      // matters — a boundary being drawn — it would place a vertex.
      L.DomEvent.stopPropagation(e);
      adopt(feature);
    });

    layer.on("contextmenu", function (e) {
      L.DomEvent.stopPropagation(e);
      _menu(e.containerPoint, feature);
    });
  }

  function _tooltip(feature) {
    var km2 = _area(feature) / 1e6;
    return (
      '<div class="feature-tooltip__title">' +
      _escape(T("gaps.title")) +
      "</div>" +
      '<div class="feature-tooltip__row">' +
      _escape(T("gaps.area", { area: App.i18n.n(Math.round(km2 * 100) / 100) })) +
      "</div>" +
      '<div class="feature-tooltip__row feature-tooltip__row--hint">' +
      _escape(T("gaps.clickHint")) +
      "</div>"
    );
  }

  function _escape(text) {
    return String(text == null ? "" : text).replace(
      /[&<>"']/g,
      function (character) {
        return {
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        }[character];
      },
    );
  }

  function _menu(point, feature) {
    App.ui.showContextMenu(point, [
      {
        labelKey: "gaps.adopt",
        icon: "fa-plus",
        onClick: function () {
          adopt(feature);
        },
      },
      {
        labelKey: "gaps.adoptAll",
        icon: "fa-layer-group",
        disabled: _features.length < 2,
        onClick: adoptAll,
      },
      { separator: true },
      {
        labelKey: "menu.zoom",
        icon: "fa-magnifying-glass-plus",
        onClick: function () {
          var layer = G.toLayer(feature.geometry, STYLE);
          if (layer)
            s.leafletMap.fitBounds(layer.getBounds(), {
              padding: [50, 50],
              maxZoom: 18,
            });
        },
      },
    ]);
  }

  // ══════════════════════════════════════════════════════════════════════
  // ADOPT
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Turn one uncovered piece into a territory.
   *
   * No confirmation: it is one click to make and one Ctrl+Z to take back, and
   * a prompt in front of a gesture that cheap teaches people to click through
   * prompts. The history entry is what makes that true, so it is pushed
   * before anything moves.
   */
  function adopt(feature) {
    if (!feature || !feature.geometry) return false;
    App.history.push();
    var next = App.polygons.clusterFeatures().concat([
      {
        type: "Feature",
        geometry: feature.geometry,
        properties: {},
      },
    ]);
    App.polygons.setClusters(next);
    console.log(">>> Gap adopted —", Math.round(_area(feature)), "m²");
    return true;
  }

  /**
   * Every gap at once, as one undoable step.
   *
   * The case this exists for is growing the boundary along one side and
   * finding four separate slivers between the old edge and the new one:
   * adopting them one at a time is four clicks and four history entries for
   * what was one decision.
   */
  function adoptAll() {
    if (!_features.length) return 0;
    App.history.push();
    var additions = _features.map(function (feature) {
      return {
        type: "Feature",
        geometry: feature.geometry,
        properties: {},
      };
    });
    var made = additions.length;
    App.polygons.setClusters(
      App.polygons.clusterFeatures().concat(additions),
    );
    console.log(">>> Adopted", made, "gaps");
    return made;
  }

  return {
    init: init,
    schedule: schedule,
    recompute: recompute,
    count: count,
    totalArea: totalArea,
    features: features,
    adopt: adopt,
    adoptAll: adoptAll,
    isVisible: isVisible,
    setVisible: setVisible,
    PANE: PANE,
  };
})();

window.App = App;
