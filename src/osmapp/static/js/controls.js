/**
 * controls.js — the toolbar, the language picker and resetAll().
 *
 * The toolbar used to be a dozen separate L.Control instances, each rendering
 * its own one-button leaflet-bar. That is where the "which icon does what?"
 * problem came from: twelve identical grey squares in a column, distinguished
 * only by a glyph and a tooltip nobody hovers long enough to read. It is now a
 * single panel built from GROUPS below, where each group is a titled section
 * with labelled buttons, and the collapse toggle trades the labels back for
 * screen space when the map matters more than the chrome.
 *
 * Availability is declarative. Every button may carry:
 *
 *   enabled()   — false disables the button rather than hiding it, so the
 *                 action stays discoverable and the tooltip explains what is
 *                 missing. This is why Export is always on screen: a button
 *                 that vanishes teaches nothing, a greyed one with
 *                 "Draw or search for an outer boundary first" does.
 *   active()    — toggle state, for the modal cut and merge tools.
 *   titleFn()   — a tooltip that has to be recomputed (undo/redo depth).
 *
 * refresh() re-evaluates all three for every button and is called from the few
 * places that change the answers: a fetch, a cluster change, a history push, a
 * mode toggle, a reset. Modules no longer reach into the DOM for a button —
 * setActive() and refresh() are the seam.
 *
 * Translation notes:
 *   • Labels and static tooltips carry data-i18n / data-i18n-attrs, so
 *     App.i18n.apply(document.body) refreshes them on a language change.
 *     Computed titles (undo depth, disabled reasons) are re-applied by
 *     refresh(), which is registered as an i18n listener.
 *   • Leaflet's layer control has no API for renaming entries, so it is
 *     rebuilt when the language changes. With URL routing a change is a page
 *     load, so this only matters for an in-place switch.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.controls = (function () {
  "use strict";

  var s = null;
  var T = null;
  var D = null;
  var _map = null;
  var _layerControl = null;
  var _aidNote = null;
  var _panel = null;

  /** id → { spec, node } for every rendered button. */
  var _items = {};

  var COLLAPSE_KEY = "osmapp.toolbar.collapsed";
  var NARROW_PX = 720;

  // ── Availability predicates ───────────────────────────────────────────
  //
  // Named functions rather than inline closures so that two buttons meaning
  // the same thing cannot drift apart, and so a spec reads as a sentence.

  function hasBoundary() {
    return !!s.outerPolygonLayer;
  }

  function hasData() {
    return !!(s.cachedStreets && s.cachedStreets.features);
  }

  /**
   * Streets alone are not enough for the trim tool: it decides where the
   * boundary goes from where the buildings are, and an area that downloaded
   * none of them has nothing to trim towards.
   */
  function hasBuildings() {
    return !!(
      s.cachedBuildings &&
      s.cachedBuildings.features &&
      s.cachedBuildings.features.length > 0
    );
  }

  function hasClusters() {
    return !!(s.clusters && s.clusters.length > 0);
  }

  function hasTwoClusters() {
    return !!(s.clusters && s.clusters.length >= 2);
  }

  function hasAnything() {
    return hasBoundary() || hasClusters();
  }

  // ══════════════════════════════════════════════════════════════════════
  // TOOLBAR CONTENT
  // ══════════════════════════════════════════════════════════════════════

  var GROUPS = [
    {
      key: "area",
      titleKey: "toolbar.groupArea",
      buttons: [
        {
          id: "draw",
          icon: "fa-draw-polygon",
          labelKey: "toolbar.labelDraw",
          titleKey: "toolbar.draw",
          accent: "blue",
          // The polygon tool is also the way back into an existing boundary —
          // clicking it with one already set offers "edit instead" — so it
          // lights up while that editor is running. Without this the app
          // would be in a mode with nothing in the toolbar saying so, which
          // is the one thing every other modal tool here avoids.
          active: function () {
            return !!s.outlineMode;
          },
          onClick: _draw,
        },
        {
          id: "locate",
          icon: "fa-location-crosshairs",
          labelKey: "toolbar.labelLocate",
          titleKey: "toolbar.locate",
          accent: "blue",
          onClick: _locate,
        },
        {
          id: "refetch",
          icon: "fa-cloud-arrow-down",
          labelKey: "toolbar.labelRefetch",
          titleKey: "toolbar.refetch",
          disabledTitleKey: "toolbar.needsBoundary",
          accent: "blue",
          enabled: hasBoundary,
          onClick: _refetch,
        },
        {
          // In Area rather than Territories on purpose: this reshapes the
          // boundary, and it belongs before the split rather than among the
          // tools that correct one.
          id: "trim",
          icon: "fa-compress",
          labelKey: "toolbar.labelTrim",
          titleKey: "toolbar.trim",
          disabledTitleKey: "toolbar.needsBuildings",
          accent: "blue",
          enabled: function () {
            return hasBoundary() && hasBuildings();
          },
          active: function () {
            return !!s.trimMode;
          },
          onClick: function () {
            App.trim.toggle();
          },
        },
      ],
    },
    {
      key: "territories",
      titleKey: "toolbar.groupTerritories",
      buttons: [
        {
          id: "partition",
          icon: "fa-shapes",
          labelKey: "toolbar.labelPartition",
          titleKey: "toolbar.partition",
          disabledTitleKey: "toolbar.needsData",
          accent: "purple",
          enabled: function () {
            return hasBoundary() && hasData();
          },
          onClick: function () {
            App.clustering.showClusterDialog();
          },
        },
        {
          id: "cut",
          icon: "fa-scissors",
          labelKey: "toolbar.labelCut",
          titleKey: "toolbar.cut",
          disabledTitleKey: "toolbar.needsTerritories",
          accent: "purple",
          enabled: hasClusters,
          active: function () {
            return !!s.editMode;
          },
          onClick: function () {
            App.editing.toggleEditMode();
          },
        },
        {
          id: "merge",
          icon: "fa-code-merge",
          labelKey: "toolbar.labelMerge",
          titleKey: "toolbar.merge",
          disabledTitleKey: "toolbar.needsTwoTerritories",
          accent: "yellow",
          enabled: hasTwoClusters,
          active: function () {
            return !!s.mergeMode;
          },
          onClick: function () {
            App.editing.toggleMergeMode();
          },
        },
        {
          // The count in the info panel is a number people check against the
          // map by eye, and they lose. This puts the same number *on* each
          // territory, so counting is reading rather than searching.
          id: "numbers",
          icon: "fa-hashtag",
          labelKey: "toolbar.labelNumbers",
          titleKey: "toolbar.numbers",
          disabledTitleKey: "toolbar.needsTerritories",
          accent: "purple",
          enabled: hasClusters,
          active: function () {
            return App.labels.isVisible();
          },
          onClick: function () {
            App.labels.setVisible(!App.labels.isVisible());
            refresh();
          },
        },
        {
          // Doing a territory again next round means the same shapes with a
          // clean slate of marks, which is otherwise a right-click per
          // territory. Disabled — not hidden — when there is nothing marked,
          // so the counter in the info panel has a visible companion.
          id: "clear-printed",
          icon: "fa-list-check",
          labelKey: "toolbar.labelClearPrinted",
          titleKey: "toolbar.clearPrinted",
          disabledTitleKey: "toolbar.needsPrinted",
          accent: "green",
          enabled: function () {
            return App.polygons.printedCount() > 0;
          },
          onClick: _clearPrinted,
        },
      ],
    },
    {
      key: "history",
      titleKey: "toolbar.groupHistory",
      buttons: [
        {
          id: "undo",
          icon: "fa-rotate-left",
          labelKey: "toolbar.labelUndo",
          accent: "red",
          enabled: function () {
            return App.history.canUndo();
          },
          titleFn: function () {
            return _withKey(
              _depthTitle(App.history.undoKey(), App.history.undoDepth()),
              "Mod+Z",
            );
          },
          onClick: function () {
            App.history.undo();
          },
        },
        {
          id: "redo",
          icon: "fa-rotate-right",
          labelKey: "toolbar.labelRedo",
          accent: "blue",
          enabled: function () {
            return App.history.canRedo();
          },
          titleFn: function () {
            return _withKey(
              _depthTitle(App.history.redoKey(), App.history.redoDepth()),
              "Mod+Y",
            );
          },
          onClick: function () {
            App.history.redo();
          },
        },
      ],
    },
    {
      key: "file",
      titleKey: "toolbar.groupFile",
      buttons: [
        {
          id: "import",
          icon: "fa-file-import",
          labelKey: "toolbar.labelImport",
          titleKey: "toolbar.import",
          accent: "green",
          setup: _setupImportButton,
        },
        {
          // Always rendered. Disabled until there is something worth writing
          // out, with a tooltip that says what is missing — a button that
          // disappears teaches nothing about why.
          id: "export",
          icon: "fa-file-export",
          labelKey: "toolbar.labelExport",
          titleKey: "toolbar.export",
          disabledTitleKey: "toolbar.needsBoundary",
          accent: "orange",
          enabled: hasBoundary,
          onClick: function () {
            App.data.exportData();
          },
        },
        {
          id: "reset",
          icon: "fa-trash",
          labelKey: "toolbar.labelReset",
          titleKey: "toolbar.reset",
          disabledTitleKey: "toolbar.needsAnything",
          accent: "red",
          enabled: hasAnything,
          onClick: resetAll,
        },
      ],
    },
    {
      key: "app",
      titleKey: "toolbar.groupApp",
      buttons: [
        {
          // The way back into the walkthrough. It only ever opens by itself
          // once, so without a button the tour would be a thing that happened
          // to you rather than a thing you can consult.
          id: "help",
          icon: "fa-circle-question",
          labelKey: "toolbar.labelHelp",
          titleKey: "toolbar.help",
          accent: "blue",
          onClick: function () {
            App.tour.start();
          },
        },
        {
          // The tour teaches the workflow once; this answers "what can I
          // press right now", which is a different question and was the one
          // with no button at all.
          id: "shortcuts",
          icon: "fa-keyboard",
          labelKey: "toolbar.labelShortcuts",
          titleKey: "toolbar.shortcuts",
          accent: "blue",
          onClick: function () {
            App.shortcuts.toggleSheet();
          },
        },
        { id: "language", custom: _mountLanguagePicker },
        {
          // fa-brands, not fa-solid: the GitHub mark lives in a separate
          // webfont.
          id: "github",
          icon: "fa-github",
          iconClass: "fa-brands",
          labelKey: "toolbar.labelGithub",
          titleKey: "toolbar.github",
          accent: "purple",
          href: "https://github.com/sarumaj/osmapp",
        },
      ],
    },
  ];

  // ══════════════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ══════════════════════════════════════════════════════════════════════

  function init(leafletMap) {
    s = App.state;
    T = App.i18n.t;
    D = App.dom;
    _map = leafletMap;

    _buildLayerControl();
    _makePanel().addTo(leafletMap);

    // The layer control does the swap itself; this is how App.basemap finds
    // out, so the choice is remembered and anything watching for it — the
    // print dialog's note, the aid styling — hears about it too.
    _map.on("baselayerchange", function (e) {
      App.basemap.entries().forEach(function (entry) {
        if (entry.layer === e.layer) App.basemap.select(entry.id);
      });
    });
    App.basemap.onChange(_syncAidNote);

    // The overlay checkbox is the only switch the gap layer has, so it is
    // also where the module finds out whether its work is worth doing.
    _map.on("overlayadd", function (e) {
      if (e.layer === s.gapsLayerGroup) App.gaps.setVisible(true);
    });
    _map.on("overlayremove", function (e) {
      if (e.layer === s.gapsLayerGroup) App.gaps.setVisible(false);
    });

    App.i18n.onChange(function () {
      _buildLayerControl();
      refresh();
    });

    refresh();
    App._loaded.push("controls");
  }

  // ── Layer control ─────────────────────────────────────────────────────

  /**
   * Basemaps as radio entries, everything else as checkboxes.
   *
   * The basemaps are mutually exclusive by nature — one thing can be under the
   * map — and Leaflet already renders that distinction with a divider, which
   * is most of the explanation the switcher needs. The rest is _aidNote below:
   * one line, shown only while an aid layer is selected, saying the thing
   * somebody would otherwise only discover on paper.
   */
  function _buildLayerControl() {
    if (_layerControl) _map.removeControl(_layerControl);

    var bases = {};
    App.basemap.entries().forEach(function (entry) {
      bases[T(entry.labelKey)] = entry.layer;
    });

    var overlays = {};
    overlays[T("layers.outer")] = s.outerPolygonLayerGroup;
    overlays[T("layers.streets")] = s.streetsLayerGroup;
    overlays[T("layers.buildings")] = s.buildingsLayerGroup;
    // The number chips ride along in this one: they are territories, not a
    // separate kind of thing to switch on and off.
    overlays[T("layers.clusters")] = s.innerPolygonsLayerGroup;
    // Its own entry rather than riding with the territories: it is the
    // opposite of a territory, and somebody who has finished checking the
    // coverage should be able to put it away without losing the shapes it
    // was drawn against.
    overlays[T("layers.gaps")] = s.gapsLayerGroup;

    _layerControl = L.control
      .layers(bases, overlays, { collapsed: false })
      .addTo(_map);

    _mountAidNote();
  }

  /** The "this one does not print" line, kept in sync with the selection. */
  function _mountAidNote() {
    var container = _layerControl.getContainer();
    if (!container) return;

    var note = document.createElement("div");
    note.className = "layer-note";
    note.setAttribute("role", "note");
    note.setAttribute("data-i18n", "layers.aidNote");
    note.textContent = T("layers.aidNote");
    container.appendChild(note);

    _aidNote = note;
    _syncAidNote();
  }

  function _syncAidNote() {
    if (_aidNote) D.toggle(_aidNote, App.basemap.isAid());
  }

  // ══════════════════════════════════════════════════════════════════════
  // PANEL
  // ══════════════════════════════════════════════════════════════════════

  function _makePanel() {
    var Control = L.Control.extend({
      options: { position: "topleft" },
      onAdd: function () {
        _panel = D.render("tpl-toolbar-panel");
        var groups = D.role(_panel, "groups");

        GROUPS.forEach(function (group) {
          var section = D.mount("tpl-toolbar-group", groups);
          section.dataset.group = group.key;

          var title = D.role(section, "title");
          title.setAttribute("data-i18n", group.titleKey);
          title.textContent = T(group.titleKey);

          var host = D.role(section, "items");
          group.buttons.forEach(function (spec) {
            if (spec.custom) {
              spec.custom(host);
              return;
            }
            _items[spec.id] = { spec: spec, node: _makeButton(spec, host) };
          });
        });

        D.onRole(_panel, "collapse", function () {
          _setCollapsed(!_panel.classList.contains("is-collapsed"));
        });
        _setCollapsed(_initialCollapsed());

        L.DomEvent.disableClickPropagation(_panel);
        L.DomEvent.disableScrollPropagation(_panel);
        return _panel;
      },
    });
    return new Control();
  }

  /**
   * @param {{id:string, icon:string, iconClass?:string, labelKey:string,
   *          titleKey?:string, disabledTitleKey?:string, accent?:string,
   *          onClick?:Function, setup?:Function, href?:string}} spec
   *   href turns the button into a real external link: click propagation is
   *   stopped so the map does not see it, but nothing is prevented, so
   *   navigation still happens.
   */
  function _makeButton(spec, host) {
    var node = D.mount("tpl-toolbar-button", host);
    node.dataset.action = spec.id;
    if (spec.accent) node.setAttribute("data-accent", spec.accent);

    var icon = D.role(node, "icon");
    icon.className =
      "tb-item__icon " + (spec.iconClass || "fa-solid") + " " + spec.icon;

    var label = D.role(node, "label");
    label.setAttribute("data-i18n", spec.labelKey);
    label.textContent = T(spec.labelKey);

    if (spec.href) {
      node.href = spec.href;
      node.target = "_blank";
      node.rel = "noopener noreferrer";
      node.removeAttribute("role");
    } else {
      node.href = "#";
    }

    if (spec.onClick) {
      L.DomEvent.on(node, "click", function (e) {
        L.DomEvent.preventDefault(e);
        L.DomEvent.stopPropagation(e);
        if (_isDisabled(node)) return;
        spec.onClick(node);
      });
    }
    if (spec.setup) spec.setup(node);

    return node;
  }

  /**
   * A greyed-out anchor is still clickable, and on touch there is no hover to
   * reveal the tooltip explaining why it should not be. Swallowing the click
   * is what makes "disabled" mean disabled.
   */
  function _isDisabled(node) {
    return node.getAttribute("aria-disabled") === "true";
  }

  // ── Collapse ──────────────────────────────────────────────────────────

  /**
   * Labels cost roughly 90 px of map width. That is a fair trade on a desktop
   * and a bad one on a phone, so narrow screens start collapsed unless the
   * user has already said otherwise.
   */
  function _initialCollapsed() {
    // No stored answer — including "storage is unavailable" — falls through
    // to the width heuristic below.
    var stored = App.util.readLocal(COLLAPSE_KEY, null);
    if (stored === "1") return true;
    if (stored === "0") return false;
    return window.innerWidth < NARROW_PX;
  }

  function _setCollapsed(collapsed) {
    _panel.classList.toggle("is-collapsed", collapsed);

    var toggle = D.role(_panel, "collapse");
    var key = collapsed ? "toolbar.expand" : "toolbar.collapse";
    toggle.setAttribute(
      "data-i18n-attrs",
      "title=" + key + ";aria-label=" + key,
    );
    toggle.title = T(key);
    toggle.setAttribute("aria-label", toggle.title);
    toggle.setAttribute("aria-expanded", String(!collapsed));

    var chevron = toggle.querySelector("i");
    if (chevron) {
      chevron.className =
        "fa-solid " + (collapsed ? "fa-chevron-right" : "fa-chevron-left");
    }

    App.util.writeLocal(COLLAPSE_KEY, collapsed ? "1" : "0");
  }

  // ══════════════════════════════════════════════════════════════════════
  // BUTTON STATE
  // ══════════════════════════════════════════════════════════════════════

  /** Re-evaluate enabled / active / tooltip for every button. */
  function refresh() {
    if (!_panel) return;
    Object.keys(_items).forEach(function (id) {
      var item = _items[id];
      var spec = item.spec;
      var node = item.node;

      var on = spec.enabled ? !!spec.enabled() : true;
      node.classList.toggle("is-disabled", !on);
      node.setAttribute("aria-disabled", String(!on));

      if (spec.active) {
        var active = !!spec.active();
        node.classList.toggle("is-active", active);
        node.setAttribute("aria-pressed", String(active));
      }

      _applyTitle(node, spec, on);
    });
  }

  /**
   * A computed title (undo depth, or the reason a button is unavailable) must
   * survive the next App.i18n.apply() pass, so the declarative mapping is
   * removed while one is in force and restored when it is not.
   */
  function _applyTitle(node, spec, enabled) {
    var computed = spec.titleFn
      ? spec.titleFn()
      : !enabled && spec.disabledTitleKey
        ? T(spec.disabledTitleKey)
        : null;

    if (computed) {
      node.removeAttribute("data-i18n-attrs");
      node.title = computed;
      node.setAttribute("aria-label", computed);
      return;
    }
    if (!spec.titleKey) return;
    node.setAttribute(
      "data-i18n-attrs",
      "title=" + spec.titleKey + ";aria-label=" + spec.titleKey,
    );
    node.title = T(spec.titleKey);
    node.setAttribute("aria-label", node.title);
  }

  /** Force a toggle button's visual state, e.g. when a mode ends by itself. */
  function setActive(id, active) {
    var item = _items[id];
    if (!item) return;
    item.node.classList.toggle("is-active", !!active);
    item.node.setAttribute("aria-pressed", String(!!active));
  }

  /**
   * @param {string} prefix i18n key the active history scope asked for, e.g.
   *   "toolbar.undoVertex". Every scope supplies a <prefix>Count and a
   *   <prefix>None, so the tooltip names what will actually be taken back
   *   rather than always saying "change".
   */
  function _depthTitle(prefix, depth) {
    return depth > 0
      ? T(prefix + "Count", { count: depth })
      : T(prefix + "None");
  }

  /**
   * "Undo last change (3 available) — Ctrl+Z".
   *
   * The cut toolbar has shown its keys on <kbd> tags since it shipped and the
   * main toolbar showed none, so the two most-used shortcuts in the app were
   * the two least discoverable. Rendered through App.shortcuts so a Mac reads
   * ⌘ rather than being told about a key its keyboard labels differently.
   */
  function _withKey(title, combo) {
    return title + " — " + App.shortcuts.hint(combo);
  }

  // ══════════════════════════════════════════════════════════════════════
  // ACTIONS
  // ══════════════════════════════════════════════════════════════════════

  function _draw() {
    // The button shows itself as active while the outline editor runs, and a
    // control that looks pressed has to be the way to unpress it — otherwise
    // clicking it asks "replace this boundary?" about the shape currently
    // being edited, which is a question about the wrong thing.
    if (s.outlineMode) {
      App.outline.cancel();
      return;
    }

    _confirmReplaceOuter().then(function (answer) {
      if (answer === "alt") {
        // "I clicked the polygon tool because I want to change the polygon"
        // is at least as likely a reading as "…because I want a new one", and
        // the old dialog offered only the destructive half of it.
        App.outline.toggle();
        return;
      }
      if (answer) s.leafletMap.editTools.startPolygon();
    });
  }

  /**
   * Resolves true when there is no boundary to lose or the user says replace,
   * "alt" when they would rather edit the one they have, false otherwise.
   */
  function _confirmReplaceOuter() {
    if (!s.outerPolygonDrawn) return Promise.resolve(true);
    return App.ui.confirm({
      titleKey: "confirm.replaceOuterTitle",
      messageKey: "alert.replaceOuter",
      okKey: "confirm.replace",
      altKey: "confirm.editInstead",
      danger: true,
    });
  }

  function _refetch() {
    App.data.confirmAndFetch(s.outerPolygonLayer.toGeoJSON(), { force: true });
  }

  /**
   * Wipe the printed marks after confirming.
   *
   * Confirmed because it is not undoable: the marks are not document geometry
   * and history.push() does not record them, so there is nothing for Ctrl+Z
   * to put back. The count goes in the question rather than in the tooltip,
   * because "clear 23 marks" and "clear 1 mark" deserve different amounts of
   * hesitation.
   */
  function _clearPrinted() {
    var count = App.polygons.printedCount();
    if (count === 0) return;
    App.ui
      .confirm({
        titleKey: "confirm.clearPrintedTitle",
        message: T("alert.clearPrintedConfirm", { count: count }),
        okKey: "confirm.clearPrinted",
        danger: true,
      })
      .then(function (ok) {
        if (ok) App.polygons.clearPrinted();
      });
  }

  // ── Locate ────────────────────────────────────────────────────────────

  function _locate(node) {
    if (!navigator.geolocation) {
      alert(T("alert.noGeolocation"));
      return;
    }
    var icon = D.role(node, "icon");
    var original = icon ? icon.className : "";
    if (icon) icon.className = "tb-item__icon fa-solid fa-spinner fa-spin";

    function restore() {
      if (icon) icon.className = original;
    }

    s.leafletMap
      .once("locationfound", function (e) {
        restore();
        s.leafletMap.setView(e.latlng, 16);
      })
      .once("locationerror", function (e) {
        restore();
        alert(T("alert.locateFailed", { message: e.message }));
      })
      .locate({ setView: false, enableHighAccuracy: true, timeout: 5000 });
  }

  // ── Import ────────────────────────────────────────────────────────────

  function _setupImportButton(node) {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = ".geojson,.json";
    input.hidden = true;
    document.body.appendChild(input);

    L.DomEvent.on(node, "click", function (e) {
      L.DomEvent.preventDefault(e);
      L.DomEvent.stopPropagation(e);
      if (_isDisabled(node)) return;
      input.click();
    });

    L.DomEvent.on(input, "change", function (e) {
      var file = e.target.files[0];
      if (file) {
        App.data.importData(file);
        input.value = "";
      }
    });
  }

  // ── Language picker ───────────────────────────────────────────────────

  function _mountLanguagePicker(host) {
    var node = D.mount("tpl-language-control", host);
    var select = D.role(node, "lang");
    var flag = D.role(node, "flag");

    App.i18n.languages().forEach(function (lang) {
      var option = document.createElement("option");
      option.value = lang.code;
      option.textContent = lang.label;
      select.appendChild(option);
    });
    select.value = App.i18n.current();

    /** The select is transparent, so the current flag is drawn separately. */
    function showFlag() {
      var current = App.i18n.current();
      App.i18n.languages().forEach(function (lang) {
        if (lang.code === current) flag.textContent = lang.label;
      });
    }
    showFlag();
    App.i18n.onChange(showFlag);

    // setLanguage navigates to that language's URL (/ , /pl, /de, /fr) so the
    // choice is shareable and bookmarkable. Pass { navigate: false } for an
    // in-place swap instead — which is why the flag is kept in sync above
    // rather than left to the page load.
    select.addEventListener("change", function () {
      App.i18n.setLanguage(select.value);
    });

    return node;
  }

  // ── Reset ─────────────────────────────────────────────────────────────

  function resetAll() {
    App.ui
      .confirm({
        titleKey: "confirm.resetTitle",
        messageKey: "alert.resetConfirm",
        okKey: "confirm.reset",
        danger: true,
      })
      .then(function (ok) {
        if (ok) clearAll();
      });
  }

  /**
   * The reset itself, with no question asked.
   *
   * Public because the guided tour needs it: after borrowing the app for a
   * sample area it has to get back to empty, and a confirmation prompt in the
   * middle of a walkthrough is a prompt about something the user never did.
   *
   * @param {{keepSession?: boolean}} [opts] keepSession leaves IndexedDB
   *   alone. Only the tour passes it — a real reset must clear the store, or
   *   the reset survives exactly until the next reload.
   */
  function clearAll(opts) {
    if (App.history) App.history.clear();
    if (s.editMode) App.editing.toggleEditMode();
    if (s.mergeMode) App.editing.toggleMergeMode();
    if (s.trimMode) App.trim.toggle();
    if (s.outlineMode) App.outline.toggle();

    [
      s.streetsLayerGroup,
      s.buildingsLayerGroup,
      s.innerPolygonsLayerGroup,
      s.outerPolygonLayerGroup,
    ].forEach(function (group) {
      if (group) group.clearLayers();
    });

    if (s.leafletMap.editTools) s.leafletMap.editTools.stopDrawing();

    s.outerPolygonLayer = null;
    s.outerPolygonDrawn = false;
    s.clusters = [];
    s.selectedClusters = [];
    s.streetSegments = [];
    s.cachedStreets = null;
    s.cachedBuildings = null;
    s.cachedBounds = null;

    // clearLayers() took the number chips off the map, but labels.js still
    // holds the rows describing them — and ui.refreshInfo asks those rows how
    // many territories are too small to see.
    if (App.labels) App.labels.refresh();
    App.ui.setInfoDefault();
    App.ui.closeContextMenu();
    // Now that startup restores the session, leaving the records behind would
    // mean a reset survives only until the next reload.
    if (App.session && !(opts && opts.keepSession)) App.session.clear();
    refresh();
    s.leafletMap.setView([47.3769, 8.5417], 13);
  }

  function isCollapsed() {
    return !!(_panel && _panel.classList.contains("is-collapsed"));
  }

  /** Public so the tour can expand the panel while it points at buttons. */
  function setCollapsed(collapsed) {
    if (_panel) _setCollapsed(!!collapsed);
  }

  return {
    init: init,
    refresh: refresh,
    setActive: setActive,
    clearAll: clearAll,
    setCollapsed: setCollapsed,
    isCollapsed: isCollapsed,
    resetAll: resetAll,
  };
})();

window.App = App;
