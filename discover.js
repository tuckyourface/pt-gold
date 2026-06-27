/* =========================================================================
 * PT Gold — API auto-discovery (MAIN world)
 *
 * Runs in the page's own JS context so it can see the requests the Phantasy
 * Tour SPA makes to its private JSON API. It wraps fetch + XMLHttpRequest,
 * notes any same-origin "/api/..." call (URL + method), and forwards the
 * shape to the isolated content script via window.postMessage. The background
 * worker later replays these endpoints (with your cookies) to poll tab-free.
 *
 * It captures ONLY request URLs/methods and a tiny structural sample of the
 * response (object keys / array length) — never full response bodies, and it
 * reads nothing the page wasn't already fetching for itself.
 * ========================================================================= */
(() => {
  "use strict";
  const TAG = "ptgold-discover";
  const seen = new Set();

  function isApi(url) {
    try {
      const u = new URL(url, location.href);
      return u.origin === location.origin && /\/api\//.test(u.pathname);
    } catch (_) {
      return false;
    }
  }

  // a cheap, non-sensitive "shape" of the JSON so the worker knows how to parse
  function shape(json) {
    try {
      if (Array.isArray(json)) {
        return { kind: "array", len: json.length, itemKeys: json[0] && typeof json[0] === "object" ? Object.keys(json[0]).slice(0, 40) : [] };
      }
      if (json && typeof json === "object") {
        const out = { kind: "object", keys: Object.keys(json).slice(0, 40) };
        // note the first array-of-objects property (likely the posts/threads list)
        for (const k of out.keys) {
          if (Array.isArray(json[k]) && json[k][0] && typeof json[k][0] === "object") {
            out.listKey = k;
            out.itemKeys = Object.keys(json[k][0]).slice(0, 40);
            break;
          }
        }
        return out;
      }
    } catch (_) {}
    return { kind: typeof json };
  }

  function report(url, method, json) {
    try {
      const u = new URL(url, location.href);
      // generalise numeric ids to {id} so we learn a reusable template
      const template = u.pathname.replace(/\/\d+/g, "/{id}");
      const key = method + " " + template;
      if (seen.has(key)) return;
      seen.add(key);
      window.postMessage(
        {
          source: TAG,
          endpoint: {
            method,
            template,
            path: u.pathname,
            search: u.search,
            shape: shape(json),
          },
        },
        location.origin
      );
    } catch (_) {}
  }

  /* ---- wrap fetch ---- */
  const _fetch = window.fetch;
  if (_fetch) {
    window.fetch = function (input, init) {
      const url = typeof input === "string" ? input : input && input.url;
      const method = (init && init.method) || (input && input.method) || "GET";
      const p = _fetch.apply(this, arguments);
      if (url && isApi(url)) {
        p.then((res) => {
          res
            .clone()
            .json()
            .then((j) => report(url, method.toUpperCase(), j))
            .catch(() => report(url, method.toUpperCase(), null));
        }).catch(() => {});
      }
      return p;
    };
  }

  /* ---- wrap XHR ---- */
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ptg = { method: (method || "GET").toUpperCase(), url };
    return _open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const meta = this.__ptg;
    if (meta && isApi(meta.url)) {
      this.addEventListener("load", () => {
        let j = null;
        try { j = JSON.parse(this.responseText); } catch (_) {}
        report(meta.url, meta.method, j);
      });
    }
    return _send.apply(this, arguments);
  };
})();
