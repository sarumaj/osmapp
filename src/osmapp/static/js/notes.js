/**
 * notes.js - annotations drawn over the working area.
 *
 * Four kinds, because four different things get written on a paper map
 * before it is handed to somebody:
 *
 *   - a **note**: a sentence pinned to a spot ("gate is round the back"),
 *   - a **pin**: a mark on one place or building with an optional label,
 *   - a **line**: a stroke along something, drawn either freehand or snapped
 *     to the street network so that "this street, not the next one" is a
 *     mark that actually lies on the street,
 *   - a **caption**: words on the ground and nothing else ("odd side", "start
 *     here"), which is a note without the icon that would anchor it to a
 *     doorway it is not about.
 *
 * All four are one record with one geometry - a list of lng/lat points, of
 * length one for everything but a line - so that everything downstream (the
 * layer, the session, the card) walks a single shape instead of four.
 *
 * Why they are not territories
 *
 * A territory is the document: it is partitioned, cut, merged and counted, and
 * every tool in the app has an opinion about it. A note is a remark about the
 * ground. Keeping them apart is what lets a note survive a re-partition, sit
 * outside the boundary, and be switched off for a card without any of the
 * geometry code having to know it exists.
 *
 * On the card
 *
 * A PNG card is a picture, so notes are drawn into it. A PDF card is a
 * document, so they become real PDF annotations a reader can open, reply to,
 * move or delete. See print.js for the handover and pdfdoc.js for the
 * dictionaries. Nothing here knows about either; this module owns the records
 * and what they look like on screen.
 */
var App = window.App || {};
App._loaded = App._loaded || [];

