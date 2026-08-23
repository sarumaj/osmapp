/**
 * pdfdoc.js - every PDF job the app does, all of them in the browser.
 *
 * Four of them. Measuring a card template, turning one of its pages into a
 * bitmap for the placement dialog, pressing the rendered map into it, and
 * lifting a saved project back out of a card that was already printed.
 *
 * Why the browser
 *   Every other request this app makes - Overpass, Nominatim, tiles - wants a
 *   network wherever the code runs. Composing a card does not, and it is the
 *   last step between "tiles cached, territories in localStorage" and a card in
 *   somebody's hand. Working offline and working without a server are different
 *   goals; this is the slice of the second that delivers the first.
 *
 * There is no server side to any of this, and no fallback to one. A second
 * implementation of four jobs in another language, kept against the day the
 * first breaks, is a great deal of code for a path with no users - and an
 * untested path is not a safety net. So failures here are failures: `ensure()`
 * says up front whether the machinery is present, and everything below reports
 * its own trouble instead of handing the job on.
 *
 * The libraries arrive on first use, not at boot. pdf-lib (with fontkit) does
 * the writing, pdf.js does the reading. Call it two megabytes between them,
 * which is fine to spend on somebody who prints and pointless to spend on a
 * page view that never touches the print dialog. Either way the service worker
 * has already precached them, so "first use" costs parsing, not bandwidth.
 *
 * On coordinates
 *   Rectangles leave here measured from the mediabox origin and come back the
 *   same way, with the origin folded in once, at draw time. Measuring in
 *   absolute terms and adding the origin again when drawing counts it twice, on
 *   every page whose mediabox starts anywhere but 0,0.
 */
var App = window.App || {};

