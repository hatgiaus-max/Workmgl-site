// WORKMGL backend core: document store + admin auth + file uploads.
// Storage is injected (Netlify Blobs in production, in-memory map in tests).
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

export const CHUNK = 3 * 1024 * 1024; // upload/serve chunk size (stays under proxy body limits)
const MAX_FILE = 60 * 1024 * 1024;
const MAX_DOC = 900 * 1024;
const MAX_ORDER = 40 * 1024;
const TOKEN_DAYS = 30;

const COLS = ["products", "orders", "coupons", "config"];
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const BLOB_RE = /^[A-Za-z0-9_-]{8,80}$/;

const json = (status, body, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });

export const parsePath = (p) => {
  if (typeof p !== "string") return null;
  const parts = p.split("/");
  if (parts.length !== 2) return null;
  const [col, id] = parts;
  if (!COLS.includes(col) || !ID_RE.test(id)) return null;
  return { col, id, key: `doc/${col}/${id}` };
};

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const size = (v) => Buffer.byteLength(JSON.stringify(v), "utf8");

/* ---------- auth ---------- */
const b64u = (buf) => Buffer.from(buf).toString("base64url");
const authKey = (env) => `${env.ADMIN_EMAIL || ""}\n${env.ADMIN_PASSWORD || ""}\nworkmgl-v1`;
const sign = (env, payload) => createHmac("sha256", authKey(env)).update(payload).digest("base64url");

export const authConfigured = (env) => !!(env.ADMIN_EMAIL && env.ADMIN_PASSWORD && env.ADMIN_PASSWORD.length >= 8);

const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export const makeToken = (env, email, now = Date.now()) => {
  const payload = b64u(JSON.stringify({ e: email, exp: now + TOKEN_DAYS * 864e5, n: b64u(randomBytes(6)) }));
  return `${payload}.${sign(env, payload)}`;
};

export const readToken = (env, req, now = Date.now()) => {
  if (!authConfigured(env)) return null;
  const h = req.headers.get("authorization") || "";
  const m = /^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(h);
  if (!m) return null;
  if (!safeEq(sign(env, m[1]), m[2])) return null;
  try {
    const p = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
    if (!p || p.exp < now) return null;
    if (String(p.e).toLowerCase() !== String(env.ADMIN_EMAIL).toLowerCase()) return null;
    return { email: p.e };
  } catch {
    return null;
  }
};

/* ---------- access rules ---------- */
// Public: read products/config, read a single coupon (to apply a code), create a NEW order.
// Admin: everything.
const canRead = (admin, kind, col) => admin || col === "products" || col === "config" || (col === "coupons" && kind === "doc");

const validOrder = (id, d) =>
  isPlain(d) && d.id === id && typeof d.at === "string" && d.at.length < 40 &&
  typeof d.name === "string" && d.name.trim().length > 0 && d.name.length <= 60 &&
  typeof d.phone === "string" && d.phone.replace(/\D/g, "").length >= 8 && d.phone.length <= 30 &&
  Array.isArray(d.items) && d.items.length > 0 && d.items.length <= 50 &&
  d.status === "new" && d.paid === false && size(d) <= MAX_ORDER;

/* ---------- handlers ---------- */
async function readDoc(store, path) {
  const p = parsePath(path);
  const data = await store.get(p.key, { type: "json" });
  return data == null ? { id: p.id, exists: false, data: null } : { id: p.id, exists: true, data };
}

async function readCol(store, col) {
  const { blobs } = await store.list({ prefix: `doc/${col}/` });
  const docs = await Promise.all(
    blobs.map(async (b) => {
      const id = b.key.slice(`doc/${col}/`.length);
      if (!ID_RE.test(id)) return null;
      const data = await store.get(b.key, { type: "json" });
      return data == null ? null : { id, data };
    })
  );
  return { docs: docs.filter(Boolean) };
}

