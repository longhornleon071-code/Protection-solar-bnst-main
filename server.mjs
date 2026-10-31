// BUNNY TEAM — Node server. DEMO BUILD: all data lives in memory and resets on restart.
// The "db" section is the only place that touches data, so a real database can replace it later.
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const PORT = Number(process.env.PORT || 3000);
const MIN_PASSWORD = 8;
const RANK = { Owner: 10, "Co-Owner": 9, "Head Admin": 8, "Head Mod": 7, Admin: 6, Moderator: 5, "Trial Admin": 4, "Trial Mod": 3, Member: 2, Visitor: 1 };
const MIN_LINK = 3, MIN_REVIEW = 5, MIN_LOGS = 6, MIN_ROLES = 8, MIN_REVOKE_ANY = 6;
const rid = (p) => p + "-" + crypto.randomBytes(4).toString("hex").toUpperCase();
const token = () => crypto.randomBytes(24).toString("base64url");
const clean = (s, n = 300) => String(s ?? "").replace(/[<>]/g, "").trim().slice(0, n);
// Passwords are stored as scrypt hashes, never in plain text.
const hashPw = (pw) => { const salt = crypto.randomBytes(16); return salt.toString("hex") + ":" + crypto.scryptSync(String(pw), salt, 64).toString("hex"); };
const checkPw = (pw, stored) => { const [s, h] = String(stored || "").split(":"); if (!s || !h) return false; const a = crypto.scryptSync(String(pw), Buffer.from(s, "hex"), 64), b = Buffer.from(h, "hex"); return a.length === b.length && crypto.timingSafeEqual(a, b); };
const pub = ({ pw, ...u }) => u; // strip the password hash from anything sent to the browser
const tempPassword = () => crypto.randomBytes(6).toString("base64url");
const failures = new Map(); // username -> { n, until } for login lockout

// ---------------- db (in-memory, starts EMPTY) ----------------
// Nothing is seeded. The first account that registers on an empty server becomes the Owner.
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const db = { users: [], trades: [], vouches: [], links: [], reports: [], logs: [], listings: [], sessions: new Map(), notifs: [] };

// ---- catalog (Adopt Me and MM2 items), fee schedule, and validation ----
const DEFAULT_ADM = [["Shadow Dragon", 240], ["Frost Dragon", 210], ["Bat Dragon", 190], ["Giraffe", 70], ["Evil Unicorn", 60], ["Owl", 45], ["Parrot", 40], ["Crow", 35], ["Turtle", 20], ["Kangaroo", 18], ["Dog", 4], ["Cat", 4]];
const DEFAULT_MM2 = [["Chroma Lightbringer", 350], ["Harvester", 260], ["Icepiercer", 180], ["Elderwood Scythe", 150], ["Nik's Scythe", 120], ["Batwing", 90], ["Candy", 55], ["Gingerscope", 40], ["Heartblade", 30], ["Corrupt", 25]];
const DEFAULT_FEES = [{ min: 100, max: 500, type: "free", rate: 0 }, { min: 501, max: 1000, type: "percent", rate: 1 }, { min: 1001, max: 5000, type: "percent", rate: 0.5 }, { min: 5001, max: 10000, type: "percent", rate: 0.5 }, { min: 10001, max: null, type: "percent", rate: 0.3 }];
const cleanItems = (arr) => {
  if (!Array.isArray(arr) || arr.length > 300) throw new Err(400, "Item list is missing or too long.");
  return arr.map((x) => { const n = clean(Array.isArray(x) ? x[0] : "", 40), v = Number(Array.isArray(x) ? x[1] : NaN); if (!n) throw new Err(400, "Every item needs a name."); if (!(v >= 0 && v <= 10000000)) throw new Err(400, "Value for " + n + " must be 0 to 10,000,000."); return [n, Math.round(v * 100) / 100]; });
};
const cleanFees = (arr) => {
  if (!Array.isArray(arr) || arr.length < 1 || arr.length > 8) throw new Err(400, "Fee schedule needs 1 to 8 rows.");
  return arr.map((f) => {
    const min = Number(f.min), max = f.max === null || f.max === "" || f.max === undefined ? null : Number(f.max), rate = Number(f.rate) || 0;
    if (!(min >= 0)) throw new Err(400, "Each fee row needs a From amount.");
    if (max !== null && !(max > min)) throw new Err(400, "To must be bigger than From.");
    if (!["free", "percent"].includes(f.type)) throw new Err(400, "Invalid fee type.");
    if (!(rate >= 0 && rate <= 100)) throw new Err(400, "Fee must be 0 to 100%.");
    return { min, max, type: f.type, rate: f.type === "free" ? 0 : rate };
  }).sort((a, b) => a.min - b.min);
};
// Commission in pesos for a transaction amount, from the fee schedule. Result is rounded to centavos.
const feeFor = (v) => { const b = db.fees.find((f) => v >= f.min && (f.max === null || v <= f.max)); if (!b || b.type === "free") return 0; return Math.round(v * b.rate) / 100; };
db.catalog = { adm: DEFAULT_ADM.map((x) => [...x]), mm2: DEFAULT_MM2.map((x) => [...x]) };
db.fees = DEFAULT_FEES.map((f) => ({ ...f }));
const U = (name, role, o = {}) => db.users.push({ id: "BT-" + (1001 + db.users.length), name, role, bio: o.bio || "Bunny Team member.", mm: !!o.mm, status: "online", avatar: null, banner: null, hue: Math.floor(Math.random() * 360), joined: new Date().toISOString().slice(0, 10), pw: "" });
const log = (actor, action, detail = "") => db.logs.unshift({ id: rid("LG"), at: Date.now(), actor: actor?.name || "system", role: actor?.role || "", action, detail });

