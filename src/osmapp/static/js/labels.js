/**
 * labels.js — numbered chips on each polygon part, and the territory list.
 *
 * The info panel reports `s.clusters.length`, which is correct but often does
 * not match what can be counted on screen, for three legitimate reasons:
 *
 *   • A territory can be too small to see. The partitioner drops orphan
 *     fragments below 5% of an average territory but keeps everything above
 *     that; the knife keeps pieces down to CUT_MIN_PIECE_M2. At a village
 *     zoom a 400 m² leftover is a few pixels of purple against a purple
 *     neighbor — counted and printable, effectively invisible.
 *   • Adjacent territories share an outline. Fifteen tiling a village read as
 *     one purple mass with lines through it, and the eye undercounts lines.
 *   • A territory can be in more than one piece. `_enforceConnectivity` makes
 *     this rare rather than impossible, and merge can produce it outright by
 *     unioning two shapes that do not touch — the same confusion in the
 *     opposite direction, with more shapes on the map than in the count.
 *
 * So there is one numbered chip per polygon *part*, with all parts of a
 * territory carrying the same number. Distinct numbers match the panel's
 * count, chips match the shapes on screen, and a repeated number explains the
 * difference. The numbering is the one the hover tooltip uses ("Territory 7").
 *
 * A chip is a handle on its territory rather than decoration, and two things
 * follow:
 *
 *   • It is clickable, hoverable, right-clickable and selectable, taking all
 *     of that from `polygons.attachProxyEvents` rather than a second copy of
 *     the handlers. On a territory a few pixels wide the chip is the only
 *     thing that can realistically be clicked. It goes inert in cut mode,
 *     where the pointer is a drawing instrument and anything clickable on the
 *     map is one more thing for the knife to catch on.
 *   • It lives in `innerPolygonsLayerGroup` with the territories rather than
 *     in a layer group of its own, so the View group's Shapes switch covers
 *     it and nothing can outlive a rebuild. Drawing the numbers is its own
 *     switch in that group, because the chips can be wanted without the
 *     shapes and not the other way round.
 *
 * The chip also carries the printed check, anchored at the same interior
 * point the number is. Keeping the check on the chip preserves the non-color
 * channel it exists for: on a territory too small to see, the chip turns red
 * rather than green and the check is the only thing on screen saying the card
 * is done.
 */

var App = window.App || {};
App._loaded = App._loaded || [];

