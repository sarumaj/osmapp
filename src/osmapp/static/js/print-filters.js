/**
 * print-filters.js - the basemap filters, and the three ways a browser can
 * refuse to run them.
 *
 * Split out of print.js, which had grown past 2 800 lines and where this was
 * the one section that touches nothing else in it: no dialog, no view, no
 * tiles, no module state beyond its own capability cache. Everything here is
 * either a pure function over pixel data or a probe against a throwaway 8x8
 * canvas, which is also what makes it the part of the print pipeline that can
 * be tested without a browser - see tests/js/print-filters.test.mjs.
 *
 * print.js calls exactly three things: support(), applyPixelFilters() and
 * drawFilteredMosaic().
 */
var App = window.App || {};

App.printFilters = (function () {
  "use strict";

  // CANVAS FILTER SUPPORT
  //
  // `"filter" in ctx` is not the question. Safari has had the property since
  // 17 while still refusing `url(#id)` references to SVG filters - it
  // implements only the CSS shorthand functions. Feature-detecting the
  // property therefore reports "supported" and then silently prints an
  // unfiltered map, which is the worst of the three possible outcomes because
  // nothing on screen says so.
  //
  // So the two are probed separately, and by rendering rather than by asking:
  // fill one pixel with pure red through a grayscale filter and look at what
  // came out. Red survives a filter that was never applied; a luminance
  // matrix turns it into a neutral ~(54,54,54). Reading the property back is
  // kept as a cheap first rejection - browsers report a filter they refused
  // as "none" - but it is not trusted on its own.
  //
  // Splitting the two matters, because it buys a middle tier instead of an
  // all-or-nothing switch. Grayscale is exact as a CSS function (the SVG
  // matrix in index.html uses the same BT.709 coefficients on purpose) and
  // contrast is close enough. Only sharpening genuinely needs SVG: a 3x3
  // convolution has no CSS equivalent.

  var _filterSupportCache = null;

  // Big enough that a per-pixel perturbation averages out; small enough to be
  // free. See the tolerance note in _filterApplies.
  var PROBE_PX = 8;

  /**
   * @returns {{svg: boolean, css: boolean, pixels: boolean}} cached after the
   *   first call. `pixels` is the one that matters most: it means the software
   *   path below is available, which covers every filter exactly.
   */
  function _filterSupport() {
    if (_filterSupportCache) return _filterSupportCache;

    var support = { svg: false, css: false, pixels: false };
    try {
      var probe = document.createElement("canvas");
      probe.width = probe.height = PROBE_PX;
      // The probe exists to be read back and nothing else, so it asks for the
      // readback hint unconditionally. Chrome warns about repeated
      // getImageData on a context that never asked for it, and this canvas
      // does it three times in a row.
      var ctx = probe.getContext("2d", { willReadFrequently: true });
      if (ctx) {
        // Readback is what the software path needs, so it is probed first and
        // on its own - a canvas can be readable without ctx.filter existing.
        support.pixels = _canReadPixels(ctx);
        if (support.pixels && "filter" in ctx) {
          support.svg = _filterApplies(ctx, "url(#tile-grayscale)");
          support.css = _filterApplies(ctx, "grayscale(1)");
        }
      }
    } catch (e) {
      /* no canvas at all: the checkboxes switch themselves off */
    }

    _filterSupportCache = support;
    console.log(
      ">>> Canvas filters — SVG:",
      support.svg,
      "CSS:",
      support.css,
      "pixels:",
      support.pixels,
    );
    return support;
  }

  function _canReadPixels(ctx) {
    try {
      ctx.getImageData(0, 0, 1, 1);
      return true;
    } catch (e) {
      return false; // tainted canvas, or readback blocked outright
    }
  }

  function _filterApplies(ctx, filter) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = "none";
    ctx.clearRect(0, 0, PROBE_PX, PROBE_PX);
    ctx.filter = filter;
    // A rejected filter is reported back as "none".
    var accepted = ctx.filter !== "none";
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(0, 0, PROBE_PX, PROBE_PX);
    ctx.restore();
    if (!accepted) return false;

    var data;
    try {
      data = ctx.getImageData(0, 0, PROBE_PX, PROBE_PX).data;
    } catch (e) {
      return false;
    }

    var r = 0;
    var g = 0;
    var b = 0;
    for (var i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
    var n = data.length / 4;
    r /= n;
    g /= n;
    b /= n;

    // Compared with tolerance, not equality, and averaged over a block rather
    // than read from one pixel. Brave farbles canvas readback to defeat
    // fingerprinting: it perturbs channel values by a few levels, keyed to the
    // session and origin. Brave is Chromium and its filters work perfectly, so
    // an exact `r === g === b` test would report "unsupported" and switch off
    // three features that were never broken.
    //
    // Unfiltered red is (255, 0, 0). Anything that has actually been through a
    // luminance filter is dark and near-neutral, which no amount of farbling
    // turns back into red.
    return r < 200 && Math.abs(r - g) < 12 && Math.abs(g - b) < 12;
  }

  // SOFTWARE FILTERS
  //
  // The fallback for every engine that will not run the SVG filters. It is a
  // faithful reimplementation of the three <filter> elements in index.html
  // rather than an approximation, so the printed card is identical whichever
  // path produced it - which matters more here than anywhere, because the
  // whole point of the preview is that it is what comes out of the printer.
  //
  // It needs nothing but getImageData, so it also covers Safari before 17,
  // where ctx.filter does not exist at all. That makes it a better answer than
  // the CSS shorthand: contrast() is a linear stretch stand-in for an S-curve,
  // and there is no CSS equivalent of a convolution at any price.
  //
  // Cost is one pass per enabled filter over 2-6 Mpx, tens of milliseconds
  // each, on a repaint that was already redrawing the whole mosaic.

  // Matches feConvolveMatrix in #tile-sharpen. The kernel sums to 1, so the
  // divisor is 1 and brightness is unchanged.
  var SHARPEN_KERNEL = [-0.1, -0.1, -0.1, -0.1, 1.8, -0.1, -0.1, -0.1, -0.1];

  // Matches the feFuncR/G/B tableValues in #tile-contrast.
  var CONTRAST_TABLE = [0, 0.15, 0.45, 0.55, 0.85, 1];

  // ITU-R BT.709, matching the feColorMatrix in #tile-grayscale.
  var LUMA_R = 0.2126;
  var LUMA_G = 0.7152;
  var LUMA_B = 0.0722;

  /**
   * Apply the enabled filters to RGBA pixel data, in place and in the same
   * order the SVG chain would.
   *
   * @param {Uint8ClampedArray} data RGBA, un-premultiplied, as getImageData
   *   hands it over - which is the color space feConvolveMatrix works in when
   *   preserveAlpha is true.
   * @param {number} width
   * @param {number} height
   * @param {{sharpen?:boolean, contrast?:boolean, grayscale?:boolean}} ops
   */
  function applyPixelFilters(data, width, height, ops) {
    if (ops.sharpen) _convolve(data, width, height, SHARPEN_KERNEL);
    if (ops.contrast) _transfer(data, CONTRAST_TABLE);
    if (ops.grayscale) _luminance(data);
    return data;
  }

  /**
   * 3x3 convolution on RGB, leaving alpha untouched - SVG's
   * preserveAlpha="true". Edges duplicate the outermost pixel, which is
   * feConvolveMatrix's default edgeMode.
   */
  function _convolve(data, width, height, kernel) {
    var source = new Uint8ClampedArray(data);
    for (var y = 0; y < height; y++) {
      for (var x = 0; x < width; x++) {
        var out = (y * width + x) * 4;
        for (var channel = 0; channel < 3; channel++) {
          var sum = 0;
          for (var ky = -1; ky <= 1; ky++) {
            var sy = y + ky;
            if (sy < 0) sy = 0;
            else if (sy >= height) sy = height - 1;
            for (var kx = -1; kx <= 1; kx++) {
              var sx = x + kx;
              if (sx < 0) sx = 0;
              else if (sx >= width) sx = width - 1;
              sum +=
                source[(sy * width + sx) * 4 + channel] *
                kernel[(ky + 1) * 3 + (kx + 1)];
            }
          }
          data[out + channel] = sum; // Uint8ClampedArray clamps and rounds
        }
      }
    }
    return data;
  }

  /**
   * feComponentTransfer type="table": the value is placed on a piecewise
   * linear curve through the table entries. Interpolation is what makes it a
   * smooth S-curve rather than six posterized steps.
   */
  function _transfer(data, table) {
    var last = table.length - 1;
    var lut = new Uint8ClampedArray(256);
    for (var v = 0; v < 256; v++) {
      var c = v / 255;
      var k = Math.floor(c * last);
      if (k >= last) k = last - 1;
      lut[v] = 255 * (table[k] + (c - k / last) * last * (table[k + 1] - table[k]));
    }
    for (var i = 0; i < data.length; i += 4) {
      data[i] = lut[data[i]];
      data[i + 1] = lut[data[i + 1]];
      data[i + 2] = lut[data[i + 2]];
    }
    return data;
  }

  function _luminance(data) {
    for (var i = 0; i < data.length; i += 4) {
      var y = LUMA_R * data[i] + LUMA_G * data[i + 1] + LUMA_B * data[i + 2];
      data[i] = data[i + 1] = data[i + 2] = y;
    }
    return data;
  }

  /**
   * The 2D context for a canvas whose pixels will be read back every frame.
   *
   * Two things make this worth a function rather than an argument at the call
   * site. The attribute is honored only on the *first* getContext call for a
   * given canvas - every later call hands back the context that already
   * exists and ignores what was asked for - so the hint has to be attached
   * where the context is first created, which is print.js building the
   * mosaic, not here where it is read. And it is worth asking for only when
   * the software path is the one that will actually run: willReadFrequently
   * moves the canvas off the GPU, which is the right trade when every frame
   * is read back and the wrong one when no frame ever is.
   *
   * @param {HTMLCanvasElement} canvas
   */
  function mosaicContext(canvas) {
    var support = _filterSupport();
    var reads = !support.svg && support.pixels;
    return reads
      ? canvas.getContext("2d", { willReadFrequently: true })
      : canvas.getContext("2d");
  }

  /** Filter the finished mosaic in place, then stamp it onto the page. */
  function _drawFilteredMosaic(ctx, mosaic, ops) {
    var mctx = mosaicContext(mosaic);
    try {
      var image = mctx.getImageData(0, 0, mosaic.width, mosaic.height);
      applyPixelFilters(image.data, mosaic.width, mosaic.height, ops);
      mctx.putImageData(image, 0, 0);
    } catch (e) {
      // Readback was probed before this ran, so reaching here means the canvas
      // changed in between. An unfiltered map beats no map.
      console.warn(">>> Software filters failed:", e.message);
    }
    ctx.drawImage(mosaic, 0, 0);
  }

  return {
    // Named without the leading underscore: these are a seam other modules
    // call across rather than one file's internals.
    support: _filterSupport,
    applyPixelFilters: applyPixelFilters,
    drawFilteredMosaic: _drawFilteredMosaic,
    mosaicContext: mosaicContext,

    // Exposed so the software path can be asserted against the SVG filters in
    // index.html it is supposed to reproduce exactly, rather than against
    // itself.
    SHARPEN_KERNEL: SHARPEN_KERNEL,
    CONTRAST_TABLE: CONTRAST_TABLE,
    LUMA: { r: LUMA_R, g: LUMA_G, b: LUMA_B },
  };
})();

window.App = App;
