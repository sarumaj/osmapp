/**
 * dom.js — building UI out of the <template> elements in index.html.
 *
 * No module in this app writes HTML as a string. Every piece of interface —
 * toolbars, dialogs, context menus, map overlays — is declared as a
 * <template> in index.html and cloned from there through render() or one of
 * the mount functions below.
 *
 * Cloned nodes are addressed by `data-role` attributes rather than by class or
 * tag, so `role(node, "apply")` finds the apply button wherever it sits in the
 * markup. This is what lets a template be restyled, reordered or wrapped in
 * extra elements without any JavaScript needing to change, and it keeps the
 * class names free for the stylesheet alone.
 *
 * A typical caller does:
 *
 *     var bar = D.mountOnMap("tpl-trim-toolbar", s.leafletMap);
 *     D.onRole(bar, "apply", apply);
 *     D.text(bar, "count", "12 buildings");
 *     ...
 *     bar = D.remove(bar);
 */
var App = window.App || {};

App.dom = (function () {
  "use strict";

  var _cache = {};

  /**
   * Clone a <template> by id and return its single root element, translated.
   *
   * @param {string} templateId the id attribute of the <template>
   * @returns {Element} a detached clone the caller is expected to mount
   * @throws if no such template exists, or if it is empty — both are typos
   *   rather than runtime conditions, so they fail loudly
   */
  function render(templateId) {
    var tpl = _cache[templateId] || document.getElementById(templateId);
    if (!tpl) throw new Error("Missing template: #" + templateId);
    _cache[templateId] = tpl;
    var node = tpl.content.firstElementChild.cloneNode(true);
    if (!node) throw new Error("Empty template: #" + templateId);
    // Templates carry data-i18n markers naming the string each node should
    // show. Translating them here means no caller has to remember to do it,
    // and a node is never briefly visible in the wrong language.
    if (App.i18n) App.i18n.apply(node);
    return node;
  }

  /** Clone a template and append it to `parent`. @returns {Element} */
  function mount(templateId, parent) {
    var node = render(templateId);
    parent.appendChild(node);
    return node;
  }

  /**
   * Find the node carrying `data-role="name"`, checking `root` itself first.
   *
   * @param {Element} root usually a node returned by render() or a mount
   * @param {string} name the data-role value
   * @returns {Element|null} null when the template has no such role, which
   *   callers generally tolerate rather than treat as an error
   */
  function role(root, name) {
    if (root.dataset && root.dataset.role === name) return root;
    return root.querySelector('[data-role="' + name + '"]');
  }

  /**
   * Set the text of a data-role node, doing nothing if the role is absent.
   *
   * Uses textContent rather than innerHTML, so a place name or a street name
   * containing angle brackets is displayed instead of being parsed as markup.
   * A null or undefined value clears the node rather than printing "null".
   */
  function text(root, name, value) {
    var node = role(root, name);
    if (node) node.textContent = value == null ? "" : String(value);
    return node;
  }

  /**
   * Show or hide a node using the `hidden` attribute.
   *
   * The attribute rather than an inline `display` style, so that showing a
   * node again does not have to know which display mode it originally had.
   * style.css backs this with an `!important` rule, because the default
   * `[hidden] { display: none }` loses to any class-based display rule.
   */
  function toggle(node, visible) {
    if (!node) return node;
    if (visible) node.removeAttribute("hidden");
    else node.setAttribute("hidden", "");
    return node;
  }

  function toggleRole(root, name, visible) {
    return toggle(role(root, name), visible);
  }

  function toggleClass(node, cls, on) {
    if (node) node.classList.toggle(cls, !!on);
    return node;
  }

  /**
   * Attach a click handler to a data-role node.
   *
   * The event is stopped before the handler runs. Most of this UI is mounted
   * inside the Leaflet map container, where an unhandled click would also
   * register as a click on the map — which closes context menus, and in a
   * modal tool places a vertex. The handler receives the event and the node.
   *
   * The call is timed through App.util.timed, which reports only on a local
   * host: this is the seam nearly every button in the app passes through, so it
   * is the one worth measuring and the one that must stay silent in production.
   *
   * @returns {Element|null} the node, or null when the role is absent
   */
  function onRole(root, name, handler) {
    var node = role(root, name);
    if (!node) return null;
    node.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      App.util.timed("onRole " + name, function () {
        handler(e, node);
      });
    });
    return node;
  }

  /**
   * Selector matching everything that belongs on the bottom edge of the map:
   * the drawing hint banner and the toolbar of each modal tool.
   *
   * Two things consult this list. mountOnMap() uses it to divert such nodes
   * into a flex column instead of positioning each against the bottom of the
   * map, and _syncBottomBars() uses it to maintain the `has-map-bar` flag on
   * <body>. The info panel occupies the same edge, and style.css uses that
   * flag to hide the panel on a window too narrow for both.
   */
  var BOTTOM_BARS =
    ".draw-hint,.cut-toolbar,.merge-toolbar,.trim-toolbar,.outline-toolbar";

  /**
   * Set or clear the `has-map-bar` flag on <body> to match what is currently
   * mounted.
   *
   * Called from mountOnMap() and remove() rather than by the tools themselves.
   * Those two functions are the only ways furniture arrives on or leaves the
   * map, so doing it here means no tool can leave the flag set by exiting
   * through a path its author did not think about.
   */
  function _syncBottomBars() {
    if (!document.querySelector || !document.body || !document.body.classList)
      return;
    document.body.classList.toggle(
      "has-map-bar",
      !!document.querySelector(BOTTOM_BARS),
    );
  }

  /**
   * Detach a node if it is still in the document.
   *
   * @returns {null} always, so callers can write `_toolbar = D.remove(_toolbar)`
   *   and drop their reference in the same statement
   */
  function remove(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
    _syncBottomBars();
    return null;
  }

  /**
   * Clone a template into the Leaflet map container as an overlay.
   *
   * Clicks and wheel events on the node are stopped from reaching the map, so
   * scrolling a long menu does not zoom and dragging a slider does not pan.
   *
   * Anything matching BOTTOM_BARS is placed in the bottom stack rather than
   * directly in the container, so that a toolbar and the hint banner are laid
   * out one above the other instead of both being positioned against the
   * bottom edge and overlapping.
   *
   * @param {string} templateId
   * @param {L.Map} map
   * @returns {Element} the mounted node
   */
  function mountOnMap(templateId, map) {
    var node = render(templateId);
    var host = map.getContainer();
    if (node.matches && node.matches(BOTTOM_BARS)) host = _bottomStack(host);
    host.appendChild(node);
    if (window.L && L.DomEvent) {
      L.DomEvent.disableClickPropagation(node);
      L.DomEvent.disableScrollPropagation(node);
    }
    _syncBottomBars();
    return node;
  }

  /**
   * Return the flex column at the bottom of the map, creating it on first use.
   *
   * It is never removed again. With no children it has no height and receives
   * no pointer events, so leaving it costs nothing — whereas removing it would
   * require remove() to recognize an empty stack, which it cannot do, since it
   * is given a node and knows nothing about the parent it came from.
   */
  function _bottomStack(container) {
    var stack = container.querySelector(".map-bottom-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "map-bottom-stack";
      container.appendChild(stack);
    }
    return stack;
  }

  return {
    render: render,
    mount: mount,
    mountOnMap: mountOnMap,
    role: role,
    text: text,
    toggle: toggle,
    toggleRole: toggleRole,
    toggleClass: toggleClass,
    onRole: onRole,
    remove: remove,
  };
})();

window.App = App;
