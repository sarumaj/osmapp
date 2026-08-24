/**
 * naming.js - what to call a territory, read off the OSM data already on the map.
 *
 * The print dialog's number field is answered exactly by labels.numberOf. The
 * locality is not on screen anywhere: it lives in the address tags of the
 * buildings inside the shape, which the app has already downloaded, drawn and
 * tallied. Three sources, in order:
 *
 *   1. addr:city / addr:place / addr:suburb on the buildings whose centroid
 *      falls inside this territory. Whichever name most of them agree on is
 *      the answer, because a territory that straddles a boundary really does
 *      contain two localities. addr:place carries the same weight as
 *      addr:city on purpose: rural Poland numbers houses against the
 *      settlement rather than a street, and there the village name is only
 *      ever in addr:place. addr:suburb is weighted down rather than dropped --
 *      a real name for a real place, just a smaller one than the field
 *      usually wants.
 *   2. The same tally over every downloaded building, so a territory whose own
 *      buildings are untagged still offers the names in use next door.
 *   3. Nominatim reverse geocoding of an interior point, folded in when it
 *      arrives. This is the one that works where the first two do not: a
 *      territory of unaddressed buildings in a village OSM knows by name.
 *
 * Everything here is a *candidate*, never an answer. The caller decides which
 * becomes a placeholder and which become autocomplete entries, and the user
 * overrides both by typing - a congregation's locality wording is its own
 * convention and no address tag knows about it.
 *
 * Nothing is cached across calls except the network lookup. The tally is one
 * pass over the building list per print dialog, and a cache would have to be
 * invalidated on every cut, merge, undo and refetch to stay honest.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.naming = (function () {
  "use strict";

  var s = null;

  /**
   * Address keys that answer "what would a publisher write on the card?",
   * with the weight their agreement carries.
   *
   * Weight multiplies the count rather than ordering the keys outright. Key
   * order alone would let one stray addr:city on a bus shelter outrank two
   * hundred buildings agreeing on an addr:place, which is exactly backwards
   * in the villages where addr:place is the only tag anybody uses.
   */
  var LOCALITY_KEYS = [
    { key: "addr:city", weight: 1 },
    { key: "addr:place", weight: 1 },
    { key: "addr:suburb", weight: 0.5 },
  ];

  /** Enough to choose from; more turns a dropdown into a directory. */
  var MAX_CANDIDATES = 12;

  var _reverse = {}; // "lat,lon|lang" -> Promise, so reopening a card is free

  function init() {
    s = App.state;
    App._loaded.push("naming");
  }

  // READING TAGS

  /**
   * One tag value as usable text, or null.
   *
   * Shared with the tooltips in polygons.js rather than reimplemented beside
   * them: both have to make the same call about the same three shapes, and a
   * value this module counts as a name while that one counts it as blank is a
   * card whose locality contradicts the tooltip it was read from.
   */
  function _text(value) {
    return App.util.tagText(value);
  }

  /**
   * A building's centroid, cached on the feature under the same property
   * polygons.refreshFilteredData uses - so whichever of the two runs first
   * pays for it and the other one does not.
   */
  function _centroid(feature) {
    if (!feature || !feature.geometry) return null;
    if (feature._centroid) return feature._centroid;
    try {
      feature._centroid = turf.centroid({
        type: "Feature",
        geometry: feature.geometry,
        properties: {},
      });
    } catch (e) {
      return null;
    }
    return feature._centroid;
  }

  function _allBuildings() {
    return (s && s.cachedBuildings && s.cachedBuildings.features) || [];
  }

  /**
   * The downloaded buildings whose centroid falls inside `feature`.
   *
   * Centroid rather than intersection, matching the per-territory building
   * count in polygons.js: a building on a boundary belongs to exactly one
   * territory, and the two numbers disagreeing would be worse than either
   * rule being slightly arbitrary.
   */
  function buildingsIn(feature) {
    var out = [];
    if (!feature || !feature.geometry) return out;

    var box;
    try {
      box = turf.bbox(feature);
    } catch (e) {
      return out;
    }

    _allBuildings().forEach(function (building) {
      var centroid = _centroid(building);
      if (!centroid) return;
      var at = centroid.geometry.coordinates;
      if (at[0] < box[0] || at[0] > box[2] || at[1] < box[1] || at[1] > box[3])
        return;
      try {
        if (turf.booleanPointInPolygon(centroid, feature)) out.push(building);
      } catch (e) {
        /* unusable geometry: it simply does not vote */
      }
    });
    return out;
  }

  // CANDIDATES

  /** Tally one set of buildings into scored, ranked candidates. */
  function _rank(buildings, scope) {
    var byValue = {}; // lowercased -> candidate

    LOCALITY_KEYS.forEach(function (spec) {
      buildings.forEach(function (building) {
        var value = _text(building.properties && building.properties[spec.key]);
        if (!value) return;

        var id = value.toLowerCase();
        var candidate = byValue[id];
        if (!candidate) {
          candidate = byValue[id] = {
            value: value,
            kind: spec.key,
            scope: scope,
            count: 0,
            score: 0,
            weight: 0,
          };
        }
        candidate.count++;
        candidate.score += spec.weight;
        // A name tagged both ways keeps the heavier label, so "Mainz" reads
        // as a city even when a handful of buildings call it a suburb.
        if (spec.weight > candidate.weight) {
          candidate.weight = spec.weight;
          candidate.kind = spec.key;
        }
      });
    });

    return Object.keys(byValue)
      .map(function (id) {
        return byValue[id];
      })
      .sort(function (a, b) {
        return b.score - a.score || a.value.localeCompare(b.value);
      });
  }

  /** Concatenate ranked lists, dropping repeats of a name already offered. */
  function _merge() {
    var seen = {};
    var out = [];
    Array.prototype.forEach.call(arguments, function (list) {
      (list || []).forEach(function (candidate) {
        var id = candidate.value.toLowerCase();
        if (seen[id]) return;
        seen[id] = true;
        out.push(candidate);
      });
    });
    return out.slice(0, MAX_CANDIDATES);
  }

  /**
   * Locality names for one territory, best first.
   *
   * The territory's own buildings come first and the rest of the download
   * after them: a name half the round is already using is a better guess than
   * nothing, but it is never a better guess than the addresses inside the
   * shape being printed.
   *
   * @param {object} feature a cluster feature
   * @returns {Array<{value:string, kind:string, scope:string, count:number}>}
   */
  function localityCandidates(feature) {
    var inside = _rank(buildingsIn(feature), "territory");
    var around = _rank(_allBuildings(), "area");
    return _merge(inside, around);
  }

  /** The single best locality guess, or null when the data offers none. */
  function localityFor(feature) {
    var candidates = localityCandidates(feature);
    return candidates.length ? candidates[0].value : null;
  }

  /**
   * Ways of writing this territory's number.
   *
   * The number itself is the answer; the other two are conventions common
   * enough to be worth one keystroke each. Zero padding only appears where it
   * can matter, and the qualified form only when there is a locality to
   * qualify with.
   *
   * @param {object} feature a cluster feature
   * @param {string} [locality] the locality about to be printed beside it
   */
  function territoryCandidates(feature, locality) {
    var out = [];

    // First, and ahead of anything derived from the index: a territory whose
    // card has been printed already has a name, and it is the one somebody
    // typed. Offering "7" to a congregation that spent last month calling this
    // one S-13 is asking them to retype it on every reprint - and the
    // placeholder is taken from the head of this list, so first is what
    // decides whether they have to.
    var known = App.polygons ? App.polygons.labelOf(feature) : "";
    if (known) out.push({ value: known, kind: "printed" });

    var number = App.labels ? App.labels.numberOf(feature) : null;
    if (!number) return out;

    var text = App.i18n ? App.i18n.n(number) : String(number);
    if (text !== known) out.push({ value: text, kind: "number" });
    if (number < 10) out.push({ value: "0" + text, kind: "padded" });
    if (locality)
      out.push({ value: locality + " " + text, kind: "qualified" });
    return out;
  }

  // REVERSE GEOCODING

  /**
   * A point guaranteed to be inside the shape, as [lng, lat].
   *
   * turf.centroid is the vertex mean and lands outside a concave territory
   * often enough to matter - and a reverse lookup on a point in the next
   * village is worse than no lookup at all. Shared with labels.js, so the
   * place this asks Nominatim about is the place the number chip sits on.
   */
  function _interiorPoint(feature) {
    if (!feature || !feature.geometry) return null;
    return App.geometry.interiorCoord({
      type: "Feature",
      geometry: feature.geometry,
      properties: {},
    });
  }

  /**
   * Ask Nominatim what this place is called.
   *
   * Resolves to `[]` on every failure - offline, rate-limited, nothing found.
   * This is an enrichment of a list that is already usable, so a rejected
   * promise would only give the caller an error to swallow.
   *
   * Coordinates are rounded to five decimals before they become the cache
   * key, which is about a meter: two prints of the same territory are one
   * lookup, and the server caches across users on top of that.
   *
   * @param {object} feature a cluster feature
   * @returns {Promise<Array<{value:string, kind:string, scope:string}>>}
   */
  function reverse(feature) {
    var at = _interiorPoint(feature);
    if (!at) return Promise.resolve([]);

    var lon = at[0].toFixed(5);
    var lat = at[1].toFixed(5);
    var lang = App.i18n ? App.i18n.current() : "";
    var key = lat + "," + lon + "|" + lang;

    var pending = _reverse[key];
    if (!pending) {
      pending = fetch(
        "/reverse_geocode?lat=" +
          encodeURIComponent(lat) +
          "&lon=" +
          encodeURIComponent(lon) +
          (lang ? "&lang=" + encodeURIComponent(lang) : ""),
      ).then(function (r) {
        return r.json().then(
          function (data) {
            if (!r.ok || data.error)
              throw new Error(data.error || "Server returned " + r.status);
            return data;
          },
          function () {
            throw new Error("Server returned " + r.status);
          },
        );
      });

      // A failed lookup is not remembered: the next card may be printed after
      // the network comes back. Mirrors boundary.js.
      pending.catch(function () {
        delete _reverse[key];
      });
      _reverse[key] = pending;
    }

    return pending.then(
      function (data) {
        return (data.candidates || [])
          .map(function (item) {
            var value = _text(item && item.value);
            return value
              ? { value: value, kind: item.kind || "place", scope: "nominatim" }
              : null;
          })
          .filter(Boolean);
      },
      function () {
        return [];
      },
    );
  }

  return {
    init: init,

    buildingsIn: buildingsIn,
    localityCandidates: localityCandidates,
    localityFor: localityFor,
    territoryCandidates: territoryCandidates,
    reverse: reverse,
  };
})();

window.App = App;
