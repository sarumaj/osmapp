/**
 * The software basemap filters, and the capability probe that decides whether
 * they are needed.
 *
 * The point of the software path is that it is not an approximation. It is a
 * reimplementation of the three <filter> elements in index.html, and the card
 * has to come out the same whichever path produced it — which matters more
 * here than anywhere, because the whole promise of the print preview is that
 * it is what comes out of the printer. So the assertions below are against the
 * SVG definitions' own numbers (BT.709 luminance, the feComponentTransfer
 * table, a kernel that sums to 1), not against whatever the implementation
 * currently returns.
 *
 * The probe is the other half. `"filter" in ctx` is not the question: Safari
 * has had the property since 17 while still refusing url(#id) references, so
 * asking the property reports "supported" and then prints an unfiltered map,
 * which is the worst of the three outcomes because nothing on screen says so.
 * And Brave farbles canvas readback to defeat fingerprinting, which an exact
 * equality test reads as "filters are broken" on a Chromium that runs them
 * perfectly. Both browsers are modelled below.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadApp } from "./helpers/load.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INDEX = readFileSync(
  join(ROOT, "src", "osmapp", "templates", "index.html"),
  "utf8",
);

// ── Canvas stubs ─────────────────────────────────────────────────────────────

/**
 * A 2d context that models one browser's filter behaviour.
 *
 * @param {{filter?: "none"|"css"|"all", readable?: boolean, farble?: number}} traits
 *   filter: which filter strings are accepted at all. "css" accepts the
 *     shorthand functions and rejects url(#id), which is Safari.
 *   readable: whether getImageData works.
 *   farble: per-channel perturbation applied on readback, which is Brave.
 */
function fakeContext(traits) {
  const accepts = traits.filter ?? "all";
  const pixels = { r: 0, g: 0, b: 0, a: 0 };
  let active = "none";

  return {
    save() {},
    restore() {
      active = "none";
    },
    setTransform() {},
    clearRect() {
      pixels.r = pixels.g = pixels.b = pixels.a = 0;
    },
    fillStyle: "#000000",
    fillRect() {
      // The probe only ever fills pure red.
      if (active === "none") {
        Object.assign(pixels, { r: 255, g: 0, b: 0, a: 255 });
      } else {
        // Any accepted filter here is a luminance one: BT.709 of pure red.
        const y = Math.round(0.2126 * 255);
        Object.assign(pixels, { r: y, g: y, b: y, a: 255 });
      }
    },
    get filter() {
      return active;
    },
    set filter(value) {
      if (value === "none") {
        active = "none";
        return;
      }
      if (accepts === "none") return; // silently stays "none"
      if (accepts === "css" && value.startsWith("url(")) return;
      active = value;
    },
    getImageData(x, y, w, h) {
      if (traits.readable === false) throw new Error("SecurityError");
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) {
        const noise = traits.farble ? ((i % 5) - 2) * traits.farble : 0;
        data[i * 4] = pixels.r + noise;
        data[i * 4 + 1] = pixels.g + noise;
        data[i * 4 + 2] = pixels.b + noise;
        data[i * 4 + 3] = pixels.a;
      }
      return { data, width: w, height: h };
    },
  };
}

/** Records the attributes each getContext call asked for. */
function fakeCanvas(traits, asked = []) {
  let context = null;
  return {
    width: 0,
    height: 0,
    asked,
    getContext(type, attributes) {
      asked.push(attributes);
      if (traits === null) return null;
      // A real canvas hands back the context it already has and ignores the
      // attributes on every call after the first. Modelled, because that is
      // the whole reason mosaicContext exists.
      if (!context) context = fakeContext(traits);
      return context;
    },
  };
}

function loadFilters(traits) {
  const document = { createElement: () => fakeCanvas(traits) };
  return loadApp(["print-filters.js"], { document }).printFilters;
}

/** An RGBA buffer filled with one colour. */
function flat(width, height, [r, g, b, a = 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = a;
  }
  return data;
}

const F = loadFilters({ filter: "all", readable: true });

// ── The constants have to match index.html ───────────────────────────────────

test("the sharpen kernel sums to 1, so brightness is unchanged", () => {
  const sum = F.SHARPEN_KERNEL.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `kernel sums to ${sum}`);
  assert.equal(F.SHARPEN_KERNEL.length, 9, "3x3");
});

test("the luminance coefficients are BT.709 and sum to 1", () => {
  assert.equal(F.LUMA.r, 0.2126);
  assert.equal(F.LUMA.g, 0.7152);
  assert.equal(F.LUMA.b, 0.0722);
  assert.ok(Math.abs(F.LUMA.r + F.LUMA.g + F.LUMA.b - 1) < 1e-9);
});

