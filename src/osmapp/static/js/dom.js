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

  /** Remove a node if it is still attached. */
  function remove(node) {
    if (node && node.parentNode) node.parentNode.removeChild(node);
    return null;
  }

  /**
   * Mount a template into the Leaflet map container and shield it from
   * map drag/scroll/click handlers. Returns the node.
   */
  function mountOnMap(templateId, map) {
    var node = mount(templateId, map.getContainer());
    if (window.L && L.DomEvent) {
      L.DomEvent.disableClickPropagation(node);
      L.DomEvent.disableScrollPropagation(node);
    }
    return node;
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
