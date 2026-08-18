/**
 * autoheal.js — repairing the faults the territory list can already name.
 *
 * The list dialog has spent its whole life describing problems it could not
 * fix. A row carries a puzzle-piece flag when its territory is drawn in
 * separate pieces, and the notes line counts them; what to do about it was
 * left as an exercise — zoom to the territory, find the piece that does not
 * belong, cut it off by hand, then merge it into whichever neighbor it
 * touches. That is four gestures per fault, and the faults arrive in batches:
 * one boundary dragged across a corner leaves half a dozen.
 *
 * Two faults are mechanical enough to repair without asking, and this module
 * is those two:
 *
 *   • **Split** — a territory whose geometry is more than one polygon. The
 *     pieces are not adjacent, so nobody can walk it as one assignment, and
 *     the number chip has to be drawn twice to say so. Each piece becomes a
 *     territory of its own. Nothing is invented and no ground moves: the same
 *     footprint, counted the way the map already draws it.
 *
 *   • **Empty** — a territory with no buildings in it. This is the fault the
 *     list had no flag for, and it is the one that actually wastes somebody's
 *     afternoon: a card printed for a strip of embankment between two streets,
 *     handed out, walked, and empty. It is absorbed into the neighbor it
 *     shares the most boundary with, which is the same repair a person would
 *     make and the same one clustering.js already makes to its own leftovers.
 *
 * Deliberately *not* healed:
 *
 *   • The `tiny` flag. It means "smaller than the number chip drawn on it at
 *     this zoom", which is a statement about the viewport rather than about
 *     the territory — zoom in and the fault is gone. Repairing on it would
 *     mean the same button does different things depending on how far the map
 *     happens to be zoomed out.
 *   • An empty territory whose neighbors are all empty too. In a download with
 *     no buildings anywhere — forest, allotments, a boundary drawn before the
 *     data arrived — "merge every empty one into a neighbor" collapses the
 *     whole partition into a single territory. So a host has to have buildings
 *     to be a host, and an empty territory with nothing populated beside it is
 *     left alone, flag and all. Chains resolve anyway: the loop runs until a
 *     pass changes nothing, and a merge that gives a neighbor its first
 *     buildings makes it a host for the next pass.
 *
 * Order matters, and it is split first. A split territory's pieces are judged
 * for buildings individually, so the sliver that was welded onto the far side
 * of a neighborhood becomes its own piece, is found to be empty, and is handed
 * to whoever it actually touches — one pass, no second look. The reverse order
 * would merge the whole two-piece thing into a neighbor and produce a
 * territory in three pieces.
 *
 * The repair is computed against plain features and applied in one
 * setClusters() call, behind one history entry, so the whole thing is a single
 * Ctrl+Z. Nothing on the map moves until the plan is complete, which is what
 * makes a partial failure — one shape turf refuses to union — cost that one
 * merge rather than the map.
 *
 * That separation is also what keeps the offer honest. The list shows a repair
 * button on a row, and the only way to be sure the button does something is to
 * do it: _plan() computes the whole repair and hands it back, heal() writes it
 * to the map, and _canFix() runs the same plan and throws it away. A cheaper
 * test that resembles the repair is how this module first shipped, and the two
 * disagreed exactly where it mattered — on a territory whose neighbor touched
 * it but could not take it, which is a question about arithmetic rather than
 * about geography. A button that runs and changes nothing is worse than no
 * button, because it teaches people to distrust the one that works.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.autoheal = (function () {
  "use strict";

  var s = null;
  var G = null;

  // How far apart two territories can be and still count as touching. The
  // same 0.5 m clustering.js uses, for the same reason: adjacent territories
  // share a boundary but rarely share exact vertices, so an exact test finds
  // no neighbors at all. Whatever probes for adjacency and whatever performs
  // the merge have to agree on this number — a union tighter than the test
  // that found the pair leaves a hairline seam, and the seam is a MultiPolygon,
  // which is the very fault being repaired.
  var TOUCH_SLACK_M = 0.5;

  // Building centroids, and the collection they were taken from. See
  // _buildingPoints.
  var _points = null;
  var _pointsFor = null;

  function init() {
    s = App.state;
    G = App.geometry;
    App._loaded.push("autoheal");
  }

  // ══════════════════════════════════════════════════════════════════════
  // THE AUDIT
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Does this territory contain no buildings?
   *
   * Three-valued on purpose. `null` is "cannot say" — nothing has been
   * downloaded, or this territory has not been counted yet — and it is the
   * answer that matters most, because the alternative is treating an
   * unanswered question as a fault and merging away a perfectly good
   * territory on the strength of data that never arrived.
   *
   * The count is the one the row already shows, read off the cluster entry
   * where polygons.refreshFilteredData put it. Counting again here would risk
   * a flag that disagrees with the number printed beside it.
   *
   * @param {{counts?: {buildings: number}}} entry a cluster entry
   * @returns {boolean|null}
   */
  function isEmpty(entry) {
    if (!entry || !s) return null;
    if (!s.cachedBuildings || !s.cachedBuildings.features) return null;
    var counts = entry.counts;
    if (!counts || typeof counts.buildings !== "number") return null;
    return counts.buildings === 0;
  }

  /**
   * What is wrong with territory `index`, and whether this module can fix it.
   *
   * @returns {{index:number, parts:number, split:boolean, empty:boolean,
   *            fixable:boolean}|null}
   */
  function issueOf(index) {
    var entry = (s && s.clusters && s.clusters[index]) || null;
    if (!entry) return null;

    var parts = 0;
    try {
      parts = G.polygonParts(entry.feature).length;
    } catch (e) {
      parts = 0;
    }

    var split = parts > 1;
    var empty = isEmpty(entry) === true;
    return {
      index: index,
      parts: parts,
      split: split,
      empty: empty,
      // Splitting a multi-part shape always changes it, so that one needs no
      // rehearsal. Everything else is answered by running the repair and
      // throwing the result away — see _canFix.
      fixable: split || (empty && _canFix(index)),
    };
  }

  /**
   * Would repairing this territory actually change anything?
   *
   * Answered by running the repair against a copy and discarding it, not by a
   * cheaper test that resembles it. This module used to predict with
   * `does a populated neighbor touch me?`, which is a different question from
   * `can that neighbor take me?`: a union turf refuses, or one that comes back
   * as two pieces, is declined by _absorb, and the row was left offering a
   * button that ran and did nothing. Two pieces of code answering one question
   * will disagree eventually, so now there is only one.
   *
   * The rehearsal is not free, so it is reached only for a territory already
   * known to be empty — a handful of rows in a list of hundreds — and each one
   * costs a bbox-filtered neighbor scan and at most a few unions.
   */
  function _canFix(index) {
    var plan = _plan(index);
    return !!(plan && plan.report.changed);
  }

  /**
   * Every issue, plus the totals the list dialog puts in its notes line.
   *
   * Costs a rehearsed repair per empty territory (see _canFix), which is why
   * the building centroids behind it are cached. Splitting needs no rehearsal
   * and territories with buildings are never rehearsed at all, so the price is
   * paid per anomaly rather than per territory.
   */
  function audit() {
    var rows = [];
    var split = 0;
    var empty = 0;
    var fixable = 0;

    ((s && s.clusters) || []).forEach(function (entry, index) {
      var issue = issueOf(index);
      if (!issue) return;
      rows.push(issue);
      if (issue.split) split++;
      if (issue.empty) empty++;
      if (issue.fixable) fixable++;
    });

    return { rows: rows, split: split, empty: empty, fixable: fixable };
  }

  // ══════════════════════════════════════════════════════════════════════
  // COUNTING BUILDINGS AS THE PLAN CHANGES
  // ══════════════════════════════════════════════════════════════════════

  /** turf.bbox, or null for geometry it refuses. */
  function _bbox(feature) {
    try {
      return turf.bbox(feature);
    } catch (e) {
      return null;
    }
  }

  /** The same shape on a one-centimeter grid. See _absorb. */
  function _quantize(feature) {
    try {
      return turf.truncate(feature, { precision: 7, mutate: false });
    } catch (e) {
      return feature;
    }
  }

  /**
   * One point per building, centroids cached on the feature.
   *
   * `_centroid` is the same field polygons.refreshFilteredData writes, so the
   * first heal after a download pays for the centroids and every later pass —
   * here or there — reads them back.
   *
   * @returns {Object[]|null} turf Points, or null when nothing is downloaded
   */
  function _buildingPoints() {
    var collection = s.cachedBuildings || null;
    var features = (collection && collection.features) || null;
    if (!features) return null;

    // Keyed on the collection object, which is replaced wholesale by a
    // download, an import or a reset and never edited in place. Opening the
    // list rehearses a repair for every empty territory, and without this
    // each rehearsal walked all the buildings again to build the same array.
    if (_pointsFor === collection) return _points;

    var points = [];
    features.forEach(function (f) {
      if (!f.geometry) return;
      var centroid = f._centroid;
      if (!centroid) {
        try {
          centroid = f._centroid = turf.centroid(G.feat(f.geometry));
        } catch (e) {
          return;
        }
      }
      points.push(centroid);
    });

    _pointsFor = collection;
    _points = points;
    return points;
  }

  /**
   * Buildings whose centroid falls inside `feature`.
   *
   * Centroid-in-polygon rather than intersection, which is what
   * refreshFilteredData does: a building on a boundary belongs to exactly one
   * territory, and both halves of the app have to pick the same one or the
   * heal disagrees with the count the row shows.
   *
   * Recounted rather than cached across a merge, because a merge is precisely
   * the event that changes the answer.
   */
  function _countBuildings(feature, points) {
    if (!points || points.length === 0) return 0;

    var box = _bbox(feature);
    if (!box) return 0;

    var count = 0;
    for (var i = 0; i < points.length; i++) {
      var c = points[i].geometry.coordinates;
      if (c[0] < box[0] || c[0] > box[2] || c[1] < box[1] || c[1] > box[3])
        continue;
      try {
        if (turf.booleanPointInPolygon(points[i], feature)) count++;
      } catch (e) {
        /* an unusable shape counts nothing rather than failing the pass */
      }
    }
    return count;
  }

  /** Buildings in a slot, computed once and dropped whenever it changes. */
  function _buildings(slot, points) {
    if (slot.buildings === null || slot.buildings === undefined)
      slot.buildings = _countBuildings(slot.feature, points);
    return slot.buildings;
  }

  // ══════════════════════════════════════════════════════════════════════
  // NEIGHBORS
  // ══════════════════════════════════════════════════════════════════════

  /** How much ground two features already have in common, in square meters. */
  function _sharedArea(a, b) {
    try {
      var shared = G.intersect(a, b);
      return shared ? G.area(shared) : 0;
    } catch (e) {
      // Unmeasurable, so assume none: the merge is then held to the stricter
      // of the two thresholds, which refuses rather than loses ground.
      return 0;
    }
  }

  /**
   * Slots touching `victim`, most shared boundary first.
   *
   * The victim is grown by the touch slack and intersected with each
   * candidate, so the ranking value is roughly the shared boundary length
   * times the slack. Ranking by centroid distance instead — the obvious
   * cheaper test — welds a sliver onto whichever territory happens to have
   * its middle nearby, across a neighbor it never touches. clustering.js
   * learned that the hard way; this is the same measurement.
   */
  function _neighbors(slots, victim) {
    var probe;
    try {
      probe = turf.buffer(victim.feature, TOUCH_SLACK_M, { units: "meters" });
    } catch (e) {
      probe = victim.feature;
    }
    if (!probe) probe = victim.feature;

    // The bounding boxes are not an optimization detail worth hiding: this
    // runs once per empty territory against every other territory, and the
    // list dialog asks for it on open. An intersection is orders of magnitude
    // dearer than four number comparisons, and two territories whose boxes
    // miss cannot possibly touch.
    var box = _bbox(probe);

    var hits = [];
    slots.forEach(function (slot) {
      if (slot === victim || slot.removed) return;
      var other = _bbox(slot.feature);
      if (box && other && !G.bboxOverlap(box, other)) return;
      try {
        var shared = G.intersect(probe, slot.feature);
        var area = shared ? turf.area(shared) : 0;
        if (area > 0) hits.push({ slot: slot, area: area });
      } catch (e) {
        /* a shape turf cannot intersect is simply not a neighbor */
      }
    });

    hits.sort(function (a, b) {
      return b.area - a.area;
    });
    return hits.map(function (hit) {
      return hit.slot;
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // THE PLAN
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Everything but `printed`.
   *
   * A card is a picture of an outline, so once the outline moves the printed
   * mark is a claim about a piece of paper that no longer matches the ground.
   * polygons.js drops it for the same reason when a boundary edit resizes a
   * territory; this is that rule applied to the other two ways a shape can
   * change. Only the territories the heal actually touched lose it.
   */
  function _carry(properties) {
    var out = {};
    Object.keys(properties || {}).forEach(function (key) {
      if (key !== "printed") out[key] = properties[key];
    });
    return out;
  }

  function _derive(source, geometry) {
    return {
      type: "Feature",
      geometry: geometry,
      properties: _carry(source && source.properties),
    };
  }

  /** Territory indices this run is allowed to touch. */
  function _scope(indices, length) {
    var scope = {};
    if (indices === undefined || indices === null) {
      for (var i = 0; i < length; i++) scope[i] = true;
      return scope;
    }
    (typeof indices === "number" ? [indices] : indices).forEach(function (i) {
      if (i >= 0 && i < length) scope[i] = true;
    });
    return scope;
  }

  /**
   * Break every in-scope territory into its polygon parts.
   *
   * Unconditional: there is no minimum size here, because the merge pass that
   * follows is the size filter. A sliver has no buildings by construction, so
   * it is empty, so it is offered to the neighbor it touches — which is a
   * better answer than any threshold, since it puts the ground somewhere
   * instead of quietly dropping it.
   */
  function _split(slots, report) {
    var out = [];
    slots.forEach(function (slot) {
      if (!slot.healing) {
        out.push(slot);
        return;
      }

      var parts;
      try {
        parts = G.polygonParts(slot.feature);
      } catch (e) {
        parts = [];
      }
      if (parts.length < 2) {
        out.push(slot);
        return;
      }

      report.split++;
      report.pieces += parts.length;
      parts.forEach(function (part) {
        out.push({
          feature: _derive(slot.feature, part.geometry),
          healing: true,
          changed: true,
          buildings: null,
        });
      });
    });
    return out;
  }

  /**
   * Host and victim as one shape, or null when nothing trustworthy came back.
   *
   * Two candidates are tried, and the acceptance test is the same for both.
   *
   * unionHealed comes first because it is the one that closes the seam:
   * neighbors share a boundary to within a few centimeters rather than
   * exactly, and a plain union of two shapes that only nearly touch returns a
   * MultiPolygon — the host would come out split, which is the other fault
   * this module exists to remove. It grows both inputs by the same slack the
   * neighbor test used, unions, and shrinks back.
   *
   * The plain union is the fallback, and it is not a formality. turf's
   * polygon clipping gives up on near-degenerate vertex arrangements — two
   * rectangles meeting along an edge produce one as soon as they are buffered,
   * because the corner arcs graze the shared edge — and it announces this by
   * throwing. geometry.unionAll answers a throw with a *partial* union,
   * dropping whichever shape it could not fold in. For the callers it was
   * written for that is the right trade: most of an outline beats none of it.
   * Here it would mean an empty territory quietly ceasing to exist, its
   * ground belonging to nobody, discovered as a hole in the coverage weeks
   * later. So:
   *
   *   • the host must come out bigger by the ground it is actually gaining,
   *     which is the victim minus whatever the two already share. Measuring
   *     against the victim's whole area instead assumes neighbors never
   *     overlap, and they do: a merge that keeps unionHealed's grown result
   *     leaves a half-meter of overlap along the seam, and a territory drawn
   *     by hand over another one overlaps outright. A 30 m² sliver sitting
   *     87% inside its neighbor gains that neighbor 4 m², and demanding 27
   *     rejected a union that had lost nothing at all.
   *   • and it must be a single polygon, or the repair has produced the exact
   *     fault it exists to remove, and the next run would split it back into
   *     the two shapes we started with.
   *
   * Failing every candidate is not a failure of the heal. It is one merge not
   * made, on a territory that keeps its flag and says so.
   */
  function _absorb(host, victim) {
    // What this merge should add: the victim, less the part of it the host is
    // already covering. Zero is a legitimate answer — a sliver wholly inside
    // its neighbor is absorbed by ceasing to be a territory of its own, and
    // no ground moves at all.
    var gain = Math.max(0, G.area(victim) - _sharedArea(host, victim));
    // A square meter of slack, because the healed union rounds the outline by
    // a few centimeters in each direction and the app treats nothing below
    // CUT_MIN_PIECE_M2 as a piece of anything.
    var floor = G.area(host) + gain * 0.9 - 1;

    var candidates = [];
    try {
      candidates.push(G.unionHealed([host, victim], TOUCH_SLACK_M));
    } catch (e) {
      /* the fallbacks below are what this catch is for */
    }
    try {
      candidates.push(G.union(host, victim));
    } catch (e) {
      /* every strategy may fail; the caller treats that as "not merged" */
    }
    try {
      // Last: the same union on a one-centimeter grid. Clipping gives up on
      // vertices that are *nearly* the same point, which is what a shared
      // boundary carried through a buffer and back is made of; quantizing
      // makes them exactly the same point and the arithmetic becomes easy.
      // A centimeter is far below anything this app measures — the touch
      // slack is fifty times it — so nothing that matters moves.
      candidates.push(G.union(_quantize(host), _quantize(victim)));
    } catch (e) {
      /* out of ideas; the victim keeps its ground and its flag */
    }

    for (var i = 0; i < candidates.length; i++) {
      var candidate = candidates[i];
      if (!candidate || !candidate.geometry) continue;
      if (G.area(candidate) < floor) continue;
      if (G.polygonParts(candidate).length !== 1) continue;
      return candidate;
    }
    return null;
  }

  /**
   * Give every empty territory to the populated neighbor it abuts most.
   *
   * Smallest first, so a scrap is absorbed by a real territory rather than
   * two scraps finding each other. The outer loop repeats while a pass
   * changed something: absorbing one empty territory can hand its neighbor
   * the buildings that make *it* a legal host, and a chain of empties along a
   * railway line unwinds one link per pass.
   */
  function _merge(slots, points, report) {
    var progress = true;

    while (progress) {
      progress = false;

      var live = slots.filter(function (slot) {
        return !slot.removed;
      });
      var victims = live
        .filter(function (slot) {
          return slot.healing && _buildings(slot, points) === 0;
        })
        .map(function (slot) {
          return { slot: slot, area: G.area(slot.feature) };
        })
        .sort(function (a, b) {
          return a.area - b.area;
        });

      for (var i = 0; i < victims.length; i++) {
        var victim = victims[i].slot;
        if (victim.removed) continue;

        // Only a territory with buildings may absorb one without. Without
        // this the empties merge into each other and, in a download with no
        // buildings at all, every territory becomes one territory.
        var hosts = _neighbors(
          live.filter(function (slot) {
            return !slot.removed && _buildings(slot, points) > 0;
          }),
          victim,
        );
        if (hosts.length === 0) continue;

        // Down the ranking until one of them can actually take it. The best
        // neighbor by shared boundary is the one that *should* have it, but
        // whether a union of those two particular outlines comes back usable
        // is a question about arithmetic, not about geography — and the
        // second-best neighbor is still a neighbor. Trying only the first
        // turned a solvable case into a button that did nothing.
        for (var h = 0; h < hosts.length; h++) {
          var host = hosts[h];
          var union = _absorb(host.feature, victim.feature);
          // Nothing trustworthy came back from this pairing; see _absorb.
          if (!union) continue;

          host.feature = _derive(host.feature, union.geometry);
          host.changed = true;
          host.buildings = null;
          victim.removed = true;
          report.merged++;
          progress = true;
          break;
        }
      }
    }

    // Whatever is still empty had nowhere to go. It keeps its flag, which is
    // the honest outcome: the list goes on saying so rather than the button
    // claiming a repair it did not make.
    slots.forEach(function (slot) {
      if (slot.removed || !slot.healing) return;
      if (_buildings(slot, points) === 0) report.unresolved++;
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // RUNNING IT
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Work out the repair without performing it.
   *
   * Pure: it reads s.clusters and returns new features, and nothing on the
   * map moves. That is what lets the same function answer "would this change
   * anything?" for the wand on a row and "what shall we write back?" for the
   * click on it — one implementation, so the button and the repair cannot
   * drift apart.
   *
   * @param {number|number[]} [indices] territories to repair; all when omitted
   * @returns {{report: Object, kept: Object[]}|null} null with no territories
   */
  function _plan(indices) {
    var entries = (s && s.clusters) || [];
    if (entries.length === 0) return null;

    var scope = _scope(indices, entries.length);
    var points = _buildingPoints();
    var report = {
      split: 0,
      pieces: 0,
      merged: 0,
      unresolved: 0,
      before: entries.length,
      after: entries.length,
      changed: false,
    };

    var slots = entries.map(function (entry, index) {
      return {
        feature: entry.feature,
        healing: !!scope[index],
        changed: false,
        removed: false,
        // Seeded from the count the row is showing rather than recounted, so
        // that the flag and the repair are working from one number. They can
        // differ: refreshFilteredData gives a building on a shared boundary to
        // the first territory that claims it, and counting each territory
        // independently gives it to both. A territory flagged empty must be
        // treated as empty by the run that was offered for it, whichever of
        // the two is the better description of the ground.
        buildings:
          entry.counts && typeof entry.counts.buildings === "number"
            ? entry.counts.buildings
            : null,
      };
    });

    slots = _split(slots, report);
    // No buildings downloaded means "empty" is unanswerable, so the merge
    // pass has nothing to decide with and is skipped outright.
    if (points) _merge(slots, points, report);

    var kept = slots.filter(function (slot) {
      return !slot.removed;
    });
    report.after = kept.length;
    report.changed =
      report.split > 0 ||
      report.merged > 0 ||
      kept.some(function (slot) {
        return slot.changed;
      });

    return { report: report, kept: kept };
  }

  /**
   * Repair territories.
   *
   * @param {number|number[]} [indices] which territories to repair; every one
   *   when omitted. Out-of-range entries are ignored.
   * @returns {{split:number, pieces:number, merged:number, unresolved:number,
   *            before:number, after:number, changed:boolean}|null} null when
   *   there are no territories at all
   */
  function heal(indices) {
    var plan = _plan(indices);
    if (!plan) return null;

    var report = plan.report;
    if (!report.changed) {
      console.log(">>> Autoheal: nothing to repair");
      return report;
    }

    if (App.history) App.history.push();
    // setClusters rebuilds a Feature around every geometry it is handed, so
    // the untouched ones are passed through as they stand rather than copied
    // here — the copy it makes is the one that ends up on the map either way.
    App.polygons.setClusters(
      plan.kept.map(function (slot) {
        return slot.feature;
      }),
    );

    console.log(
      ">>> Autoheal:",
      report.split,
      "split into",
      report.pieces + ",",
      report.merged,
      "merged away,",
      report.before,
      "->",
      report.after,
      "territories",
      report.unresolved > 0
        ? "(" + report.unresolved + " still empty, nothing to merge into)"
        : "",
    );
    return report;
  }

  return {
    init: init,
    isEmpty: isEmpty,
    issueOf: issueOf,
    audit: audit,
    heal: heal,
  };
})();

window.App = App;
