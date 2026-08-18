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
    // The info panel's uncovered row is written from this count, and it is
    // written only when the panel is otherwise redrawn. Every path that
    // changes the coverage redraws the panel *before* this runs — setClusters
    // refreshes the panel synchronously and schedules this two hundred
    // milliseconds later — so without saying so here, adopting a gap left the
    // panel still counting the gap that had just become a territory.
    if (App.ui && App.ui.refreshInfo) App.ui.refreshInfo();
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

    var features = App.polygons.clusterFeatures();

    // Nothing covered at all is not a gap, it is an empty area — and
    // ensureDefaultCluster already has an opinion about that case.
    if (!features.length) return [];

    var rest = _uncovered(outer, features);
    if (!rest || !rest.geometry) return [];

    var minimum = s.GAP_MIN_M2 || 200;
    var out = [];
    G.polygonParts(rest).forEach(function (part) {
      _open(part).forEach(function (piece) {
        if (G.area(piece) >= minimum) out.push(piece);
      });
    });
    return out.sort(function (a, b) {
      return G.area(b) - G.area(a);
    });
  }

  /**
   * The boundary minus the territories.
   *
   * Two ways of asking, because the fast one can fail quietly. G.unionAll
   * folds the territories together and swallows a failure per feature —
   * `acc = union(acc, f) || acc` keeps the accumulator and drops `f`. That is
   * the right call for merging, where losing a shape is visible immediately;
   * here it means a territory silently vanishes from the covered set and the
   * ground under it is announced as uncovered. Clicking that would build a
   * second territory on top of an existing one.
   *
   * So the union is done here, counting what it could not fold in, and any
   * failure at all falls through to subtracting the territories one at a time.
   * That path cannot lose a territory — a cluster that will not subtract
   * leaves its own ground looking covered, which errs towards offering too
   * few gaps rather than towards offering a gap over somebody's territory.
   */
  function _uncovered(outer, features) {
    var union = _covered(features);

    if (union.feature && !union.failed) {
      try {
        var rest = G.difference(outer, union.feature);
        // A boundary entirely covered is the normal, healthy answer.
        if (!rest || !rest.geometry) return null;
        return rest;
      } catch (e) {
        /* fall through to the slow path */
      }
    }

    return _subtractEach(outer, features);
  }

  /**
   * The territories folded into one shape, and how many would not fold.
   *
   * @returns {{feature: Feature|null, failed: number}}
   */
  function _covered(features) {
    var covered = null;
    var failed = 0;

    // One pass over the whole collection when it works — the same answer the
    // fold below produces, for roughly a third of the time, and this is the
    // single most expensive thing the gap layer does.
    var all = [];
    for (var j = 0; j < features.length; j++) {
      var g = G.feat(features[j]);
      if (g && g.geometry) all.push(g);
    }
    if (!all.length) return { feature: null, failed: 0 };
    try {
      var once = turf.union(turf.featureCollection(all));
      if (once && once.geometry) return { feature: once, failed: 0 };
    } catch (e) {
      /* fall through to the counted fold */
    }

    for (var i = 0; i < all.length; i++) {
      var f = all[i];
      if (!covered) {
        covered = f;
        continue;
      }
      var merged = null;
      try {
        merged = G.union(covered, f);
      } catch (e) {
        merged = null;
      }
      if (merged && merged.geometry) covered = merged;
      else failed++;
    }

    return { feature: covered, failed: failed };
  }

  /** Subtract the territories one at a time; slower, and cannot lose one. */
  function _subtractEach(outer, features) {
    var rest = outer;
    for (var i = 0; i < features.length && rest && rest.geometry; i++) {
      var next = null;
      try {
        next = G.difference(rest, G.feat(features[i]));
      } catch (e) {
        next = rest; // an unusable cluster leaves its ground looking covered
      }
      rest = next;
    }
    return rest && rest.geometry ? rest : null;
  }

  /**
   * Morphological opening: shrink by half a meter, and if anything survives,
   * grow it back. What does not survive was never a gap.
   *
   * Returns a *list*, and that is the bug this signature exists to prevent.
   * It used to return one piece via G.largestPolygon, on the assumption that
   * opening a region gives back a smaller version of the same region. It does
   * not: two open areas joined by a strip narrower than a meter — a lane
   * between two territories, the pinch where a reshaped boundary nearly
   * touches a cluster — erode into two separate lobes, and keeping the larger
   * silently discarded the other. On a plain 100 m barbell with a 60 cm neck
   * that is half the uncovered ground, gone, with nothing on screen to say a
   * second area was ever found.
   *
   * @param {Feature} part
   * @returns {Feature[]} zero or more real uncovered pieces
   */
  function _open(part) {
    var eps = s.GAP_OPEN_M || 0.5;
    var core = null;
    try {
      core = turf.buffer(part, -eps, { units: "meters" });
    } catch (e) {
      core = null;
    }

    // Nothing survived. That has two very different causes and they must not
    // be treated alike: the shape was genuinely too thin to be a gap, or the
    // erosion gave up on a valid but awkward ring. turf.buffer returns
    // undefined for both, so the shape is asked directly — area over
    // perimeter is about half the width of a long strip, so a piece whose
    // ratio clears eps was at least 2·eps wide and should have survived.
    // Dropping a large obvious gap is worse than showing one a little larger
    // than it strictly is; it is only ever offered, never applied by itself.
    if (!core || !core.geometry) {
      return _thickness(part) >= eps ? [part] : [];
    }

    var lobes = G.polygonParts(core).filter(function (lobe) {
      return G.area(lobe) > 0;
    });
    if (!lobes.length) return [];

    return lobes
      .map(function (lobe) {
        var grown = null;
        try {
          grown = turf.buffer(lobe, eps, { units: "meters" });
        } catch (e) {
          grown = null;
        }
        if (!grown || !grown.geometry) return lobe;

        // Growing back must not reach into a territory, so the result is
        // clipped to the region it came from. Without this an adopted gap
        // would overlap its neighbors by half a meter.
        var clipped = null;
        try {
          clipped = G.intersect(grown, part);
        } catch (e) {
          clipped = null;
        }
        if (!clipped || !clipped.geometry) return lobe;

        // largestPolygon is safe *here* and not above: clipping one lobe back
        // to the region it came from can shave slivers off it, and those are
        // fragments of this lobe rather than uncovered areas of their own.
        return G.largestPolygon(clipped) || lobe;
      })
      .filter(function (piece) {
        return piece && piece.geometry && G.area(piece) > 0;
      });
  }

  /**
   * Roughly half the width of the piece, in meters.
   *
   * Area over perimeter: for a long strip of width w it converges on w/2, and
   * for a compact shape it is much larger. Used only to tell "this vanished
   * because it was a thread" from "the erosion could not cope with this ring".
   */
  function _thickness(feature) {
    try {
      var area = turf.area(feature);
      var perimeter = turf.length(turf.polygonToLine(feature), {
        units: "meters",
      });
      return perimeter > 0 ? area / perimeter : 0;
    } catch (e) {
      return 0;
    }
  }

  function count() {
    return _features.length;
  }

  function totalArea() {
    return _features.reduce(function (sum, feature) {
      return sum + G.area(feature);
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
    var km2 = G.area(feature) / 1e6;
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
        // Labelled by what it will actually do here rather than by the
        // mechanism: "dissolve" is one word for two outcomes, and which one
        // you get depends on where the gap sits. A menu entry that says which
        // needs no second glance.
        labelKey: _touchesOuterNow(feature)
          ? "gaps.dissolveTrim"
          : "gaps.dissolveAbsorb",
        icon: "fa-droplet",
        onClick: function () {
          dissolve(feature);
        },
      },
      {
        labelKey: "gaps.dissolveAll",
        icon: "fa-fill-drip",
        disabled: _features.length < 2,
        onClick: dissolveAll,
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

  /** Which of the two dissolves applies, for labelling the menu. */
  function _touchesOuterNow(feature) {
    if (!s.outerPolygonLayer) return false;
    try {
      return _touchesOuter(feature, G.getOuterFeature(s.outerPolygonLayer));
    } catch (e) {
      return false;
    }
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
    console.log(">>> Gap adopted —", Math.round(G.area(feature)), "m²");
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

  // ══════════════════════════════════════════════════════════════════════
  // DISSOLVE
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Make a gap disappear rather than turn it into a territory.
   *
   * Adopting is right when the ground is worth a card of its own. Most gaps
   * are not: they are the strip left by dragging a boundary outward, or the
   * hole where a territory was deleted, and what you want is for the map to
   * stop having a hole in it. Which of the two things that means depends on
   * where the gap sits:
   *
   *   • Touching the outer boundary → the boundary is wrong, not the
   *     territories. It is trimmed back to the edges of the territories
   *     around the gap, so the working area ends where the cards end.
   *   • Enclosed by territories → the territories are what is wrong, and the
   *     one it abuts most absorbs it.
   *
   * Touching the boundary wins when both are true, which is the common case
   * after growing the outline: a strip against the new edge with territories
   * along one side of it. Absorbing that would stretch one territory out to
   * an edge nobody drew it against.
   */
  function dissolve(feature) {
    if (!feature || !feature.geometry || !s.outerPolygonLayer) return false;

    App.history.push();
    if (!_dissolveOne(feature)) {
      // Nothing moved, so the entry would be a step that undoes nothing —
      // worse than no entry, because Ctrl+Z would then look broken.
      App.history.undo();
      alert(T("gaps.dissolveFailed"));
      return false;
    }
    return true;
  }

  /** dissolve() without the history entry, so the bulk path can reuse it. */
  function _dissolveOne(feature) {
    var outer;
    try {
      outer = G.getOuterFeature(s.outerPolygonLayer);
    } catch (e) {
      return false;
    }
    if (!outer || !outer.geometry) return false;
    return _touchesOuter(feature, outer)
      ? _trimOuter(feature, outer)
      : _absorb(feature);
  }

  /**
   * Whether the gap runs along the outer boundary.
   *
   * Asked of the piece grown by a whisker rather than of the piece itself:
   * opening shrank it by GAP_OPEN_M and grew it back clipped, so a gap that
   * genuinely reaches the boundary can end a few millimeters short of it.
   */
  function _touchesOuter(feature, outer) {
    var eps = s.GAP_OPEN_M || 0.5;
    try {
      var probe = turf.buffer(feature, eps * 2, { units: "meters" });
      if (!probe || !probe.geometry) return false;
      return !!turf.booleanIntersects(probe, turf.polygonToLine(outer));
    } catch (e) {
      return false;
    }
  }

  /**
   * Trim the boundary back so the gap falls outside it.
   *
   * The piece is grown first, or the half meter that opening took off would
   * be left behind as a hairline strip — dissolving a gap and watching a
   * thinner version of it stay put is exactly the failure this feature exists
   * to avoid. Growing it would reach into the territories beside it, so
   * whatever the growth covers that a territory already covers is put back
   * before the subtraction: a territory that lost half a meter would be
   * clipped by replaceOuter and would lose its printed mark for a change
   * nobody asked for.
   */
  function _trimOuter(feature, outer) {
    var eps = s.GAP_OPEN_M || 0.5;
    var cut = feature;
    try {
      var grown = turf.buffer(feature, eps * 1.5, { units: "meters" });
      if (grown && grown.geometry) {
        var covered = _covered(App.polygons.clusterFeatures()).feature;
        var trimmed = covered ? G.difference(grown, covered) : grown;
        if (trimmed && trimmed.geometry) cut = trimmed;
      }
    } catch (e) {
      /* the ungrown piece still removes the bulk of it */
    }

    var next = null;
    try {
      next = G.difference(outer, cut);
    } catch (e) {
      next = null;
    }
    if (!next || !next.geometry) return false;

    next = _keepInhabited(next);
    if (!next || !next.geometry) return false;

    if (!App.polygons.replaceOuter(next)) return false;
    console.log(
      ">>> Gap dissolved into the boundary —",
      Math.round(G.area(feature)),
      "m² trimmed off",
    );
    return true;
  }

  /**
   * Drop the parts of a trimmed boundary that hold no territory.
   *
   * Cutting a gap out of the outline can sever a corner, and a boundary in
   * two pieces where one of them is empty ground is not a smaller boundary,
   * it is a mess. The largest part is kept regardless, so a boundary with no
   * territories in it at all still survives its own trim.
   */
  function _keepInhabited(outer) {
    var parts = G.polygonParts(outer);
    if (parts.length <= 1) return outer;

    var features = App.polygons.clusterFeatures();
    var kept = parts.filter(function (part) {
      return features.some(function (cluster) {
        try {
          var hit = G.intersect(part, cluster);
          return !!(hit && hit.geometry && turf.area(hit) > 1);
        } catch (e) {
          return false;
        }
      });
    });
    if (!kept.length) return G.largestPolygon(outer);

    var merged = kept[0];
    for (var i = 1; i < kept.length; i++) {
      try {
        merged = G.union(merged, kept[i]) || merged;
      } catch (e) {
        /* keep what we have */
      }
    }
    return merged;
  }

  /**
   * Hand the gap to the territory it belongs to most.
   *
   * "Most" is the longest shared edge, measured as the area a thin collar
   * around the gap shares with each territory — a proxy, but a robust one,
   * and it is the rule every GIS calls sliver elimination. Splitting the gap
   * between its neighbors proportionally was the alternative, and it is the
   * worse answer for the shapes this actually meets: a hole where a territory
   * used to be, handed to whichever neighbor it mostly abuts, beats the same
   * hole carved into four wedges nobody drew.
   *
   * unionHealed rather than union: the piece stands half a meter clear of its
   * neighbors because opening put it there, and a plain union would leave
   * that hairline behind as a hole inside the territory.
   */
  function _absorb(feature) {
    var eps = s.GAP_OPEN_M || 0.5;
    var features = App.polygons.clusterFeatures();
    if (!features.length) return false;

    var collar = null;
    try {
      collar = turf.buffer(feature, eps * 3, { units: "meters" });
    } catch (e) {
      collar = null;
    }
    if (!collar || !collar.geometry) return false;

    var best = -1;
    var bestShare = 0;
    features.forEach(function (cluster, index) {
      var share = 0;
      try {
        var hit = G.intersect(collar, cluster);
        share = hit && hit.geometry ? turf.area(hit) : 0;
      } catch (e) {
        share = 0;
      }
      if (share > bestShare) {
        bestShare = share;
        best = index;
      }
    });
    if (best < 0) return false;

    var merged = null;
    try {
      merged = G.unionHealed([features[best], feature], eps * 1.6);
    } catch (e) {
      merged = null;
    }
    if (!merged || !merged.geometry) return false;

    var next = features.map(function (cluster, index) {
      if (index !== best) return cluster;
      var properties = Object.assign({}, cluster.properties || {});
      // The shape changed, so a card printed from it no longer matches the
      // ground — the rule trimming and cutting already follow.
      delete properties.printed;
      return {
        type: "Feature",
        geometry: merged.geometry,
        properties: properties,
      };
    });

    App.polygons.setClusters(next);
    console.log(
      ">>> Gap absorbed by territory",
      best + 1,
      "—",
      Math.round(G.area(feature)),
      "m²",
    );
    return true;
  }

  /** Every gap closed, as one undoable step. */
  function dissolveAll() {
    if (!_features.length) return 0;
    var pending = _features.slice();
    var done = 0;

    App.history.push();
    // Each one re-reads the current territories and boundary, because the one
    // before it may well have moved both.
    pending.forEach(function (feature) {
      if (_dissolveOne(feature)) done++;
    });

    if (!done) {
      App.history.undo();
      alert(T("gaps.dissolveFailed"));
      return 0;
    }
    recompute();
    console.log(">>> Dissolved", done, "gaps");
    return done;
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
    dissolve: dissolve,
    dissolveAll: dissolveAll,
    isVisible: isVisible,
    setVisible: setVisible,
    PANE: PANE,
  };
})();

window.App = App;