test("the luminance coefficients match the feColorMatrix in index.html", () => {
  // The software path is only worth having if it is the same filter. A drift
  // here means the preview and the print differ by browser, silently.
  const matrix = /id="tile-grayscale"[\s\S]*?values="([^"]+)"/.exec(INDEX);
  assert.ok(matrix, "index.html should still define #tile-grayscale");
  const values = matrix[1].trim().split(/\s+/).map(Number);
  assert.equal(values[0], F.LUMA.r);
  assert.equal(values[1], F.LUMA.g);
  assert.equal(values[2], F.LUMA.b);
});

test("the contrast table matches the feFuncR in index.html", () => {
  const func = /id="tile-contrast"[\s\S]*?tableValues="([^"]+)"/.exec(INDEX);
  assert.ok(func, "index.html should still define #tile-contrast");
  assert.deepEqual(
    func[1].trim().split(/\s+/).map(Number),
    F.CONTRAST_TABLE,
  );
});

test("the contrast table is a curve through black and white", () => {
  assert.equal(F.CONTRAST_TABLE[0], 0);
  assert.equal(F.CONTRAST_TABLE[F.CONTRAST_TABLE.length - 1], 1);
});

// ── grayscale ────────────────────────────────────────────────────────────────

test("grayscale turns pure red into BT.709 neutral", () => {
  const data = flat(2, 2, [255, 0, 0]);
  F.applyPixelFilters(data, 2, 2, { grayscale: true });
  const expected = Math.round(0.2126 * 255);
  assert.ok(Math.abs(data[0] - expected) <= 1, `got ${data[0]}, expected ~${expected}`);
  assert.equal(data[0], data[1]);
  assert.equal(data[1], data[2]);
});

test("grayscale leaves alpha alone", () => {
  const data = flat(2, 2, [200, 40, 10, 128]);
  F.applyPixelFilters(data, 2, 2, { grayscale: true });
  assert.equal(data[3], 128);
});

test("grayscale is idempotent on an already neutral image", () => {
  const data = flat(2, 2, [90, 90, 90]);
  F.applyPixelFilters(data, 2, 2, { grayscale: true });
  assert.ok(Math.abs(data[0] - 90) <= 1);
});

// ── sharpen ──────────────────────────────────────────────────────────────────

test("sharpen leaves a flat field flat", () => {
  // The kernel sums to 1, so a region with no gradient must come back
  // unchanged — including at the edges, where feConvolveMatrix duplicates the
  // outermost pixel rather than treating the outside as black. An edge mode
  // bug shows up here as a dark border on every printed card.
  const data = flat(5, 5, [120, 120, 120]);
  F.applyPixelFilters(data, 5, 5, { sharpen: true });
  for (let i = 0; i < data.length; i += 4) {
    assert.ok(
      Math.abs(data[i] - 120) <= 1,
      `pixel ${i / 4} drifted to ${data[i]} — check the edge handling`,
    );
  }
});

test("sharpen increases the step across an edge", () => {
  const w = 5;
  const h = 3;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = x < 2 ? 100 : 160;
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = v;
      data[i + 3] = 255;
    }
  }
  const before = data[(1 * w + 2) * 4];
  F.applyPixelFilters(data, w, h, { sharpen: true });
  assert.ok(
    data[(1 * w + 2) * 4] > before,
    "the light side of an edge should get lighter",
  );
  assert.ok(data[(1 * w + 1) * 4] < 100, "the dark side should get darker");
});

test("sharpen leaves alpha alone", () => {
  const data = flat(3, 3, [120, 120, 120, 64]);
  F.applyPixelFilters(data, 3, 3, { sharpen: true });
  assert.equal(data[3], 64);
});

// ── contrast ─────────────────────────────────────────────────────────────────

test("contrast passes through every table knot exactly", () => {
  // The table is not a plain S-curve: its middle segment is *flatter* than 1
  // (0.4–0.6 maps to 0.45–0.55), which compresses the midtones, while the
  // quarter tones are stretched. Asserting knots rather than a hand-waved
  // "darks get darker" pins the actual shape, including that black and white
  // stay put — a card whose paper went grey is the failure people notice.
  const table = F.CONTRAST_TABLE;
  const last = table.length - 1;

  table.forEach((expected, k) => {
    const input = Math.round((255 * k) / last);
    const px = flat(1, 1, [input, input, input]);
    F.applyPixelFilters(px, 1, 1, { contrast: true });
    assert.ok(
      Math.abs(px[0] - Math.round(255 * expected)) <= 1,
      `knot ${k}: ${input} became ${px[0]}, expected ~${Math.round(255 * expected)}`,
    );
  });
});

test("contrast never inverts", () => {
  // A transfer curve that dips would turn a darker patch of map lighter than
  // the one beside it, which no amount of eyeballing a preview catches.
  let previous = -1;
  for (let v = 0; v < 256; v++) {
    const px = flat(1, 1, [v, v, v]);
    F.applyPixelFilters(px, 1, 1, { contrast: true });
    assert.ok(px[0] >= previous, `output fell at input ${v}`);
    previous = px[0];
  }
});