App.notes = (function () {
  "use strict";

  var s = null;
  var D = null;
  var T = null;
  var N = null;

  /**
   * Which tool the next gesture makes something with.
   *
   * Drawing is one tool rather than two, and the gesture decides which kind of
   * line comes out: a drag is a freehand sweep, a click places a vertex. That
   * is a distinction the hand already makes, so it needs no control. What does
   * need one is whether a clicked vertex is pulled onto the street network,
   * which is a question about the result rather than about the gesture - hence
   * the snap switch on the bar, in the same place the cut and trim tools keep
   * theirs.
   */
  var TOOLS = ["note", "pin", "draw", "text"];

  /**
   * The Font Awesome glyph each tool is drawn with - on the bar, in the menu,
   * and on the map, where a note and a pin are drawn with the glyph of the
   * tool that made them.
   */
  var TOOL_ICONS = {
    note: "fa-note-sticky",
    pin: "fa-location-dot",
    draw: "fa-pencil",
    text: "fa-font",
  };

  /** What a stored record may call itself. The draw tool makes "line". */
  var KINDS = ["note", "pin", "line", "text"];

  /** What the text dialog is titled, per kind. */
  var TITLE_KEYS = {
    note: "notes.titleNote",
    pin: "notes.titlePin",
    line: "notes.titleLine",
    text: "notes.titleText",
  };

  var PEN_KEY = "osmapp.notes.pen";

  /**
   * How far back a double-click reaches for the clicks that belong to it.
   *
   * Leaflet fires click, click, dblclick, so the two trailing clicks have
   * already placed vertices by the time the gesture is reported. Both are
   * dropped and one is placed at the double-click instead - which is the cut
   * tool's rule, for the same reason it has it: popping only one leaves the
   * line a vertex long, and popping everything inside the window eats real
   * vertices from anybody clicking quickly along a street.
   */
  var DBLCLICK_MS = 300;

  /** Snapshots of the whole note list, newest last. */
  var _undo = [];
  var _redo = [];
  var MAX = 60;

  var _tool = "note";
  var _pen = { color: "#d40000", width: 2 };

  var _toolbar = null;
  var _hint = null;
  var _visible = true;

  // The line being drawn. `points` are committed lng/lat coordinates;
  // `_preview` is the polyline showing them, including the routed geometry
  // inserted between snapped clicks.
  var _draft = null;
  var _preview = null;
  var _snapDot = null;

  // The left button, from press to release: `moved` once it has travelled far
  // enough to be a sweep rather than a click, and `opened` when there was no
  // line in progress when it went down.
  var _press = null;

  // The right button, which pans the map while the draw tool has the left one.
  var _rightPan = null;

  function init() {
    s = App.state;
    D = App.dom;
    T = App.i18n.t;
    N = App.network;
    var saved = App.util.readJson(PEN_KEY, null);
    if (saved) {
      // Checked rather than trusted: the color is interpolated into a marker's
      // inline style and the width into a stroke weight, and localStorage is
      // the one input here nothing else has looked at.
      _pen.color = _cssColor(saved.color);
      _pen.width = isFinite(saved.width)
        ? Math.min(8, Math.max(0.5, saved.width))
        : _pen.width;
    }
    App._loaded.push("notes");
  }

  // THE RECORDS

  /** @returns {number} how many annotations exist, whatever kind they are. */
  function count() {
    return s.notes.length;
  }

  /**
   * The records, deep-copied.
   *
   * Copies rather than the live array, because both callers - the session
   * writer and the card composer - hold what they are given past the next
   * edit, and a shared array would let a note deleted in the meantime turn up
   * on a card.
   *
   * @returns {Array<{kind:string, points:Array<Array<number>>, text:string,
   *                  color:string, width:number}>}
   */
  function all() {
    return _clone(s.notes);
  }

  /**
   * Replace every note with the ones in a saved project.
   *
   * Anything that is not a usable record is dropped rather than refused: a
   * project restores for its territories, and a note that failed to parse is
   * not a reason to lose them.
   */
  function restore(list) {
    s.notes = (Array.isArray(list) ? list : []).map(_sanitize).filter(Boolean);
    _undo = [];
    _redo = [];
    _render();
    // refresh() rather than _changed(): the list on screen is now what the
    // store already holds, so marking the session dirty would queue a write
    // of what was just read. The toolbar still has to be told, because
    // whether there is anything to clear has just changed.
    App.controls.refresh();
  }

  /** Drop every note. Used by resetAll() and by the import of a new project. */
  function clear() {
    if (!s.notes.length) return;
    _remember();
    s.notes = [];
    _render();
    _changed();
  }

  /**
   * One record, or null when the value cannot be one.
   *
   * Coordinates are checked rather than trusted because this is the seam a
   * file arrives through: a note with a NaN in it draws nothing on the map and
   * an empty rectangle on a card, both of which look like the note was lost
   * rather than like the file was wrong.
   */
  function _sanitize(raw) {
    if (!raw || KINDS.indexOf(raw.kind) < 0) return null;
    var points = (Array.isArray(raw.points) ? raw.points : [])
      .filter(function (point) {
        return (
          Array.isArray(point) &&
          isFinite(point[0]) &&
          isFinite(point[1]) &&
          Math.abs(point[1]) <= 90
        );
      })
      .map(function (point) {
        return [point[0], point[1]];
      });
    if (!points.length) return null;
    if (raw.kind === "line" && points.length < 2) return null;

    return {
      kind: raw.kind,
      points: raw.kind === "line" ? points : points.slice(0, 1),
      text: typeof raw.text === "string" ? raw.text : "",
      color: /^#[0-9a-f]{6}$/i.test(raw.color) ? raw.color : _pen.color,
      width: isFinite(raw.width) ? Math.min(20, Math.max(0.5, raw.width)) : 2,
    };
  }

  function _clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  /** What every mutation owes the rest of the app. */
  function _changed() {
    App.session.markDirty();
    App.controls.refresh();
    _sync();
  }

  // UNDO
  //
  // Snapshots of the whole list rather than a log of operations. A note list
  // is a few kilobytes at the outside, and every gesture here - adding,
  // editing the text, recoloring, deleting - is one snapshot rather than four
  // kinds of inverse operation to keep in step with the four kinds of edit.

  function _remember() {
    _undo.push(_clone(s.notes));
    if (_undo.length > MAX) _undo.shift();
    _redo = [];
  }

  function _swap(from, to) {
    if (!from.length) return;
    to.push(_clone(s.notes));
    s.notes = from.pop();
    _render();
    _changed();
  }

  var NOTES_SCOPE = {
    id: "notes",
    undo: function () {
      _swap(_undo, _redo);
    },
    redo: function () {
      _swap(_redo, _undo);
    },
    canUndo: function () {
      return _undo.length > 0;
    },
    canRedo: function () {
      return _redo.length > 0;
    },
    undoDepth: function () {
      return _undo.length;
    },
    redoDepth: function () {
      return _redo.length;
    },
    undoKey: "toolbar.undoNote",
    redoKey: "toolbar.redoNote",
  };

  // THE LAYER

  /**
   * Rebuild every layer from the records.
   *
   * Wholesale rather than patched. There are tens of notes, not thousands, and
   * a patching renderer is where "the map still shows a note that was deleted"
   * comes from - which for an annotation is the one failure that matters,
   * since nothing else on the map contradicts it.
   */
  function _render() {
    var group = s.notesLayerGroup;
    if (!group) return;
    group.clearLayers();
    s.notes.forEach(function (note) {
      group.addLayer(_layerFor(note));
    });
  }

  function _layerFor(note) {
    var layer = note.kind === "line" ? _lineLayer(note) : _markerLayer(note);

    layer.on("contextmenu", function (e) {
      L.DomEvent.stopPropagation(e);
      _showNoteMenu(e.containerPoint, note);
    });
    // Left-click opens the same editor the menu's first entry does. A note is
    // a piece of text somebody wrote, and the thing you do to a piece of text
    // is read it and change it - so it is worth the one gesture everybody
    // tries first.
    layer.on("click", function (e) {
      L.DomEvent.stopPropagation(e);
      _openEditor(note);
    });
    return layer;
  }

  function _lineLayer(note) {
    return L.polyline(
      note.points.map(function (point) {
        return [point[1], point[0]];
      }),
      {
        pane: "notesPane",
        color: note.color,
        weight: Math.max(2, note.width * 1.5),
        opacity: 0.9,
        lineCap: "round",
        lineJoin: "round",
      },
    ).bindTooltip(note.text || T("notes.kindMark"), { sticky: true });
  }

  /**
   * A note or a pin, as a glyph on the map.
   *
   * The two differ in where the icon sits and in whether the label is on
   * screen the whole time. A pin points at a doorway, so its tip is the
   * coordinate and its label - which is often just a house number - waits for
   * a hover. A note *is* its label, so hiding it behind a hover would leave a
   * map of identical glyphs nobody can read without pointing at each one.
   *
   * The glyph comes from TOOL_ICONS rather than from a pair written out here,
   * so a note is drawn with the same icon its tool is labelled with.
   */
  function _markerLayer(note) {
    if (note.kind === "text") return _captionLayer(note);

    var pin = note.kind === "pin";
    var size = pin ? 28 : 24;
    var icon = L.divIcon({
      className: "note-marker" + (pin ? " note-marker--pin" : ""),
      html:
        '<i class="fa-solid ' +
        TOOL_ICONS[note.kind] +
        '" style="color:' +
        _cssColor(note.color) +
        '"></i>',
      iconSize: [size, size],
      iconAnchor: pin ? [size / 2, size] : [size / 2, size / 2],
    });

    var marker = L.marker([note.points[0][1], note.points[0][0]], {
      icon: icon,
      pane: "notesPane",
      // Off, and not merely undocumented: Leaflet makes a marker draggable
      // with one option, and a note that moves when you meant to click it is a
      // silent edit to something whose whole value is that it stays where it
      // was put. Moving one is a delete and a new note.
      draggable: false,
      keyboard: false,
    });

    if (note.text) {
      marker.bindTooltip(note.text, {
        permanent: !pin,
        direction: "right",
        className: "note-tooltip",
        opacity: 0.95,
      });
    }
    return marker;
  }

  /**
   * A caption: the words on the ground, with nothing marking the spot.
   *
   * Centred on its point by the transform on .note-caption rather than by an
   * iconAnchor, because the box is as wide as whatever was typed and Leaflet
   * needs a size up front to compute an anchor from.
   */
  function _captionLayer(note) {
    return L.marker([note.points[0][1], note.points[0][0]], {
      icon: L.divIcon({
        className: "note-caption",
        iconSize: null,
        html:
          '<span style="color:' +
          _cssColor(note.color) +
          '">' +
          _escapeHtml(note.text) +
          "</span>",
      }),
      pane: "notesPane",
      keyboard: false,
    });
  }

  /** A color safe to interpolate into markup, or the pen's default. */
  function _cssColor(value) {
    return /^#[0-9a-f]{6}$/i.test(value) ? value : "#d40000";
  }

  /**
   * Text safe to interpolate into markup.
   *
   * A caption is drawn through L.divIcon, which takes a string of HTML and no
   * other kind of content, so this is the one place in the app where something
   * somebody typed is turned into markup rather than into a text node.
   */
  function _escapeHtml(value) {
    return String(value == null ? "" : value).replace(
      /[&<>"']/g,
      function (character) {
        return HTML_ESCAPES[character];
      },
    );
  }

  var HTML_ESCAPES = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };

  // VISIBILITY

  function isVisible() {
    return _visible;
  }

  function setVisible(on) {
    _visible = !!on;
    var group = s.notesLayerGroup;
    if (!group || !s.leafletMap) return;
    if (_visible) s.leafletMap.addLayer(group);
    else s.leafletMap.removeLayer(group);
  }

  // MODE

  /**
   * Enter or leave note taking.
   *
   * Like every other modal tool here, entering closes whichever one currently
   * holds the map: they all take over the click, and two of them sharing it
   * means a click that cuts a territory and drops a pin on the cut.
   */
  function toggle() {
    var next = !s.noteMode;

    if (next) {
      if (s.editMode) App.editing.toggleEditMode();
      if (s.mergeMode) App.editing.toggleMergeMode();
      if (s.trimMode) App.trim.toggle();
      if (s.outlineMode) App.outline.toggle();
      if (s.leafletMap.editTools) s.leafletMap.editTools.stopDrawing();
    }

    s.noteMode = next;
    App.controls.refresh();

    if (next) _start();
    else _stop();
  }

  function _start() {
    // Notes are drawn on top of the map, so a switched-off note layer would
    // make the tool look broken: click, nothing appears, click again.
    if (!_visible) setVisible(true);
    N.build();

    var map = s.leafletMap;
    map.on("click", _onMapClick);
    map.on("dblclick", _onMapDblClick);
    // The gesture that ends a line would otherwise also zoom the map, which
    // moves the ground out from under the mark that was just finished.
    map.doubleClickZoom.disable();
    L.DomEvent.on(map.getContainer(), "pointerdown", _onPointerDown);
    L.DomEvent.on(map.getContainer(), "pointermove", _onPointerMove);
    L.DomEvent.on(map.getContainer(), "pointerup", _onPointerUp);
    L.DomEvent.on(map.getContainer(), "pointercancel", _onPointerCancel);
    L.DomEvent.on(map.getContainer(), "mousedown", _onRightPanDown);
    L.DomUtil.addClass(map.getContainer(), "is-annotating");

    // The pointer is a pen now: a territory tooltip chasing it covers the
    // ground being aimed at, which is the same reason the outline editor turns
    // them off.
    App.polygons.setTooltipMode("off");
    App.polygons.clearHover();

    _snapDot = L.circleMarker([0, 0], {
      pane: "notesPane",
      radius: 5,
      color: "#e74c3c",
      fillColor: "#fff",
      fillOpacity: 1,
      weight: 2,
      interactive: false,
    });

    _hint = D.mountOnMap("tpl-notes-hint", s.leafletMap);
    _showToolbar();
    App.shortcuts.push(NOTES_KEYS);
    App.history.pushScope(NOTES_SCOPE);
    _setTool(_tool);
    _sync();
  }

  function _stop() {
    var map = s.leafletMap;
    _discardDraft();
    map.off("click", _onMapClick);
    map.off("dblclick", _onMapDblClick);
    map.doubleClickZoom.enable();
    L.DomEvent.off(map.getContainer(), "pointerdown", _onPointerDown);
    L.DomEvent.off(map.getContainer(), "pointermove", _onPointerMove);
    L.DomEvent.off(map.getContainer(), "pointerup", _onPointerUp);
    L.DomEvent.off(map.getContainer(), "pointercancel", _onPointerCancel);
    L.DomEvent.off(map.getContainer(), "mousedown", _onRightPanDown);
    _endRightPan();
    L.DomUtil.removeClass(map.getContainer(), "is-annotating");
    if (map.dragging) map.dragging.enable();

    _hint = D.remove(_hint);
    _toolbar = D.remove(_toolbar);
    App.shortcuts.pop("notes");
    App.history.popScope("notes");
    App.ui.closeContextMenu();
    App.polygons.setTooltipMode(s.mergeMode ? "anchored" : "full");
    _snapDot = null;
    _press = null;
    _undo = [];
    _redo = [];
  }

  /**
   * Choose the tool the next gesture uses.
   *
   * Map dragging is the one thing that has to move with it: a freehand stroke
   * is a drag, so while the draw tool is selected the left button belongs to
   * the pen and the map is panned with the right one instead - the same
   * bargain the cut tool makes, for the same reason. The other two tools leave
   * panning alone, which is what makes a note on the far side of town two
   * gestures rather than a mode change.
   */
  function _setTool(tool) {
    if (TOOLS.indexOf(tool) < 0) return;
    if (_draft && tool !== _tool) _discardDraft();
    _tool = tool;

    var map = s.leafletMap;
    if (map && map.dragging) {
      if (tool === "draw") map.dragging.disable();
      else map.dragging.enable();
    }
    if (_hint) {
      _hint.setAttribute("data-i18n", _hintKey());
      _hint.textContent = T(_hintKey());
    }
    _sync();
  }

  function _hintKey() {
    return "notes.hint" + _tool.charAt(0).toUpperCase() + _tool.slice(1);
  }

  /** The snap switch, which only the draw tool consults. */
  function _setSnap(on) {
    s.noteSnap = !!on;
    if (!s.noteSnap) _hideSnapDot();
    // A vertex already placed keeps whether it snapped, so the routing of the
    // hops between the ones that did is what changes under this switch.
    _syncDraft();
    _sync();
  }

  // DRAWING

  /**
   * Where a note or a pin goes.
   *
   * The draw tool is not served from here: a click and a drag begin
   * identically, so which of the two happened is only known on release, and
   * the pointer handlers below are what know it.
   *
   * A click that landed on an existing note never arrives here at all - the
   * layer stops it and opens that note's editor instead.
   */
  function _onMapClick(e) {
    if (!s.noteMode || _tool === "draw") return;
    _createPoint(e.latlng);
  }

  /** Close a line on the double-click that ended it. */
  function _onMapDblClick(e) {
    if (!s.noteMode || _tool !== "draw" || !_draft) return;
    L.DomEvent.stopPropagation(e);
    L.DomEvent.preventDefault(e);

    var now = Date.now();
    var popped = 0;
    while (
      popped < 2 &&
      _draft.times.length &&
      now - _draft.times[_draft.times.length - 1] < DBLCLICK_MS
    ) {
      _draft.points.pop();
      _draft.snapped.pop();
      _draft.times.pop();
      popped++;
    }

    _addVertex(e.latlng);
    finishLine();
  }

  /** One clicked vertex, pulled onto the street network if snapping is on. */
  function _addVertex(latlng) {
    var hit = _snap(latlng);
    _pushPoint(hit, hit.snapped);
  }

  /**
   * Add one point to the draft and redraw it.
   *
   * The three arrays are parallel and are kept that way here rather than at
   * each of the three places a point comes from. `snapped` decides which hops
   * the street tool may route, and `times` is what the double-click reaches
   * back through - both indexed by point, and both silently wrong the moment
   * one caller pushes to two of the three.
   *
   * @param {{lat:number, lng:number}} at
   */
  function _pushPoint(at, snapped) {
    _draft.points.push([at.lng, at.lat]);
    _draft.snapped.push(!!snapped);
    _draft.times.push(Date.now());
    _syncDraft();
  }

  /**
   * The left button goes down, and it is not yet known what for.
   *
   * Bound on the container rather than on the map, because Leaflet's own mouse
   * events are click-shaped - it reports a drag as a move of the map, which is
   * exactly what has been disabled for this tool - and because a pointer event
   * covers a finger and a stylus with the same code.
   */
  function _onPointerDown(e) {
    if (!s.noteMode || _tool !== "draw") return;
    if (e.button !== undefined && e.button !== 0) return;
    // A press that starts on a note is that note's click, not a new stroke
    // beginning underneath it.
    if (_overOwnLayer(e.target)) return;
    e.preventDefault();
    _press = { x: e.clientX, y: e.clientY, moved: false, opened: !_draft };
  }

  function _onPointerMove(e) {
    if (!s.noteMode || _tool !== "draw") return;

    if (_press) {
      // Below the threshold the press is still a click waiting to happen: a
      // pointer travels a pixel or two under any finger, and treating that as
      // a sweep would leave a two-point scribble everywhere somebody clicked.
      if (!_press.moved && !_travelled(e)) return;
      _press.moved = true;
      _startDraft();
      var at = s.leafletMap.mouseEventToLatLng(e);
      if (_farEnough(at)) _pushPoint(at, false);
      return;
    }

    // With no button down there is no stroke, but there is a magnet, and a dot
    // under the cursor is the only thing that says where the next click will
    // actually land.
    _moveSnapDot(e);
  }

  function _onPointerUp(e) {
    if (!_press) return;
    var press = _press;
    _press = null;
    if (!s.noteMode || _tool !== "draw") return;

    if (!press.moved) {
      _startDraft();
      _addVertex(s.leafletMap.mouseEventToLatLng(e));
      return;
    }

    // A sweep that began on empty ground is one whole mark, and letting go
    // ends it. A sweep added to a line that was already being clicked out only
    // extends it, so that line stays open for the next point.
    if (press.opened) finishLine();
  }

  /**
   * The gesture was taken away rather than finished - a touch the browser
   * decided was a scroll, a window that lost the pointer.
   *
   * Not routed through _onPointerUp, which would read the abandoned press as a
   * click and place a vertex wherever the pointer happened to be. A stroke
   * already begun is kept: it is a line somebody drew, and Escape is how a
   * line is thrown away.
   */
  function _onPointerCancel() {
    _press = null;
  }

  /** Whether the press has travelled far enough to be a sweep. */
  function _travelled(e) {
    return (
      Math.abs(e.clientX - _press.x) > DRAG_PX ||
      Math.abs(e.clientY - _press.y) > DRAG_PX
    );
  }

  /** Show where the next click would land, or nothing when nothing is pulling. */
  function _moveSnapDot(e) {
    if (!_snapDot || !s.noteSnap) return;
    var hit = _snap(s.leafletMap.mouseEventToLatLng(e));
    if (!hit.snapped) {
      _hideSnapDot();
      return;
    }
    _snapDot.setLatLng([hit.lat, hit.lng]);
    if (!s.leafletMap.hasLayer(_snapDot)) _snapDot.addTo(s.leafletMap);
  }

  function _hideSnapDot() {
    if (_snapDot && s.leafletMap.hasLayer(_snapDot))
      s.leafletMap.removeLayer(_snapDot);
  }

  // THE RIGHT BUTTON
  //
  // The draw tool has the left one, so the map is panned with the right, and a
  // right button that was pressed and released without travelling still means
  // "menu" the way it does everywhere else in the app. The same arrangement
  // the cut tool makes, and for the same reason.

  function _onRightPanDown(e) {
    if (!s.noteMode || _tool !== "draw" || e.button !== 2) return;
    // Without this the browser starts a selection drag, and on the platforms
    // that raise the context menu on mousedown, raises it mid-pan. It also
    // suppresses Leaflet's own contextmenu event, which is what would
    // otherwise open the menu on top of the pan.
    L.DomEvent.preventDefault(e);
    _rightPan = { x: e.clientX, y: e.clientY, moved: false };
    L.DomUtil.addClass(s.leafletMap.getContainer(), "is-right-panning");
    // The button may well be released outside the map, so the rest of the
    // gesture is followed on the document.
    L.DomEvent.on(document, "mousemove", _onRightPanMove);
    L.DomEvent.on(document, "mouseup", _onRightPanUp);
  }

  function _onRightPanMove(e) {
    if (!_rightPan) return;
    // The ground follows the pointer, so the view moves the opposite way.
    var dx = _rightPan.x - e.clientX;
    var dy = _rightPan.y - e.clientY;
    if (!dx && !dy) return;
    _rightPan.x = e.clientX;
    _rightPan.y = e.clientY;
    _rightPan.moved = true;
    s.leafletMap.panBy([dx, dy], { animate: false });
  }

  function _onRightPanUp(e) {
    if (!_rightPan || e.button !== 2) return;
    var moved = _rightPan.moved;
    _endRightPan();
    if (!s.noteMode) return;
    if (moved) _moveSnapDot(e);
    else handleContextMenu(s.leafletMap.mouseEventToContainerPoint(e));
  }

  function _endRightPan() {
    if (!_rightPan) return;
    _rightPan = null;
    L.DomEvent.off(document, "mousemove", _onRightPanMove);
    L.DomEvent.off(document, "mouseup", _onRightPanUp);
    L.DomUtil.removeClass(s.leafletMap.getContainer(), "is-right-panning");
  }

  /**
   * Whether the pointer went down on something this module drew.
   *
   * The freehand tool swallows the press before Leaflet turns it into a click,
   * so without this a stroke that starts on an existing note replaces that
   * note's own click - and the editor becomes unreachable in the one tool
   * where the pointer is most likely to be over one.
   */
  function _overOwnLayer(target) {
    var node = target;
    while (node && node !== document.body) {
      if (node.classList && node.classList.contains("note-marker")) return true;
      node = node.parentNode;
    }
    return false;
  }

  /** Points closer together than this are the same point at this zoom. */
  var FREEHAND_MIN_PX = 3;

  /** Travel below this leaves a press a click rather than a sweep. */
  var DRAG_PX = 4;

  function _farEnough(latlng) {
    var points = _draft.points;
    if (!points.length) return true;
    var last = points[points.length - 1];
    var map = s.leafletMap;
    return (
      map.latLngToContainerPoint(latlng).distanceTo(
        map.latLngToContainerPoint(L.latLng(last[1], last[0])),
      ) >= FREEHAND_MIN_PX
    );
  }

  function _startDraft() {
    if (_draft) return;
    _draft = { points: [], snapped: [], times: [] };
    _preview = L.polyline([], {
      pane: "notesPane",
      color: _pen.color,
      weight: Math.max(2, _pen.width * 1.5),
      opacity: 0.75,
      dashArray: "6 4",
      interactive: false,
    }).addTo(s.leafletMap);
  }

  function _discardDraft() {
    if (_preview) s.leafletMap.removeLayer(_preview);
    _hideSnapDot();
    _preview = null;
    _draft = null;
    _sync();
  }

  /** Redraw the line being drawn, routed where the street tool asked for it. */
  function _syncDraft() {
    if (!_draft || !_preview) return;
    _preview.setLatLngs(
      _geometry().map(function (point) {
        return [point[1], point[0]];
      }),
    );
    _sync();
  }

  /**
   * The draft's full geometry: the clicked points, with street paths inserted
   * between the pairs that earned one.
   */
  function _geometry() {
    if (!_draft) return [];

    var out = [_draft.points[0]];
    for (var i = 0; i + 1 < _draft.points.length; i++) {
      var path = _route(i);
      if (path) {
        for (var j = 1; j < path.length - 1; j++)
          out.push([path[j].lng, path[j].lat]);
      }
      out.push(_draft.points[i + 1]);
    }
    return out;
  }

  /**
   * The street path between two clicked vertices, or null for a straight line.
   *
   * The rule is the cut tool's, for the reason the cut tool has it: a vertex
   * placed by hand is a statement about where the mark goes, so only a pair
   * that both landed on the network is routed, and only when the detour is
   * small enough that the drawn line is recognizably the one that was asked
   * for. The difference here is that the mark does not have to separate
   * anything, so there is no extension out to a boundary.
   */
  function _route(index) {
    if (!_draft.snapped[index] || !_draft.snapped[index + 1]) return null;

    var radius = _snapRadius();
    var a = _draft.points[index];
    var b = _draft.points[index + 1];
    var from = N.nearestNodeAt(L.latLng(a[1], a[0]), radius);
    var to = N.nearestNodeAt(L.latLng(b[1], b[0]), radius);
    if (!from || !to) return null;

    var path = N.route(from.key, to.key);
    if (!path || path.length < 2) return null;

    var routed = N.pathLength(path);
    var straight = L.latLng(a[1], a[0]).distanceTo(L.latLng(b[1], b[0]));
    if (routed > straight * s.CUT_ROUTE_MAX_DETOUR) return null;
    if (routed - straight > s.CUT_ROUTE_MAX_EXTRA_M) return null;
    return path;
  }

  function _snapRadius() {
    return N.pixelRadiusM(s.CUT_SNAP_PX, s.CUT_SNAP_MAX_M);
  }

  /**
   * Pull a click onto the street network.
   *
   * Intersections win ties against the middle of a road for the same reason
   * they do in the cut tool: landing on a junction is nearly always what was
   * meant, and it gives the router a node to start from rather than a point
   * beside one.
   *
   * @returns {{lat:number, lng:number, snapped:boolean}}
   */
  function _snap(latlng) {
    if (!s.noteSnap) return { lat: latlng.lat, lng: latlng.lng, snapped: false };

    var radius = _snapRadius();
    var coord = [latlng.lng, latlng.lat];
    var node = N.nearestNode(coord, radius);
    var seg = N.nearestSegmentPoint(coord, radius);
    var hit = null;

    if (node && (!seg || node.dist * s.CUT_NODE_BONUS <= seg.dist)) hit = node;
    else if (seg) hit = seg;

    if (!hit) return { lat: latlng.lat, lng: latlng.lng, snapped: false };
    return { lat: hit.coord[1], lng: hit.coord[0], snapped: true };
  }

  // CREATING

  function _createPoint(latlng) {
    var kind = _tool;
    _askText(TITLE_KEYS[kind], "", function (text) {
      // A pin is a place, and a place with no label is still a place. A note
      // and a caption are their words, so an empty one is one that was
      // thought better of.
      if (!text && kind !== "pin") return;
      _add({ kind: kind, points: [[latlng.lng, latlng.lat]], text: text });
    });
  }

  /**
   * Close the line being drawn and store it, routed geometry and all.
   *
   * Every way a line ends comes through here: the button, Enter, the
   * double-click that closes a street line, and letting go of a freehand
   * stroke. What is stored is the drawn geometry rather than the clicked
   * points, so a mark that followed the streets keeps the shape it had on
   * screen.
   */
  function finishLine() {
    if (!_draft) return;
    var geometry = _geometry();
    _discardDraft();
    // One point is not a line - a tap rather than a sweep, or a double-click
    // on empty ground. Storing it would put an invisible annotation on the
    // card and an unclickable one on the map.
    if (geometry.length < 2) return;

    // Stored first, then opened for its label - rather than asked for the
    // label and stored on the answer. Both put the same dialog on screen, and
    // this way round the mark survives a dialog that is dismissed: the line is
    // the work, and the words are a remark about it.
    //
    // Asked at all, rather than left to the menu on the mark, because a mark
    // with no words reaches a PDF as a comment with nothing in it - which is
    // the one outcome that reads as the feature being broken.
    _openEditor(_add({ kind: "line", points: geometry, text: "" }));
  }

  /** Take back the last vertex of a street line still being drawn. */
  function popVertex() {
    if (!_draft || !_draft.points.length) return;
    _draft.points.pop();
    _draft.snapped.pop();
    _draft.times.pop();
    if (!_draft.points.length) _discardDraft();
    else _syncDraft();
  }

  /** @returns {Object} the sanitized record now in the list, not the argument. */
  function _add(record) {
    _remember();
    var stored = _sanitize({
      kind: record.kind,
      points: record.points,
      text: record.text,
      color: _pen.color,
      width: _pen.width,
    });
    s.notes.push(stored);
    _render();
    _changed();
    return stored;
  }

  function _remove(note) {
    var index = s.notes.indexOf(note);
    if (index < 0) return;
    _remember();
    s.notes.splice(index, 1);
    _render();
    _changed();
  }

  // EDITING

  /**
   * The text dialog, used for a new note and for an existing one alike.
   *
   * @param {string} titleKey
   * @param {string} value what the field starts with
   * @param {function(string): void} onSave run with the trimmed text; not run
   *   at all when the dialog is dismissed, so a cancelled edit leaves the note
   *   exactly as it was
   */
  function _askText(titleKey, value, onSave) {
    var dialog = App.ui.openDialog("tpl-note-dialog", function () {
      App.shortcuts.pop("note-text");
    });
    D.text(dialog, "title", T(titleKey));

    var field = D.role(dialog, "text");
    field.value = value || "";

    function save() {
      var text = field.value.trim();
      App.ui.closeDialog();
      onSave(text);
    }

    D.onRole(dialog, "save", save);
    D.onRole(dialog, "cancel", function () {
      App.ui.closeDialog();
    });

    // Ctrl/Cmd+Enter saves and Escape cancels, both while the field has focus,
    // which is where the cursor is for the whole life of this dialog - hence
    // whileTyping on each. Enter alone is left to the textarea, where it is
    // the second line of a note rather than the end of one.
    App.shortcuts.push({
      id: "note-text",
      titleKey: "shortcuts.groupNoteText",
      exclusive: true,
      entries: [
        {
          combos: ["Mod+Enter"],
          labelKey: "shortcuts.noteTextSave",
          whileTyping: true,
          run: save,
        },
        {
          combos: ["Escape"],
          labelKey: "shortcuts.noteTextCancel",
          whileTyping: true,
          run: App.ui.closeDialog,
        },
      ],
    });

    field.focus();
    field.select();
  }

  function _openEditor(note) {
    _askText(TITLE_KEYS[note.kind], note.text, function (text) {
      if (text === note.text) return;
      _remember();
      note.text = text;
      _render();
      _changed();
    });
  }

  // MENUS

  /**
   * The menu on one note.
   *
   * Recoloring is here rather than on the toolbar because the pen's color is
   * about the next note; this is about the one already on the map, and a
   * control that meant both would silently repaint whatever was last clicked.
   */
  function _showNoteMenu(point, note) {
    App.ui.showContextMenu(point, [
      {
        labelKey: "notes.menuEdit",
        icon: "fa-pen",
        onClick: function () {
          _openEditor(note);
        },
      },
      {
        labelKey: "notes.menuRecolor",
        icon: "fa-palette",
        disabled: note.color === _pen.color && note.width === _pen.width,
        onClick: function () {
          _remember();
          note.color = _pen.color;
          note.width = _pen.width;
          _render();
          _changed();
        },
      },
      { separator: true },
      {
        labelKey: "notes.menuDelete",
        icon: "fa-trash",
        danger: true,
        onClick: function () {
          _remove(note);
        },
      },
    ]);
  }

  /**
   * The menu on bare map while the tool is running.
   *
   * Routed here from main.js and from the territory layers, so that in this
   * mode a right-click anywhere answers with the tools rather than with the
   * menu of whatever happens to be underneath - which in note mode is never
   * the subject.
   */
  function handleContextMenu(point) {
    var items = TOOLS.map(function (tool) {
      return {
        labelKey: "notes.tool" + tool.charAt(0).toUpperCase() + tool.slice(1),
        icon: TOOL_ICONS[tool],
        checked: tool === _tool,
        onClick: function () {
          _setTool(tool);
        },
      };
    });

    items.push({ separator: true });
    items.push({
      labelKey: "notes.snap",
      icon: s.noteSnap ? "fa-square-check" : "fa-square",
      checked: !!s.noteSnap,
      onClick: function () {
        _setSnap(!s.noteSnap);
      },
    });
    if (_draft) {
      items.push({
        labelKey: "notes.finish",
        icon: "fa-check",
        disabled: _draft.points.length < 2,
        onClick: finishLine,
      });
    }
    items.push({
      labelKey: "notes.done",
      icon: "fa-xmark",
      onClick: toggle,
    });
    return App.ui.showContextMenu(point, items);
  }

  // SHORTCUTS

  var NOTES_KEYS = {
    id: "notes",
    titleKey: "shortcuts.groupNotes",
    entries: [
      {
        combos: ["1"],
        labelKey: "shortcuts.noteToolNote",
        run: function () {
          _setTool("note");
        },
      },
      {
        combos: ["2"],
        labelKey: "shortcuts.noteToolPin",
        run: function () {
          _setTool("pin");
        },
      },
      {
        combos: ["3"],
        labelKey: "shortcuts.noteToolDraw",
        run: function () {
          _setTool("draw");
        },
      },
      {
        combos: ["4"],
        labelKey: "shortcuts.noteToolText",
        run: function () {
          _setTool("text");
        },
      },
      {
        combos: ["S"],
        labelKey: "shortcuts.noteSnap",
        run: function () {
          _setSnap(!s.noteSnap);
        },
      },
      {
        combos: ["Enter"],
        labelKey: "shortcuts.noteFinish",
        when: function () {
          return !!_draft && _draft.points.length >= 2;
        },
        run: finishLine,
      },
      {
        combos: ["Backspace", "Delete"],
        labelKey: "shortcuts.noteBack",
        when: function () {
          return !!_draft && _draft.points.length > 0;
        },
        run: popVertex,
      },
      {
        // Escape backs out one step at a time rather than closing the tool
        // from under a half-drawn line, which is the same courtesy the cut
        // tool extends to a half-drawn cut.
        combos: ["Escape"],
        labelKey: "shortcuts.noteCancel",
        run: function () {
          if (_draft) _discardDraft();
          else toggle();
        },
      },
      { combos: ["Drag"], labelKey: "shortcuts.noteDrag", note: true },
      { combos: ["Click"], labelKey: "shortcuts.noteClick", note: true },
      { combos: ["Right-drag"], labelKey: "shortcuts.panRight", note: true },
    ],
  };

  // TOOLBAR

  function _showToolbar() {
    _toolbar = D.mountOnMap("tpl-notes-toolbar", s.leafletMap);

    TOOLS.forEach(function (tool) {
      D.onRole(_toolbar, "tool-" + tool, function () {
        _setTool(tool);
      });
    });

    var color = D.role(_toolbar, "color");
    color.value = _pen.color;
    color.addEventListener("input", function () {
      _pen.color = color.value;
      _savePen();
      if (_preview) _preview.setStyle({ color: _pen.color });
      _sync();
    });

    var width = D.role(_toolbar, "width");
    width.value = String(_pen.width);
    width.addEventListener("input", function () {
      _pen.width = parseFloat(width.value);
      _savePen();
      if (_preview)
        _preview.setStyle({ weight: Math.max(2, _pen.width * 1.5) });
      _sync();
    });

    var snap = D.role(_toolbar, "snap");
    snap.checked = !!s.noteSnap;
    snap.addEventListener("change", function () {
      _setSnap(snap.checked);
    });

    D.onRole(_toolbar, "finish", finishLine);
    D.onRole(_toolbar, "undo", NOTES_SCOPE.undo);
    D.onRole(_toolbar, "redo", NOTES_SCOPE.redo);
    D.onRole(_toolbar, "done", toggle);
  }

  function _savePen() {
    App.util.writeJson(PEN_KEY, _pen);
  }

  /** Repaint whatever the toolbar says about the state it is not holding. */
  function _sync() {
    if (!_toolbar) return;

    TOOLS.forEach(function (tool) {
      D.toggleClass(
        D.role(_toolbar, "tool-" + tool),
        "is-active",
        tool === _tool,
      );
    });

    // Greyed rather than hidden while a pen that ignores it is selected. The
    // switch is the draw tool's alone, but a row that comes and goes changes
    // the height of a bar somebody is aiming at, and a control that vanishes
    // teaches nothing about what it was for - which is the same trade every
    // disabled tile in the toolbar makes.
    D.toggleClass(D.role(_toolbar, "snap-row"), "is-disabled", _tool !== "draw");
    var snap = D.role(_toolbar, "snap");
    snap.checked = !!s.noteSnap;
    snap.disabled = _tool !== "draw";

    D.text(_toolbar, "count", T("notes.count", { count: s.notes.length }));
    D.text(
      _toolbar,
      "width-out",
      T("notes.widthValue", { value: App.i18n.n(_pen.width) }),
    );

    var drawing = !!_draft && _draft.points.length > 0;
    D.toggleRole(_toolbar, "finish", drawing);
    D.toggleClass(
      D.role(_toolbar, "finish"),
      "is-disabled",
      !drawing || _draft.points.length < 2,
    );
    D.text(
      _toolbar,
      "status",
      drawing ? T("notes.vertices", { count: _draft.points.length }) : "",
    );

    D.toggleClass(D.role(_toolbar, "undo"), "is-disabled", !_undo.length);
    D.toggleClass(D.role(_toolbar, "redo"), "is-disabled", !_redo.length);
  }

  return {
    init: init,
    toggle: toggle,
    handleContextMenu: handleContextMenu,
    count: count,
    all: all,
    restore: restore,
    clear: clear,
    isVisible: isVisible,
    setVisible: setVisible,
    // Out for the tests: the record filter is the seam a saved project comes
    // in through, and a note it wrongly accepts is one that draws nothing and
    // says nothing about why.
    _sanitize: _sanitize,
  };
})();

window.App = App;
