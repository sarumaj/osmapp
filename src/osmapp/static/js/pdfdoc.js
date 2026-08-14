/**
 * pdfdoc.js — the PDF work that used to happen in Python, done in the browser.
 *
 * Four things the server did and this does instead: measure a card template
 * (/inspect_template), rasterize one of its pages for the placement dialog
 * (/template_preview), stamp the rendered map onto it (/compose_pdf), and read
 * a saved project back out of a printed card (/extract_project).
 *
 * Why it moved
 *   Everything else this app asks the server for — Overpass, Nominatim, tiles —
 *   needs the network no matter where the code runs. The PDF routes did not,
 *   and they were the only thing standing between "the tiles are cached, the
 *   territories are in localStorage" and a card in your hand. Offline is not
 *   the same as serverless; this is the part of serverless that buys offline.
 *
 * The server routes are still there and are still correct. Every entry point
 * below is called through `withFallback`, so a browser that cannot do the work
 * — no CompressionStream, a vendor file that never downloaded, a template that
 * trips something in pdf.js that pypdf shrugs at — lands on the old path
 * instead of on an error. Except when offline, where there is nothing to fall
 * back to and the client's own message is the honest one.
 *
 * Libraries, loaded on first use rather than at startup: pdf-lib (+fontkit)
 * writes PDFs, pdf.js reads them. Together they are about two megabytes, which
 * is worth paying for when someone prints and not worth paying for on a page
 * load that never opens the print dialog. The service worker precaches them
 * either way, so "on first use" is a parse cost, not a download.
 *
 * Coordinates
 *   Rectangles come out of here relative to the mediabox origin and go back in
 *   the same way, with the origin added at draw time. The server measured
 *   absolute and then added the origin again when drawing, which double-counts
 *   on a page whose mediabox does not start at 0,0. Identical output for every
 *   template that does, which is very nearly all of them.
 */
var App = window.App || {};

