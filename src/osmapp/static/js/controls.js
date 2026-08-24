/**
 * controls.js - the toolbar, the language picker and resetAll().
 *
 * The toolbar is one panel built from GROUPS below, each group a titled
 * section with labelled buttons; the collapse toggle trades the labels back
 * for screen space. Availability is declarative - every button may carry:
 *
 *   enabled()   - false disables the button rather than hiding it, so the
 *                 action stays discoverable and the tooltip explains what is
 *                 missing. Export is always on screen for this reason: a
 *                 greyed button reading "Draw or search for an outer boundary
 *                 first" teaches what a vanished one does not.
 *   active()    - toggle state, for the modal cut and merge tools.
 *   titleFn()   - a tooltip that has to be recomputed (undo/redo depth).
 *   shortcut    - the key that does the same thing, drawn into the tooltip.
 *                 Named `shortcut` rather than `key` because a group already
 *                 has a `key`. The binding itself is registered in
 *                 _registerKeys() below, and a test pins the two lists to
 *                 each other.
 *
 * refresh() re-evaluates all three for every button, and is called from the
 * few places that change the answers: a fetch, a cluster change, a history
 * push, a mode toggle, a reset. setActive() and refresh() are the seam other
 * modules use; none of them reaches into the DOM for a button.
 *
 * Translation:
 *   - Labels and static tooltips carry data-i18n / data-i18n-attrs, so
 *     App.i18n.apply(document.body) refreshes them on a language change.
 *   - Computed titles - an undo depth, a disabled reason, "Show or hide
 *     Streets" - do not survive an App.i18n.apply() pass, so refresh() is
 *     registered as an i18n listener and rebuilds them. With URL routing a
 *     language change is a page load, so this matters only for an in-place
 *     switch.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.controls = (function () {
  "use strict";

  var s = null;
  var T = null;
  var D = null;
  var _map = null;
  var _aidNote = null;
  var _panel = null;

  /** id -> { spec, node } for every rendered button. */
  var _items = {};

  var COLLAPSE_KEY = "osmapp.toolbar.collapsed";
  var NARROW_PX = 720;

  // A Font Awesome class per basemap the server may send, drawn on the picker's
  // tile the way every other glyph in this panel is drawn.
  //
  // A webfont icon rather than an emoji: an emoji is a picture the platform
  // draws, so it arrives in whatever weight, color and size the font vendor
  // chose and sits beside 27 line icons that share none of those. The tile is
  // the one place the current basemap is named, so it is the one place that
  // difference is on screen the whole time.
  //
  // The list below the tile carries the same icons: it is the app's own menu,
  // which paints an <i> per row, so a layer is named the same way in both
  // places.
  //
  // Keyed by id rather than derived from it, because the choice is editorial. An
  // id absent from this table falls back to a globe, so an aid layer added
  // server-side needs no change here.
  var BASEMAP_ICONS = {
    osm: "fa-map",
    imagery: "fa-satellite",
    terrain: "fa-mountain-sun",
  };

  var BASEMAP_ICON_FALLBACK = "fa-earth-europe";

  // Availability predicates
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
    return hasBoundary() || hasClusters() || hasNotes();
  }

  function hasNotes() {
    return App.notes.count() > 0;
  }

  /**
   * The zoom limits are the basemap's, not the map's: getMaxZoom() answers
   * from the layers currently on the map, so switching to an aid basemap that
   * stops at 17 greys the button out at 17 rather than letting the click zoom
   * past the last tile that exists. Both read the live map, so refresh() on
   * "zoomend" is what keeps the pair honest.
   */
  function canZoomIn() {
    return !!_map && _map.getZoom() < _map.getMaxZoom();
  }

  function canZoomOut() {
    return !!_map && _map.getZoom() > _map.getMinZoom();
  }

  // TOOLBAR CONTENT

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
          shortcut: "D",
          // The polygon tool is also the way back into an existing boundary --
          // clicking it with one already set offers "edit instead" - so it
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
          shortcut: "G",
          onClick: _locate,
        },
        {
          id: "refetch",
          icon: "fa-cloud-arrow-down",
          labelKey: "toolbar.labelRefetch",
          titleKey: "toolbar.refetch",
          disabledTitleKey: "toolbar.needsBoundary",
          accent: "blue",
          shortcut: "R",
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
          shortcut: "T",
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
          shortcut: "S",
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
          shortcut: "C",
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
          shortcut: "M",
          enabled: hasTwoClusters,
          active: function () {
            return !!s.mergeMode;
          },
          onClick: function () {
            App.editing.toggleMergeMode();
          },
        },
        {
          // The app exists to produce cards, and the only other way to ask
          // for one is to right-click the right shape on the map: a gesture
          // you have to already know about, aimed at a polygon you have to
          // already have found. This opens the list instead, where every row
          // has a printer and a number beside it.
          id: "print",
          icon: "fa-print",
          labelKey: "toolbar.labelPrint",
          titleKey: "toolbar.print",
          disabledTitleKey: "toolbar.needsTerritories",
          accent: "green",
          shortcut: "P",
          enabled: hasClusters,
          onClick: function () {
            App.labels.openList();
          },
        },
        {
          // Doing a territory again next round means the same shapes with a
          // clean slate of marks, which is otherwise a right-click per
          // territory. Disabled - not hidden - when there is nothing marked,
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
      // Its own group rather than a tile in Territories: a note is a remark
      // about the ground, not a subdivision of it. It outlives a
      // re-partition, it may sit outside the boundary, and nothing in the
      // group above has an opinion about one - which is three reasons the two
      // do not belong under the same heading.
      key: "notes",
      titleKey: "toolbar.groupNotes",
      buttons: [
        {
          id: "notes",
          icon: "fa-pen-to-square",
          labelKey: "toolbar.labelNotes",
          titleKey: "toolbar.notes",
          accent: "orange",
          shortcut: "A",
          active: function () {
            return !!s.noteMode;
          },
          onClick: function () {
            App.notes.toggle();
          },
        },
        {
          // Disabled rather than hidden, like Clear marks beside it: a greyed
          // tile says there is nothing to clear, a missing one says nothing
          // at all.
          id: "clear-notes",
          icon: "fa-eraser",
          labelKey: "toolbar.labelClearNotes",
          titleKey: "toolbar.clearNotes",
          disabledTitleKey: "toolbar.needsNotes",
          accent: "red",
          enabled: hasNotes,
          onClick: _clearNotes,
        },
      ],
    },
    {
      // What is on screen, as opposed to what is in the document: no switch
      // here changes a territory, a boundary or a download, which is what
      // separates the group from every other one in the panel.
      //
      // The zoom pair and the basemap drop-down share the first line: all
      // three are about the map underneath rather than about what is drawn on
      // it, and three and a half tiles of the panel's six hold them. The
      // basemap is one drop-down rather than a row of switches because the
      // choice is exclusive. Then a divider, then the overlays, each its own
      // toggle. The layer switches are never disabled - one that greys out
      // cannot be used to find out whether the data arrived - so Numbers is the
      // only entry with an enabled() predicate.
      key: "view",
      titleKey: "toolbar.groupView",
      noteTemplate: "tpl-toolbar-note",
      buttons: [
        // The zoom pair heads the line: it is the switch used most often and
        // the only one here that is a plain action rather than a state. It
        // stands in for Leaflet's own zoom control, which main.js suppresses
        // with zoomControl: false - two unlabelled squares in this same
        // corner, styled by leaflet.css and by nothing in this app.
        //
        // Disabled at the ends of the scale rather than silently doing
        // nothing, which is the whole reason a button gets an enabled()
        // predicate here: the tooltip then says why, and the greyed tile says
        // that the map is as close in as this basemap goes rather than that
        // the click missed.
        {
          id: "zoom-in",
          icon: "fa-magnifying-glass-plus",
          labelKey: "toolbar.labelZoomIn",
          titleKey: "toolbar.zoomIn",
          disabledTitleKey: "toolbar.atMaxZoom",
          accent: "green",
          enabled: canZoomIn,
          onClick: function () {
            _map.zoomIn();
          },
        },
        {
          id: "zoom-out",
          icon: "fa-magnifying-glass-minus",
          labelKey: "toolbar.labelZoomOut",
          titleKey: "toolbar.zoomOut",
          disabledTitleKey: "toolbar.atMinZoom",
          accent: "green",
          enabled: canZoomOut,
          onClick: function () {
            _map.zoomOut();
          },
        },
        { id: "basemap", custom: _mountBasemapPicker },
        { separator: true },
        {
          id: "layer-outer",
          // A crop frame rather than a polygon: fa-draw-polygon is the Draw
          // button's glyph, and a collapsed panel has dropped the labels that
          // would tell two identical icons apart.
          icon: "fa-crop-simple",
          labelKey: "toolbar.labelLayerOuter",
          accent: "blue",
          active: _overlayShown("outerPolygonLayerGroup"),
          titleFn: _overlayTitle("layers.outer"),
          onClick: _toggleOverlay("outerPolygonLayerGroup"),
        },
        {
          id: "layer-streets",
          icon: "fa-road",
          labelKey: "toolbar.labelLayerStreets",
          accent: "blue",
          active: _overlayShown("streetsLayerGroup"),
          titleFn: _overlayTitle("layers.streets"),
          onClick: _toggleOverlay("streetsLayerGroup"),
        },
        {
          id: "layer-buildings",
          icon: "fa-building",
          labelKey: "toolbar.labelLayerBuildings",
          accent: "blue",
          active: _overlayShown("buildingsLayerGroup"),
          titleFn: _overlayTitle("layers.buildings"),
          onClick: _toggleOverlay("buildingsLayerGroup"),
        },
        {
          // The number chips ride along in this one: they are territories,
          // not a separate kind of thing to switch on and off. Which is also
          // why the Numbers button below is a second switch rather than a
          // duplicate of this one - that one draws the chips, this one draws
          // the shapes they sit on.
          id: "layer-clusters",
          icon: "fa-object-group",
          labelKey: "toolbar.labelLayerClusters",
          accent: "purple",
          active: _overlayShown("innerPolygonsLayerGroup"),
          titleFn: _overlayTitle("layers.clusters"),
          onClick: _toggleOverlay("innerPolygonsLayerGroup"),
        },
        {
          // Its own switch rather than riding with the territories: it is the
          // opposite of a territory, and somebody who has finished checking
          // the coverage can put it away without losing the shapes it was
          // drawn against.
          //
          // The only switch here that is not merely a draw call: App.gaps
          // stops subtracting while it is off (see setVisible there), so this
          // one goes through the module rather than through the map, and the
          // layer group stays where main.js put it.
          id: "layer-gaps",
          icon: "fa-triangle-exclamation",
          labelKey: "toolbar.labelLayerGaps",
          accent: "orange",
          active: function () {
            return !!(App.gaps && App.gaps.isVisible());
          },
          titleFn: _overlayTitle("layers.gaps"),
          onClick: function () {
            if (!App.gaps) return;
            App.gaps.setVisible(!App.gaps.isVisible());
            refresh();
          },
        },
        {
          // Beside the other overlays rather than with the Notes group: this
          // draws or hides them, which is the same kind of switch as Streets
          // and Buildings and a different kind of thing from writing one.
          id: "layer-notes",
          icon: "fa-note-sticky",
          labelKey: "toolbar.labelLayerNotes",
          accent: "orange",
          active: function () {
            return App.notes.isVisible();
          },
          titleFn: _overlayTitle("layers.notes"),
          onClick: function () {
            App.notes.setVisible(!App.notes.isVisible());
            refresh();
          },
        },
        {
          // A view switch rather than a territory tool: it changes the
          // picture and not the document, which is what puts it in this group.
          // The count in the info panel is a number people check against the
          // map by eye, and they lose - this puts the same number *on* each
          // territory, so counting is reading rather than searching.
          id: "numbers",
          icon: "fa-hashtag",
          labelKey: "toolbar.labelNumbers",
          titleKey: "toolbar.numbers",
          disabledTitleKey: "toolbar.needsTerritories",
          accent: "purple",
          shortcut: "N",
          enabled: hasClusters,
          active: function () {
            return App.labels.isVisible();
          },
          onClick: function () {
            App.labels.setVisible(!App.labels.isVisible());
            refresh();
          },
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
          // out, with a tooltip that says what is missing - a button that
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
          shortcut: "H",
          onClick: function () {
            App.tour.start();
          },
        },
        {
          // The tour teaches the workflow once; this answers "what can I
          // press right now", which is a different question and needs a
          // button of its own.
          id: "shortcuts",
          icon: "fa-keyboard",
          labelKey: "toolbar.labelShortcuts",
          titleKey: "toolbar.shortcuts",
          accent: "blue",
          shortcut: "?",
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

  // LIFECYCLE

  function init(leafletMap) {
    s = App.state;
    T = App.i18n.t;
    D = App.dom;
    _map = leafletMap;

    _makePanel().addTo(leafletMap);

    // A basemap can also be chosen from outside the toolbar - the session
    // restore picks the remembered one - so the group's own state is painted
    // from the change rather than from the click, and the aid note with it.
    App.basemap.onChange(function () {
      _syncAidNote();
      refresh();
    });

    App.i18n.onChange(refresh);

    // The zoom pair is the only button in the panel whose availability the map
    // changes on its own - a scroll wheel, a double-click, a fitBounds - so it
    // is the only one that needs the map to say when it moved.
    leafletMap.on("zoomend", refresh);

    _registerKeys();
    refresh();
    App._loaded.push("controls");
  }

  // Keys for the toolbar

  /**
   * Entering a modal tool needs keys of its own. Every one of them answers a
   * dozen keys once it is running, so without these the shortcut sheet on the
   * main map lists five lines - help, escape, right-click, undo, redo - one
   * keystroke before listing fourteen, which reads as an app that mostly has
   * no shortcuts.
   *
   * Two rules make single letters safe here.
   *
   *   - `_idle()` - none of these fire while a modal tool is running. The
   *     tools bind their own letters and are innermost on the stack, but only
   *     for the letters they use: without this, T inside the merge tool would
   *     start trimming from underneath it.
   *   - The registry already refuses to fire a character-producing combo into
   *     a text field, so the search box and the card fields are unaffected.
   *
   * Availability reuses the buttons' own predicates rather than restating
   * them, so an entry that is greyed on the sheet is greyed for the same
   * reason the button is.
   */
  function _registerKeys() {
    App.shortcuts.global(
      [
        { combos: ["D"], labelKey: "shortcuts.goDraw", run: _draw },
        { combos: ["G"], labelKey: "shortcuts.goLocate", run: _locateFromKey },
        {
          combos: ["R"],
          labelKey: "shortcuts.goRefetch",
          when: hasBoundary,
          run: _refetch,
        },
        {
          combos: ["T"],
          labelKey: "shortcuts.goTrim",
          when: function () {
            return hasBoundary() && hasBuildings();
          },
          run: function () {
            App.trim.toggle();
          },
        },
        {
          combos: ["S"],
          labelKey: "shortcuts.goSplit",
          when: function () {
            return hasBoundary() && hasData();
          },
          run: function () {
            App.clustering.showClusterDialog();
          },
        },
        {
          combos: ["C"],
          labelKey: "shortcuts.goCut",
          when: hasClusters,
          run: function () {
            App.editing.toggleEditMode();
          },
        },
        {
          combos: ["M"],
          labelKey: "shortcuts.goMerge",
          when: hasTwoClusters,
          run: function () {
            App.editing.toggleMergeMode();
          },
        },
        {
          combos: ["N"],
          labelKey: "shortcuts.goNumbers",
          when: hasClusters,
          run: function () {
            App.labels.setVisible(!App.labels.isVisible());
            refresh();
          },
        },
        {
          combos: ["P"],
          labelKey: "shortcuts.goPrint",
          when: hasClusters,
          run: function () {
            App.labels.openList();
          },
        },
        {
          combos: ["A"],
          labelKey: "shortcuts.goNotes",
          run: function () {
            App.notes.toggle();
          },
        },
        {
          combos: ["H"],
          labelKey: "shortcuts.goTour",
          run: function () {
            App.tour.start();
          },
        },
      ].map(_whenIdle),
    );
  }

  /** No modal tool is running and no boundary is being drawn. */
  function _idle() {
    if (s.editMode || s.mergeMode || s.trimMode || s.outlineMode || s.noteMode)
      return false;
    var tools = s.leafletMap && s.leafletMap.editTools;
    return !(tools && tools.drawing());
  }

  /**
   * Fold _idle() into whatever the entry already asked for, so the sheet greys
   * every one of these while a tool owns the keyboard - which is also the
   * honest answer to "what can I press right now".
   */
  function _whenIdle(entry) {
    var own = entry.when;
    entry.when = own
      ? function () {
          return _idle() && own();
        }
      : _idle;
    return entry;
  }

  /** _locate() spins the icon on the node it was clicked from; there is none. */
  function _locateFromKey() {
    var item = _items.locate;
    _locate(item ? item.node : null);
  }

  // The View group

  /**
   * The basemap drop-down: one tile, the glyph of the current choice, and the
   * layers the server offers as its options.
   *
   * A select rather than one tile per basemap, for the reason the language
   * picker is one: the choice is exclusive and the options are named, so a row
   * of mutually exclusive tiles spends three tiles' width - and three rows of a
   * collapsed panel - saying what one control says. Which basemaps exist is a
   * server decision (config.AID_LAYERS, an empty URL removes one), so the
   * options are built from App.basemap rather than written out.
   *
   * Each option is the layer's full name: a list has room for "Satellite
   * imagery" where a 52 px tile does not. No pictogram in front of it, unlike
   * the language picker's flags - the tile's glyph comes out of the icon font
   * (see BASEMAP_ICONS) and an <option> paints plain text only.
   *
   * @returns {HTMLElement} the tile, which _makePanel names with data-action.
   */
  function _mountBasemapPicker(host) {
    var node = D.mount("tpl-basemap-control", host);
    var button = D.role(node, "basemap");
    var glyph = D.role(node, "glyph");

    /**
     * The glyph is the only thing on the tile that says which basemap is on,
     * since the label names the control. Painted from the change rather than
     * from the click, so a basemap chosen elsewhere - the session restore picks
     * the remembered one - shows here too.
     *
     * className rather than classList, so the previous basemap's icon goes when
     * the new one arrives; the tile class is restated for the same reason.
     */
    function show() {
      glyph.className = "tb-item__icon fa-solid " + _icon(App.basemap.current());
    }

    show();
    App.basemap.onChange(show);

    // Built on the click, which is what keeps the names in the current
    // language and the tick on the current layer without a listener for
    // either. Which layers exist is a server decision, so the list comes from
    // App.basemap rather than from anything written here.
    button.addEventListener("click", function () {
      var current = App.basemap.current();
      _openTileMenu(
        node,
        App.basemap.entries().map(function (entry) {
          return {
            labelKey: entry.labelKey,
            // Its own icon, so the row says which layer it is - replaced by
            // the tick on the one that is on, which is the more useful of the
            // two things an icon column can say here.
            icon: entry.id === current ? "fa-check" : _icon(entry.id),
            checked: entry.id === current,
            onClick: function () {
              App.basemap.select(entry.id);
            },
          };
        }),
      );
    });

    return node;
  }

  function _icon(id) {
    return BASEMAP_ICONS[id] || BASEMAP_ICON_FALLBACK;
  }

  /** @returns {Function} A predicate: true while `key`'s group is on the map. */
  function _overlayShown(key) {
    return function () {
      return !!(s[key] && _map.hasLayer(s[key]));
    };
  }

  /** @returns {Function} A click handler that adds or removes `key`'s group. */
  function _toggleOverlay(key) {
    return function () {
      var group = s[key];
      if (!group) return;
      if (_map.hasLayer(group)) _map.removeLayer(group);
      else _map.addLayer(group);
      refresh();
    };
  }

  /**
   * A tooltip naming the layer, e.g. "Show or hide Streets".
   *
   * Interpolated rather than given a key per layer, so the layer names stay in
   * one place in the dictionary: a "Show or hide Streets" spelled out per
   * switch is a second copy of every name to keep in step with the first.
   */
  function _overlayTitle(nameKey) {
    return function () {
      return T("toolbar.layerToggle", { name: T(nameKey) });
    };
  }

  function _syncAidNote() {
    if (_aidNote) D.toggle(_aidNote, App.basemap.isAid());
  }

  // PANEL

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
          // dynamic() first, then the written-out buttons, so a group that is
          // partly server-driven puts what the server sent at the top of its
          // own list rather than after it.
          var specs = (group.dynamic ? group.dynamic() : []).concat(
            group.buttons || [],
          );
          specs.forEach(function (spec) {
            if (spec.separator) {
              D.mount("tpl-toolbar-break", host);
              return;
            }
            if (spec.custom) {
              // Named the same way as the buttons beside it. The two custom
              // tiles share one class with each other and their own class with
              // nothing, so without this the only selector that reaches the
              // language picker also reaches the basemap one - and the guided
              // tour, which addresses every other tile as [data-action="id"],
              // spotlit whichever of the two the panel happened to build
              // first.
              var tile = spec.custom(host);
              if (tile && tile.dataset) tile.dataset.action = spec.id;
              return;
            }
            _items[spec.id] = { spec: spec, node: _makeButton(spec, host) };
          });

          // Below the items rather than inside them: it is a sentence about
          // the group, and it is hidden until it has something to say.
          if (group.noteTemplate) {
            _aidNote = D.mount(group.noteTemplate, section);
            _syncAidNote();
          }
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
   *          shortcut?:string, onClick?:Function, setup?:Function,
   *          href?:string}} spec
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

  // Collapse

  /**
   * Labels cost roughly 90 px of map width. That is a fair trade on a desktop
   * and a bad one on a phone, so narrow screens start collapsed unless the
   * user has already said otherwise.
   */
  function _initialCollapsed() {
    // No stored answer - including "storage is unavailable" - falls through
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

  // BUTTON STATE

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
    // A key belonging to a button is part of what the button is, so it goes in
    // the tooltip the way undo and redo carry theirs. That makes the mapping
    // no longer declarative, so the title is computed here rather than left to
    // data-i18n-attrs.
    if (spec.shortcut) {
      node.removeAttribute("data-i18n-attrs");
      node.title = _withKey(T(spec.titleKey), spec.shortcut);
      node.setAttribute("aria-label", node.title);
      return;
    }
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
   * "Undo last change (3 available) - Ctrl+Z".
   *
   * The cut toolbar shows its keys on <kbd> tags; this is how the main
   * toolbar shows its own, so the two most-used shortcuts in the app are not
   * also the two least discoverable. Rendered through App.shortcuts so a Mac
   * reads ⌘ rather than being told about a key its keyboard labels
   * differently.
   */
  function _withKey(title, combo) {
    return title + " — " + App.shortcuts.hint(combo);
  }

  // ACTIONS

  function _draw() {
    // The button shows itself as active while the outline editor runs, and a
    // control that looks pressed has to be the way to unpress it - otherwise
    // clicking it asks "replace this boundary?" about the shape currently
    // being edited, which is a question about the wrong thing.
    if (s.outlineMode) {
      App.outline.cancel();
      return;
    }

    _confirmReplaceOuter().then(function (answer) {
      if (answer === "alt") {
        // "I clicked the polygon tool because I want to change the polygon"
        // is at least as likely a reading as "...because I want a new one", so
        // the dialog offers both rather than only the destructive half.
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

  // Locate

  function _locate(node) {
    if (!navigator.geolocation) {
      alert(T("alert.noGeolocation"));
      return;
    }
    // Null when the shortcut fired it rather than a click: there is nothing
    // to spin, and everything below already tolerates that.
    var icon = node ? D.role(node, "icon") : null;
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

  // Import

  function _setupImportButton(node) {
    var input = document.createElement("input");
    input.type = "file";
    // A printed card is a project too: App.pdfdoc.compose embeds the boundary
    // and the territories in every PDF it builds, so the sheet on somebody's
    // desk is a restore point.
    input.accept = ".geojson,.json,.pdf";
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

  // Language picker

  /**
   * Open a tile's list as the app's own menu, under the tile.
   *
   * Drawn rather than delegated to a <select>, because a native pop-up's size
   * and position are the browser's and it takes both from the control it
   * belongs to - which for these two tiles is 80 px wide and `opacity: 0`.
   * showContextMenu is the menu a right-click on a territory opens: its width
   * is its content's, its rows are the size every other row in the app is, and
   * _placeMenu keeps it on screen.
   *
   * @param {HTMLElement} tile - Positions the menu; the point below is in the
   *   map container's coordinates, which is what _placeMenu measures against.
   * @param {Array<Object>} items - As showContextMenu takes them.
   */
  function _openTileMenu(tile, items) {
    var container = s.leafletMap.getContainer().getBoundingClientRect();
    var box = tile.getBoundingClientRect();
    App.ui.showContextMenu(
      { x: box.left - container.left, y: box.bottom - container.top + 4 },
      items,
    );
  }

  function _mountLanguagePicker(host) {
    var node = D.mount("tpl-language-control", host);
    var button = D.role(node, "lang");
    var flag = D.role(node, "flag");

    /** The button is transparent, so the current flag is drawn separately. */
    function showFlag() {
      var current = App.i18n.current();
      App.i18n.languages().forEach(function (lang) {
        if (lang.code === current) flag.textContent = lang.flag;
      });
    }
    showFlag();
    App.i18n.onChange(showFlag);

    // Flag and endonym, so the list is scannable by shape and readable by
    // anyone who has landed in a language they cannot read. Neither part goes
    // through t(): both are the same string in every language, which is what
    // makes this the one control in the panel a language change leaves alone.
    //
    // Built on the click rather than once, because which one is current
    // changes and the tick has to move with it.
    //
    // setLanguage navigates to that language's URL (/ , /pl, /de, /fr) so the
    // choice is shareable and bookmarkable. Pass { navigate: false } for an
    // in-place swap instead - which is why the flag is kept in sync above
    // rather than left to the page load.
    button.addEventListener("click", function () {
      var current = App.i18n.current();
      _openTileMenu(
        node,
        App.i18n.languages().map(function (lang) {
          return {
            label: lang.flag + " " + lang.name,
            // The flag is the mark that says which language a row is, so the
            // icon column is left to say which one is on.
            icon: lang.code === current ? "fa-check" : "",
            checked: lang.code === current,
            onClick: function () {
              App.i18n.setLanguage(lang.code);
            },
          };
        }),
      );
    });

    return node;
  }

  // Reset

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
   *   alone. Only the tour passes it - a real reset must clear the store, or
   *   the reset survives exactly until the next reload.
   */
  function clearAll(opts) {
    if (App.history) App.history.clear();
    if (s.editMode) App.editing.toggleEditMode();
    if (s.mergeMode) App.editing.toggleMergeMode();
    if (s.trimMode) App.trim.toggle();
    if (s.outlineMode) App.outline.toggle();
    if (s.noteMode) App.notes.toggle();
    App.notes.clear();

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
    // holds the rows describing them - and ui.refreshInfo asks those rows how
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

  /**
   * Throw every annotation away, after asking.
   *
   * Asked rather than undoable, unlike a single deletion: the note tool's undo
   * stack lives only while the tool is open, so by the time this button is
   * reachable there is nothing left to take it back.
   */
  function _clearNotes() {
    App.ui
      .confirm({
        titleKey: "notes.clearTitle",
        messageKey: "notes.clearMessage",
        okKey: "notes.clearOk",
        danger: true,
      })
      .then(function (yes) {
        if (yes) App.notes.clear();
      });
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
  };
})();

window.App = App;