const notify = (uid, text) => db.notifs.unshift({ id: rid("NT"), uid, text, at: Date.now(), read: false });
const userById = (id) => db.users.find((u) => u.id === id);
function statsOf(uid) {
  const t = db.trades.filter((x) => x.mm === uid), done = t.filter((x) => x.status === "Completed");
  const vs = db.vouches.filter((v) => v.mm === uid && v.status === "verified");
  const sum = (a, f) => Math.round(a.reduce((s, x) => s + f(x), 0) * 100) / 100;
  return { trades: done.length, holds: t.filter((x) => x.hold).length, holdsDone: done.filter((x) => x.hold).length, holdsPending: t.filter((x) => x.hold && ["Pending", "In Progress"].includes(x.status)).length,
    commission: sum(done, (x) => x.commission), commissionPending: sum(t.filter((x) => ["Pending", "In Progress"].includes(x.status)), (x) => x.commission),
    sales: sum(done, (x) => x.value), pending: t.filter((x) => ["Pending", "In Progress"].includes(x.status)).length, cancelled: t.filter((x) => x.status === "Cancelled").length, disputed: t.filter((x) => x.status === "Disputed").length,
    vouches: vs.length, rating: vs.length ? Math.round((vs.reduce((s, v) => s + v.rating, 0) / vs.length) * 100) / 100 : 0,
    active: t.length + db.links.filter((l) => l.by === uid).length + db.logs.filter((l) => l.actor === userById(uid)?.name).length };
}
const linkStatus = (l) => (l.status === "active" && l.expiresAt < Date.now() ? "expired" : l.status);
const pubLink = (l) => ({ ...l, status: linkStatus(l), byName: userById(l.by)?.name });

// ---------------- http helpers ----------------
const hits = new Map();
const limited = (ip) => { const n = Date.now(), a = (hits.get(ip) || []).filter((t) => n - t < 6e4); a.push(n); hits.set(ip, a); return a.length > 240; };
const send = (res, code, body) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok, no) => { let b = "", n = 0; req.on("data", (c) => { n += c.length; if (n > 400000) { no(new Error("too large")); req.destroy(); } else b += c; }); req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(new Error("bad json")); } }); });
const authOf = (req) => { const t = (req.headers.authorization || "").replace("Bearer ", ""); const id = db.sessions.get(t); return id ? userById(id) : null; };
class Err extends Error { constructor(c, m) { super(m); this.code = c; } }
const need = (me, min) => { if (!me) throw new Err(401, "Sign in first."); if (RANK[me.role] < min) throw new Err(403, "Your role does not have permission for this action."); };
const img = (s) => (typeof s === "string" && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length < 160000 ? s : null);