App.labels = (function () {
  "use strict";

  var s = null;
  var G = null;
  var D = null;
  var T = null;

  var VISIBLE_KEY = "osmapp.labels.visible";

  /**
   * One row per territory, rebuilt by refresh():
   *   { index, area, parts, printed, anchors: [{ latlng, bbox, tiny, marker }] }
   * The buildings/streets counts are deliberately *not* cached here — they
   * live on the cluster entry and are filled in later by refreshFilteredData,
   * so the list reads them at open time instead.
   */
  var _rows = [];
  var _visible = true;
  var _dialog = null;
  // Which rows the list is showing, how far the jump button has walked through
  // the flagged ones, and which territories are picked out. All three belong
  // to an open dialog rather than to the territories, so openList() resets
  // them and _renderList() does not.
  //
  // Each filter axis is a question with three answers: 0 don't care, 1 only
  // these, -1 only the others. They are separate questions rather than one
  // list of choices, so "printed, and still has something wrong with it" is
  // two clicks and needs no entry of its own.
  var _axes = { repair: 0, printed: 0 };
  var _jumpAt = -1;
  // Territory indices, and the row a range extends from. The selection is by
  // index rather than by feature because it is only alive while the dialog is,
  // and the dialog is rebuilt from indices.
  var _picked = [];
  var _anchor = null;
  var _cursor = null;
  var _reopening = false;
  // Whether the rows box has been given its floor for this opening. See
  // _pinRows.
  var _pinned = false;
  // The uncovered ground the rows on screen were drawn from, so a recount
  // that found the same thing again does not rebuild them. See refreshList.
  var _gapsShown = null;
  // The last audit, kept until the territories themselves change. Working it
  // out costs a rehearsed repair per empty territory; the answer cannot move
  // because somebody clicked a row or a filter.
  var _audit = null;

  // A double click arrives as two clicks and then a dblclick, so the first of
  // the pair has already changed the selection before anything can know it was
  // half of a gesture rather than a whole one. The selection as it stood
  // before the pair is kept here and put back, because zooming to a territory
  // is a look rather than a decision and should leave the picking alone.
  var DBLCLICK_MS = 300;
  var _clickAt = 0;
  var _beforeClick = null;
  var _pulsed = null;
  var _pulseTimer = null;

  function init() {
    s = App.state;
    G = App.geometry;
    D = App.dom;
    T = App.i18n.t;

    _visible = _storedVisible();

    // "Too small to see" is a statement about the current zoom, not about the
    // territory, so it is re-decided whenever the zoom changes.
    s.leafletMap.on("zoomend", _syncTiny);

    App.i18n.onChange(function () {
      refresh();
      if (_dialog) openList();
    });

    App._loaded.push("labels");
  }

  // ══════════════════════════════════════════════════════════════════════
  // VISIBILITY
  // ══════════════════════════════════════════════════════════════════════

  function _storedVisible() {
    // Visible unless explicitly switched off, so a first visit and an
    // unavailable store both show the numbers.
    return App.util.readLocal(VISIBLE_KEY, "1") !== "0";
  }

  function isVisible() {
    return _visible;
  }

  function setVisible(visible) {
    _visible = !!visible;
    App.util.writeLocal(VISIBLE_KEY, _visible ? "1" : "0");
    refresh();
  }

  // ══════════════════════════════════════════════════════════════════════
  // BUILDING THE CHIPS
  // ══════════════════════════════════════════════════════════════════════

  /**
   * A point guaranteed to be inside the part, as a Leaflet LatLng.
   *
   * Not the centroid: a C-shaped or doughnut territory puts its centroid in
   * the hole, and a number floating over a neighbor is worse than no number.
   * G.interiorPoint promises interior, and is the same call clustering.js
   * assigns pieces with — so a chip never lands on a piece that was counted
   * as somebody else's.
   */
  function _interiorPoint(part) {
    var c = G.interiorCoord(part);
    return c ? L.latLng(c[1], c[0]) : null;
  }

  /** Longest on-screen edge of a part's bounding box, in pixels. */
  function _pixelSpan(bbox) {
    if (!bbox || !s.leafletMap) return Infinity;
    try {
      var a = s.leafletMap.latLngToContainerPoint(L.latLng(bbox[1], bbox[0]));
      var b = s.leafletMap.latLngToContainerPoint(L.latLng(bbox[3], bbox[2]));
      return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
    } catch (e) {
      return Infinity;
    }
  }

  function _isTiny(bbox) {
    return _pixelSpan(bbox) < (s.TINY_TERRITORY_PX || 24);
  }

  /** The chip body: a check when the card is done, then the number. */
  function _body(number, flags) {
    var check = flags.printed
      ? '<i class="fa-solid fa-check territory-label__check" aria-hidden="true"></i>'
      : "";
    return check + App.i18n.n(number);
  }

  function _classes(flags) {
    var cls = ["territory-label"];
    if (flags.printed) cls.push("territory-label--printed");
    if (flags.part) cls.push("territory-label--part");
    if (flags.tiny) cls.push("territory-label--tiny");
    if (flags.selected) cls.push("territory-label--selected");
    // Cut mode: still visible, no longer a pointer target.
    if (flags.inert) cls.push("territory-label--static");
    return cls.join(" ");
  }

  /**
   * The chip.
   *
   * iconSize [0, 0] rather than a fixed box: a three-digit number is wider
   * than a one-digit one, and a fixed iconAnchor would push wide chips off
   * centre. At zero size Leaflet drops the element exactly on the point and
   * CSS centres the chip above it with a stem back down to the anchor, so
   * every chip points at its own territory no matter how wide it is.
   */
  function _icon(number, flags) {
    return L.divIcon({
      className: "territory-label-wrap",
      html:
        '<span class="' +
        _classes(flags) +
        '">' +
        _body(number, flags) +
        "</span>",
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
  }

  /** The chip element inside a marker, or null before it is on the map. */
  function _chip(marker) {
    var element = marker && marker.getElement && marker.getElement();
    return (element && element.firstElementChild) || null;
  }

  function _describe(entry, index) {
    var parts = [];
    try {
      parts = G.polygonParts(entry.feature);
    } catch (e) {
      parts = [];
    }

    var area = 0;
    try {
      area = turf.area(entry.feature);
    } catch (e) {
      /* unmeasurable geometry */
    }

    var anchors = [];
    // Largest first, so the plain chip lands on the piece people think of as
    // the territory and the dashed "also this one" chips land on the scraps.
    parts
      .map(function (part) {
        var size = 0;
        try {
          size = turf.area(part);
        } catch (e) {
          /* keep it, unmeasured */
        }
        return { part: part, size: size };
      })
      .sort(function (a, b) {
        return b.size - a.size;
      })
      .forEach(function (item) {
        var latlng = _interiorPoint(item.part);
        if (!latlng) return;
        var bbox = null;
        try {
          bbox = turf.bbox(item.part);
        } catch (e) {
          bbox = null;
        }
        anchors.push({
          latlng: latlng,
          bbox: bbox,
          area: item.size,
          tiny: _isTiny(bbox),
          marker: null,
        });
      });

    return {
      index: index,
      area: area,
      parts: anchors.length,
      printed: App.polygons.isPrinted(entry.feature),
      anchors: anchors,
    };
  }

  /** Drop the chips this module put on the map, and nothing else. */
  function _clear() {
    _rows.forEach(function (row) {
      row.anchors.forEach(function (anchor) {
        if (anchor.marker) s.innerPolygonsLayerGroup.removeLayer(anchor.marker);
      });
    });
    _rows = [];
  }

  /**
   * Rebuild every chip from s.clusters.
   *
   * Called from the one place cluster membership changes (setClusters) plus
   * the ones that change it without going through there — deleteCluster, the
   * two print-mark writers, and setTooltipMode, which is how entering and
   * leaving cut mode reaches the chips.
   *
   * The markers are removed one by one rather than with clearLayers(): the
   * group is shared with the territories themselves, and clearing it here
   * would take the map with it.
   */
  function refresh() {
    if (!s || !s.innerPolygonsLayerGroup) return;

    _clear();
    // Every cluster change lands here, and every cluster change is exactly
    // what can move the answer.
    _audit = null;

    var inert = !!s.editMode;

    // Described whether or not the chips are drawn. The rows are the audit —
    // the count, the too-small warning, the list dialog — and all of that is
    // about the territories rather than about the numbers. Returning early on
    // `!_visible` would leave _rows empty, so switching the numbers off would
    // silently take the info panel's warning with them.
    _rows = (s.clusters || []).map(_describe);

    if (_visible) {
      _rows.forEach(function (row) {
        var entry = s.clusters[row.index];

        row.anchors.forEach(function (anchor, part) {
          var marker = L.marker(anchor.latlng, {
            icon: _icon(row.index + 1, {
              printed: row.printed,
              part: part > 0,
              tiny: anchor.tiny,
              selected: !!entry.layer._selected,
              inert: inert,
            }),
            interactive: !inert,
            keyboard: false,
            // Well above anything else this group holds, so a chip is never
            // the thing hidden when two territories nearly coincide.
            zIndexOffset: 700,
          });
          anchor.marker = marker;
          s.innerPolygonsLayerGroup.addLayer(marker);

          if (inert) return;
          App.polygons.attachProxyEvents(
            marker,
            entry.layer,
            entry.feature,
            function (on) {
              var chip = _chip(marker);
              if (chip) chip.classList.toggle("territory-label--hover", on);
            },
          );
        });
      });
    }
  }

  /** Repaint one territory's chips as selected or not. */
  function setSelected(layer, selected) {
    var index = -1;
    for (var i = 0; i < (s.clusters || []).length; i++) {
      if (s.clusters[i].layer === layer) {
        index = i;
        break;
      }
    }
    var row = _rows[index];
    if (!row) return;
    row.anchors.forEach(function (anchor) {
      var chip = _chip(anchor.marker);
      if (chip) chip.classList.toggle("territory-label--selected", !!selected);
    });
  }

  /**
   * Re-decide after a zoom which chips have outgrown their territory.
   *
   * A drawing decision about a marker, and nothing more since the list stopped
   * carrying a "too small to see" flag: that described the viewport rather
   * than anything wrong with a territory, it emptied the moment you zoomed in,
   * and autoheal could never repair it — so it sat among the two flags that
   * are real faults and made them look like housekeeping.
   */
  function _syncTiny() {
    _rows.forEach(function (row) {
      row.anchors.forEach(function (anchor) {
        var tiny = _isTiny(anchor.bbox);
        if (tiny === anchor.tiny) return;
        anchor.tiny = tiny;
        var chip = _chip(anchor.marker);
        if (chip) chip.classList.toggle("territory-label--tiny", tiny);
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // THE AUDIT
  // ══════════════════════════════════════════════════════════════════════

  function rows() {
    return _rows.slice();
  }

  /**
   * The number shown on a territory, 1-based, or null when the feature is not
   * one of the current clusters.
   *
   * Identity rather than geometry: the same feature object is carried through
   * cuts, merges and the session store, and after an undo two territories can
   * legitimately have identical shapes.
   */
  function numberOf(feature) {
    if (!feature || !s || !s.clusters) return null;
    for (var i = 0; i < s.clusters.length; i++)
      if (s.clusters[i].feature === feature) return i + 1;
    return null;
  }

  /**
   * Why the territories are worth a second look, as three numbers.
   *
   * `tiny` is territories with no part big enough to notice at this zoom and
   * `split` is territories drawn as more than one shape: both explain a
   * disagreement between the count in the info panel and what can be counted
   * on screen, and both are legitimate states rather than errors.
   *
   * `empty` is different in kind. A territory with no buildings in it is not
   * a counting problem — it looks perfectly ordinary on the map — it is a card
   * that sends somebody to walk a strip of embankment. It is read live off the
   * cluster entries rather than off `_rows`, because the counts are filled in
   * by refreshFilteredData *after* the rows are built.
   *
   * `crossed` is a boundary drawn straight through a building, so that one
   * house is half in one territory and half in the next. It is the one fault
   * here that is invisible at the zoom the list is usually read at, and the
   * one that costs two people a walk each: two cards get printed showing the
   * same roof. autoheal answers it from a cached survey of the whole map, so
   * asking per row costs nothing after the first.
   *
   * `uncovered` is not about a territory at all: it is ground inside the
   * boundary that is in no territory (see gaps.js). It is counted here rather
   * than given a row of its own in the info panel, because a second number
   * there is a second place to look and a second thing to explain — for a fault
   * whose repair, its flag and its place on the map all live in the list. One
   * mark on the one count, and the list says which of the three it is.
   *
   * All of them are what App.autoheal repairs, or declines to; see there for
   * why `tiny` is the one it leaves alone.
   */
  function warnings() {
    var split = 0;
    var empty = 0;
    var crossed = 0;
    _rows.forEach(function (row) {
      if (row.parts > 1) split++;
      if (_isEmpty(row.index)) empty++;
      if (_isCrossed(row.index)) crossed++;
    });
    var uncovered = _gaps().length;
    return {
      split: split,
      empty: empty,
      crossed: crossed,
      uncovered: uncovered,
      total: split + empty + crossed + uncovered,
    };
  }

  /**
   * The pieces of ground in no territory, largest first.
   *
   * Read from gaps.js at the moment it is asked rather than cached, because
   * the recount lands two hundred milliseconds after whatever changed the
   * coverage, and a list holding a copy would go on offering a piece that had
   * just become a territory.
   */
  function _gaps() {
    if (!App.gaps || !App.gaps.features) return [];
    return App.gaps.features() || [];
  }

  /** Whether territory `index` holds no buildings; false when unknowable. */
  function _isEmpty(index) {
    if (!App.autoheal) return false;
    return App.autoheal.isEmpty((s.clusters || [])[index]) === true;
  }

  /** How many buildings territory `index`'s boundary is drawn through. */
  function _crossed(index) {
    if (!App.autoheal || !App.autoheal.crossed) return 0;
    return App.autoheal.crossed(index);
  }

  function _isCrossed(index) {
    return _crossed(index) > 0;
  }

  // ══════════════════════════════════════════════════════════════════════
  // FINDING ONE
  // ══════════════════════════════════════════════════════════════════════

  function _restorePulse() {
    _pulseTimer = null;
    var layer = _pulsed;
    _pulsed = null;
    if (!layer) return;
    layer._hover = false;
    App.polygons.refreshStyle(layer);
    var element = layer.getElement && layer.getElement();
    if (element) element.classList.remove("territory-pulse");
  }

  /**
   * Two channels again: the fill brightens (works everywhere) and the outline
   * animates (works where an SVG element exists, which is the default
   * renderer). Either alone is easy to miss on a map that has just moved.
   */
  function _pulse(layer) {
    if (_pulseTimer) {
      window.clearTimeout(_pulseTimer);
      _restorePulse();
    }
    _pulsed = layer;
    layer._hover = true;
    App.polygons.refreshStyle(layer);
    var element = layer.getElement && layer.getElement();
    if (element) element.classList.add("territory-pulse");
    _pulseTimer = window.setTimeout(_restorePulse, 2400);
  }

  /** Zoom to territory `index` (0-based) and flash it. */
  function focus(index) {
    var entry = s.clusters[index];
    if (!entry || !entry.layer) return false;
    var bounds;
    try {
      bounds = entry.layer.getBounds();
    } catch (e) {
      return false;
    }
    if (!bounds || !bounds.isValid()) return false;

    s.leafletMap.fitBounds(bounds, { padding: [60, 60], maxZoom: 19 });
    _pulse(entry.layer);
    return true;
  }

  // ══════════════════════════════════════════════════════════════════════
  // THE LIST
  // ══════════════════════════════════════════════════════════════════════

  function _areaText(area) {
    if (!(area > 0)) return T("list.areaUnknown");
    return area >= 1e6
      ? T("tooltip.areaKm", { value: App.i18n.n(Math.round(area / 1e4) / 100) })
      : T("tooltip.areaM", { value: App.i18n.n(Math.round(area)) });
  }

  function _flag(host, icon, cls, title) {
    var node = document.createElement("i");
    node.className = "fa-solid " + icon + " territory-row__flag " + cls;
    node.setAttribute("title", title);
    node.setAttribute("aria-label", title);
    // An <i> carries no role, and an aria-label on an element with no role is
    // not required to be announced — which made the flags decoration for
    // anyone not looking at them, on a row whose whole purpose is to say that
    // something is wrong with this territory.
    node.setAttribute("role", "img");
    host.appendChild(node);
  }

  /**
   * Every counted territory as a row you can click.
   *
   * This is the answer to "where are they?" — the count becomes a list, the
   * list becomes a place on the map. Rows stay in index order because that is
   * the order the chips and the tooltips number them in; sorting by area
   * would put the interesting ones on top and break the correspondence.
   *
   * Built from s.clusters rather than from _rows, so the list is complete
   * even with the chips switched off.
   */
  function openList() {
    // Re-opening rather than opening: the language switcher rebuilds this
    // dialog in place, and openDialog() tears the old one down on the way.
    // Without the distinction that teardown would hand the selection to the
    // map halfway through a re-render, and the reset below would then throw
    // the selection away — losing it because somebody changed language.
    var reopening = _dialog !== null;
    _reopening = reopening;
    _gapsShown = null;
    // A new dialog node, so the floor measured onto the old one went with it.
    _pinned = false;
    var dialog = App.ui.openDialog("tpl-territory-list", function () {
      App.shortcuts.pop("list");
      _dialog = null;
      if (_reopening) return;
      _handOver();
    });
    _reopening = false;
    _dialog = dialog;

    D.onRole(dialog, "close", function () {
      App.ui.closeDialog();
    });

    // Wired once, outside _renderList: a repair rebuilds the rows and nothing
    // else, so a handler attached per render would fire twice after the first
    // repair and three times after the second.
    var toggle = D.role(dialog, "show-numbers");
    if (toggle) {
      toggle.addEventListener("change", function () {
        setVisible(toggle.checked);
        if (App.controls) App.controls.refresh();
      });
    }

    D.onRole(dialog, "fix-all", function () {
      _fix(null, D.role(dialog, "fix-all"));
    });

    // A fresh opening shows everything and has nothing picked. Carrying either
    // over from last time would mean opening the list and finding most of the
    // territories missing, or a dozen of them selected, with the reason two
    // controls up the dialog. A re-render in the same sitting keeps both.
    if (!reopening) {
      _axes = { repair: 0, printed: 0 };
      _jumpAt = -1;
      // Seeded from whatever the map is already holding, so the round trip
      // closes: open the list on a live selection and it shows that selection,
      // adjust it here, close, and the map has what the list last said. Two
      // ideas of "selected" — one on the map, one in the dialog — would drift
      // the moment either changed.
      _picked = _pickedOnMap();
      _anchor = null;
      _cursor = null;
    }

    var chips = dialog.querySelectorAll("[data-axis]");
    Array.prototype.forEach.call(chips, function (chip) {
      chip.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        var axis = chip.dataset.axis;
        // Round the three states and back to the start, so one control can be
        // turned off the same way it was turned on.
        _axes[axis] = _axes[axis] === 0 ? 1 : _axes[axis] === 1 ? -1 : 0;
        // The walk is through what is on screen, so a narrower list restarts
        // it rather than resuming somewhere the rows no longer are.
        _jumpAt = -1;
        _renderList(dialog);
      });
    });

    D.onRole(dialog, "jump", function () {
      _jump(dialog);
    });

    D.onRole(dialog, "clear-selection", function () {
      _picked = [];
      _anchor = null;
      _cursor = null;
      _beforeClick = null;
      _paintSelection(dialog);
    });

    // The last screen in the app that took over without registering anything,
    // so "?" over it listed the keys of the map underneath and said nothing
    // about the list itself. N is the same letter the toolbar uses for the
    // same switch, which is the point of having one.
    App.shortcuts.push({
      id: "list",
      titleKey: "shortcuts.groupList",
      exclusive: true,
      entries: [
        {
          combos: ["N"],
          labelKey: "shortcuts.listNumbers",
          run: function () {
            if (!toggle) return;
            toggle.checked = !toggle.checked;
            setVisible(toggle.checked);
            if (App.controls) App.controls.refresh();
          },
        },
        {
          combos: ["J"],
          labelKey: "shortcuts.listJump",
          run: function () {
            _jump(dialog);
          },
        },
        {
          // Select-all over what is *shown*, which is what makes it worth
          // having next to the filters: narrow to the unprinted ones, take
          // all of them, close, and the map is holding exactly those.
          combos: ["Mod+A"],
          labelKey: "shortcuts.listSelectAll",
          run: function () {
            _selectAllShown(dialog);
          },
        },
        {
          combos: ["ArrowDown", "ArrowUp"],
          labelKey: "shortcuts.listMove",
          run: function (e) {
            _step(dialog, e && e.key === "ArrowUp" ? -1 : 1, false);
          },
        },
        {
          combos: ["Shift+ArrowDown", "Shift+ArrowUp"],
          labelKey: "shortcuts.listExtend",
          run: function (e) {
            _step(dialog, e && e.key === "ArrowUp" ? -1 : 1, true);
          },
        },
        { combos: ["Mod+Click"], labelKey: "shortcuts.listPick", note: true },
        {
          combos: ["Double-click"],
          labelKey: "shortcuts.listZoom",
          note: true,
        },
        {
          combos: ["Shift+Click"],
          labelKey: "shortcuts.listRange",
          note: true,
        },
        {
          combos: ["Escape"],
          labelKey: "shortcuts.listClose",
          run: function () {
            App.ui.closeDialog();
          },
        },
      ],
    });

    _renderList(dialog);
  }

  /**
   * Redraw the list, if one is open.
   *
   * For gaps.js, whose recount lands two hundred milliseconds after whatever
   * changed the coverage — long after the dialog was drawn. Without this, a
   * gap adopted from the map, a boundary dragged outward, or an undo would
   * leave the list showing a piece of ground that no longer exists, or hiding
   * one that had just appeared. Pushed from there rather than polled from
   * here, because that is the one place the answer changes.
   */
  function refreshList() {
    if (!_dialog) return;
    // Only when the answer actually moved. A recount runs after anything that
    // touches the coverage and returns fresh objects describing the same
    // ground, and rebuilding on every one of them tore the rows out from under
    // whoever was clicking them — the row nodes are what the selection, the
    // keyboard walk and the scroll position all hang off, so a rebuild for no
    // reason is a selection lost for no reason.
    if (_gapMark() === _gapsShown) return;

    // Whoever closed a gap from the keyboard was standing on a row that is
    // about to stop existing, and a focus left on a detached node sends the
    // next Tab back to the top of the page rather than into the list.
    var here = document.activeElement;
    var inside = !!(here && _dialog.contains(here));

    _renderList(_dialog);

    if (inside && !_dialog.contains(document.activeElement))
      _focusFirst([
        D.role(_dialog, "fix-all"),
        D.role(_dialog, "close"),
      ]);
  }

  /**
   * What the uncovered ground currently is, as a string worth comparing.
   *
   * Areas rather than identities: gaps.js rebuilds its features from scratch
   * on every recount, so the objects are always new and only the shapes say
   * whether anything happened.
   */
  function _gapMark() {
    return _gaps()
      .map(function (feature) {
        try {
          return Math.round(G.area(feature));
        } catch (e) {
          return "?";
        }
      })
      .join(",");
  }

  /**
   * Fill an already-open list dialog from the current territories.
   *
   * Separate from openList() because a repair changes the list and must not
   * change the screen around it. Re-opening the dialog put the scroll back to
   * the top and the focus back on the first thing in it, which for a list of
   * forty territories means finding your place again after every click — and
   * the rows you are working through are exactly the ones near the bottom,
   * because those are the ones nobody has got to yet.
   *
   * @param {Element} dialog
   * @param {{status?: string}} [opts] a sentence for the live region
   */
  function _renderList(dialog, opts) {
    var entries = s.clusters || [];
    var all = entries.map(function (entry, index) {
      return _rows[index] || _describe(entry, index);
    });
    var shown = all.filter(_matchesFilter);
    // Uncovered ground answers the same two questions every row does — it is
    // always something to repair, and it is never printed — so it goes
    // through the same filter rather than past it.
    var gaps = _gaps();
    var shownGaps = _matchesGapFilter() ? gaps : [];
    _gapsShown = _gapMark();

    var toggle = D.role(dialog, "show-numbers");
    if (toggle) toggle.checked = isVisible();

    _paintChips(dialog);

    D.text(
      dialog,
      "total",
      _filtering()
        ? T("list.showing", { shown: shown.length, total: all.length })
        : T("list.total", { count: all.length }),
    );
    D.text(dialog, "outcome", (opts && opts.status) || "");

    var warn = warnings();
    var notes = [];
    if (warn.split > 0) notes.push(T("list.warnSplit", { n: warn.split }));
    if (warn.empty > 0) notes.push(T("list.warnEmpty", { n: warn.empty }));
    if (warn.crossed > 0)
      notes.push(T("list.warnCrossed", { n: warn.crossed }));
    if (warn.uncovered > 0)
      notes.push(T("list.warnUncovered", { n: warn.uncovered }));
    D.text(dialog, "notes", notes.join(" "));
    D.toggleRole(dialog, "notes", notes.length > 0);

    // The repair offer, per row and for the list as a whole. `fixable` is not
    // the same as `flagged`: a territory too small to see is flagged and not
    // fixable, and an empty one no neighbor can take is flagged and not
    // fixable either. autoheal answers it by rehearsing the repair rather than
    // by guessing at it, so a wand that is shown always does something.
    if (!_audit)
      _audit = App.autoheal ? App.autoheal.audit() : { rows: [], fixable: 0 };
    var audit = _audit;
    var fixable = {};
    audit.rows.forEach(function (issue) {
      if (issue.fixable) fixable[issue.index] = true;
    });
    // Uncovered ground is always fixable — adopting a piece of it produces a
    // territory that was not there a moment ago — so it needs no rehearsal
    // and counts towards the offer on its own.
    D.toggleRole(dialog, "fix-all", audit.fixable > 0 || gaps.length > 0);

    var host = D.role(dialog, "rows");
    host.textContent = "";
    // "There are none" and "none of them match" are different answers, and
    // offering the first when the second is true sends somebody looking for
    // territories that are sitting right there behind a filter.
    D.toggleRole(dialog, "empty", all.length === 0 && gaps.length === 0);
    D.toggleRole(
      dialog,
      "no-match",
      all.length + gaps.length > 0 && shown.length + shownGaps.length === 0,
    );

    shown.forEach(function (row) {
      var entry = entries[row.index];
      var node = D.mount("tpl-territory-row", host);

      D.text(node, "num", App.i18n.n(row.index + 1));
      D.text(node, "main", _areaText(row.area));

      var counts = entry && entry.counts;
      D.text(
        node,
        "meta",
        counts
          ? T("tooltip.buildings", { count: App.i18n.n(counts.buildings) }) +
              " · " +
              T("tooltip.streets", { count: App.i18n.n(counts.streets) })
          : T("tooltip.noData"),
      );

      var flags = D.role(node, "flags");
      if (row.printed)
        _flag(flags, "fa-circle-check", "is-printed", T("list.flagPrinted"));
      if (row.parts > 1)
        _flag(
          flags,
          "fa-puzzle-piece",
          "is-split",
          T("list.flagSplit", { n: row.parts }),
        );
      if (_isEmpty(row.index))
        _flag(flags, "fa-house-circle-xmark", "is-empty", T("list.flagEmpty"));
      var crossed = _crossed(row.index);
      if (crossed > 0)
        _flag(
          flags,
          "fa-house-chimney-crack",
          "is-crossed",
          T("list.flagCrossed", { count: crossed }),
        );

      // The row is addressed by its number rather than by its position in the
      // DOM, so a repair can put the focus back on the same territory even
      // after everything below it has been renumbered.
      node.dataset.territory = String(row.index);
      // And marked here rather than recomputed by the jump, so the walk is a
      // querySelectorAll over what is on screen and cannot drift from the
      // flags the row is actually showing.
      if (_isFlagged(row)) node.dataset.flagged = "1";

      D.toggle(D.role(node, "fix"), !!fixable[row.index]);
      D.onRole(node, "fix", function (e, button) {
        _fix(row.index, button);
      });

      // A list where clicking selects and double-clicking opens, which is what
      // every other list anybody uses does. Zooming to the territory was on
      // the single click while the list had no selection to speak of; now it
      // has one, and a click that both picks a row and throws the dialog away
      // can only be one of the two.
      D.onRole(node, "go", function (e) {
        if (e && e.shiftKey) {
          _extendTo(dialog, row.index);
          return;
        }
        if (e && (e.ctrlKey || e.metaKey)) {
          _togglePick(dialog, row.index);
          return;
        }
        _pickOnly(dialog, row.index);
      });

      var go = D.role(node, "go");
      if (go)
        go.addEventListener("dblclick", function (e) {
          e.preventDefault();
          e.stopPropagation();
          _openRow(row.index);
        });

      // The list is the answer to "which fourteen?", and the next question is
      // always "print that one".
      D.onRole(node, "print", function () {
        if (!entry || !entry.feature) return;
        App.ui.closeDialog();
        App.print.printCluster(entry.feature);
      });
    });

    // After the territories rather than among them. The rows are in territory
    // order because that is the order the chips on the map are numbered in,
    // and a piece of ground with no number cannot take a place in that
    // sequence without pushing every row below it away from the chip it
    // belongs to. At the end they are a section of their own, and the jump
    // button is what finds them in a list of ninety-nine.
    shownGaps.forEach(function (feature, position) {
      _gapRow(host, feature, position);
    });

    _pinHeight(dialog, host);
    _paintSelection(dialog);

    var flagged = shown.filter(_isFlagged).length + shownGaps.length;
    D.toggleRole(dialog, "jump", flagged > 0);
    D.text(dialog, "jump-count", flagged > 0 ? App.i18n.n(flagged) : "");
  }

  /**
   * One piece of uncovered ground, as a row.
   *
   * The same template as a territory, and deliberately not a second one: it is
   * the same kind of object in the same list — an area you can go and look at,
   * with something wrong with it and a button that puts it right — and a
   * separate template would be a second thing to restyle every time this one
   * changes.
   *
   * What it is *not* is a territory, so three things differ. It carries no
   * number, because there is nothing on the map numbering it. It cannot be
   * selected — the selection is handed to the map on the way out, where merge
   * and delete act on territories — so it gets no `data-territory` and stays
   * out of _shownOrder. And it cannot be printed: there is no card for ground
   * nobody has claimed yet.
   *
   * @param {Element} host the rows box
   * @param {Object} feature the gap, as gaps.js holds it
   * @param {number} position its index in gaps.features(), which is what
   *   autoheal.healGaps and gaps.dissolve are addressed by
   */
  function _gapRow(host, feature, position) {
    var node = D.mount("tpl-territory-row", host);
    node.classList.add("territory-row-wrap--uncovered");
    // Not data-territory: the keyboard walk, the range select and the
    // hand-over to the map are all about territories, and a row that answered
    // to a territory index would put a piece of unclaimed ground into a
    // selection that merge is about to act on.
    node.dataset.gap = String(position);
    node.dataset.flagged = "1";

    // The number chip is where the eye goes first, so it is the one that says
    // this row is not a territory — an exclamation where a number would be,
    // in the same orange the shape itself is drawn in on the map.
    var num = D.role(node, "num");
    if (num) {
      num.textContent = "";
      var mark = document.createElement("i");
      mark.className = "fa-solid fa-triangle-exclamation";
      mark.setAttribute("aria-hidden", "true");
      num.appendChild(mark);
    }

    var area = 0;
    try {
      area = G.area(feature);
    } catch (e) {
      /* unmeasurable geometry still deserves its row */
    }
    D.text(node, "main", _areaText(area));
    D.text(node, "meta", T("list.uncoveredMeta"));
    // Said in words as well as in color, and read out by the same mechanism
    // the other flags use.
    _flag(
      D.role(node, "flags"),
      "fa-map-location-dot",
      "is-uncovered",
      T("list.flagUncovered"),
    );

    // Adopt it and repair what that made, which is one button rather than
    // two because "make this a territory" and "and then fix the territory it
    // made" are never wanted apart. See autoheal.healGaps.
    var wand = D.role(node, "fix");
    if (wand) {
      wand.setAttribute("title", T("list.fixUncovered"));
      wand.setAttribute("aria-label", T("list.fixUncovered"));
    }
    D.toggle(wand, true);
    D.onRole(node, "fix", function () {
      _fix({ gap: position }, wand);
    });

    // The other outcome, and the more common one: most uncovered ground is
    // not worth a card, and closing it hands it to a neighbor or trims the
    // boundary back — whichever the shape calls for. gaps.js decides which.
    D.toggle(D.role(node, "print"), false);
    D.toggle(D.role(node, "dissolve"), true);
    D.onRole(node, "dissolve", function () {
      if (App.gaps) App.gaps.dissolve(feature);
    });

    // A single click goes and looks at it, where a territory needs a double.
    // There is no selection to lose here — that is what the second click of a
    // territory's pair is undoing — so making people click twice would be
    // ceremony for its own sake.
    D.onRole(node, "go", function () {
      App.ui.closeDialog();
      focusGap(feature);
    });
  }

  /**
   * Zoom to a piece of uncovered ground.
   *
   * Zoom 17 rather than the 19 a territory gets: a gap is understood by what is
   * around it — the territories it sits between — and a tighter zoom shows the
   * hole and nothing else.
   */
  function focusGap(feature) {
    if (!feature || !feature.geometry || !s.leafletMap) return false;
    var layer = G.toLayer(feature.geometry, {});
    if (!layer) return false;
    var bounds;
    try {
      bounds = layer.getBounds();
    } catch (e) {
      return false;
    }
    if (!bounds || !bounds.isValid()) return false;
    s.leafletMap.fitBounds(bounds, { padding: [60, 60], maxZoom: 17 });
    return true;
  }

  /**
   * Show which rows are picked, and nothing else.
   *
   * Deliberately not _renderList, which rebuilds every row and re-audits every
   * territory — a second of work on a real partition to move a highlight from
   * one row to another. Nothing about a selection can change which rows exist,
   * what they say, or what is wrong with them, so this walks the rows already
   * on screen and sets a flag on each.
   */
  function _paintSelection(dialog) {
    var rows = dialog.querySelectorAll("[data-territory]");
    Array.prototype.forEach.call(rows, function (node) {
      var picked = _picked.indexOf(Number(node.dataset.territory)) >= 0;
      if (picked) node.dataset.selected = "1";
      else delete node.dataset.selected;
      D.text(node, "selected-note", picked ? T("list.rowSelected") : "");
    });

    // Reusing merge's own sentence: the count means the same thing in both
    // places, and it is the same selection — the list is only where it was
    // picked.
    D.text(dialog, "selection", T("merge.selected", { count: _picked.length }));
    D.toggleRole(dialog, "selection", _picked.length > 0);
    D.toggleRole(dialog, "clear-selection", _picked.length > 0);
  }

  /**
   * Freeze the dialog at the size it opened, without making every list tall.
   *
   * The chips sit above the rows and the dialog is centred, so anything that
   * changes its height pulls it in around the control that was just clicked
   * and the next click lands somewhere else. A constant height in the
   * stylesheet answers that and costs too much: five territories, which is
   * what the sample every first-time visitor sees contains, would open a
   * 600 px dialog four fifths of which is empty box.
   *
   * So the size is the one the list opened with — measured once, then held.
   * The stylesheet decides what that natural size is, cap included; from then
   * on the dialog is that tall and the rows box takes up the slack.
   *
   * It is the *dialog* that is pinned rather than the rows box, and the
   * difference is not academic. Filtering changes more than the number of
   * rows: a chip's label grows from "Printed" to "Printed only" and the find
   * bar wraps onto a second line, which moved everything by a further 29 px
   * with the rows box alone held still. Freezing the outside and letting the
   * one flexible child absorb whatever the rest of the column does is the same
   * arrangement the print dialog uses, and it covers the cases nobody thought
   * to enumerate.
   *
   * Measured rather than counted because a row's height is a stylesheet's
   * business, and reading it back is the only way not to have the number twice.
   */
  function _pinHeight(dialog, host) {
    if (!dialog || _pinned) return;
    var height = dialog.offsetHeight;
    if (height <= 0) return;
    dialog.style.height = height + "px";
    // The cap existed to decide the natural size. That is decided now, and the
    // box has to be free to take back whatever the controls above it give up.
    if (host) host.style.maxHeight = "none";
    _pinned = true;
  }

  // ══════════════════════════════════════════════════════════════════════
  // FINDING ONE ROW AMONG NINETY-NINE
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Does this row carry a fault worth walking to?
   *
   * Split and empty, and deliberately not tiny. On a real partition — ninety-
   * nine territories with one genuine fault in it — thirty-five rows were
   * "too small to see at this zoom", so a walk that included them stepped
   * through thirty-five viewport artefacts before reaching the thing that was
   * actually wrong. Zooming in empties that set entirely, which is the proof
   * it does not belong in a locator. It keeps its flag on the row and its own
   * entry in the filter, where choosing it is a decision rather than noise.
   *
   * Wider than `fixable`, though: a territory in two pieces that autoheal
   * cannot repair is still one to be taken to.
   */
  function _isFlagged(row) {
    return row.parts > 1 || _isEmpty(row.index) || _isCrossed(row.index);
  }

  /** Is any axis actually narrowing the list? */
  function _filtering() {
    return _axes.repair !== 0 || _axes.printed !== 0;
  }

  /** One axis against one row: 0 keeps everything, 1 keeps it, -1 keeps the rest. */
  function _axisKeeps(state, has) {
    return state === 0 || (state > 0 ? has : !has);
  }

  function _matchesFilter(row) {
    return (
      _axisKeeps(_axes.repair, _isFlagged(row)) &&
      _axisKeeps(_axes.printed, !!row.printed)
    );
  }

  /**
   * The same two questions asked of uncovered ground, whose answers are fixed:
   * it always needs attention, and it is never printed. So "only the ones with
   * issues" keeps it and "not printed" keeps it, while "no issues" and
   * "printed only" hide the lot.
   */
  function _matchesGapFilter() {
    return _axisKeeps(_axes.repair, true) && _axisKeeps(_axes.printed, false);
  }

  /**
   * Put each chip in the state its axis is in.
   *
   * The label says which state that is — "Issues", "With issues", "No issues"
   * — because three states is one more than a pressed-or-not control can mean
   * on its own, and a legend nobody reads is not an answer. `aria-pressed`
   * carries the coarser "is this narrowing anything", which is the question
   * somebody scanning the bar for why half the list is missing is asking.
   */
  function _paintChips(dialog) {
    var chips = dialog.querySelectorAll("[data-axis]");
    Array.prototype.forEach.call(chips, function (chip) {
      var axis = chip.dataset.axis;
      var state = _axes[axis] || 0;
      var name = state === 0 ? "Any" : state > 0 ? "Only" : "Not";
      var text = T(
        "list.chip" + axis.charAt(0).toUpperCase() + axis.slice(1) + name,
      );
      D.text(chip, "chip-label", text);
      chip.setAttribute("title", text);
      chip.setAttribute("aria-pressed", state === 0 ? "false" : "true");
      chip.dataset.state = state === 0 ? "any" : state > 0 ? "only" : "not";
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // PICKING SEVERAL
  // ══════════════════════════════════════════════════════════════════════

  /**
   * The selection, as the map will receive it.
   *
   * Indices are resolved against s.clusters at the moment they are handed
   * over rather than held as layer references, because a repair between the
   * pick and the close rebuilds every layer on the map and renumbers what is
   * left. An index that no longer exists is dropped instead of throwing.
   */
  function selection() {
    var entries = s.clusters || [];
    return _picked
      .map(function (index) {
        return entries[index];
      })
      .filter(Boolean)
      .map(function (entry) {
        return { layer: entry.layer, feature: entry.feature };
      });
  }

  /**
   * Give the selection to the map on the way out.
   *
   * This is what the picking is for. The list is a far better place to choose
   * fourteen territories out of ninety-nine than a map is, and the operations
   * worth doing to fourteen territories — merging them, deleting them — live
   * out there. So closing the dialog is the hand-over, and App.editing holds
   * it from then on: one idea of "selected", painted once, counted once,
   * undone once.
   *
   * Cleared here rather than left behind, because the selection now belongs
   * somewhere else and two copies of it would drift the moment either changed.
   */
  function _handOver() {
    var items = selection();
    _picked = [];
    _anchor = null;
    _cursor = null;
    _beforeClick = null;
    if (!App.editing || !App.editing.selectClusters) return false;
    // Handed over even when it is empty: the list is authoritative at the
    // moment it closes, so clearing the selection in here has to clear it out
    // there too. selectClusters declines to open a mode for nothing.
    return App.editing.selectClusters(items);
  }

  /** The map's current selection, as territory indices. */
  function _pickedOnMap() {
    var entries = s.clusters || [];
    var out = [];
    (s.selectedClusters || []).forEach(function (item) {
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].layer !== item.layer) continue;
        if (out.indexOf(i) < 0) out.push(i);
        return;
      }
    });
    return out;
  }

  /** The territory indices the list is showing, in display order. */
  function _shownOrder() {
    return (s.clusters || [])
      .map(function (entry, index) {
        return _rows[index] || _describe(entry, index);
      })
      .filter(_matchesFilter)
      .map(function (row) {
        return row.index;
      });
  }

  function _togglePick(dialog, index) {
    // Any other way of picking ends the click pair: the snapshot is only
    // worth putting back if nothing has happened since it was taken.
    _beforeClick = null;
    var at = _picked.indexOf(index);
    if (at >= 0) _picked.splice(at, 1);
    else _picked.push(index);
    // A range extends from the last row touched by hand, the way it does in
    // every file list — including when that touch took a row *out*.
    _anchor = index;
    _cursor = index;
    _paintSelection(dialog);
  }

  /**
   * This row and nothing else, which is what a plain click means in a list.
   *
   * The selection it replaces is remembered first, so that the double click
   * this may turn out to be the first half of can put it back. Only the first
   * click of a pair takes the snapshot — the second one is inside the window
   * and would otherwise overwrite it with the state the first one just created,
   * which is the state being backed out of.
   */
  function _pickOnly(dialog, index) {
    var now = Date.now();
    if (!_beforeClick || now - _clickAt > DBLCLICK_MS)
      _beforeClick = _picked.slice();
    _clickAt = now;

    _picked = [index];
    _anchor = index;
    _cursor = index;
    _paintSelection(dialog);
  }

  /**
   * Close the list and go and look at the territory on the map.
   *
   * Undoes the selection the first click of the double made, because a double
   * click is one gesture. Without that, glancing at territory 7 would leave
   * territory 7 selected on the map and open the mode that holds a selection,
   * which is a lot of consequence for a look.
   */
  function _zoomTo(index) {
    // Anything pending from an earlier click is stale now, and must not be
    // put back over a selection this gesture had nothing to do with.
    _beforeClick = null;
    App.ui.closeDialog();
    focus(index);
  }

  /**
   * The tail of a double click: go and look, and undo the pick the first half
   * of it made.
   *
   * Separate from _zoomTo because only a double click has a half to undo. The
   * flag on a row zooms without ever having selected anything, and restoring
   * a snapshot there would put back a selection from some earlier click.
   */
  function _openRow(index) {
    if (_beforeClick) _picked = _beforeClick;
    _zoomTo(index);
  }

  /**
   * Everything between the anchor and here, in what the list is showing.
   *
   * Through the shown rows rather than through the index range, so a range
   * taken while filtered picks the twelve rows you can see rather than the
   * eighty the numbers happen to span. With no anchor yet — Shift-clicking
   * first — the range is just this row, which is what starts one.
   */
  function _extendTo(dialog, index) {
    _beforeClick = null;
    var order = _shownOrder();
    var to = order.indexOf(index);
    if (to < 0) return;
    var from = _anchor === null ? to : order.indexOf(_anchor);
    if (from < 0) from = to;

    // The range *is* the selection rather than being added to it, which is
    // what lets Shift+Up walk back over rows it just took. Adding instead
    // meant the selection could only ever grow, so a range overshot by two
    // rows had to be started again from scratch.
    _picked = order.slice(Math.min(from, to), Math.max(from, to) + 1);
    // The anchor stays put, so a second Shift-click grows or shrinks the same
    // range rather than starting a new one from where the last one ended.
    if (_anchor === null) _anchor = index;
    _cursor = index;
    _paintSelection(dialog);
  }

  /**
   * Move through the list from the keyboard.
   *
   * Plain arrows move and take the row they land on, Shift+arrows drag the
   * range out from the anchor — the same two rules as clicking, which is the
   * point: the mouse and the keyboard should not disagree about what a
   * selection is.
   *
   * @param {number} delta -1 for up, 1 for down
   * @param {boolean} extend whether Shift is down
   */
  function _step(dialog, delta, extend) {
    var order = _shownOrder();
    if (order.length === 0) return;

    var at = order.indexOf(_cursor);
    if (at < 0) at = order.indexOf(_anchor);
    var next =
      at < 0
        ? delta > 0
          ? 0
          : order.length - 1
        : Math.min(order.length - 1, Math.max(0, at + delta));

    var index = order[next];
    if (extend) {
      if (_anchor === null) _anchor = _cursor === null ? index : _cursor;
      _extendTo(dialog, index);
    } else {
      _pickOnly(dialog, index);
    }
    _focusRow(dialog, index);
  }

  /** Put the keyboard on a row and bring it into view. */
  function _focusRow(dialog, index) {
    var row = dialog.querySelector('[data-territory="' + index + '"]');
    if (!row) return;
    if (row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
    var button = D.role(row, "go");
    if (!button || !button.focus) return;
    try {
      button.focus({ preventScroll: true });
    } catch (e) {
      button.focus();
    }
  }

  /**
   * Take every row on screen, or put them all down again.
   *
   * The second press clearing is what makes this reachable from the keyboard
   * alone: Escape belongs to the dialog, and a selection with no way back
   * except the mouse is not a keyboard feature.
   */
  function _selectAllShown(dialog) {
    _beforeClick = null;
    var indices = _shownOrder();

    var already = indices.every(function (index) {
      return _picked.indexOf(index) >= 0;
    });
    if (already && indices.length > 0) {
      _picked = _picked.filter(function (index) {
        return indices.indexOf(index) < 0;
      });
    } else {
      indices.forEach(function (index) {
        if (_picked.indexOf(index) < 0) _picked.push(index);
      });
    }
    _anchor = indices.length ? indices[indices.length - 1] : null;
    _cursor = _anchor;
    _paintSelection(dialog);
  }

  /**
   * Walk to the next flagged row and put the keyboard on it.
   *
   * Through what is on screen rather than through every territory, so the
   * filter and the jump compose instead of fighting: narrow to the printed
   * ones and the walk visits the printed ones that need attention. Wrapping
   * at the end rather than stopping, because the list is a loop somebody is
   * working around, not a document with a last page.
   *
   * The row is scrolled to and focused rather than selected on the map. This
   * is a locator for the list — the map is one click further on, and going
   * there closes the dialog.
   */
  function _jump(dialog) {
    // Every flagged row, not only the territories: a piece of ground nobody
    // covers is the thing in this list most worth being taken to.
    var rows = dialog.querySelectorAll("[data-flagged='1']");
    if (!rows.length) return false;

    _jumpAt = (_jumpAt + 1) % rows.length;
    var row = rows[_jumpAt];
    var button = D.role(row, "go") || row;
    if (row.scrollIntoView) row.scrollIntoView({ block: "nearest" });
    if (button.focus) button.focus({ preventScroll: true });
    return true;
  }

  /** What the repair did, as a sentence for the live region. */
  function _outcome(report) {
    if (!report || !report.changed) return T("list.fixedNone");
    var said = [];
    if (report.adopted > 0)
      said.push(T("list.fixedAdopted", { n: report.adopted }));
    if (report.split > 0)
      said.push(
        T("list.fixedSplit", { n: report.split, pieces: report.pieces }),
      );
    if (report.detached > 0)
      said.push(T("list.fixedDetached", { n: report.detached }));
    if (report.merged > 0)
      said.push(T("list.fixedMerged", { n: report.merged }));
    if (report.unresolved > 0)
      said.push(T("list.fixedStuck", { n: report.unresolved }));
    if (report.crossed > 0)
      said.push(T("list.fixedStuckWalls", { n: report.crossed }));
    return said.join(" ");
  }

  /**
   * Put the focus somewhere sensible once the rows have been rebuilt.
   *
   * In order: the same control on the same territory, that territory's own
   * row, the row that took its place in the list, and finally whatever is
   * still standing in the dialog. Territory 12 becoming territories 12 and 13
   * is the ordinary case and the first branch covers it; territory 12 being
   * merged away entirely is the other one, and landing on whoever is numbered
   * 12 now keeps the keyboard where the eye already is.
   */
  function _restoreFocus(dialog, index, role) {
    // "Fix all" is about the list rather than about a row, so it comes back to
    // itself — or, once there is nothing left to fix and it has gone, to the
    // button that closes the dialog.
    if (index === null) {
      _focusFirst([D.role(dialog, "fix-all"), D.role(dialog, "close")]);
      return;
    }

    var rows = dialog.querySelectorAll("[data-territory]");
    var target = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].dataset.territory === String(index)) {
        target = rows[i];
        break;
      }
    }
    if (!target && rows.length) target = rows[Math.min(index, rows.length - 1)];

    // Walked in order rather than picked by the first non-null: the wand that
    // was clicked is usually gone or hidden by now — that is what a successful
    // repair looks like — and stopping at it left the focus on <body>, which
    // takes the next Tab back to the top of the page instead of into the list.
    _focusFirst([
      target && role ? D.role(target, role) : null,
      target ? D.role(target, "go") : null,
      D.role(dialog, "fix-all"),
      D.role(dialog, "close"),
    ]);
  }

  /** Focus the first of `candidates` that is present and not hidden. */
  function _focusFirst(candidates) {
    for (var c = 0; c < candidates.length; c++) {
      var button = candidates[c];
      if (!button || button.hasAttribute("hidden") || !button.focus) continue;
      // preventScroll, because the whole point of the caller is that the list
      // has not moved: focusing a control below the fold scrolls it into view
      // and undoes the offset that was just put back. The caller restores the
      // offset again afterwards for browsers that ignore the option.
      try {
        button.focus({ preventScroll: true });
      } catch (e) {
        button.focus();
      }
      return;
    }
  }

  /**
   * Run the repair, then rebuild the rows around what it did.
   *
   * The dialog stays where it is. A heal renumbers everything after the first
   * territory it changes, so the rows have to be rebuilt — but the scroll
   * offset and the focus belong to the person reading, not to the data, and
   * both are put back.
   *
   * The work is deferred by a tick so the spinner is actually painted before
   * turf starts, which is the same 30 ms editing.js buys for a merge.
   *
   * @param {{gap: number}|number|null} target one territory by index, one
   *   piece of uncovered ground as `{gap: n}`, or null for everything —
   *   which includes the uncovered ground, because "fix all" is the button
   *   that makes the map right and a strip nobody walks is not right.
   * @param {Element} [source] the button that was clicked, so the focus can
   *   come back to its equivalent
   */
  function _fix(target, source) {
    if (!App.autoheal || !_dialog) return;
    var dialog = _dialog;
    var rows = D.role(dialog, "rows");
    var scroll = rows ? rows.scrollTop : 0;
    var role = source && source.dataset ? source.dataset.role : null;
    var gap = target && typeof target === "object" ? target.gap : null;
    // A repaired gap is gone from the list, so there is no row to come back
    // to: the focus lands where "fix all" leaves it instead.
    var index = gap === null ? target : null;

    App.ui.showBusy(T("loading.healing"));
    window.setTimeout(function () {
      var report = null;
      try {
        report =
          gap === null
            ? App.autoheal.heal(index === null ? undefined : index)
            : App.autoheal.healGaps(gap);
      } catch (e) {
        console.error(">>> Autoheal failed:", e);
      }
      App.ui.hideOverlay();

      // The dialog can have been closed while the repair ran — Escape still
      // works under the spinner — and rebuilding a dialog that is no longer
      // on the page would throw.
      if (_dialog !== dialog) return;

      if (!report) {
        alert(T("alert.healFailed"));
        return;
      }

      _renderList(dialog, { status: _outcome(report) });
      // Focus first, scroll second. Moving the focus can scroll the list on
      // its own, so the offset has to be the last thing written.
      _restoreFocus(dialog, index, role);
      var after = D.role(dialog, "rows");
      if (after) after.scrollTop = scroll;
    }, 30);
  }

  return {
    init: init,
    refresh: refresh,
    rows: rows,
    numberOf: numberOf,
    warnings: warnings,
    focus: focus,
    setSelected: setSelected,
    openList: openList,
    refreshList: refreshList,
    isVisible: isVisible,
    setVisible: setVisible,
  };
})();

window.App = App;
