/**
 * i18n.js - translation for the whole client.
 *
 * Design notes:
 *   - Language comes from the URL: / is English, /pl, /fr and /de are the others.
 *     Switching rewrites that URL with pushState and swaps the dictionary in
 *     place, so the address stays shareable without the page - and everything
 *     the page was holding - being thrown away to change some labels.
 *     Flask inlines the matching dictionary into the page as window.I18N_BUNDLE,
 *     so there is no fetch waterfall and no untranslated first paint. Fetching
 *     from static/lang/ remains as a fallback and for in-place switching.
 *   - English is always loaded as a fallback, so a half-finished translation
 *     degrades to English per key rather than showing raw key names.
 *   - Markup is annotated declaratively:
 *       data-i18n="key"                     -> textContent
 *       data-i18n-attrs="title=key;placeholder=key2"  -> attributes
 *     App.dom.render() runs apply() on every cloned template, so templates are
 *     translated the moment they are mounted without each module remembering.
 *   - Strings built in JS go through t(). Console logging stays English on
 *     purpose - it is developer output, not user output.
 *
 * Adding a language: drop static/lang/<code>.json next to the others and add
 * it to LANGUAGES below.
 */
var App = window.App || {};

App.i18n = (function () {
  "use strict";

  var FALLBACK_LANG = "en";

  // Each language names itself. An endonym rather than a translated name,
  // because the reader most in need of this control is the one who has landed
  // in a language they cannot read: "Deutsch" is findable from any starting
  // point, "German" only from English. The flag is the same string in the
  // switcher's own tile, which is why both live here rather than in the
  // dictionaries - a name in four translations is four places to keep in step
  // for a word that never changes.
  var LANGUAGES = [
    { code: "en", flag: "🇺🇸", name: "English" },
    { code: "pl", flag: "🇵🇱", name: "Polski" },
    { code: "de", flag: "🇩🇪", name: "Deutsch" },
    { code: "fr", flag: "🇫🇷", name: "Français" },
  ];

  var _lang = FALLBACK_LANG;
  var _dict = {};
  var _fallback = {};
  var _listeners = [];
  var _numbers = new Intl.NumberFormat(FALLBACK_LANG);
  var _plural = new Intl.PluralRules(FALLBACK_LANG);

  // LOOKUP

  function _resolve(node, vars) {
    // A key may resolve to a string, or to a { one, few, many, other } map
    // when the sentence inflects. Polish has three categories, so an
    // English-style count === 1 test produces "2 terenów" and "1 terenów".
    if (typeof node === "string") return node;
    if (node && typeof node === "object" && vars && typeof vars.count === "number") {
      var cat = _plural.select(vars.count);
      return node[cat] || node.other || node.many;
    }
    return undefined;
  }

  function _dig(dict, key) {
    var parts = key.split(".");
    var node = dict;
    for (var i = 0; i < parts.length; i++) {
      if (node == null || typeof node !== "object") return undefined;
      node = node[parts[i]];
    }
    return node;
  }

  /**
   * @param {string} key dotted path into the dictionary
   * @param {Object} [vars] values for {placeholders}; numbers are localized
   */
  function t(key, vars) {
    var text = _resolve(_dig(_dict, key), vars);
    if (text === undefined) text = _dig(_fallback, key);
    if (text === undefined) {
      console.warn(">>> Missing translation:", key);
      return key;
    }
    if (!vars) return text;

    return text.replace(/\{(\w+)\}/g, function (match, name) {
      if (!(name in vars)) return match;
      var value = vars[name];
      return typeof value === "number" ? _numbers.format(value) : String(value);
    });
  }

  /** Localized number, for anything built outside a translated string. */
  function n(value) {
    return _numbers.format(value);
  }

  /**
   * Label for a raw OSM tag value, e.g. tag("highway", "living_street").
   *
   * Deliberately not t(): OSM has an open vocabulary, so an unknown value is
   * the normal case rather than a missing-translation bug, and routing these
   * through t() would fill the console with warnings for tags nobody has got
   * round to naming yet. Unknown values are prettified instead, which for most
   * of them reads perfectly well.
   *
   * @param {string} group dictionary section, e.g. "highway" or "building"
   * @param {string} value raw tag value; "a;b" is labelled part by part
   */
  function tag(group, value) {
    if (value == null) return "";
    var raw = String(value).trim();
    if (!raw) return "";

    if (raw.indexOf(";") >= 0) {
      return raw
        .split(";")
        .map(function (part) {
          return tag(group, part);
        })
        .filter(Boolean)
        .join(" / ");
    }

    var hit = _dig(_dict, group + "." + raw);
    if (typeof hit !== "string") hit = _dig(_fallback, group + "." + raw);
    if (typeof hit === "string") return hit;

    return raw.replace(/_/g, " ").replace(/^./, function (c) {
      return c.toUpperCase();
    });
  }

  // DOM

  function _translateNode(node) {
    var key = node.getAttribute("data-i18n");
    if (key) node.textContent = t(key);

    var attrs = node.getAttribute("data-i18n-attrs");
    if (!attrs) return;
    attrs.split(";").forEach(function (pair) {
      var bits = pair.split("=");
      if (bits.length !== 2) return;
      node.setAttribute(bits[0].trim(), t(bits[1].trim()));
    });
  }

  /** Translate a subtree in place. Safe to call on freshly cloned templates. */
  function apply(root) {
    root = root || document.body;
    if (root.nodeType !== 1) return root;
    if (
      root.hasAttribute("data-i18n") ||
      root.hasAttribute("data-i18n-attrs")
    ) {
      _translateNode(root);
    }
    var nodes = root.querySelectorAll("[data-i18n], [data-i18n-attrs]");
    for (var i = 0; i < nodes.length; i++) _translateNode(nodes[i]);
    return root;
  }

  // LIFECYCLE

  /**
   * @returns {Array<{code:string, flag:string, name:string}>} A copy, so a
   *   caller building a picker cannot reorder the switcher for everyone else.
   */
  function languages() {
    return LANGUAGES.slice();
  }

  function current() {
    return _lang;
  }

  function isSupported(code) {
    for (var i = 0; i < LANGUAGES.length; i++)
      if (LANGUAGES[i].code === code) return true;
    return false;
  }

  /**
   * Build the dictionary URL for a language.
   *
   * Two traps this avoids:
   *   - A relative I18N_URL resolves differently per language, because the app
   *     is served from /, /pl, /fr and /de - "static/lang/pl.json" becomes
   *     "/de/static/lang/pl.json" on the German page. Resolving against
   *     document.baseURI pins it regardless of path depth.
   *   - String.replace with a string pattern swaps only the FIRST match, so a
   *     path with more than one LANG placeholder is half-substituted.
   *
   * If the value has no LANG placeholder it is treated as a directory, so
   * window.I18N_URL = "/assets/translations/" also works.
   */
  function _url(code) {
    var template = window.I18N_URL || "/static/lang/LANG.json";
    var path =
      template.indexOf("LANG") >= 0
        ? template.split("LANG").join(code)
        : template.replace(/\/?$/, "/") + code + ".json";
    return new URL(path, document.baseURI).href;
  }

  function _fetchDict(code) {
    var url = _url(code);
    return fetch(url).then(function (r) {
      if (!r.ok) {
        throw new Error("Dictionary " + code + " not found at " + url);
      }
      return r.json().catch(function () {
        throw new Error(
          "Dictionary " + code + " at " + url + " is not valid JSON",
        );
      });
    });
  }

  /** The URL decides. Everything else is a fallback for serving the page
   *  outside Flask. */
  function detect() {
    if (window.APP_LANG && isSupported(window.APP_LANG)) return window.APP_LANG;

    var fromPath = String(window.location.pathname)
      .split("/")
      .filter(Boolean)[0];
    if (fromPath && isSupported(fromPath)) return fromPath;

    var preferred = navigator.languages || [navigator.language || ""];
    for (var i = 0; i < preferred.length; i++) {
      var code = String(preferred[i]).slice(0, 2).toLowerCase();
      if (isSupported(code)) return code;
    }
    return FALLBACK_LANG;
  }

  /** URL for a language, from the server when available. */
  function pathFor(code) {
    if (window.LANG_PATHS && window.LANG_PATHS[code])
      return window.LANG_PATHS[code];
    return code === FALLBACK_LANG ? "/" : "/" + code;
  }

  /** Resolves once t() is usable. */
  function init() {
    _bindHistory();
    var bundle = window.I18N_BUNDLE;
    if (bundle && bundle.messages) {
      _fallback = bundle.fallback || bundle.messages;
      _activate(
        isSupported(bundle.lang) ? bundle.lang : FALLBACK_LANG,
        bundle.messages,
      );
      return Promise.resolve(_lang);
    }
    return _fetchFromStatic();
  }

  /** Used when the page was not rendered by Flask, or after an in-place switch. */
  function _fetchFromStatic() {
    return _fetchDict(FALLBACK_LANG)
      .then(function (dict) {
        _fallback = dict;
        _dict = dict;
        var wanted = detect();
        if (wanted === FALLBACK_LANG) return _activate(FALLBACK_LANG, dict);
        return _fetchDict(wanted).then(
          function (localized) {
            return _activate(wanted, localized);
          },
          function (err) {
            console.warn(">>> Falling back to English:", err.message);
            return _activate(FALLBACK_LANG, dict);
          },
        );
      })
      .catch(function (err) {
        // Without dictionaries t() returns raw keys, which is ugly but keeps
        // the app usable rather than blocking startup entirely.
        console.error(">>> i18n failed to load:", err);
      });
  }

  function _activate(code, dict) {
    _lang = code;
    _dict = dict;
    _numbers = new Intl.NumberFormat(code);
    _plural = new Intl.PluralRules(code);
    document.documentElement.lang = code;
    return code;
  }

  /**
   * @param {string} code
   * @param {{navigate?: boolean}} [opts] navigate defaults to true, which
   *   keeps the URL in step with the choice so it can be shared and
   *   bookmarked. The URL is rewritten with pushState and the dictionaries are
   *   swapped in place rather than reloading, which would throw away everything
   *   the page is holding - the drawn boundary, the downloaded streets, the undo
   *   stack, the map view - to change some text. Pass false to swap without
   *   touching the URL at all.
   */
  function setLanguage(code, opts) {
    if (!isSupported(code) || code === _lang) return Promise.resolve(_lang);
    var updateUrl = !opts || opts.navigate !== false;

    // No History API: fall back to a full-page navigation, which is correct,
    // just lossy.
    if (updateUrl && !_canPushState()) {
      window.location.assign(pathFor(code));
      return Promise.resolve(code);
    }
    return _swap(code, updateUrl);
  }

  function _canPushState() {
    return !!(window.history && window.history.pushState);
  }

  function _swap(code, updateUrl) {
    return _fetchDict(code).then(
      function (dict) {
        _activate(code, dict);
        if (updateUrl) {
          window.history.pushState({ lang: code }, "", pathFor(code));
        }
        _syncManifestLink(code);
        apply(document.body);
        _notify(code);
        console.log(">>> Language switched in place to", code);
        return code;
      },
      function (err) {
        console.warn(">>> Could not swap dictionaries:", err.message);
        // A reload can only rescue this if the network can serve the page.
        // Offline, navigating would replace a working app with a dead tab, so
        // the current language stays and nothing is lost.
        if (updateUrl && navigator.onLine !== false) {
          window.location.assign(pathFor(code));
        }
        return _lang;
      },
    );
  }

  function _notify(code) {
    _listeners.forEach(function (fn) {
      try {
        fn(code);
      } catch (e) {
        console.error(">>> Language listener failed:", e);
      }
    });
  }

  /**
   * The manifest is served per language (/manifest.webmanifest?lang=xx), and
   * an installed PWA reads it from the live document. Without this the app
   * would install under whichever language the tab happened to start in.
   */
  function _syncManifestLink(code) {
    var link = document.querySelector('link[rel="manifest"]');
    if (!link) return;
    try {
      var url = new URL(link.getAttribute("href"), document.baseURI);
      url.searchParams.set("lang", code);
      link.setAttribute("href", url.pathname + url.search);
    } catch (e) {
      /* an un-rewritable href is not worth failing the switch over */
    }
  }

  /**
   * Back and Forward now move between languages, because pushState made them
   * history entries. Without this the URL would change and the text would not.
   */
  function _bindHistory() {
    if (!_canPushState()) return;
    window.addEventListener("popstate", function () {
      var code = _codeFromPath();
      if (code !== _lang) _swap(code, false);
    });
  }

  function _codeFromPath() {
    var first = String(window.location.pathname).split("/").filter(Boolean)[0];
    return first && isSupported(first) ? first : FALLBACK_LANG;
  }

  /** Register a callback for strings that JS built and must rebuild. */
  function onChange(fn) {
    _listeners.push(fn);
  }

  return {
    init: init,
    t: t,
    n: n,
    tag: tag,
    apply: apply,
    languages: languages,
    current: current,
    setLanguage: setLanguage,
    onChange: onChange,
  };
})();

window.App = App;
