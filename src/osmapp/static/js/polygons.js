/**
 * polygons.js — cluster lifecycle, hover styling, and the filtered view.
 *
 * Added in this pass:
 *   • ensureDefaultCluster() — drawing an outer polygon now yields one cluster
 *     covering the whole area, so a territory is usable without partitioning.
 *     That cluster carries properties.auto so the app can tell it apart from a
 *     deliberate one.
 *   • Hover highlighting for clusters and the outer polygon. The style is
 *     resolved from layer state (selected beats hover beats resting) so
 *     merge-mode selection survives a mouseout.
 *   • addInnerPolygon() carves out of the auto cluster rather than rejecting
 *     the draw — otherwise every hand-drawn polygon would "overlap" the
 *     whole-area cluster and be refused.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.polygons = (function () {
  "use strict";

  var s = null;
  var G = null;
  var T = null;

  var OUTER_STYLE = {
    color: "#3388ff",
    fillColor: "#3388ff",
    fillOpacity: 0.05,
    weight: 2,
  };
  var OUTER_STYLE_HOVER = {
    color: "#1d6fe0",
    fillColor: "#3388ff",
    fillOpacity: 0.08,
    weight: 4,
  };
  var CLUSTER_STYLE_DIM = {
    color: "#9b59b6",
    fillColor: "#9b59b6",
    fillOpacity: 0.15,
    weight: 2,
  };
  var CLUSTER_STYLE_HOVER = {
    color: "#7d3c98",
    fillColor: "#9b59b6",
    fillOpacity: 0.35,
    weight: 4,
  };
  var CLUSTER_STYLE_SELECTED = {
    color: "#f39c12",
    fillColor: "#f39c12",
    fillOpacity: 0.3,
    weight: 3,
  };

  /**
   * Territories whose card has already been produced.
   *
   * The first attempt at this made them *quieter* than the rest — pale fill,
   * dashed outline — on the theory that the interesting part of the map is
   * what is left. That was wrong in the way that matters: a thin dashed
   * outline around a barely-there fill is what a deleted or provisional shape
   * looks like, so marking a territory read as losing it.
   *
   * So printed territories are now the more emphatic of the two: a heavier
   * solid outline and a stronger fill, in green because that is already the
   * app's "done" color. Done is a state worth seeing, not worth hiding.
   *
   * color cannot carry it alone — a green wash and a purple one are close for
   * a red-green color blind reader and identical in a greyscale screenshot —
   * so every printed territory also carries a check, on its number chip. See
   * labels.js. Shape beats a dash pattern at this: it survives being small,
   * being overlapped, and being printed.
   */
  var CLUSTER_STYLE_PRINTED = {
    color: "#1e8449",
    fillColor: "#27ae60",
    fillOpacity: 0.28,
    weight: 3,
  };
  var CLUSTER_STYLE_PRINTED_HOVER = {
    color: "#145a32",
    fillColor: "#27ae60",
    fillOpacity: 0.42,
    weight: 4,
  };
  var STREET_STYLE = { color: "#e74c3c", weight: 4, opacity: 0.25 };
  var STREET_STYLE_HOVER = { color: "#e74c3c", weight: 4, opacity: 1 };
  var BUILDING_STYLE = {
    color: "#555555",
    fillColor: "#7f8c8d",
    fillOpacity: 0.5,
    weight: 1,
  };
  var BUILDING_STYLE_HOVER = {
    color: "#2c3e50",
    fillColor: "#34495e",
    fillOpacity: 0.75,
    weight: 2,
  };

  /**
   * Buildings the trim tool has been told to disregard.
   *
   * Red rather than merely faded: this is a decision the user made, and a
   * decision has to be distinguishable from a rendering artefact at a glance
   * across a screen with four thousand grey rectangles on it. It is also the
   * one place in the app where "excluded" is a state a building can be in, so
   * it borrows the danger color rather than inventing a fifth one.
   */
  var BUILDING_STYLE_IGNORED = {
    color: "#922b21",
    fillColor: "#e74c3c",
    fillOpacity: 0.55,
    weight: 1,
  };
  var BUILDING_STYLE_IGNORED_HOVER = {
    color: "#641e16",
    fillColor: "#c0392b",
    fillOpacity: 0.8,
    weight: 2,
  };

  /**
   * Buildings the trim tool called isolated that the user then kept anyway.
   *
   * Neither red nor grey, because it is neither: the automatic pass had an
   * opinion and the user overruled it, and both halves of that are worth
   * seeing. Without it, putting a building back makes it identical to the four
   * thousand that were never in question, and finding it again — to check the
   * decision, or to change it back — means hunting.
   */
  var BUILDING_STYLE_FLAGGED = {
    color: "#9a6a00",
    fillColor: "#f39c12",
    fillOpacity: 0.45,
    weight: 1,
  };
  var BUILDING_STYLE_FLAGGED_HOVER = {
    color: "#7e4f00",
    fillColor: "#e67e22",
    fillOpacity: 0.75,
    weight: 2,
  };

  var PANE = {
    clusters: "clustersPane",
    streets: "streetsPane",
    buildings: "buildingsPane",
  };

  function init() {
    s = App.state;
    G = App.geometry;
    T = App.i18n.t;

    // One delegated set of handlers per group, covering every street and
    // building now and in future. Binding per feature would mean thousands of
    // tooltip objects and listener closures for a panel only one of them can
    // show at a time.
    _wireFeatureGroup(
      s.streetsLayerGroup,
      _streetTooltip,
      STREET_STYLE_HOVER,
      STREET_STYLE,
    );
    _wireFeatureGroup(
      s.buildingsLayerGroup,
      _buildingTooltip,
      _buildingHoverStyle,
      _buildingStyle,
    );
    App._loaded.push("polygons");
  }

  // ── Building state ────────────────────────────────────────────────────
  //
  // A building's resting appearance stopped being a constant when the trim
  // tool arrived: it now depends on whether that tool is running and whether
  // this particular building has been excluded. The style is therefore
  // resolved per layer rather than handed to _wireFeatureGroup once, so the
  // hover handlers cannot repaint an ignored building back to grey on the way
  // out — which is exactly what a fixed rest style did.

  /** "excluded" | "flagged" | null, as far as the trim tool is concerned. */
  function buildingState(feature) {
    if (!s.trimMode || !App.trim || !feature) return null;
    if (App.trim.isIgnored(feature)) return "excluded";
    if (App.trim.isFlagged(feature)) return "flagged";
    return null;
  }

  function _buildingStyle(layer) {
    var state = buildingState(layer && layer.feature);
    if (state === "excluded") return BUILDING_STYLE_IGNORED;
    if (state === "flagged") return BUILDING_STYLE_FLAGGED;
    return BUILDING_STYLE;
  }

  function _buildingHoverStyle(layer) {
    var state = buildingState(layer && layer.feature);
    if (state === "excluded") return BUILDING_STYLE_IGNORED_HOVER;
    if (state === "flagged") return BUILDING_STYLE_FLAGGED_HOVER;
    return BUILDING_STYLE_HOVER;
  }

  /** Repaint every rendered building. Called when the trim selection changes. */
  function restyleBuildings() {
    if (!s.buildingsLayerGroup) return;
    (function walk(parent) {
      parent.eachLayer(function (layer) {
        if (layer.eachLayer) walk(layer);
        if (layer.setStyle && layer.feature) layer.setStyle(_buildingStyle(layer));
      });
    })(s.buildingsLayerGroup);
  }

  // ══════════════════════════════════════════════════════════════════════
  // STYLE RESOLUTION
  // ══════════════════════════════════════════════════════════════════════

  /** Selected beats hover beats resting, so hovering a selection is stable. */
  function _styleFor(layer) {
    if (layer._selected) return CLUSTER_STYLE_SELECTED;
    if (layer._printed) {
      return layer._hover ? CLUSTER_STYLE_PRINTED_HOVER : CLUSTER_STYLE_PRINTED;
    }
    return layer._hover ? CLUSTER_STYLE_HOVER : CLUSTER_STYLE_DIM;
  }

  function refreshStyle(layer) {
    if (layer && layer.setStyle) layer.setStyle(_styleFor(layer));
  }

  function selectCluster(layer, selected) {
    layer._selected = !!selected;
    refreshStyle(layer);
    // The number chip is a second handle on the same territory, so it has to
    // show the same state — a selected shape with an unselected number on it
    // reads as two different things.
    if (App.labels) App.labels.setSelected(layer, layer._selected);
  }

  // ══════════════════════════════════════════════════════════════════════
  // CLUSTER STORE
  // ══════════════════════════════════════════════════════════════════════

  function clusterFeatures() {
    return s.clusters.map(function (c) {
      return c.feature;
    });
  }

  function clusterLayers() {
    return s.clusters.map(function (c) {
      return c.layer;
    });
  }

  function findCluster(layer) {
    for (var i = 0; i < s.clusters.length; i++)
      if (s.clusters[i].layer === layer)
        return { index: i, entry: s.clusters[i] };
    return null;
  }

  function isAuto(feature) {
    return !!(feature && feature.properties && feature.properties.auto);
  }

  // ══════════════════════════════════════════════════════════════════════
  // PRINT STATE
  // ══════════════════════════════════════════════════════════════════════
  //
  // A territory carries properties.printed — the ISO timestamp of the card
  // that was last produced from it, or nothing at all.
  //
  // A timestamp rather than a boolean because the question people actually
  // ask is "did I do this one *this* round?", and because it costs the same.
  // It lives in properties, which means it rides along with everything that
  // already moves a territory around: setClusters copies properties through,
  // buildPayload spreads them into the export, and the session store is that
  // same payload. Nothing new had to learn about it.
  //
  // PAYLOAD_VERSION is deliberately *not* bumped. The field is optional in
  // both directions — an old export simply has no marks, and an old build
  // reading a new export ignores a property it does not know. Bumping would
  // throw away every saved session on the planet to add a field nobody's
  // existing data was missing.
  //
  // Cutting and merging drop the mark, and that is correct rather than
  // incidental: editing.js builds the resulting pieces with `properties: {}`,
  // so a territory whose shape changed no longer claims a card that no longer
  // matches it. Territories a cut passed through untouched keep theirs,
  // because the same feature object is carried forward.

  /** @returns {string|null} ISO timestamp of the last card, or null. */
  function printedAt(feature) {
    var props = feature && feature.properties;
    var value = props && props.printed;
    return typeof value === "string" && value ? value : null;
  }

  function isPrinted(feature) {
    return printedAt(feature) !== null;
  }

  function printedCount() {
    return s.clusters.filter(function (entry) {
      return isPrinted(entry.feature);
    }).length;
  }

  /**
   * Flag or unflag one territory and repaint it.
   *
   * @param {Object} feature the cluster feature, not the layer — print.js
   *   holds one of these across an async composition and has no layer.
   * @param {boolean} printed
   * @param {{at?: string}} [opts] override the timestamp, for an import that
   *   is replaying somebody else's marks.
   * @returns {boolean} whether anything changed
   */
  function markPrinted(feature, printed, opts) {
    var entry = null;
    for (var i = 0; i < s.clusters.length; i++) {
      if (s.clusters[i].feature === feature) {
        entry = s.clusters[i];
        break;
      }
    }
    // Not a failure worth shouting about: the territory may have been cut,
    // merged or deleted while a PDF was being composed.
    if (!entry) return false;

    var next = printed ? (opts && opts.at) || new Date().toISOString() : null;
    if (printedAt(entry.feature) === next) return false;

    entry.feature.properties = entry.feature.properties || {};
    if (next) entry.feature.properties.printed = next;
    else delete entry.feature.properties.printed;

    // Cached on the layer so _styleFor stays O(1) — it runs on every hover.
    entry.layer._printed = !!next;
    refreshStyle(entry.layer);
    // Rebuilds this territory's chips in green, with the check on them.
    if (App.labels) App.labels.refresh();
    _syncPrintedCount();

    if (App.session) App.session.markDirty();
    if (App.controls) App.controls.refresh();
    return true;
  }

  /** Wipe every mark — the start of a new round of the territory. */
  function clearPrinted() {
    var cleared = 0;
    s.clusters.forEach(function (entry) {
      if (!isPrinted(entry.feature)) return;
      delete entry.feature.properties.printed;
      entry.layer._printed = false;
      refreshStyle(entry.layer);
      cleared++;
    });
    if (cleared === 0) return 0;

    if (App.labels) App.labels.refresh();
    _syncPrintedCount();
    if (App.session) App.session.markDirty();
    if (App.controls) App.controls.refresh();
    return cleared;
  }

  function _syncPrintedCount() {
    if (App.ui && App.ui.setPrintedCount) App.ui.setPrintedCount(printedCount());
  }

  // ── Where the check went ──────────────────────────────────────────────
  //
  // There used to be a second marker here: a green check in a circle, dropped
  // at each printed territory's interior point, existing purely as a
  // non-color channel — a green wash and a purple one are the same wash to a
  // red-green color blind reader and identical in a greyscale screenshot.
  //
  // The number chip is now that channel. It is already anchored at the same
  // interior point, already rebuilt on every mark and unmark, and it already
  // turns green; giving it the check costs one glyph and removes a whole
  // second marker that had to be created, anchored, tracked on the entry,
  // torn down in three places and kept from stacking on top of the number
  // sitting in the same spot. See labels.js.
  //
  // The tiny-territory case makes the merge worth more than the code it
  // saves: a speck's chip is red rather than green, so on the one territory
  // where color was already spoken for, the check is the only thing saying
  // "done".

  /**
   * Replace every cluster. Accepts GeoJSON Features or bare geometries.
   * @param {Array} features
   * @param {{silent?: boolean}} [opts] silent skips the filtered-data refresh
   * @returns {number} how many clusters ended up on the map
   */
  function setClusters(features, opts) {
    s.innerPolygonsLayerGroup.clearLayers();
    s.clusters = [];
    s.selectedClusters = [];

    (features || []).forEach(function (input) {
      var geometry = input && (input.geometry || (input.type ? input : null));
      if (!geometry || !geometry.type) return;

      var feature = {
        type: "Feature",
        geometry: geometry,
        properties: (input && input.properties) || {},
      };
      var layer = G.toLayer(feature.geometry, CLUSTER_STYLE_DIM, {
        pane: PANE.clusters,
      });
      if (!layer) return;

      layer._printed = isPrinted(feature);

      s.innerPolygonsLayerGroup.addLayer(layer);
      attachClusterEvents(layer, feature);
      // `counts` (plural) is filled in later by refreshFilteredData.
      var entry = { feature: feature, layer: layer };
      s.clusters.push(entry);
      // After addLayer: a path has no rendered element to restyle before it
      // is on the map, so a style applied earlier would be dropped.
      if (layer._printed) refreshStyle(layer);
    });

    // Before refreshFilteredData: that repaints the info panel, and the info
    // panel asks labels.js whether any of the territories it is about to
    // count are too small or too scattered to find.
    if (App.labels) App.labels.refresh();

    if (!opts || !opts.silent) refreshFilteredData();
    if (App.session) App.session.markDirty();
    // Cut and merge only mean something once there are territories, and this
    // is the single choke point every cluster change goes through.
    if (App.controls) App.controls.refresh();
    return s.clusters.length;
  }

  /**
   * Give the outer polygon a cluster of its own when nothing else exists, so a
   * freshly drawn territory is immediately printable and exportable without
   * running the partitioner.
   */
  function ensureDefaultCluster() {
    if (s.clusters.length > 0 || !s.outerPolygonLayer) return false;
    var outer;
    try {
      outer = G.getOuterFeature(s.outerPolygonLayer);
    } catch (e) {
      console.warn(">>> Cannot create the default cluster:", e.message);
      return false;
    }
    setClusters([
      { type: "Feature", geometry: outer.geometry, properties: { auto: true } },
    ]);
    console.log(">>> Whole area set as a single cluster");
    return true;
  }

  /**
   * Append a hand-drawn polygon.
   *
   * Deliberate clusters may not overlap. The auto whole-area cluster is a
   * placeholder rather than a decision, so a new polygon is carved out of it
   * instead of being rejected.
   */
  function addInnerPolygon(layer, geojson) {
    var candidate = G.feat(geojson.geometry || geojson);

    if (s.outerPolygonLayer) {
      try {
        var clipped = G.intersect(
          candidate,
          G.getOuterFeature(s.outerPolygonLayer),
        );
        if (clipped && clipped.geometry) candidate = clipped;
      } catch (e) {
        /* keep the unclipped shape */
      }
    }

    for (var i = 0; i < s.clusters.length; i++) {
      if (isAuto(s.clusters[i].feature)) continue;
      try {
        var overlap = G.intersect(candidate, s.clusters[i].feature);
        if (overlap && turf.area(overlap) > 1) {
          if (s.leafletMap.hasLayer(layer)) s.leafletMap.removeLayer(layer);
          alert(T("alert.overlap"));
          return false;
        }
      } catch (e) {
        console.warn(">>> Overlap test failed for cluster", i, e.message);
      }
    }

    var next = [];
    s.clusters.forEach(function (entry) {
      if (!isAuto(entry.feature)) {
        next.push(entry.feature);
        return;
      }
      var remainder = null;
      try {
        remainder = G.difference(entry.feature, candidate);
      } catch (e) {
        remainder = null;
      }
      // Not `> 1`: a square metre of leftover became a full territory —
      // counted in the info panel, printable as a card, and invisible at any
      // zoom anyone works at. Below the floor the scrap belongs to nobody,
      // which is the honest outcome for a scrap.
      if (
        remainder &&
        remainder.geometry &&
        turf.area(remainder) >= (s.MIN_REMAINDER_M2 || 1)
      ) {
        next.push({
          type: "Feature",
          geometry: remainder.geometry,
          properties: { auto: true },
        });
      }
    });
    next.push({
      type: "Feature",
      geometry: candidate.geometry,
      properties: {},
    });

    // setClusters rebuilds layers from geometry, so the drawn one is surplus.
    if (s.leafletMap.hasLayer(layer)) s.leafletMap.removeLayer(layer);

    if (App.history) App.history.push();
    setClusters(next);
    return true;
  }

  function deleteCluster(layer) {
    var hit = findCluster(layer);
    if (!hit) return false;
    if (App.history) App.history.push();
    if (layer.disableEdit) layer.disableEdit();
    s.innerPolygonsLayerGroup.removeLayer(layer);
    s.clusters.splice(hit.index, 1);
    // Every territory after this one is renumbered, so the chips are rebuilt
    // rather than patched.
    if (App.labels) App.labels.refresh();
    refreshFilteredData();
    // The one cluster mutation that does not go through setClusters().
    if (App.controls) App.controls.refresh();
    return true;
  }

  // ══════════════════════════════════════════════════════════════════════
  // EVENTS
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Tooltip presentation depends on what the pointer is currently for.
   *
   *   full     — resting state. Sticky, so it tracks the cursor and reads like
   *              a label for whatever is under it.
   *   anchored — merge mode. Same content, but pinned above the shape instead
   *              of following the pointer, so it never sits on top of the
   *              territory being clicked.
   *   off      — cut mode. The pointer is a drawing instrument there; a panel
   *              chasing it hides the street being snapped to.
   */
  var TOOLTIP_MODES = {
    full: {
      sticky: true,
      direction: "top",
      className: "cluster-tooltip",
      opacity: 0.95,
    },
    anchored: {
      sticky: false,
      direction: "top",
      className: "cluster-tooltip cluster-tooltip--anchored",
      opacity: 0.95,
    },
    off: null,
    // Trim mode. Territory tooltips would be noise — the territories are not
    // what is being decided — but the building ones are the decision: which
    // building this is, whether it has an address, whether it is a house or a
    // shed. Excluding a building you cannot identify is guessing, and "off"
    // made every one of these calls a guess.
    features: null,
  };

  var _tooltipMode = "full";

  /**
   * Rebind every cluster tooltip in a new presentation. Rebinding rather than
   * opening and closing on each hover avoids the flicker of a tooltip that
   * appears and is dismissed in the same frame.
   * @param {"full"|"anchored"|"off"} mode
   */
  function setTooltipMode(mode) {
    if (!(mode in TOOLTIP_MODES) || mode === _tooltipMode) return;
    _tooltipMode = mode;
    if (!_featureInfoAllowed()) _closeFeatureTooltips();
    clusterLayers().forEach(function (layer) {
      _bindTooltip(layer);
    });
    // Chips carry the same tooltip and, in cut mode, stop taking the pointer
    // altogether — a clickable number sitting on the map is one more thing
    // for the knife to catch on.
    if (App.labels) App.labels.refresh();
  }

  /**
   * @param {L.Layer} target what the pointer touches
   * @param {L.Layer} [source] the cluster layer the text describes, when the
   *   two are not the same thing — a number chip is a target that stands for
   *   a territory it is not.
   */
  function _bindTooltip(target, source) {
    source = source || target;
    target.closeTooltip();
    target.unbindTooltip();
    var opts = TOOLTIP_MODES[_tooltipMode];
    if (opts)
      target.bindTooltip(function () {
        return _tooltipContent(source);
      }, opts);
  }

  /**
   * Drop any hover highlight still standing. Entering a pointer tool suppresses
   * mouseover, so without this the shape under the cursor at that moment would
   * stay lit for as long as the tool is active.
   */
  function clearHover() {
    _closeFeatureTooltips();
    clusterLayers().forEach(function (layer) {
      if (!layer._hover) return;
      layer._hover = false;
      refreshStyle(layer);
    });
    if (s.outerPolygonLayer && s.outerPolygonLayer.setStyle) {
      s.outerPolygonLayer.setStyle(OUTER_STYLE);
    }
  }

  /**
   * Tooltip body, resolved when the tooltip opens rather than when the layer is
   * created — counts are filled in by refreshFilteredData(), which runs after
   * setClusters() has already built the layers.
   */
  function _tooltipContent(layer) {
    var found = findCluster(layer);
    if (!found) return "";
    var entry = found.entry;

    var lines = [
      "<strong>" + T("tooltip.territory", { n: found.index + 1 }) + "</strong>",
    ];

    if (entry.counts) {
      lines.push(T("tooltip.buildings", { count: App.i18n.n(entry.counts.buildings) }));
      lines.push(T("tooltip.streets", { count: App.i18n.n(entry.counts.streets) }));
    } else {
      lines.push(T("tooltip.noData"));
    }

    var area = 0;
    try {
      area = turf.area(entry.feature);
    } catch (e) {
      /* unmeasurable geometry */
    }
    if (area > 0) {
      lines.push(
        area >= 1e6
          ? T("tooltip.areaKm", { value: App.i18n.n(Math.round(area / 1e4) / 100) })
          : T("tooltip.areaM", { value: App.i18n.n(Math.round(area)) }),
      );
    }

    // Last, and only when true. The color already says "printed"; this says
    // when, which is the part that decides whether it counts for this round.
    var stamp = printedAt(entry.feature);
    if (stamp) lines.push(T("tooltip.printed", { date: _formatDate(stamp) }));

    return lines.join("<br>");
  }

  /** Locale-formatted day, falling back to the raw ISO date if unparseable. */
  function _formatDate(iso) {
    var date = new Date(iso);
    if (isNaN(date.getTime())) return String(iso).slice(0, 10);
    try {
      return date.toLocaleDateString(App.i18n.current(), {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    } catch (e) {
      return date.toISOString().slice(0, 10);
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // STREET AND BUILDING INFO
  // ══════════════════════════════════════════════════════════════════════

  var FEATURE_TOOLTIP = {
    sticky: true,
    direction: "top",
    className: "feature-tooltip",
    opacity: 0.95,
    offset: [0, -4],
  };

  /**
   * OSM tag values are arbitrary text from arbitrary contributors and go into
   * a tooltip via innerHTML, so every one of them is escaped. The cluster
   * tooltip above gets away without this only because everything in it is
   * either a translated string or a number this app computed.
   */
  var _ESCAPES = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };

  function _esc(value) {
    return String(value).replace(/[&<>"']/g, function (c) {
      return _ESCAPES[c];
    });
  }

  /**
   * One property as trimmed text, or null when it carries nothing.
   *
   * The normalization itself lives in App.util.tagText, because naming.js has
   * to make exactly the same three judgements about exactly the same values —
   * and two copies of "is this tag empty?" that disagree would put a locality
   * on a card that the tooltip beside it says is unaddressed.
   */
  function _prop(feature, key) {
    return App.util.tagOf(feature, key);
  }

  /** OSM's yes/no tags, where the value may also be a subtype like "viaduct". */
  function _flag(feature, key) {
    var value = _prop(feature, key);
    if (!value) return false;
    var lower = value.toLowerCase();
    return lower !== "no" && lower !== "false";
  }

  function _buildingTooltip(layer) {
    return buildingInfo(layer && layer.feature);
  }

  /**
   * The building panel, by feature rather than by layer.
   *
   * Public because the trim tool puts the same text on its marks: a mark sits
   * on top of the building it stands for and swallows the hover, so without
   * this, marking a building would take away the only way to find out what it
   * was.
   */
  function buildingInfo(f) {
    if (!f) return "";

    var name = _prop(f, "name");
    // addr:place stands in for addr:street where houses are numbered against
    // the settlement rather than a street, which is common in rural Poland.
    var street = _prop(f, "addr:street") || _prop(f, "addr:place");
    var number = _prop(f, "addr:housenumber");
    var unit = _prop(f, "addr:unit");
    var kind = _prop(f, "building");
    var kindLabel = kind && kind !== "yes" ? App.i18n.tag("building", kind) : null;

    var address = [street, number].filter(Boolean).join(" ");
    if (address && unit) address += "/" + unit;
    var locality = [_prop(f, "addr:postcode"), _prop(f, "addr:city") || _prop(f, "addr:suburb")]
      .filter(Boolean)
      .join(" ");

    var title = name || address || kindLabel || T("feature.building");
    var lines = ["<strong>" + _esc(title) + "</strong>"];

    if (address && title !== address) lines.push(_esc(address));
    if (locality) lines.push(_esc(locality));
    // Which buildings OSM has no address for is itself worth knowing when the
    // point of the exercise is a card someone has to walk from.
    if (!address && !locality)
      lines.push("<em>" + _esc(T("feature.noAddress")) + "</em>");
    if (kindLabel && title !== kindLabel) lines.push(_esc(kindLabel));

    var levels = _prop(f, "building:levels");
    if (levels) lines.push(_esc(T("feature.levels", { n: levels })));

    // Last, and only while trimming: what the tool currently intends to do
    // with this building, and how to change its mind.
    var state = buildingState(f);
    if (state === "excluded")
      lines.push("<em>" + _esc(T("trim.excludedNote")) + "</em>");
    else if (state === "flagged")
      lines.push("<em>" + _esc(T("trim.flaggedNote")) + "</em>");

    return lines.join("<br>");
  }

  function _streetTooltip(layer) {
    var f = layer.feature;
    if (!f) return "";

    var name = _prop(f, "name");
    var kind = _prop(f, "highway");
    var lines = [
      "<strong>" + _esc(name || T("feature.unnamedStreet")) + "</strong>",
    ];
    if (kind) lines.push(_esc(App.i18n.tag("highway", kind)));

    // The compact facts read better on one line than as four short ones.
    var facts = [];
    var length = parseFloat(_prop(f, "length"));
    if (isFinite(length) && length > 0)
      facts.push(T("feature.length", { n: App.i18n.n(Math.round(length)) }));
    var lanes = _prop(f, "lanes");
    if (lanes) facts.push(T("feature.lanes", { n: lanes }));
    var speed = _prop(f, "maxspeed");
    // maxspeed is free text: "50", "30 mph", "DE:urban". Only bare numbers get
    // a unit appended; anything else is shown as tagged.
    if (speed) facts.push(/^\d+$/.test(speed) ? T("feature.speed", { n: speed }) : speed);
    if (facts.length) lines.push(_esc(facts.join(" · ")));

    var ref = _prop(f, "ref");
    if (ref) lines.push(_esc(T("feature.ref", { ref: ref })));

    var surface = _prop(f, "surface");
    if (surface) lines.push(_esc(App.i18n.tag("surface", surface)));

    var traits = [];
    if (_flag(f, "oneway")) traits.push(T("feature.oneway"));
    if (_flag(f, "bridge")) traits.push(T("feature.bridge"));
    if (_flag(f, "tunnel")) traits.push(T("feature.tunnel"));
    if (traits.length) lines.push(_esc(traits.join(" · ")));

    return lines.join("<br>");
  }

  /**
   * Hover highlight, lazily bound tooltip, and pointer-event forwarding for
   * one of the feature groups.
   *
   * The forwarding is the subtle part. Streets and buildings paint above the
   * territories, so a right-click on a building never reached the territory
   * underneath and the context menu did not open — the browser's did. Now the
   * event is re-fired on whichever territory contains that point, so clicking
   * a building behaves exactly like clicking the territory around it.
   */
  function _wireFeatureGroup(group, contentFn, hoverStyle, restStyle) {
    /** A style may be a constant or a function of the layer it paints. */
    function styleFor(style, layer) {
      return typeof style === "function" ? style(layer) : style;
    }

    group.on("mouseover", function (e) {
      var layer = e.layer;
      if (!layer || !layer.setStyle) return;
      layer.setStyle(styleFor(hoverStyle, layer));
      if (!_featureInfoAllowed()) return;
      if (!layer._infoBound) {
        layer.bindTooltip(contentFn, FEATURE_TOOLTIP);
        layer._infoBound = true;
      }
      // bindTooltip's own mouseover handler is registered too late to catch
      // the event currently being dispatched, so the first open is manual.
      layer.openTooltip(e.latlng);
    });

    group.on("mouseout", function (e) {
      var layer = e.layer;
      if (!layer || !layer.setStyle) return;
      layer.setStyle(styleFor(restStyle, layer));
      if (layer._infoBound) layer.closeTooltip();
    });

    group.on("click contextmenu", function (e) {
      // While trimming, a building is the subject rather than a way through to
      // the territory under it: clicking one excludes it. Forwarding as well
      // would open a context menu on top of the selection being made.
      if (s.trimMode) {
        if (group === s.buildingsLayerGroup && e.type === "click" && App.trim)
          App.trim.handleBuildingClick(e.layer, e);
        return;
      }
      var found = clusterAt(e.latlng);
      if (!found) return;
      found.entry.layer.fire(e.type, e, true);
    });
  }

  /** Territory containing a point, bbox-rejected first. */
  function clusterAt(latlng) {
    var point = [latlng.lng, latlng.lat];
    for (var i = 0; i < s.clusters.length; i++) {
      var entry = s.clusters[i];
      try {
        var box = entry._bbox || (entry._bbox = turf.bbox(entry.feature));
        if (
          point[0] < box[0] ||
          point[0] > box[2] ||
          point[1] < box[1] ||
          point[1] > box[3]
        )
          continue;
        if (turf.booleanPointInPolygon(turf.point(point), entry.feature))
          return { index: i, entry: entry };
      } catch (e) {
        /* unusable geometry; try the next territory */
      }
    }
    return null;
  }

  /**
   * Feature tooltips follow the cluster tooltip mode. In cut mode the pointer
   * is a drawing instrument and a panel chasing it would cover the street
   * being snapped to; in merge mode the extra detail is noise.
   */
  function _featureInfoAllowed() {
    return (_tooltipMode === "full" || _tooltipMode === "features") && !s.editMode;
  }

  function _closeFeatureTooltips() {
    [s.streetsLayerGroup, s.buildingsLayerGroup].forEach(function (group) {
      if (!group) return;
      (function walk(parent) {
        parent.eachLayer(function (layer) {
          if (layer.eachLayer) walk(layer);
          if (layer._infoBound) {
            layer.closeTooltip();
            if (layer.setStyle)
              layer.setStyle(
                group === s.streetsLayerGroup
                  ? STREET_STYLE
                  : _buildingStyle(layer),
              );
          }
        });
      })(group);
    });
  }

  /**
   * Everything a territory does when you point at it, bound to `target` but
   * acting on `layer`.
   *
   * The two are the same object for the polygon itself. They differ for the
   * number chip, which is a small, always-findable handle on a shape that may
   * be a couple of pixels wide — the case the chips exist for in the first
   * place. Splitting target from layer rather than copying these four
   * handlers into labels.js is the point: two implementations of "click a
   * territory" would drift, and the one on the chip would be the one nobody
   * remembered to update.
   *
   * @param {Function} [onHover] told when the highlight goes on and off, so a
   *   proxy can light itself up alongside the shape it stands for.
   */
  function _bindClusterBehavior(target, layer, feature, onHover) {
    // Remove exactly what this function bound last time, by reference.
    //
    // `off("mouseover mouseout click contextmenu")` with no handler is a
    // blanket removal: it takes every listener for those types off the layer,
    // and bindTooltip's own mouseover/mouseout are listeners for those types.
    // Which meant this was silently order-dependent — bind the tooltip first
    // and it was wiped a line later, with no error and no clue. An event map
    // keyed on the handlers we actually own cannot do that to anything else,
    // whichever order the two binders are called in.
    if (target._clusterHandlers) target.off(target._clusterHandlers);

    function hover(on) {
      layer._hover = on;
      refreshStyle(layer);
      if (onHover) onHover(on);
    }

    var handlers = {
      mouseover: function () {
        // In cut mode the cursor is drawing, not pointing. Highlighting would
        // also bringToFront() the cluster over the dashed preview line.
        if (s.editMode) return;
        hover(true);
        if (layer.bringToFront) layer.bringToFront();
      },

      mouseout: function () {
        if (!layer._hover) return;
        hover(false);
      },

      click: function (e) {
        if (s.mergeMode) {
          L.DomEvent.stopPropagation(e);
          App.editing.handleClusterSelectClick(layer, feature);
          return;
        }
        // In draw mode let the event through so Leaflet.Editable's vertex
        // handles and the draw tool's map click both still work.
        if (s.editMode) return;

        L.DomEvent.stopPropagation(e);
        App.ui.closeContextMenu();
        s.leafletMap.fitBounds(layer.getBounds(), {
          padding: [50, 50],
          maxZoom: 18,
        });
      },

      contextmenu: function (e) {
        L.DomEvent.stopPropagation(e);
        if (s.editMode || s.mergeMode) return;
        App.ui.showPolygonContextMenu(e.containerPoint, layer, feature);
      },
    };

    target._clusterHandlers = handlers;
    target.on(handlers);
  }

  function attachClusterEvents(layer, feature) {
    _bindTooltip(layer);
    _bindClusterBehavior(layer, layer, feature);
  }

  /**
   * Make something that is not the territory behave like it — same tooltip,
   * same hover, same click, same context menu. Used by labels.js for the
   * number chips.
   */
  function attachProxyEvents(proxy, layer, feature, onHover) {
    _bindTooltip(proxy, layer);
    _bindClusterBehavior(proxy, layer, feature, onHover);
  }

  function attachOuterEvents(layer) {
    layer.off("mouseover mouseout");
    layer.on("mouseover", function () {
      if (s.editMode) return;
      layer.setStyle(OUTER_STYLE_HOVER);
    });
    layer.on("mouseout", function () {
      layer.setStyle(OUTER_STYLE);
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // FILTERED VIEW
  // ══════════════════════════════════════════════════════════════════════

  function refreshFilteredData() {
    if (!s.cachedStreets || !s.cachedBuildings) return;

    if (s.clusters.length === 0) {
      renderStreets(s.cachedStreets.features);
      renderBuildings(s.cachedBuildings.features);
      App.ui.setInfoLoaded(
        s.cachedStreets.features.length,
        s.cachedBuildings.features.length,
      );
      return;
    }

    var feats = clusterFeatures();
    var boxes = feats.map(function (f) {
      return turf.bbox(f);
    });
    var counts = feats.map(function () {
      return { streets: 0, buildings: 0 };
    });

    // ── Streets: bbox reject, then a real intersection test ──────────────
    var filteredStreets = [];
    s.cachedStreets.features.forEach(function (f) {
      if (!f.geometry) return;
      var fb;
      try {
        fb = turf.bbox(f);
      } catch (e) {
        return;
      }
      var hit = false;
      for (var i = 0; i < feats.length; i++) {
        if (!G.bboxOverlap(fb, boxes[i])) continue;
        var inside = false;
        try {
          inside = turf.booleanIntersects(G.feat(f.geometry), feats[i]);
        } catch (e) {
          inside = G.anyCoordInPolygons(f, [feats[i]]);
        }
        if (!inside) continue;
        counts[i].streets++;
        hit = true;
        // Deliberately no early exit. Territory boundaries follow streets, so
        // a boundary street genuinely belongs to both neighbors and someone
        // walking it expects to see it in either. The rendered list still gets
        // it once; only the per-territory counts overlap.
      }
      if (hit) filteredStreets.push(f);
    });

    // ── Buildings: one centroid per building, cached on the feature ──────
    var filteredBuildings = [];
    s.cachedBuildings.features.forEach(function (f) {
      if (!f.geometry) return;
      var centroid = f._centroid;
      if (!centroid) {
        try {
          centroid = f._centroid = turf.centroid(G.feat(f.geometry));
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
            filteredBuildings.push(f);
            counts[i].buildings++;
            return;
          }
        } catch (e) {
          /* fall through to the next cluster */
        }
      }
    });

    s.clusters.forEach(function (entry, i) {
      entry.counts = counts[i];
    });

    renderStreets(filteredStreets);
    renderBuildings(filteredBuildings);
    App.ui.setInfoFiltered(
      filteredStreets.length,
      filteredBuildings.length,
      s.clusters.length,
      printedCount(),
    );
  }

  function renderStreets(features) {
    s.streetsLayerGroup.clearLayers();
    if (!features || features.length === 0) return;
    L.geoJSON(
      { type: "FeatureCollection", features: features },
      { style: STREET_STYLE, pane: PANE.streets },
    ).addTo(s.streetsLayerGroup);
  }

  function renderBuildings(features) {
    s.buildingsLayerGroup.clearLayers();
    if (!features || features.length === 0) return;
    L.geoJSON(
      { type: "FeatureCollection", features: features },
      { style: BUILDING_STYLE, pane: PANE.buildings },
    ).addTo(s.buildingsLayerGroup);
  }

  return {
    init: init,

    clusterFeatures: clusterFeatures,
    clusterLayers: clusterLayers,
    findCluster: findCluster,
    isAuto: isAuto,
    printedAt: printedAt,
    isPrinted: isPrinted,
    printedCount: printedCount,
    markPrinted: markPrinted,
    clearPrinted: clearPrinted,
    setClusters: setClusters,
    ensureDefaultCluster: ensureDefaultCluster,
    addInnerPolygon: addInnerPolygon,
    deleteCluster: deleteCluster,

    attachClusterEvents: attachClusterEvents,
    attachProxyEvents: attachProxyEvents,
    attachOuterEvents: attachOuterEvents,
    setTooltipMode: setTooltipMode,
    clearHover: clearHover,
    clusterAt: clusterAt,
    selectCluster: selectCluster,
    refreshStyle: refreshStyle,
    refreshFilteredData: refreshFilteredData,
    renderStreets: renderStreets,
    renderBuildings: renderBuildings,
    restyleBuildings: restyleBuildings,
    buildingInfo: buildingInfo,
    buildingState: buildingState,

    OUTER_STYLE: OUTER_STYLE,
    CLUSTER_STYLE_DIM: CLUSTER_STYLE_DIM,
    CLUSTER_STYLE_HOVER: CLUSTER_STYLE_HOVER,
    CLUSTER_STYLE_SELECTED: CLUSTER_STYLE_SELECTED,
    CLUSTER_STYLE_PRINTED: CLUSTER_STYLE_PRINTED,
    CLUSTER_STYLE_PRINTED_HOVER: CLUSTER_STYLE_PRINTED_HOVER,
    STREET_STYLE: STREET_STYLE,
    BUILDING_STYLE: BUILDING_STYLE,
    BUILDING_STYLE_IGNORED: BUILDING_STYLE_IGNORED,
    BUILDING_STYLE_FLAGGED: BUILDING_STYLE_FLAGGED,
    PANE: PANE,
  };
})();

window.App = App;