App.pdfdoc = (function () {
  "use strict";

  // Mirrors internal/pdf.py — the name the project state is embedded under,
  // and the caps a card is allowed to carry. Kept in step by hand: a card
  // written here has to be readable by the server route and the other way
  // round.
  var PROJECT_ATTACHMENT_NAME = "osmapp-project.json.gz";
  var PROJECT_MAX_BYTES = 8 * 1024 * 1024;
  var PROJECT_MAX_UNZIPPED = 32 * 1024 * 1024;

  // Mirrors internal/template.py. Extend MARKERS freely — a template with
  // none falls back to the largest text-free rectangle.
  var MARKERS = /MIEJSCE NA MAP|MAPA TERENU|MAP AREA|KARTENFELD/i;
  var LEADER = /^[.\u2026]{4,}$/;
  var MIN_SIDE_PT = 40.0;
  var MAX_PAGE_FRACTION = 0.9;

  // pypdfium2 rendered the placement preview at this scale; matching it keeps
  // the dialog's pixel-per-point maths identical on both paths.
  var PREVIEW_SCALE = 110 / 72;

  // ══════════════════════════════════════════════════════════════════════
  // LIBRARY LOADING
  // ══════════════════════════════════════════════════════════════════════

  function _vendor() {
    return window.VENDOR || {};
  }

  /**
   * True when the client path is worth attempting at all.
   *
   * Only checks that the URLs were inlined. Whether the files are actually
   * reachable is what the fallback is for — asking that here would mean a
   * network round trip before deciding whether to avoid the network.
   */
  function supported() {
    var v = _vendor();
    return !!(v.pdfLib && v.fontkit && v.pdfjs && v.font);
  }

  var _scripts = {};

  /** Inject a classic <script> once, resolving when the global appears. */
  function _script(url, global) {
    if (_scripts[url]) return _scripts[url];
    _scripts[url] = new Promise(function (resolve, reject) {
      if (window[global]) return resolve(window[global]);
      var el = document.createElement("script");
      el.src = url;
      el.async = true;
      el.onload = function () {
        if (window[global]) resolve(window[global]);
        else reject(new Error(url + " loaded without defining " + global));
      };
      el.onerror = function () {
        reject(new Error("Could not load " + url));
      };
      document.head.appendChild(el);
    }).catch(function (err) {
      // Not cached: a failure now is usually the service worker not having
      // precached this build yet, and the next attempt may well succeed.
      delete _scripts[url];
      throw err;
    });
    return _scripts[url];
  }

  var _pdfLib = null;

  /** pdf-lib with fontkit registered — everything that *writes* a PDF. */
  function _writer() {
    if (_pdfLib) return _pdfLib;
    var v = _vendor();
    _pdfLib = Promise.all([
      _script(v.pdfLib, "PDFLib"),
      _script(v.fontkit, "fontkit"),
    ])
      .then(function (parts) {
        return { lib: parts[0], fontkit: parts[1] };
      })
      .catch(function (err) {
        _pdfLib = null;
        throw err;
      });
    return _pdfLib;
  }

  var _pdfJs = null;

  /**
   * pdf.js — everything that *reads* a PDF.
   *
   * An ES module, so it arrives through import() rather than a script tag.
   * The worker is same-origin and precached; without workerSrc pdf.js falls
   * back to parsing on the main thread, which locks the UI on a page that has
   * a photograph in it.
   */
  function _reader() {
    if (_pdfJs) return _pdfJs;
    var v = _vendor();
    _pdfJs = Promise.resolve()
      .then(function () {
        return import(v.pdfjs);
      })
      .then(function (mod) {
        var lib = mod.default && mod.default.getDocument ? mod.default : mod;
        if (v.pdfjsWorker) lib.GlobalWorkerOptions.workerSrc = v.pdfjsWorker;
        return lib;
      })
      .catch(function (err) {
        _pdfJs = null;
        throw err;
      });
    return _pdfJs;
  }

  function _open(lib, bytes) {
    return lib.getDocument({
      data: bytes,
      // Templates exported by a word processor often reference the standard 14
      // rather than embedding them, and getTextContent needs the metrics to
      // recover the characters. Without this the markers and the dotted
      // leaders come back as empty strings.
      standardFontDataUrl: _vendor().pdfjsStandardFonts,
      // Nothing here needs generated code, and refusing it keeps the app
      // compatible with a strict script-src.
      isEvalSupported: false,
    }).promise;
  }

  // ══════════════════════════════════════════════════════════════════════
  // FALLBACK
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Run `client`, and on any failure run `server` instead.
   *
   * Offline is the exception: there is no server to ask, and the second
   * failure would replace a message about this PDF with a message about the
   * network. The one the client produced is the one worth showing.
   */
  function withFallback(label, client, server) {
    var attempt;
    if (!supported()) return server();
    try {
      attempt = client();
    } catch (err) {
      attempt = Promise.reject(err);
    }
    if (!attempt || typeof attempt.then !== "function") return server();

    return attempt.catch(function (err) {
      if (navigator.onLine === false) throw err;
      console.warn(
        ">>> " + label + " fell back to the server:",
        (err && err.message) || err,
      );
      return server();
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // BYTES
  // ══════════════════════════════════════════════════════════════════════

  function _bytes(source) {
    if (source instanceof Uint8Array) return Promise.resolve(source);
    if (source instanceof ArrayBuffer)
      return Promise.resolve(new Uint8Array(source));
    return source.arrayBuffer().then(function (buf) {
      return new Uint8Array(buf);
    });
  }

  function _collect(stream) {
    return new Response(stream).arrayBuffer().then(function (buf) {
      return new Uint8Array(buf);
    });
  }

  /** gzip, or the payload unchanged where the browser has no CompressionStream. */
  function _gzip(bytes) {
    if (typeof window.CompressionStream !== "function") {
      // internal/pdf.py reads an uncompressed attachment too — it tries gzip
      // and keeps the raw bytes when that fails — so this stays readable
      // everywhere, just larger.
      return Promise.resolve(bytes);
    }
    return _collect(
      new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
    );
  }

  function _gunzip(bytes) {
    // Not gzip: written by a build from before the payload was compressed.
    if (!(bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)) {
      return Promise.resolve(bytes);
    }
    if (typeof window.DecompressionStream !== "function") {
      return Promise.reject(new Error("This browser cannot read gzip."));
    }
    return _collect(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
    );
  }

  // ══════════════════════════════════════════════════════════════════════
  // INSPECT — where the map goes on this template
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Every rectangle the page draws, in page coordinates.
   *
   * The current transform has to be tracked for the same reason the Python
   * version tracked it: a template produced by a word processor usually wraps
   * its drawing in a scale, and untransformed coordinates would be wrong by
   * that factor without looking wrong. Form XObjects are followed as well,
   * which the pypdf version did not do — a template whose card is a single
   * embedded form had no candidate rectangles at all there.
   */
  function _rectangles(page, ops) {
    return page.getOperatorList().then(function (list) {
      var ctm = [1, 0, 0, 1, 0, 0];
      var stack = [];
      var out = [];

      for (var i = 0; i < list.fnArray.length; i++) {
        var fn = list.fnArray[i];
        var args = list.argsArray[i];

        if (fn === ops.save) {
          stack.push(ctm);
        } else if (fn === ops.restore) {
          ctm = stack.length ? stack.pop() : ctm;
        } else if (fn === ops.transform) {
          ctm = _mul(_matrix(args), ctm);
        } else if (fn === ops.paintFormXObjectBegin) {
          stack.push(ctm);
          ctm = _mul(_matrix(args && args[0]), ctm);
        } else if (fn === ops.paintFormXObjectEnd) {
          ctm = stack.length ? stack.pop() : ctm;
        } else if (fn === ops.constructPath) {
          _pathRects(args, ops, ctm, out);
        }
      }
      return out;
    });
  }

  function _matrix(value) {
    if (!value || value.length < 6) return [1, 0, 0, 1, 0, 0];
    return [
      +value[0],
      +value[1],
      +value[2],
      +value[3],
      +value[4],
      +value[5],
    ];
  }

  function _mul(a, b) {
    return [
      a[0] * b[0] + a[1] * b[2],
      a[0] * b[1] + a[1] * b[3],
      a[2] * b[0] + a[3] * b[2],
      a[2] * b[1] + a[3] * b[3],
      a[4] * b[0] + a[5] * b[2] + b[4],
      a[4] * b[1] + a[5] * b[3] + b[5],
    ];
  }

  function _apply(m, x, y) {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }

  /** How many numbers each path sub-operator consumes. */
  var PATH_ARITY = {
    moveTo: 2,
    lineTo: 2,
    curveTo: 6,
    curveTo2: 4,
    curveTo3: 4,
    closePath: 0,
    rectangle: 4,
  };

  /**
   * Pull the `re` operators out of one constructPath.
   *
   * pdf.js hands the whole path over as a list of sub-operators and one flat
   * run of numbers, so the run has to be walked with the arity table above to
   * know which four belong to a rectangle. The shape of the outer arguments
   * has changed across pdf.js majors — a trailing bounding box came and went —
   * so only the first two entries are read, and anything unrecognized ends the
   * walk rather than misreading the rest of the numbers.
   */
  function _pathRects(args, ops, ctm, out) {
    var codes = args && args[0];
    var coords = args && args[1];
    if (!codes || !coords || typeof coords.length !== "number") return;

    var arity = {};
    for (var name in PATH_ARITY) {
      if (ops[name] !== undefined) arity[ops[name]] = PATH_ARITY[name];
    }

    var at = 0;
    for (var i = 0; i < codes.length; i++) {
      var take = arity[codes[i]];
      if (take === undefined) return;
      if (codes[i] === ops.rectangle) {
        var x = +coords[at];
        var y = +coords[at + 1];
        var w = +coords[at + 2];
        var h = +coords[at + 3];
        if (isFinite(x) && isFinite(y) && isFinite(w) && isFinite(h)) {
          out.push(_transformed(ctm, x, y, w, h));
        }
      }
      at += take;
      if (at > coords.length) return;
    }
  }

  function _transformed(ctm, x, y, w, h) {
    var pts = [
      _apply(ctm, x, y),
      _apply(ctm, x + w, y),
      _apply(ctm, x + w, y + h),
      _apply(ctm, x, y + h),
    ];
    var xs = pts.map(function (p) {
      return p[0];
    });
    var ys = pts.map(function (p) {
      return p[1];
    });
    var minX = Math.min.apply(null, xs);
    var minY = Math.min.apply(null, ys);
    return {
      x: minX,
      y: minY,
      width: Math.max.apply(null, xs) - minX,
      height: Math.max.apply(null, ys) - minY,
    };
  }

  /** Text runs with their baseline position and rendered size. */
  function _textItems(page) {
    return page.getTextContent().then(function (content) {
      var items = [];
      (content.items || []).forEach(function (item) {
        var text = (item.str || "").trim();
        if (!text) return;
        var t = item.transform || [1, 0, 0, 1, 0, 0];
        items.push({
          x: t[4],
          y: t[5],
          size: Math.hypot(t[2], t[3]) || item.height || 0,
          text: text,
        });
      });
      return items;
    });
  }

  function _holds(rect, points) {
    return points.every(function (p) {
      return (
        rect.x <= p[0] &&
        p[0] <= rect.x + rect.width &&
        rect.y <= p[1] &&
        p[1] <= rect.y + rect.height
      );
    });
  }

  function _area(rect) {
    return rect.width * rect.height;
  }

  function _round(rect) {
    return {
      x: Math.round(rect.x * 100) / 100,
      y: Math.round(rect.y * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100,
    };
  }

  function _placeholderFor(rects, items, pageWidth, pageHeight) {
    var pageArea = pageWidth * pageHeight;
    if (pageArea <= 0) return null;

    var seen = {};
    var candidates = [];
    rects.forEach(function (r) {
      var key = [r.x, r.y, r.width, r.height]
        .map(function (v) {
          return Math.round(v * 10) / 10;
        })
        .join(",");
      if (seen[key]) return;
      seen[key] = true;
      if (r.width < MIN_SIDE_PT || r.height < MIN_SIDE_PT) return;
      if (_area(r) > MAX_PAGE_FRACTION * pageArea) return;
      candidates.push(r);
    });
    if (!candidates.length) return null;

    var marks = items
      .filter(function (item) {
        return MARKERS.test(item.text);
      })
      .map(function (item) {
        return [item.x, item.y];
      });

    var best = null;
    if (marks.length) {
      // Several rectangles enclose the marker — the card frame does too. The
      // smallest one that still contains it is the map box.
      var fitting = candidates.filter(function (c) {
        return _holds(c, marks);
      });
      if (fitting.length) {
        best = fitting.reduce(function (a, b) {
          return _area(b) < _area(a) ? b : a;
        });
      }
    }

    if (!best) {
      // No marker: prefer the largest rectangle with no text inside it.
      var empty = candidates.filter(function (c) {
        return !items.some(function (item) {
          return _holds(c, [[item.x, item.y]]);
        });
      });
      var pool = empty.length ? empty : candidates;
      best = pool.reduce(function (a, b) {
        return _area(b) > _area(a) ? b : a;
      });
    }

    return { placeholder: best, candidates: candidates };
  }

  /** Dotted leader runs, left to right, become the writable field anchors. */
  function _fieldsFor(items) {
    var leaders = items
      .filter(function (item) {
        return LEADER.test(item.text);
      })
      .sort(function (a, b) {
        return a.x - b.x;
      });

    var names = ["locality", "territory"];
    var fields = {};
    names.forEach(function (name, i) {
      var leader = leaders[i];
      if (!leader) return;
      fields[name] = {
        x: Math.round((leader.x + 3) * 100) / 100,
        y: Math.round((leader.y + 5) * 100) / 100,
        size: Math.round(leader.size * 10) / 10,
      };
    });
    return fields;
  }

  /**
   * Page size, map placeholder and field anchors for a card template.
   *
   * Also returns every rectangle that survived filtering, which the server
   * route never did. print.js has always read `layout.candidates` to drive the
   * placement dialog's snapping, and on a detected layout that list was
   * silently empty — snapping only ever worked on a layout that had already
   * been positioned by hand once.
   */
  function inspectTemplate(file) {
    return Promise.all([_reader(), _bytes(file)])
      .then(function (parts) {
        return _open(parts[0], parts[1]);
      })
      .then(function (doc) {
        return _inspectPages(doc, 1).then(
          function (layout) {
            doc.destroy();
            return layout;
          },
          function (err) {
            doc.destroy();
            throw err;
          },
        );
      });
  }

  function _inspectPages(doc, number) {
    if (number > doc.numPages) {
      throw new Error("no usable placeholder rectangle");
    }
    return doc.getPage(number).then(function (page) {
      if ((page.rotate || 0) % 360) return _inspectPages(doc, number + 1);

      // page.view is [x0, y0, x1, y1]; measurements come out relative to its
      // origin so that draw time can add the origin back exactly once.
      var view = page.view;
      var originX = view[0];
      var originY = view[1];
      var pageWidth = view[2] - view[0];
      var pageHeight = view[3] - view[1];

      return _reader()
        .then(function (lib) {
          return Promise.all([_rectangles(page, lib.OPS), _textItems(page)]);
        })
        .then(function (parts) {
          var rects = parts[0].map(function (r) {
            return { x: r.x - originX, y: r.y - originY, width: r.width, height: r.height };
          });
          var items = parts[1].map(function (item) {
            return {
              x: item.x - originX,
              y: item.y - originY,
              size: item.size,
              text: item.text,
            };
          });

          var found = _placeholderFor(rects, items, pageWidth, pageHeight);
          if (!found) return _inspectPages(doc, number + 1);

          return {
            page: number - 1,
            pageWidth: Math.round(pageWidth * 100) / 100,
            pageHeight: Math.round(pageHeight * 100) / 100,
            placeholder: _round(found.placeholder),
            fields: _fieldsFor(items),
            candidates: found.candidates.map(_round),
          };
        });
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // PREVIEW — one page as a bitmap for the placement dialog
  // ══════════════════════════════════════════════════════════════════════

  function renderPage(file, pageIndex) {
    var index = Math.min(8, Math.max(0, pageIndex | 0));
    return Promise.all([_reader(), _bytes(file)])
      .then(function (parts) {
        return _open(parts[0], parts[1]);
      })
      .then(function (doc) {
        if (index >= doc.numPages) {
          doc.destroy();
          throw new Error("The template has no page at that index.");
        }
        return doc
          .getPage(index + 1)
          .then(function (page) {
            var viewport = page.getViewport({ scale: PREVIEW_SCALE });
            var canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.round(viewport.width));
            canvas.height = Math.max(1, Math.round(viewport.height));
            var context = canvas.getContext("2d");
            // A PDF page has no background of its own, and a card rendered
            // onto transparency is a black rectangle in a dark-mode browser.
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, canvas.width, canvas.height);
            return page.render({ canvasContext: context, viewport: viewport })
              .promise.then(function () {
                return _toBlob(canvas);
              });
          })
          .then(
            function (blob) {
              doc.destroy();
              return blob;
            },
            function (err) {
              doc.destroy();
              throw err;
            },
          );
      });
  }

  function _toBlob(canvas) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error("The template page could not be rasterized."));
      }, "image/png");
    });
  }

  // ══════════════════════════════════════════════════════════════════════
  // COMPOSE — stamp the map onto the template
  // ══════════════════════════════════════════════════════════════════════

  /**
   * @param {Object} spec
   * @param {File}   spec.template
   * @param {Blob}   spec.image      the rendered map, PNG
   * @param {number} spec.page
   * @param {Object} spec.box        {x, y, width, height} in points
   * @param {Array}  spec.fields     [{text, x, y, size}]
   * @param {Object} [spec.project]  embedded so the card is also the backup
   * @returns {Promise<Blob>}
   */
  function compose(spec) {
    return Promise.all([_writer(), _bytes(spec.template), _bytes(spec.image)])
      .then(function (parts) {
        var PDFLib = parts[0].lib;
        // Not `ignoreEncryption` — the server refused encrypted templates and
        // so does this. A card is a document handed to somebody else; quietly
        // stripping a password off one is not this app's decision to make.
        return PDFLib.PDFDocument.load(parts[1]).then(function (doc) {
          doc.registerFontkit(parts[0].fontkit);
          return _stamp(PDFLib, doc, parts[2], spec);
        });
      })
      .then(function (bytes) {
        return new Blob([bytes], { type: "application/pdf" });
      });
  }

  function _stamp(PDFLib, doc, image, spec) {
    var box = spec.box;
    if (
      !box ||
      ![box.x, box.y, box.width, box.height].every(function (v) {
        return isFinite(v);
      })
    ) {
      throw new Error("The placeholder rectangle is not a finite rectangle.");
    }
    if (box.width <= 0 || box.height <= 0) {
      throw new Error("The placeholder rectangle has no area.");
    }

    var index = spec.page | 0;
    if (index < 0 || index >= doc.getPageCount()) {
      throw new Error("The template has no page at that index.");
    }

    var page = doc.getPage(index);
    if ((page.getRotation().angle || 0) % 360) {
      throw new Error("Rotated template pages are not supported.");
    }

    // The crop box, not the media box: pdf.js reports page.view as the two
    // intersected, so that is the box the placeholder was measured against and
    // drawing against anything else would shift the map by the difference.
    // Identical on every template where the two agree, which is nearly all.
    var media = page.getCropBox ? page.getCropBox() : page.getMediaBox();
    if (
      box.x < 0 ||
      box.y < 0 ||
      box.x + box.width > media.width ||
      box.y + box.height > media.height
    ) {
      throw new Error("The placeholder rectangle falls outside the page.");
    }

    return doc.embedPng(image).then(function (png) {
      if (!png.width || !png.height) {
        throw new Error("The map image has no pixels.");
      }

      // Contain, not cover: the canvas already carries the placeholder's
      // aspect ratio, so this normally divides out exactly and only matters
      // for a card composed from an older saved view.
      var drawH = box.height;
      var drawW = (png.width / png.height) * drawH;
      if (drawW > box.width) {
        drawW = box.width;
        drawH = (png.height / png.width) * drawW;
      }

      // pdf-lib draws in user space, so a mediabox that does not start at the
      // origin shifts everything; the offset goes back in here.
      page.drawImage(png, {
        x: media.x + box.x + (box.width - drawW) / 2,
        y: media.y + box.y + (box.height - drawH) / 2,
        width: drawW,
        height: drawH,
      });

      var texts = (spec.fields || []).filter(function (field) {
        return field && field.text && isFinite(field.x) && isFinite(field.y);
      });
      if (!texts.length) return _finish(doc, spec);

      return _font(doc).then(function (font) {
        texts.forEach(function (field) {
          page.drawText(field.text, {
            x: media.x + field.x,
            y: media.y + field.y,
            // 10, not field.size. reportlab hardcoded 10 and the detected
            // leader size is often 14, so honoring it here would change every
            // card printed from a template someone has already tuned against.
            // Worth revisiting — on both paths at once.
            size: 10,
            font: font,
          });
        });
        return _finish(doc, spec);
      });
    });
  }

  /**
   * DejaVuSans, subsetted.
   *
   * The standard 14 are WinAnsi and cannot render ł ą ę ś ż ź ć ń, which is
   * every second Polish locality name. Subsetting is the one place this beats
   * the server outright: only the glyphs actually on the card are embedded.
   */
  function _font(doc) {
    return fetch(_vendor().font)
      .then(function (response) {
        if (!response.ok) throw new Error("The card font is not available.");
        return response.arrayBuffer();
      })
      .then(function (buf) {
        return doc.embedFont(new Uint8Array(buf), { subset: true });
      });
  }

  function _finish(doc, spec) {
    if (!spec.project) return doc.save();

    var raw;
    try {
      raw = new TextEncoder().encode(JSON.stringify(spec.project));
    } catch (err) {
      // A card that prints without its backup beats no card at all.
      console.warn(">>> Could not serialize the project state:", err.message);
      return doc.save();
    }
    if (raw.length > PROJECT_MAX_BYTES) {
      throw new Error("The project state is too large to attach.");
    }

    return _gzip(raw)
      .then(function (packed) {
        doc.attach(packed, PROJECT_ATTACHMENT_NAME, {
          mimeType: "application/gzip",
          description: "osmapp project state",
        });
      })
      .catch(function (err) {
        console.warn(">>> Could not attach the project state:", err.message);
      })
      .then(function () {
        return doc.save();
      });
  }

  // ══════════════════════════════════════════════════════════════════════
  // EXTRACT — read a saved project back out of a printed card
  // ══════════════════════════════════════════════════════════════════════

  function extractProject(file) {
    return Promise.all([_writer(), _bytes(file)])
      .then(function (parts) {
        return parts[0].lib.PDFDocument.load(parts[1]).then(function (doc) {
          return _attachment(parts[0].lib, doc, PROJECT_ATTACHMENT_NAME);
        });
      })
      .then(function (blob) {
        if (!blob) throw new Error("That PDF does not carry a saved project.");
        return _gunzip(blob);
      })
      .then(function (raw) {
        if (raw.length > PROJECT_MAX_UNZIPPED) {
          throw new Error("The saved project in that PDF is implausibly large.");
        }
        var payload = JSON.parse(new TextDecoder().decode(raw));
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
          throw new Error("The saved project in that PDF is damaged.");
        }
        return payload;
      });
  }

  /**
   * The last file embedded under `name`, or null.
   *
   * /EmbeddedFiles is a name tree, so it is either a flat /Names array or a
   * /Kids chain of them; both shapes turn up in the wild and pdf-lib hands
   * over the raw dictionaries rather than resolving either.
   */
  function _attachment(PDFLib, doc, name) {
    var names = doc.catalog.lookup(PDFLib.PDFName.of("Names"), PDFLib.PDFDict);
    if (!names) return null;
    var tree = names.lookup(
      PDFLib.PDFName.of("EmbeddedFiles"),
      PDFLib.PDFDict,
    );
    if (!tree) return null;

    var found = null;
    _walkNameTree(PDFLib, tree, function (key, value) {
      if (key === name) found = value;
    });
    if (!found) return null;

    var spec = doc.context.lookup(found, PDFLib.PDFDict) || found;
    var ef = spec.lookup(PDFLib.PDFName.of("EF"), PDFLib.PDFDict);
    if (!ef) return null;
    var stream =
      ef.lookup(PDFLib.PDFName.of("F")) || ef.lookup(PDFLib.PDFName.of("UF"));
    if (!stream) return null;

    if (typeof PDFLib.decodePDFRawStream !== "function") {
      throw new Error("This build cannot decode PDF attachments.");
    }
    return PDFLib.decodePDFRawStream(stream).decode();
  }

  function _walkNameTree(PDFLib, node, visit) {
    var entries = node.lookup(PDFLib.PDFName.of("Names"), PDFLib.PDFArray);
    if (entries) {
      for (var i = 0; i + 1 < entries.size(); i += 2) {
        var key = entries.lookup(i);
        visit(key && key.decodeText ? key.decodeText() : String(key), entries.get(i + 1));
      }
    }
    var kids = node.lookup(PDFLib.PDFName.of("Kids"), PDFLib.PDFArray);
    if (kids) {
      for (var k = 0; k < kids.size(); k++) {
        var kid = kids.lookup(k, PDFLib.PDFDict);
        if (kid) _walkNameTree(PDFLib, kid, visit);
      }
    }
  }

  return {
    supported: supported,
    withFallback: withFallback,
    inspectTemplate: inspectTemplate,
    renderPage: renderPage,
    compose: compose,
    extractProject: extractProject,
    // Exported for the tests: the geometry is the part that can be wrong
    // without looking wrong, and it is pure.
    _placeholderFor: _placeholderFor,
    _fieldsFor: _fieldsFor,
    _pathRects: _pathRects,
  };
})();

window.App = App;
