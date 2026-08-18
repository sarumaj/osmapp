/**
 * trim.js — shrink the outer boundary onto the buildings that matter.
 *
 * ── The problem ────────────────────────────────────────────────────────────
 *
 * A boundary is drawn by hand or adopted from Nominatim, and both are far
 * larger than the thing being partitioned. An administrative outline includes
 * the fields, the forest, the gravel pit and the four farms on the far side of
 * the river; a hand-drawn one includes whatever was convenient to trace. The
 * partitioner then divides all of it, so a territory that is nine-tenths
 * meadow gets the same slice of the k-means budget as a street of terraced
 * houses, and somebody eventually walks out to a card with two addresses on it.
 *
 * Trimming before partitioning is the fix, and it is the one step of the
 * workflow that was missing. What the boundary should actually enclose is
 * "everywhere within walking reach of a building we care about" — which is a
 * shape nobody wants to trace by hand.
 *
 * ── How the shape is found ─────────────────────────────────────────────────
 *
 *   1. Buildings the user has marked as ignored are dropped, and so is
 *      anything already outside the boundary.
 *   2. Every remaining building stamps a disc of radius `reach` into a raster
 *      (coverage.js). The marked cells are the union of those discs without
 *      ever computing a union: a few thousand turf.buffer + turf.union calls
 *      would take tens of seconds, and this runs on every drag of the slider.
 *   3. The raster's connected components are the settlements. The one holding
 *      the most buildings seeds the shape, and any other group of kept
 *      buildings is joined to it by a corridor stamped along the streets that
 *      lead there — the outer boundary is a single polygon everywhere else in
 *      the app, and quietly returning a MultiPolygon would lose parts.
 *
 *      Joining rather than dropping is the rule that makes the tool
 *      predictable: what you keep, you keep. Dropping was the older behavior
 *      and it meant un-excluding an outlying building did nothing visible —
 *      the count went up and the boundary did not move. It is also honest
 *      about the ground: a territory that includes the farm at the end of the
 *      lane includes the lane, because that is what the person walking it
 *      does. Excluding the sparse edges is therefore a decision, which is why
 *      the outlier pass now runs the moment the tool opens.
 *
 *      A corridor goes straight, and is only routed around the working
 *      boundary when a straight line would leave it — which is checked over
 *      the whole segment, since a concave boundary can cut through the middle
 *      of a line whose ends are both comfortably inside. The way round is
 *      found on the grid and then pulled straight, so it comes back as a
 *      couple of legs rather than as a staircase. And it is a wedge: full
 *      width where it leaves the settlement, tapering to a tip at the building
 *      it reaches, because a constant-width strip meeting a settlement at
 *      right angles reads as plumbing.
 *   3a. Holes are closed. An empty field ringed by houses, a courtyard the
 *      reach did not quite reach, a sliver left by the street snapping: none
 *      of them is a place to tell somebody to skip, and on a printed card
 *      there is no way to tell an intentional exclusion from an artefact. A
 *      hole in the *working* boundary is different — the user chose that one —
 *      so the result is re-clipped when the outer polygon has any.
 *   4. Its boundary ring is traced, collapsed, and straightened by the amount
 *      the edge-detail slider asks for. A boundary that hugs every bay between
 *      two houses is accurate and unusable: somebody holding the card has to
 *      be able to tell which side of the line they are standing on.
 *   5. If "follow streets" is on, each ring vertex is pulled onto the nearest
 *      street center-line within `snap` meters, and consecutive vertices that
 *      both landed on the network are joined by the actual street between them
 *      (App.network). That is what turns a staircase around the backs of the
 *      houses into an edge that runs along a road.
 *   6. The result is clipped to the existing boundary. Trimming only ever
 *      removes area — a tool that can also grow the working area is a
 *      different tool, and a surprising one.
 *
 * ── Why the moves in step 5 are safe ───────────────────────────────────────
 *
 * The raster contains the whole disc of radius `reach` around every kept
 * building, so every kept building is at least `reach` from the ring. Snapping
 * moves a vertex by at most `snap`, and a routed replacement is rejected
 * unless it stays within `slack` of the ring, and both are configured below
 * `reach`. So the boundary can be dragged onto the street network without any
 * risk of it walking over a house.
 *
 * Straightening moves the edge inward by up to its own tolerance, so the detail
 * slider is capped at `reach` minus a held-back clearance rather than left
 * free. That coupling is worth seeing rather than hiding: asking for a wider
 * berth around the houses is exactly what buys the room to draw a simpler line
 * around them.
 *
 * That is the argument, not the guarantee. The guarantee is that the tool
 * counts: the status line says how many buildings the proposed shape actually
 * contains, measured on the shape itself, and the confirmation repeats it.
 * Nothing is applied on the strength of the reasoning above.
 *
 * ── Taking it over ─────────────────────────────────────────────────────────
 *
 * Everything above works from what the buildings are, and the answer is
 * usually right. "Usually" is the problem: the one corner that should follow
 * the ditch rather than the hedge is not a thing any of these settings can
 * express. So the proposal can be adjusted by hand — Leaflet.Editable, already
 * in the app for drawing the boundary in the first place, puts a handle on
 * every corner. While that is on, the sliders and the selection are locked,
 * because a recompute would silently throw the adjustment away and the honest
 * way to prevent that is to make it impossible rather than to warn about it.
 *
 * ── Seeing the selection ───────────────────────────────────────────────────
 *
 * Excluded buildings are painted red, which says nothing at all at the zoom
 * where you want to check what a shift-drag just did — a house is two pixels
 * across there. So each one also carries a mark measured in pixels, the same
 * size at every zoom, and clicking a mark puts that one building back. Being
 * able to see a mistake is not much use without being able to undo exactly it.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.trim = (function () {
  "use strict";

  var s = null;
  var G = null;
  var SP = null;
  var C = null;
  var N = null;
  var D = null;
  var T = null;

  var PANE = "trimPane";

  /** What the boundary would become. */
  var PREVIEW_STYLE = {
    color: "#16a085",
    weight: 3,
    dashArray: "8 4",
    fillColor: "#1abc9c",
    fillOpacity: 0.06,
    interactive: false,
    pane: PANE,
  };

  /** What it would give up. Shown because the area lost is the whole point. */
  var LOST_STYLE = {
    color: "#c0392b",
    weight: 1,
    fillColor: "#e74c3c",
    fillOpacity: 0.14,
    interactive: false,
    pane: PANE,
  };

  /**
   * The proposal while it is being adjusted by hand.
   *
   * Solid and interactive, unlike the dashed preview: the difference between
   * "here is what I worked out" and "this is yours to move now" has to be
   * visible before the first vertex is dragged, or the handles look like
   * decoration.
   */
  var EDIT_STYLE = {
    color: "#0e6655",
    weight: 3,
    fillColor: "#1abc9c",
    fillOpacity: 0.12,
    pane: PANE,
  };

  var BOX_STYLE = {
    color: "#16a085",
    weight: 1,
    dashArray: "4 3",
    fillColor: "#1abc9c",
    fillOpacity: 0.1,
    interactive: false,
    pane: PANE,
  };

  var _pool = null; // [{ feature, key, centroid, big }] — candidates
  var _byFeature = null; // feature → key, so painting a building is not a scan
  // ── Who decided what ──────────────────────────────────────────────────
  //
  // The selection used to be one set of excluded keys, written to by both the
  // automatic pass and the user. That was fine while the pass ran once, and
  // it is not fine now that two sliders re-run it: re-running would either
  // wipe every decision made by hand or pile the new answer on top of the old
  // one, and neither is what moving a slider means.
  //
  // So the two are kept apart. `_auto` is the pass's current answer and is
  // replaced wholesale whenever it runs; `_manual` holds only the buildings
  // somebody has said something about, true for exclude and false for keep.
  // `_ignored` is derived from both and never written to directly.
  var _auto = null; // Set of keys the current pass names
  var _manual = null; // Map key → true (exclude) / false (keep)
  var _ignored = null; // derived: (_auto ∪ manual-excluded) ∖ manual-kept
  var _scaleCache = null; // { entries, median, unit, groups, home } per pool
  var _result = null; // last computed proposal
  var _toolbar = null;
  var _hint = null;
  var _preview = null;
  var _lost = null;
  var _markerLayer = null;
  var _editLayer = null; // the proposal as a draggable polygon
  var _boxLayer = null;
  var _drag = null; // { start, mode } while a rectangle is being dragged
  var _timer = null;
  var _busy = false;
  // A recompute is scheduled or running. See _schedule.
  var _pending = false;

  function init() {
    s = App.state;
    G = App.geometry;
    SP = App.spatial;
    C = App.coverage;
    N = App.network;
    D = App.dom;
    T = App.i18n.t;
    App._loaded.push("trim");
  }

  function isActive() {
    return !!s.trimMode;
  }

  // ══════════════════════════════════════════════════════════════════════
  // MODE
  // ══════════════════════════════════════════════════════════════════════

  function toggle() {
    var next = !s.trimMode;

    if (next) {
      if (!s.outerPolygonLayer) {
        alert(T("alert.drawAndLoadFirst"));
        return;
      }
      if (!s.cachedBuildings || !s.cachedBuildings.features.length) {
        alert(T("trim.noBuildings"));
        return;
      }
      if (s.editMode) App.editing.toggleEditMode();
      if (s.mergeMode) App.editing.toggleMergeMode();
      if (s.outlineMode) App.outline.toggle();
    }

    s.trimMode = next;
    App.controls.setActive("trim", next);

    if (next) _start();
    else _stop();
  }

  function _start() {
    _auto = new Set();
    _manual = new Map();
    _ignored = new Set();
    _ignoreUndo = [];
    _ignoreRedo = [];
    _result = null;
    _scaleCache = null;
    _pool = _buildPool();

    App.shortcuts.push(TRIM_KEYS);
    App.history.pushScope(TRIM_SCOPE);

    N.build();

    // The pointer is a selection instrument now: a tooltip chasing it covers
    // the building being clicked, and a territory highlight lifts a purple
    // wash over the buildings that are the subject of the exercise.
    // "features", not "off": territory tooltips are noise here, but the
    // building ones are the decision being made. See polygons.js.
    App.polygons.setTooltipMode("features");
    App.gaps.schedule(0);
    App.polygons.clearHover();
    App.polygons.restyleBuildings();

    _markerLayer = L.layerGroup().addTo(s.leafletMap);
    // Marks are drawn for the current view only, so the view changing is the
    // event that decides which ones exist.
    s.leafletMap.on("moveend", _renderMarkers);

    _hint = D.mountOnMap("tpl-draw-hint", s.leafletMap);
    _hint.setAttribute("data-i18n", "trim.hint");
    _hint.textContent = T("trim.hint");

    // Run before the toolbar exists so the first status line already reports
    // the proposal people actually want to see. Trimming nothing on arrival
    // asks the user to discover the one button that makes the tool do its job;
    // starting from the suggestion and letting them put buildings back is the
    // same decision with the work already done.
    markOutliers();

    _showToolbar();
    _bindBoxSelect();
    L.DomUtil.addClass(s.leafletMap.getContainer(), "is-trimming");
    _schedule(0);
  }

  function _stop() {
    if (s.leafletMap)
      L.DomUtil.removeClass(s.leafletMap.getContainer(), "is-trimming");
    setEdit(false, { silent: true });
    _unbindBoxSelect();
    s.leafletMap.off("moveend", _renderMarkers);
    if (_markerLayer) {
      s.leafletMap.removeLayer(_markerLayer);
      _markerLayer = null;
    }
    _clearPreview();
    _hint = D.remove(_hint);
    _hideToolbar();
    clearTimeout(_timer);
    _timer = null;
    _auto = new Set();
    _manual = new Map();
    _ignored = new Set();
    _ignoreUndo = [];
    _ignoreRedo = [];
    _pool = null;
    _byFeature = null;
    _scaleCache = null;
    _result = null;
    // A held eraser whose mode has closed underneath it would get its release
    // after the layer it was erasing had already been thrown away.
    App.shortcuts.releaseAll();
    App.shortcuts.pop("trim");
    App.history.popScope("trim");
    App.ui.closeContextMenu();
    App.polygons.restyleBuildings();
    App.polygons.setTooltipMode(s.mergeMode ? "anchored" : "full");
    App.gaps.schedule(0);
  }

  // ══════════════════════════════════════════════════════════════════════
  // SELECTION
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Buildings that can be trimmed away: everything downloaded that currently
   * sits inside the boundary, keyed and with a centroid cached.
   *
   * Keyed on the OSM id where there is one. Object identity would do for a
   * single session, but a key survives the filtered view being rebuilt, which
   * is what happens the moment a territory changes underneath the tool.
   */
  function _buildPool() {
    var pool = [];
    _byFeature = new Map();
    var outer = null;
    try {
      outer = G.getOuterFeature(s.outerPolygonLayer);
    } catch (e) {
      return pool;
    }
    var box = turf.bbox(outer);

    (s.cachedBuildings.features || []).forEach(function (feature, index) {
      if (!feature.geometry) return;
      var centroid;
      try {
        centroid = feature._centroid || (feature._centroid = turf.centroid(G.feat(feature.geometry)));
      } catch (e) {
        return;
      }
      var c = centroid.geometry.coordinates;
      if (c[0] < box[0] || c[0] > box[2] || c[1] < box[1] || c[1] > box[3]) return;
      try {
        if (!turf.booleanPointInPolygon(centroid, outer)) return;
      } catch (e) {
        return;
      }

      var id = feature.properties && feature.properties.osmid;
      var key = id == null ? "ix:" + index : "osm:" + id;
      _byFeature.set(feature, key);
      pool.push({
        feature: feature,
        key: key,
        centroid: c,
        // Only buildings bigger than a raster cell need their footprint
        // stamped as well as their center; for a terraced house the center
        // disc already covers the whole thing.
        big: _isBig(feature),
      });
    });
    return pool;
  }

  function _isBig(feature) {
    try {
      var b = turf.bbox(G.feat(feature.geometry));
      var span = Math.max(
        (b[2] - b[0]) * SP.lngScale((b[1] + b[3]) / 2),
        (b[3] - b[1]) * SP.M_PER_DEG_LAT,
      );
      return span > (s.TRIM_CELL_M || 10) * 2;
    } catch (e) {
      return false;
    }
  }

  /**
   * A building's key, in constant time.
   *
   * This was a linear scan over the pool, and it is asked once per building
   * by restyleBuildings() — which is called on every click, every box drag
   * and every slider recompute. On a town with four thousand buildings that
   * is sixteen million comparisons per interaction, which is the difference
   * between a selection gesture that feels immediate and one that stutters.
   */
  function _keyOf(feature) {
    if (!feature || !_byFeature) return null;
    var key = _byFeature.get(feature);
    return key === undefined ? null : key;
  }

  /** Read by polygons.js when it paints a building. */
  function isIgnored(feature) {
    if (!s.trimMode || !_ignored) return false;
    var key = _keyOf(feature);
    return key !== null && _ignored.has(key);
  }

  /**
   * Named by the pass and kept anyway — the amber ring.
   *
   * Derived rather than remembered. A set that only ever grew was right while
   * the pass ran once; with the sliders live it would leave a mark on
   * buildings the current settings no longer name, which is a mark that
   * points at a decision nothing on screen is making any more.
   */
  function isFlagged(feature) {
    if (!s.trimMode || !_auto) return false;
    var key = _keyOf(feature);
    return key !== null && _auto.has(key) && !_ignored.has(key);
  }

  /** How many the pass names and the user has overruled. */
  function flaggedCount() {
    if (!_auto) return 0;
    var count = 0;
    _auto.forEach(function (key) {
      if (!_ignored.has(key)) count++;
    });
    return count;
  }

  // ── The derived set ───────────────────────────────────────────────────

  /**
   * Rebuild `_ignored` from the pass and the decisions taken by hand.
   *
   * Everything that changes either input ends here, and nothing anywhere
   * writes to `_ignored` itself — which is what makes "a slider moves the
   * machine's answer, a click moves yours" true rather than merely intended.
   */
  function _applySelection() {
    _ignored = new Set();
    if (_auto) _auto.forEach(function (key) {
      _ignored.add(key);
    });
    if (_manual)
      _manual.forEach(function (excluded, key) {
        if (excluded) _ignored.add(key);
        else _ignored.delete(key);
      });
    _selectionChanged();
  }

  function ignoredCount() {
    return _ignored ? _ignored.size : 0;
  }

  /**
   * Everything that changes the selection ends here.
   *
   * Three things have to move together — the building fills, the markers over
   * them and the proposal — and before this existed each caller remembered two
   * of the three. The one it forgot was always the markers, because a stale
   * marker looks exactly like a marker.
   */
  function _selectionChanged() {
    App.polygons.restyleBuildings();
    _renderMarkers();
    _schedule();
  }

  /**
   * Flip one building, from wherever the request came from — the shape, its
   * marker, or the context menu. Three call sites had the same four lines
   * written out; recording an undo snapshot would have made it three places
   * to remember to do it.
   */
  function _toggleIgnored(key) {
    if (s.trimEdit || key === null || key === undefined || !_ignored) return;
    pushIgnore();
    _manual.set(key, !_ignored.has(key));
    _applySelection();
  }

  /** Clicking a building in trim mode toggles it. */
  function handleBuildingClick(layer) {
    // While the shape is being adjusted by hand the selection is frozen: a
    // recompute would throw the adjustment away, and a click that silently
    // does nothing is better explained by the locked controls beside it.
    if (s.trimEdit) return;
    if (!layer || !layer.feature) return;
    _toggleIgnored(_keyOf(layer.feature));
  }

  function _setRange(bounds, ignore) {
    var changed = 0;
    var recorded = false;
    _pool.forEach(function (entry) {
      var c = entry.centroid;
      if (!bounds.contains(L.latLng(c[1], c[0]))) return;
      if (ignore ? _ignored.has(entry.key) : !_ignored.has(entry.key)) return;
      // One snapshot for the whole drag, taken lazily so a box that catches
      // nothing does not put an empty step on the undo stack.
      if (!recorded) {
        pushIgnore();
        recorded = true;
      }
      _manual.set(entry.key, ignore);
      changed++;
    });
    if (changed) _applySelection();
    return changed;
  }

  /**
   * Nothing excluded at all — including by the pass.
   *
   * Emptying the manual overrides alone would leave the automatic answer
   * standing, so the button that says Clear would clear the part nobody
   * asked about and leave the part it proposed. Moving either outlier slider
   * runs the pass again, which is the way back.
   */
  function clearSelection() {
    if (!_ignored || _ignored.size === 0) return;
    pushIgnore();
    _auto = new Set();
    _manual = new Map();
    _applySelection();
  }

  // ── Markers ───────────────────────────────────────────────────────────
  //
  // A red fill on the building itself says "excluded" perfectly well at zoom
  // 18 and not at all at zoom 13, where a house is two pixels across and the
  // decision you are checking is invisible. So every excluded building also
  // gets a marker, and a marker is measured in pixels: it is the same size at
  // every zoom, which is the whole point of having one.
  //
  // They are markers rather than a second styled polygon layer because they
  // also have to be clickable at that zoom. Clicking one puts the building
  // back, which is the missing half of a selection gesture — being able to see
  // a mistake is not much use without being able to undo exactly it.

  var _icons = {};

  function _icon(kind) {
    if (!_icons[kind]) {
      _icons[kind] = L.divIcon({
        className: "trim-marker trim-marker--" + kind,
        html:
          '<span aria-hidden="true">' +
          (kind === "excluded" ? "\u2715" : "\u25CB") +
          "</span>",
        iconSize: [16, 16],
        iconAnchor: [8, 8],
      });
    }
    return _icons[kind];
  }

  /**
   * Redraw the marks.
   *
   * Two kinds, and the second is the one that makes the first usable. A red
   * cross is a building being excluded; an amber ring is one the outlier pass
   * named and the user kept anyway. Both are clickable and both toggle, so the
   * mark is not a report on a past decision but the handle for changing it.
   *
   * Only what is on screen, and never more than a budget of them: excluding a
   * whole quarter of a town is one shift-drag, and four thousand live markers
   * is a map that no longer pans. Off-screen marks cost nothing to leave out
   * because nobody can see them, and this runs again on every move.
   */
  function _renderMarkers() {
    if (!_markerLayer || !s.trimMode || !_pool) return;
    _markerLayer.clearLayers();

    var bounds = s.leafletMap.getBounds().pad(0.25);
    var budget = s.TRIM_MARKER_MAX || 800;
    var shown = 0;

    for (var i = 0; i < _pool.length && shown < budget; i++) {
      var entry = _pool[i];
      var kind = _ignored.has(entry.key)
        ? "excluded"
        : _auto.has(entry.key)
          ? "flagged"
          : null;
      if (!kind) continue;
      var at = L.latLng(entry.centroid[1], entry.centroid[0]);
      if (!bounds.contains(at)) continue;
      shown++;
      _markerLayer.addLayer(_marker(at, kind, entry));
    }
  }

  function _marker(at, kind, entry) {
    var marker = L.marker(at, {
      icon: _icon(kind),
      pane: PANE,
      keyboard: false,
    });

    // A mark sits on top of the building it stands for and swallows the hover,
    // so it carries the building's own panel — otherwise marking a building
    // would take away the only way to find out what it was, which is exactly
    // the information the decision needs.
    marker.bindTooltip(
      function () {
        return App.polygons.buildingInfo(entry.feature);
      },
      {
        direction: "top",
        offset: [0, -8],
        className: "feature-tooltip",
        opacity: 0.95,
      },
    );

    marker.on("click", function (e) {
      // Otherwise the map sees the click too and the building underneath
      // toggles straight back.
      L.DomEvent.stopPropagation(e);
      _toggleIgnored(entry.key);
    });

    marker.on("contextmenu", function (e) {
      L.DomEvent.stopPropagation(e);
      _showTrimMenu(e.containerPoint, entry.key);
    });
    return marker;
  }

  /**
   * Mark the buildings that are isolated *for this place*.
   *
   * A single farm at the end of a track drags the boundary out to meet it, and
   * finding those by eye on a map of four thousand buildings is the tedious
   * half of the job. This runs by default when the tool opens: since a kept
   * building is now always enclosed, something has to propose the exclusions,
   * and arriving at the answer people want beats asking them to find the one
   * button that produces it.
   *
   * Two rules have been wrong here before, and both were wrong in the same
   * direction — they answered a question about one building when the thing
   * being decided is about a place.
   *
   * The first counted neighbors inside a fixed radius: "fewer than three
   * within 60 m" describes an ordinary house in a village where the plots are
   * 80 m apart, so on exactly the rural areas these cards are printed for it
   * marked almost everything. It also excluded buildings as it went and let
   * later ones see the thinned-out result, so marks cascaded and pressing the
   * button twice marked a larger set than pressing it once.
   *
   * The second measured every building against the median spacing for the
   * area, which fixed both of those and still could not see a hamlet: four
   * houses sitting together two kilometers out are not isolated from each
   * other, so none of them ever qualified and the boundary went on reaching
   * for them.
   *
   * So the buildings are grouped first and the groups are judged. See
   * outliersIn below; the short version is that a place is an outlier when it
   * is both small and far, both measured against the area's own spacing, and
   * that every building in such a place goes together.
   */
  function markOutliers(opts) {
    if (!_pool || !_ignored) return 0;
    var next = new Set();
    outliersIn(_pool).forEach(function (entry) {
      next.add(entry.key);
    });

    // Re-asserting the pass over the decisions taken by hand is what the
    // button means and what a slider must never do. A slider that dropped
    // every keep-this-one on every drag would be a control that punishes
    // being touched twice; a button that left them in place would be a
    // button that visibly does nothing once you have overruled it.
    if (opts && opts.reassert) {
      var stale = [];
      _manual.forEach(function (excluded, key) {
        if (!excluded && next.has(key)) stale.push(key);
      });
      if (stale.length) pushIgnore();
      stale.forEach(function (key) {
        _manual.delete(key);
      });
    }

    _auto = next;
    _applySelection();
    return _auto.size;
  }

  /**
   * Which of `entries` are unusually isolated.
   *
   * Judged by group, not by building — which is the fix for the thing this
   * rule kept getting wrong. Measuring each building's distance to its k-th
   * nearest neighbor asks "is this house on its own?", and four houses sitting
   * together two kilometers from anywhere answer *no*: they have each other.
   * So a lone farm was found and a hamlet never was, however far out it sat,
   * and the boundary went on reaching for it.
   *
   * The question the tool actually needs answered is "is this *place* on its
   * own?". So the buildings are first clustered by single linkage — anything
   * within a short hop of anything else is the same place — and then each
   * place is measured against the main one. A place that is small and far is
   * an outlier, and every building in it goes together, because half a hamlet
   * is not a thing anybody wants a boundary drawn around.
   *
   * Both halves of "small and far" stay relative to the area. Far is still
   * several times the median plot spacing, the same as before. Small is a
   * share of everything downloaded, with a floor — a genuine second village
   * of fifty houses is not an accident to be swept up automatically, and it
   * is a decision somebody should make by dragging a box.
   *
   * Pure, and takes the whole set rather than the un-excluded remainder, which
   * is what makes pressing the button twice a no-op.
   *
   * ── The two numbers that are now sliders ──────────────────────────────
   *
   * `factor` and `groupMax` arrive as arguments with the live settings as
   * their default, rather than being read from state here. That keeps this
   * function a function — the tests ask it about made-up villages at settings
   * no toolbar is showing — and it is also what lets the toolbar re-run it on
   * every drag without a mode having to be open.
   *
   * Neither is a distance or a count that means anything on its own, which is
   * the whole reason they can be offered at all: `factor` multiplies the
   * area's own median plot spacing and `groupMax` is compared against a floor
   * that scales with how much was downloaded. Somebody sliding them is
   * sliding "how far out is far" and "how small is a hamlet", and both
   * answers keep meaning the same thing in a terrace and in farmland.
   *
   * @param {Array} entries objects carrying a `centroid`
   * @param {{factor?: number, groupMax?: number}} [opts]
   * @returns {Array} the subset to exclude, in input order
   */
  function outliersIn(entries, opts) {
    if (!entries || entries.length < 3) return [];
    opts = opts || {};

    var factor = opts.factor;
    if (factor == null) factor = s.trimOutlierFactor;
    if (factor == null) factor = s.TRIM_OUTLIER_FACTOR || 3;

    var scale = _scaleOf(entries);
    if (!scale.groups || scale.groups.length < 2) {
      console.log(">>> Outliers: one settlement, nothing to exclude");
      return [];
    }

    var groups = scale.groups;
    var home = scale.home;
    var threshold = scale.unit * factor;

    var groupMax = opts.groupMax;
    if (groupMax == null) groupMax = s.trimOutlierGroupMax;
    if (groupMax == null) groupMax = s.TRIM_OUTLIER_GROUP_MAX || 8;

    // Exactly what the slider says, and nothing else.
    //
    // This used to be lifted to a share of everything downloaded, so that
    // "at most eight buildings" would not be silly in a town of four
    // thousand. The intent was right and the effect was the bug people
    // actually hit: in a city the ceiling worked out at two hundred, so a
    // whole block on the far side of a park was small enough to sweep away —
    // and the readout beside the slider went on saying eight. A control that
    // reports one number and applies another is worse than a blunt one, and
    // the slider reaches sixty now for the towns that need it.
    var maxSize = groupMax;
    var reach = Math.max(threshold * 4, 2000);
    var homeGrid = new SP.Grid(120);
    home.forEach(function (index) {
      homeGrid.addPoint(entries[index].centroid, index);
    });

    var marked = Object.create(null);
    var places = 0;
    groups.forEach(function (group) {
      if (group === home) return;
      if (group.length > maxSize) return;
      if (_gapTo(entries, group, homeGrid, reach) <= threshold) return;
      places++;
      group.forEach(function (index) {
        marked[index] = true;
      });
    });

    var out = entries.filter(function (entry, index) {
      return marked[index];
    });
    console.log(
      ">>> Outliers: spacing",
      Math.round(scale.median),
      "m, main settlement",
      Math.round(_spanOf(entries, home)),
      "m across, unit",
      Math.round(scale.unit),
      "m, threshold",
      Math.round(threshold),
      "m,",
      groups.length,
      "places,",
      out.length,
      "buildings in",
      places,
      "of them",
    );
    return out;
  }

  /**
   * The measurements every judgement here is made against, worked out once.
   *
   * ── Why there is a unit at all ────────────────────────────────────────
   *
   * "Far" was the median plot spacing times the slider, with an absolute
   * floor of 120 m underneath it. That is right in a village and wrong in a
   * city, in a way that produced exactly the complaint this replaces: plots
   * in a city sit maybe fifteen meters apart, so the floor decided the
   * question, and *any* group more than 120 m from the main mass was called
   * isolated. A block on the far side of a park, a terrace across a river, an
   * estate behind a industrial strip — all of them are 150 to 300 m from
   * their nearest neighbor and all of them are plainly still in the city.
   * The slider could not rescue it either: ten times fifteen meters is still
   * only 150.
   *
   * The missing term is how big the place is. A gap of 200 m means something
   * quite different in a settlement 800 m across than in one 8 km across, and
   * the main settlement is right there to be measured. So the unit is the
   * largest of three things — the plot spacing, a floor, and a share of the
   * main settlement's own extent — and the slider multiplies it. A village is
   * unaffected, because its extent term comes out below the floor and the
   * arithmetic reduces to what it was before. A city gets a unit several
   * times larger, which is what stops it eating its own suburbs.
   *
   * ── Why it is cached ──────────────────────────────────────────────────
   *
   * None of it depends on the sliders: the linkage distance comes from the
   * median spacing, and the groups come from the linkage. So a drag re-runs
   * the two cheap comparisons per group and nothing else, instead of
   * re-clustering four thousand buildings on every frame. Keyed on the array
   * identity, which is what the pool is — and what a test's made-up village
   * is too.
   */
  function _scaleOf(entries) {
    if (_scaleCache && _scaleCache.entries === entries) return _scaleCache;

    var k = Math.max(1, s.TRIM_OUTLIER_NEIGHBORS || 3);
    var median = _median(_neighborDistances(entries, k));

    // Short enough that two settlements a few hundred meters apart stay two
    // settlements, long enough that a street with a gap in it stays one.
    var link = Math.max(
      median * (s.TRIM_OUTLIER_LINK_FACTOR || 1.5),
      (s.TRIM_OUTLIER_MIN_M || 120) / 2,
    );

    var groups = _groupsWithin(entries, link);
    var home = groups.length ? groups[0] : [];
    for (var i = 1; i < groups.length; i++)
      if (groups[i].length > home.length) home = groups[i];

    // The floor is divided by the default factor so that the default setting
    // reproduces the old number exactly: unit × 3 is 120 m in an area with
    // nothing else to go on, which is where it has always been.
    var base = Math.max(1, s.TRIM_OUTLIER_FACTOR || 3);
    var unit = Math.max(
      median,
      (s.TRIM_OUTLIER_MIN_M || 120) / base,
      _spanOf(entries, home) * (s.TRIM_OUTLIER_SPAN_SHARE || 0.025),
    );

    _scaleCache = {
      entries: entries,
      median: median,
      unit: unit,
      groups: groups,
      home: home,
    };
    return _scaleCache;
  }

  /**
   * How big the main settlement is, corner to corner, in meters.
   *
   * The diagonal of its bounding box rather than anything cleverer: what is
   * being asked is only "village, town or city", and a measure that needs the
   * shape to be convex or the density to be uniform would answer that same
   * question with more ways to be wrong.
   */
  function _spanOf(entries, group) {
    if (!group || group.length < 2) return 0;
    var minLng = Infinity;
    var maxLng = -Infinity;
    var minLat = Infinity;
    var maxLat = -Infinity;
    group.forEach(function (index) {
      var c = entries[index].centroid;
      if (c[0] < minLng) minLng = c[0];
      if (c[0] > maxLng) maxLng = c[0];
      if (c[1] < minLat) minLat = c[1];
      if (c[1] > maxLat) maxLat = c[1];
    });
    var width = (maxLng - minLng) * SP.lngScale((minLat + maxLat) / 2);
    var height = (maxLat - minLat) * SP.M_PER_DEG_LAT;
    return Math.sqrt(width * width + height * height);
  }

  /**
   * Single-linkage groups: indices into `entries`, one array per place.
   *
   * Union-find over the pairs the grid says are close enough, rather than a
   * distance matrix — the point of clustering thousands of buildings on every
   * press of a button is that it has to cost about as much as not doing it.
   */
  function _groupsWithin(entries, distance) {
    var parent = new Array(entries.length);
    for (var i = 0; i < entries.length; i++) parent[i] = i;

    function find(x) {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]]; // halve the path on the way up
        x = parent[x];
      }
      return x;
    }

    function union(a, b) {
      var ra = find(a);
      var rb = find(b);
      if (ra !== rb) parent[rb] = ra;
    }

    var grid = new SP.Grid(Math.max(60, distance));
    entries.forEach(function (entry, index) {
      grid.addPoint(entry.centroid, index);
    });
    var ring = Math.max(
      1,
      Math.ceil(distance / (grid.cell * SP.M_PER_DEG_LAT)),
    );

    entries.forEach(function (entry, index) {
      var candidates = grid.candidates(entry.centroid, ring);
      for (var c = 0; c < candidates.length; c++) {
        var other = grid.items[candidates[c]].payload;
        if (other <= index) continue;
        if (SP.dist(entry.centroid, entries[other].centroid) <= distance)
          union(index, other);
      }
    });

    var byRoot = Object.create(null);
    var groups = [];
    entries.forEach(function (entry, index) {
      var root = find(index);
      var group = byRoot[root];
      if (!group) groups.push((byRoot[root] = group = []));
      group.push(index);
    });
    return groups;
  }

  /** Closest any member of `group` comes to the main settlement, in meters. */
  function _gapTo(entries, group, homeGrid, reach) {
    var best = Infinity;
    for (var i = 0; i < group.length; i++) {
      var hit = homeGrid.nearestPoint(entries[group[i]].centroid, reach);
      if (hit && hit.dist < best) best = hit.dist;
    }
    return best;
  }

  /**
   * Distance from each building to its k-th nearest neighbor, in input order.
   *
   * Widening ring by ring rather than guessing a radius: the whole point is
   * that no single radius is right for both a terrace and a hamlet. Infinity
   * for a building with fewer than k neighbors anywhere, which is as isolated
   * as it gets.
   */
  function _neighborDistances(entries, k) {
    var grid = new SP.Grid(120);
    entries.forEach(function (entry, index) {
      grid.addPoint(entry.centroid, index);
    });

    var maxRing = 12; // ~1.4 km out; past that the answer is "isolated"
    return entries.map(function (entry) {
      var found = [];
      for (var ring = 0; ring <= maxRing; ring++) {
        var candidates = grid.shell(entry.centroid, ring);
        for (var i = 0; i < candidates.length; i++) {
          var other = entries[grid.items[candidates[i]].payload];
          if (other === entry) continue;
          found.push(SP.dist(entry.centroid, other.centroid));
        }
        // One ring past having enough: a hit in the current shell can still be
        // beaten from the corner of the next one.
        if (found.length >= k && ring > 0) {
          found.sort(function (a, b) {
            return a - b;
          });
          return found[k - 1];
        }
      }
      found.sort(function (a, b) {
        return a - b;
      });
      return found.length >= k ? found[k - 1] : Infinity;
    });
  }

  /**
   * What one notch of the isolation slider is worth here, in meters.
   *
   * The slider is a multiplier, and a multiplier with nothing to multiply is
   * a number nobody can act on: "3×" says nothing about whether the farm at
   * the end of the track is going to be caught. So the readout carries the
   * distance it works out to, and it is the same number the pass uses rather
   * than a second calculation that can drift from it.
   *
   * @param {Array} [entries] defaults to the pool, so the toolbar can ask
   *   without knowing what the pool is and a test can ask without one.
   */
  function isolationUnit(entries) {
    var pool = entries || _pool;
    if (!pool || pool.length < 3) return 0;
    return _scaleOf(pool).unit;
  }

  function _median(values) {
    var finite = values.filter(function (value) {
      return isFinite(value);
    });
    if (!finite.length) return 0;
    finite.sort(function (a, b) {
      return a - b;
    });
    var mid = Math.floor(finite.length / 2);
    return finite.length % 2 ? finite[mid] : (finite[mid - 1] + finite[mid]) / 2;
  }

  // ── Rectangle select ──────────────────────────────────────────────────
  //
  // Clicking four hundred buildings one at a time is not a workflow. Shift
  // drags a box that ignores everything inside it; Alt drags one that puts
  // them back. Both suspend map dragging for the duration, because a gesture
  // that pans the map and selects at the same time does neither well.

  function _bindBoxSelect() {
    var container = s.leafletMap.getContainer();
    L.DomEvent.on(container, "mousedown", _onBoxDown);
  }

  function _unbindBoxSelect() {
    _endBox();
    if (!s.leafletMap) return;
    L.DomEvent.off(s.leafletMap.getContainer(), "mousedown", _onBoxDown);
  }

  function _onBoxDown(e) {
    if (e.button !== 0 || s.trimEdit) return;
    var ignore = e.shiftKey;
    var restore = e.altKey;
    if (!ignore && !restore) return;

    L.DomEvent.preventDefault(e);
    _drag = { start: s.leafletMap.mouseEventToLatLng(e), ignore: ignore };
    s.leafletMap.dragging.disable();
    L.DomEvent.on(document, "mousemove", _onBoxMove);
    L.DomEvent.on(document, "mouseup", _onBoxUp);
  }

  function _onBoxMove(e) {
    if (!_drag) return;
    var bounds = L.latLngBounds(_drag.start, s.leafletMap.mouseEventToLatLng(e));
    if (!_boxLayer) _boxLayer = L.rectangle(bounds, BOX_STYLE).addTo(s.leafletMap);
    else _boxLayer.setBounds(bounds);
  }

  function _onBoxUp(e) {
    if (!_drag) return;
    var bounds = L.latLngBounds(_drag.start, s.leafletMap.mouseEventToLatLng(e));
    var ignore = _drag.ignore;
    _endBox();
    // A click that never moved is a click, and the building under it has
    // already been toggled by the layer's own handler.
    if (bounds.getNorth() - bounds.getSouth() > 1e-7) _setRange(bounds, ignore);
  }

  function _endBox() {
    if (_boxLayer) {
      s.leafletMap.removeLayer(_boxLayer);
      _boxLayer = null;
    }
    if (!_drag) return;
    _drag = null;
    try {
      s.leafletMap.dragging.enable();
    } catch (e) {
      /* the map may already be gone */
    }
    L.DomEvent.off(document, "mousemove", _onBoxMove);
    L.DomEvent.off(document, "mouseup", _onBoxUp);
  }

  // ══════════════════════════════════════════════════════════════════════
  // SHAPE
  // ══════════════════════════════════════════════════════════════════════

  /** The live proposal, read out of the map and the current selection. */
  function compute() {
    var outer;
    try {
      outer = G.getOuterFeature(s.outerPolygonLayer);
    } catch (e) {
      return { error: "failed" };
    }
    if (!_ignored) _ignored = new Set();
    if (!_pool) _pool = _buildPool();

    var keep = [];
    var dropped = [];
    _pool.forEach(function (entry) {
      (_ignored.has(entry.key) ? dropped : keep).push(entry);
    });

    return propose({
      outer: outer,
      keep: keep,
      ignored: dropped,
      reach: s.trimReachM || s.TRIM_REACH_M,
      detail: detailM(),
      corridor: s.TRIM_CORRIDOR_M,
      follow: !!s.trimFollow,
    });
  }

  /**
   * How far the traced edge may be straightened, in meters.
   *
   * Capped against the reach rather than free, and that cap is the same
   * clearance argument as everything else here: the raster puts every kept
   * building at least `reach` from the ring, simplification moves the ring by
   * at most its tolerance, so a tolerance of `reach - clearance` still leaves
   * `clearance` meters of ground between the boundary and the nearest wall.
   *
   * Which also makes the two sliders read as one idea rather than two: asking
   * for a wider berth around the houses is what buys you the room to draw a
   * simpler line around them.
   */
  function detailM(reach, wanted) {
    if (reach == null) reach = s.trimReachM || s.TRIM_REACH_M;
    if (wanted == null)
      wanted = s.trimDetailM == null ? s.TRIM_DETAIL_M : s.trimDetailM;
    var ceiling = Math.max(0, reach - (s.TRIM_DETAIL_CLEARANCE_M || 15));
    return Math.max(0, Math.min(ceiling, wanted));
  }

  /**
   * Work out the trimmed boundary.
   *
   * Takes everything it needs as arguments rather than reading the map, so the
   * one part of this tool that is an algorithm rather than an interaction can
   * be run on made-up villages.
   *
   * @param {{outer: Object, keep: Array, ignored?: Array, reach: number,
   *          detail?: number, corridor?: number, follow?: boolean}} opts
   *   `keep` and `ignored` are entries carrying at least `centroid`; `big`
   *   asks for the footprint to be stamped too. `detail` is the simplification
   *   tolerance in meters, `corridor` the width of the links drawn to outlying
   *   groups.
   * @returns {{feature, areaBefore, areaAfter, inside, outside, ignoredInside,
   *            cell}|{error: string}}
   */
  function propose(opts) {
    var outer = opts.outer;
    var keep = opts.keep || [];
    var ignored = opts.ignored || [];
    if (keep.length === 0) return { error: "noKeep" };

    var reach = opts.reach || s.TRIM_REACH_M;
    var geometry = {
      cell: s.TRIM_CELL_M,
      pad: reach + 4 * (s.TRIM_CELL_M || 10),
      maxCells: s.TRIM_MAX_CELLS,
    };
    var box = turf.bbox(outer);
    var raster = new C.Raster(box, geometry);

    keep.forEach(function (entry) {
      raster.stampDisc(entry.centroid, reach);
      if (entry.big) _stampFootprint(raster, entry.feature, reach);
    });

    var best = _connect(raster, keep, {
      corridor: opts.corridor,
      reach: reach,
      // Where a corridor is allowed to run. Without it a link is a straight
      // line that stops dead the first time the working boundary bends away
      // from it, and the group it was drawn for stays stranded outside.
      inside: _insideRaster(outer, box, geometry),
    });
    if (!best) return { error: "failed" };

    var rings = raster.ringsOf(best).exteriors;
    if (rings.length === 0) return { error: "failed" };
    var ring = rings.length === 1 ? rings[0] : _largestRing(rings);

    var detail = opts.detail == null ? s.TRIM_DETAIL_M || 0 : opts.detail;
    var core = _polygon(_simplify(ring, detail));
    if (!core) return { error: "failed" };

    var shaped = opts.follow ? _followStreets(core) || core : core;

    var clipped;
    try {
      clipped = G.intersect(shaped, outer);
    } catch (e) {
      clipped = null;
    }
    var final = G.largestPolygon(clipped || shaped);
    if (!final) return { error: "failed" };
    final = _fillHoles(final, outer);

    // Measured on the shape itself rather than inferred from the reach. The
    // clearance argument in the header is why this is expected to come out
    // right; this is why it is safe to apply when it does not.
    var counts = _count(final, keep);
    return {
      feature: final,
      areaBefore: G.area(outer),
      areaAfter: G.area(final),
      inside: counts.inside,
      outside: counts.outside,
      ignoredInside: _count(final, ignored).inside,
      // The one number that says what the detail slider just did. Without it
      // the slider is a control whose effect you have to squint at the map to
      // see, and at low zoom you cannot see it at all.
      vertices: Math.max(0, _ringOf(final).length - 1),
      cell: raster.cell,
    };
  }

  /**
   * Make the kept buildings one place, and say which raster component that is.
   *
   * Without this, a building that is not near any other simply lost: it formed
   * its own component, the vote went to the settlement, and the proposal came
   * back unchanged. Which made un-excluding one a no-op — you clicked, the
   * count went up, and the boundary did not move. That is the single most
   * confusing thing a tool like this can do, because the user's model is the
   * simple one and the simple one is right: what I keep, I keep.
   *
   * So an outlying group is not dropped, it is joined — by stamping a corridor
   * along the streets that lead to it. Which is also the honest answer on the
   * ground: a territory that includes the farm at the end of the lane includes
   * the lane, because that is what the person walking it does. Straight-line
   * corridors are the fallback for anything the network cannot reach.
   *
   * This is what makes excluding the sparse edges a decision rather than a
   * side effect, and it is why the outlier pass now runs by default: dropping
   * is no longer automatic, so something has to propose it.
   *
   * @returns {number} the component label holding every kept building it could
   *   join; groups it could not are left to be counted as falling outside.
   */
  function _connect(raster, keep, opts) {
    var radius = opts.corridor || s.TRIM_CORRIDOR_M || 12;
    var rounds = s.TRIM_LINK_ROUNDS || 3;

    for (var round = 0; ; round++) {
      var groups = Object.create(null);
      keep.forEach(function (entry) {
        var label = raster.labelAt(entry.centroid);
        if (!label) return;
        (groups[label] || (groups[label] = [])).push(entry);
      });

      var labels = Object.keys(groups);
      if (labels.length === 0) return 0;

      var best = labels[0];
      labels.forEach(function (label) {
        if (groups[label].length > groups[best].length) best = label;
      });
      var home = groups[best];

      // One place already, out of rounds, or so many scattered groups that
      // bridging them all would draw a starfish rather than a territory.
      if (
        labels.length === 1 ||
        round >= rounds ||
        labels.length > (s.TRIM_LINK_MAX_GROUPS || 40)
      ) {
        return parseInt(best, 10);
      }

      labels.forEach(function (label) {
        if (label === best) return;
        _bridge(raster, groups[label], home, radius, opts);
      });
    }
  }

  /** The working boundary as a raster, so a corridor can be kept inside it. */
  function _insideRaster(outer, box, geometry) {
    try {
      var inside = new C.Raster(box, geometry);
      inside.fillPolygon(outer.geometry.coordinates);
      return inside.marked > 0 ? inside : null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Stamp a corridor from the nearest member of `from` to the nearest of `to`.
   *
   * Straight, unless straight is impossible.
   *
   * The first version asked the street network first, and that was the wrong
   * instinct dressed up as a good one. A lane to an outlying farm is rarely
   * the shortest way there by road, so the corridor set off along whatever
   * route the graph liked, wandered around two corners, and arrived as an arm
   * nobody would have drawn. Following streets is right for the *edge* of the
   * territory, where the line has to be one somebody can stand on and see; it
   * is wrong for a link, where the only question is how to reach the building
   * without covering ground that was not asked for. The straight line is the
   * answer to that question, and it is also the shortest.
   *
   * So the boundary is only worked around when it genuinely blocks the way —
   * checked over the whole segment rather than at its endpoints, because a
   * concave boundary can cut through the middle of a line whose ends are both
   * comfortably inside. Then, and only then, a grid route goes round, and it
   * is pulled straight afterwards so it comes back as a couple of legs rather
   * than as a staircase.
   */
  function _bridge(raster, from, to, radius, opts) {
    var anchor = _nearestTo(from, to[0].centroid);
    var target = _nearestTo(to, anchor.centroid);
    anchor = _nearestTo(from, target.centroid);

    var a = anchor.centroid;
    var b = target.centroid;
    var inside = opts.inside;
    var path = [a, b];

    if (inside && !inside.visible(a, b)) {
      var around = inside.route(a, b);
      if (around && around.length > 1) {
        // Keep the real endpoints: the grid route starts and ends at cell
        // centers, which can sit half a cell off the buildings it is joining.
        var legs = inside.simplifyPath(around);
        legs[0] = a;
        legs[legs.length - 1] = b;
        path = legs;
      }
    }

    // A wedge, not a wire: full width where it leaves the settlement, tapering
    // to a tip a couple of corridor-widths across at the building it reaches,
    // whose own reach disc rounds the end off.
    var reach = opts.reach || s.TRIM_REACH_M;
    raster.stampPath(path, radius, {
      start: Math.max(radius * (s.TRIM_TIP_FACTOR || 2), raster.cell * 2),
      end: reach,
    });
  }

  function _nearestTo(entries, coord) {
    var best = entries[0];
    var bestD = Infinity;
    for (var i = 0; i < entries.length; i++) {
      var d = SP.distSq(entries[i].centroid, coord);
      if (d < bestD) {
        bestD = d;
        best = entries[i];
      }
    }
    return best;
  }

  /**
   * Close every hole in the proposal.
   *
   * A territory boundary with a hole in it is a boundary somebody has to
   * explain. On a printed card it is worse than that: the person walking it
   * has no way to tell an intentional exclusion from a rendering artefact, and
   * these are artefacts — an empty field ringed by houses, a courtyard the
   * reach did not close, a sliver the street snapping left behind. None of
   * them is a place anybody should be told to skip.
   *
   * Holes in the *working boundary* are a different matter: those the user
   * chose, so the result is re-clipped when the outer polygon has any, which
   * puts back exactly those and nothing else.
   */
  function _fillHoles(feature, outer) {
    var rings = feature.geometry.coordinates;
    if (rings.length <= 1) return feature;

    var filled;
    try {
      filled = turf.polygon([rings[0]], feature.properties || {});
    } catch (e) {
      return feature;
    }

    var outerRings = outer.geometry.coordinates;
    if (outerRings.length <= 1) return filled;
    try {
      var reclipped = G.intersect(filled, outer);
      var largest = G.largestPolygon(reclipped);
      return largest || filled;
    } catch (e) {
      return filled;
    }
  }

  function _ringOf(feature) {
    var g = feature.geometry;
    var rings = g.type === "MultiPolygon" ? g.coordinates[0] : g.coordinates;
    return (rings && rings[0]) || [];
  }

  /** Stamp a large footprint at its vertices as well as its center. */
  function _stampFootprint(raster, feature, reach) {
    var coords = feature.geometry.coordinates;
    var ring =
      feature.geometry.type === "MultiPolygon" ? coords[0][0] : coords[0];
    if (!Array.isArray(ring)) return;
    var step = Math.max(1, Math.floor(ring.length / 12));
    for (var i = 0; i < ring.length; i += step) raster.stampDisc(ring[i], reach);
  }

  function _largestRing(rings) {
    var best = rings[0];
    var bestArea = -1;
    rings.forEach(function (ring) {
      var a = Math.abs(C.signedArea(ring));
      if (a > bestArea) {
        bestArea = a;
        best = ring;
      }
    });
    return best;
  }

  /**
   * Straighten the traced staircase.
   *
   * The floor is the raster's own resolution: below that there is nothing to
   * remove but the steps themselves, and leaving those in makes every
   * downstream test several times the work for a shape nobody can tell apart.
   * Above it, this is the edge-detail slider, and it is doing the thing the
   * slider promises — a boundary that hugs every bay between two houses is
   * accurate and unusable, because the person holding the card has to decide
   * which side of it they are standing on.
   */
  function _simplify(ring, meters) {
    var tolerance =
      Math.max(meters || 0, s.TRIM_SIMPLIFY_M || 6) / C.M_PER_DEG_LAT;
    try {
      var out = turf.simplify(turf.polygon([ring]), {
        tolerance: tolerance,
        highQuality: false,
        mutate: false,
      });
      var simple = out && out.geometry && out.geometry.coordinates[0];
      if (simple && simple.length >= 4) return simple;
    } catch (e) {
      /* the staircase is a perfectly usable ring on its own */
    }
    return ring;
  }

  function _polygon(ring) {
    try {
      var poly = turf.polygon([_close(ring)]);
      if (turf.booleanValid && !turf.booleanValid(poly)) {
        var healed = turf.buffer(poly, 0);
        return healed && healed.geometry ? G.largestPolygon(healed) : null;
      }
      return poly;
    } catch (e) {
      return null;
    }
  }

  function _close(ring) {
    var out = ring.slice();
    var first = out[0];
    var last = out[out.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) out.push(first.slice());
    return out;
  }

  // ── Following the streets ─────────────────────────────────────────────

  /**
   * Pull the ring onto the street network.
   *
   * Two separate moves, and the second is the one that matters. Snapping a
   * vertex sideways onto a road makes the corner sit on the road; routing
   * between two snapped vertices makes the whole edge between them run along
   * it, bends and all. Without the routing this produces a boundary that
   * touches streets at points and cuts across gardens in between.
   *
   * A routed replacement is rejected when it detours (the same limits the cut
   * tool uses) or when it wanders further than `slack` from the ring it is
   * replacing — that second test is what stops a road that loops back through
   * the middle of the village from being adopted as the edge of it.
   */
  function _followStreets(core) {
    if (!N.isReady()) return null;

    var ring = core.geometry.coordinates[0];
    var snapM = s.TRIM_SNAP_M || 25;
    var slack = s.TRIM_ROUTE_SLACK_M || 40;
    var budget = s.TRIM_ROUTE_BUDGET || 400;

    var ringGrid = new SP.Grid(120);
    for (var i = 0; i < ring.length - 1; i++)
      ringGrid.addSegment(ring[i], ring[i + 1], null);

    var anchors = [];
    for (i = 0; i < ring.length - 1; i++) {
      var hit = N.nearestSegmentPoint(ring[i], snapM);
      var coord = hit ? hit.coord : ring[i];
      var node = hit ? N.nearestNode(coord, snapM) : null;
      anchors.push({ coord: coord, key: node ? node.key : null });
    }
    if (anchors.length < 3) return null;

    var out = [];
    var routes = 0;
    for (i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var b = anchors[(i + 1) % anchors.length];
      out.push(a.coord);

      if (!a.key || !b.key || a.key === b.key) continue;
      if (routes >= budget) continue;
      var direct = SP.dist(a.coord, b.coord);
      if (direct < (s.TRIM_ROUTE_MIN_M || 15)) continue;

      routes++;
      var path = N.route(a.key, b.key, s.TRIM_ROUTE_MAX_POPS);
      if (!path || path.length < 3) continue;

      var length = N.pathLength(path);
      if (length > direct * (s.CUT_ROUTE_MAX_DETOUR || 1.75)) continue;
      if (length - direct > (s.CUT_ROUTE_MAX_EXTRA_M || 300)) continue;

      var usable = true;
      var middle = [];
      for (var j = 1; j < path.length - 1; j++) {
        var point = [path[j].lng, path[j].lat];
        var near = ringGrid.nearestSegment(point, slack);
        if (!near) {
          usable = false;
          break;
        }
        middle.push(point);
      }
      if (usable) for (j = 0; j < middle.length; j++) out.push(middle[j]);
    }

    var deduped = G.dedupCoords(out, 1e-9);
    if (deduped.length < 3) return null;
    return _polygon(deduped);
  }

  // ── Measuring ─────────────────────────────────────────────────────────

  function _count(feature, entries) {
    var box;
    try {
      box = turf.bbox(feature);
    } catch (e) {
      return { inside: 0, outside: entries.length };
    }
    var inside = 0;
    entries.forEach(function (entry) {
      var c = entry.centroid;
      if (c[0] < box[0] || c[0] > box[2] || c[1] < box[1] || c[1] > box[3]) return;
      try {
        if (turf.booleanPointInPolygon(turf.point(c), feature)) inside++;
      } catch (e) {
        /* an unmeasurable point counts as outside */
      }
    });
    return { inside: inside, outside: entries.length - inside };
  }

  // ══════════════════════════════════════════════════════════════════════
  // PREVIEW
  // ══════════════════════════════════════════════════════════════════════

  /** Recompute after the dust settles; a slider drag fires far too often. */
  function _schedule(delay) {
    clearTimeout(_timer);
    // Said here rather than in _recompute, which is where it belongs and where
    // it can never be seen: the proposal is half a second of raster and buffer
    // work on one synchronous tick, and the browser paints nothing between
    // being told and being blocked. Announced at the moment the slider moves,
    // the debounce it is already waiting out becomes the frame it is painted
    // in — so the toolbar says "working" for the half second it is, instead of
    // showing the last answer as though it were the current one.
    _pending = true;
    _updateStatus();
    _timer = setTimeout(
      _recompute,
      delay === undefined ? s.TRIM_DEBOUNCE_MS || 220 : delay,
    );
  }

  function _recompute() {
    if (!s.trimMode || _busy || s.trimEdit) {
      _pending = false;
      return;
    }
    _busy = true;
    var started = Date.now();
    try {
      _result = compute();
    } catch (e) {
      console.error(">>> Trim failed:", e);
      _result = { error: "failed" };
    }
    _busy = false;
    _pending = false;
    console.log(">>> Trim proposal in", Date.now() - started, "ms");
    _drawPreview();
    _updateStatus();
  }

  function _drawPreview() {
    _clearPreview();
    if (!_result || _result.error) return;

    try {
      _preview = L.geoJSON(_result.feature, PREVIEW_STYLE).addTo(s.leafletMap);
    } catch (e) {
      console.warn(">>> Could not draw the trim preview:", e.message);
      return;
    }

    _drawLost(_result.feature);
  }

  /**
   * The area being given up, which is the thing being decided. Drawn under the
   * proposal so the two outlines do not fight over the same pixels, and
   * redrawn after every hand adjustment so it never describes a shape that has
   * since moved.
   */
  function _drawLost(feature) {
    if (_lost && s.leafletMap) s.leafletMap.removeLayer(_lost);
    _lost = null;
    try {
      var outer = G.getOuterFeature(s.outerPolygonLayer);
      var lostShape = G.difference(outer, feature);
      if (lostShape && lostShape.geometry) {
        _lost = L.geoJSON(lostShape, LOST_STYLE).addTo(s.leafletMap);
        _lost.bringToBack();
      }
    } catch (e) {
      /* the proposal alone still reads */
    }
  }

  function _clearPreview() {
    [_preview, _lost].forEach(function (layer) {
      if (layer && s.leafletMap) s.leafletMap.removeLayer(layer);
    });
    _preview = _lost = null;
  }

  // ══════════════════════════════════════════════════════════════════════
  // ADJUSTING BY HAND
  // ══════════════════════════════════════════════════════════════════════
  //
  // Everything above works from what the buildings are, and the answer is
  // usually right. "Usually" is the problem: the one corner that should follow
  // the ditch rather than the hedge is not a thing any of these settings can
  // express, and re-deriving the whole shape from a slider to move one vertex
  // is the wrong shape of control entirely.
  //
  // So the proposal can be taken over. Leaflet.Editable — already in the app
  // for drawing the boundary in the first place — puts a handle on every
  // corner, a half-handle on every edge for adding one, and deletes on click.
  // Nothing new is vendored for this.
  //
  // The mode is a latch rather than a free-for-all, because the two ways of
  // producing this shape cannot both be live at once. While it is on, the
  // sliders and the selection are locked: a recompute would silently throw the
  // adjustment away, and the honest way to prevent that is to make it
  // impossible rather than to warn about it afterwards. Turning it off goes
  // back to the computed shape — which is a discard, but an explicit one, done
  // by the same control that started the editing.

  function isEditing() {
    return !!s.trimEdit;
  }

  /**
   * @param {boolean} on
   * @param {{silent?: boolean}} [opts] silent skips the recompute on the way
   *   out, for a teardown that is about to throw everything away anyway
   */
  function setEdit(on, opts) {
    on = !!on;
    if (on === !!s.trimEdit) return;
    if (on && (!_result || _result.error || !_result.feature)) return;

    s.trimEdit = on;
    if (on) _startEdit();
    else _stopEdit(opts);

    _syncEditLocks();
    _updateStatus();
  }

  function _startEdit() {
    _clearPreview();
    _editLayer = G.toLayer(_result.feature.geometry, EDIT_STYLE, { pane: PANE });
    if (!_editLayer) {
      s.trimEdit = false;
      return;
    }
    _editLayer.addTo(s.leafletMap);

    try {
      _editLayer.enableEdit(s.leafletMap);
    } catch (e) {
      // Without Leaflet.Editable the shape is still on the map and still
      // applicable; it just cannot be dragged. Better than refusing to open.
      console.warn(">>> Cannot edit the trim proposal by hand:", e.message);
    }

    // Every way the plugin can change the ring. dragend rather than drag: the
    // measurement re-tests every kept building, which is not a per-frame job.
    _editLayer.on(
      "editable:vertex:dragend editable:vertex:new editable:vertex:deleted editable:dragend",
      _afterEdit,
    );
    _drawLost(_result.feature);
  }

  function _stopEdit(opts) {
    if (_editLayer) {
      try {
        _editLayer.disableEdit();
      } catch (e) {
        /* never enabled */
      }
      s.leafletMap.removeLayer(_editLayer);
      _editLayer = null;
    }
    if (!opts || !opts.silent) _schedule(0);
  }

  /** Re-measure the hand-moved shape. The numbers have to follow the geometry. */
  function _afterEdit() {
    if (!_editLayer || !_result) return;
    // A sweep deletes corners one at a time and this re-tests every kept
    // building against the ring. Once at the end of the stroke, not once per
    // corner — App.vertices calls back on release.
    if (App.vertices.isErasing()) return;
    var poly;
    try {
      poly = G.largestPolygon(_editLayer.toGeoJSON());
    } catch (e) {
      poly = null;
    }
    if (!poly) return;

    var keep = _pool.filter(function (entry) {
      return !_ignored.has(entry.key);
    });
    var ignored = _pool.filter(function (entry) {
      return _ignored.has(entry.key);
    });
    var counts = _count(poly, keep);

    _result = {
      feature: poly,
      areaBefore: _result.areaBefore,
      areaAfter: G.area(poly),
      inside: counts.inside,
      outside: counts.outside,
      ignoredInside: _count(poly, ignored).inside,
      vertices: Math.max(0, _ringOf(poly).length - 1),
      cell: _result.cell,
      edited: true,
    };

    _drawLost(poly);
    _updateStatus();
  }

  /** Locks, so the two ways of producing this shape are never both live. */
  function _syncEditLocks() {
    if (!_toolbar) return;
    var locked = !!s.trimEdit;
    ["reach", "detail", "follow", "isolation", "group"].forEach(function (role) {
      var node = D.role(_toolbar, role);
      if (node) node.disabled = locked;
    });
    ["outliers", "clear"].forEach(function (role) {
      var node = D.role(_toolbar, role);
      if (node) D.toggleClass(node, "is-disabled", locked);
    });
    D.toggleClass(_toolbar, "is-editing", locked);
    var box = D.role(_toolbar, "edit");
    if (box) box.checked = locked;
  }

  // ══════════════════════════════════════════════════════════════════════
  // TOOLBAR
  // ══════════════════════════════════════════════════════════════════════

  function _showToolbar() {
    _hideToolbar();
    _toolbar = D.mountOnMap("tpl-trim-toolbar", s.leafletMap);

    var reach = D.role(_toolbar, "reach");
    reach.min = String(s.TRIM_REACH_MIN_M || 20);
    reach.max = String(s.TRIM_REACH_MAX_M || 150);
    reach.step = "5";
    reach.value = String(s.trimReachM || s.TRIM_REACH_M);
    reach.addEventListener("input", function () {
      s.trimReachM = parseInt(reach.value, 10) || s.TRIM_REACH_M;
      _syncReach();
      // The detail ceiling is a function of the reach, so narrowing the reach
      // has to pull the other slider in with it rather than silently ignoring
      // where it is sitting.
      _syncDetail();
      _schedule();
    });

    var detail = D.role(_toolbar, "detail");
    detail.min = "0";
    detail.step = "5";
    detail.value = String(detailM());
    detail.addEventListener("input", function () {
      s.trimDetailM = parseInt(detail.value, 10) || 0;
      _syncDetail();
      _schedule();
    });

    // ── The outlier sliders ─────────────────────────────────────────────
    //
    // The pass runs on arrival and used to be the end of the conversation:
    // the only reply to "it took too much" or "it left the four farms in"
    // was to click buildings one at a time, or drag a box, and to do that
    // again on the next area. These two are the same conversation held with
    // the rule instead of with its output — and because both are relative to
    // the area's own spacing, a setting that suits one village keeps meaning
    // the same thing in the next one.
    var isolation = D.role(_toolbar, "isolation");
    isolation.min = String(_scaled(s.TRIM_OUTLIER_FACTOR_MIN || 1));
    isolation.max = String(_scaled(s.TRIM_OUTLIER_FACTOR_MAX || 20));
    isolation.step = "1"; // tenths, see _scaled
    isolation.value = String(_scaled(_factor()));
    isolation.addEventListener("input", function () {
      s.trimOutlierFactor = (parseInt(isolation.value, 10) || 30) / 10;
      _syncOutliers();
      _scheduleOutliers();
    });

    var group = D.role(_toolbar, "group");
    group.min = String(s.TRIM_OUTLIER_GROUP_MIN || 1);
    group.max = String(s.TRIM_OUTLIER_GROUP_LIMIT || 60);
    group.step = "1";
    group.value = String(_groupMax());
    group.addEventListener("input", function () {
      s.trimOutlierGroupMax = parseInt(group.value, 10) || 1;
      _syncOutliers();
      _scheduleOutliers();
    });

    var edit = D.role(_toolbar, "edit");
    edit.checked = !!s.trimEdit;
    edit.addEventListener("change", function () {
      setEdit(!!edit.checked);
    });

    var follow = D.role(_toolbar, "follow");
    follow.checked = !!s.trimFollow;
    follow.addEventListener("change", function () {
      s.trimFollow = !!follow.checked;
      _schedule(0);
    });

    D.onRole(_toolbar, "apply", apply);
    D.onRole(_toolbar, "outliers", _runOutliers);
    D.onRole(_toolbar, "clear", clearSelection);
    D.onRole(_toolbar, "cancel", function () {
      if (s.trimMode) toggle();
    });

    _syncReach();
    _syncDetail();
    _syncOutliers();
    _syncEditLocks();
    _updateStatus();
  }

  // ── Outlier settings ──────────────────────────────────────────────────

  /** Range inputs are integers, and the isolation factor is not. */
  function _scaled(factor) {
    return Math.round(factor * 10);
  }

  function _factor() {
    var value = s.trimOutlierFactor;
    if (value == null) value = s.TRIM_OUTLIER_FACTOR || 3;
    return value;
  }

  function _groupMax() {
    var value = s.trimOutlierGroupMax;
    if (value == null) value = s.TRIM_OUTLIER_GROUP_MAX || 8;
    return value;
  }

  /**
   * Re-run the pass, a beat after the slider stops moving.
   *
   * Separate from _schedule and shorter: the pass clusters every building in
   * the pool, and the shape recompute it triggers is debounced again on the
   * far side. Running both on every frame of a drag would spend the whole
   * drag computing the answer to a setting the slider has already left.
   */
  var _outlierTimer = null;

  function _scheduleOutliers() {
    clearTimeout(_outlierTimer);
    // Grouping the buildings and deciding which are outliers is another second
    // on a town, and it runs before the proposal does. Its own debounce is the
    // frame the word gets painted in.
    _pending = true;
    _updateStatus();
    _outlierTimer = setTimeout(function () {
      _outlierTimer = null;
      if (s.trimMode && !s.trimEdit) markOutliers();
    }, 120);
  }

  /**
   * The readouts.
   *
   * The isolation slider says what its multiplier comes to on the ground,
   * because a multiplier on a number nobody has been told is not a control
   * anybody can aim. The floor is part of that: below TRIM_OUTLIER_MIN_M the
   * distance stops moving however far left the slider goes, and a readout
   * that went on counting down would be describing an effect that is not
   * happening.
   */
  function _syncOutliers() {
    if (!_toolbar) return;
    var unit = isolationUnit();
    var meters = Math.round(unit * _factor());
    D.text(
      _toolbar,
      "isolation-out",
      unit > 0
        ? T("trim.isolationValue", {
            factor: App.i18n.n(Math.round(_factor() * 10) / 10),
            meters: meters,
          })
        : T("trim.isolationBare", {
            factor: App.i18n.n(Math.round(_factor() * 10) / 10),
          }),
    );

    var max = _groupMax();
    D.text(
      _toolbar,
      "group-out",
      max <= 1
        ? T("trim.groupSingle")
        : T("trim.groupValue", { count: max }),
    );
  }

  function _hideToolbar() {
    _toolbar = D.remove(_toolbar);
  }

  function _syncReach() {
    if (!_toolbar) return;
    D.text(
      _toolbar,
      "reach-out",
      T("trim.reachValue", { meters: s.trimReachM || s.TRIM_REACH_M }),
    );
  }

  function _syncDetail() {
    if (!_toolbar) return;
    var slider = D.role(_toolbar, "detail");
    var reach = s.trimReachM || s.TRIM_REACH_M;
    slider.max = String(Math.max(0, reach - (s.TRIM_DETAIL_CLEARANCE_M || 15)));
    var value = detailM();
    s.trimDetailM = value;
    slider.value = String(value);
    D.text(
      _toolbar,
      "detail-out",
      value === 0 ? T("trim.detailFull") : T("trim.detailValue", { meters: value }),
    );
  }

  function _updateStatus() {
    if (!_toolbar) return;
    var count = T("trim.ignored", { count: ignoredCount() });
    // The buildings the automatic pass named and the user put back. Worth its
    // own number: it is the one thing on screen that says how far the proposal
    // has been overruled by hand.
    var kept = flaggedCount();
    if (kept > 0) count += " · " + T("trim.flaggedCount", { count: kept });
    D.text(_toolbar, "count", count);

    var ready = false;
    var status;

    if (_pending) {
      // Only the sentence changes. Whether Apply is live is still decided by
      // the proposal in hand, because the one on screen is still the one that
      // would be applied until the new one lands.
      status = T("trim.computing");
      ready = !!(_result && !_result.error);
    } else if (!_result) {
      status = T("trim.computing");
    } else if (_result.error) {
      // Spelled out rather than concatenated: a key built at runtime is a key
      // that no search for it will ever find, which is how a translation goes
      // missing without anybody noticing.
      status = T(_result.error === "noKeep" ? "trim.noKeep" : "trim.failed");
    } else {
      var saved = _result.areaBefore
        ? Math.round((1 - _result.areaAfter / _result.areaBefore) * 100)
        : 0;
      if (saved <= 0) {
        status = T("trim.nothing");
      } else {
        ready = true;
        status = T("trim.saving", {
          percent: saved,
          area: _round(_result.areaAfter / 1e6),
        });
        status += " · " + T("trim.corners", { count: _result.vertices });
        if (_result.edited) status += " · " + T("trim.editedNote");
        if (_result.outside > 0)
          status += " · " + T("trim.dropped", { count: _result.outside });
      }
    }

    D.text(_toolbar, "status", status);
    D.toggleClass(_toolbar, "is-ready", ready);
  }

  function _round(km2) {
    return km2 >= 100 ? Math.round(km2) : Math.round(km2 * 100) / 100;
  }

  // ══════════════════════════════════════════════════════════════════════
  // APPLY
  // ══════════════════════════════════════════════════════════════════════

  function apply() {
    if (!_result || _result.error || !_result.feature) {
      alert(T("trim.nothingToApply"));
      return;
    }
    var result = _result;
    var saved = result.areaBefore
      ? Math.round((1 - result.areaAfter / result.areaBefore) * 100)
      : 0;

    var detail = T("trim.applyDetail", {
      before: _round(result.areaBefore / 1e6),
      after: _round(result.areaAfter / 1e6),
      percent: saved,
    });
    if (result.outside > 0)
      detail += " · " + T("trim.dropped", { count: result.outside });

    App.ui
      .confirm({
        titleKey: "trim.applyTitle",
        messageKey: "trim.applyMessage",
        detail: detail,
        okKey: "trim.applyOk",
        danger: result.outside > 0,
      })
      .then(function (ok) {
        if (ok) _install(result.feature);
      });
  }

  /**
   * Swap in the trimmed boundary and bring the territories with it.
   *
   * The clipping, the printed marks and the empty-partition fallback all live
   * in App.polygons.replaceOuter now: the outline editor does exactly the
   * same six things after exactly the same kind of change, and two copies of
   * "what happens to a territory that is now half outside" is one copy too
   * many. What is still this tool's own business is the sanity of the ring
   * and the fact that a trim can only ever shrink.
   */
  function _install(poly) {
    // A ring that has been dragged by hand can cross itself, drift outside the
    // working boundary, or pick up a hole. The computed path already
    // guarantees none of that; this is the one entry point where it has to be
    // enforced rather than assumed.
    poly = _sanitize(poly);
    if (!poly) {
      alert(T("trim.failed"));
      return;
    }

    if (App.history) App.history.push();

    // Before the swap: the tool is holding markers and a preview over a
    // boundary that is about to be replaced.
    if (s.trimMode) toggle();

    // Replacing the boundary clips every territory against it and then
    // re-tests every building — the heaviest thing in the app after the
    // partition itself, and the only one of them that never said so.
    App.ui.busy("loading.boundary", function () {
      _swap(poly);
    });
  }

  function _swap(poly) {
    var stats = App.polygons.replaceOuter(poly);
    if (!stats) {
      alert(T("trim.failed"));
      return;
    }

    console.log(
      ">>> Boundary trimmed —",
      Math.round(G.area(poly)),
      "m², ",
      stats.kept,
      "territories kept,",
      stats.dropped,
      "dropped",
    );
  }

  /** Valid, inside the working boundary, and a single ring. */
  function _sanitize(poly) {
    var healed = poly;
    try {
      if (turf.booleanValid && !turf.booleanValid(healed)) {
        healed = G.largestPolygon(turf.buffer(healed, 0)) || healed;
      }
    } catch (e) {
      /* an unrepairable ring is still worth clipping */
    }
    try {
      var outer = G.getOuterFeature(s.outerPolygonLayer);
      var clipped = G.largestPolygon(G.intersect(healed, outer));
      if (clipped) healed = _fillHoles(clipped, outer);
    } catch (e) {
      return null;
    }
    return healed && healed.geometry ? healed : null;
  }

  // ══════════════════════════════════════════════════════════════════════
  // KEYBOARD
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Outliers and Clear are new: both have been buttons since the tool
   * shipped, and both were the only two actions on any of the three mode
   * toolbars with no key at all. `when` rather than a guard inside `run`, so
   * the sheet can grey what the hand-adjust latch has locked instead of
   * offering a key that quietly does nothing.
   */
  var TRIM_KEYS = {
    id: "trim",
    titleKey: "shortcuts.groupTrim",
    entries: [
      { combos: ["Enter"], labelKey: "shortcuts.trimApply", run: apply },
      {
        // Cut and merge both answer Backspace, and this tool collects a
        // selection exactly the way merge does. Leaving it to Ctrl+Z alone
        // made it the one modal tool where the obvious key did nothing.
        combos: ["Backspace", "Delete"],
        labelKey: "shortcuts.trimBack",
        when: function () {
          return _ignoreUndo.length > 0;
        },
        run: _undoIgnore,
      },
      {
        combos: ["Shift+Backspace", "Shift+Delete"],
        labelKey: "shortcuts.trimForward",
        when: function () {
          return _ignoreRedo.length > 0;
        },
        run: _redoIgnore,
      },
      {
        combos: ["E"],
        labelKey: "trim.adjust",
        run: function () {
          setEdit(!s.trimEdit);
        },
      },
      // Only while the proposal is being taken over by hand: with the latch
      // off there are no corner handles on screen, and a key that silently
      // does nothing is worse than one the sheet has greyed out.
      App.vertices.eraserKey({
        when: function () {
          return !!s.trimEdit && !!_editLayer;
        },
        layer: function () {
          return _editLayer;
        },
        onStroke: _afterEdit,
      }),
      {
        combos: ["F"],
        labelKey: "trim.follow",
        when: function () {
          return !s.trimEdit;
        },
        run: function () {
          s.trimFollow = !s.trimFollow;
          if (_toolbar) D.role(_toolbar, "follow").checked = s.trimFollow;
          _schedule(0);
        },
      },
      {
        combos: ["O"],
        labelKey: "trim.outliers",
        when: function () {
          return !s.trimEdit;
        },
        run: _runOutliers,
      },
      {
        combos: ["C"],
        labelKey: "trim.clear",
        when: function () {
          return !s.trimEdit && ignoredCount() > 0;
        },
        run: clearSelection,
      },
      {
        combos: ["Escape"],
        labelKey: "shortcuts.trimCancel",
        run: function () {
          if (s.trimMode) toggle();
        },
      },
      { combos: ["Click"], labelKey: "shortcuts.trimPick", note: true },
      { combos: ["Shift+drag"], labelKey: "shortcuts.trimBox", note: true },
      { combos: ["Alt+drag"], labelKey: "shortcuts.trimUnbox", note: true },
      { combos: ["Right-click"], labelKey: "shortcuts.menu", note: true },
    ],
  };

  /**
   * The button, as opposed to the sliders.
   *
   * `reassert` is what stops it from being a no-op: the pass has already run,
   * so pressing it can only mean "put your answer back over mine". Without
   * that it would recompute the same set, find every one of them already
   * excluded or already overruled, and change nothing at all.
   */
  function _runOutliers() {
    var marked = markOutliers({ reassert: true });
    if (marked === 0) alert(T("trim.noOutliers"));
  }

  // ── Selection history ─────────────────────────────────────────────────
  //
  // The ignore set is what this tool edits, and until now nothing recorded
  // it: Ctrl+Z while trimming reached straight past it into the cluster
  // stack and undid whatever geometry change came before the tool was
  // opened. Snapshots are small — a set of keys — so every change gets one.

  var _ignoreUndo = [];
  var _ignoreRedo = [];
  var IGNORE_MAX = 50;

  /** Record the ignore set before a change that should be undoable. */
  function pushIgnore() {
    if (!_ignored) return;
    _ignoreUndo.push(_snapshotIgnored());
    if (_ignoreUndo.length > IGNORE_MAX) _ignoreUndo.shift();
    _ignoreRedo = [];
    App.history.sync();
  }

  /**
   * Both halves, because both can change.
   *
   * The pass's answer used to be indistinguishable from the user's edits
   * inside a snapshot, which was harmless while it was computed once. Clear
   * empties it and the Outliers button replaces it, so a snapshot that only
   * carried the derived set would undo those two by putting the *result*
   * back while leaving the inputs saying something else.
   *
   * Slider moves are deliberately not on this stack, for the same reason the
   * reach and detail sliders are not: they are settings rather than edits.
   * Undoing past one therefore restores the pass's answer as it stood then,
   * and moving the slider again re-syncs it.
   */
  function _snapshotIgnored() {
    var auto = [];
    _auto.forEach(function (key) {
      auto.push(key);
    });
    var manual = [];
    _manual.forEach(function (excluded, key) {
      manual.push([key, excluded]);
    });
    return { auto: auto, manual: manual };
  }

  function _restoreIgnored(shot) {
    if (!shot) return;
    _auto = new Set(shot.auto || []);
    _manual = new Map(shot.manual || []);
    _applySelection();
    App.history.sync();
  }

  function _undoIgnore() {
    if (!_ignoreUndo.length) return;
    _ignoreRedo.push(_snapshotIgnored());
    _restoreIgnored(_ignoreUndo.pop());
  }

  function _redoIgnore() {
    if (!_ignoreRedo.length) return;
    _ignoreUndo.push(_snapshotIgnored());
    _restoreIgnored(_ignoreRedo.pop());
  }

  var TRIM_SCOPE = {
    id: "trim",
    undo: _undoIgnore,
    redo: _redoIgnore,
    canUndo: function () {
      return _ignoreUndo.length > 0;
    },
    canRedo: function () {
      return _ignoreRedo.length > 0;
    },
    undoDepth: function () {
      return _ignoreUndo.length;
    },
    redoDepth: function () {
      return _ignoreRedo.length;
    },
    undoKey: "toolbar.undoIgnore",
    redoKey: "toolbar.redoIgnore",
  };

  // ── Context menu ──────────────────────────────────────────────────────

  /**
   * The trim toolbar's actions, under the cursor — and, when the pointer is
   * over a building, that building named as something to keep or exclude.
   * Right-click did nothing at all here before.
   */
  function _showTrimMenu(point, key) {
    var excluded = key ? isIgnored(key) : false;
    App.ui.showContextMenu(point, [
      key && {
        labelKey: excluded ? "trim.menuKeep" : "trim.menuExclude",
        icon: excluded ? "fa-square-plus" : "fa-square-minus",
        checked: excluded,
        disabled: !!s.trimEdit,
        onClick: function () {
          _toggleIgnored(key);
        },
      },
      key && { separator: true },
      {
        labelKey: "trim.outliers",
        icon: "fa-wand-magic-sparkles",
        disabled: !!s.trimEdit,
        onClick: _runOutliers,
      },
      {
        labelKey: "trim.clear",
        icon: "fa-eraser",
        disabled: !!s.trimEdit || ignoredCount() === 0,
        onClick: clearSelection,
      },
      {
        labelKey: "trim.adjust",
        icon: s.trimEdit ? "fa-square-check" : "fa-square",
        checked: !!s.trimEdit,
        onClick: function () {
          setEdit(!s.trimEdit);
        },
      },
      { separator: true },
      {
        labelKey: "trim.apply",
        icon: "fa-check",
        onClick: apply,
      },
      {
        labelKey: "trim.cancel",
        icon: "fa-xmark",
        danger: true,
        onClick: function () {
          if (s.trimMode) toggle();
        },
      },
    ]);
  }

  /**
   * Called from polygons.js for a right-click while the tool is running.
   * The building key is derived here rather than at the call site, because
   * how a building is keyed is this module's business and nobody else's.
   *
   * @param {L.Layer} [layer] the building under the cursor, if there was one
   */
  function handleContextMenu(point, layer) {
    if (!s.trimMode) return false;
    var key = layer && layer.feature ? _keyOf(layer.feature) : null;
    _showTrimMenu(point, key);
    return true;
  }

  return {
    init: init,
    toggle: toggle,
    isActive: isActive,
    isIgnored: isIgnored,
    isFlagged: isFlagged,
    ignoredCount: ignoredCount,
    flaggedCount: flaggedCount,
    isolationUnit: isolationUnit,
    detailM: detailM,
    handleBuildingClick: handleBuildingClick,
    markOutliers: markOutliers,
    outliersIn: outliersIn,
    clearSelection: clearSelection,
    handleContextMenu: handleContextMenu,
    setEdit: setEdit,
    isEditing: isEditing,
    compute: compute,
    propose: propose,
    apply: apply,
  };
})();

window.App = App;
