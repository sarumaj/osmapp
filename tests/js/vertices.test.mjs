/**
 * The eraser, which is the one gesture in the app that destroys on hover.
 *
 * Everything else that removes something needs a click, and a click is an
 * aim. This needs a key held down and a movement, which means the questions
 * worth asking are all about what it does *not* take:
 *
 *   - Not the corners outside its ring. A sweep past a shape must not quietly
 *     take the far side of it, and a radius measured in the wrong units — on
 *     the ground rather than on screen — is exactly how that happens without
 *     looking like a bug at the zoom it was tested at.
 *   - Not the last three. Leaflet.Editable's own floor is what stops a
 *     polygon becoming a line, and asking it per corner rather than once for
 *     the whole sweep is what makes a run that starts legal stop at the
 *     floor instead of straight through it.
 *   - Not the middle markers, which carry a delete() that removes the handle
 *     and leaves the ring alone — erasing one would look like it worked and
 *     change nothing.
 *
 * And one thing it must do: report the stroke once, so a swipe is one undo
 * step rather than one per corner.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { loadApp } from "./helpers/load.mjs";

/** Container points, with the distanceTo L.Point provides. */
function point(x, y) {
  return {
    x,
    y,
    distanceTo(other) {
      return Math.hypot(this.x - other.x, this.y - other.y);
    },
  };
}

class VertexMarker {
  constructor(latlng) {
    this.latlng = latlng;
  }
}

class MiddleMarker {
  constructor(latlng) {
    this.latlng = latlng;
  }
}

/**
 * A ring of corners at known screen positions.
 *
 * The map projection is the identity here: latlng {lat, lng} comes back as a
 * container point {x: lng, y: lat}. What is being tested is which corners the
 * ring reaches, and a real projection would only make the fixture harder to
 * read without making the question different.
 */
function setup({ at = [], minVertex = 3 } = {}) {
  const removed = [];
  const markers = at.map((pair) => new VertexMarker({ lat: pair[1], lng: pair[0] }));
  const middles = [new MiddleMarker({ lat: 0, lng: 0 })];

  const editor = {
    editLayer: {
      eachLayer(fn) {
        markers.concat(middles).forEach(fn);
      },
    },
    vertexCanBeDeleted: () => markers.length > minVertex,
  };

  markers.forEach((marker) => {
    marker.delete = () => {
      const index = markers.indexOf(marker);
      if (index >= 0) markers.splice(index, 1);
      removed.push(marker);
    };
  });
  middles.forEach((marker) => {
    marker.delete = () => removed.push(marker);
  });

  const layer = { editor };
  const listeners = {};
  const container = {};

  const L = {
    Point: class {
      constructor(x, y) {
        this.x = x;
        this.y = y;
      }
    },
    Editable: {
      VertexIcon: { prototype: { options: { iconSize: { x: 8, y: 8 } } } },
      VertexMarker,
    },
    DomUtil: { addClass() {}, removeClass() {} },
    DomEvent: {
      on(_node, type, fn) {
        listeners[type] = fn;
      },
      off(_node, type) {
        delete listeners[type];
      },
    },
  };

  const App = loadApp(["vertices.js"], { window: {}, L });

  App.state = { VERTEX_SIZE_PX: 12, VERTEX_ERASER_PX: 20 };
  App.dom = { mountOnMap: () => ({ style: {} }), remove: () => null };
  App.state.leafletMap = {
    getContainer: () => container,
    dragging: { enable() {}, disable() {} },
    latLngToContainerPoint: (latlng) => point(latlng.lng, latlng.lat),
    mouseEventToContainerPoint: (event) => point(event.x, event.y),
  };

  App.vertices.init();
  return {
    vertices: App.vertices,
    L,
    layer,
    markers,
    removed,
    /** Move the pointer, as the map container would report it. */
    move(x, y) {
      listeners.mousemove({ x, y });
    },
  };
}

// ── The handles ──────────────────────────────────────────────────────────────

test("the corner handle is grown past the library's eight pixels", () => {
  const h = setup();
  assert.equal(h.vertices.install(), true);
  assert.equal(h.L.Editable.VertexIcon.prototype.options.iconSize.x, 12);
});

test("installing twice is not installing twice", () => {
  // It is called from start-up and it mutates a shared prototype; a second
  // call that re-applied the size would be harmless today and a compounding
  // bug the moment the size is ever derived from the current one.
  const h = setup();
  assert.equal(h.vertices.install(), true);
  assert.equal(h.vertices.install(), false);
});

// ── The sweep ────────────────────────────────────────────────────────────────

test("a sweep takes the corners it passes over and leaves the rest", () => {
  const h = setup({ at: [[0, 0], [10, 0], [200, 0], [300, 0], [400, 0]] });
  h.vertices.eraseStart({ layer: () => h.layer });
  h.move(5, 0);

  assert.deepEqual(
    h.markers.map((m) => m.latlng.lng),
    [200, 300, 400],
    "the two within the ring go, the three beyond it stay",
  );
});

test("the ring stops at the library's floor rather than at nothing", () => {
  // Four corners, all of them under the pointer, and a polygon needs three.
  // Asking once for the sweep would take all four; asking per corner takes
  // exactly the one that can go.
  const h = setup({ at: [[0, 0], [1, 0], [2, 0], [3, 0]], minVertex: 3 });
  h.vertices.eraseStart({ layer: () => h.layer });
  h.move(0, 0);

  assert.equal(h.markers.length, 3, "a triangle survives the sweep");
});

test("the half-handles between corners are not corners", () => {
  const h = setup({ at: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]] });
  h.vertices.eraseStart({ layer: () => h.layer });
  h.move(0, 0);

  assert.ok(
    h.removed.every((marker) => marker instanceof VertexMarker),
    "a middle marker's delete() drops the handle and leaves the ring alone",
  );
});

test("a stroke is reported once, with what it took", () => {
  const h = setup({ at: [[0, 0], [5, 0], [10, 0], [300, 0], [400, 0], [500, 0]] });
  const strokes = [];
  h.vertices.eraseStart({
    layer: () => h.layer,
    onStroke: (count) => strokes.push(count),
  });

  h.move(0, 0);
  h.move(6, 0);
  assert.deepEqual(strokes, [], "nothing is reported while the key is down");

  assert.equal(h.vertices.eraseStop(), 3);
  assert.deepEqual(strokes, [3], "one entry for the gesture, not one per corner");
});

test("a stroke that took nothing reports nothing", () => {
  // Otherwise every press of the key that missed would put an empty step on
  // the host's undo stack.
  const h = setup({ at: [[500, 500]] });
  const strokes = [];
  h.vertices.eraseStart({ layer: () => h.layer, onStroke: (n) => strokes.push(n) });
  h.move(0, 0);
  h.vertices.eraseStop();
  assert.deepEqual(strokes, []);
});

test("erasing is a state the host can see", () => {
  const h = setup({ at: [[0, 0], [1, 0], [2, 0], [3, 0]] });
  assert.equal(h.vertices.isErasing(), false);
  h.vertices.eraseStart({ layer: () => h.layer });
  assert.equal(h.vertices.isErasing(), true);
  h.vertices.eraseStop();
  assert.equal(h.vertices.isErasing(), false);
});

test("a layer with no editor is not a layer to erase from", () => {
  // The key is live for as long as its context is pushed, and the latch that
  // puts handles on screen can be off — starting a sweep against a shape with
  // no editor must fail rather than arm a gesture that cannot do anything.
  const h = setup();
  assert.equal(h.vertices.eraseStart({ layer: () => ({}) }), false);
  assert.equal(h.vertices.isErasing(), false);
});
