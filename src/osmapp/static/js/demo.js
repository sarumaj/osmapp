/**
 * demo.js — the sample territory the guided tour works on.
 *
 * Half of what this app does only exists as a dialog: the partitioner, the cut
 * tool, the merge bar, the context menu, the print view. None of them can be
 * opened without a boundary, downloaded streets and at least one territory —
 * which is exactly what a first-time visitor does not have. A tour that can
 * only describe those screens in prose is describing the half that is hardest
 * to imagine.
 *
 * So the tour borrows the app for a minute: it loads a small sample area,
 * opens the real dialogs on it, and then puts back whatever was there before.
 *
 * ── Why the data is invented rather than downloaded ────────────────────────
 *
 * A bundled extract of a real place would look better on the basemap, and it
 * would also be several hundred kilobytes of OpenStreetMap data shipped in the
 * app, stale from the day it was cut, and a licensing footnote nobody reads.
 * Fetching a real area instead would make the tour need Overpass, a working
 * connection and ten seconds of patience before it could say anything.
 *
 * The sample is therefore generated: a small grid village, laid out in metres
 * around a fixed point and projected to WGS84. Its streets are named "Sample
 * street 1" and so on, in the user's language, which is the honest way to
 * signal that none of this is real — better than a plausible-looking fake that
 * leaves someone wondering why their town has moved.
 *
 * ── Why leaving is the interesting part ────────────────────────────────────
 *
 * enter() is easy. leave() has to be right every single time, including when
 * the tour is abandoned with Escape halfway through, because the alternative
 * is a user whose afternoon of territory work was replaced by a demo village.
 * Two things protect it:
 *
 *   • The snapshot is the app's own export payload, taken before anything is
 *     touched, and restored through the same applyPayload() that a file import
 *     uses. Nothing bespoke, nothing that can drift from the real code path.
 *   • The session store is suspended for the whole visit, so the sample never
 *     reaches IndexedDB. Even a browser crash mid-tour loses nothing: the last
 *     saved session is still the user's own.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.demo = (function () {
  "use strict";

  var s = null;

  // ── Where and how big ─────────────────────────────────────────────────
  //
  // Farmland in central Poland: far enough from anything for the basemap
  // underneath to be fields rather than somebody else's streets, and in the
  // part of the world these cards are printed for.
  var ROOT = { lng: 19.36, lat: 52.16 };

  // A few degrees off north. A grid aligned exactly to the axes reads as graph
  // paper; the same grid turned slightly reads as a place.
  var ROTATION_DEG = 8;

  var M_PER_DEG_LAT = 111320;

  var AVENUES = [0, 190, 380, 570]; // east–west, metres north of ROOT
  var STREETS = [0, 230, 460, 690, 920]; // north–south, metres east of ROOT
  var MARGIN = 70; // how far the outer boundary runs past the outermost street
  var OVERHANG = 40; // how far each street runs past the last crossing

  var HOUSE_SPACING = 110; // along an avenue
  var HOUSE_OFFSET = 32; // from the centre line
  var HOUSE_W = 14;
  var HOUSE_D = 10;
  var JUNCTION_CLEAR = 30; // no houses this close to a crossing

  // ── The outfield ──────────────────────────────────────────────────────
  //
  // A track running east out of the village with three farms strung along it,
  // and a boundary drawn wide enough to contain them.
  //
  // This exists for the trim step. On a tidy grid with the boundary pulled
  // tight around it there is nothing to trim, so the tool opened on a sample
  // where it visibly did nothing — which teaches the opposite of the point.
  // The farms are spaced far enough apart that the outlier pass finds them by
  // its own rule rather than by anything rigged here, and the empty half of
  // the boundary is the thing the tool is for.
  // Spaced by more than three times the village's own median plot spacing,
  // which is the rule the outlier pass actually applies. Closer together and
  // they would be a hamlet — correctly, and uselessly for the walkthrough.
  var FARMS = [1550, 1850, 2150]; // meters east, all on the track
  var FARM_Y = 285; // between the second and third avenue
  var FARM_W = 20;
  var FARM_D = 16;

  // The territories are cut on these grid lines, so their edges land on real
  // streets exactly as the partitioner's would.
  var SPLIT_X = 460;
  var SPLIT_Y = 380;
  // A second north-south cut, out in the outfield. Without it the eastern
  // territory is most of the working area and the partition step introduces
  // the partitioner with one territory eight times the size of its neighbors.
  var SPLIT_FIELD = 1250;

  var _active = false;
  var _snapshot = null;
  var _view = null;

  function init() {
    s = App.state;
    App._loaded.push("demo");
  }

  // ══════════════════════════════════════════════════════════════════════
  // GEOMETRY
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Local metres (x east, y north) to [lng, lat].
   *
   * Flat-earth on purpose. Over 900 m the error against a proper projection is
   * centimetres, and the alternative is a projection library for a village
   * that does not exist.
   */
  function _project(x, y) {
    var a = (ROTATION_DEG * Math.PI) / 180;
    var rx = x * Math.cos(a) - y * Math.sin(a);
    var ry = x * Math.sin(a) + y * Math.cos(a);
    var perLng = M_PER_DEG_LAT * Math.cos((ROOT.lat * Math.PI) / 180);
    return [
      _round(ROOT.lng + rx / perLng),
      _round(ROOT.lat + ry / M_PER_DEG_LAT),
    ];
  }

  /** Six decimals is about 10 cm — past that it is noise in a bigger file. */
  function _round(value) {
    return Math.round(value * 1e6) / 1e6;
  }

  function _rect(x0, y0, x1, y1) {
    return [
      [
        _project(x0, y0),
        _project(x1, y0),
        _project(x1, y1),
        _project(x0, y1),
        _project(x0, y0),
      ],
    ];
  }

  function _lineFeature(from, to, name, index) {
    var length = Math.round(
      Math.sqrt(
        Math.pow(to[0] - from[0], 2) + Math.pow(to[1] - from[1], 2),
      ),
    );
    return {
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [_project(from[0], from[1]), _project(to[0], to[1])],
      },
      properties: {
        name: name,
        highway: index < AVENUES.length ? "residential" : "unclassified",
        surface: index % 3 === 0 ? "asphalt" : "paving_stones",
        length: length,
      },
    };
  }

  /**
   * Looked up through App.i18n rather than a captured `t`, so that building
   * the sample never depends on init() having run — the payload is pure data
   * and the tests build it without a map, a state object or a DOM.
   */
  function _streetName(index) {
    return App.i18n.t("demo.street", { n: index + 1 });
  }

  /** East edge of the working area: far enough out to hold the last farm. */
  function _east() {
    return Math.max(
      STREETS[STREETS.length - 1] + MARGIN,
      FARMS[FARMS.length - 1] + MARGIN + FARM_W,
    );
  }

  function _streets() {
    var out = [];
    var minX = STREETS[0] - OVERHANG;
    var maxX = STREETS[STREETS.length - 1] + OVERHANG;
    var minY = AVENUES[0] - OVERHANG;
    var maxY = AVENUES[AVENUES.length - 1] + OVERHANG;

    AVENUES.forEach(function (y, i) {
      out.push(_lineFeature([minX, y], [maxX, y], _streetName(i), i));
    });
    STREETS.forEach(function (x, i) {
      var index = AVENUES.length + i;
      out.push(_lineFeature([x, minY], [x, maxY], _streetName(index), index));
    });

    // The track out to the farms. Without it they sit in a field with no way
    // to reach them, which is not a place anybody is given a card for.
    var track = AVENUES.length + STREETS.length;
    out.push(
      _lineFeature(
        [STREETS[STREETS.length - 1], FARM_Y],
        [FARMS[FARMS.length - 1] + 40, FARM_Y],
        _streetName(track),
        track,
      ),
    );
    return out;
  }

  /** True when a point along an avenue is too close to a crossing street. */
  function _nearJunction(x) {
    for (var i = 0; i < STREETS.length; i++) {
      if (Math.abs(x - STREETS[i]) < JUNCTION_CLEAR) return true;
    }
    return false;
  }

  function _buildings() {
    var out = [];
    var first = STREETS[0];
    var last = STREETS[STREETS.length - 1];

    AVENUES.forEach(function (y, avenue) {
      var number = 1;
      for (var x = first + 30; x <= last - 30; x += HOUSE_SPACING) {
        if (_nearJunction(x)) continue;
        [1, -1].forEach(function (side) {
          var cy = y + side * HOUSE_OFFSET;
          out.push({
            type: "Feature",
            geometry: {
              type: "Polygon",
              coordinates: _rect(
                x - HOUSE_W / 2,
                cy - HOUSE_D / 2,
                x + HOUSE_W / 2,
                cy + HOUSE_D / 2,
              ),
            },
            properties: {
              building: number % 7 === 0 ? "apartments" : "house",
              "addr:street": _streetName(avenue),
              // Odd on the north side, even on the south, the way a real
              // street is numbered.
              "addr:housenumber": String(side > 0 ? number : number + 1),
              "building:levels": number % 7 === 0 ? "4" : "2",
            },
          });
        });
        number += 2;
      }
    });

    FARMS.forEach(function (x, i) {
      out.push({
        type: "Feature",
        geometry: {
          type: "Polygon",
          coordinates: _rect(
            x - FARM_W / 2,
            FARM_Y - FARM_D / 2,
            x + FARM_W / 2,
            FARM_Y + FARM_D / 2,
          ),
        },
        properties: {
          building: "farm",
          "addr:street": _streetName(AVENUES.length + STREETS.length),
          "addr:housenumber": String(i * 2 + 1),
          "building:levels": "1",
        },
      });
    });
    return out;
  }

  function _outerRing() {
    return _rect(
      STREETS[0] - MARGIN,
      AVENUES[0] - MARGIN,
      _east(),
      AVENUES[AVENUES.length - 1] + MARGIN,
    );
  }

  /**
   * Four territories tiling the boundary, split on two of the grid lines.
   *
   * One of them carries a printed mark, so the green fill and the tick are on
   * screen from the moment the sample loads rather than being described in the
   * abstract two steps later.
   */
  function _clusters() {
    var west = STREETS[0] - MARGIN;
    var east = _east();
    var south = AVENUES[0] - MARGIN;
    var north = AVENUES[AVENUES.length - 1] + MARGIN;

    var boxes = [
      [west, south, SPLIT_X, SPLIT_Y],
      [SPLIT_X, south, SPLIT_FIELD, SPLIT_Y],
      [west, SPLIT_Y, SPLIT_X, north],
      [SPLIT_X, SPLIT_Y, SPLIT_FIELD, north],
      [SPLIT_FIELD, south, east, north],
    ];

    return boxes.map(function (box, i) {
      return {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: _rect(box[0], box[1], box[2], box[3]) },
        properties: i === 0 ? { printed: new Date().toISOString() } : {},
      };
    });
  }

  function _bounds() {
    var ring = _outerRing()[0];
    var lngs = ring.map(function (c) {
      return c[0];
    });
    var lats = ring.map(function (c) {
      return c[1];
    });
    return {
      west: Math.min.apply(null, lngs),
      east: Math.max.apply(null, lngs),
      south: Math.min.apply(null, lats),
      north: Math.max.apply(null, lats),
    };
  }

  /**
   * The sample in the app's own export format, so it goes in through the same
   * door as a file the user imported.
   *
   * Rebuilt on every call rather than cached: the street names come out of the
   * dictionary, and the dictionary can change while the tour is open.
   */
  function payload() {
    return {
      version: App.data.PAYLOAD_VERSION,
      exportedAt: new Date().toISOString(),
      outerPolygon: {
        type: "Feature",
        geometry: { type: "Polygon", coordinates: _outerRing() },
        properties: {},
      },
      bounds: _bounds(),
      streets: { type: "FeatureCollection", features: _streets() },
      buildings: { type: "FeatureCollection", features: _buildings() },
      clusters: _clusters(),
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  // BORROWING THE APP
  // ══════════════════════════════════════════════════════════════════════

  function isActive() {
    return _active;
  }

  /**
   * Swap the sample in, remembering everything needed to swap it back out.
   *
   * The order matters. The snapshot is taken before the session is suspended
   * only because buildPayload() reads state and writes nothing; everything
   * that *does* write is behind the suspend.
   *
   * @returns {boolean} whether the sample was loaded
   */
  function enter() {
    if (_active) return true;

    try {
      _snapshot = s.outerPolygonLayer ? App.data.buildPayload() : null;
    } catch (e) {
      console.warn(">>> Could not snapshot the current work:", e && e.message);
      // Refusing is the only safe answer: without a snapshot there is nothing
      // to put back, and the tour is not worth someone's afternoon.
      return false;
    }

    _view = {
      center: s.leafletMap.getCenter(),
      zoom: s.leafletMap.getZoom(),
    };

    if (App.session) App.session.setSuspended(true);
    _active = true;

    var sample = payload();

    // The card is composed from tiles, and no tile server has heard of this
    // village — without this the print step would open on an empty field with
    // a red rectangle on it, while the map behind the dialog showed streets
    // and houses. A preview that does not preview teaches the wrong thing
    // about the one feature the whole app exists for.
    if (App.print && App.print.setBasemapOverlay) {
      App.print.setBasemapOverlay({
        streets: sample.streets,
        buildings: sample.buildings,
      });
    }

    try {
      App.data.applyPayload(sample);
    } catch (e) {
      console.warn(">>> Could not load the sample area:", e && e.message);
      leave();
      return false;
    }
    return true;
  }

  /** Put the user's work back. Safe to call when no sample is loaded. */
  function leave() {
    if (!_active) return false;
    _active = false;

    // Before anything else: a print dialog still open on the sample must stop
    // drawing a village that is about to be taken away.
    if (App.print && App.print.setBasemapOverlay) {
      App.print.setBasemapOverlay(null);
    }

    try {
      if (_snapshot) App.data.applyPayload(_snapshot);
      else if (App.controls && App.controls.clearAll) {
        // Nothing to restore, so the app goes back to empty — but the session
        // store is left alone. A first-time visitor has nothing saved anyway,
        // and wiping it would turn "I looked at the tour" into "I lost my
        // boundary" for anyone whose restore had not finished yet.
        App.controls.clearAll({ keepSession: true });
      }
    } catch (e) {
      console.error(">>> Could not restore your work after the tour:", e);
    }

    if (_view) {
      try {
        s.leafletMap.setView(_view.center, _view.zoom);
      } catch (e) {
        /* a view that cannot be restored is not worth failing over */
      }
    }

    var had = !!_snapshot;
    _snapshot = null;
    _view = null;

    if (App.session) {
      App.session.setSuspended(false);
      // Suspending cancelled whatever save was already queued when the tour
      // started, so an edit made in the second before it could be a second
      // that never reached the store. One write closes that window, and it
      // writes exactly what is on screen — which is now the user's own work.
      if (had) App.session.markDirty({ data: true });
    }
    return true;
  }

  /** The first territory of the sample, for steps that need one to point at. */
  function firstCluster() {
    return s.clusters && s.clusters.length ? s.clusters[0] : null;
  }

  return {
    init: init,
    payload: payload,
    enter: enter,
    leave: leave,
    isActive: isActive,
    firstCluster: firstCluster,

    // Exercised by the tests, which check the sample is well-formed before it
    // is ever handed to applyPayload().
  };
})();

window.App = App;
