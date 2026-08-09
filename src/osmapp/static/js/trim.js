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
  var _ignored = null; // Set of keys currently excluded
  var _flagged = null; // Set of keys the outlier pass has ever named
  var _result = null; // last computed proposal
  var _toolbar = null;
  var _hint = null;
  var _preview = null;
  var _lost = null;
  var _markerLayer = null;
  var _boxLayer = null;
  var _drag = null; // { start, mode } while a rectangle is being dragged
  var _timer = null;
  var _busy = false;

  function init() {
    s = App.state;
    G = App.geometry;
    SP = App.spatial;
    C = App.coverage;
    N = App.network;
    D = App.dom;
    T = App.i18n.t;
    document.addEventListener("keydown", _onKeyDown);
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
    }

    s.trimMode = next;
    App.controls.setActive("trim", next);

    if (next) _start();
    else _stop();
  }

  function _start() {
    _ignored = new Set();
    _flagged = new Set();
    _result = null;
    _pool = _buildPool();

    N.build();

    // The pointer is a selection instrument now: a tooltip chasing it covers
    // the building being clicked, and a territory highlight lifts a purple
    // wash over the buildings that are the subject of the exercise.
    // "features", not "off": territory tooltips are noise here, but the
    // building ones are the decision being made. See polygons.js.
    App.polygons.setTooltipMode("features");
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
    _ignored = new Set();
    _flagged = new Set();
    _pool = null;
    _result = null;
    App.polygons.restyleBuildings();
    App.polygons.setTooltipMode(s.mergeMode ? "anchored" : "full");
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
      pool.push({
        feature: feature,
        key: id == null ? "ix:" + index : "osm:" + id,
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

  function _keyOf(feature) {
    if (!feature || !_pool) return null;
    for (var i = 0; i < _pool.length; i++)
      if (_pool[i].feature === feature) return _pool[i].key;
    return null;
  }

  /** Read by polygons.js when it paints a building. */
  function isIgnored(feature) {
    if (!s.trimMode || !_ignored) return false;
    var key = _keyOf(feature);
    return key !== null && _ignored.has(key);
  }

  /** Named by the outlier pass, whether or not it is currently excluded. */
  function isFlagged(feature) {
    if (!s.trimMode || !_flagged) return false;
    var key = _keyOf(feature);
    return key !== null && _flagged.has(key);
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

  /** Clicking a building in trim mode toggles it. */
  function handleBuildingClick(layer) {
    if (!layer || !layer.feature) return;
    var key = _keyOf(layer.feature);
    if (key === null) return;
    if (_ignored.has(key)) _ignored.delete(key);
    else _ignored.add(key);
    _selectionChanged();
  }

  function _setRange(bounds, ignore) {
    var changed = 0;
    _pool.forEach(function (entry) {
      var c = entry.centroid;
      if (!bounds.contains(L.latLng(c[1], c[0]))) return;
      if (ignore ? _ignored.has(entry.key) : !_ignored.has(entry.key)) return;
      if (ignore) _ignored.add(entry.key);
      else _ignored.delete(entry.key);
      changed++;
    });
    if (changed) _selectionChanged();
    return changed;
  }

  function clearSelection() {
    if (!_ignored || _ignored.size === 0) return;
    _ignored = new Set();
    _selectionChanged();
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
        : _flagged.has(entry.key)
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
      if (_ignored.has(entry.key)) _ignored.delete(entry.key);
      else _ignored.add(entry.key);
      _selectionChanged();
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
   * The first version counted neighbors inside a fixed radius and was wrong
   * twice over. Wrong absolutely: "fewer than three neighbors within 60 m"
   * describes an ordinary house in a village where the plots are 80 m apart,
   * so on exactly the rural areas these cards are printed for it marked almost
   * everything. And wrong procedurally: it excluded buildings as it went and
   * let later ones see the thinned-out result, so marks cascaded outward from
   * the first sparse corner and pressing the button twice marked a different,
   * larger set than pressing it once.
   *
   * Both are fixed by measuring against the whole neighborhood instead of a
   * constant. Every building's distance to its k-th nearest neighbor is
   * computed once, over the entire pool and independent of what is already
   * excluded, and a building is an outlier when that distance is several times
   * the median for the area. A dense town and a strung-out hamlet each get
   * judged by their own spacing, the answer does not depend on the order of
   * the loop, and pressing the button again is a no-op.
   *
   * The absolute floor is the one thing left that is not relative: in a
   * terrace where the median gap is 12 m, three times that is still a house
   * next door, and nothing at all should be called isolated inside 120 m.
   */
  function markOutliers() {
    if (!_pool || !_ignored) return 0;
    var marked = 0;
    outliersIn(_pool).forEach(function (entry) {
      // The flag is permanent for the session even when the exclusion is not:
      // putting a building back should not make it identical to the four
      // thousand that were never in question, or finding it again — to check
      // the decision, or to change it back — means hunting for it.
      _flagged.add(entry.key);
      if (_ignored.has(entry.key)) return;
      _ignored.add(entry.key);
      marked++;
    });
    _selectionChanged();
    return marked;
  }

  /**
   * Which of `entries` are unusually isolated.
   *
   * Pure, and takes the whole set rather than the un-excluded remainder, which
   * is what makes pressing the button twice a no-op.
   *
   * @param {Array} entries objects carrying a `centroid`
   * @returns {Array} the subset to exclude, in input order
   */
  function outliersIn(entries) {
    if (!entries || entries.length < 3) return [];

    var k = Math.max(1, s.TRIM_OUTLIER_NEIGHBORS || 3);
    var spacing = _neighborDistances(entries, k);
    var median = _median(spacing);
    var threshold = Math.max(
      median * (s.TRIM_OUTLIER_FACTOR || 3),
      s.TRIM_OUTLIER_MIN_M || 120,
    );

    var out = entries.filter(function (entry, index) {
      return spacing[index] > threshold;
    });
    console.log(
      ">>> Outliers: median spacing",
      Math.round(median),
      "m, threshold",
      Math.round(threshold),
      "m,",
      out.length,
      "of",
      entries.length,
    );
    return out;
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
    if (e.button !== 0) return;
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
      areaBefore: _area(outer),
      areaAfter: _area(final),
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

  function _area(feature) {
    try {
      return turf.area(feature);
    } catch (e) {
      return 0;
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // PREVIEW
  // ══════════════════════════════════════════════════════════════════════

  /** Recompute after the dust settles; a slider drag fires far too often. */
  function _schedule(delay) {
    clearTimeout(_timer);
    _timer = setTimeout(
      _recompute,
      delay === undefined ? s.TRIM_DEBOUNCE_MS || 220 : delay,
    );
  }

  function _recompute() {
    if (!s.trimMode || _busy) return;
    _busy = true;
    var started = Date.now();
    try {
      _result = compute();
    } catch (e) {
      console.error(">>> Trim failed:", e);
      _result = { error: "failed" };
    }
    _busy = false;
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

    // The area being given up, which is the thing being decided. Drawn under
    // the proposal so the two outlines do not fight over the same pixels.
    try {
      var outer = G.getOuterFeature(s.outerPolygonLayer);
      var lostShape = G.difference(outer, _result.feature);
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

    var follow = D.role(_toolbar, "follow");
    follow.checked = !!s.trimFollow;
    follow.addEventListener("change", function () {
      s.trimFollow = !!follow.checked;
      _schedule(0);
    });

    D.onRole(_toolbar, "apply", apply);
    D.onRole(_toolbar, "outliers", function () {
      var marked = markOutliers();
      if (marked === 0) alert(T("trim.noOutliers"));
    });
    D.onRole(_toolbar, "clear", clearSelection);
    D.onRole(_toolbar, "cancel", function () {
      if (s.trimMode) toggle();
    });

    _syncReach();
    _syncDetail();
    _updateStatus();
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
    var kept = _flagged ? _flagged.size - ignoredCount() : 0;
    if (kept > 0) count += " · " + T("trim.flaggedCount", { count: kept });
    D.text(_toolbar, "count", count);

    var ready = false;
    var status;

    if (!_result) {
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
   * Territories are clipped rather than discarded: trimming is usually the
   * step before partitioning, but nothing stops it being used afterwards, and
   * throwing away a hand-corrected partition to shave a field off the edge
   * would be an expensive surprise. A territory whose shape actually changed
   * loses its printed mark, for the same reason a cut one does — the card in
   * somebody's hand no longer matches the ground.
   */
  function _install(poly) {
    if (App.history) App.history.push();

    var layer = G.toLayer(poly.geometry, App.polygons.OUTER_STYLE);
    if (!layer) {
      alert(T("trim.failed"));
      return;
    }
    layer.on("click", function (e) {
      L.DomEvent.stopPropagation(e);
    });

    s.outerPolygonLayerGroup.clearLayers();
    s.outerPolygonLayerGroup.addLayer(layer);
    s.outerPolygonLayer = layer;
    s.outerPolygonDrawn = true;
    App.polygons.attachOuterEvents(layer);

    var kept = [];
    App.polygons.clusterFeatures().forEach(function (feature) {
      var before = _area(feature);
      var clipped = null;
      try {
        clipped = G.intersect(feature, poly);
      } catch (e) {
        clipped = null;
      }
      if (!clipped || !clipped.geometry) return;
      var after = _area(clipped);
      if (after < (s.MIN_REMAINDER_M2 || 50)) return;

      var properties = Object.assign({}, feature.properties || {});
      if (Math.abs(after - before) > 1) delete properties.printed;
      kept.push({
        type: "Feature",
        geometry: clipped.geometry,
        properties: properties,
      });
    });

    if (s.trimMode) toggle();

    App.polygons.setClusters(kept);
    if (s.clusters.length === 0) App.polygons.ensureDefaultCluster();
    App.controls.refresh();

    console.log(
      ">>> Boundary trimmed —",
      Math.round(_area(poly)),
      "m², ",
      s.clusters.length,
      "territories kept",
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // KEYBOARD
  // ══════════════════════════════════════════════════════════════════════

  function _onKeyDown(e) {
    if (!s || !s.trimMode || !e.key) return;
    var tag = ((e.target || {}).tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

    if (e.key === "Escape") {
      toggle();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      apply();
      return;
    }
    if (!e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "f") {
      e.preventDefault();
      s.trimFollow = !s.trimFollow;
      if (_toolbar) D.role(_toolbar, "follow").checked = s.trimFollow;
      _schedule(0);
    }
  }

  return {
    init: init,
    toggle: toggle,
    isActive: isActive,
    isIgnored: isIgnored,
    isFlagged: isFlagged,
    ignoredCount: ignoredCount,
    detailM: detailM,
    handleBuildingClick: handleBuildingClick,
    markOutliers: markOutliers,
    outliersIn: outliersIn,
    clearSelection: clearSelection,
    compute: compute,
    propose: propose,
    apply: apply,
  };
})();

window.App = App;