// ---------------- API ----------------
const routes = [];
const R = (m, p, fn) => routes.push([m, new RegExp("^" + p.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$"), fn]);

R("GET", "/api/overview", () => {
  const done = db.trades.filter((t) => t.status === "Completed");
  return { totals: { members: db.users.length, mms: db.users.filter((u) => u.mm).length, trades: done.length, vouches: db.vouches.filter((v) => v.status === "verified").length, commission: Math.round(done.reduce((s, t) => s + t.commission, 0)) },
    recent: done.sort((a, b) => b.at - a.at).slice(0, 6).map((t) => ({ id: t.id, mm: userById(t.mm)?.name, items: t.items, game: t.game, at: t.at })),
    activity: db.vouches.filter((v) => v.status === "verified").sort((a, b) => b.at - a.at).slice(0, 5).map((v) => ({ who: v.customer, mm: userById(v.mm)?.name, rating: v.rating, at: v.at })),
    demo: { login: true } };
});
R("GET", "/api/mms", () => db.users.filter((u) => u.mm).map((u) => ({ ...pub(u), stats: statsOf(u.id), reviews: db.vouches.filter((v) => v.mm === u.id && v.status === "verified").sort((a, b) => b.at - a.at).slice(0, 5).map(({ customer, rating, text, at }) => ({ customer, rating, text, at })) })));
R("GET", "/api/users", () => db.users.map((u) => ({ id: u.id, name: u.name, role: u.role })));
R("GET", "/api/me", (r) => { need(r.me, 1); return { ...pub(r.me), stats: statsOf(r.me.id), rank: RANK[r.me.role] }; });
R("POST", "/api/login", async (r) => {
  const name = clean(r.body.username, 20).toLowerCase(), pw = String(r.body.password || "");
  const f = failures.get(name); if (f && f.until > Date.now()) throw new Err(429, "Too many wrong attempts. Wait 15 minutes and try again.");
  const u = db.users.find((x) => x.name.toLowerCase() === name);
  if (!u || !checkPw(pw, u.pw)) { const n = (f?.n || 0) + 1; failures.set(name, { n, until: n >= 5 ? Date.now() + 15 * 6e4 : 0 }); throw new Err(401, "Wrong username or password."); }
  failures.delete(name); const t = token(); db.sessions.set(t, u.id); log(u, "Signed in"); return { token: t, user: { ...pub(u), rank: RANK[u.role] } };
});
R("POST", "/api/register", (r) => {
  const name = clean(r.body.username, 20), pw = String(r.body.password || "");
  if (name.length < 2) throw new Err(400, "Username needs 2–20 characters.");
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) throw new Err(400, "Username can use letters, numbers, _ . - only.");
  if (pw.length < MIN_PASSWORD) throw new Err(400, "Password needs at least " + MIN_PASSWORD + " characters.");
  if (db.users.some((u) => u.name.toLowerCase() === name.toLowerCase())) throw new Err(409, "That username is taken.");
  const first = db.users.length === 0; U(name, first ? "Owner" : "Member", { mm: first }); const u = db.users[db.users.length - 1]; u.pw = hashPw(pw);
  const t = token(); db.sessions.set(t, u.id); log(u, "Created account"); return { token: t, user: { ...pub(u), rank: RANK[u.role] } };
});
R("POST", "/api/logout", (r) => { db.sessions.delete((r.req.headers.authorization || "").replace("Bearer ", "")); return { ok: true }; });
R("PATCH", "/api/me", (r) => {
  need(r.me, 2); const b = r.body, n = clean(b.name, 20);
  if (b.name !== undefined) { if (n.length < 2) throw new Err(400, "Username needs 2–20 characters."); if (db.users.some((u) => u.id !== r.me.id && u.name.toLowerCase() === n.toLowerCase())) throw new Err(409, "That username is taken."); r.me.name = n; }
  if (b.bio !== undefined) r.me.bio = clean(b.bio, 200);
  if (b.avatar !== undefined) r.me.avatar = img(b.avatar); if (b.banner !== undefined) r.me.banner = img(b.banner);
  if (b.status && ["online", "busy", "offline"].includes(b.status)) r.me.status = b.status;
  if (b.comm !== undefined) { if (b.comm === null || b.comm === "") r.me.comm = undefined; else { const c = Number(b.comm); if (!(c >= 0 && c <= 100)) throw new Err(400, "Commission must be 0 to 100."); r.me.comm = Math.round(c * 10) / 10; } }
  log(r.me, "Updated profile"); return r.me;
});
R("POST", "/api/users/:id/role", (r) => {
  need(r.me, MIN_ROLES); const t = userById(r.params.id), role = r.body.role;
  if (!t || !(role in RANK)) throw new Err(400, "Unknown account or role.");
  if (RANK[t.role] >= RANK[r.me.role] || RANK[role] >= RANK[r.me.role]) throw new Err(403, "You can only manage roles below your own.");
  log(r.me, "Changed role", `${t.name}: ${t.role} → ${role}`); t.role = role; t.mm = t.mm || RANK[role] >= MIN_LINK; return { ok: true };
});

// links
const mk = (me, type, ref, minutes, batchId) => ({ id: rid(type === "vouch" ? "VQ" : "VL"), token: token(), type, ref: clean(ref, 60), by: me.id, createdAt: Date.now(), expiresAt: Date.now() + minutes * 6e4, status: "active", batchId: batchId || null, views: 0 });
const minutesOf = (b, type) => { const m = Number(b.minutes); if (type === "vouch") return 7 * 24 * 60; if (![1, 5, 10].includes(m)) throw new Err(400, "Choose 1, 5, or 10 minutes."); return m; };
R("POST", "/api/links", (r) => { need(r.me, MIN_LINK); const type = r.body.type === "vouch" ? "vouch" : "verify"; const l = mk(r.me, type, r.body.ref, minutesOf(r.body, type)); db.links.unshift(l); log(r.me, "Created " + type + " link", l.id + " ref " + l.ref); return pubLink(l); });
R("POST", "/api/links/batch", (r) => {
  need(r.me, MIN_LINK); const n = Math.floor(Number(r.body.count)); if (!(n >= 1 && n <= 25)) throw new Err(400, "Choose 1–25 links.");
  const m = minutesOf(r.body, "verify"), refs = String(r.body.refs || "").split("\n").map((s) => s.trim()).filter(Boolean), bid = rid("BT"), out = [];
  for (let i = 0; i < n; i++) { const l = mk(r.me, "verify", refs[i] || (clean(r.body.ref, 50) || "BATCH") + "-" + (i + 1), m, bid); db.links.unshift(l); out.push(pubLink(l)); }
  log(r.me, "Created batch of " + n + " verification links", bid); return out;
});
R("GET", "/api/links", (r) => { need(r.me, MIN_LINK); const n0 = db.links.length; db.links = db.links.filter((l) => Date.now() - l.expiresAt < 864e5); if (db.links.length < n0) log(null, "Auto-cleanup removed " + (n0 - db.links.length) + " old links"); return db.links.filter((l) => RANK[r.me.role] >= MIN_REVOKE_ANY || l.by === r.me.id).map(pubLink); });
R("POST", "/api/links/:id/revoke", (r) => {
  need(r.me, MIN_LINK); const l = db.links.find((x) => x.id === r.params.id); if (!l) throw new Err(404, "Link not found.");
  if (l.by !== r.me.id && RANK[r.me.role] < MIN_REVOKE_ANY) throw new Err(403, "Only the creator or an Admin+ can revoke this link.");
  if (linkStatus(l) !== "active") throw new Err(400, "Only active links can be revoked."); l.status = "revoked"; log(r.me, "Revoked link", l.id); return pubLink(l);
});
const byToken = (t, type) => { const l = db.links.find((x) => x.token === t && x.type === type); if (!l) throw new Err(404, "This link does not exist."); return l; };
R("GET", "/api/verify/:t", (r) => {
  const l = byToken(r.params.t, "verify"), st = linkStatus(l); if (st !== "active") return { status: st };
  l.views++; if (l.views === 1) notify(l.by, "Verification link " + l.id + " was opened" + (l.ref ? " (" + l.ref + ")" : "")); const s = userById(l.by); return { status: st, serverNow: Date.now(), link: { id: l.id, ref: l.ref, createdAt: l.createdAt, expiresAt: l.expiresAt }, staff: { id: s.id, name: s.name, role: s.role, avatar: s.avatar, hue: s.hue, status: s.status, verified: RANK[s.role] >= MIN_LINK, stats: statsOf(s.id), comm: s.comm ?? null } };
});
R("POST", "/api/verify/:t/confirm", (r) => { const l = byToken(r.params.t, "verify"); if (linkStatus(l) !== "active") throw new Err(410, "This link is no longer active."); l.status = "used"; notify(l.by, "Customer finished verification " + l.id); return { ok: true }; });
R("GET", "/api/vouch/:t", (r) => {
  const l = byToken(r.params.t, "vouch"), st = linkStatus(l); if (st !== "active") return { status: st }; const s = userById(l.by);
  return { status: st, link: { id: l.id, ref: l.ref, expiresAt: l.expiresAt }, mm: { id: s.id, name: s.name, role: s.role, avatar: s.avatar, hue: s.hue, comm: s.comm ?? null } };
});
R("POST", "/api/vouch/:t", (r) => {
  const l = byToken(r.params.t, "vouch"); if (linkStatus(l) !== "active") throw new Err(410, "This vouch link is no longer active.");
  const b = r.body, mm = userById(l.by), customer = clean(b.customer, 20), text = clean(b.text, 400), ref = clean(b.txRef, 30).toUpperCase(), rating = Math.floor(Number(b.rating));
  if (customer.length < 2) throw new Err(400, "Enter your username."); if (!(rating >= 1 && rating <= 5)) throw new Err(400, "Choose a star rating."); if (text.length < 10) throw new Err(400, "Write at least 10 characters.");
  if ([mm.name.toLowerCase(), mm.id.toLowerCase()].includes(customer.toLowerCase())) throw new Err(400, "You can't vouch for yourself.");
  const t = db.trades.find((x) => x.id === ref || x.ref.toUpperCase() === ref);
  if (!t || t.mm !== mm.id) throw new Err(400, "That transaction was not handled by this middleman.");
  if (t.status !== "Completed") throw new Err(400, "Only completed transactions are eligible for a vouch.");
  if (![t.buyer, t.seller].some((n) => n.toLowerCase() === customer.toLowerCase())) throw new Err(400, "Your username must match the buyer or seller on this transaction.");
  if (db.vouches.some((v) => v.txRef === t.id && v.status !== "rejected")) throw new Err(409, "A vouch was already submitted for this transaction.");
  const v = { id: rid("VR"), mm: mm.id, customer, rating, text, txRef: t.id, proof: img(b.proof), status: "pending", at: Date.now(), linkId: l.id };
  db.vouches.unshift(v); l.status = "used"; notify(mm.id, "New vouch from " + customer + " is waiting for review"); log(null, "Vouch submitted", v.id); return { id: v.id, status: v.status };
});
R("GET", "/api/vouches", (r) => { need(r.me, MIN_LINK); return db.vouches.filter((v) => v.mm === r.me.id || RANK[r.me.role] >= MIN_REVIEW).map((v) => ({ ...v, mmName: userById(v.mm)?.name })); });
R("POST", "/api/vouches/:id/status", (r) => { need(r.me, MIN_REVIEW); const v = db.vouches.find((x) => x.id === r.params.id); if (!v || !["pending", "verified", "rejected", "under-review"].includes(r.body.status)) throw new Err(400, "Invalid request."); v.status = r.body.status; log(r.me, "Vouch → " + v.status, v.id); return v; });

// trades
R("GET", "/api/trades", (r) => { need(r.me, MIN_LINK); return db.trades.filter((t) => t.mm === r.me.id || RANK[r.me.role] >= MIN_REVIEW).sort((a, b) => b.at - a.at).map((t) => ({ ...t, mmName: userById(t.mm)?.name })); });
R("POST", "/api/trades", (r) => {
  need(r.me, MIN_LINK); const b = r.body, items = String(b.items || "").split(",").map((s) => clean(s, 40)).filter(Boolean);
  if (!clean(b.buyer, 20) || !clean(b.seller, 20) || !items.length) throw new Err(400, "Buyer, seller, and at least one item are required.");
  const val = Math.max(0, Number(b.value) || 0), t = { id: rid("TR"), mm: r.me.id, buyer: clean(b.buyer, 20), seller: clean(b.seller, 20), game: b.game === "MM2" ? "MM2" : "ADM", items, ref: clean(b.ref, 30) || rid("REF"), commission: feeFor(val), value: val, hold: !!b.hold, verifRef: clean(b.verifRef, 30) || null, evidence: [], events: [{ text: "Transaction created by " + r.me.name, at: Date.now() }], status: "Pending", at: Date.now() };
  db.trades.unshift(t); log(r.me, "Created trade", t.id); return t;
});
R("POST", "/api/trades/:id/status", (r) => {
  need(r.me, MIN_LINK); const t = db.trades.find((x) => x.id === r.params.id); if (!t) throw new Err(404, "Trade not found.");
  if (t.mm !== r.me.id && RANK[r.me.role] < MIN_REVIEW) throw new Err(403, "Only the assigned middleman or a Moderator+ can change this trade.");
  if (!["Pending", "In Progress", "Completed", "Cancelled", "Disputed"].includes(r.body.status)) throw new Err(400, "Invalid status.");
  if (r.body.note) t.evidence.push({ note: clean(r.body.note, 200), by: r.me.name, at: Date.now() }); t.status = r.body.status; (t.events ||= []).push({ text: "Status changed to " + t.status + " by " + r.me.name, at: Date.now() }); if (t.mm !== r.me.id) notify(t.mm, "Trade " + t.id + " is now " + t.status); log(r.me, "Trade → " + t.status, t.id); return t;
});

// listings
R("GET", "/api/listings", () => db.listings);
R("POST", "/api/listings", (r) => {
  need(r.me, 2); const b = r.body; if (!clean(b.item, 40)) throw new Err(400, "Item is required.");
  const l = { id: rid("LS"), game: b.game === "MM2" ? "MM2" : "ADM", type: ["WTB", "WTS", "LF"].includes(b.type) ? b.type : "WTS", item: clean(b.item, 40), mutation: clean(b.mutation, 10), note: clean(b.note, 120), by: r.me.name, byId: r.me.id, at: Date.now() };
  db.listings.unshift(l); log(r.me, "Created listing", l.id); return l;
});
R("DELETE", "/api/listings/:id", (r) => { need(r.me, 2); const l = db.listings.find((x) => x.id === r.params.id); if (!l) throw new Err(404, "Not found."); if (l.byId !== r.me.id && RANK[r.me.role] < MIN_REVIEW) throw new Err(403, "You can only remove your own listings."); db.listings = db.listings.filter((x) => x !== l); return { ok: true }; });

// reports (anyone may file; staff review; a report never labels anyone)
const CATS = ["Fake middleman", "Impersonation", "Fake verification link", "Trading scam", "Payment scam", "Fake screenshots", "Harassment", "Suspicious behavior", "Other"];
R("POST", "/api/reports", (r) => {
  const b = r.body; if (!CATS.includes(b.category)) throw new Err(400, "Choose a category."); if (clean(b.description, 800).length < 15) throw new Err(400, "Describe what happened (15+ characters).");
  const rp = { id: rid("RP"), category: b.category, target: clean(b.target, 40), description: clean(b.description, 800), evidence: clean(b.evidence, 300), image: img(b.image), by: r.me?.name || "Anonymous", status: "open", note: "", at: Date.now() };
  db.reports.unshift(rp); db.users.filter((u) => RANK[u.role] >= MIN_REVIEW).forEach((u) => notify(u.id, "New report " + rp.id + ": " + rp.category)); log(r.me, "Report filed", rp.id); return { id: rp.id };
});
R("GET", "/api/reports", (r) => { need(r.me, MIN_REVIEW); return db.reports; });
R("POST", "/api/reports/:id/status", (r) => { need(r.me, MIN_REVIEW); const rp = db.reports.find((x) => x.id === r.params.id); if (!rp || !["open", "reviewing", "resolved", "dismissed"].includes(r.body.status)) throw new Err(400, "Invalid request."); rp.status = r.body.status; rp.note = clean(r.body.note, 200); log(r.me, "Report → " + rp.status, rp.id); return rp; });
R("GET", "/api/logs", (r) => { need(r.me, MIN_LOGS); return db.logs.slice(0, 100); });
R("GET", "/api/reports/categories", () => CATS);

R("GET", "/api/notifications", (r) => { need(r.me, 1); return db.notifs.filter((n) => n.uid === r.me.id).slice(0, 40); });
R("POST", "/api/notifications/read", (r) => { need(r.me, 1); db.notifs.forEach((n) => { if (n.uid === r.me.id) n.read = true; }); return { ok: true }; });
R("GET", "/api/me/activity", (r) => { need(r.me, 1); return db.logs.filter((l) => l.actor === r.me.name).slice(0, 10); });
R("POST", "/api/me/signout-all", (r) => { need(r.me, 1); for (const [t, id] of [...db.sessions]) if (id === r.me.id) db.sessions.delete(t); log(r.me, "Signed out all sessions"); return { ok: true }; });
R("POST", "/api/users", (r) => {
  need(r.me, MIN_ROLES); const name = clean(r.body.name, 20), role = r.body.role;
  if (name.length < 2) throw new Err(400, "Username needs 2–20 characters."); if (!(role in RANK) || RANK[role] >= RANK[r.me.role]) throw new Err(403, "You can only give roles below your own.");
  if (db.users.some((u) => u.name.toLowerCase() === name.toLowerCase())) throw new Err(409, "That username is taken.");
  const tmp = tempPassword(); U(name, role, { mm: RANK[role] >= MIN_LINK }); const u = db.users[db.users.length - 1]; u.pw = hashPw(tmp); log(r.me, "Added member", name + " as " + role); return { id: u.id, name: u.name, role: u.role, tempPassword: tmp };
});
R("GET", "/api/catalog", () => ({ adm: db.catalog.adm, mm2: db.catalog.mm2, fees: db.fees }));
R("PUT", "/api/catalog", (r) => { need(r.me, 10); db.catalog = { adm: cleanItems(r.body.adm), mm2: cleanItems(r.body.mm2) }; db.fees = cleanFees(r.body.fees); log(r.me, "Updated items and fees"); return { adm: db.catalog.adm, mm2: db.catalog.mm2, fees: db.fees }; });
R("POST", "/api/users/:id/comm", (r) => { need(r.me, 1); const t = userById(r.params.id); if (!t) throw new Err(404, "Member not found."); if (t.id !== r.me.id && RANK[r.me.role] < 10) throw new Err(403, "Only the Owner can set another middleman's commission."); const v = r.body.comm; if (v === null || v === "") t.comm = undefined; else { const c = Number(v); if (!(c >= 0 && c <= 100)) throw new Err(400, "Commission must be 0 to 100."); t.comm = Math.round(c * 10) / 10; } log(r.me, "Set commission", t.name + " " + (t.comm ?? "none") + "%"); return { ok: true }; });
// ---------------- server ----------------
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost"), p = decodeURIComponent(url.pathname);
    if (p === "/health") { res.writeHead(200); return res.end("ok"); }
    if (p.startsWith("/api/")) {
      if (limited(req.socket.remoteAddress)) return send(res, 429, { error: "Too many requests. Slow down." });
      const hit = routes.find(([m, re]) => m === req.method && re.test(p));
      if (!hit) return send(res, 404, { error: "Not found." });
      const body = ["POST", "PATCH", "PUT"].includes(req.method) ? await readBody(req) : {};
      return send(res, 200, await hit[2]({ req, body, params: hit[1].exec(p).groups || {}, me: authOf(req) }));
    }
    let f = path.resolve(ROOT, p === "/" ? "index.html" : p.slice(1));
    try { if (!f.startsWith(ROOT + path.sep) || !(await stat(f)).isFile()) throw 0; } catch { f = path.join(ROOT, "index.html"); }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] || "application/octet-stream", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
    res.end(await readFile(f));
  } catch (e) { if (e instanceof Err) return send(res, e.code, { error: e.message }); console.error(e); send(res, 400, { error: e.message === "too large" ? "Upload too large." : "Bad request." }); }
});
server.listen(PORT, "0.0.0.0", () => console.log("Bunny Team demo on port " + PORT));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
