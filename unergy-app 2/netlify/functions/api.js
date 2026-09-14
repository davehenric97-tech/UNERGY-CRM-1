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

// ---------- Notion import (server-side fetch — the integration token never reaches the browser) ----------
function extractNotionValue(prop) {
  if (!prop) return "";
  switch (prop.type) {
    case "title": return (prop.title || []).map((t) => t.plain_text).join("");
    case "rich_text": return (prop.rich_text || []).map((t) => t.plain_text).join("");
    case "email": return prop.email || "";
    case "phone_number": return prop.phone_number || "";
    case "number": return prop.number != null ? String(prop.number) : "";
    case "select": return prop.select ? prop.select.name : "";
    case "status": return prop.status ? prop.status.name : "";
    case "multi_select": return (prop.multi_select || []).map((o) => o.name).join(", ");
    case "date": return prop.date ? (prop.date.start || "") : "";
    case "checkbox": return prop.checkbox ? "Yes" : "No";
    case "url": return prop.url || "";
    case "people": return (prop.people || []).map((pp) => pp.name || "").join(", ");
    case "formula": return extractNotionValue({ type: prop.formula.type, [prop.formula.type]: prop.formula[prop.formula.type] });
    case "rollup": {
      if (prop.rollup.type === "array") return (prop.rollup.array || []).map((v) => extractNotionValue(v)).filter(Boolean).join(", ");
      const rv = prop.rollup[prop.rollup.type];
      return rv != null ? String(rv) : "";
    }
    default: return "";
  }
}
async function fetchNotionDatabase(databaseId, apiKey) {
  const headersSet = {};
  const allRows = [];
  let cursor = undefined;
  let hasMore = true;
  let guard = 0;
  while (hasMore && guard < 20) {
    guard++;
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const res = await fetch(`https://api.notion.com/v1/databases/${databaseId}/query`, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const suffix = res.status === 404 ? " — check the database was shared with your integration" : "";
      throw new Error("Notion returned " + res.status + suffix);
    }
    const json = await res.json();
    (json.results || []).forEach((page) => {
      const row = {};
      const props = page.properties || {};
      Object.keys(props).forEach((key) => {
        headersSet[key] = true;
        row[key] = extractNotionValue(props[key]);
      });
      allRows.push(row);
    });
    hasMore = !!json.has_more;
    cursor = json.next_cursor;
  }
  return { headers: Object.keys(headersSet), rows: allRows };
}

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
  try {
    const rows = await gridstatusQuery("ercot_spp_day_ahead_hourly", apiKey, { ...timeParams, limit: 300 });
    if (rows.length) {
      const cols = pickColumns(rows[0]);
      if (cols.valueKeys.length) {
        const valKey = cols.valueKeys[0];
        priceSeries = rows.map((r) => parseFloat(r[valKey])).filter((v) => !isNaN(v));
        price = priceSeries.length ? priceSeries[priceSeries.length - 1] : null;
        priceLabel = niceLabel(valKey);
      }
    }
  } catch (e) { /* price stays empty if this fails (e.g. rate limited) */ }

  let load = null;
  try {
    const rows = await gridstatusQuery("ercot_load", apiKey, { ...timeParams, limit: 300 });
    if (rows.length) {
      const cols = pickColumns(rows[rows.length - 1]);
      if (cols.valueKeys.length) {
        const v = parseFloat(rows[rows.length - 1][cols.valueKeys[0]]);
        if (!isNaN(v)) load = v;
      }
    }
  } catch (e) { /* load stays empty if this fails (e.g. rate limited) */ }

  let fuelSeries = [], fuelKeys = [], latestMix = null, mainSource = null;
  try {
    const rows = await gridstatusQuery("ercot_fuel_mix", apiKey, { ...timeParams, limit: 200 });
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
  } catch (e) { /* fuel mix is best-effort (e.g. rate limited) */ }

  let netLoad = null;
  if (load !== null && latestMix) {
    const wind = latestMix["wind"] || 0;
    const solar = latestMix["solar"] || 0;
    netLoad = load - wind - solar;
  }

  if (price === null && !latestMix && load === null) return { available: false, reason: "fetch_failed" };
  return {
    available: true, price, priceLabel, priceSeries, load, netLoad, mainSource,
    fuelSeries, fuelKeys, fetchedAt: new Date().toISOString(),
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
    id: coId, name: "SunSaver", submitCode, apiKey: crypto.randomBytes(20).toString("hex"),
    vppFormEnabled: true, energyFormEnabled: false, energyFormCode: null,
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
  await setJSON("apikey-" + seedCo.apiKey, { companyId: coId, companyName: "SunSaver" });
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
// ---------- demo-mode toggle: full-number capture for testing (off by default) ----------
async function getDemoFullCapture() {
  const s = await getJSON("app-settings");
  return !!(s && s.demoFullCapture);
}

function stripPeopleSecrets(companies) {
  return companies.map((c) => ({
    id: c.id, name: c.name, submitCode: c.submitCode, apiKey: c.apiKey || null, notifyEmail: c.notifyEmail || "",
    vppFormEnabled: c.vppFormEnabled !== false, energyFormCode: c.energyFormCode || null, energyFormEnabled: !!c.energyFormEnabled,
    people: (c.people || []).map((p) => ({ id: p.id, name: p.name, email: p.email })),
  }));
}

// ---------- email notifications (Resend — best-effort, never blocks a submission from saving) ----------
async function sendEmail(to, subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  const list = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
  if (!apiKey || !list.length) return;
  const from = process.env.NOTIFY_FROM_EMAIL || "UNERGY CRM <onboarding@resend.dev>";
  try {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": "Bearer " + apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: list, subject, html }),
    });
  } catch (e) { /* email is a courtesy notification — a failure here must never block the deal from saving */ }
}
async function notifyNewSubmission(deal, companyName, companyNotifyEmail) {
  const adminList = (process.env.NOTIFY_ADMIN_EMAILS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const customerLine = deal.customerName || "a client";
  const addressLine = deal.serviceAddress ? `<p>Service address: ${escapeHtml(deal.serviceAddress)}</p>` : "";
  if (adminList.length) {
    await sendEmail(
      adminList,
      "New deal submitted — " + customerLine,
      `<p><strong>${escapeHtml(companyName)}</strong> just submitted a new account: <strong>${escapeHtml(customerLine)}</strong>. This needs prompt attention.</p>${addressLine}<p>Log in to UNERGY CRM to review it.</p>`
    );
  }
  if (companyNotifyEmail) {
    await sendEmail(
      companyNotifyEmail,
      "Your submission was received — " + customerLine,
      `<p>Thanks — we've received your submission for <strong>${escapeHtml(customerLine)}</strong>. UNERGY will follow up shortly.</p>`
    );
  }
}
function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ---------- external partner API (a company's own software calls this — never a browser session) ----------
function stripDealForApi(d) {
  // billFile is dropped from LIST responses (it's a full base64 image and
  // would bloat a "give me everyone's status" call) but is still fully
  // stored and visible to both sides in the actual web dashboard.
  const { billingLog, hiddenFromPartner, billFile, ...rest } = d;
  return rest;
}
const MAX_BILL_FILE_B64_CHARS = 6 * 1024 * 1024; // ~4.5MB decoded — keeps total request comfortably under Netlify's payload limit
function validateBillFile(billFile) {
  if (!billFile) return null;
  if (typeof billFile !== "object" || !billFile.dataUrl || !billFile.dataUrl.startsWith("data:")) {
    const e = new Error("billFile must be an object with a dataUrl (a data: URL, e.g. what FileReader.readAsDataURL produces)");
    e.status = 400; throw e;
  }
  if (billFile.dataUrl.length > MAX_BILL_FILE_B64_CHARS) {
    const e = new Error("billFile is too large — please compress it below ~4.5MB before sending");
    e.status = 400; throw e;
  }
  return { name: billFile.name || "bill", type: billFile.type || "application/octet-stream", dataUrl: billFile.dataUrl };
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
  let session = verifyToken(token);

  // A partner's own software authenticates with a per-company API key instead
  // of a browser session token — completely separate credential, completely
  // separate (much narrower) set of things it's allowed to do.
  const partnerApiKey = event.headers["x-partner-api-key"] || event.headers["X-Partner-Api-Key"];
  let isPartnerApiKey = false;
  if (!session && partnerApiKey) {
    const mapping = await getJSON("apikey-" + partnerApiKey);
    if (mapping) {
      session = { role: "partner-api", companyId: mapping.companyId, companyName: mapping.companyName };
      isPartnerApiKey = true;
    }
  }

  try {
    await bootstrapIfNeeded();

    if (isPartnerApiKey && action !== "apiListAccounts" && action !== "apiSubmitAccount") {
      const e = new Error("This API key can only be used with apiListAccounts and apiSubmitAccount"); e.status = 403; throw e;
    }

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
        return ok(cors, { token: signToken(sessionPayload), session: sessionPayload, demoFullCapture: await getDemoFullCapture() });
      }

      case "submitCode": {
        const code = (p.code || "").trim().toUpperCase();
        const vppEntry = await getJSON("submitcode-" + code);
        if (vppEntry) {
          const companies = (await getJSON("companies")) || [];
          const co = companies.find((c) => c.id === vppEntry.companyId);
          if (!co || co.vppFormEnabled === false) { const e = new Error("This form isn't currently accepting submissions"); e.status = 403; throw e; }
          const sessionPayload = { role: "partner-rep", companyId: vppEntry.companyId, companyName: vppEntry.companyName, formType: "vpp" };
          return ok(cors, { token: signToken(sessionPayload), session: sessionPayload, demoFullCapture: await getDemoFullCapture() });
        }
        const energyEntry = await getJSON("energycode-" + code);
        if (energyEntry) {
          const companies = (await getJSON("companies")) || [];
          const co = companies.find((c) => c.id === energyEntry.companyId);
          if (!co || !co.energyFormEnabled) { const e = new Error("This form isn't currently accepting submissions"); e.status = 403; throw e; }
          const sessionPayload = { role: "partner-rep", companyId: energyEntry.companyId, companyName: energyEntry.companyName, formType: "energy" };
          return ok(cors, { token: signToken(sessionPayload), session: sessionPayload, demoFullCapture: await getDemoFullCapture() });
        }
        const e = new Error("Access code not recognized"); e.status = 401; throw e;
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
        // Self-heal: any company created before API keys existed gets one now.
        let changed = false;
        for (const co of companies) {
          if (!co.apiKey) {
            co.apiKey = crypto.randomBytes(20).toString("hex");
            await setJSON("apikey-" + co.apiKey, { companyId: co.id, companyName: co.name });
            changed = true;
          }
        }
        if (changed) await setJSON("companies", companies);
        return ok(cors, { companies: stripPeopleSecrets(companies) });
      }

      case "addCompany": {
        requireAdmin(session);
        const companies = (await getJSON("companies")) || [];
        const submitCode = await genUniqueSubmitCode();
        const apiKey = crypto.randomBytes(20).toString("hex");
        const co = { id: "co_" + crypto.randomBytes(4).toString("hex"), name: p.name, submitCode, apiKey, vppFormEnabled: true, energyFormEnabled: false, energyFormCode: null, people: [] };
        companies.push(co);
        await setJSON("companies", companies);
        await setJSON("submitcode-" + submitCode, { companyId: co.id, companyName: co.name });
        await setJSON("apikey-" + apiKey, { companyId: co.id, companyName: co.name });
        await setJSON("deals-" + co.id, []);
        return ok(cors, { companies: stripPeopleSecrets(companies) });
      }

      case "regenApiKey": {
        requireAdmin(session);
        const companies = (await getJSON("companies")) || [];
        const co = companies.find((c) => c.id === p.companyId);
        if (!co) { const e = new Error("Company not found"); e.status = 404; throw e; }
        if (co.apiKey) await del("apikey-" + co.apiKey);
        const newKey = crypto.randomBytes(20).toString("hex");
        co.apiKey = newKey;
        await setJSON("companies", companies);
        await setJSON("apikey-" + newKey, { companyId: co.id, companyName: co.name });
        return ok(cors, { companies: stripPeopleSecrets(companies) });
      }

      case "removeCompany": {
        requireAdmin(session);
        const companies = (await getJSON("companies")) || [];
        const co = companies.find((c) => c.id === p.companyId);
        if (co) {
          for (const person of co.people || []) await del("login-" + normEmail(person.email));
          await del("submitcode-" + co.submitCode);
          if (co.apiKey) await del("apikey-" + co.apiKey);
          if (co.energyFormCode) await del("energycode-" + co.energyFormCode);
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

      case "setVppFormEnabled": {
        requireAdmin(session);
        const companies = (await getJSON("companies")) || [];
        const co = companies.find((c) => c.id === p.companyId);
        if (!co) { const e = new Error("Company not found"); e.status = 404; throw e; }
        co.vppFormEnabled = !!p.enabled;
        await setJSON("companies", companies);
        return ok(cors, { companies: stripPeopleSecrets(companies) });
      }

      case "setEnergyFormEnabled": {
        requireAdmin(session);
        const companies = (await getJSON("companies")) || [];
        const co = companies.find((c) => c.id === p.companyId);
        if (!co) { const e = new Error("Company not found"); e.status = 404; throw e; }
        co.energyFormEnabled = !!p.enabled;
        if (co.energyFormEnabled && !co.energyFormCode) {
          const newCode = await genUniqueSubmitCode();
          co.energyFormCode = newCode;
          await setJSON("energycode-" + newCode, { companyId: co.id, companyName: co.name });
        }
        await setJSON("companies", companies);
        return ok(cors, { companies: stripPeopleSecrets(companies) });
      }

      case "regenEnergyCode": {
        requireAdmin(session);
        const companies = (await getJSON("companies")) || [];
        const co = companies.find((c) => c.id === p.companyId);
        if (!co) { const e = new Error("Company not found"); e.status = 404; throw e; }
        if (co.energyFormCode) await del("energycode-" + co.energyFormCode);
        const newCode = await genUniqueSubmitCode();
        co.energyFormCode = newCode;
        await setJSON("companies", companies);
        await setJSON("energycode-" + newCode, { companyId: co.id, companyName: co.name });
        return ok(cors, { companies: stripPeopleSecrets(companies) });
      }

      case "getAppSettings": {
        requireAdmin(session);
        return ok(cors, { demoFullCapture: await getDemoFullCapture() });
      }

      case "setDemoFullCapture": {
        requireAdmin(session);
        await setJSON("app-settings", { demoFullCapture: !!p.enabled });
        return ok(cors, { demoFullCapture: !!p.enabled });
      }

      case "setNotifyEmail": {
        requireAdmin(session);
        const companies = (await getJSON("companies")) || [];
        const co = companies.find((c) => c.id === p.companyId);
        if (!co) { const e = new Error("Company not found"); e.status = 404; throw e; }
        co.notifyEmail = (p.email || "").trim();
        await setJSON("companies", companies);
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
        // Partners never see accounts admin has marked hidden-from-partner —
        // admin's own view (getAllDeals) always sees everything.
        const visible = session.role === "admin" ? deals : deals.filter((d) => !d.hiddenFromPartner);
        return ok(cors, { deals: visible });
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

      case "moveDeal": {
        requireAdmin(session);
        const { dealId, fromCompanyId, toCompanyId } = p;
        if (!dealId || !fromCompanyId || !toCompanyId) { const e = new Error("Missing dealId, fromCompanyId, or toCompanyId"); e.status = 400; throw e; }
        if (fromCompanyId === toCompanyId) { const e = new Error("That's already where this account is"); e.status = 400; throw e; }
        const fromDeals = (await getJSON("deals-" + fromCompanyId)) || [];
        const idx = fromDeals.findIndex((d) => d.id === dealId);
        if (idx === -1) { const e = new Error("Account not found"); e.status = 404; throw e; }
        const deal = fromDeals[idx];
        deal.companyId = toCompanyId;
        deal.updatedAt = new Date().toISOString();
        deal.updatedBy = p.actorLabel || deal.updatedBy;
        const remaining = fromDeals.filter((d) => d.id !== dealId);
        await setJSON("deals-" + fromCompanyId, remaining);
        const toDeals = (await getJSON("deals-" + toCompanyId)) || [];
        toDeals.push(deal);
        await setJSON("deals-" + toCompanyId, toDeals);
        return ok(cors, { deal });
      }

      case "submitDeal": {
        // partner-rep or partner-review submitting a new lead for their own company
        if (!session || session.role === "admin") { const e = new Error("Unauthorized"); e.status = 401; throw e; }
        const deals = (await getJSON("deals-" + session.companyId)) || [];
        deals.push(p.deal);
        await setJSON("deals-" + session.companyId, deals);
        const companiesForNotify = (await getJSON("companies")) || [];
        const coForNotify = companiesForNotify.find((c) => c.id === session.companyId);
        await notifyNewSubmission(p.deal, session.companyName, coForNotify && coForNotify.notifyEmail).catch(() => {});
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

      case "notionFetch": {
        requireAdmin(session);
        const notionKey = process.env.NOTION_API_KEY;
        if (!notionKey) { const e = new Error("Notion isn't connected yet — add a NOTION_API_KEY environment variable in Netlify."); e.status = 400; throw e; }
        if (!p.databaseId) { const e = new Error("Missing database ID"); e.status = 400; throw e; }
        const data = await fetchNotionDatabase(p.databaseId, notionKey);
        return ok(cors, data);
      }

      case "apiListAccounts": {
        if (!session || session.role !== "partner-api") { const e = new Error("Unauthorized"); e.status = 401; throw e; }
        const deals = (await getJSON("deals-" + session.companyId)) || [];
        const visible = deals.filter((d) => !d.hiddenFromPartner).map(stripDealForApi);
        return ok(cors, { accounts: visible });
      }

      case "apiSubmitAccount": {
        if (!session || session.role !== "partner-api") { const e = new Error("Unauthorized"); e.status = 401; throw e; }
        if (!p.customerName) { const e = new Error("customerName is required"); e.status = 400; throw e; }
        const now = new Date().toISOString();
        const newAccount = {
          id: "acct_" + crypto.randomBytes(6).toString("hex"),
          companyId: session.companyId, source: "api",
          customerName: p.customerName || "", businessName: p.businessName || "", ownsOrRents: p.ownsOrRents || "",
          email: p.email || "", phone: p.phone || "", serviceAddress: p.serviceAddress || "", billingAddress: p.billingAddress || "",
          solarBattery: p.solarBattery || "Solar and Battery", propertyType: p.propertyType || "Residential",
          tdu: p.tdu || "", currentREP: p.currentREP || "", esiid: p.esiid || "",
          contractTerm: p.contractTerm || "12", priceKWH: p.priceKWH || "", salesRepName: p.salesRepName || "",
          intakeDate: now.slice(0, 10), contractSentDate: "", contractSignedDate: "", startDate: "",
          status: "NEW", notes: p.notes || "", billFile: validateBillFile(p.billFile),
          switchHold: "No", paymentStatus: "Current", vppEnabled: "No", batteryBrand: "", billingLog: [],
          createdAt: now, updatedAt: now, createdBy: "API — " + session.companyName, updatedBy: "API — " + session.companyName,
        };
        const deals = (await getJSON("deals-" + session.companyId)) || [];
        deals.push(newAccount);
        await setJSON("deals-" + session.companyId, deals);
        const notifs = (await getJSON("notif-admin")) || [];
        notifs.unshift({ id: "ntf_" + crypto.randomBytes(4).toString("hex"), message: session.companyName + " submitted a new client via API: " + newAccount.customerName, createdAt: now, read: false });
        await setJSON("notif-admin", notifs.slice(0, 60));
        const companiesForNotify2 = (await getJSON("companies")) || [];
        const coForNotify2 = companiesForNotify2.find((c) => c.id === session.companyId);
        await notifyNewSubmission(newAccount, session.companyName, coForNotify2 && coForNotify2.notifyEmail).catch(() => {});
        return ok(cors, { account: stripDealForApi(newAccount) });
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