test("contrast interpolates rather than posterizing", () => {
  // Six table entries applied as steps would give six output levels, which on
  // a map reads as banding across every gradient.
  const seen = new Set();
  for (let v = 0; v < 256; v += 8) {
    const px = flat(1, 1, [v, v, v]);
    F.applyPixelFilters(px, 1, 1, { contrast: true });
    seen.add(px[0]);
  }
  assert.ok(seen.size > 20, `only ${seen.size} distinct outputs — that is a staircase`);
});

// ── ordering and no-ops ──────────────────────────────────────────────────────

test("no enabled filter leaves the data untouched", () => {
  const data = flat(3, 3, [10, 200, 30]);
  const before = Array.from(data);
  F.applyPixelFilters(data, 3, 3, {});
  assert.deepEqual(Array.from(data), before);
});

test("the filters run in the SVG chain's order", () => {
  // sharpen, then contrast, then grayscale. Running grayscale first would give
  // a different answer for a coloured edge, and the printed card would not
  // match the preview on the browsers that take the SVG path.
  const w = 3;
  const chained = flat(w, w, [200, 60, 20]);
  F.applyPixelFilters(chained, w, w, { sharpen: true, contrast: true, grayscale: true });

  const manual = flat(w, w, [200, 60, 20]);
  F.applyPixelFilters(manual, w, w, { sharpen: true });
  F.applyPixelFilters(manual, w, w, { contrast: true });
  F.applyPixelFilters(manual, w, w, { grayscale: true });

  assert.deepEqual(Array.from(chained), Array.from(manual));
});

// ── the capability probe ─────────────────────────────────────────────────────

test("a browser that runs everything reports everything", () => {
  assert.deepEqual(loadFilters({ filter: "all", readable: true }).support(), {
    svg: true,
    css: true,
    pixels: true,
  });
});

test("Safari's CSS-only filters are reported as css without svg", () => {
  // The property exists and the shorthand works; url(#id) is refused. Trusting
  // `"filter" in ctx` here would print an unfiltered map and say nothing.
  assert.deepEqual(loadFilters({ filter: "css", readable: true }).support(), {
    svg: false,
    css: true,
    pixels: true,
  });
});

test("Brave's farbled readback still counts as working filters", () => {
  // Brave perturbs channel values by a few levels to defeat fingerprinting. It
  // is Chromium and its filters are fine, so an exact r === g === b test would
  // switch off three features that were never broken.
  const support = loadFilters({ filter: "all", readable: true, farble: 3 }).support();
  assert.equal(support.svg, true);
  assert.equal(support.css, true);
  assert.equal(support.pixels, true);
});

test("a canvas that cannot be read reports nothing, filters included", () => {
  // Without readback there is no way to verify a filter was applied, and no
  // software path to fall back to.
  assert.deepEqual(loadFilters({ filter: "all", readable: false }).support(), {
    svg: false,
    css: false,
    pixels: false,
  });
});

test("no canvas at all is not an exception", () => {
  assert.deepEqual(loadFilters(null).support(), {
    svg: false,
    css: false,
    pixels: false,
  });
});

test("the probe result is cached", () => {
  const filters = loadFilters({ filter: "all", readable: true });
  assert.equal(filters.support(), filters.support());
});


// ── The readback hint ────────────────────────────────────────────────────────
//
// getImageData on a context that never asked for willReadFrequently is slow
// and Chrome says so in the console. The attribute is honored on the *first*
// getContext call for a canvas and ignored by every later one, which is why
// asking at the readback site would have been a no-op: print.js creates the
// mosaic's context long before print-filters.js reads it.

test("the capability probe asks to be read back", () => {
  const asked = [];
  const document = { createElement: () => fakeCanvas({ filter: "all", readable: true }, asked) };
  loadApp(["print-filters.js"], { document }).printFilters.support();
  assert.deepEqual(asked[0], { willReadFrequently: true });
});

test("the mosaic asks for it when the software path is the one that runs", () => {
  // No ctx.filter: every frame is filtered by reading the pixels back.
  const filters = loadFilters({ filter: "none", readable: true });
  const canvas = fakeCanvas({ filter: "none", readable: true });
  filters.mosaicContext(canvas);
  assert.deepEqual(canvas.asked, [{ willReadFrequently: true }]);
});

test("the mosaic does not ask for it when the browser filters natively", () => {
  // willReadFrequently moves the canvas off the GPU. On the fast path nothing
  // is ever read back, so that would be a slower map for no benefit at all.
  const filters = loadFilters({ filter: "all", readable: true });
  const canvas = fakeCanvas({ filter: "all", readable: true });
  filters.mosaicContext(canvas);
  assert.deepEqual(canvas.asked, [undefined]);
});

test("a browser that can neither filter nor read back is not asked either", () => {
  const filters = loadFilters({ filter: "none", readable: false });
  const canvas = fakeCanvas({ filter: "none", readable: false });
  filters.mosaicContext(canvas);
  assert.deepEqual(canvas.asked, [undefined]);
});
