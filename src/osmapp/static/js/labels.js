/**
 * labels.js — adding countable numbers to the info panel.
 *
 * The info panel reports `s.clusters.length`, which is correct but often
 * does not match what you can count on screen. There are three reasons for
 * this, all of them legitimate:
 *
 *   • A territory can be too small to see. The partitioner drops orphan
 *     fragments below 5% of an average territory but keeps everything above
 *     that threshold. The knife keeps pieces down to CUT_MIN_PIECE_M2, and
 *     carving the auto cluster leaves behind whatever is left over. At a
 *     village zoom level, a 400 m² leftover is just a few pixels of purple
 *     against a purple neighbor — it is counted and printable, but it is
 *     effectively invisible.
 *
 *   • Adjacent territories share an outline. When fifteen of them tile a
 *     village, they can read as one purple mass with some lines drawn
 *     through it, and the human eye tends to undercount those lines.
 *
 *   • A territory can be in more than one piece. The `_enforceConnectivity`
 *     function makes this rare but does not make it impossible, and merge
 *     can produce it outright by unioning two shapes that do not touch. In
 *     that case the map shows *more* shapes than the panel counts, which is
 *     the same confusion in the opposite direction.
 *
 * The solution is to show one numbered chip per polygon *part*, where all
 * parts of a territory carry the same number. Distinct numbers match the
 * panel's count, chips on screen match the shapes on screen, and a repeated
 * number explains the difference rather than leaving it as a puzzle. The
 * numbering also matches the hover tooltip ("Territory 7"), because having
 * two separate numbering schemes would be more confusing than having none.
 *
 * Two things follow from treating a chip as a handle on its territory
 * rather than as mere decoration:
 *
 *   • The chip is clickable, hoverable, right-clickable, and selectable. It
 *     gets all of this behavior from `polygons.attachProxyEvents` instead of
 *     from a duplicate copy of the handlers. On a territory that is only a
 *     few pixels wide, the chip is the only thing you can realistically
 *     click — which is exactly the situation the chips were added for. The
 *     chip goes inert in cut mode, where the pointer acts as a drawing
 *     instrument and anything clickable on the map is just one more thing
 *     for the knife to catch on.
 *
 *   • The chip lives in `innerPolygonsLayerGroup` alongside the territories
 *     themselves, rather than in a separate layer group of its own. This
 *     way the switcher's Territories toggle covers it, nothing can outlive
 *     a rebuild, and the switcher lists one entry per kind of thing on the
 *     map instead of one per implementation detail. Showing and hiding the
 *     numbers is the toolbar's job, placed next to the tools that make the
 *     numbers worth having.
 *
 * The chip also carries the printed check, which used to be a separate
 * marker in `polygons.js`. Both were anchored at the same interior point,
 * so by construction the two would collide and the badge had to be nudged
 * out of the number's way. Merging them removes a marker that had to be
 * created, anchored, tracked on the cluster entry, and torn down in three
 * different places. It also preserves the non-color channel that the badge
 * existed for: on a territory too small to see, the chip turns red rather
 * than green, and the check becomes the only thing on screen indicating
 * that the card is done.
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
  // Which rows the list is showing, and how far the jump button has walked
  // through the flagged ones. Both belong to an open dialog rather than to the
  // territories, so openList() resets them and _renderList() does not.
  var _filter = "all";
  var _jumpAt = -1;
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
   * Why a territory is worth a second look, as three numbers.
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
   * All three are what App.autoheal repairs, or declines to; see there for
   * why `tiny` is the one it leaves alone.
   */
  function warnings() {
    var tiny = 0;
    var split = 0;
    var empty = 0;
    _rows.forEach(function (row) {
      if (row.parts > 1) split++;
      if (_rowIsTiny(row)) tiny++;
      if (_isEmpty(row.index)) empty++;
    });
    return {
      tiny: tiny,
      split: split,
      empty: empty,
      total: tiny + split + empty,
    };
  }

  /**
   * Is every part of this territory too small to notice at this zoom?
   *
   * A statement about the viewport rather than about the territory, which is
   * why it is kept apart from the other two flags everywhere it matters: it
   * changes when the map moves, autoheal declines to repair on it, and the
   * locator walks past it. It is still worth saying, because a territory you
   * cannot see is one you cannot click either — which is what the filter's own
   * entry for it is for.
   */
  function _rowIsTiny(row) {
    return (
      row.anchors.length > 0 &&
      row.anchors.every(function (anchor) {
        return anchor.tiny;
      })
    );
  }

  /** Whether territory `index` holds no buildings; false when unknowable. */
  function _isEmpty(index) {
    if (!App.autoheal) return false;
    return App.autoheal.isEmpty((s.clusters || [])[index]) === true;
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
    var dialog = App.ui.openDialog("tpl-territory-list", function () {
      App.shortcuts.pop("list");
      _dialog = null;
    });
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

    // A fresh opening shows everything. Carrying a filter over from last time
    // would mean opening the list and finding most of the territories missing,
    // with the reason two controls up the dialog.
    _filter = "all";
    _jumpAt = -1;

    var filter = D.role(dialog, "filter");
    if (filter) {
      filter.value = _filter;
      filter.addEventListener("change", function () {
        _filter = filter.value;
        // The walk is through what is on screen, so a narrower list restarts
        // it rather than resuming somewhere the rows no longer are.
        _jumpAt = -1;
        _renderList(dialog);
      });
    }

    D.onRole(dialog, "jump", function () {
      _jump(dialog);
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

    var toggle = D.role(dialog, "show-numbers");
    if (toggle) toggle.checked = isVisible();

    var filter = D.role(dialog, "filter");
    if (filter) filter.value = _filter;

    D.text(
      dialog,
      "total",
      _filter === "all"
        ? T("list.total", { count: all.length })
        : T("list.showing", { shown: shown.length, total: all.length }),
    );
    D.text(dialog, "outcome", (opts && opts.status) || "");

    var warn = warnings();
    var notes = [];
    if (warn.tiny > 0) notes.push(T("list.warnTiny", { n: warn.tiny }));
    if (warn.split > 0) notes.push(T("list.warnSplit", { n: warn.split }));
    if (warn.empty > 0) notes.push(T("list.warnEmpty", { n: warn.empty }));
    D.text(dialog, "notes", notes.join(" "));
    D.toggleRole(dialog, "notes", notes.length > 0);

    // The repair offer, per row and for the list as a whole. `fixable` is not
    // the same as `flagged`: a territory too small to see is flagged and not
    // fixable, and an empty one no neighbor can take is flagged and not
    // fixable either. autoheal answers it by rehearsing the repair rather than
    // by guessing at it, so a wand that is shown always does something.
    var audit = App.autoheal ? App.autoheal.audit() : { rows: [], fixable: 0 };
    var fixable = {};
    audit.rows.forEach(function (issue) {
      if (issue.fixable) fixable[issue.index] = true;
    });
    D.toggleRole(dialog, "fix-all", audit.fixable > 0);

    var host = D.role(dialog, "rows");
    host.textContent = "";
    // "There are none" and "none of them match" are different answers, and
    // offering the first when the second is true sends somebody looking for
    // territories that are sitting right there behind a filter.
    D.toggleRole(dialog, "empty", all.length === 0);
    D.toggleRole(dialog, "no-match", all.length > 0 && shown.length === 0);

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
      if (_rowIsTiny(row))
        _flag(flags, "fa-magnifying-glass-plus", "is-tiny", T("list.flagTiny"));
      if (_isEmpty(row.index))
        _flag(flags, "fa-house-circle-xmark", "is-empty", T("list.flagEmpty"));

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

    var flagged = shown.filter(_isFlagged).length;
    D.toggleRole(dialog, "jump", flagged > 0);
    D.text(dialog, "jump-count", flagged > 0 ? App.i18n.n(flagged) : "");
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
    return row.parts > 1 || _isEmpty(row.index);
  }

  function _matchesFilter(row) {
    if (_filter === "repair") return _isFlagged(row);
    if (_filter === "tiny") return _rowIsTiny(row);
    if (_filter === "printed") return !!row.printed;
    if (_filter === "unprinted") return !row.printed;
    return true;
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
    var rows = dialog.querySelectorAll("[data-territory][data-flagged='1']");
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
    if (report.split > 0)
      said.push(
        T("list.fixedSplit", { n: report.split, pieces: report.pieces }),
      );
    if (report.merged > 0)
      said.push(T("list.fixedMerged", { n: report.merged }));
    if (report.unresolved > 0)
      said.push(T("list.fixedStuck", { n: report.unresolved }));
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
   * @param {number|null} index one territory, or null for all of them
   * @param {Element} [source] the button that was clicked, so the focus can
   *   come back to its equivalent
   */
  function _fix(index, source) {
    if (!App.autoheal || !_dialog) return;
    var dialog = _dialog;
    var rows = D.role(dialog, "rows");
    var scroll = rows ? rows.scrollTop : 0;
    var role = source && source.dataset ? source.dataset.role : null;

    App.ui.showBusy(T("loading.healing"));
    window.setTimeout(function () {
      var report = null;
      try {
        report = App.autoheal.heal(index === null ? undefined : index);
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
    isVisible: isVisible,
    setVisible: setVisible,
  };
})();

window.App = App;
