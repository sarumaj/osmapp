/**
 * labels.js — making the number in the info panel countable.
 *
 * The info panel reports `s.clusters.length`, which is exactly right and
 * regularly disagrees with what you can count on screen. Three reasons, all
 * of them real:
 *
 *   • A territory can be too small to see. The partitioner drops orphans
 *     below 5% of an average territory but keeps everything above it; the
 *     knife keeps pieces down to CUT_MIN_PIECE_M2; carving the auto cluster
 *     leaves whatever is left over. At a village zoom a 400 m² leftover is a
 *     few pixels of purple against a purple neighbor — counted, printable,
 *     invisible.
 *   • Adjacent territories share an outline. Fifteen of them tiling a village
 *     read as one purple mass with some lines in it, and eyes undercount
 *     lines.
 *   • A territory can be in more than one piece. _enforceConnectivity makes
 *     that rare rather than impossible, and merge can produce it outright by
 *     unioning two shapes that do not touch. Then the map shows *more* shapes
 *     than the panel counts, which is the same confusion the other way round.
 *
 * So: one numbered chip per polygon *part*, all parts of a territory carrying
 * the same number. Distinct numbers = the panel's count, chips on screen =
 * the shapes on screen, and a repeated number is the explanation for the
 * difference rather than a puzzle. The numbering matches the hover tooltip
 * ("Territory 7"), because two numbering schemes would be worse than none.
 *
 * Two things follow from treating a chip as a handle on its territory rather
 * than as decoration:
 *
 *   • It is clickable, hoverable, right-clickable and selectable, and it gets
 *     all of that from polygons.attachProxyEvents rather than from a copy of
 *     the handlers. On a territory a few pixels wide the chip is the only
 *     thing you can realistically hit, which is exactly the case the chips
 *     were added for. It goes inert in cut mode, where the pointer is a
 *     drawing instrument and anything clickable on the map is one more thing
 *     for the knife to catch on.
 *   • It lives in innerPolygonsLayerGroup with the territories themselves
 *     rather than in a layer group of its own: the switcher's Territories
 *     toggle covers it, nothing can outlive a rebuild, and the switcher
 *     lists one entry per kind of thing on the map instead of one per
 *     implementation detail. Showing and hiding the numbers is the toolbar's
 *     job, next to the tools that make them worth having.
 *
 * The chip also carries the printed check, which used to be a marker of its
 * own in polygons.js. Both were anchored at the same interior point, so the
 * two collided by construction and the badge had to be nudged out of the
 * number's way. Merging them removes a marker that had to be created,
 * anchored, tracked on the cluster entry and torn down in three places, and
 * it keeps the non-color channel the badge existed for: on a territory too
 * small to see, the chip is red rather than green, and the check is then the
 * only thing on screen saying the card is done.
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

    var inert = !!s.editMode;

    // Described whether or not the chips are drawn. The rows are the audit —
    // the count, the too-small warning, the list dialog — and all of that is
    // about the territories rather than about the numbers. Returning early
    // here used to leave _rows empty, so switching the numbers off silently
    // took the info panel's warning with them.
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

  /** Re-decide the "too small to see" flag after a zoom. */
  function _syncTiny() {
    var changed = false;
    _rows.forEach(function (row) {
      row.anchors.forEach(function (anchor) {
        var tiny = _isTiny(anchor.bbox);
        if (tiny === anchor.tiny) return;
        anchor.tiny = tiny;
        changed = true;
        var chip = _chip(anchor.marker);
        if (chip) chip.classList.toggle("territory-label--tiny", tiny);
      });
    });
    // The info panel carries a warning derived from the same flag.
    if (changed && App.ui && App.ui.refreshInfo) App.ui.refreshInfo();
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
   * Why the count and the map might disagree, as two numbers.
   *
   * `tiny` is territories with no part big enough to notice at this zoom;
   * `split` is territories drawn as more than one shape. Both are legitimate
   * states, not errors — but both are worth saying out loud next to a number
   * somebody is trying to reconcile with their eyes.
   */
  function warnings() {
    var tiny = 0;
    var split = 0;
    _rows.forEach(function (row) {
      if (row.parts > 1) split++;
      if (
        row.anchors.length > 0 &&
        row.anchors.every(function (anchor) {
          return anchor.tiny;
        })
      )
        tiny++;
    });
    return { tiny: tiny, split: split, total: tiny + split };
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
    var dialog = App.ui.openDialog("tpl-territory-list", function () {
      App.shortcuts.pop("list");
      _dialog = null;
    });
    _dialog = dialog;

    D.onRole(dialog, "close", function () {
      App.ui.closeDialog();
    });

    var toggle = D.role(dialog, "show-numbers");
    if (toggle) {
      toggle.checked = isVisible();
      toggle.addEventListener("change", function () {
        setVisible(toggle.checked);
        if (App.controls) App.controls.refresh();
      });
    }

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
          combos: ["Escape"],
          labelKey: "shortcuts.listClose",
          run: function () {
            App.ui.closeDialog();
          },
        },
      ],
    });

    var entries = s.clusters || [];
    var shown = entries.map(function (entry, index) {
      return _rows[index] || _describe(entry, index);
    });

    D.text(dialog, "total", T("list.total", { count: shown.length }));

    var warn = warnings();
    var notes = [];
    if (warn.tiny > 0) notes.push(T("list.warnTiny", { n: warn.tiny }));
    if (warn.split > 0) notes.push(T("list.warnSplit", { n: warn.split }));
    D.text(dialog, "notes", notes.join(" "));
    D.toggleRole(dialog, "notes", notes.length > 0);

    var host = D.role(dialog, "rows");
    host.textContent = "";
    D.toggleRole(dialog, "empty", shown.length === 0);

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
      if (
        row.anchors.length > 0 &&
        row.anchors.every(function (anchor) {
          return anchor.tiny;
        })
      )
        _flag(flags, "fa-magnifying-glass-plus", "is-tiny", T("list.flagTiny"));

      D.onRole(node, "go", function () {
        App.ui.closeDialog();
        focus(row.index);
      });

      // The list is the answer to "which fourteen?", and the next question is
      // always "print that one".
      D.onRole(node, "print", function () {
        if (!entry || !entry.feature) return;
        App.ui.closeDialog();
        App.print.printCluster(entry.feature);
      });
    });
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
    isVisible: isVisible,
    setVisible: setVisible,
  };
})();

window.App = App;
