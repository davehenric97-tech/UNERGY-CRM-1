// UNERGY CRM backend — Netlify Function
// Real server-side auth + authorization. The browser never sees other
// companies' data or any password hash — the server decides what a given
// token is allowed to read/write, on every request.

const crypto = require("crypto");
const { getStore } = require("@netlify/blobs");

const SECRET = process.env.SESSION_SECRET || "change-this-secret-before-real-use";
const store = () => getStore({
  name: "unergy-data",
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN,
});

// ---------- storage helpers ----------
async function getJSON(key) {
  const v = await store().get(key, { type: "json" });
  return v === null ? null : v;
}
async function setJSON(key, val) {
  await store().setJSON(key, val);
}
async function del(key) {
  await store().delete(key);
}
async function listKeys(prefix) {
  const { blobs } = await store().list({ prefix });
  return blobs.map((b) => b.key);
}

// ---------- password hashing (scrypt, built into Node — no extra deps) ----------
function randomSalt() {
  return crypto.randomBytes(16).toString("hex");
}
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}
function verifyPassword(password, salt, hash) {
  const check = hashPassword(password, salt);
  const a = Buffer.from(check, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function genTempPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < 10; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
async function genUniqueSubmitCode() {
  const existing = (await listKeys("submitcode-")).map((k) => k.replace("submitcode-", ""));
  let code, tries = 0;
  do { code = genCode(); tries++; } while (existing.indexOf(code) > -1 && tries < 25);
  return code;
}
function normEmail(e) { return (e || "").trim().toLowerCase(); }

// ---------- grid status (server-side fetch to gridstatus.io — API key never reaches the browser) ----------
function niceLabel(key) {
  return String(key).replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function pickColumns(row) {
  let tsKey = null;
  const valueKeys = [];
  Object.keys(row).forEach((k) => {
    const lk = k.toLowerCase();
    const v = row[k];
    if (tsKey === null && (lk.includes("time") || lk.includes("date") || lk.includes("interval"))) { tsKey = k; return; }
    if (typeof v === "number") valueKeys.push(k);
  });
  return { tsKey, valueKeys };
}
async function gridstatusQuery(datasetId, apiKey, params) {
  const qs = new URLSearchParams({ api_key: apiKey, ...params }).toString();
  const url = `https://api.gridstatus.io/v1/datasets/${datasetId}/query?${qs}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("gridstatus.io returned " + res.status);
  const json = await res.json();
  return Array.isArray(json) ? json : (json.data || []);
}
async function fetchGridStatus() {
  const apiKey = process.env.GRIDSTATUS_API_KEY;
  if (!apiKey) return { available: false, reason: "no_api_key" };
  const now = new Date();
  const start = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const timeParams = { start_time: start.toISOString(), end_time: now.toISOString() };

  let price = null, priceLabel = null, priceSeries = [];
  let debug = {};
  try {
    const rows = await gridstatusQuery("ercot_spp_day_ahead_hourly", apiKey, { ...timeParams, limit: 300 });
    debug.priceRowCount = rows.length;
    debug.priceSampleRow = rows[0] || null;
    if (rows.length) {
      const cols = pickColumns(rows[0]);
      debug.priceValueKeys = cols.valueKeys;
      if (cols.valueKeys.length) {
        const valKey = cols.valueKeys[0];
        priceSeries = rows.map((r) => parseFloat(r[valKey])).filter((v) => !isNaN(v));
        price = priceSeries.length ? priceSeries[priceSeries.length - 1] : null;
        priceLabel = niceLabel(valKey);
      }
    }
  } catch (e) { debug.priceError = e.message; }

  let load = null;
  try {
    const rows = await gridstatusQuery("ercot_load", apiKey, { ...timeParams, limit: 300 });
    debug.loadRowCount = rows.length;
    debug.loadSampleRow = rows[rows.length - 1] || null;
    if (rows.length) {
      const cols = pickColumns(rows[rows.length - 1]);
      debug.loadValueKeys = cols.valueKeys;
      if (cols.valueKeys.length) {
        const v = parseFloat(rows[rows.length - 1][cols.valueKeys[0]]);
        if (!isNaN(v)) load = v;
      }
    }
  } catch (e) { debug.loadError = e.message; }

  let fuelSeries = [], fuelKeys = [], latestMix = null, mainSource = null;
  try {
    const rows = await gridstatusQuery("ercot_fuel_mix", apiKey, { ...timeParams, limit: 200 });
    debug.fuelRowCount = rows.length;
    debug.fuelSampleRow = rows[rows.length - 1] || null;
    if (rows.length) {
      const keySet = {};
      fuelSeries = rows.map((r) => {
        const cols = pickColumns(r);
        const mix = {};
        cols.valueKeys.forEach((k) => {
          const v = parseFloat(r[k]);
          if (!isNaN(v)) { mix[k] = v; keySet[k] = true; }
        });
        return mix;
      });
      fuelKeys = Object.keys(keySet);
      latestMix = fuelSeries.length ? fuelSeries[fuelSeries.length - 1] : null;
      if (latestMix) {
        let best = null, bestVal = -1;
        Object.keys(latestMix).forEach((k) => { if (latestMix[k] > bestVal) { bestVal = latestMix[k]; best = k; } });
        mainSource = best ? niceLabel(best) : null;
      }
    }
  } catch (e) { debug.fuelError = e.message; }

  let netLoad = null;
  if (load !== null && latestMix) {
    const wind = latestMix["wind"] || 0;
    const solar = latestMix["solar"] || 0;
    netLoad = load - wind - solar;
  }

  if (price === null && !latestMix && load === null) return { available: false, reason: "fetch_failed", debug };
  return {
    available: true, price, priceLabel, priceSeries, load, netLoad, mainSource,
    fuelSeries, fuelKeys, fetchedAt: new Date().toISOString(), debug,
  };
}

// ---------- session tokens (signed, stateless — no server-side session storage needed) ----------
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  return body + "." + sig;
}
function verifyToken(token) {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  const expected = crypto.createHmac("sha256", SECRET).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(Buffer.from(body, "base64url").toString()); } catch (e) { return null; }
}

// ---------- bootstrap (first-run defaults) ----------
async function bootstrapIfNeeded() {
  const team = await getJSON("admin-team");
  if (team) return;
  const adminSalt = randomSalt(), demoSalt = randomSalt();
  const adminHash = hashPassword("Unergy2026!", adminSalt);
  const demoHash = hashPassword("password123", demoSalt);
  const adminId = "mem_" + crypto.randomBytes(4).toString("hex");
  const demoId = "mem_" + crypto.randomBytes(4).toString("hex");
  const coId = "co_" + crypto.randomBytes(4).toString("hex");
  const submitCode = genCode();

  const seedCo = {
    id: coId, name: "SunSaver", submitCode,
    people: [{ id: demoId, name: "Demo Reviewer", email: "demo@sunsaver.com" }],
  };
  await setJSON("admin-team", [{ id: adminId, name: "UNERGY Admin", email: "admin@unergypowercompany.com" }]);
  await setJSON("companies", [seedCo]);
  await setJSON("login-admin@unergypowercompany.com", {
    type: "admin", personId: adminId, personName: "UNERGY Admin",
    personEmail: "admin@unergypowercompany.com", passwordHash: adminHash, salt: adminSalt,
  });
  await setJSON("login-demo@sunsaver.com", {
    type: "partner", companyId: coId, companyName: "SunSaver", role: "review",
    personId: demoId, personName: "Demo Reviewer", personEmail: "demo@sunsaver.com",
    passwordHash: demoHash, salt: demoSalt,
  });
  await setJSON("submitcode-" + submitCode, { companyId: coId, companyName: "SunSaver" });
  await setJSON("deals-" + coId, []);
}

// ---------- authorization helpers ----------
function requireAdmin(session) {
  if (!session || session.role !== "admin") { const e = new Error("Forbidden"); e.status = 403; throw e; }
}
function requireCompanyAccess(session, companyId) {
  if (!session) { const e = new Error("Unauthorized"); e.status = 401; throw e; }
  if (session.role === "admin") return;
  if (session.role === "partner-review" && session.companyId === companyId) return;
  const e = new Error("Forbidden"); e.status = 403; throw e;
}
function stripPeopleSecrets(companies) {
  return companies.map((c) => ({
    id: c.id, name: c.name, submitCode: c.submitCode,
    people: (c.people || []).map((p) => ({ id: p.id, name: p.name, email: p.email })),
  }));
}

// ---------- main handler ----------
exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers: cors, body: "Method not allowed" };

  let body;
  try { body = JSON.parse(event.body || "{}"); } catch (e) { return { statusCode: 400, headers: cors, body: "Bad JSON" }; }
  const { action, params } = body;
  const p = params || {};

  const authHeader = event.headers.authorization || event.headers.Authorization || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  const session = verifyToken(token);

  try {
    await bootstrapIfNeeded();

    switch (action) {
      case "login": {
        const email = normEmail(p.email);
        const entry = await getJSON("login-" + email);
        if (!entry || !verifyPassword(p.password || "", entry.salt, entry.passwordHash)) {
          const e = new Error("Invalid email or password"); e.status = 401; throw e;
        }
        const sessionPayload = entry.type === "admin"
          ? { role: "admin", personName: entry.personName, personEmail: entry.personEmail }
          : { role: "partner-review", companyId: entry.companyId, companyName: entry.companyName,
              personName: entry.personName, personEmail: entry.personEmail };
        return ok(cors, { token: signToken(sessionPayload), session: sessionPayload });
      }

      case "submitCode": {
        const code = (p.code || "").trim().toUpperCase();
        const entry = await getJSON("submitcode-" + code);
        if (!entry) { const e = new Error("Access code not recognized"); e.status = 401; throw e; }
        const sessionPayload = { role: "partner-rep", companyId: entry.companyId, companyName: entry.companyName };
        return ok(cors, { token: signToken(sessionPayload), session: sessionPayload });
      }

      case "changeMyPassword": {
        if (!session || !session.personEmail) { const e = new Error("Unauthorized"); e.status = 401; throw e; }
        const key = "login-" + normEmail(session.personEmail);
        const entry = await getJSON(key);
        if (!entry || !verifyPassword(p.currentPassword || "", entry.salt, entry.passwordHash)) {
          const e = new Error("Current password is incorrect"); e.status = 401; throw e;
        }
        if (!p.newPassword || p.newPassword.length < 8) {
          const e = new Error("New password must be at least 8 characters"); e.status = 400; throw e;
        }
        const salt = randomSalt();
        entry.passwordHash = hashPassword(p.newPassword, salt);
        entry.salt = salt;
        await setJSON(key, entry);
        return ok(cors, { done: true });
      }

      case "getCompanies": {
        requireAdmin(session);
        const companies = (await getJSON("companies")) || [];
        return ok(cors, { companies: stripPeopleSecrets(companies) });
      }

      case "addCompany": {
        requireAdmin(session);
        const companies = (await getJSON("companies")) || [];
        const submitCode = await genUniqueSubmitCode();
        const co = { id: "co_" + crypto.randomBytes(4).toString("hex"), name: p.name, submitCode, people: [] };
        companies.push(co);
        await setJSON("companies", companies);
        await setJSON("submitcode-" + submitCode, { companyId: co.id, companyName: co.name });
        await setJSON("deals-" + co.id, []);
        return ok(cors, { companies: stripPeopleSecrets(companies) });
      }

      case "removeCompany": {
        requireAdmin(session);
        const companies = (await getJSON("companies")) || [];
        const co = companies.find((c) => c.id === p.companyId);
        if (co) {
          for (const person of co.people || []) await del("login-" + normEmail(person.email));
          await del("submitcode-" + co.submitCode);
          await del("deals-" + co.id);
        }
        const next = companies.filter((c) => c.id !== p.companyId);
        await setJSON("companies", next);
        return ok(cors, { companies: stripPeopleSecrets(next) });
      }

      case "regenSubmitCode": {
        requireAdmin(session);
        const companies = (await getJSON("companies")) || [];
        const co = companies.find((c) => c.id === p.companyId);
        if (!co) { const e = new Error("Company not found"); e.status = 404; throw e; }
        await del("submitcode-" + co.submitCode);
        const newCode = await genUniqueSubmitCode();
        co.submitCode = newCode;
        await setJSON("companies", companies);
        await setJSON("submitcode-" + newCode, { companyId: co.id, companyName: co.name });
        return ok(cors, { companies: stripPeopleSecrets(companies) });
      }

      case "addPerson": {
        requireAdmin(session);
        const email = normEmail(p.email);
        if (!p.name || !email || !p.password || p.password.length < 8) {
          const e = new Error("Name, email, and an 8+ character password are required"); e.status = 400; throw e;
        }
        if (await getJSON("login-" + email)) { const e = new Error("That email is already registered"); e.status = 409; throw e; }
        const companies = (await getJSON("companies")) || [];
        const co = companies.find((c) => c.id === p.companyId);
        if (!co) { const e = new Error("Company not found"); e.status = 404; throw e; }
        const salt = randomSalt();
        const hash = hashPassword(p.password, salt);
        const person = { id: "mem_" + crypto.randomBytes(4).toString("hex"), name: p.name, email };
        co.people = (co.people || []).concat([person]);
        await setJSON("companies", companies);
        await setJSON("login-" + email, {
          type: "partner", companyId: co.id, companyName: co.name, role: "review",
          personId: person.id, personName: p.name, personEmail: email, passwordHash: hash, salt,
        });
        return ok(cors, { companies: stripPeopleSecrets(companies) });
      }

      case "removePerson": {
        requireAdmin(session);
        const companies = (await getJSON("companies")) || [];
        const co = companies.find((c) => c.id === p.companyId);
        if (co) {
          const person = (co.people || []).find((m) => m.id === p.personId);
          if (person) await del("login-" + normEmail(person.email));
          co.people = (co.people || []).filter((m) => m.id !== p.personId);
        }
        await setJSON("companies", companies);
        return ok(cors, { companies: stripPeopleSecrets(companies) });
      }

      case "resetPersonPassword": {
        requireAdmin(session);
        if (!p.newPassword || p.newPassword.length < 8) {
          const e = new Error("New password must be at least 8 characters"); e.status = 400; throw e;
        }
        const companies = (await getJSON("companies")) || [];
        const co = companies.find((c) => c.id === p.companyId);
        const person = co && (co.people || []).find((m) => m.id === p.personId);
        if (!person) { const e = new Error("Person not found"); e.status = 404; throw e; }
        const salt = randomSalt();
        const hash = hashPassword(p.newPassword, salt);
        const loginKey = "login-" + normEmail(person.email);
        const entry = await getJSON(loginKey);
        entry.passwordHash = hash; entry.salt = salt;
        await setJSON(loginKey, entry);
        return ok(cors, { done: true });
      }

      case "getAdminTeam": {
        requireAdmin(session);
        const team = (await getJSON("admin-team")) || [];
        return ok(cors, { team: team.map((m) => ({ id: m.id, name: m.name, email: m.email })) });
      }

      case "addAdminMember": {
        requireAdmin(session);
        const email = normEmail(p.email);
        if (!p.name || !email || !p.password || p.password.length < 8) {
          const e = new Error("Name, email, and an 8+ character password are required"); e.status = 400; throw e;
        }
        if (await getJSON("login-" + email)) { const e = new Error("That email is already registered"); e.status = 409; throw e; }
        const team = (await getJSON("admin-team")) || [];
        const salt = randomSalt();
        const hash = hashPassword(p.password, salt);
        const member = { id: "mem_" + crypto.randomBytes(4).toString("hex"), name: p.name, email };
        team.push(member);
        await setJSON("admin-team", team);
        await setJSON("login-" + email, {
          type: "admin", personId: member.id, personName: p.name, personEmail: email, passwordHash: hash, salt,
        });
        return ok(cors, { team: team.map((m) => ({ id: m.id, name: m.name, email: m.email })) });
      }

      case "removeAdminMember": {
        requireAdmin(session);
        const team = (await getJSON("admin-team")) || [];
        const member = team.find((m) => m.id === p.memberId);
        if (member) await del("login-" + normEmail(member.email));
        const next = team.filter((m) => m.id !== p.memberId);
        await setJSON("admin-team", next);
        return ok(cors, { team: next.map((m) => ({ id: m.id, name: m.name, email: m.email })) });
      }

      case "resetAdminMemberPassword": {
        requireAdmin(session);
        if (!p.newPassword || p.newPassword.length < 8) {
          const e = new Error("New password must be at least 8 characters"); e.status = 400; throw e;
        }
        const team = (await getJSON("admin-team")) || [];
        const member = team.find((m) => m.id === p.memberId);
        if (!member) { const e = new Error("Member not found"); e.status = 404; throw e; }
        const salt = randomSalt();
        const hash = hashPassword(p.newPassword, salt);
        const loginKey = "login-" + normEmail(member.email);
        const entry = await getJSON(loginKey);
        entry.passwordHash = hash; entry.salt = salt;
        await setJSON(loginKey, entry);
        return ok(cors, { done: true });
      }

      case "getDeals": {
        requireCompanyAccess(session, p.companyId);
        const deals = (await getJSON("deals-" + p.companyId)) || [];
        return ok(cors, { deals });
      }

      case "getAllDeals": {
        requireAdmin(session);
        const companies = (await getJSON("companies")) || [];
        let all = [];
        for (const co of companies) {
          const deals = (await getJSON("deals-" + co.id)) || [];
          all = all.concat(deals);
        }
        return ok(cors, { deals: all });
      }

      case "setDeals": {
        requireCompanyAccess(session, p.companyId);
        await setJSON("deals-" + p.companyId, p.deals || []);
        return ok(cors, { done: true });
      }

      case "submitDeal": {
        // partner-rep or partner-review submitting a new lead for their own company
        if (!session || session.role === "admin") { const e = new Error("Unauthorized"); e.status = 401; throw e; }
        const deals = (await getJSON("deals-" + session.companyId)) || [];
        deals.push(p.deal);
        await setJSON("deals-" + session.companyId, deals);
        return ok(cors, { done: true });
      }

      case "getNotifications": {
        if (p.scope === "admin") requireAdmin(session);
        else requireCompanyAccess(session, p.scope);
        const notifs = (await getJSON("notif-" + p.scope)) || [];
        return ok(cors, { notifications: notifs });
      }

      case "setNotifications": {
        if (p.scope === "admin") requireAdmin(session);
        else requireCompanyAccess(session, p.scope);
        await setJSON("notif-" + p.scope, p.notifications || []);
        return ok(cors, { done: true });
      }

      case "pushNotification": {
        // internal use — any authenticated session may notify admin or their own company
        if (!session) { const e = new Error("Unauthorized"); e.status = 401; throw e; }
        const scope = p.scope;
        if (scope !== "admin") requireCompanyAccess(session, scope);
        const notifs = (await getJSON("notif-" + scope)) || [];
        notifs.unshift({ id: "ntf_" + crypto.randomBytes(4).toString("hex"), message: p.message, createdAt: new Date().toISOString(), read: false });
        await setJSON("notif-" + scope, notifs.slice(0, 60));
        return ok(cors, { done: true });
      }

      case "getMessages": {
        requireCompanyAccess(session, p.companyId);
        const msgs = (await getJSON("msgs-" + p.companyId)) || [];
        return ok(cors, { messages: msgs });
      }

      case "getAllMessages": {
        requireAdmin(session);
        const companies = (await getJSON("companies")) || [];
        const byCompany = {};
        for (const co of companies) byCompany[co.id] = (await getJSON("msgs-" + co.id)) || [];
        return ok(cors, { messagesByCompany: byCompany });
      }

      case "getGridStatus": {
        if (!session) { const e = new Error("Unauthorized"); e.status = 401; throw e; }
        const data = await fetchGridStatus();
        return ok(cors, data);
      }

      case "sendMessage": {
        requireCompanyAccess(session, p.companyId);
        const isAdmin = session.role === "admin";
        const msgs = (await getJSON("msgs-" + p.companyId)) || [];
        msgs.push({
          id: "msg_" + crypto.randomBytes(4).toString("hex"),
          from: isAdmin ? "admin" : "partner",
          text: p.text, authorName: session.personName || (isAdmin ? "UNERGY" : session.companyName),
          dealId: p.dealId || null, dealLabel: p.dealLabel || null,
          createdAt: new Date().toISOString(),
          readByAdmin: isAdmin, readByPartner: !isAdmin,
        });
        await setJSON("msgs-" + p.companyId, msgs);
        return ok(cors, { done: true });
      }

      default:
        return { statusCode: 404, headers: cors, body: "Unknown action" };
    }
  } catch (err) {
    return { statusCode: err.status || 500, headers: cors, body: JSON.stringify({ error: err.message || "Server error" }) };
  }
};

function ok(cors, data) {
  return { statusCode: 200, headers: { ...cors, "Content-Type": "application/json" }, body: JSON.stringify(data) };
}
}
