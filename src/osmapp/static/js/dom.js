/**
 * dom.js — the only place in the app allowed to touch templates.
 *
 * Everything that used to be an HTML string (`innerHTML = '<div style=…>'`)
 * now lives in a <template> in index.html and is cloned through render().
 * Look-ups go through data-role attributes so markup can be restyled or
 * reordered without touching JS.
 */
var App = window.App || {};

App.dom = (function () {
  "use strict";

  var _cache = {};

  /** Clone a <template> by id and return its single root element. */
  function render(templateId) {
    var tpl = _cache[templateId] || document.getElementById(templateId);
    if (!tpl) throw new Error("Missing template: #" + templateId);
    _cache[templateId] = tpl;
    var node = tpl.content.firstElementChild.cloneNode(true);
    if (!node) throw new Error("Empty template: #" + templateId);
    // Templates carry data-i18n markers; translating here means no module has
    // to remember to do it after mounting.
    if (App.i18n) App.i18n.apply(node);
    return node;
  }

  /** Clone a template and append it to `parent`. */
  function mount(templateId, parent) {
    var node = render(templateId);
    parent.appendChild(node);
    return node;
  }

  /** First descendant (or self) carrying data-role="name". */
  function role(root, name) {
    if (root.dataset && root.dataset.role === name) return root;
    return root.querySelector('[data-role="' + name + '"]');
  }

  /** Set textContent on a data-role node, tolerating a missing node. */
  function text(root, name, value) {
    var node = role(root, name);
    if (node) node.textContent = value == null ? "" : String(value);
    return node;
  }

  /** Show/hide via the `hidden` attribute (CSS enforces it with !important). */
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
   * Wire a click handler onto a data-role node, stopping Leaflet from
   * treating the click as a map interaction.
   */
  function onRole(root, name, handler) {
    var node = role(root, name);
    if (!node) return null;
    node.addEventListener("click", function (e) {
      e.preventDefault();
      e.stopPropagation();
      handler(e, node);
    });
    return node;
  }

  /**
   * The furniture that lives on the bottom edge of the map: the hint banner
   * and the four mode bars. Two things read this list — the stack they are
   * mounted into, and the .has-map-bar flag the info panel watches, since it
   * occupies the same edge and style.css hides it on a narrow window where
   * the two would otherwise land on the same pixels.
   */
  var BOTTOM_BARS =
    ".draw-hint,.cut-toolbar,.merge-toolbar,.trim-toolbar,.outline-toolbar";

  /**
   * Kept here rather than at the nine mount and unmount sites across
   * editing.js, trim.js, outline.js and main.js: every one of them already
   * goes through mountOnMap() and remove(), and a flag that four modules have
   * to remember to clear is a flag that stays set after the one path nobody
   * tested.
   */
  function _syncBottomBars() {
    if (!document.querySelector || !document.body || !document.body.classList)
      return;
    document.body.classList.toggle(
      "has-map-bar",
      !!document.querySelector(BOTTOM_BARS),
    );
  }

  /** Remove a node if it is still attached. */
  function remove(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
    _syncBottomBars();
    return null;
  }

  /**
   * Mount a template into the Leaflet map container and shield it from
   * map drag/scroll/click handlers. Returns the node.
   *
   * Bottom-edge furniture goes into the stack instead of straight into the
   * container, so the bar and the banner are laid out against each other
   * rather than each against the bottom of the map.
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
   * Made on first use and then left in place. Empty it has no children, so it
   * has no height and nothing to hit — cheaper than teardown bookkeeping in
   * remove(), which does not know a stack from any other parent.
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