App.pdfdoc = (function () {
  "use strict";

  // The name the state is filed under and the ceilings a card may carry. This
  // is the only definition - nothing else reads or writes the attachment - and
  // the name is fixed rather than derived, so recovering the state later is one
  // lookup instead of a hunt and a card carrying somebody else's attachment is
  // not mistaken for one of these.
  var PROJECT_ATTACHMENT_NAME = "osmapp-project.json.gz";
  var PROJECT_MAX_BYTES = 8 * 1024 * 1024;
  var PROJECT_MAX_UNZIPPED = 32 * 1024 * 1024;

  // Detection thresholds. MARKERS can grow as needed; a template matching none
  // of it falls back to the largest rectangle without text.
  var MARKERS = /MIEJSCE NA MAP|MAPA TERENU|MAP AREA|KARTENFELD/i;
  var LEADER = /^[.\u2026]{4,}$/;
  var MIN_SIDE_PT = 40.0;
  var MAX_PAGE_FRACTION = 0.9;

  // The scale the placement preview is rendered at. The dialog's
  // pixels-per-point arithmetic is written against this number, so the two
  // have to move together.
  var PREVIEW_SCALE = 110 / 72;

  // LIBRARY LOADING

  function _vendor() {
    return window.VENDOR || {};
  }

  /**
   * Throw unless the machinery is at least declared.
   *
   * All this confirms is that the URLs reached the page. Whether the files
   * behind them can actually be fetched is discovered by fetching them, and
   * the loaders below report that in their own words - more use than a
   * boolean. With nothing left to fall back to, the point of asking early is
   * to fail with a sentence somebody can act on.
   */
  function ensure() {
    var v = _vendor();
    if (v.pdfLib && v.fontkit && v.pdfjs && v.font) return;
    throw new Error("This build is missing its PDF libraries.");
  }

  var _scripts = {};

  /** Add a classic <script> tag once, settling when its global shows up. */
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
      // Deliberately not remembered. A failure at this point usually means
      // the service worker has not precached this build yet, so trying again
      // later stands a decent chance.
      delete _scripts[url];
      throw err;
    });
    return _scripts[url];
  }

  var _pdfLib = null;

  /** pdf-lib, fontkit registered: the half of this file that *writes*. */
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
   * pdf.js - the half that *reads*.
   *
   * Ships as an ES module, so it comes in via import() instead of a script
   * tag. Its worker is same-origin and precached. Leave workerSrc unset and
   * pdf.js parses on the main thread instead, which freezes the interface the
   * moment a page contains a photograph.
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
      // Word-processor exports tend to point at the standard 14 rather than
      // embed anything, and getTextContent wants the metrics before it can
      // recover characters. Leave this out and both the markers and the leader
      // dots come back as empty strings.
      standardFontDataUrl: _vendor().pdfjsStandardFonts,
      // Nothing here needs code generated at runtime, and turning it down
      // keeps a strict script-src workable.
      isEvalSupported: false,
    }).promise;
  }

  /**
   * Hand a document back.
   *
   * pdf.js 6 dropped PDFDocumentProxy.destroy() - teardown moved to the
   * loading task, which is what owns the worker. Calling the old method on a
   * v6 proxy throws, and every one of these sits in a `.then` that nobody
   * awaits, so the failure surfaces as an unrelated rejection ("doc.destroy
   * is not a function") swallowing whatever the caller was actually doing.
   *
   * Rejections from the teardown itself are of no interest here: the
   * document is being thrown away either way.
   */
  function _close(doc) {
    var owner = (doc && doc.loadingTask) || doc;
    if (!owner || !owner.destroy) return;
    Promise.resolve()
      .then(function () {
        return owner.destroy();
      })
      .catch(function () {});
  }

  // BYTES

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

  /** gzip - or the payload untouched, on a browser with no CompressionStream. */
  function _gzip(bytes) {
    if (typeof window.CompressionStream !== "function") {
      // _gunzip below takes an uncompressed payload as it comes, so a card
      // written on such a browser still opens anywhere. It is just bigger.
      return Promise.resolve(bytes);
    }
    return _collect(
      new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip")),
    );
  }

  function _gunzip(bytes) {
    // No gzip header, so a build from before compression wrote this one.
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

  // INSPECT - where the map goes on this template

  /**
   * Every rectangle drawn on the page, in page coordinates.
   *
   * The transform is tracked because word processors habitually wrap their
   * drawing in a scale, and coordinates taken raw would be wrong by that
   * factor while looking perfectly fine. Form XObjects are descended into for
   * the same reason: a template whose card sits inside one embedded form
   * offers no candidate rectangles at all to a walk that stays at the top
   * level.
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

  /** Numbers consumed by each path sub-operator. */
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
   * Recover the `re` operators from a single constructPath.
   *
   * What pdf.js hands over is a list of sub-operators plus one flat run of
   * numbers, so the run gets walked against the arity table above to work out
   * which four belong to a rectangle. The outer argument shape has shifted
   * between pdf.js majors - a trailing bounding box appeared and later left
   * again - so only the first two entries are touched, and an unfamiliar
   * sub-operator ends the walk instead of misreading everything after it.
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

  /** Runs of text, with baseline position and the size they render at. */
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
      // Plenty of rectangles enclose the marker, the card frame among them.
      // The smallest that still does is the map box.
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
      // No marker anywhere: take the biggest rectangle holding no text.
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

  /** Leader dots, read left to right, mark where the fields are written. */
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
   * For a card template: page size, the map box, and where the fields go.
   *
   * `layout.candidates` carries every rectangle that got through filtering, and
   * print.js drives the placement dialog's snapping off it. Returning a detected
   * layout without them is the quiet failure to avoid: snapping then works only
   * on a layout somebody has already placed by hand, and says nothing about why.
   */
  function inspectTemplate(file) {
    ensure();
    return Promise.all([_reader(), _bytes(file)])
      .then(function (parts) {
        return _open(parts[0], parts[1]);
      })
      .then(function (doc) {
        return _inspectPages(doc, 1).then(
          function (layout) {
            _close(doc);
            return layout;
          },
          function (err) {
            _close(doc);
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

      // page.view arrives as [x0, y0, x1, y1]. Measuring relative to its
      // origin lets draw time put the origin back exactly once.
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

  // PREVIEW - one page as a bitmap for the placement dialog

  function renderPage(file, pageIndex) {
    ensure();
    var index = Math.min(8, Math.max(0, pageIndex | 0));
    return Promise.all([_reader(), _bytes(file)])
      .then(function (parts) {
        return _open(parts[0], parts[1]);
      })
      .then(function (doc) {
        if (index >= doc.numPages) {
          _close(doc);
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
            // PDF pages carry no background. Render a card onto transparency
            // and a dark-mode browser shows a black rectangle.
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, canvas.width, canvas.height);
            return page.render({ canvasContext: context, viewport: viewport })
              .promise.then(function () {
                return _toBlob(canvas);
              });
          })
          .then(
            function (blob) {
              _close(doc);
              return blob;
            },
            function (err) {
              _close(doc);
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

  // COMPOSE - stamp the map onto the template

  /**
   * @param {Object} spec
   * @param {File}   spec.template
   * @param {Blob}   spec.image      the finished map, as PNG
   * @param {number} spec.page
   * @param {Object} spec.box        {x, y, width, height} in points
   * @param {Array}  spec.fields     [{text, x, y, size}]
   * @param {Object} [spec.project]  goes in so the card doubles as a backup
   * @returns {Promise<Blob>}
   */
  function compose(spec) {
    ensure();
    return Promise.all([_writer(), _bytes(spec.template), _bytes(spec.image)])
      .then(function (parts) {
        var PDFLib = parts[0].lib;
        // No `ignoreEncryption`: an encrypted template is turned away rather
        // than opened. Cards get handed to other people, and silently taking
        // a password off one is not this app's decision to make.
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

    // Crop box, not media box. pdf.js gives page.view as the intersection of
    // the two, so that is what the placeholder was measured against; drawing
    // against anything else moves the map by whatever the difference is. Where
    // the two boxes agree - nearly always - this is the same thing.
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

      // Contain rather than cover. The canvas already holds the placeholder's
      // aspect ratio, so in practice this divides out exactly; it only bites
      // on a card built from an older saved view.
      var drawH = box.height;
      var drawW = (png.width / png.height) * drawH;
      if (drawW > box.width) {
        drawW = box.width;
        drawH = (png.height / png.width) * drawW;
      }

      // pdf-lib works in user space, so a mediabox starting anywhere but the
      // origin displaces the lot. The offset is put back right here.
      var area = {
        x: media.x + box.x + (box.width - drawW) / 2,
        y: media.y + box.y + (box.height - drawH) / 2,
        width: drawW,
        height: drawH,
      };
      page.drawImage(png, {
        x: area.x,
        y: area.y,
        width: area.width,
        height: area.height,
      });

      var texts = (spec.fields || []).filter(function (field) {
        return field && field.text && isFinite(field.x) && isFinite(field.y);
      });
      // One font for the card's fields and for any note whose words are
      // printed, fetched only when something actually needs it: a card with
      // neither should not pay for a typeface.
      var wantsFont =
        texts.length ||
        (spec.notes || []).some(function (note) {
          return note && note.label;
        });

      return (wantsFont ? _font(doc) : Promise.resolve(null)).then(function (
        font,
      ) {
        // After the image and before the fields, which is also the order they
        // are read in: an annotation belongs over the map it is about.
        _annotate(PDFLib, doc, page, area, spec.notes, font);

        texts.forEach(function (field) {
          page.drawText(field.text, {
            x: media.x + field.x,
            y: media.y + field.y,
            // A fixed 10 pt rather than field.size. The leader size detection
            // reports is frequently 14, so obeying it would move the text on
            // every card printed from a template somebody has already tuned
            // to the 10 pt this has always written.
            size: 10,
            font: font,
          });
        });
        return _finish(doc, spec);
      });
    });
  }

  /**
   * DejaVuSans, cut down to what is used.
   *
   * WinAnsi is what the standard 14 give you, and it has no ł ą ę ś ż ź ć ń --
   * that is every other locality name in Poland. Subsetting is the single
   * place this genuinely beats the server: only glyphs that appear on the card
   * make it into the file.
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
      // Losing the backup is survivable. Losing the card is not.
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

  // ANNOTATE - the notes, as annotations rather than as ink

  /**
   * Why these are annotations and not pixels
   *
   * A note is somebody's remark about the ground, and the person holding the
   * card is the one most likely to want to answer it. Pressed into the map
   * image it is a picture of a remark: it cannot be opened, moved, replied to
   * or taken off. Written as an annotation it is the thing itself - it appears
   * in the reader's comment list, with the note's words as its /Contents and
   * this app as its author.
   *
   * The consequence, and it is a real one: a PDF card does not carry those
   * words in ink. A PNG card draws them beside the mark, because a picture has
   * nowhere else to put them; a PDF card puts them where a comment goes, which
   * is a panel rather than the page. Print a PDF card and you get the marks
   * without the sentences.
   *
   * Why every kind is /Ink
   *
   * A pin is closer in spirit to /Text, the popup note a reader draws its own
   * icon for. It is also the subtype a reader will not let go of: the ones
   * that let an annotation be selected and deleted - the browsers especially --
   * offer that for the kinds they can draw themselves, and a popup note is not
   * among them. A pin nobody can rub out is worse than a pin filed under a
   * subtype that suits it less well, so all three are ink, and what tells a
   * glyph from a mark is that its paths are closed and filled.
   *
   * Each annotation carries an appearance stream of its own. Where /AP is
   * absent, PDF 32000-1 12.5.5 leaves the drawing to the reader, and readers
   * differ - in what they draw, and in whether they draw markup when printing
   * at all. With /AP and the print flag, the marks on the paper are the marks
   * that were on the preview.
   *
   * On coordinates: everything below is in absolute user space, and each
   * appearance stream's /BBox is its annotation's /Rect. That is deliberate --
   * 12.5.5 maps the transformed BBox onto the Rect, so the two being equal is
   * what makes that mapping the identity and keeps a stroke from being
   * stretched into its own bounding box.
   */

  var ANNOTATION_AUTHOR = "OSM Territory Mapper";

  /** Slack around a path's own extent, so a thick line is not clipped. */
  var INK_PAD_PT = 2;

  /** The white outline every glyph carries, so it reads on any ground. */
  var GLYPH_OUTLINE_PT = 0.7;

  /**
   * The note window a reader opens from the comment.
   *
   * Closed, and never printed - the print flag is deliberately absent here,
   * where every other annotation this file writes carries it. A popup is the
   * reader's window onto the text, not something to put on paper.
   */
  var POPUP_W_PT = 200;
  var POPUP_H_PT = 90;

  /**
   * Attach one annotation per note.
   *
   * @param {Object} area where the map image ended up, in user space
   * @param {Array} notes from print.js: paths as fractions of that image, with
   *   y measured downward the way a canvas measures it
   */
  function _annotate(PDFLib, doc, page, area, notes, font) {
    if (!Array.isArray(notes) || !notes.length) return;
    var stamped = PDFLib.PDFString.fromDate(new Date());

    notes.forEach(function (note, index) {
      // One annotation per note, whichever pieces it is made of. A glyph with
      // its words beside it is one remark somebody made, and two objects
      // would be two rows in the comment list and two things to delete.
      var dict = note.paths.length
        ? _inkAnnotation(PDFLib, doc, note, area, font)
        : _captionAnnotation(PDFLib, doc, note, area, font);
      if (!dict) return;

      // Hex strings, not literals: a note is whatever the user typed, and the
      // PDFDocEncoding a literal string implies has no room for the Polish
      // diacritics the rest of this file goes to some length to support.
      dict.Contents = PDFLib.PDFHexString.fromText(note.text || "");
      dict.T = PDFLib.PDFHexString.fromText(ANNOTATION_AUTHOR);
      dict.NM = PDFLib.PDFHexString.fromText("osmapp-note-" + (index + 1));
      // Both dates, and the same date. A reader's comment list is a list of
      // things somebody said, and it sorts and captions them by when they
      // were said; one written with neither is a row with a blank where the
      // rest of them carry a time.
      dict.M = stamped;
      dict.CreationDate = stamped;
      if (note.subject) {
        // What the comment list calls this row, in the language of the card.
        dict.Subj = PDFLib.PDFHexString.fromText(note.subject);
      }
      dict.C = _rgb(note.color);
      // Bit 3, Print. Without it a reader is entitled to leave the annotation
      // off the paper, which for a card that exists to be carried around is
      // the same as not making it.
      dict.F = 4;

      // The parent's own reference has to exist before the popup can name it
      // and after the popup has been named on the parent, so it is reserved
      // here and filled in below rather than handed out by register().
      var ref = doc.context.nextRef();
      dict.Popup = _popup(PDFLib, doc, page, dict.Rect, ref);
      doc.context.assign(ref, doc.context.obj(dict));
      page.node.addAnnot(ref);
    });
  }

  /**
   * One note, as the ink it is drawn with.
   *
   * A mark is stroked in its own color at its own width. A glyph is filled in
   * that color and outlined in white, with the even-odd rule, so the second
   * ring of a pin or a note is the hole the icon font draws there.
   */
  function _inkAnnotation(PDFLib, doc, note, area, font) {
    var paths = (note.paths || [])
      .map(function (path) {
        return path
          .map(function (point) {
            return _onPage(point, area);
          })
          .filter(Boolean);
      })
      .filter(function (path) {
        return path.length >= 2;
      });
    if (!paths.length) return null;

    var width = note.closed
      ? GLYPH_OUTLINE_PT
      : Math.max(0.5, note.width || 1);
    var rect = _bounds(paths, width / 2 + INK_PAD_PT);
    var color = _rgb(note.color);

    var content = note.closed
      ? [_rgbOp(color, "rg"), "1 1 1 RG"]
      : [_rgbOp(color, "RG")];
    content.push(_num(width) + " w", "1 J", "1 j");
    paths.forEach(function (path) {
      content.push(_linePath(path) + (note.closed ? " h" : ""));
    });
    // One painting operator for the lot: the rings of a glyph have to be
    // filled together or the hole in one of them is filled by the next.
    content.push(note.closed ? "B*" : "S");

    var label = _label(note, area, font);
    if (label) {
      content.push(label.content);
      rect = _union(rect, label.rect);
    }

    return {
      Type: "Annot",
      Subtype: "Ink",
      Rect: rect,
      // The geometry twice over, deliberately. /InkList is what an editor
      // reshapes and what a reader regenerates an appearance from after an
      // edit; the /AP is what everything draws until somebody does.
      InkList: paths.map(function (path) {
        return path.reduce(function (flat, point) {
          return flat.concat(point);
        }, []);
      }),
      BS: { W: width, S: "S" },
      AP: {
        N: _appearance(PDFLib, doc, rect, content.join("\n"), label && font),
      },
    };
  }

  /**
   * A caption: words on the map and nothing else, so /FreeText rather than
   * ink around an empty path.
   *
   * The subtype is what a reader keys its editing off - double-clicking a
   * FreeText opens it for typing, which is exactly what a caption is for.
   */
  function _captionAnnotation(PDFLib, doc, note, area, font) {
    var label = _label(note, area, font);
    if (!label) return null;

    return {
      Type: "Annot",
      Subtype: "FreeText",
      Rect: label.rect,
      // The appearance below is what is actually drawn; /DA is what a reader
      // falls back on when it rebuilds one after an edit, so the two name the
      // same font at the same size.
      DA: PDFLib.PDFString.of("/F1 " + _num(label.size) + " Tf 0 g"),
      DR: { Font: { F1: font.ref } },
      // Left, matching the box the preview drew.
      Q: 0,
      AP: { N: _appearance(PDFLib, doc, label.rect, label.content, font) },
    };
  }

  /**
   * The box of words a note carries, drawn in the annotation's own appearance.
   *
   * Every measurement arrives as a fraction of the map image, so that a card
   * whose map was fitted into a smaller placeholder carries type fitted by the
   * same amount - see _labelSpec in print.js, which is where the lines were
   * wrapped and the box first measured.
   *
   * The box is measured again here, and kept at whichever of the two is
   * wider. The preview measures Arial and this draws DejaVu, and a box sized
   * for the narrower of the two clips the last word off every label - which
   * is what the appearance stream's own BBox does to anything past its edge.
   * Growing happens away from the mark, so a label that was flipped to the
   * left of its glyph does not grow back across it.
   *
   * @returns {{content:string, rect:number[], size:number}|null}
   */
  function _label(note, area, font) {
    if (!note.label || !font) return null;
    var label = note.label;

    var topLeft = _onPage(label.at, area);
    var size = label.size * area.width;
    var pad = label.pad * area.width;
    var step = label.step * area.width;

    var text = label.lines.reduce(function (widest, line) {
      return Math.max(widest, font.widthOfTextAtSize(line, size));
    }, 0);
    var width = Math.max(label.width * area.width, text + pad * 2);
    var height = Math.max(
      label.height * area.height,
      label.lines.length * step + pad * 2,
    );

    var left = topLeft[0];
    var top = topLeft[1];
    var grown = width - label.width * area.width;
    if (label.grow === "left") left -= grown;
    else if (label.grow === "centre") left -= grown / 2;
    var rect = [left, top - height, left + width, top];

    var content = [
      "q 1 1 1 rg",
      _rgbOp(_rgb(note.color), "RG"),
      _num(Math.max(0.4, size * 0.08)) + " w",
      _rect(rect),
      "B Q",
      "BT /F1 " + _num(size) + " Tf 0 g",
    ];
    label.lines.forEach(function (line, index) {
      // Down from the top of the box rather than up from the bottom: the
      // preview lays the lines out that way, and a box with one line too many
      // has to overflow at the same end in both.
      var baseline = top - pad - size * ASCENDER - index * step;
      content.push(
        "1 0 0 1 " +
          _num(left + pad) +
          " " +
          _num(baseline) +
          " Tm " +
          font.encodeText(line) +
          " Tj",
      );
    });
    content.push("ET");

    return { content: content.join("\n"), rect: rect, size: size };
  }

  /**
   * How far below the top of a line its baseline sits, as a share of the type
   * size.
   *
   * A canvas draws from the top of the em box and a PDF from the baseline, so
   * something has to bridge them. pdf-lib exposes a line height but not an
   * ascender, and 0.78 is close enough for DejaVu at nine points that the two
   * outputs put the words in the same place.
   */
  var ASCENDER = 0.78;

  /** A rectangle as the operator that draws it. */
  function _rect(rect) {
    return (
      _num(rect[0]) +
      " " +
      _num(rect[1]) +
      " " +
      _num(rect[2] - rect[0]) +
      " " +
      _num(rect[3] - rect[1]) +
      " re"
    );
  }

  /** The rectangle covering both. */
  function _union(a, b) {
    return [
      Math.min(a[0], b[0]),
      Math.min(a[1], b[1]),
      Math.max(a[2], b[2]),
      Math.max(a[3], b[3]),
    ];
  }

  /**
   * The window a reader shows the note's text in.
   *
   * Written out rather than left to the reader. A markup annotation without
   * one is a shape that happens to carry a string: some readers invent a
   * popup for it, some show the text only in a sidebar, and some show nothing
   * at all - which is the complaint this exists to answer.
   *
   * @param {number[]} rect the annotation's own rectangle
   * @param {PDFRef} parent the annotation this window belongs to
   * @returns {PDFRef}
   */
  function _popup(PDFLib, doc, page, rect, parent) {
    var ref = doc.context.register(
      doc.context.obj({
        Type: "Annot",
        Subtype: "Popup",
        // Beside the mark and hanging below it, which is where a reader that
        // honors the rectangle puts a note window it did not place itself.
        Rect: [rect[2], rect[1] - POPUP_H_PT, rect[2] + POPUP_W_PT, rect[1]],
        Parent: parent,
        Open: false,
      }),
    );
    page.node.addAnnot(ref);
    return ref;
  }

  /**
   * A form XObject holding one annotation's drawing.
   *
   * @param {Object} [font] named F1 in the form's resources where the content
   *   sets type; a stream that says Tf with no font to resolve draws nothing
   * @returns {PDFRef}
   */
  function _appearance(PDFLib, doc, rect, content, font) {
    return doc.context.register(
      doc.context.flateStream(content, {
        Type: "XObject",
        Subtype: "Form",
        BBox: rect,
        Resources: font ? { Font: { F1: font.ref } } : {},
      }),
    );
  }

  /**
   * One point of the map image, in user space.
   *
   * The flip is the whole of it: a canvas measures y downward from the top and
   * a PDF measures it upward from the bottom, and getting that backwards
   * mirrors every annotation about the middle of the card - which looks like a
   * plausible card until somebody compares it with the preview.
   */
  function _onPage(point, area) {
    if (!point || !isFinite(point[0]) || !isFinite(point[1])) return null;
    return [
      area.x + point[0] * area.width,
      area.y + (1 - point[1]) * area.height,
    ];
  }

  /** The rectangle enclosing every point, grown by `pad`. */
  function _bounds(paths, pad) {
    var x0 = Infinity;
    var y0 = Infinity;
    var x1 = -Infinity;
    var y1 = -Infinity;
    paths.forEach(function (path) {
      path.forEach(function (point) {
        x0 = Math.min(x0, point[0]);
        y0 = Math.min(y0, point[1]);
        x1 = Math.max(x1, point[0]);
        y1 = Math.max(y1, point[1]);
      });
    });
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  }

  function _linePath(path) {
    return path
      .map(function (point, index) {
        return _num(point[0]) + " " + _num(point[1]) + (index ? " l" : " m");
      })
      .join(" ");
  }

  /**
   * A color-setting operator: "rg" fills in it, "RG" strokes in it.
   *
   * @param {number[]} color three components in 0..1, from _rgb
   */
  function _rgbOp(color, operator) {
    return color.map(_num).concat(operator).join(" ");
  }

  /** "#rrggbb" as the three 0..1 components a PDF color is written in. */
  function _rgb(value) {
    var match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value || "");
    if (!match) return [0, 0, 0];
    return [1, 2, 3].map(function (group) {
      return parseInt(match[group], 16) / 255;
    });
  }

  /** Content streams are text, so a coordinate is written to the dot it needs. */
  function _num(value) {
    return (Math.round(value * 100) / 100).toString();
  }

  // EXTRACT - read a saved project back out of a printed card

  function extractProject(file) {
    ensure();
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
   * Whichever file was embedded last under `name`, else null.
   *
   * /EmbeddedFiles is a name tree, meaning either one flat /Names array or a
   * /Kids chain of them. Both turn up out there, and pdf-lib passes the raw
   * dictionaries along without resolving either shape.
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
    inspectTemplate: inspectTemplate,
    renderPage: renderPage,
    compose: compose,
    extractProject: extractProject,
    // Out for the tests. The geometry is pure, and it is the part capable of
    // being wrong while looking entirely reasonable.
    _placeholderFor: _placeholderFor,
    _fieldsFor: _fieldsFor,
    _pathRects: _pathRects,
    _close: _close,
    // Out for the tests as well: the flip in _onPage and the geometry either
    // side of it are what put an annotation over the right piece of ground,
    // and a card whose comments are all mirrored still looks like a card.
    _annotate: _annotate,
    _label: _label,
    _onPage: _onPage,
    _rgb: _rgb,
    _bounds: _bounds,
  };
})();

window.App = App;