async function batchRead(store, admin, reads) {
  if (!Array.isArray(reads) || reads.length > 20) return json(400, { error: "bad_request" });
  const out = [];
  for (const r of reads) {
    if (!r || (r.type !== "doc" && r.type !== "col")) { out.push({ error: "bad_request" }); continue; }
    if (r.type === "doc") {
      const p = parsePath(r.path);
      if (!p) { out.push({ error: "bad_path" }); continue; }
      if (!canRead(admin, "doc", p.col)) { out.push({ error: "forbidden" }); continue; }
      out.push(await readDoc(store, r.path));
    } else {
      if (!COLS.includes(r.path)) { out.push({ error: "bad_path" }); continue; }
      if (!canRead(admin, "col", r.path)) { out.push({ error: "forbidden" }); continue; }
      out.push(await readCol(store, r.path));
    }
  }
  return json(200, { results: out });
}

async function writeDoc(store, admin, body) {
  const p = parsePath(body && body.path);
  if (!p) return json(400, { error: "bad_path" });
  const op = body.op;
  if (!["set", "update", "delete"].includes(op)) return json(400, { error: "bad_op" });

  if (!admin) {
    // The only public write: placing a brand-new order.
    if (!(p.col === "orders" && op === "set" && validOrder(p.id, body.data))) return json(403, { error: "forbidden" });
    const exists = await store.get(p.key, { type: "json" });
    if (exists != null) return json(403, { error: "forbidden" });
    await store.setJSON(p.key, body.data);
    return json(200, { ok: true });
  }

  if (op === "delete") { await store.delete(p.key); return json(200, { ok: true }); }
  if (!isPlain(body.data)) return json(400, { error: "bad_data" });
  let next = body.data;
  if (op === "update") {
    const cur = await store.get(p.key, { type: "json" });
    if (cur == null) return json(404, { error: "not_found" });
    next = { ...cur, ...body.data };
  }
  if (size(next) > MAX_DOC) return json(413, { error: "too_large" });
  await store.setJSON(p.key, next);
  return json(200, { ok: true });
}

async function login(env, body) {
  if (!authConfigured(env)) return json(503, { error: "auth_not_configured" });
  const email = String((body && body.email) || "").trim().toLowerCase();
  const pass = String((body && body.password) || "");
  const ok = safeEq(email, String(env.ADMIN_EMAIL).trim().toLowerCase()) & safeEq(pass, env.ADMIN_PASSWORD);
  if (!ok) {
    await new Promise((r) => setTimeout(r, 700));
    return json(401, { error: "bad_credentials" });
  }
  return json(200, { token: makeToken(env, String(env.ADMIN_EMAIL).trim()), email: String(env.ADMIN_EMAIL).trim() });
}

