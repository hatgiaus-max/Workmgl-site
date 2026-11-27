// WORKMGL data layer: talks to the Netlify backend through /api (proxied by Vercel).
// Exposes the same interface the site used with Firebase: db, user, assets, auth.
(() => {
  const TOKEN_KEY = "wm-admin-token";
  const getToken = () => { try { return localStorage.getItem(TOKEN_KEY) || ""; } catch (e) { return ""; } };
  const setToken = (t) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (e) {} };

  const api = async (path, { method = "GET", body, raw, timeout = 20000 } = {}) => {
    const headers = {};
    const t = getToken();
    if (t) headers.authorization = "Bearer " + t;
    if (body !== undefined) headers["content-type"] = "application/json";
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const r = await fetch("/api/" + path, { method, headers, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined, signal: ctl.signal, cache: "no-store" });
      let data = null;
      try { data = await r.json(); } catch (e) { data = null; }
      if (!r.ok) { const err = new Error((data && data.error) || "http_" + r.status); err.status = r.status; throw err; }
      return data;
    } finally { clearTimeout(timer); }
  };

  const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const meta = { fromCache: false, hasPendingWrites: false };
  const docSnap = (id, exists, data) => ({ id, exists, data: () => clone(data), metadata: meta });
  const colSnap = (docs) => {
    const list = docs.map((d) => docSnap(d.id, true, d.data));
    return { docs: list, size: list.length, empty: !list.length, metadata: meta };
  };
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  /* live updates: one batched poll for every active listener */
  let admin = false;
  const subs = new Map(); // key -> {type, path, last, ok, fns:Set<{next, error}>}
  let timer = null, busy = false, again = false;
  const interval = () => (admin ? 8000 : 45000);

  const tick = async () => {
    if (busy) { again = true; return; }
    busy = true;
    try {
      const entries = [...subs.values()].filter((s) => s.fns.size);
      for (let i = 0; i < entries.length; i += 20) {
        const part = entries.slice(i, i + 20);
        let res;
        try { res = (await api("read", { method: "POST", body: { reads: part.map((s) => ({ type: s.type, path: s.path })) } })).results; }
        catch (e) {
          part.forEach((s) => { if (!s.ok && !s.failed) { s.failed = true; s.fns.forEach((f) => f.error && f.error(e)); } });
          continue;
        }
        part.forEach((s, k) => {
          const r = res[k];
          if (!r || r.error) { if (!s.ok && !s.failed) { s.failed = true; s.fns.forEach((f) => f.error && f.error(new Error(r ? r.error : "read_failed"))); } return; }
          const sig = JSON.stringify(r);
          if (s.ok && sig === s.last) return;
          s.ok = true; s.last = sig;
          const snap = s.type === "doc" ? docSnap(r.id, r.exists, r.data) : colSnap(r.docs);
          s.fns.forEach((f) => { try { f.next(snap); } catch (e) { console.error(e); } });
        });
      }
    } finally {
      busy = false;
      clearTimeout(timer);
      timer = setTimeout(tick, interval());
      if (again) { again = false; setTimeout(tick, 0); }
    }
  };
  const refreshSoon = () => { clearTimeout(timer); timer = setTimeout(tick, 150); };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshSoon(); });

  const listen = (type, path, next, error) => {
    const key = type + ":" + path;
    let s = subs.get(key);
    if (!s) { s = { type, path, last: null, ok: false, failed: false, fns: new Set() }; subs.set(key, s); }
    const f = { next, error };
    s.fns.add(f);
    if (s.ok && s.last) {
      const r = JSON.parse(s.last);
      setTimeout(() => next(type === "doc" ? docSnap(r.id, r.exists, r.data) : colSnap(r.docs)), 0);
    }
    refreshSoon();
    return () => { s.fns.delete(f); };
  };

  const write = async (path, op, data) => {
    await api("write", { method: "POST", body: { path, op, data } });
    refreshSoon();
  };

  const doc = (path) => ({
    id: path.split("/").pop(),
    path,
    get: async () => {
      const r = (await api("read", { method: "POST", body: { reads: [{ type: "doc", path }] } })).results[0];
      if (!r || r.error) throw new Error(r ? r.error : "read_failed");
      return docSnap(r.id, r.exists, r.data);
    },
    set: (data) => write(path, "set", data),
    update: (data) => write(path, "update", data),
    delete: () => write(path, "delete"),
    onSnapshot: (next, error) => listen("doc", path, next, error),
  });
  const collection = (path) => ({
    path,
    doc: (id) => doc(path + "/" + (id || newId())),
    onSnapshot: (next, error) => listen("col", path, next, error),
  });

  const upload = async (file) => {
    const type = file.type || "application/octet-stream";
    const start = await api("upload/start", { method: "POST", body: { type, size: file.size } });
    const n = Math.ceil(file.size / start.chunk);
    for (let i = 0; i < n; i++) {
      const part = file.slice(i * start.chunk, Math.min(file.size, (i + 1) * start.chunk));
      let tries = 0;
      for (;;) {
        try { await api(`upload/chunk?id=${encodeURIComponent(start.id)}&i=${i}`, { method: "PUT", raw: part, timeout: 120000 }); break; }
        catch (e) { if (++tries >= 3) throw e; await new Promise((r) => setTimeout(r, 800 * tries)); }
      }
    }
    const done = await api("upload/finish", { method: "POST", body: { id: start.id } });
    return { id: done.id };
  };

  (async () => {
    const res = window.__fbres;
    let me = { signedIn: false, admin: false, email: "" };
    if (getToken()) {
      try { me = await api("me", { timeout: 10000 }); if (!me.admin) setToken(""); }
      catch (e) { me = { signedIn: false, admin: false, email: "" }; }
    }
    admin = !!me.admin;
    res({
      db: { doc, collection },
      user: { canEdit: async () => admin, isOwner: async () => admin, id: async () => null, can: async () => admin },
      assets: admin ? { upload } : null,
      auth: {
        email: me.email || "",
        signedIn: admin,
        admin,
        login: async (email, password) => {
          const r = await api("login", { method: "POST", body: { email, password } });
          setToken(r.token);
        },
        logout: async () => { setToken(""); },
        reset: async () => { const e = new Error("reset_not_supported"); e.code = "reset_not_supported"; throw e; },
      },
    });
  })();
})();
