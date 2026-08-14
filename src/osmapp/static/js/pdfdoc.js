/**
 * pdfdoc.js — the PDF jobs that used to run in Python, run here instead.
 *
 * Four of them. Measuring a card template, turning one of its pages into a
 * bitmap for the placement dialog, pressing the rendered map into it, and
 * lifting a saved project back out of a card that was already printed.
 *
 * Why bother
 *   Every other request this app makes — Overpass, Nominatim, tiles — wants a
 *   network, wherever the code happens to run. The PDF routes never did. They
 *   were simply the last thing between "tiles cached, territories sitting in
 *   localStorage" and an actual card. Working offline and working without a
 *   server are different goals; this is the slice of the second that delivers
 *   the first.
 *
 * There is no server side to this any more. /inspect_template,
 * /template_preview, /compose_pdf and /extract_project are gone, and so are
 * internal/pdf.py, internal/template.py, pypdf, pypdfium2 and reportlab. They
 * survived one release as a fallback and nothing ever reached them. Carrying a
 * second implementation of all four jobs, in another language, against the day
 * the first one breaks is a great deal of code to maintain for a path with no
 * users — and an untested path is not a safety net anyway. So failures here
 * are failures: `ensure()` says up front whether the machinery is present, and
 * everything below reports its own trouble instead of handing the job on.
 *
 * The libraries arrive on first use, not at boot. pdf-lib (with fontkit) does
 * the writing, pdf.js does the reading. Call it two megabytes between them,
 * which is fine to spend on somebody who prints and pointless to spend on a
 * page view that never touches the print dialog. Either way the service worker
 * has already precached them, so "first use" costs parsing, not bandwidth.
 *
 * On coordinates
 *   Rectangles leave here measured from the mediabox origin and come back the
 *   same way, with the origin folded in when something is drawn. The old
 *   server route measured in absolute terms and then added the origin a second
 *   time at draw time, so a page whose mediabox started anywhere but 0,0 got
 *   counted twice.
 */
var App = window.App || {};

App.pdfdoc = (function () {
  "use strict";

  // The name the state is filed under and the ceilings a card may carry.
  // These used to have to agree with internal/pdf.py by hand; nothing else
  // reads or writes the attachment now, so this is the only definition. The
  // name stays fixed regardless: recovering the state later is one lookup
  // instead of a hunt, and a card carrying somebody else's file is not
  // mistaken for ours.
  var PROJECT_ATTACHMENT_NAME = "osmapp-project.json.gz";
  var PROJECT_MAX_BYTES = 8 * 1024 * 1024;
  var PROJECT_MAX_UNZIPPED = 32 * 1024 * 1024;

  // Detection thresholds, inherited from the Python that used to do this.
  // MARKERS can grow as needed; a template matching none of it falls back to
  // the largest rectangle without text.
  var MARKERS = /MIEJSCE NA MAP|MAPA TERENU|MAP AREA|KARTENFELD/i;
  var LEADER = /^[.\u2026]{4,}$/;
  var MIN_SIDE_PT = 40.0;
  var MAX_PAGE_FRACTION = 0.9;

  // The scale pypdfium2 rendered the placement preview at. Kept because the
  // dialog's pixels-per-point arithmetic was written against it, not because
  // there is anything left to stay in step with.
  var PREVIEW_SCALE = 110 / 72;

  // ══════════════════════════════════════════════════════════════════════
  // LIBRARY LOADING
  // ══════════════════════════════════════════════════════════════════════

  function _vendor() {
    return window.VENDOR || {};
  }

  /**
   * Throw unless the machinery is at least declared.
   *
   * All this confirms is that the URLs reached the page. Whether the files
   * behind them can actually be fetched is discovered by fetching them, and
   * the loaders below report that in their own words — more use than a
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
   * pdf.js — the half that *reads*.
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

  /** gzip — or the payload untouched, on a browser with no CompressionStream. */
  function _gzip(bytes) {
    if (typeof window.CompressionStream !== "function") {
      // _gunzip below takes an uncompressed payload as it comes, and so did
      // the Python that used to read these, so a card written on such a
      // browser still opens anywhere. It is just bigger.
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

  // ══════════════════════════════════════════════════════════════════════
  // INSPECT — where the map goes on this template
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Every rectangle drawn on the page, in page coordinates.
   *
   * The transform gets tracked here for the same reason it did in Python:
   * word processors habitually wrap their drawing in a scale, and coordinates
   * taken raw would be wrong by that factor while looking perfectly fine. This
   * version also descends into Form XObjects, which pypdf never did — over
   * there, a template whose card sits inside one embedded form produced no
   * candidate rectangles whatsoever.
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
   * between pdf.js majors — a trailing bounding box appeared and later left
   * again — so only the first two entries are touched, and an unfamiliar
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
   * This also hands back every rectangle that got through filtering, which the
   * server route never bothered to. print.js has always read
   * `layout.candidates` to drive snapping in the placement dialog, and on a
   * detected layout that list came through empty without comment — so snapping
   * only ever did anything on a layout somebody had already placed by hand.
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

  // ══════════════════════════════════════════════════════════════════════
  // PREVIEW — one page as a bitmap for the placement dialog
  // ══════════════════════════════════════════════════════════════════════

  function renderPage(file, pageIndex) {
    ensure();
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
        // No `ignoreEncryption`. The server turned encrypted templates away
        // and this does the same. Cards get handed to other people, and
        // silently taking a password off one is not ours to decide.
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
    // the two boxes agree — nearly always — this is the same thing.
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
            // 10 rather than field.size. reportlab had 10 baked in, and the
            // leader size that detection reports is frequently 14, so obeying
            // it would move the text on every card printed from a template
            // somebody already tuned. Worth fixing — but on both paths at once.
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
   * WinAnsi is what the standard 14 give you, and it has no ł ą ę ś ż ź ć ń —
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

  // ══════════════════════════════════════════════════════════════════════
  // EXTRACT — read a saved project back out of a printed card
  // ══════════════════════════════════════════════════════════════════════

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
    ensure: ensure,
    inspectTemplate: inspectTemplate,
    renderPage: renderPage,
    compose: compose,
    extractProject: extractProject,
    // Out for the tests. The geometry is pure, and it is the part capable of
    // being wrong while looking entirely reasonable.
    _placeholderFor: _placeholderFor,
    _fieldsFor: _fieldsFor,
    _pathRects: _pathRects,
  };
})();

window.App = App;