/* uploads: start -> chunk(s) -> finish; files are served from /api/blob/<id> */
async function uploadStart(store, body) {
  const type = String((body && body.type) || "application/octet-stream").slice(0, 100);
  const total = Number(body && body.size);
  if (!(total > 0 && total <= MAX_FILE)) return json(413, { error: "too_large" });
  if (!/^(image|video)\//.test(type)) return json(415, { error: "bad_type" });
  const id = Date.now().toString(36) + b64u(randomBytes(9));
  await store.setJSON(`upmeta/${id}`, { type, size: total, chunks: Math.ceil(total / CHUNK), done: false, at: Date.now() });
  return json(200, { id, chunk: CHUNK });
}

async function uploadChunk(store, req, url) {
  const id = url.searchParams.get("id") || "";
  const i = Number(url.searchParams.get("i"));
  if (!BLOB_RE.test(id) || !Number.isInteger(i) || i < 0) return json(400, { error: "bad_request" });
  const meta = await store.get(`upmeta/${id}`, { type: "json" });
  if (!meta || meta.done || i >= meta.chunks) return json(400, { error: "bad_request" });
  const buf = await req.arrayBuffer();
  const expected = i === meta.chunks - 1 ? meta.size - CHUNK * i : CHUNK;
  if (buf.byteLength !== expected) return json(400, { error: "bad_chunk_size" });
  await store.set(`up/${id}/${i}`, buf);
  return json(200, { ok: true });
}

async function uploadFinish(store, body) {
  const id = String((body && body.id) || "");
  if (!BLOB_RE.test(id)) return json(400, { error: "bad_request" });
  const meta = await store.get(`upmeta/${id}`, { type: "json" });
  if (!meta) return json(404, { error: "not_found" });
  const { blobs } = await store.list({ prefix: `up/${id}/` });
  if (blobs.length !== meta.chunks) return json(400, { error: "incomplete" });
  await store.setJSON(`upmeta/${id}`, { ...meta, done: true });
  return json(200, { id });
}

async function serveBlob(store, req, id) {
  if (!BLOB_RE.test(id)) return new Response("Not found", { status: 404 });
  const meta = await store.get(`upmeta/${id}`, { type: "json" });
  if (!meta || !meta.done) return new Response("Not found", { status: 404 });
  const base = {
    "content-type": meta.type,
    "accept-ranges": "bytes",
    "cache-control": "public, max-age=31536000, immutable",
  };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.get("range") || "");
  if (range && (range[1] !== "" || range[2] !== "")) {
    let start, end;
    if (range[1] === "") { start = Math.max(0, meta.size - Number(range[2])); end = meta.size - 1; }
    else { start = Number(range[1]); end = range[2] === "" ? meta.size - 1 : Math.min(Number(range[2]), meta.size - 1); }
    if (start >= meta.size || start > end) {
      return new Response(null, { status: 416, headers: { ...base, "content-range": `bytes */${meta.size}` } });
    }
    // Serve at most the rest of one chunk; media players request the next part themselves.
    const ci = Math.floor(start / CHUNK);
    end = Math.min(end, (ci + 1) * CHUNK - 1);
    const part = new Uint8Array(await store.get(`up/${id}/${ci}`, { type: "arrayBuffer" }));
    const slice = part.subarray(start - ci * CHUNK, end - ci * CHUNK + 1);
    return new Response(slice, {
      status: 206,
      headers: { ...base, "content-range": `bytes ${start}-${end}/${meta.size}`, "content-length": String(slice.byteLength) },
    });
  }
  if (meta.chunks === 1) {
    const buf = await store.get(`up/${id}/0`, { type: "arrayBuffer" });
    return new Response(buf, { status: 200, headers: { ...base, "content-length": String(meta.size) } });
  }
  const stream = new ReadableStream({
    async start(ctrl) {
      for (let i = 0; i < meta.chunks; i++) ctrl.enqueue(new Uint8Array(await store.get(`up/${id}/${i}`, { type: "arrayBuffer" })));
      ctrl.close();
    },
  });
  return new Response(stream, { status: 200, headers: { ...base, "content-length": String(meta.size) } });
}

/* ---------- router ---------- */
export async function handle(req, { store, env }) {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  const method = req.method;

  if (method === "GET" && route.startsWith("blob/")) return serveBlob(store, req, route.slice(5));

  const who = readToken(env, req);
  const admin = !!who;
  const body = async () => {
    const t = await req.text();
    if (t.length > 1024 * 1024) throw new Error("too_large");
    return t ? JSON.parse(t) : {};
  };

  try {
    if (method === "GET" && route === "health") return json(200, { ok: true, auth: authConfigured(env) });
    if (method === "GET" && route === "me") return json(200, { signedIn: admin, admin, email: who ? who.email : "" });
    if (method === "POST" && route === "login") return login(env, await body());
    if (method === "POST" && route === "read") return batchRead(store, admin, (await body()).reads);
    if (method === "POST" && route === "write") return writeDoc(store, admin, await body());

    if (route.startsWith("upload/")) {
      if (!admin) return json(403, { error: "forbidden" });
      if (method === "POST" && route === "upload/start") return uploadStart(store, await body());
      if (method === "PUT" && route === "upload/chunk") return uploadChunk(store, req, url);
      if (method === "POST" && route === "upload/finish") return uploadFinish(store, await body());
    }
    return json(404, { error: "not_found" });
  } catch (e) {
    if (e instanceof SyntaxError) return json(400, { error: "bad_json" });
    if (e && e.message === "too_large") return json(413, { error: "too_large" });
    console.error(e);
    return json(500, { error: "server_error" });
  }
}
