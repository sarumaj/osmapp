/**
 * controls.js — custom Leaflet toolbar controls, the language picker and
 * resetAll().
 *
 * Translation notes:
 *   • Button tooltips carry data-i18n-attrs, so App.i18n.apply(document.body)
 *     refreshes them on a language change without this module tracking them.
 *   • The undo and redo buttons deliberately have no titleKey: history.js owns
 *     their tooltips because the text includes the stack depth.
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
  var _map = null;
  var _layerControl = null;

  var BUTTONS = [
    {
      icon: "fa-draw-polygon",
      titleKey: "toolbar.draw",
      accent: "blue",
      onClick: function () {
        if (s.outerPolygonDrawn && !confirm(T("alert.replaceOuter"))) return;
        s.leafletMap.editTools.startPolygon();
      },
    },
    {
      icon: "fa-rotate-left",
      accent: "red",
      btnClass: "undo-btn",
      onClick: function () {
        App.history.undo();
      },
    },
    {
      icon: "fa-rotate-right",
      accent: "blue",
      btnClass: "redo-btn",
      onClick: function () {
        App.history.redo();
      },
    },
    {
      icon: "fa-location-crosshairs",
      titleKey: "toolbar.locate",
      accent: "blue",
      onClick: _locate,
    },
    {
      icon: "fa-file-import",
      titleKey: "toolbar.import",
      accent: "green",
      setup: _setupImportButton,
    },
    {
      icon: "fa-file-export",
      titleKey: "toolbar.export",
      accent: "orange",
      barClass: "export-toolbar",
      onClick: function () {
        App.data.exportData();
      },
    },
    {
      icon: "fa-cloud-arrow-down",
      titleKey: "toolbar.refetch",
      accent: "blue",
      barClass: "fetch-toolbar",
      onClick: function () {
        if (!s.outerPolygonLayer) {
          alert(T("alert.drawFirst"));
          return;
        }
        App.data.fetchData(s.outerPolygonLayer.toGeoJSON(), true);
      },
    },
    {
      icon: "fa-shapes",
      titleKey: "toolbar.partition",
      accent: "purple",
      onClick: function () {
        App.clustering.showClusterDialog();
      },
    },
    {
      icon: "fa-scissors",
      titleKey: "toolbar.cut",
      accent: "purple",
      btnClass: "edit-mode-btn",
      onClick: function () {
        App.editing.toggleEditMode();
      },
    },
    {
      icon: "fa-code-merge",
      titleKey: "toolbar.merge",
      accent: "yellow",
      btnClass: "merge-mode-btn",
      onClick: function () {
        App.editing.toggleMergeMode();
      },
    },
    {
      icon: "fa-broom",
      titleKey: "toolbar.cleanup",
      accent: "green",
      onClick: function () {
        App.editing.cleanupClusters();
      },
    },
    {
      icon: "fa-trash",
      titleKey: "toolbar.reset",
      accent: "red",
      onClick: resetAll,
    },
    {
      // fa-brands, not fa-solid: the GitHub mark lives in a separate webfont.
      icon: "fa-github",
      iconClass: "fa-brands",
      titleKey: "toolbar.github",
      accent: "purple",
      href: "https://github.com/sarumaj/osmapp",
    },
  ];

  function init(leafletMap) {
    s = App.state;
    T = App.i18n.t;
    _map = leafletMap;

    _buildLayerControl();
    BUTTONS.forEach(function (spec) {
      _makeButton(spec).addTo(leafletMap);
    });
    _makeLanguagePicker().addTo(leafletMap);

    App.i18n.onChange(_buildLayerControl);
    App._loaded.push("controls");
  }

  // ── Layer control ─────────────────────────────────────────────────────

  function _buildLayerControl() {
    if (_layerControl) _map.removeControl(_layerControl);
    var overlays = {};
    overlays[T("layers.outer")] = s.outerPolygonLayerGroup;
    overlays[T("layers.streets")] = s.streetsLayerGroup;
    overlays[T("layers.buildings")] = s.buildingsLayerGroup;
    overlays[T("layers.clusters")] = s.innerPolygonsLayerGroup;
    _layerControl = L.control
      .layers(null, overlays, { collapsed: false })
      .addTo(_map);
  }

  // ── Button factory ────────────────────────────────────────────────────

  /**
   * @param {{icon:string, iconClass?:string, titleKey?:string, accent:string,
   *          onClick?:Function, setup?:Function, href?:string,
   *          barClass?:string, btnClass?:string}} spec
   *   href turns the button into a real external link. disableClickPropagation
   *   stops the map seeing the click but does not preventDefault, so navigation
   *   still happens.
   */
  function _makeButton(spec) {
    var Control = L.Control.extend({
      options: { position: "topleft" },
      onAdd: function () {
        var container = L.DomUtil.create(
          "div",
          "leaflet-bar tb-bar" + (spec.barClass ? " " + spec.barClass : ""),
        );
        var link = L.DomUtil.create(
          "a",
          "tb-btn" + (spec.btnClass ? " " + spec.btnClass : ""),
          container,
        );
        if (spec.href) {
          link.href = spec.href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
        } else {
          link.href = "#";
          link.setAttribute("role", "button");
        }
        link.setAttribute("data-accent", spec.accent);

        if (spec.titleKey) {
          link.title = T(spec.titleKey);
          link.setAttribute("aria-label", link.title);
          link.setAttribute(
            "data-i18n-attrs",
            "title=" + spec.titleKey + ";aria-label=" + spec.titleKey,
          );
        }

        var icon = L.DomUtil.create(
          "i",
          (spec.iconClass || "fa-solid") + " " + spec.icon,
          link,
        );
        icon.setAttribute("aria-hidden", "true");

        if (spec.onClick) {
          L.DomEvent.on(link, "click", function (e) {
            L.DomEvent.preventDefault(e);
            L.DomEvent.stopPropagation(e);
            spec.onClick(link, container);
          });
        }
        if (spec.setup) spec.setup(link, container);

        L.DomEvent.disableClickPropagation(container);
        return container;
      },
    });
    return new Control();
  }

  // ── Language picker ───────────────────────────────────────────────────

  function _makeLanguagePicker() {
    var Control = L.Control.extend({
      options: { position: "topleft" },
      onAdd: function () {
        var container = App.dom.render("tpl-language-control");
        var select = App.dom.role(container, "lang");

        App.i18n.languages().forEach(function (lang) {
          var option = document.createElement("option");
          option.value = lang.code;
          option.textContent = lang.label;
          select.appendChild(option);
        });
        select.value = App.i18n.current();

        // setLanguage navigates to that language's URL (/ , /pl, /de) so the
        // choice is shareable and bookmarkable. Pass { navigate: false } for an
        // in-place swap instead.
        select.addEventListener("change", function () {
          App.i18n.setLanguage(select.value);
        });

        L.DomEvent.disableClickPropagation(container);
        return container;
      },
    });
    return new Control();
  }

  // ── Locate ────────────────────────────────────────────────────────────

  function _locate(link) {
    if (!navigator.geolocation) {
      alert(T("alert.noGeolocation"));
      return;
    }
    var icon = link.querySelector("i");
    if (icon) icon.className = "fa-solid fa-spinner fa-spin";

    function restore() {
      if (icon) icon.className = "fa-solid fa-location-crosshairs";
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

  function _setupImportButton(link) {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = ".geojson,.json";
    input.hidden = true;
    document.body.appendChild(input);

    L.DomEvent.on(link, "click", function (e) {
      L.DomEvent.preventDefault(e);
      L.DomEvent.stopPropagation(e);
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

  // ── Reset ─────────────────────────────────────────────────────────────

  function resetAll() {
    if (!confirm(T("alert.resetConfirm"))) return;

    if (App.history) App.history.clear();
    if (s.editMode) App.editing.toggleEditMode();
    if (s.mergeMode) App.editing.toggleMergeMode();

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

    App.ui.setInfoDefault();
    App.ui.hideExportToolbar();
    App.ui.closeContextMenu();
    s.leafletMap.setView([47.3769, 8.5417], 13);
  }

  return { init: init, resetAll: resetAll };
})();

window.App = App;
