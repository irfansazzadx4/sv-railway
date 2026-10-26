/**
 * NID Service Bot — WhatsApp Cloud API
 * ✅ Self-built HTML (no PHP dependency)
 * ✅ Default version per user (.setversion v1/v2/v3)
 * ✅ Fast reply (markRead AFTER processing)
 * ✅ PDF upload → API extract → HTML build → PDF → WhatsApp
 * ✅ Per-user custom card price (না থাকলে global default price)
 * ✅ SV Service এর জন্য আলাদা price (per-user override + global default)
 * ✅ Admin panel থেকে সব active user কে broadcast message
 */

const express  = require("express");
const axios    = require("axios");
const fs       = require("fs");
const path     = require("path");
const crypto   = require("crypto");
const FormData = require("form-data");

// ─────────────────────────── CONFIG ───────────────────────────
const CONFIG = {
  PORT: process.env.PORT || 3000,
  ADMIN_PASS: process.env.ADMIN_PASS || "admin123",

  WA_TOKEN:        process.env.WHATSAPP_TOKEN,
  WA_PHONE_ID:     process.env.WHATSAPP_PHONE_ID,
  WA_VERIFY_TOKEN: process.env.WHATSAPP_VERIFY_TOKEN || "myVerifyToken123",
  WA_API_VERSION:  "v21.0",

  API_EXTRACT_URL: "http://onlinebd.duckdns.org/api_proxy_server.php",
  SITE_BASE:       "https://dakhila-ldtax-gov-bd.rf.gd",
  ASSETS:          "http://onlinebd.duckdns.org",

  // ✅ SV API গুলোর key এখন env থেকে (code এ আর hardcode নেই)
  SV_API1_URL: process.env.SV_API1_URL || "https://onlinebd.duckdns.org/api_check.php",
  SV_API1_KEY: process.env.SV_API1_KEY,
  SV_API2_URL: process.env.SV_API2_URL,   // VIP API
  SV_API2_KEY: process.env.SV_API2_KEY,

  // ✅ VIP response GitHub এ user ভিত্তিক folder এ save করতে (ঐচ্ছিক) — PRIVATE repo ব্যবহার করুন
  GITHUB_TOKEN:  process.env.GITHUB_TOKEN,
  GITHUB_REPO:   process.env.GITHUB_REPO,   // "owner/repo"
  GITHUB_BRANCH: process.env.GITHUB_BRANCH || "main",

  // ✅ Meta / WhatsApp নিরাপত্তা ও broadcast
  WA_APP_SECRET:           process.env.WHATSAPP_APP_SECRET,      // webhook signature যাচাই (Meta App → Settings → Basic)
  ADMIN_WA_NUMBER:         process.env.ADMIN_WA_NUMBER,          // গুরুতর Meta alert এই নম্বরে আসবে
  BROADCAST_TEMPLATE_NAME: process.env.BROADCAST_TEMPLATE_NAME,  // approved template (১টা {{1}} variable সহ)
  BROADCAST_TEMPLATE_LANG: process.env.BROADCAST_TEMPLATE_LANG || "bn",

  PDF_API_URL:    process.env.PDF_API_URL,
  PDF_API_SECRET: process.env.PDF_API_SECRET,

  BASE_URL:    process.env.RENDER_EXTERNAL_URL || "https://nidservicebd.onrender.com",
  STORAGE_DIR: path.join(__dirname, "storage"),
  DATA_DIR:    path.join(__dirname, "data"),

  MONGO_URI: process.env.MONGO_URI,
};

if (!fs.existsSync(CONFIG.STORAGE_DIR)) fs.mkdirSync(CONFIG.STORAGE_DIR, { recursive: true });
if (!fs.existsSync(CONFIG.DATA_DIR))    fs.mkdirSync(CONFIG.DATA_DIR,    { recursive: true });

const USERS_FILE        = path.join(CONFIG.DATA_DIR, "users.json");
const STATS_FILE        = path.join(CONFIG.DATA_DIR, "stats.json");
const SETTINGS_FILE     = path.join(CONFIG.DATA_DIR, "settings.json");
const TRANSACTIONS_FILE = path.join(CONFIG.DATA_DIR, "transactions.json"); // ✅ প্রতিটা job এর আলাদা log
const RESPONSES_FILE    = path.join(CONFIG.DATA_DIR, "responses.json");    // ✅ VIP API response (২৪ ঘণ্টা)

// ─────────────────────────── HELPERS ───────────────────────────
const loadJSON = (f, def) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return def; } };
const saveJSON = (f, d)   => fs.writeFileSync(f, JSON.stringify(d, null, 2));

const getUsers    = () => loadJSON(USERS_FILE,    []);
const saveUsers   = (u) => saveJSON(USERS_FILE,   u);
const getStats    = () => loadJSON(STATS_FILE,    {});
const saveStats   = (s) => saveJSON(STATS_FILE,   s);
// ✅ svPrice যোগ হলো global settings এ
const getSettings = () => loadJSON(SETTINGS_FILE, { cardPrice: 0, svPrice: 0, sv2Price: 0, svCost: 0, sv2Cost: 0 });
const saveSettings= (s) => saveJSON(SETTINGS_FILE, s);
const getTransactions  = () => loadJSON(TRANSACTIONS_FILE, []);  // ✅ job log
const saveTransactions = (t) => saveJSON(TRANSACTIONS_FILE, t);

function normalizeNumber(num) {
  let n = String(num).replace(/\D/g, "");
  if (n.startsWith("0")) n = "880" + n.slice(1);
  if (!n.startsWith("880") && n.length === 10) n = "880" + n;
  return n;
}

function getUser(number) {
  return getUsers().find(x => normalizeNumber(x.number) === normalizeNumber(number));
}

function isAllowed(number) {
  const users = getUsers();
  if (users.length === 0) return false;
  const u = users.find(x => normalizeNumber(x.number) === normalizeNumber(number));
  return u && u.active !== false;
}

function getUserBalance(number) {
  const u = getUser(number);
  return u ? (u.balance || 0) : 0;
}

function getUserDefaultVersion(number) {
  const u = getUser(number);
  return u ? (u.defaultVersion || 0) : 0;
}

function setUserDefaultVersion(number, version) {
  const users = getUsers();
  const idx = users.findIndex(x => normalizeNumber(x.number) === normalizeNumber(number));
  if (idx !== -1) {
    users[idx].defaultVersion = version;
    saveUsers(users);
    return true;
  }
  return false;
}

// ── SV Service Mode helpers ──
function getUserServiceMode(number) {
  const u = getUser(number);
  return u ? (u.serviceMode || "default") : "default";
}

function setUserServiceMode(number, mode) {
  const users = getUsers();
  const idx = users.findIndex(x => normalizeNumber(x.number) === normalizeNumber(number));
  if (idx !== -1) {
    users[idx].serviceMode = mode;
    saveUsers(users);
    return true;
  }
  return false;
}

// ✅ প্রতিটা user এর জন্য নিজস্ব PDF card price (না থাকলে global default price)
function getCardPriceForUser(number) {
  const u = getUser(number);
  if (u && u.price !== undefined && u.price !== null && u.price !== "") return u.price;
  return getSettings().cardPrice || 0;
}

// ✅ NEW: SV service এর জন্য আলাদা price (per-user override, না থাকলে global default svPrice)
function getSVPriceForUser(number) {
  const u = getUser(number);
  if (u && u.svPrice !== undefined && u.svPrice !== null && u.svPrice !== "") return u.svPrice;
  return getSettings().svPrice || 0;
}

// ✅ SV2 (VIP API) এর জন্য আলাদা price (per-user override, না থাকলে global default sv2Price)
function getSV2PriceForUser(number) {
  const u = getUser(number);
  if (u && u.sv2Price !== undefined && u.sv2Price !== null && u.sv2Price !== "") return u.sv2Price;
  return getSettings().sv2Price || 0;
}

// mode: "pdf" | "sv" (SV1 API) | "sv2" (VIP API)
function getPriceForUser(number, mode = "pdf") {
  if (mode === "sv")  return getSVPriceForUser(number);
  if (mode === "sv2") return getSV2PriceForUser(number);
  return getCardPriceForUser(number);
}

function modeLabel(mode) {
  return mode === "sv" ? "SV1" : mode === "sv2" ? "SV2 (VIP)" : "PDF";
}

// আমাদের নিজস্ব API খরচ (লাভের হিসাবের জন্য)
function getApiCost(mode) {
  const s = getSettings();
  if (mode === "sv")  return s.svCost  || 0;
  if (mode === "sv2") return s.sv2Cost || 0;
  return 0;
}

// ✅ per-user SV1 / SV2 on-off (কিছু সেট না থাকলে ডিফল্টে চালু)
function isApiEnabled(number, api) { // api: "sv1" | "sv2"
  const u = getUser(number);
  return !u || u[api + "Enabled"] !== false;
}

// ✅ UPDATED: mode-aware deduct — PDF আর SV আলাদাভাবে balance কাটবে
function deductBalance(number, mode = "pdf") {
  const users = getUsers();
  const price = getPriceForUser(number, mode);
  if (price === 0) return true;
  const idx = users.findIndex(x => normalizeNumber(x.number) === normalizeNumber(number));
  if (idx === -1) return false;
  if ((users[idx].balance || 0) < price) return false;
  users[idx].balance = (users[idx].balance || 0) - price;
  saveUsers(users);
  return true;
}

function recordStat(number) {
  const stats = getStats();
  const key   = normalizeNumber(number);
  if (!stats[key]) stats[key] = { count: 0, lastUsed: null };
  stats[key].count++;
  stats[key].lastUsed = new Date().toISOString();
  saveStats(stats);
}

// ✅ প্রতিটা সফল job এর আলাদা log — কে, কখন, কোন API/version, কত টাকা কাটলো, আমাদের API খরচ কত
function recordTransaction(number, { mode, version, price, nid, name }) {
  const txs = getTransactions();
  txs.push({
    number:  normalizeNumber(number),
    mode:    mode    || "pdf",
    version: version || 0,
    price:   price   || 0,
    cost:    getApiCost(mode), // ✅ আমাদের নিজস্ব API খরচ (লাভের হিসাবের জন্য)
    nid:     nid      || "",
    name:    name     || "",
    time:    new Date().toISOString(),
  });
  // ফাইল যেন অসীম বড় না হয় — সর্বশেষ ৫০০০ টা entry
  if (txs.length > 5000) txs.splice(0, txs.length - 5000);
  saveTransactions(txs);
}

// টাকা কাটার পর card তৈরি fail করলে refund করার জন্য
function refundBalance(number, amount) {
  if (!amount) return;
  const users = getUsers();
  const idx = users.findIndex(x => normalizeNumber(x.number) === normalizeNumber(number));
  if (idx !== -1) {
    users[idx].balance = (users[idx].balance || 0) + amount;
    saveUsers(users);
  }
}

// ✅ "আজ" এখন বাংলাদেশ সময় (Asia/Dhaka) অনুযায়ী — আগে UTC ছিল, তাই সকাল ৬টায় দিন বদলে যেত
const dhakaDay = (d) => new Date(d).toLocaleDateString("en-CA", { timeZone: "Asia/Dhaka" });
function isToday(isoTime) {
  return !!isoTime && dhakaDay(isoTime) === dhakaDay(Date.now());
}

const sumBy = (arr, k) => arr.reduce((s, t) => s + (t[k] || 0), 0);

// একজন user এর সম্পূর্ণ history + today/total summary
function getUserTxSummary(number) {
  const n     = normalizeNumber(number);
  const all   = getTransactions().filter(t => t.number === n);
  const today = all.filter(t => isToday(t.time));
  return {
    count:      all.length,
    totalSpent: sumBy(all, "price"),
    totalCost:  sumBy(all, "cost"),
    todayCount: today.length,
    todaySpent: sumBy(today, "price"),
    todayCost:  sumBy(today, "cost"),
    list:       all.slice().reverse(), // সর্বশেষটা আগে
  };
}

// আজকে কোন user কতটা কাজ করলো, কত টাকা কাটলো, আমাদের কত খরচ — admin dashboard এর জন্য
function getTodayActivitySummary() {
  const txs   = getTransactions().filter(t => isToday(t.time));
  const users = getUsers();
  const map   = new Map();
  for (const t of txs) {
    if (!map.has(t.number)) map.set(t.number, { number: t.number, jobs: 0, spent: 0, cost: 0 });
    const row = map.get(t.number);
    row.jobs++;
    row.spent += t.price || 0;
    row.cost  += t.cost  || 0;
  }
  return [...map.values()]
    .map(r => ({ ...r, name: users.find(u => normalizeNumber(u.number) === r.number)?.name || "" }))
    .sort((a, b) => b.jobs - a.jobs);
}

function toBn(num) {
  if (num === undefined || num === null) return "";
  const digits = String(num);
  const bnDigits = {
    '0': '০', '1': '১', '2': '২', '3': '৩', '4': '৪',
    '5': '৫', '6': '৬', '7': '৭', '8': '৮', '9': '৯'
  };
  return digits.replace(/[0-9]/g, d => bnDigits[d]);
}

// ─────────────────────── PENDING STATE ────────────────────────
const pendingChoices = new Map();

function setPending(number, extractedData) {
  pendingChoices.set(normalizeNumber(number), {
    data:      extractedData,
    timestamp: Date.now(),
  });
}

function getPending(number) {
  return pendingChoices.get(normalizeNumber(number)) || null;
}

function clearPending(number) {
  pendingChoices.delete(normalizeNumber(number));
}

// ✅ NEW: WhatsApp মাঝে মাঝে একই webhook event ২বার পাঠায় (retry) — এতে ডাবল চার্জ ঠেকানো হচ্ছে
const processedMsgIds = new Set();
function isDuplicateMessage(msgId) {
  if (!msgId) return false;
  if (processedMsgIds.has(msgId)) return true;
  processedMsgIds.add(msgId);
  if (processedMsgIds.size > 3000) {
    const arr = [...processedMsgIds].slice(-1500);
    processedMsgIds.clear();
    arr.forEach(id => processedMsgIds.add(id));
  }
  return false;
}

// ─────────────────────────── MONGODB ───────────────────────────
let mongoClient = null;

async function getMongoClient() {
  if (mongoClient) return mongoClient;
  if (!CONFIG.MONGO_URI) return null;
  try {
    const { MongoClient } = require("mongodb");
    mongoClient = new MongoClient(CONFIG.MONGO_URI);
    await mongoClient.connect();
    console.log("✅ MongoDB connected");
    return mongoClient;
  } catch (e) {
    console.error("MongoDB connect error:", e.message);
    return null;
  }
}

async function saveToMongo(collection, key, data) {
  try {
    const client = await getMongoClient();
    if (!client) return;
    await client.db("nidbot").collection(collection)
      .replaceOne({ _id: key }, { _id: key, data }, { upsert: true });
  } catch (e) { console.error("MongoDB save error:", e.message); }
}

async function loadFromMongo(collection, key) {
  try {
    const client = await getMongoClient();
    if (!client) return null;
    const doc = await client.db("nidbot").collection(collection).findOne({ _id: key });
    return doc ? doc.data : null;
  } catch (e) { return null; }
}

async function backupData() {
  try {
    await Promise.all([
      saveToMongo("backups", "users",        getUsers()),
      saveToMongo("backups", "stats",        getStats()),
      saveToMongo("backups", "settings",     getSettings()),
      saveToMongo("backups", "transactions", getTransactions()), // ✅
      saveToMongo("backups", "svcache",      getSVCache()),      // ✅ যেন redeploy এর পরও cache হারিয়ে গিয়ে আবার API call না হয়
      saveToMongo("backups", "responses",    getResponses()),    // ✅ VIP response
    ]);
  } catch (e) { console.error("Backup error:", e.message); }
}

async function restoreData() {
  try {
    const [users, stats, settings, transactions, svcache, responses] = await Promise.all([
      loadFromMongo("backups", "users"),
      loadFromMongo("backups", "stats"),
      loadFromMongo("backups", "settings"),
      loadFromMongo("backups", "transactions"), // ✅
      loadFromMongo("backups", "svcache"),      // ✅
      loadFromMongo("backups", "responses"),    // ✅
    ]);
    if (users        && !fs.existsSync(USERS_FILE))        saveUsers(users);
    if (stats        && !fs.existsSync(STATS_FILE))        saveStats(stats);
    if (settings      && !fs.existsSync(SETTINGS_FILE))     saveSettings(settings);
    if (transactions && !fs.existsSync(TRANSACTIONS_FILE)) saveTransactions(transactions);
    if (svcache      && !fs.existsSync(SV_CACHE_FILE))      saveSVCache(svcache);
    if (responses    && !fs.existsSync(RESPONSES_FILE))     saveResponses(responses);
    if (users || stats || settings || transactions || svcache || responses) console.log("✅ Data restored from MongoDB");
    else console.log("ℹ️ No MongoDB data — starting fresh");
  } catch (e) { console.error("Restore error:", e.message); }
}

// ─────────────────────── WHATSAPP API ──────────────────────────
const WA_BASE    = () => `https://graph.facebook.com/${CONFIG.WA_API_VERSION}/${CONFIG.WA_PHONE_ID}`;
const WA_HEADERS = () => ({ Authorization: `Bearer ${CONFIG.WA_TOKEN}`, "Content-Type": "application/json" });

async function sendText(to, body) {
  try {
    await axios.post(`${WA_BASE()}/messages`, {
      messaging_product: "whatsapp", to, type: "text", text: { body }
    }, { headers: WA_HEADERS() });
  } catch (e) { console.error("sendText error:", e.response?.data || e.message); }
}

async function markRead(messageId) {
  try {
    await axios.post(`${WA_BASE()}/messages`, {
      messaging_product: "whatsapp", status: "read", message_id: messageId
    }, { headers: WA_HEADERS() });
  } catch {}
}

async function sendVersionChoice(to, nidName, nidNumber, currentDefault) {
  const defaultInfo = currentDefault > 0
    ? `\n\n⚙️ আপনার default: V${currentDefault} (শুধু V${currentDefault} পেতে কিছু না লিখলেও হবে)`
    : `\n\n💡 Tip: *.setversion v1* দিলে পরে automatically V1 তৈরি হবে`;

  try {
    await axios.post(`${WA_BASE()}/messages`, {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: `✅ NID তথ্য পাওয়া গেছে!\n\n👤 নাম: ${nidName}\n🆔 NID: ${nidNumber}\n\nকোন ভার্সনের কার্ড বানাবেন?${defaultInfo}`
        },
        action: {
          buttons: [
            { type: "reply", reply: { id: "choose_v1", title: "📄 Version 1" } },
            { type: "reply", reply: { id: "choose_v2", title: "📄 Version 2" } },
            { type: "reply", reply: { id: "choose_v3", title: "📄 Version 3" } },
          ]
        }
      }
    }, { headers: WA_HEADERS() });
  } catch (e) {
    console.error("sendVersionChoice error:", e.response?.data || e.message);
    await sendText(to,
      `✅ NID তথ্য পাওয়া গেছে!\n👤 নাম: ${nidName}\n🆔 NID: ${nidNumber}\n\nকোন ভার্সন চান? টাইপ করুন: *v1*, *v2*, অথবা *v3*${defaultInfo}`
    );
  }
}

async function uploadMedia(buffer, filename, mimetype) {
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("file", buffer, { filename, contentType: mimetype });
  form.append("type", mimetype);
  const res = await axios.post(`${WA_BASE()}/media`, form, {
    headers: { ...form.getHeaders(), Authorization: `Bearer ${CONFIG.WA_TOKEN}` },
    maxContentLength: Infinity, maxBodyLength: Infinity,
  });
  return res.data.id;
}

async function sendDocument(to, mediaId, filename, caption) {
  try {
    await axios.post(`${WA_BASE()}/messages`, {
      messaging_product: "whatsapp", to, type: "document",
      document: { id: mediaId, filename, caption }
    }, { headers: WA_HEADERS() });
  } catch (e) { console.error("sendDocument error:", e.response?.data || e.message); }
}

async function downloadMedia(mediaId) {
  const meta = await axios.get(
    `https://graph.facebook.com/${CONFIG.WA_API_VERSION}/${mediaId}`,
    { headers: { Authorization: `Bearer ${CONFIG.WA_TOKEN}` } }
  );
  const fileRes = await axios.get(meta.data.url, {
    headers: { Authorization: `Bearer ${CONFIG.WA_TOKEN}` },
    responseType: "arraybuffer",
  });
  return { buffer: Buffer.from(fileRes.data), mimetype: meta.data.mime_type };
}

// ─────────────────────── NID EXTRACTION ────────────────────────

function mapAPIData(d) {
  return {
    nid: d.nationalId || d.nid || d.NID || d.national_id || "",
    pin: d.pin || "",
    oldNid:
      d.formNo ||
      d.form_number ||
      d.oldNid ||
      d.old_nid ||
      "",
    nameBangla:
      d.nameBn ||
      d.nameBangla ||
      d.name_bn ||
      "",
    nameEnglish:
      d.nameEn ||
      d.nameEnglish ||
      d.name_en ||
      "",
    dob:
      d.dateOfBirth ||
      d.dob ||
      "",
    father:
      d.father ||
      d.fatherName ||
      d.father_name ||
      "",
    mother:
      d.mother ||
      d.motherName ||
      d.mother_name ||
      "",
    spouse:
      d.spouse ||
      d.spouseName ||
      "N/A",
    gender:
      d.gender ||
      "",
    religion:
      d.religion ||
      "",
    birthPlace:
      d.birthPlace ||
      d.birth_place ||
      "",
    bloodGroup:
      d.bloodGroup ||
      d.blood_group ||
      "N/A",
    occupation:
      d.occupation ||
      "N/A",
    education:
      d.education ||
      "N/A",
    voterArea:
      d.voterArea ||
      d.voter_area ||
      d.voterAreaName ||
      "",
    voterNo:
      d.voterNo ||
      d.voter_no ||
      "",
    voterAreaCode:
      d.voterAreaCode ||
      d.voter_area_code ||
      "",
    slNo:
      d.slNo ||
      d.sl_no ||
      "",
    upazilaCode:
      d.upazilaCode ||
      d.upazila_code ||
      "",
    fatherNID:
      d.nidFather ||
      d.fatherNID ||
      d.father_nid ||
      "N/A",
    motherNID:
      d.nidMother ||
      d.motherNID ||
      d.mother_nid ||
      "N/A",
    presentAddress:
      typeof d.presentAddress === "string"
        ? d.presentAddress
        : (d.presentAddress?.addressLine || d.presentAddress?.address || ""),
    permanentAddress:
      typeof d.permanentAddress === "string"
        ? d.permanentAddress
        : (d.permanentAddress?.addressLine || d.permanentAddress?.address || ""),
    photo:
      d.photo ||
      d.userIMG ||
      d.imageUrl12 ||
      "",
    dateOfToday:
      d.dateOfToday ||
      new Date().toLocaleDateString("bn-BD", {
        year: "numeric",
        month: "long",
        day: "numeric"
      })
  };
}

async function extractNIDFromPDF(buffer) {
  try {
    const form = new FormData();
    form.append("pdf", buffer, { 
      filename: "document.pdf",
      contentType: "application/pdf"
    });

    const res = await axios.post(CONFIG.API_EXTRACT_URL, form, {
      headers: form.getHeaders(),
    });

    if (res.data && res.data.success === true) {
      return mapAPIData(res.data.data);
    } else {
      throw new Error(res.data.message || "API থেকে সঠিক রেসপন্স পাওয়া যায়নি।");
    }
  } catch (error) {
    console.error("API Extraction Error:", error.message);
    throw new Error(error.response?.data?.message || error.message || "API থেকে Data Extract করতে সমস্যা হয়েছে।");
  }
}

// ✅ NEW: যেকোনো ফরম্যাটের DOB কে YYYY-MM-DD এ normalize করার জন্য
// সাপোর্ট করে: YYYY-MM-DD, YYYY/MM/DD, YYYY.MM.DD, DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, "31 January 2004"
const MONTH_NAME_MAP = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

function buildYMD(y, mo, d) {
  const yy = String(y).padStart(4, "0");
  const mm = String(mo).padStart(2, "0");
  const dd = String(d).padStart(2, "0");
  const mNum = parseInt(mm, 10), dNum = parseInt(dd, 10);
  if (!yy || yy.length !== 4 || mNum < 1 || mNum > 12 || dNum < 1 || dNum > 31) return null;
  return `${yy}-${mm}-${dd}`;
}

function normalizeDOB(raw) {
  if (!raw) return null;
  const s = String(raw).trim();

  // ইতিমধ্যে YYYY-MM-DD ফরম্যাটে থাকলে
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return buildYMD(m[1], m[2], m[3]);

  // / . - যেকোনো separator দিয়ে ৩টা numeric অংশ — YYYY/MM/DD বা DD/MM/YYYY দুটোই হ্যান্ডেল করবে
  m = s.match(/^(\d{1,4})[\/.\-](\d{1,2})[\/.\-](\d{1,4})$/);
  if (m) {
    const [, p1, p2, p3] = m;
    if (p1.length === 4) return buildYMD(p1, p2, p3); // YYYY/MM/DD, YYYY.MM.DD
    if (p3.length === 4) return buildYMD(p3, p2, p1); // DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY
  }

  // "31 January 2004" / "31 Jan 2004" ফরম্যাট
  m = s.match(/^(\d{1,2})\s+([a-zA-Z]+)\s+(\d{4})$/);
  if (m) {
    const [, d, monName, y] = m;
    const mo = MONTH_NAME_MAP[monName.toLowerCase()];
    if (mo) return buildYMD(y, mo, d);
  }

  return null;
}

// ✅ বাংলা সংখ্যা (০-৯) → ইংরেজি
const bnToEn = (s) => String(s ?? "").replace(/[০-৯]/g, d => "০১২৩৪৫৬৭৮৯".indexOf(d));

// ✅ user যা-ই লিখুক (verify, nid, dob, নাম, অন্য কথা...) — শুধু ১০/১৩/১৭ ডিজিটের NID আর জন্ম তারিখ বের করে নেয়
function parseSVInput(raw) {
  let rest = bnToEn(raw);
  const dobs = [];

  // ১) 31/02/2004, 2004-02-31, 31.02.2004 ইত্যাদি
  rest = rest.replace(/(?<!\d)\d{1,4}[\/.\-]\d{1,2}[\/.\-]\d{1,4}(?!\d)/g, (m) => { dobs.push(m); return " "; });

  // ২) 31 January 2004 / 31-Jan-2004 / 31st Jan, 2004
  rest = rest.replace(/(?<!\d)(\d{1,2})(?:st|nd|rd|th)?[\s,\-]+([A-Za-z]{3,9})\.?,?[\s\-]+(\d{4})(?!\d)/g, (m, d, mon, y) => {
    if (!MONTH_NAME_MAP[mon.toLowerCase()]) return m;
    dobs.push(`${d} ${mon} ${y}`);
    return " ";
  });

  // ৩) NID: ঠিক ১০, ১৩ বা ১৭ ডিজিট (১১/১২/১৪ ডিজিটের ফোন নম্বর ইত্যাদি বাদ)
  const nids = [...new Set(rest.match(/(?<!\d)(?:\d{17}|\d{13}|\d{10})(?!\d)/g) || [])];
  return { nids, dobs: [...new Set(dobs)] };
}

const serviceModeLabel = (m) => m === "sv" ? "SV Mode ✅" : m === "vip" ? "VIP Mode 💎" : "Default (PDF)";

// ✅ NEW: একবার সফল হওয়া NID+DOB lookup আবার API call না করে cache থেকে serve করার জন্য (token বাঁচাতে)
const SV_CACHE_FILE = path.join(CONFIG.DATA_DIR, "sv_cache.json");
const getSVCache  = () => loadJSON(SV_CACHE_FILE, {});
const saveSVCache = (c) => saveJSON(SV_CACHE_FILE, c);

function svCacheKey(nid, dob) { return `${nid}_${dob}`; }

function getCachedSVData(nid, dob) {
  const cache = getSVCache();
  return cache[svCacheKey(nid, dob)] || null;
}

function setCachedSVData(nid, dob, data) {
  const cache = getSVCache();
  cache[svCacheKey(nid, dob)] = { data, time: new Date().toISOString() };
  const keys = Object.keys(cache);
  if (keys.length > 5000) { // পুরনো entry গুলো ছেঁটে ফেলা হচ্ছে যেন ফাইল অসীম বড় না হয়
    keys.sort((a, b) => new Date(cache[a].time) - new Date(cache[b].time))
      .slice(0, keys.length - 5000)
      .forEach(k => delete cache[k]);
  }
  saveSVCache(cache);
}

// ═══════════════ SV PROVIDERS (adapter) ═══════════════
// প্রতিটা provider { data, raw } ফেরত দেয় — data সবসময় একই ফরম্যাটে, তাই V1–V4 HTML builder এ হাত দিতে হয় না।
// Error হলে err.kind = "timeout" | "notfound" | "failed"
// ⚠️ কোনো provider এ auto-retry নেই — retry করলে ওপাশে আবার টোকেন কাটতে পারে।
function svError(message, kind) {
  const e = new Error(String(message || "API error").slice(0, 300));
  e.kind = kind;
  return e;
}

function classifyAxiosError(err) {
  if (err.kind) return err;
  const timeout = err.code === "ECONNABORTED" || err.code === "ETIMEDOUT" || /timeout/i.test(err.message || "");
  const apiMsg  = err.response?.data?.message || err.response?.data?.error;
  return svError(typeof apiMsg === "string" ? apiMsg : (err.message || "API error"), timeout ? "timeout" : "failed");
}

const cleanBlood = (b) => {
  const s = String(b || "").trim();
  return (s === "-" || s.toUpperCase() === "N/A") ? "" : s;
};
const todayBn = () => new Date().toLocaleDateString("bn-BD", { year: "numeric", month: "long", day: "numeric" });

// ── SV1 (সস্তা API) ──
async function fetchFromSV1(nid, dob) {
  if (!CONFIG.SV_API1_KEY) throw svError("SV1 API key সেট করা নেই (SV_API1_KEY)", "failed");
  const url = `${CONFIG.SV_API1_URL}?key=${encodeURIComponent(CONFIG.SV_API1_KEY)}&nid=${encodeURIComponent(nid)}&dob=${encodeURIComponent(dob)}`;

  let res;
  try {
    res = await axios.get(url, { timeout: 180000 }); // ✅ slow হলেও ৩ মিনিট অপেক্ষা
  } catch (e) { throw classifyAxiosError(e); }

  const raw = res.data;
  if (!raw || raw.success === false) {
    throw svError(raw?.message || raw?.error || "SV1 এ তথ্য পাওয়া যায়নি।", "notfound");
  }

  const d = raw["data-Info"] || raw.data || raw;

  let presentAddr = "";
  if (typeof d.preAddress === "string") presentAddr = d.preAddress;
  else if (d.preAddress?.addressLine) presentAddr = d.preAddress.addressLine;
  else if (d.preAddress?.address) presentAddr = d.preAddress.address;
  else if (typeof d.presentAddress === "string") presentAddr = d.presentAddress;
  else if (d.presentAddress?.addressLine) presentAddr = d.presentAddress.addressLine;

  let permanentAddr = "";
  if (typeof d.perAddress === "string") permanentAddr = d.perAddress;
  else if (d.perAddress?.addressLine) permanentAddr = d.perAddress.addressLine;
  else if (d.perAddress?.address) permanentAddr = d.perAddress.address;
  else if (typeof d.permanentAddress === "string") permanentAddr = d.permanentAddress;
  else if (d.permanentAddress?.addressLine) permanentAddr = d.permanentAddress.addressLine;

  return {
    raw,
    data: {
      nid:              d.nationalId  || d.nid          || nid,
      pin:              d.pin         || "",
      oldNid:           d.oldId       || d.formNo        || d.old_nid || "",
      nameBangla:       d.nameBangla  || d.nameBn        || d.name_bn || "",
      nameEnglish:      d.nameEnglish || d.nameEn        || d.name_en || "",
      dob:              d.dateOfBirth || d.dob            || dob,
      father:           d.fatherName  || d.father         || "",
      mother:           d.motherName  || d.mother         || "",
      spouse:           d.spouseName  || d.spouse         || "",
      gender:           d.gender      || "",
      religion:         d.religion    || "",
      birthPlace:       d.birthPlace  || d.birth_place    || "",
      bloodGroup:       cleanBlood(d.bloodGroup || d.blood_group),
      occupation:       d.occupation  || "",
      education:        d.education   || "",
      voterArea:        d.voterArea   || d.voter_area     || "",
      voterNo:          d.voterNo     || d.voterNumber    || d.voter_no || "",
      voterAreaCode:    d.voterAreaCode || d.voter_area_code || "",
      upazilaCode:      d.districtCode || d.upazilaCode   || "",
      fatherNID:        d.fatherNID   || "",
      motherNID:        d.motherNID   || "",
      slNo:             d.slNo        || "",
      presentAddress:   presentAddr,
      permanentAddress: permanentAddr,
      photo:            d.photo       || d.userIMG        || d.imageUrl12 || "",
      ageBangla:        d.ageBangla      || "",
      birthDayBangla:   d.birthDayBangla || "",
      dateOfToday:      todayBn(),
    },
  };
}

// ── SV2 (VIP API) ──
// ⚠️ VIP API এর আসল URL parameter নাম অন্য হলে শুধু এই function টা বদলান
function buildSV2Url(nid, dob) {
  return `${CONFIG.SV_API2_URL}?key=${encodeURIComponent(CONFIG.SV_API2_KEY)}&nid=${encodeURIComponent(nid)}&dob=${encodeURIComponent(dob)}`;
}

async function fetchFromSV2(nid, dob) {
  if (!CONFIG.SV_API2_URL || !CONFIG.SV_API2_KEY) {
    throw svError("SV2 API সেট করা নেই (SV_API2_URL / SV_API2_KEY)", "failed");
  }

  let res;
  try {
    res = await axios.get(buildSV2Url(nid, dob), { timeout: 120000 });
  } catch (e) { throw classifyAxiosError(e); }

  const raw = res.data;
  const d   = raw?.data?.data || raw?.data;
  if (!raw || raw.status !== "success" || !d || !(d.nationalId || d.nameEn || d.name)) {
    const msg = raw?.message || raw?.error || raw?.data?.message || "SV2 তেও তথ্য পাওয়া যায়নি।";
    throw svError(typeof msg === "string" ? msg : "SV2 তেও তথ্য পাওয়া যায়নি।", "notfound");
  }

  const genderMap = { male: "পুরুষ", female: "মহিলা", other: "অন্যান্য" };
  const addr = (a) => (typeof a === "string" ? a : (a?.addressLine || ""));

  return {
    raw, // ✅ হুবহু রেসপন্স — save করার জন্য
    data: {
      nid:              d.nationalId || nid,
      pin:              d.pin || "",
      oldNid:           d.oldNid || "",
      nameBangla:       d.name || "",
      nameEnglish:      d.nameEn || "",
      dob:              d.dateOfBirth || dob,
      father:           d.father || "",
      mother:           d.mother || "",
      spouse:           d.spouse || "",
      gender:           genderMap[String(d.gender || "").toLowerCase()] || d.gender || "",
      religion:         d.religion || "",
      birthPlace:       d.birthPlace || "",
      bloodGroup:       cleanBlood(d.bloodGroup),
      occupation:       d.occupation || "",
      education:        d.education || "",
      voterArea:        d.voterArea || "",
      voterNo:          d.voter_no || "",
      voterAreaCode:    d.voter_area_code || "",
      upazilaCode:      d.upazilaCode || "",
      fatherNID:        "",
      motherNID:        "",
      slNo:             d.sl_no || "",
      presentAddress:   addr(d.presentAddress),
      permanentAddress: addr(d.permanentAddress),
      photo:            d.photo || "",
      ageBangla:        d.age || "",
      birthDayBangla:   d.birthDay || "",
      dateOfToday:      todayBn(),
    },
  };
}

// ═══════════════ VIP RESPONSE SAVE (২৪ ঘণ্টা admin panel + ঐচ্ছিক GitHub) ═══════════════
const RESPONSE_TTL_MS = 24 * 60 * 60 * 1000;
const getResponses  = () => loadJSON(RESPONSES_FILE, []);
const saveResponses = (r) => saveJSON(RESPONSES_FILE, r);

function pruneResponses() {
  const list  = getResponses();
  const fresh = list.filter(r => Date.now() - new Date(r.time).getTime() < RESPONSE_TTL_MS);
  if (fresh.length !== list.length) saveResponses(fresh);
  return fresh;
}

// GitHub এ user এর নামে আলাদা folder: responses/<user-number>/<nid>_<provider>_<time>.json
async function pushResponseToGitHub(number, nid, provider, raw) {
  if (!CONFIG.GITHUB_TOKEN || !CONFIG.GITHUB_REPO) return;
  const folder   = normalizeNumber(number);
  const filePath = `responses/${folder}/${nid}_${provider}_${Date.now()}.json`;
  await axios.put(
    `https://api.github.com/repos/${CONFIG.GITHUB_REPO}/contents/${filePath}`,
    {
      message: `save ${provider} response for ${folder}`,
      content: Buffer.from(JSON.stringify(raw, null, 2), "utf8").toString("base64"),
      branch:  CONFIG.GITHUB_BRANCH,
    },
    {
      headers: {
        Authorization: `Bearer ${CONFIG.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "nid-bot",
      },
      timeout: 20000,
    }
  );
}

function saveRawResponse(number, nid, provider, raw) {
  try {
    const list = pruneResponses();
    list.push({
      id: crypto.randomBytes(6).toString("hex"),
      number: normalizeNumber(number),
      nid: String(nid || ""),
      provider,
      time: new Date().toISOString(),
      raw,
    });
    saveResponses(list);
    pushResponseToGitHub(number, nid, provider, raw)
      .catch(e => console.error("GitHub save error:", e.response?.data?.message || e.message));
  } catch (e) { console.error("saveRawResponse error:", e.message); }
}

// ✅ API তে ageBangla / birthDayBangla না থাকলে (পুরনো cache বা PDF mode) DOB থেকে নিজেই হিসাব করার fallback
function calcAgeBangla(dob) {
  const n = normalizeDOB(dob);
  if (!n) return "";
  const [y, m, d] = n.split("-").map(Number);
  const now = new Date();
  const ny = now.getUTCFullYear(), nm = now.getUTCMonth() + 1, nd = now.getUTCDate();
  let yy = ny - y, mm = nm - m, dd = nd - d;
  if (dd < 0) { mm--; dd += new Date(Date.UTC(ny, nm - 1, 0)).getUTCDate(); }
  if (mm < 0) { yy--; mm += 12; }
  if (yy < 0) return "";
  return `${toBn(yy)} বছর, ${toBn(mm)} মাস, ${toBn(dd)} দিন`;
}

function calcBirthDayBangla(dob) {
  const n = normalizeDOB(dob);
  if (!n) return "";
  const [y, m, d] = n.split("-").map(Number);
  const days = ["রবিবার", "সোমবার", "মঙ্গলবার", "বুধবার", "বৃহস্পতিবার", "শুক্রবার", "শনিবার"];
  return days[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

// ─────────────────────── HTML BUILDERS ────────────────────────

function buildHTMLv1(d) {
  const presentAddr   = (d.presentAddress  || "").replace(/\r\n/g, "<br>").replace(/\n/g, "<br>");
  const permanentAddr = (d.permanentAddress || "").replace(/\r\n/g, "<br>").replace(/\n/g, "<br>");
  const qrData = encodeURIComponent(`${d.nameEnglish} ${d.nid} ${d.dob}`);

  return `<!DOCTYPE html>
<html lang="bn">
<head>
    <meta charset="utf-8">
    <meta content="width=device-width, initial-scale=1.0" name="viewport">
    <title>${d.nid} - ${d.nameEnglish}</title>
    <link href="https://surokkha.gov.bd/favicon.png" rel="icon">
    <link rel="stylesheet" href="https://site-assets.fontawesome.com/releases/v6.1.1/css/all.css">
    <style>
        @import url('https://fonts.maateen.me/solaiman-lipi/font.css');
        @page { size: A4; margin: 0; }
        body {
            margin: 0;
            font-family: 'Solaimanlipi', sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            min-height: 10vh;
            background-color: #f0f0f0;
        }
        .printable-container {
            width: 750px;
            height: 1000px;
            position: relative;
            box-shadow: 0;
            margin: 10px 0;
            flex-shrink: 0;
            background-color: lightgrey;
        }
        .background { position: relative; width: 100%; height: 100%; }
        .crane { max-width: 100%; height: 100%; }
        #print-pdf-btn {
            background: linear-gradient(45deg, #FF5722, #FF9800);
            padding: 10px 20px;
            width: auto;
            height: auto;
            border: none;
            font-size: 20px;
            font-weight: bold;
            cursor: pointer;
            box-shadow: 2px 5px 10px rgba(0, 0, 0, 0.2);
            color: #fff;
            border-radius: 25px;
            margin: 25px;
            display: block;
            text-transform: uppercase;
            transition: all 0.3s ease-in-out;
            letter-spacing: 1px;
        }
        @media print {
            html, body {
                width: 210mm !important;
                height: 297mm !important;
                background-color: #ffffff !important;
                margin: 0;
                padding: 0;
                -webkit-print-color-adjust: exact;
                color-adjust: exact;
            }
            .no-print { display: none !important; }
            @page { margin-top: 0mm; margin-bottom: 0mm; }
            .printable-container {
                width: 205mm;
                height: 295mm;
                page-break-after: avoid;
                margin: 0mm;
                overflow: hidden;
            }
            .crane { width: 100%; height: 100%; display: block; }
        }
    </style>
</head>
<body style="text-align: center;">
    <div class="printable-container">
        <img class="crane" src="https://dakhila-ldtax-gov-bd.rf.gd/assets/images/server_unofficialV1.jpg" height="1000px" width="750px">

        <div style="position: absolute; left: 30%; top: 8%; width: auto; font-size: 16px; color: rgb(255 224 0);"><b>National Identity Registration Wing (NIDW)</b></div>
        <div style="position: absolute; left: 37%; top: 11%; width: auto; font-size: 14px; color: rgb(255, 47, 161);"><b>Select Your Search Category</b></div>
        <div style="position: absolute; left: 45%; top: 12.8%; width: auto; font-size: 12px; color: rgb(8, 121, 4);">Search By NID / Voter No.</div>
        <div style="position: absolute; left: 45%; top: 14.3%; width: auto; font-size: 12px; color: rgb(7, 119, 184);">Search By Form No.</div>
        <div style="position: absolute; left: 30%; top: 16.9%; width: auto; font-size: 12px; color: rgb(252, 0, 0);"><b>NID or Voter No*</b></div>
        <div style="position: absolute; left: 45%; top: 16.9%; width: auto; font-size: 12px; color: rgb(143, 143, 143);">${d.nid}</div>
        <div style="position: absolute; left: 62.9%; top: 17.1%; width: auto; font-size: 11px; color: rgb(255 255 255);">Submit</div>
        <div style="position: absolute; left: 89%; top: 11.55%; width: auto; font-size: 11px; color: #fff;">Home</div>

        <div style="position: absolute; left: 37%; top: 27%; font-size: 17px;"><b>জাতীয় পরিচিতি তথ্য</b></div>
        <div style="position: absolute; left: 37%; top: 29.7%; font-size: 14px;">জাতীয় পরিচয় পত্র নম্বর</div>
        <div style="position: absolute; left: 55%; top: 29.7%; font-size: 14px;">${d.nid}</div>

        <div style="position: absolute; left: 37%; top: 32.5%; font-size: 14px;">পিন নম্বর</div>
        <div style="position: absolute; left: 55%; top: 32.5%; font-size: 14px;">${d.pin}</div>

        <div style="position: absolute; left: 37%; top: 35%; font-size: 14px;">ফরম নাম্বার</div>
        <div style="position: absolute; left: 55%; top: 35%; font-size: 14px;">${d.oldNid}</div>

        <div style="position: absolute; left: 37%; top: 37.5%; font-size: 14px;">ভোটার নাম্বার</div>
        <div style="position: absolute; left: 55%; top: 37.5%; font-size: 14px;">${d.voterNo}</div>

        <div style="position: absolute; left: 37%; top: 40.2%; font-size: 14px;">ভোটার এলাকা</div>
        <div style="position: absolute; left: 55%; top: 40.2%; font-size: 14px;">${d.voterArea}</div>

        <div style="position: absolute; left: 37%; top: 43%; font-size: 17px;"><b>ব্যক্তিগত তথ্য</b></div>
        <div style="position: absolute; left: 37%; top: 45.6%; font-size: 14px;">নাম (বাংলা)</div>
        <div style="position: absolute; left: 55%; top: 45.6%; font-size: 14px;"><b>${d.nameBangla}</b></div>

        <div style="position: absolute; left: 37%; top: 48.5%; font-size: 14px;">নাম (ইংরেজি)</div>
        <div style="position: absolute; left: 55%; top: 48.5%; font-size: 14px;">${d.nameEnglish}</div>

        <div style="position: absolute; left: 37%; top: 51%; font-size: 14px;">জন্ম তারিখ</div>
        <div style="position: absolute; left: 55%; top: 51%; font-size: 14px;">${d.dob}</div>

        <div style="position: absolute; left: 37%; top: 53.7%; font-size: 14px;">পিতার নাম</div>
        <div style="position: absolute; left: 55%; top: 53.7%; font-size: 14px;">${d.father}</div>

        <div style="position: absolute; left: 37%; top: 56.2%; font-size: 14px;">মাতার নাম</div>
        <div style="position: absolute; left: 55%; top: 56.2%; font-size: 14px;">${d.mother}</div>

        <div style="position: absolute; left: 37%; top: 59%; font-size: 14px;">স্বামী/স্ত্রীর নাম</div>
        <div style="position: absolute; left: 55%; top: 59%; font-size: 14px;">${d.spouse}</div>

        <div style="position: absolute; left: 37%; top: 61.8%; font-size: 17px;"><b>অন্যান্য তথ্য</b></div>

        <div style="position: absolute; left: 37%; top: 65%; font-size: 14px;">লিঙ্গ</div>
        <div style="position: absolute; left: 55%; top: 65%; font-size: 14px;">${d.gender}</div>

        <div style="position: absolute; left: 37%; top: 67.6%; font-size: 14px;">জন্মস্থান</div>
        <div style="position: absolute; left: 55%; top: 67.6%; font-size: 14px;">${d.birthPlace}</div>

        <div style="position: absolute; left: 37%; top: 70.3%; font-size: 14px;">রক্তের গ্রুপ</div>
        <div style="position: absolute; left: 55%; top: 70.3%; font-size: 14px; color: rgb(252, 0, 0);">${d.bloodGroup}</div>

        <div style="position: absolute; left: 37%; top: 72.8%; font-size: 14px;">পেশা</div>
        <div style="position: absolute; left: 55%; top: 72.8%; font-size: 14px;">${d.occupation}</div>

        <div style="position: absolute; left: 37%; top: 75.6%; font-size: 17px;"><b>বর্তমান ঠিকানা</b></div>
        <div style="position: absolute; left: 37%; top: 78.3%; width: 48%; font-size: 13px; text-align: left; white-space: normal;">${presentAddr}</div>

        <div style="position: absolute; left: 37%; top: 84.4%; font-size: 17px;"><b>স্থায়ী ঠিকানা</b></div>
        <div style="position: absolute; left: 37%; top: 87.3%; width: 48%; font-size: 13px; text-align: left; white-space: normal;">${permanentAddr}</div>

        <div style="position: absolute; top: 94.8%; width: 100%; font-size: 14px; text-align: center; color: rgb(255, 0, 0);">উপরে প্রদর্শিত তথ্যসমূহ জাতীয় পরিচয়পত্র সংশ্লিষ্ট, ভোটার তালিকার সাথে সরাসরি সম্পর্কযুক্ত নয়।</div>
        <div style="position: absolute; top: 96.5%; width: 100%; text-align: center; font-size: 12px; color: rgb(3, 3, 3);">This is Software Generated Report From Bangladesh Election Commission, Signature &amp; Seal Aren't Required.</div>

        <div style="position: absolute; left: 16%; top: 25.8%;">
            <img src="${d.photo}" height="140px" width="121px" style="border-radius: 10px;" onerror="this.onerror=null; this.src='https://dakhila-ldtax-gov-bd.rf.gd/assets/media/card/blank.png';">
        </div>

        <div style="position: absolute; left: 17.7%; top: 44.2%;">
            <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${qrData}" height="95px" width="95px">
        </div>

        <div style="position: absolute; display: flex; font-weight: bold; left: 15.5%; top: 39.8%; height: 32px; width: 130px; font-size: 13px; color: rgb(7, 7, 7); margin: auto; align-items: center;" align="center">
            <div style="flex: 1;">${d.nameEnglish}</div>
        </div>
    </div>
</body>
</html>`;
}

// ── V2: PHP signToServerV2 এর exact structure ──
function buildHTMLv2(d) {
  const A = CONFIG.ASSETS;
  const presentAddr   = (d.presentAddress  || "").replace(/\r\n/g, "<br>").replace(/\n/g, "<br>");
  const permanentAddr = (d.permanentAddress || "").replace(/\r\n/g, "<br>").replace(/\n/g, "<br>");

  return `<!DOCTYPE html>
<html lang="bn">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${d.nid} - ${d.nameEnglish}</title>
    <link href="https://fonts.maateen.me/solaiman-lipi/font.css" rel="stylesheet">
    <style>
        @font-face {
            font-family: 'Solaimanlipi';
            src: url('https://fonts.maateen.me/solaiman-lipi/SolaimanLipi.woff2') format('woff2');
        }
        * { box-sizing: border-box; }
        body {
            font-family: 'Solaimanlipi', 'Solaiman Lipi', sans-serif;
            margin: auto;
            padding: 0;
            background-color: #f4f4f9;
            width: 210mm;
        }
        @page { size: 210mm 297mm; margin: 0; }
        @media print {
            * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            body { background: white; margin: 0; padding: 0; }
            .container { margin: 0 !important; }
        }
        .container {
            margin: auto;
            background: white;
            padding-left: 20px;
            padding-right: 20px;
        }
        .header_top {
            text-align: center;
            border-bottom: 1px solid #c2c2c2;
        }
        p.text { line-height: 7px; }
        img#user_img {
            width: 110px;
            margin-top: 10px;
            border-radius: 10px;
            box-shadow: rgba(0, 0, 0, 0.35) 0px 2px 10px;
            height: 120px;
            margin-bottom: 20px;
        }
        .user_photo { text-align: center; }
        .sub_container { margin: 5px 0 !important; padding: 0 10px; }
        .section { margin-bottom: 1px; }
        .section-title {
            font-size: 17px !important;
            font-family: 'Solaimanlipi', sans-serif;
            font-weight: bold;
            background: #bbe6ed;
            color: black;
            padding: 5px;
            margin-bottom: 3px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            table-layout: fixed;
        }
        colgroup col { width: 40%; }
        colgroup col:last-child { width: 60%; }
        table, td { border: 1px solid #EAEAEA; }
        td {
            font-size: 14px !important;
            font-family: 'Solaimanlipi', sans-serif;
            padding: 2px 5px !important;
            text-align: left;
        }
        td:first-child { font-weight: Normal; color: #000; }
        strong { font-weight: normal !important; }
        .footer_text { margin-top: 5px !important; }
        #footer_english {
            text-align: center;
            margin-top: -16px;
            font-size: 13px;
            font-weight: bold;
            font-family: Arial;
            letter-spacing: -0.2px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="header_top">
                <img src="${A}/assets/server/img/logo-server-copy.svg" alt="" style="width: 50px; margin-top: 10px;" onerror="this.onerror=null; this.src='https://surokkha.gov.bd/favicon.png';">
                <p class="text_one text" style="font-size: 16px;">বাংলাদেশ নির্বাচন কমিশন</p>
                <p class="text_two text" style="font-size: 16px;">নির্বাচন কমিশন সচিবালয়</p>
                <p class="text_three text" style="font-size: 16px; margin-bottom: 10px;">জাতীয় পরিচয় নিবন্ধন অনুবিভাগ</p>
            </div>
            <div class="user_photo">
                <img src="${d.photo}" alt="" id="user_img" onerror="this.onerror=null; this.src='https://dakhila-ldtax-gov-bd.rf.gd/assets/media/card/blank.png';">
            </div>
        </div>
        <div class="sub_container">

            <div class="section">
                <div class="section-title">জাতীয় পরিচিতি তথ্য</div>
                <div class="section-content">
                    <table>
                        <colgroup><col><col></colgroup>
                        <tr><td>জাতীয় পরিচয় পত্র নম্বর</td><td><strong>${d.nid || "N/A"}</strong></td></tr>
                        <tr><td>পিন নম্বর</td><td><strong>${d.pin || "N/A"}</strong></td></tr>
                        <tr><td>ভোটার নম্বর</td><td><strong>${d.voterNo || "N/A"}</strong></td></tr>
                        <tr><td>ভোটার এরিয়া কোড</td><td><strong>${d.voterAreaCode || "N/A"}</strong></td></tr>
                        <tr><td>ভোটার এলাকা</td><td><strong>${d.voterArea || "N/A"}</strong></td></tr>
                        <tr><td>ফরম নম্বর</td><td><strong>${d.oldNid || "N/A"}</strong></td></tr>
                        <tr><td>পিতার এনআইডি</td><td><strong>${d.fatherNID || "N/A"}</strong></td></tr>
                        <tr><td>মাতার এনআইডি</td><td><strong>${d.motherNID || "N/A"}</strong></td></tr>
                    </table>
                </div>
            </div>

            <div class="section">
                <div class="section-title">ব্যক্তিগত তথ্য</div>
                <div class="section-content">
                    <table>
                        <colgroup><col><col></colgroup>
                        <tr><td>নাম (বাংলা)</td><td><strong>${d.nameBangla || "N/A"}</strong></td></tr>
                        <tr><td>নাম (ইংরেজি)</td><td><strong>${d.nameEnglish || "N/A"}</strong></td></tr>
                        <tr><td>জন্ম তারিখ</td><td><strong>${d.dob || "N/A"}</strong></td></tr>
                        <tr><td>পিতার নাম</td><td><strong>${d.father || "N/A"}</strong></td></tr>
                        <tr><td>মাতার নাম</td><td><strong>${d.mother || "N/A"}</strong></td></tr>
                        <tr><td>স্বামী/স্ত্রীর নাম</td><td><strong>${d.spouse || "N/A"}</strong></td></tr>
                    </table>
                </div>
            </div>

            <div class="section">
                <div class="section-title">অন্যান্য তথ্য</div>
                <div class="section-content">
                    <table>
                        <colgroup><col><col></colgroup>
                        <tr><td>রক্তের গ্রুপ</td><td><strong>${d.bloodGroup || "N/A"}</strong></td></tr>
                        <tr><td>পেশা</td><td><strong>${d.occupation || "N/A"}</strong></td></tr>
                        <tr><td>শিক্ষাগত যোগ্যতা</td><td><strong>${d.education || "N/A"}</strong></td></tr>
                        <tr><td>লিঙ্গ</td><td><strong>${d.gender || "N/A"}</strong></td></tr>
                        <tr><td>ধর্ম</td><td><strong>${d.religion || "N/A"}</strong></td></tr>
                        <tr><td>জন্মস্থান</td><td><strong>${d.birthPlace || "N/A"}</strong></td></tr>
                    </table>
                </div>
            </div>

            <div class="section">
                <div class="section-title">বর্তমান ঠিকানা</div>
                <div class="section-content">
                    <table><colgroup><col></colgroup>
                        <tr><td>${presentAddr || "N/A"}</td></tr>
                    </table>
                </div>
            </div>

            <div class="section">
                <div class="section-title">স্থায়ী ঠিকানা</div>
                <div class="section-content">
                    <table><colgroup><col></colgroup>
                        <tr><td>${permanentAddr || "N/A"}</td></tr>
                    </table>
                </div>
            </div>

            <div class="footer_text">
                <p style="text-align: center; color: red;">উপরে প্রদর্শিত তথ্যসমূহ জাতীয় পরিচয়পত্র সংশ্লিষ্ট, ভোটার তালিকার সাথে সরাসরি সম্পর্কযুক্ত নয়।</p>
                <p id="footer_english">This is Software Generated Report From Bangladesh Election Commission, Signature &amp; Seal Aren't Required.</p>
            </div>
        </div>
    </div>
</body>
</html>`;
}

// ── V3: PHP signToServerV3 এর exact structure ──
function buildHTMLv3(d) {
  const A = CONFIG.ASSETS;
  const presentAddr   = (d.presentAddress  || "").replace(/\r\n/g, "<br>").replace(/\n/g, "<br>");
  const permanentAddr = (d.permanentAddress || "").replace(/\r\n/g, "<br>").replace(/\n/g, "<br>");

  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${d.nid} - ${d.nameEnglish}</title>
    <link href="https://fonts.maateen.me/solaiman-lipi/font.css" rel="stylesheet">
    <style>
        @font-face {
            font-family: 'Solaimanlipi';
            src: url('https://fonts.maateen.me/solaiman-lipi/SolaimanLipi.woff2') format('woff2');
        }
        * { box-sizing: border-box; }
        body {
            font-family: 'Solaimanlipi', 'Solaiman Lipi', sans-serif;
            margin: auto;
            padding: 0;
            background-color: #f4f4f9;
            width: 210mm;
        }
        @page { size: 210mm 297mm; margin: 0; }
        @media print {
            * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
            body { background: white; margin: 0; padding: 0; }
            .container { margin: 0 !important; }
        }
        .container {
            margin: auto;
            background: white;
            padding-left: 20px;
            padding-right: 20px;
        }
        .header_top {
            text-align: center;
            border-bottom: 1px solid #c2c2c2;
        }
        p.text { line-height: 10px; }
        img#user_img {
            width: 110px;
            margin-top: 1px;
            border-radius: 10px;
            box-shadow: rgba(0, 0, 0, 0.35) 0px 2px 10px;
            height: 120px;
        }
        .name {
            border: 1px solid #eaeaea;
            padding: 1px;
            font-size: 15px;
            font-weight: bold;
        }
        .user_photo {
            text-align: center;
            margin-top: 5px;
            background-color: #bbe6ed;
            margin-bottom: 8px;
        }
        .sub_container {
            padding-left: 100px;
            padding-right: 100px;
        }
        .section { background-color: #bbe6ed; }
        .section-title {
            font-size: 17px !important;
            font-family: 'Solaimanlipi', sans-serif;
            font-weight: bold;
            background: #bbe6ed;
            color: black;
            padding: 5px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            table-layout: fixed;
        }
        colgroup col { width: 40%; }
        colgroup col:last-child { width: 60%; }
        table, td { border: 1px solid #EAEAEA; }
        td {
            font-size: 14px !important;
            font-family: 'Solaimanlipi', sans-serif;
            padding: 2px 5px !important;
            text-align: left;
        }
        td:first-child { color: #000; font-weight: normal; }
        strong { font-weight: normal !important; }
        .footer_text { margin-top: 15px; }
        #footer_english {
            text-align: center;
            margin-top: -16px;
            font-size: 13px;
            font-weight: bold;
            font-family: Arial;
            letter-spacing: -0.2px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="sub_container">
            <div class="header">
                <div class="header_top">
                    <img src="${A}/assets/server/img/logo-server-copy.svg" alt="" style="width: 50px; margin-top: 10px;" onerror="this.onerror=null; this.src='https://surokkha.gov.bd/favicon.png';">
                    <p class="text_one text" style="font-size: 16px;">বাংলাদেশ নির্বাচন কমিশন</p>
                    <p class="text_two text" style="font-size: 16px;">নির্বাচন কমিশন সচিবালয়</p>
                    <p class="text_three text" style="font-size: 16px; margin-bottom: 10px;">জাতীয় পরিচয় নিবন্ধন অনুবিভাগ</p>
                </div>
                <div class="user_photo">
                    <img src="${d.photo}" alt="" id="user_img" onerror="this.onerror=null; this.src='https://dakhila-ldtax-gov-bd.rf.gd/assets/media/card/blank.png';">
                    <div class="name">${d.nameEnglish}</div>
                </div>
            </div>

            <div class="section">
                <div class="section-title">জাতীয় পরিচিতি তথ্য</div>
                <div class="section-content">
                    <table>
                        <colgroup><col><col></colgroup>
                        <tr><td>জাতীয় পরিচয় পত্র নম্বর</td><td><strong>${d.nid || "N/A"}</strong></td></tr>
                        <tr><td>পিন নম্বর</td><td><strong>${d.pin || "N/A"}</strong></td></tr>
                        <tr><td>পূর্ববর্তী এনআইডি নম্বর</td><td><strong>${d.oldNid || "N/A"}</strong></td></tr>
                        <tr><td>জন্ম নিবন্ধন নম্বর</td><td><strong>${d.voterNo || "N/A"}</strong></td></tr>
                        <tr><td>ভোটার এলাকা</td><td><strong>${d.voterArea || "N/A"}</strong></td></tr>
                    </table>
                </div>
            </div>

            <div class="section">
                <div class="section-title">ব্যক্তিগত তথ্য</div>
                <div class="section-content">
                    <table>
                        <colgroup><col><col></colgroup>
                        <tr><td>নাম (বাংলা)</td><td><strong>${d.nameBangla || "N/A"}</strong></td></tr>
                        <tr><td>নাম (ইংরেজি)</td><td><strong>${d.nameEnglish || "N/A"}</strong></td></tr>
                        <tr><td>জন্ম তারিখ</td><td><strong>${d.dob || "N/A"}</strong></td></tr>
                        <tr><td>পিতার নাম</td><td><strong>${d.father || "N/A"}</strong></td></tr>
                        <tr><td>মাতার নাম</td><td><strong>${d.mother || "N/A"}</strong></td></tr>
                        <tr><td>স্বামী/স্ত্রীর নাম</td><td><strong>${d.spouse || "N/A"}</strong></td></tr>
                    </table>
                </div>
            </div>

            <div class="section">
                <div class="section-title">অন্যান্য তথ্য</div>
                <div class="section-content">
                    <table>
                        <colgroup><col><col></colgroup>
                        <tr><td>পেশা</td><td><strong>${d.occupation || "N/A"}</strong></td></tr>
                        <tr><td>রক্তের গ্রুপ</td><td><strong>${d.bloodGroup || "N/A"}</strong></td></tr>
                        <tr><td>ধর্ম</td><td><strong>${d.religion || "N/A"}</strong></td></tr>
                        <tr><td>লিঙ্গ</td><td><strong>${d.gender || "N/A"}</strong></td></tr>
                        <tr><td>শিক্ষাগত যোগ্যতা</td><td><strong>${d.education || "N/A"}</strong></td></tr>
                        <tr><td>জন্মস্থান</td><td><strong>${d.birthPlace || "N/A"}</strong></td></tr>
                    </table>
                </div>
            </div>

            <div class="section">
                <div class="section-title">বর্তমান ঠিকানা</div>
                <div class="section-content">
                    <table><colgroup><col></colgroup>
                        <tr><td>${presentAddr || "N/A"}</td></tr>
                    </table>
                </div>
            </div>

            <div class="section">
                <div class="section-title">স্থায়ী ঠিকানা</div>
                <div class="section-content">
                    <table><colgroup><col></colgroup>
                        <tr><td>${permanentAddr || "N/A"}</td></tr>
                    </table>
                </div>
            </div>
        </div>

        <div class="footer_text">
            <p style="text-align: center; color: red; font-size: 16px;">উপরে প্রদর্শিত তথ্যসমূহ জাতীয় পরিচয়পত্র সংশ্লিষ্ট, ভোটার তালিকার সাথে সরাসরি সম্পর্কযুক্ত নয়।</p>
            <p id="footer_english">This is Software Generated Report From Bangladesh Election Commission, Signature &amp; Seal Aren't Required.</p>
        </div>
    </div>
</body>
</html>`;
}

// ── V4: Version 1 Layout (Customized as per request) ──
function buildHTMLv4(d) {
  const presentAddr   = (d.presentAddress  || "").replace(/\r\n/g, "<br>").replace(/\n/g, "<br>");
  const permanentAddr = (d.permanentAddress || "").replace(/\r\n/g, "<br>").replace(/\n/g, "<br>");
  const qrData = encodeURIComponent(`${d.nameEnglish} ${d.nid} ${d.dob}`);

  // রক্তের গ্রুপ খালি, N/A বা '-' থাকলে যেন কিছু না দেখায়
  let bloodText = d.bloodGroup || "";
  if (bloodText === "-" || bloodText === "N/A" || bloodText.trim() === "") {
    bloodText = "";
  }

  return `<!DOCTYPE html>
<html lang="bn">
<head>
    <meta charset="utf-8">
    <meta content="width=device-width, initial-scale=1.0" name="viewport">
    <title>${d.nid} - ${d.nameEnglish}</title>
    <link href="https://surokkha.gov.bd/favicon.png" rel="icon">
    <link rel="stylesheet" href="https://site-assets.fontawesome.com/releases/v6.1.1/css/all.css">
    <style>
        @import url('https://fonts.maateen.me/solaiman-lipi/font.css');
        @page { size: A4; margin: 0; }
        body {
            margin: 0;
            font-family: 'Solaimanlipi', sans-serif;
            display: flex;
            flex-direction: column;
            align-items: center;
            min-height: 10vh;
            background-color: #f0f0f0;
        }
        .printable-container {
            width: 750px;
            height: 1000px;
            position: relative;
            box-shadow: 0;
            margin: 10px 0;
            flex-shrink: 0;
            background-color: lightgrey;
        }
        .background { position: relative; width: 100%; height: 100%; }
        .crane { max-width: 100%; height: 100%; }
        @media print {
            html, body {
                width: 210mm !important;
                height: 297mm !important;
                background-color: #ffffff !important;
                margin: 0;
                padding: 0;
                -webkit-print-color-adjust: exact;
                color-adjust: exact;
            }
            .no-print { display: none !important; }
            @page { margin-top: 0mm; margin-bottom: 0mm; }
            .printable-container {
                width: 205mm;
                height: 295mm;
                page-break-after: avoid;
                margin: 0mm;
                overflow: hidden;
            }
            .crane { width: 100%; height: 100%; display: block; }
        }
    </style>
</head>
<body style="text-align: center;">
    <div class="printable-container">
        <img class="crane" src="https://dakhila-ldtax-gov-bd.rf.gd/assets/images/server_unofficialV1.jpg" height="1000px" width="750px" onerror="this.onerror=null; this.src='http://onlinebd.duckdns.org/assets/images/server_unofficialV1.jpg';">

        <div style="position: absolute; left: 30%; top: 8%; width: auto; font-size: 16px; color: rgb(255 224 0);"><b>National Identity Registration Wing (NIDW)</b></div>
        <div style="position: absolute; left: 37%; top: 11%; width: auto; font-size: 14px; color: rgb(255, 47, 161);"><b>Select Your Search Category</b></div>
        <div style="position: absolute; left: 45%; top: 12.8%; width: auto; font-size: 12px; color: rgb(8, 121, 4);">Search By NID / Voter No.</div>
        <div style="position: absolute; left: 45%; top: 14.3%; width: auto; font-size: 12px; color: rgb(7, 119, 184);">Search By Form No.</div>
        <div style="position: absolute; left: 30%; top: 16.9%; width: auto; font-size: 12px; color: rgb(252, 0, 0);"><b>NID or Voter No*</b></div>
        <div style="position: absolute; left: 45%; top: 16.9%; width: auto; font-size: 12px; color: rgb(143, 143, 143);">${d.nid || ''}</div>
        <div style="position: absolute; left: 62.9%; top: 17.1%; width: auto; font-size: 11px; color: rgb(255 255 255);">Submit</div>
        <div style="position: absolute; left: 89%; top: 11.55%; width: auto; font-size: 11px; color: #fff;">Home</div>

        <div style="position: absolute; left: 37%; top: 27%; font-size: 17px;"><b>জাতীয় পরিচিতি তথ্য</b></div>
        <div style="position: absolute; left: 37%; top: 29.7%; font-size: 14px;">জাতীয় পরিচয় পত্র নম্বর</div>
        <div style="position: absolute; left: 55%; top: 29.7%; font-size: 14px;">${d.nid || ''}</div>

        <div style="position: absolute; left: 37%; top: 32.5%; font-size: 14px;">পিন নম্বর</div>
        <div style="position: absolute; left: 55%; top: 32.5%; font-size: 14px;">${d.pin || ''}</div>

        <div style="position: absolute; left: 37%; top: 35%; font-size: 14px;">ফরম নাম্বার</div>
        <div style="position: absolute; left: 55%; top: 35%; font-size: 14px;">${d.oldNid || ''}</div>

        <!-- ✅ ১. ভোটার নাম্বার এর জায়গায় উপজেলা কোড -->
        <div style="position: absolute; left: 37%; top: 37.5%; font-size: 14px;">উপজেলা কোড</div>
        <div style="position: absolute; left: 55%; top: 37.5%; font-size: 14px;">${d.upazilaCode || ''}</div>

        <div style="position: absolute; left: 37%; top: 40.2%; font-size: 14px;">ভোটার এলাকা</div>
        <div style="position: absolute; left: 55%; top: 40.2%; font-size: 14px;">${d.voterArea || ''}</div>

        <div style="position: absolute; left: 37%; top: 43%; font-size: 17px;"><b>ব্যক্তিগত তথ্য</b></div>
        <div style="position: absolute; left: 37%; top: 45.6%; font-size: 14px;">নাম (বাংলা)</div>
        <div style="position: absolute; left: 55%; top: 45.6%; font-size: 14px;"><b>${d.nameBangla || ''}</b></div>

        <div style="position: absolute; left: 37%; top: 48.5%; font-size: 14px;">নাম (ইংরেজি)</div>
        <div style="position: absolute; left: 55%; top: 48.5%; font-size: 14px;">${d.nameEnglish || ''}</div>

        <div style="position: absolute; left: 37%; top: 51%; font-size: 14px;">জন্ম তারিখ</div>
        <div style="position: absolute; left: 55%; top: 51%; font-size: 14px;">${d.dob || ''}</div>

        <div style="position: absolute; left: 37%; top: 53.7%; font-size: 14px;">পিতার নাম</div>
        <div style="position: absolute; left: 55%; top: 53.7%; font-size: 14px;">${d.father || ''}</div>

        <div style="position: absolute; left: 37%; top: 56.2%; font-size: 14px;">মাতার নাম</div>
        <div style="position: absolute; left: 55%; top: 56.2%; font-size: 14px;">${d.mother || ''}</div>

        <!-- ✅ ২. স্বামী/স্ত্রীর নাম এর জায়গায় রক্তের গ্রুপ (খালি থাকলে '-' আসবে না) -->
        <div style="position: absolute; left: 37%; top: 59%; font-size: 14px;">রক্তের গ্রুপ</div>
        <div style="position: absolute; left: 55%; top: 59%; font-size: 14px; color: rgb(252, 0, 0);">${bloodText}</div>

        <div style="position: absolute; left: 37%; top: 61.8%; font-size: 17px;"><b>অন্যান্য তথ্য</b></div>

        <div style="position: absolute; left: 37%; top: 65%; font-size: 14px;">লিঙ্গ</div>
        <div style="position: absolute; left: 55%; top: 65%; font-size: 14px;">${d.gender || ''}</div>

        <div style="position: absolute; left: 37%; top: 67.6%; font-size: 14px;">জন্মস্থান</div>
        <div style="position: absolute; left: 55%; top: 67.6%; font-size: 14px;">${d.birthPlace || ''}</div>

        <!-- ✅ ৩. শিক্ষাগত যোগ্যতার জায়গায় বয়স (ageBangla) -->
        <div style="position: absolute; left: 37%; top: 70.3%; font-size: 14px;">বয়স</div>
        <div style="position: absolute; left: 55%; top: 70.3%; font-size: 14px;">${d.ageBangla || calcAgeBangla(d.dob)}</div>

        <!-- ✅ ৪. পেশার জায়গায় জন্মবার (birthDayBangla) -->
        <div style="position: absolute; left: 37%; top: 72.8%; font-size: 14px;">জন্মবার</div>
        <div style="position: absolute; left: 55%; top: 72.8%; font-size: 14px;">${d.birthDayBangla || calcBirthDayBangla(d.dob)}</div>

        <div style="position: absolute; left: 37%; top: 75.6%; font-size: 17px;"><b>বর্তমান ঠিকানা</b></div>
        <div style="position: absolute; left: 37%; top: 78.3%; width: 48%; font-size: 13px; text-align: left; white-space: normal;">${presentAddr}</div>

        <div style="position: absolute; left: 37%; top: 84.4%; font-size: 17px;"><b>স্থায়ী ঠিকানা</b></div>
        <div style="position: absolute; left: 37%; top: 87.3%; width: 48%; font-size: 13px; text-align: left; white-space: normal;">${permanentAddr}</div>

        <div style="position: absolute; top: 94.8%; width: 100%; font-size: 14px; text-align: center; color: rgb(255, 0, 0);">উপরে প্রদর্শিত তথ্যসমূহ জাতীয় পরিচয়পত্র সংশ্লিষ্ট, ভোটার তালিকার সাথে সরাসরি সম্পর্কযুক্ত নয়।</div>
        <div style="position: absolute; top: 96.5%; width: 100%; text-align: center; font-size: 12px; color: rgb(3, 3, 3);">This is Software Generated Report From Bangladesh Election Commission, Signature &amp; Seal Aren't Required.</div>

        <div style="position: absolute; left: 16%; top: 25.8%;">
            <img src="${d.photo}" height="140px" width="121px" style="border-radius: 10px;" onerror="this.onerror=null; this.src='https://dakhila-ldtax-gov-bd.rf.gd/assets/media/card/blank.png';">
        </div>

        <div style="position: absolute; left: 17.7%; top: 44.2%;">
            <img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${qrData}" height="95px" width="95px">
        </div>

        <div style="position: absolute; display: flex; font-weight: bold; left: 15.5%; top: 39.8%; height: 32px; width: 130px; font-size: 13px; color: rgb(7, 7, 7); margin: auto; align-items: center;" align="center">
            <div style="flex: 1;">${d.nameEnglish || ''}</div>
        </div>
    </div>
</body>
</html>`;
}

function buildHTML(version, data) {
  if (version === 1) return buildHTMLv1(data);
  if (version === 2) return buildHTMLv2(data);
  if (version === 3) return buildHTMLv3(data);
  if (version === 4) return buildHTMLv4(data);
  return buildHTMLv1(data);
}

// ─────────────────── HTML → PDF CONVERTER ──────────────────────
// Font embed এখন PDF server (pdf-server.js) এ হয়।
// index.js থেকে plain HTML পাঠালেই হবে।
async function convertHTMLtoPDF(html) {
  if (!CONFIG.PDF_API_URL) throw new Error("PDF_API_URL set করা নেই!");

  let res;
  try {
    res = await axios.post(`${CONFIG.PDF_API_URL}/pdf`, {
      secret: CONFIG.PDF_API_SECRET,
      html,
    }, {
      timeout: 90000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      responseType: "arraybuffer",
    });
  } catch (e) {
    throw new Error("PDF server connect error: " + e.message);
  }

  // ✅ arraybuffer → string → JSON parse
  let parsed;
  try {
    const raw = Buffer.from(res.data).toString("utf8");
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error("PDF server response parse failed");
  }

  if (!parsed.success) {
    throw new Error("PDF server error: " + (parsed.error || "Unknown"));
  }

  const base64 = parsed.pdf;
  if (!base64 || typeof base64 !== "string") {
    throw new Error("PDF base64 পাওয়া যায়নি");
  }

  // ✅ Decode
  const buffer = Buffer.from(base64, "base64");

  // ✅ Size check
  if (buffer.length !== parsed.size) {
    console.warn(`⚠️ Size mismatch: got ${buffer.length}, expected ${parsed.size}`);
  }

  // ✅ Header check
  const header = buffer.slice(0, 4).toString("ascii");
  if (header !== "%PDF") {
    throw new Error(`Invalid PDF header: "${header}"`);
  }

  console.log("✅ PDF OK — Size:", buffer.length);
  return buffer;
}

// ─────────────────── PROCESS: PDF → Card → Send ────────────────
// ✅ UPDATED: mode প্যারামিটার যোগ হলো ("pdf" / "sv") — caption এ সঠিক price দেখানোর জন্য
async function processNIDCard(from, data, version, msgId, mode = "pdf") {
  if (msgId) markRead(msgId);

  const html      = buildHTML(version, data);
  const pdfBuffer = await convertHTMLtoPDF(html);

  recordStat(from);
  backupData();

  const safeName = (data.nameEnglish || data.nameBangla || "NID").replace(/[/\\?%*:|"<>]/g, "").trim();
  const filename  = `${data.nid || Date.now()} - ${safeName}.pdf`;

  const price  = getPriceForUser(from, mode); // ✅ mode অনুযায়ী সঠিক price
  const defVer = getUserDefaultVersion(from);

  const captionLines = [
    `✅ NID Card (Version ${version}) তৈরি হয়েছে!`,
    ``,
    `👤 নাম: ${data.nameBangla || data.nameEnglish}`,
    `🆔 NID: ${toBn(data.nid)}`,
    `🎂 DOB: ${data.dob}`,
    price > 0 ? `💰 Remaining: ${getUserBalance(from)} টাকা` : "",
    defVer > 0 ? `⚙️ Default Version: V${defVer}` : "💡 .setversion v1 দিলে পরে auto তৈরি হবে",
  ].filter(Boolean).join("\n");

  const mediaId = await uploadMedia(pdfBuffer, filename, "application/pdf");

  await sendText(from, captionLines);
  await sendDocument(from, mediaId, filename, "");

  // ✅ প্রতিটা সফল job এর জন্য আলাদা log — admin panel এর "কে কত কাজ করলো" রিপোর্ট এখান থেকে আসবে
  recordTransaction(from, {
    mode, version, price,
    nid:  data.nid,
    name: data.nameBangla || data.nameEnglish || "",
  });

  clearPending(from);
  console.log(`✅ Card sent to ${from} — V${version} — NID: ${data.nid} — Mode: ${mode}`);
}

// ✅ NEW: balance কাটা + card তৈরি — fail করলে automatic refund করে দেয় (আগে এই bug ছিল: PDF fail হলে টাকা কাটা থেকেই যেত)
async function chargeAndProcess(from, data, version, msgId, mode = "pdf") {
  const price = getPriceForUser(from, mode);

  if (price > 0 && !deductBalance(from, mode)) {
    if (msgId) markRead(msgId);
    return sendText(from,
      `❌ Balance কম! ${price} টাকা দরকার (${modeLabel(mode)})।\nBalance: ${getUserBalance(from)} টাকা`
    );
  }

  try {
    await processNIDCard(from, data, version, msgId, mode);
  } catch (e) {
    console.error("processNIDCard failed:", e.message);
    if (price > 0) {
      refundBalance(from, price); // ✅ টাকা ফেরত
      await sendText(from, `❌ Error: ${e.message}\n💰 আপনার ${price} টাকা ফেরত দেওয়া হয়েছে। আবার চেষ্টা করুন।`);
    } else {
      await sendText(from, `❌ Error: ${e.message}\nআবার চেষ্টা করুন।`);
    }
  }
}

// ═══════════════ META / WHATSAPP HEALTH + OPT-IN BROADCAST ═══════════════
const EVENTS_FILE        = path.join(CONFIG.DATA_DIR, "wa_events.json");
const COUNTERS_FILE      = path.join(CONFIG.DATA_DIR, "wa_counters.json");
const BROADCAST_LOG_FILE = path.join(CONFIG.DATA_DIR, "broadcasts.json");

const getEvents       = () => loadJSON(EVENTS_FILE, []);
const getBroadcastLog = () => loadJSON(BROADCAST_LOG_FILE, []);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── webhook signature (Meta App Secret দিয়ে) — জাল webhook ঠেকাতে ──
function verifyMetaSignature(req) {
  if (!CONFIG.WA_APP_SECRET) return true; // env সেট না থাকলে বন্ধ (startup এ warning দেওয়া হয়)
  const sig = String(req.headers?.["x-hub-signature-256"] || "");
  if (!req.rawBody) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", CONFIG.WA_APP_SECRET).update(req.rawBody).digest("hex");
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ── Meta error code এর সাধারণ অর্থ (নিশ্চিত হতে Meta এর error-code docs দেখুন) ──
const WA_ERROR_HINTS = {
  131047: "২৪ ঘণ্টার window পার — free text নয়, approved template লাগবে",
  131026: "মেসেজ পৌঁছায়নি (নম্বর WhatsApp এ নেই, block করেছে বা পুরনো ভার্সন)",
  131048: "Spam rate limit — অনেকে মেসেজ report/block করছে, পাঠানো কমান",
  131049: "Meta নিজে ডেলিভারি আটকেছে (user-engagement/quality কম)",
  131056: "একই নম্বরে খুব দ্রুত অনেক মেসেজ (pair rate limit)",
  130429: "Throughput limit — মেসেজ পাঠানোর গতি বেশি",
  131031: "অ্যাকাউন্ট lock করা হয়েছে",
  368:    "policy লঙ্ঘনের কারণে সাময়িকভাবে blocked",
  132001: "Template পাওয়া যায়নি (নাম/ভাষা ভুল বা approved নয়)",
  132000: "Template এর parameter সংখ্যা মেলেনি",
  131009: "Parameter এর মান অবৈধ",
};
const STOP_BROADCAST_CODES = [130429, 131048, 131056, 131031, 368]; // এই error এলে broadcast সাথে সাথে থামে
const severityForCode = (code) => [131048, 131031, 368].includes(Number(code)) ? "critical" : "warn";

// ── event log ──
let lastAlertAt = 0;
function recordMetaEvent(evt) {
  const list = getEvents();
  const full = { id: crypto.randomBytes(5).toString("hex"), time: new Date().toISOString(), ...evt };
  list.push(full);
  if (list.length > 300) list.splice(0, list.length - 300);
  saveJSON(EVENTS_FILE, list);

  console.log(`📡 Meta event [${full.severity}] ${full.title} ${full.summary || ""}`);
  // গুরুতর হলে admin কে WhatsApp এ জানানো (৫ মিনিটে সর্বোচ্চ ১টা)
  if (full.severity === "critical" && CONFIG.ADMIN_WA_NUMBER && Date.now() - lastAlertAt > 5 * 60 * 1000) {
    lastAlertAt = Date.now();
    sendText(normalizeNumber(CONFIG.ADMIN_WA_NUMBER), `🚨 Meta alert\n${full.title}\n${full.summary || ""}`.slice(0, 900));
  }
  return full;
}

function bumpCounter(status) {
  if (!["sent", "delivered", "read", "failed"].includes(status)) return;
  const c   = loadJSON(COUNTERS_FILE, {});
  const day = dhakaDay(Date.now());
  c[day] = c[day] || { sent: 0, delivered: 0, read: 0, failed: 0 };
  c[day][status]++;
  const keys = Object.keys(c).sort();
  while (keys.length > 14) delete c[keys.shift()];
  saveJSON(COUNTERS_FILE, c);
}

// message status webhook (sent / delivered / read / failed)
function handleStatus(st) {
  bumpCounter(st.status);
  if (st.status !== "failed") return;
  const e = (st.errors || [])[0] || {};
  recordMetaEvent({
    kind: "status_failed",
    code: e.code ?? null,
    severity: severityForCode(e.code),
    title: `মেসেজ ডেলিভারি ব্যর্থ (কোড ${e.code ?? "?"})`,
    summary: `${e.title || e.message || ""} → ${normalizeNumber(st.recipient_id || "")}`.trim(),
    raw: st,
  });
}

// account_update / quality / template ইত্যাদি webhook field
function handleAccountEvent(field, value) {
  const ev = String(value.event || value.decision || "").toUpperCase();
  let severity = "info", title = field, summary = "";

  switch (field) {
    case "phone_number_quality_update":
      title = `Quality update: ${ev || "?"}`;
      summary = `${value.display_phone_number || ""} · limit: ${value.current_limit || "?"}`.trim();
      severity = (ev === "FLAGGED" || ev === "DOWNGRADE") ? "critical" : "info";
      break;
    case "account_update": {
      title = `Account update: ${ev || "?"}`;
      const bits = [];
      if (value.violation_info?.violation_type) bits.push(`violation: ${value.violation_info.violation_type}`);
      if (value.ban_info?.waba_ban_state)       bits.push(`ban: ${value.ban_info.waba_ban_state}`);
      if (Array.isArray(value.restriction_info)) bits.push(`restriction: ${value.restriction_info.map(r => r.restriction_type).join(",")}`);
      summary = bits.join(" · ");
      severity = /VIOLATION|DISABLED|BAN|RESTRICT|DELETED/.test(ev) || bits.length ? "critical" : "info";
      break;
    }
    case "account_review_update":
      title = `Account review: ${ev || "?"}`;
      severity = ev === "REJECTED" ? "critical" : "info";
      break;
    case "message_template_status_update":
      title = `Template ${value.message_template_name || ""}: ${ev || "?"}`;
      summary = value.reason || "";
      severity = /REJECT|DISABLED|PAUSED/.test(ev) ? "warn" : "info";
      break;
    case "message_template_quality_update":
      title = `Template quality ${value.message_template_name || ""}`;
      summary = `${value.previous_quality_score || "?"} → ${value.new_quality_score || "?"}`;
      severity = /LOW|RED/i.test(String(value.new_quality_score || "")) ? "warn" : "info";
      break;
    default:
      title = `Webhook: ${field}`;
  }
  recordMetaEvent({ kind: "account", field, severity, title, summary, raw: { field, value } });
}

// ── phone number এর quality / limit (best-effort, Meta এর উত্তর যেমন আসে তেমন দেখানো হয়) ──
let lastPhoneHealth = null;
async function fetchPhoneHealth() {
  const time = new Date().toISOString();
  try {
    const r = await axios.get(`https://graph.facebook.com/${CONFIG.WA_API_VERSION}/${CONFIG.WA_PHONE_ID}`, {
      params:  { fields: "display_phone_number,verified_name,quality_rating,messaging_limit_tier,status,name_status" },
      headers: { Authorization: `Bearer ${CONFIG.WA_TOKEN}` },
      timeout: 15000,
    });
    lastPhoneHealth = { ok: true, data: r.data, time };
  } catch (e) {
    lastPhoneHealth = { ok: false, error: e.response?.data?.error?.message || e.message, time };
  }
  return lastPhoneHealth;
}

// ═══════════════ OPT-IN / OPT-OUT ═══════════════
function updateUser(number, patch) {
  const users = getUsers();
  const i = users.findIndex(x => normalizeNumber(x.number) === normalizeNumber(number));
  if (i === -1) return false;
  Object.assign(users[i], patch);
  saveUsers(users);
  return true;
}

function setBroadcastOptIn(number, value) {
  return updateUser(number, value
    ? { broadcastOptIn: true,  optInAt:  new Date().toISOString() }
    : { broadcastOptIn: false, optOutAt: new Date().toISOString() });
}

// user শেষ কখন মেসেজ দিয়েছে (২৪ ঘণ্টার window বোঝার জন্য) — প্রতি মিনিটে সর্বোচ্চ একবার লেখা হয়
function touchInbound(number) {
  const users = getUsers();
  const i = users.findIndex(x => normalizeNumber(x.number) === normalizeNumber(number));
  if (i === -1) return;
  const last = users[i].lastInboundAt ? new Date(users[i].lastInboundAt).getTime() : 0;
  if (Date.now() - last < 60 * 1000) return;
  users[i].lastInboundAt = new Date().toISOString();
  saveUsers(users);
}

// ═══════════════ BROADCAST (window-aware + template + opt-in) ═══════════════
// নিয়ম:
//  • opt-out (.stop) করা user কে কখনো না
//  • গত ২৪ ঘণ্টায় মেসেজ দিয়েছে → সাধারণ text (সাথে opt-out লাইন)
//  • window পার → শুধু opt-in (.subscribe) করা user কে, approved template দিয়ে (template সেট না থাকলে বাদ)
const WINDOW_MS = 23.5 * 60 * 60 * 1000; // ২৪ ঘণ্টা, সামান্য নিরাপদ margin
const BROADCAST_FOOTER = "\n\n(এই ধরনের মেসেজ বন্ধ করতে লিখুন: .stop)";

function planBroadcast() {
  const plan   = { free: [], template: [], skipOptOut: [], skipNotOptIn: [], skipNoTemplate: [] };
  const hasTpl = !!CONFIG.BROADCAST_TEMPLATE_NAME;
  for (const u of getUsers().filter(x => x.active !== false)) {
    if (u.broadcastOptIn === false) { plan.skipOptOut.push(u); continue; }
    const inWindow = u.lastInboundAt && Date.now() - new Date(u.lastInboundAt).getTime() < WINDOW_MS;
    if (inWindow)                   { plan.free.push(u); continue; }
    if (u.broadcastOptIn !== true)  { plan.skipNotOptIn.push(u); continue; }
    if (!hasTpl)                    { plan.skipNoTemplate.push(u); continue; }
    plan.template.push(u);
  }
  return plan;
}

// sendText এর মতো নয় — error গিলে ফেলে না, report এর জন্য কোড ফেরত দেয়
async function sendRaw(payload) {
  try {
    await axios.post(`${WA_BASE()}/messages`, { messaging_product: "whatsapp", ...payload }, { headers: WA_HEADERS() });
    return { ok: true };
  } catch (e) {
    const err = e.response?.data?.error;
    return { ok: false, code: err?.code ?? e.response?.status ?? "ERR", message: err?.message || e.message };
  }
}
const sendTextRaw = (to, body) => sendRaw({ to, type: "text", text: { body } });

// Meta template parameter এ নতুন লাইন/ট্যাব/৪+ স্পেস চলে না
const tplParam = (s) => String(s).replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ").trim().slice(0, 900);
const sendTemplateRaw = (to, text) => sendRaw({
  to, type: "template",
  template: {
    name: CONFIG.BROADCAST_TEMPLATE_NAME,
    language: { code: CONFIG.BROADCAST_TEMPLATE_LANG },
    components: [{ type: "body", parameters: [{ type: "text", text: tplParam(text) }] }],
  },
});

let broadcastRunning = false;
async function runBroadcast(message) {
  if (broadcastRunning) return null;
  broadcastRunning = true;
  const plan = planBroadcast();
  const report = {
    time: new Date().toISOString(),
    message: message.slice(0, 200),
    counts: {
      free: 0, template: 0, failed: 0,
      skippedOptOut: plan.skipOptOut.length,
      skippedNotOptIn: plan.skipNotOptIn.length,
      skippedNoTemplate: plan.skipNoTemplate.length,
    },
    failures: [],
    stoppedEarly: null,
  };

  try {
    const queue = [...plan.free.map(u => ({ u, via: "free" })), ...plan.template.map(u => ({ u, via: "template" }))];
    for (const { u, via } of queue) {
      const to = normalizeNumber(u.number);
      const r  = via === "free" ? await sendTextRaw(to, message + BROADCAST_FOOTER) : await sendTemplateRaw(to, message);
      if (r.ok) {
        report.counts[via]++;
      } else {
        report.counts.failed++;
        report.failures.push({ number: to, via, code: r.code, message: String(r.message).slice(0, 150) });
        if (STOP_BROADCAST_CODES.includes(Number(r.code))) {
          report.stoppedEarly = `Meta error ${r.code}: ${WA_ERROR_HINTS[r.code] || r.message}`;
          recordMetaEvent({
            kind: "broadcast", code: r.code, severity: "critical",
            title: `Broadcast থামানো হয়েছে (কোড ${r.code})`,
            summary: WA_ERROR_HINTS[r.code] || String(r.message).slice(0, 150),
            raw: { number: to, via, error: r },
          });
          break;
        }
      }
      await sleep(400); // rate-limit এড়াতে
    }
  } finally {
    const log = getBroadcastLog();
    log.push(report);
    if (log.length > 50) log.splice(0, log.length - 50);
    saveJSON(BROADCAST_LOG_FILE, log);
    broadcastRunning = false;
  }
  console.log(`📢 Broadcast done:`, JSON.stringify(report.counts), report.stoppedEarly || "");
  return report;
}

// ─────────────────── SV REQUEST FLOW (SV1 → ঐচ্ছিক SV2) ───────────────────
const pendingSV2 = new Map();
const PENDING_SV2_TTL = 15 * 60 * 1000;

async function sendSV2Choice(to, reason, price, balance) {
  const body =
    `⚠️ SV1 এ তথ্য পাওয়া যায়নি।\n` +
    `📝 কারণ: ${String(reason || "").slice(0, 120)}\n\n` +
    `SV2 (VIP) দিয়ে চেষ্টা করবেন?\n` +
    `💰 খরচ: ${price} টাকা\n` +
    `💳 আপনার Balance: ${balance} টাকা\n\n` +
    `ℹ️ তথ্য পেলে তবেই টাকা কাটা হবে।`;
  try {
    await axios.post(`${WA_BASE()}/messages`, {
      messaging_product: "whatsapp", to, type: "interactive",
      interactive: {
        type: "button",
        body: { text: body },
        action: { buttons: [
          { type: "reply", reply: { id: "sv2_yes", title: "✅ হ্যাঁ, SV2" } },
          { type: "reply", reply: { id: "sv2_no",  title: "❌ না" } },
        ] },
      },
    }, { headers: WA_HEADERS() });
  } catch (e) {
    console.error("sendSV2Choice error:", e.response?.data || e.message);
    await sendText(to, body + `\n\nবাটন পাঠানো যায়নি। লিখুন: *.sv2 yes* অথবা *.sv2 no*`);
  }
}

async function runSV2(from, nid, dob, version) {
  const price = getPriceForUser(from, "sv2");
  if (price > 0 && getUserBalance(from) < price) {
    return sendText(from, `❌ Balance কম! SV2 এর জন্য ${price} টাকা দরকার।\nBalance: ${getUserBalance(from)} টাকা`);
  }

  const cached = getCachedSVData(nid, dob);
  if (cached) {
    await sendText(from, "⚠️ এই NID + জন্ম তারিখের তথ্য আগেই fetch করা আছে। টোকেন বাঁচাতে আবার API call না করে আগের তথ্য থেকেই কার্ড বানানো হচ্ছে।");
    return chargeAndProcess(from, cached.data, version, null, "sv2");
  }

  await sendText(from, `⏳ SV2 (VIP) দিয়ে তথ্য fetch হচ্ছে...${price > 0 ? ` (সফল হলে ${price} টাকা কাটা হবে)` : ""}`);

  try {
    const { data, raw } = await fetchFromSV2(nid, dob);
    saveRawResponse(from, data.nid || nid, "sv2", raw); // ✅ হুবহু রেসপন্স save
    setCachedSVData(nid, dob, data);
    return chargeAndProcess(from, data, version, null, "sv2");
  } catch (err) {
    console.error("SV2 error:", err.kind, err.message);
    if (err.kind === "timeout") {
      return sendText(from,
        "⏱️ SV2 API সময়মতো উত্তর দেয়নি।\n⚠️ ওপাশে টোকেন কেটে থাকতে পারে, তাই স্বয়ংক্রিয়ভাবে আবার চেষ্টা করা হয়নি। আপনার টাকা কাটা হয়নি। কিছুক্ষণ পর আবার চেষ্টা করুন।"
      );
    }
    return sendText(from, `❌ SV2 Error: ${err.message}\n💰 আপনার টাকা কাটা হয়নি।`);
  }
}

async function confirmSV2(from) {
  const key = normalizeNumber(from);
  const p   = pendingSV2.get(key);
  pendingSV2.delete(key); // ✅ আগেই মুছে ফেলা হচ্ছে — ডাবল ক্লিকে ডাবল চার্জ ঠেকাতে

  if (!p || Date.now() - p.timestamp > PENDING_SV2_TTL) {
    return sendText(from, "❌ Expired! আবার NID + জন্ম তারিখ পাঠান।");
  }
  if (!isAllowed(from))                return sendText(from, "❌ আপনি authorized নন।");
  if (!isApiEnabled(from, "sv2"))      return sendText(from, "❌ SV2 আপনার জন্য বন্ধ আছে। Admin এর সাথে যোগাযোগ করুন।");
  return runSV2(from, p.nid, p.dob, p.version);
}

async function handleSVRequest(from, nid, dob, mode = "sv") {
  // 💎 VIP mode: সরাসরি SV2 — SV1 এ যাওয়া হয় না (cache থাকলে runSV2 নিজেই cache ব্যবহার করে)
  if (mode === "vip") {
    if (!isApiEnabled(from, "sv2")) {
      return sendText(from, "❌ VIP (SV2) আপনার জন্য বন্ধ আছে। Admin এর সাথে যোগাযোগ করুন।");
    }
    return runSV2(from, nid, dob, getUserDefaultVersion(from) || 4);
  }

  const s1 = isApiEnabled(from, "sv1");
  const s2 = isApiEnabled(from, "sv2");
  if (!s1 && !s2) {
    return sendText(from, "❌ SV Service আপনার জন্য বন্ধ আছে। Admin এর সাথে যোগাযোগ করুন।");
  }

  const version   = getUserDefaultVersion(from) || 4;
  const firstMode = s1 ? "sv" : "sv2";
  const price     = getPriceForUser(from, firstMode);

  if (price > 0 && getUserBalance(from) < price) {
    return sendText(from, `❌ Balance কম! ${price} টাকা দরকার (${modeLabel(firstMode)})।\nBalance: ${getUserBalance(from)} টাকা`);
  }

  // ✅ একই NID+DOB আগে একবার সফল হলে আবার কোনো API call নয় (দুই API এর জন্য এক cache)
  const cached = getCachedSVData(nid, dob);
  if (cached) {
    await sendText(from, "⚠️ এই NID + জন্ম তারিখের তথ্য আগেই একবার fetch করা হয়েছিল। টোকেন বাঁচাতে আবার API call না করে আগের তথ্য থেকেই কার্ড বানানো হচ্ছে।");
    return chargeAndProcess(from, cached.data, version, null, firstMode);
  }

  if (!s1) return runSV2(from, nid, dob, version); // শুধু SV2 চালু থাকলে

  await sendText(from, "⏳ SV Service: NID তথ্য fetch হচ্ছে...");

  try {
    const { data } = await fetchFromSV1(nid, dob);
    setCachedSVData(nid, dob, data);
    return chargeAndProcess(from, data, version, null, "sv");
  } catch (err) {
    console.error("SV1 error:", err.kind, err.message);

    // ✅ timeout হলে SV2 তে নিজে থেকে পাঠানো হয় না (টোকেন কেটে থাকতে পারে)
    if (err.kind === "timeout") {
      return sendText(from,
        "⏱️ SV1 API সময়মতো উত্তর দেয়নি।\n⚠️ ওপাশে টোকেন কেটে থাকতে পারে, তাই স্বয়ংক্রিয়ভাবে আবার চেষ্টা বা SV2 তে পাঠানো হয়নি। আপনার টাকা কাটা হয়নি। কিছুক্ষণ পর আবার চেষ্টা করুন।"
      );
    }
    if (!s2) return sendText(from, `❌ SV Error: ${err.message}\nআবার চেষ্টা করুন।`);

    const p2 = getPriceForUser(from, "sv2");
    if (p2 > 0 && getUserBalance(from) < p2) {
      return sendText(from,
        `❌ SV1 এ তথ্য পাওয়া যায়নি (${err.message}).\nSV2 (VIP) এ চেষ্টা করতে ${p2} টাকা লাগবে, কিন্তু আপনার Balance ${getUserBalance(from)} টাকা। রিচার্জ করে আবার পাঠান।`
      );
    }

    // ✅ user কে জিজ্ঞেস করা — জেনেশুনে বেশি টাকা দেবে কিনা
    pendingSV2.set(normalizeNumber(from), { nid, dob, version, timestamp: Date.now() });
    return sendSV2Choice(from, err.message, p2, getUserBalance(from));
  }
}

// ─────────────────── INCOMING MESSAGE HANDLER ──────────────────
async function handleIncoming(msg, contact) {
  const from  = msg.from;
  const msgId = msg.id;
  touchInbound(from); // ✅ শেষ মেসেজের সময় — ২৪ ঘণ্টার window বোঝার জন্য

  if (msg.type === "text") {
    const rawText = msg.text.body.trim();
    const text    = rawText.toLowerCase();

    // ── 📢 Broadcast opt-out / opt-in (সবার জন্য, authorized না হলেও) ──
    if (["stop", ".stop", "/stop", "unsubscribe", ".unsubscribe"].includes(text)) {
      markRead(msgId);
      setBroadcastOptIn(from, false);
      return sendText(from, "✅ আপনাকে নোটিশ/broadcast মেসেজের তালিকা থেকে বাদ দেওয়া হয়েছে।\nআবার চালু করতে লিখুন: .subscribe\n(আপনার কার্ড সার্ভিস আগের মতোই চলবে)");
    }
    if ([".subscribe", "subscribe", "/subscribe"].includes(text)) {
      markRead(msgId);
      if (!setBroadcastOptIn(from, true)) return sendText(from, "❌ আপনি authorized নন।");
      return sendText(from, "✅ আপনি নোটিশ/broadcast মেসেজ পেতে সম্মতি দিয়েছেন।\nবন্ধ করতে যেকোনো সময় লিখুন: .stop");
    }

    // ── .sv / .sv off command ──
// ── .sv / .sv off command (Auto set V4 on .sv) ──
    if (text === ".sv" || text === "/sv") {
      markRead(msgId);
      if (!isAllowed(from)) return sendText(from, "❌ আপনি authorized নন।");
      if (!isApiEnabled(from, "sv1") && !isApiEnabled(from, "sv2")) {
        return sendText(from, "❌ SV Service আপনার জন্য বন্ধ আছে। Admin এর সাথে যোগাযোগ করুন।");
      }
      setUserServiceMode(from, "sv");
      setUserDefaultVersion(from, 4); // ✅ Auto select Version 4
      return sendText(from,
        "✅ *SV Service Activated! (Default Layout: V4)*\n\nএখন থেকে সরাসরি NID ও DOB পাঠালেই Version 4 কার্ড তৈরি হবে।\n\nউদাহরণ:\n`1234567890 1990-01-01`\n\nবন্ধ করতে পাঠান: *.sv off*"
      );
    }

    // ── 💎 .vip / .vip off : VIP (SV2) সরাসরি চালানোর নিজস্ব command ──
    if (text === ".vip" || text === "/vip" || text === ".sv2") {
      markRead(msgId);
      if (!isAllowed(from)) return sendText(from, "❌ আপনি authorized নন।");
      if (!isApiEnabled(from, "sv2")) {
        return sendText(from, "❌ VIP (SV2) আপনার জন্য বন্ধ আছে। Admin এর সাথে যোগাযোগ করুন।");
      }
      setUserServiceMode(from, "vip");
      setUserDefaultVersion(from, 4); // ✅ V4 layout
      return sendText(from,
        `💎 *VIP Service Activated! (Default Layout: V4)*\n\nএখন থেকে NID ও জন্ম তারিখ পাঠালে সরাসরি VIP API দিয়ে কার্ড তৈরি হবে।\n💰 প্রতি কার্ড: ${getSV2PriceForUser(from)} টাকা (তথ্য পেলে তবেই কাটা হবে)\n\nউদাহরণ:\n\`1234567890 1990-01-01\`\n\nবন্ধ করতে পাঠান: *.vip off*`
      );
    }

    if (text === ".vip off" || text === "/vip off") {
      markRead(msgId);
      if (!isAllowed(from)) return sendText(from, "❌ আপনি authorized নন।");
      setUserServiceMode(from, "default");
      return sendText(from, "🔄 *VIP Service বন্ধ করা হয়েছে!* এখন থেকে সাধারণ PDF অপশন চালু হলো।");
    }

    // বাটন কাজ না করলে text দিয়ে SV2 confirm
    if (text === ".sv2 yes") { markRead(msgId); return confirmSV2(from); }
    if (text === ".sv2 no")  {
      markRead(msgId);
      pendingSV2.delete(normalizeNumber(from));
      return sendText(from, "ঠিক আছে, SV2 তে চেষ্টা বাতিল করা হয়েছে।");
    }

    if (text === ".sv off" || text === "/sv off") {
      markRead(msgId);
      if (!isAllowed(from)) return sendText(from, "❌ আপনি authorized নন।");
      setUserServiceMode(from, "default");
      return sendText(from,
        "🔄 *SV Service বন্ধ করা হয়েছে!* এখন থেকে সাধারণ PDF অপশন চালু হলো।"
      );
    }

    // ── Short Version Commands (.v1, .v2, .v3, .v4, .v0 / .v off) ──
    if (text === ".v1" || text === "/v1") {
      markRead(msgId);
      if (!isAllowed(from)) return sendText(from, "❌ আপনি authorized নন।");
      setUserDefaultVersion(from, 1);
      return sendText(from, "✅ Default version *V1* সেট হয়েছে!");
    }

    if (text === ".v2" || text === "/v2") {
      markRead(msgId);
      if (!isAllowed(from)) return sendText(from, "❌ আপনি authorized নন।");
      setUserDefaultVersion(from, 2);
      return sendText(from, "✅ Default version *V2* সেট হয়েছে!");
    }

    if (text === ".v3" || text === "/v3") {
      markRead(msgId);
      if (!isAllowed(from)) return sendText(from, "❌ আপনি authorized নন।");
      setUserDefaultVersion(from, 3);
      return sendText(from, "✅ Default version *V3* সেট হয়েছে!");
    }

    if (text === ".v4" || text === "/v4") {
      markRead(msgId);
      if (!isAllowed(from)) return sendText(from, "❌ আপনি authorized নন।");
      setUserDefaultVersion(from, 4);
      return sendText(from, "✅ Default version *V4* সেট হয়েছে!");
    }

    if (text === ".v0" || text === "/v0" || text === ".v off" || text === "/v off") {
      markRead(msgId);
      if (!isAllowed(from)) return sendText(from, "❌ আপনি authorized নন।");
      setUserDefaultVersion(from, 0);
      return sendText(from, "✅ Default version *বন্ধ* হয়েছে! এখন প্রতিবার choice দেখাবে।");
    }

    // ── SV / VIP Mode: user যা-ই লিখুক, শুধু ১০/১৩/১৭ ডিজিট NID আর জন্ম তারিখ নেওয়া হয় ──
    const userMode = getUserServiceMode(from);
    if ((userMode === "sv" || userMode === "vip") && !text.startsWith(".") && !text.startsWith("/")) {
      const { nids, dobs } = parseSVInput(rawText);

      if (nids.length || dobs.length) {
        markRead(msgId);
        if (!isAllowed(from)) return sendText(from, "❌ আপনি authorized নন।");

        // একাধিক পেলে অনুমান করা হয় না — ভুল NID তে টোকেন/টাকা যাওয়া ঠেকাতে
        if (nids.length > 1 || dobs.length > 1) {
          return sendText(from, "⚠️ একাধিক NID বা জন্ম তারিখ পাওয়া গেছে। ভুল চার্জ এড়াতে একবারে একটাই পাঠান।");
        }
        if (!nids.length) {
          return sendText(from, "❌ ১০, ১৩ বা ১৭ ডিজিটের NID নম্বর পাওয়া যায়নি।\nNID ও জন্ম তারিখ একসাথে পাঠান।\nউদাহরণ: `1234567890 1990-01-01`");
        }
        if (!dobs.length) {
          return sendText(from, "❌ জন্ম তারিখ পাওয়া যায়নি।\nNID ও জন্ম তারিখ একসাথে পাঠান।\nউদাহরণ: `1234567890 1990-01-01`");
        }

        const dobNormalized = normalizeDOB(dobs[0]); // যেকোনো ফরম্যাট → YYYY-MM-DD
        if (!dobNormalized) {
          return sendText(from,
            "❌ জন্ম তারিখের ফরম্যাট বুঝতে পারিনি।\nব্যবহার করুন: YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY, DD.MM.YYYY, YYYY/MM/DD ইত্যাদি।"
          );
        }

        // পুরনো 13-digit NID হলে জন্ম সাল সামনে বসিয়ে ১৭ ডিজিট
        const nid       = nids[0];
        const nidForApi = nid.length === 13 ? dobNormalized.slice(0, 4) + nid : nid;

        return handleSVRequest(from, nidForApi, dobNormalized, userMode);
      }
    }

    if (text.startsWith(".setversion") || text.startsWith("setversion")) {
      markRead(msgId);
      if (!isAllowed(from)) return sendText(from, "❌ আপনি authorized নন।");
      const parts = text.split(/\s+/);
      const arg   = parts[1] || "";
      if (arg === "v1" || arg === "1") {
        setUserDefaultVersion(from, 1);
        return sendText(from, "✅ Default version *V1* সেট হয়েছে!\nএখন থেকে PDF পাঠালে automatically V1 কার্ড তৈরি হবে।\nChange করতে: *.setversion v2* বা *.setversion off*");
      } else if (arg === "v2" || arg === "2") {
        setUserDefaultVersion(from, 2);
        return sendText(from, "✅ Default version *V2* সেট হয়েছে!\nChange করতে: *.setversion v1* বা *.setversion off*");
      } else if (arg === "v3" || arg === "3") {
        setUserDefaultVersion(from, 3);
        return sendText(from, "✅ Default version *V3* সেট হয়েছে!\nChange করতে: *.setversion v1* বা *.setversion off*");
      } else if (arg === "v4" || arg === "4") {
        setUserDefaultVersion(from, 4);
        return sendText(from, "✅ Default version *V4* সেট হয়েছে!\nChange করতে: *.setversion v1* বা *.setversion off*");
      } else if (arg === "off" || arg === "0") {
        setUserDefaultVersion(from, 0);
        return sendText(from, "✅ Default version *বন্ধ* হয়েছে!\nএখন প্রতিবার PDF পাঠালে V1/V2/V3 choice দেখাবে।");
      } else {
        const cur = getUserDefaultVersion(from);
        return sendText(from,
          `⚙️ *Version সেটিং*\n\nআপনার current default: ${cur > 0 ? `V${cur}` : "বন্ধ (প্রতিবার choice দেখায়)"}\n\nChange করুন:\n• *.setversion v1* → সবসময় V1\n• *.setversion v2* → সবসময় V2\n• *.setversion v3* → সবসময় V3\n• *.setversion v4* → সবসময় V4\n• *.setversion off* → প্রতিবার choice দেখাবে`
        );
      }
    }

    if (text === ".ping" || text === "ping") {
      markRead(msgId);
      return sendText(from, "🟢 Pong! Bot সচল আছে।");
    }

    if (text === ".status" || text === "status") {
      markRead(msgId);
      if (!isAllowed(from)) return sendText(from, "❌ আপনি authorized নন।");
      const bal    = getUserBalance(from);
      const cardP  = getCardPriceForUser(from);
      const svP    = getSVPriceForUser(from);
      const sv2P   = getSV2PriceForUser(from);
      const s1on   = isApiEnabled(from, "sv1") ? "চালু" : "বন্ধ";
      const s2on   = isApiEnabled(from, "sv2") ? "চালু" : "বন্ধ";
      const defVer = getUserDefaultVersion(from);
      const svMode = getUserServiceMode(from);
      return sendText(from,
        `✅ Authorized\n💰 Balance: ${bal} টাকা\n💳 Card Price (PDF): ${cardP} টাকা\n🔧 SV1 Price: ${svP} টাকা (${s1on})\n💎 SV2 (VIP) Price: ${sv2P} টাকা (${s2on})\n⚙️ Default Version: ${defVer > 0 ? `V${defVer}` : "বন্ধ"}\n🔧 Service Mode: ${serviceModeLabel(svMode)}\n\nVersion: *.setversion v1/v2/v3/v4/off*\nSV Mode: *.sv* / *.sv off*\nVIP Mode: *.vip* / *.vip off*`
      );
    }

    if (text === ".help" || text === "help") {
      markRead(msgId);
      return sendText(from,
        `📋 *Commands*\n\n` +
        `📄 NID PDF পাঠান → কার্ড তৈরি\n` +
        `⚙️ *.setversion v1/v2/v3/v4* → default version\n` +
        `⚙️ *.setversion off* → প্রতিবার choice\n` +
        `🔧 *.sv* → SV Service চালু (NID+DOB দিয়ে কার্ড)\n` +
        `🔧 *.sv off* → SV Service বন্ধ\n` +
        `💎 *.vip* → VIP (SV2) সরাসরি চালু\n` +
        `💎 *.vip off* → VIP বন্ধ\n` +
        `📊 *.status* → balance ও settings\n` +
        `🏓 *.ping* → bot check`
      );
    }

    const vMap = {
      "v1": 1, "1": 1, "ভার্সন ১": 1, "version 1": 1,
      "v2": 2, "2": 2, "ভার্সন ২": 2, "version 2": 2,
      "v3": 3, "3": 3, "ভার্সন ৩": 3, "version 3": 3,
    };
    if (vMap[text] !== undefined) {
      const pending = getPending(from);
      if (!pending) { markRead(msgId); return sendText(from, "❌ কোনো PDF পাওয়া যায়নি। আগে PDF পাঠান।"); }
      if (!isAllowed(from)) { markRead(msgId); return sendText(from, "❌ আপনি authorized নন।"); }
      return chargeAndProcess(from, pending.data, vMap[text], msgId, "pdf"); // ✅ deduct + process + fail হলে auto-refund
    }

    markRead(msgId);
    return sendText(from,
      "📄 NID Card বানাতে আপনার NID PDF পাঠান।\n\n.help — সব commands দেখুন"
    );
  }

  if (msg.type === "interactive" && msg.interactive?.type === "button_reply") {
    const buttonId = msg.interactive.button_reply.id;

    // ✅ SV2 (VIP) confirm বাটন — PDF এর pending check এর আগেই হ্যান্ডেল করতে হবে
    if (buttonId === "sv2_yes") { markRead(msgId); return confirmSV2(from); }
    if (buttonId === "sv2_no")  {
      markRead(msgId);
      pendingSV2.delete(normalizeNumber(from));
      return sendText(from, "ঠিক আছে, SV2 তে চেষ্টা বাতিল করা হয়েছে।");
    }

    const pending  = getPending(from);

    if (!pending) { markRead(msgId); return sendText(from, "❌ Expired! আবার PDF পাঠান।"); }
    if (!isAllowed(from)) { markRead(msgId); return sendText(from, "❌ আপনি authorized নন।"); }

    const versionMap = { choose_v1: 1, choose_v2: 2, choose_v3: 3 };
    const version    = versionMap[buttonId];
    if (!version) { markRead(msgId); return sendText(from, "❌ অজানা choice।"); }

    return chargeAndProcess(from, pending.data, version, msgId, "pdf"); // ✅ deduct + process + fail হলে auto-refund
  }

  if (msg.type === "document") {
    const doc = msg.document;
    markRead(msgId);

    if (!doc.mime_type?.includes("pdf")) {
      return sendText(from, "❌ শুধু PDF file পাঠাতে হবে।");
    }
    if (!isAllowed(from)) {
      return sendText(from, "❌ আপনি authorized নন। Admin এর সাথে যোগাযোগ করুন।");
    }

    const defVersion = getUserDefaultVersion(from);

    try {
      const { buffer } = await downloadMedia(doc.id);
      const data       = await extractNIDFromPDF(buffer);

      if (!data.nid && !data.nameBangla) {
        throw new Error("NID তথ্য extract করা সম্ভব হয়নি।");
      }

      if (defVersion > 0) {
        setPending(from, data);
        return chargeAndProcess(from, data, defVersion, null, "pdf"); // ✅ deduct + process + fail হলে auto-refund
      }

      setPending(from, data);
      await sendVersionChoice(from, data.nameBangla || data.nameEnglish || "অজানা", data.nid || "N/A", 0);
    } catch (err) {
      console.error("PDF Process error:", err.message);
      await sendText(from, `❌ Error: ${err.message}\nআবার চেষ্টা করুন।`);
    }
  }
}

// ──────────────────── EXPRESS SERVER ────────────────────────────
const app = express();
app.use(express.json({ limit: "50mb", verify: (req, res, buf) => { req.rawBody = buf; } })); // rawBody → signature যাচাই
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

app.get("/webhook", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === CONFIG.WA_VERIFY_TOKEN) {
    console.log("✅ Webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  // ✅ জাল webhook ঠেকাতে Meta এর signature যাচাই (WHATSAPP_APP_SECRET সেট থাকলে)
  if (!verifyMetaSignature(req)) {
    console.warn("⛔ Webhook signature মেলেনি — প্রত্যাখ্যান করা হলো");
    return res.sendStatus(401);
  }
  res.sendStatus(200);
  try {
    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        const value = change.value || {};
        const field = change.field || "messages";

        // account_update, quality, template ইত্যাদি — log + গুরুতর হলে admin কে alert
        if (field !== "messages") { handleAccountEvent(field, value); continue; }

        for (const st of value.statuses || []) handleStatus(st); // sent/delivered/read/failed

        for (const msg of value.messages || []) {
          if (isDuplicateMessage(msg.id)) { console.log("⏭️ Duplicate webhook skipped:", msg.id); continue; }
          await handleIncoming(msg, (value.contacts || [])[0]);
        }
      }
    }
  } catch (e) { console.error("Webhook error:", e.message); }
});

app.get("/",        (_, res) => res.send("✅ NID Bot is running"));
app.get("/privacy", (_, res) => res.send(`<html><body style="font-family:sans-serif;max-width:700px;margin:40px auto;padding:20px;">
  <h1>Privacy Policy</h1>
  <p>NID Service Bot processes NID PDFs temporarily and does not store personal data.</p>
</body></html>`));

// ──────────────────── ADMIN PANEL ───────────────────────────────
const adminSessions = new Set();

function adminAuth(req, res, next) {
  const sess = (req.headers.cookie || "")
    .split(";").map(s => s.trim())
    .find(s => s.startsWith("admin_sess="))?.split("=")[1];
  if (sess && adminSessions.has(sess)) return next();
  res.redirect("/admin/login");
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (iso) => iso
  ? new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Dhaka", hour12: true, dateStyle: "short", timeStyle: "short" })
  : "—";
const backTo = (res, number) => res.redirect(number ? `/admin#u-${normalizeNumber(number)}` : "/admin");

const ADMIN_CSS = `<style>
:root{--bg:#0a0f1f;--panel:#111833;--panel2:#18214a;--line:#252f5c;--text:#eaeeff;--mut:#8b96c6;--acc:#7c5cff;--acc2:#22d3ee;--ok:#34d399;--bad:#fb7185;--warn:#fbbf24}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans Bengali',sans-serif;color:var(--text);min-height:100vh;-webkit-text-size-adjust:100%;
 background:radial-gradient(1100px 560px at 8% -10%,#1b2460 0%,transparent 60%),radial-gradient(900px 480px at 100% 0%,#2a1b60 0%,transparent 55%),var(--bg)}
a{color:var(--acc2);text-decoration:none}
.top{position:sticky;top:0;z-index:50;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;background:rgba(10,15,31,.82);backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);border-bottom:1px solid var(--line)}
.brand{font-weight:800;letter-spacing:.3px;display:flex;align-items:center;gap:8px;white-space:nowrap}
.brand i{width:28px;height:28px;border-radius:9px;background:linear-gradient(135deg,var(--acc),var(--acc2));display:inline-grid;place-items:center;font-style:normal;font-size:15px}
.top nav{display:flex;gap:4px;overflow-x:auto}
.top nav a{padding:7px 12px;border-radius:10px;color:var(--mut);font-size:13px;font-weight:600;white-space:nowrap}
.top nav a.on,.top nav a:hover{background:var(--panel2);color:var(--text)}
.wrap{max-width:1240px;margin:0 auto;padding:18px 14px 70px}
h2.sec{font-size:12px;letter-spacing:1.1px;text-transform:uppercase;color:var(--mut);margin:28px 2px 12px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}
h2.sec span{letter-spacing:0;text-transform:none;font-weight:600}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.stat{background:linear-gradient(160deg,var(--panel2),var(--panel));border:1px solid var(--line);border-radius:16px;padding:14px}
.stat .l{font-size:11px;color:var(--mut);text-transform:uppercase;letter-spacing:.6px}
.stat .v{font-size:24px;font-weight:800;margin-top:4px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:16px}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:12px}
input,select,textarea{width:100%;background:#0c1330;border:1px solid var(--line);color:var(--text);border-radius:10px;padding:10px 12px;font-size:14px;outline:none;font-family:inherit}
input:focus,select:focus,textarea:focus{border-color:var(--acc)}
label.f{display:block;font-size:11px;color:var(--mut);margin:0 0 4px 2px}
.fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.btn{display:inline-block;text-align:center;border:0;border-radius:10px;padding:10px 14px;font-size:14px;font-weight:700;cursor:pointer;color:#fff;background:var(--acc);font-family:inherit;white-space:nowrap}
.btn.ok{background:var(--ok);color:#052e1b}
.btn.bad{background:var(--bad);color:#3b0a14}
.btn.warn{background:var(--warn);color:#3a2a00}
.btn.ghost{background:var(--panel2);color:var(--text);border:1px solid var(--line)}
.btn.sm{padding:8px 11px;font-size:12px}
.sum{cursor:pointer;font-weight:700;list-style:none;font-size:14px}
.sum::-webkit-details-marker{display:none}
details.card[open]>.sum{margin-bottom:14px}
.pill{font-size:11px;font-weight:700;padding:3px 9px;border-radius:99px;white-space:nowrap}
.pill.on{background:#0b3b2b;color:var(--ok)}
.pill.off{background:#3b0f1a;color:var(--bad)}
.pill.pdf{background:#14284d;color:#7cb4ff}
.pill.sv{background:#3a2d08;color:var(--warn)}
.pill.sv2{background:#2d1a5c;color:#b9a2ff}
.pill.crit{background:#3b0f1a;color:var(--bad)}
.pill.warn{background:#3a2d08;color:var(--warn)}
.pill.info{background:#14284d;color:#7cb4ff}
/* users */
.users{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:12px}
.u{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:14px;display:flex;flex-direction:column;gap:12px;scroll-margin-top:70px}
.u.off{opacity:.62}
.uh{display:flex;gap:10px;align-items:center}
.av{width:42px;height:42px;border-radius:14px;background:linear-gradient(135deg,var(--acc),var(--acc2));display:grid;place-items:center;font-weight:800;flex:none}
.uh .n{font-weight:700;font-size:15px;word-break:break-word}
.uh .p{font-size:12px;color:var(--mut)}
.uh .pill{margin-left:auto}
.bal{display:flex;align-items:center;justify-content:space-between;background:#0c1330;border:1px solid var(--line);border-radius:14px;padding:10px 14px}
.bal b{font-size:26px}
.bal small{color:var(--mut);font-size:11px}
.money{display:grid;gap:8px}
.chips{display:flex;gap:6px;flex-wrap:wrap}
.chip{background:var(--panel2);border:1px solid var(--line);color:var(--text);border-radius:99px;padding:6px 12px;font-size:12px;cursor:pointer;font-family:inherit}
.go{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.sws{display:flex;gap:6px}
.sws form{flex:1}
.sw{width:100%;border:1px solid var(--line);background:#0c1330;color:var(--mut);padding:9px 8px;border-radius:10px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit}
.sw.on{background:#0b3b2b;border-color:#14684b;color:var(--ok)}
.sw.off{background:#3b0f1a;border-color:#6d1a2c;color:var(--bad)}
details.m summary{cursor:pointer;list-style:none;padding:9px 12px;border-radius:10px;background:var(--panel2);font-size:13px;font-weight:700;text-align:center}
details.m summary::-webkit-details-marker{display:none}
details.m[open] summary{margin-bottom:12px}
.stack{display:grid;gap:12px}
.row3{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:8px}
.seg{display:flex;gap:3px;background:#0c1330;border:1px solid var(--line);border-radius:12px;padding:3px}
.seg form{flex:1}
.seg button{width:100%;border:0;background:transparent;color:var(--mut);padding:8px 4px;border-radius:9px;font-weight:700;font-size:12px;cursor:pointer;font-family:inherit}
.seg button.on{background:linear-gradient(135deg,var(--acc),var(--acc2));color:#fff}
.seg button:disabled{opacity:.35;cursor:not-allowed}
.cap{font-size:11px;color:var(--mut);margin:-4px 2px 0}
/* lists & tables */
.li{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid var(--line)}
.li:last-child{border-bottom:0}
.li .a{font-weight:700}
.li .b{font-size:12px;color:var(--mut)}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch}
table{width:100%;border-collapse:collapse;font-size:13px;min-width:600px}
th{text-align:left;color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.5px;padding:8px;border-bottom:1px solid var(--line)}
td{padding:10px 8px;border-bottom:1px solid var(--line)}
.code{background:#0c1330;border:1px solid var(--line);border-radius:12px;padding:14px;overflow:auto;font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-all}
.muted{color:var(--mut);font-size:12px}
.login{min-height:100vh;display:grid;place-items:center;padding:16px}
.login .card{width:100%;max-width:360px}
.err{color:var(--bad);font-size:13px;margin-bottom:10px}
@media(max-width:600px){
 .wrap{padding:12px 10px 70px}
 .users{grid-template-columns:1fr}
 .stat .v{font-size:20px}
 .brand span{display:none}
}
</style>`;

function adminPage(title, body, active = "home") {
  return `<!DOCTYPE html><html lang="bn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${ADMIN_CSS}</head><body>
<header class="top">
  <div class="brand"><i>◈</i><span>NID Hub</span></div>
  <nav>
    <a class="${active === "home" ? "on" : ""}" href="/admin">📊 Dashboard</a>
    <a class="${active === "resp" ? "on" : ""}" href="/admin/responses">🗂 Responses</a>
    <a class="${active === "meta" ? "on" : ""}" href="/admin/meta">📡 Meta</a>
    <a href="/admin/logout">🚪 Logout</a>
  </nav>
</header>
<main class="wrap">${body}</main>
</body></html>`;
}

const loginPage = (err) => `<!DOCTYPE html><html lang="bn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin Login</title>${ADMIN_CSS}</head><body>
<div class="login"><div class="card">
  <div class="brand" style="font-size:20px;margin-bottom:18px"><i>◈</i><span style="display:inline">NID Hub</span></div>
  ${err ? `<p class="err">❌ ভুল পাসওয়ার্ড</p>` : ""}
  <form method="POST" action="/admin/login">
    <input name="password" type="password" placeholder="Admin password" required autofocus/>
    <button class="btn" style="width:100%;margin-top:10px">লগইন →</button>
  </form>
</div></div></body></html>`;

app.get("/admin/login", (_, res) => res.send(loginPage(false)));

app.post("/admin/login", (req, res) => {
  if (req.body.password === CONFIG.ADMIN_PASS) {
    const tok = crypto.randomBytes(16).toString("hex");
    adminSessions.add(tok);
    res.setHeader("Set-Cookie", `admin_sess=${tok}; HttpOnly; Path=/; Max-Age=86400`);
    return res.redirect("/admin");
  }
  res.send(loginPage(true));
});

app.get("/admin/logout", (req, res) => {
  const c = (req.headers.cookie || "").split(";").map(s => s.trim()).find(s => s.startsWith("admin_sess="));
  if (c) adminSessions.delete(c.split("=")[1]);
  res.setHeader("Set-Cookie", "admin_sess=; Max-Age=0; Path=/");
  res.redirect("/admin/login");
});

const statBox = (label, value, color) =>
  `<div class="stat"><div class="l">${label}</div><div class="v"${color ? ` style="color:${color}"` : ""}>${value}</div></div>`;

const modePill = (mode) => `<span class="pill ${esc(mode)}">${esc(modeLabel(mode))}</span>`;

// ── Dashboard ──
app.get("/admin", adminAuth, (req, res) => {
  const users    = getUsers();
  const stats    = getStats();
  const settings = getSettings();
  const today    = getTodayActivitySummary();
  const plan     = planBroadcast();
  const lastB    = getBroadcastLog().slice(-1)[0];

  const todayJobs  = today.reduce((s, r) => s + r.jobs, 0);
  const todayRev   = today.reduce((s, r) => s + r.spent, 0);
  const todayCost  = today.reduce((s, r) => s + r.cost, 0);
  const todayProfit = todayRev - todayCost;
  const totalBal   = users.reduce((s, u) => s + (u.balance || 0), 0);
  const activeCnt  = users.filter(u => u.active !== false).length;

  const mongoOK = !!CONFIG.MONGO_URI;
  const ghOK    = !!(CONFIG.GITHUB_TOKEN && CONFIG.GITHUB_REPO);
  const sv1OK   = !!CONFIG.SV_API1_KEY;
  const sv2OK   = !!(CONFIG.SV_API2_URL && CONFIG.SV_API2_KEY);

  const swForm = (num, api, on, label) => `
    <form method="POST" action="/admin/toggleapi">
      <input type="hidden" name="number" value="${esc(num)}"/><input type="hidden" name="api" value="${api}"/>
      <button class="sw ${on ? "on" : "off"}">${label}: ${on ? "ON" : "OFF"}</button>
    </form>`;

  const userCard = (u) => {
    const num   = u.number;
    const bal   = u.balance || 0;
    const s     = stats[normalizeNumber(num)] || { count: 0, lastUsed: null };
    const on    = u.active !== false;
    const sv1   = u.sv1Enabled !== false;
    const sv2   = u.sv2Enabled !== false;
    const pv    = (v) => (v !== undefined && v !== null && v !== "") ? v : "";
    const ini   = esc(((u.name || num) + "").trim().charAt(0).toUpperCase() || "#");
    const curMode = u.serviceMode || "default";
    const optTxt  = u.broadcastOptIn === true ? "✅ Opt-in" : u.broadcastOptIn === false ? "🚫 Opt-out" : "— Opt-in নেই";
    const svTag   = curMode === "sv" ? `<span class="pill sv">SV Mode</span>` : curMode === "vip" ? `<span class="pill sv2">VIP Mode</span>` : "";
    // ✅ admin নিজে user এর mode চালু করতে পারবে (user এর .sv / .vip পাঠানোর সমতুল্য)
    const segBtn = (m, label, enabled) => `
      <form method="POST" action="/admin/setmode">
        <input type="hidden" name="number" value="${esc(num)}"/><input type="hidden" name="mode" value="${m}"/>
        <button class="${curMode === m ? "on" : ""}" ${enabled ? "" : "disabled"}>${label}</button>
      </form>`;

    return `
    <div class="u ${on ? "" : "off"}" id="u-${esc(normalizeNumber(num))}" data-q="${esc(((u.name || "") + " " + num).toLowerCase())}">
      <div class="uh">
        <div class="av">${ini}</div>
        <div><div class="n">${esc(u.name || "নাম নেই")}</div><div class="p">${esc(num)}</div></div>
        <span class="pill ${on ? "on" : "off"}">${on ? "Active" : "Off"}</span>
      </div>

      <div class="bal">
        <div><small>BALANCE</small><br><b style="color:${bal < 0 ? "var(--bad)" : "var(--ok)"}">${bal} ৳</b></div>
        <div style="text-align:right"><small>মোট কার্ড: <b style="font-size:13px">${s.count}</b></small><br><small>${fmtTime(s.lastUsed)}</small><br>${svTag}</div>
      </div>

      <div class="cap">📢 ${optTxt} · শেষ মেসেজ: ${fmtTime(u.lastInboundAt)}</div>
      <form class="money" method="POST" action="/admin/recharge">
        <input type="hidden" name="number" value="${esc(num)}"/>
        <input name="amount" type="number" inputmode="decimal" min="1" step="any" placeholder="টাকার পরিমাণ লিখুন" required/>
        <div class="chips">${[50, 100, 200, 500, 1000].map(a => `<button type="button" class="chip" onclick="this.closest('form').amount.value=${a}">${a}</button>`).join("")}</div>
        <div class="go">
          <button class="btn ok" name="type" value="add">＋ টাকা যোগ</button>
          <button class="btn bad" name="type" value="remove" onclick="return confirm('${esc(num)} এর balance থেকে টাকা কাটবেন?')">－ টাকা কাটুন</button>
        </div>
      </form>

      <div class="seg">${segBtn("default", "📄 PDF", true)}${segBtn("sv", "🔧 SV", sv1 || sv2)}${segBtn("vip", "💎 VIP", sv2)}</div>
      <div class="cap">Service Mode — user এর .sv / .vip লেখার মতোই কাজ করে</div>
      <div class="sws">${swForm(num, "sv1", sv1, "SV1")}${swForm(num, "sv2", sv2, "SV2 VIP")}</div>

      <details class="m">
        <summary>⚙️ আরও সেটিং</summary>
        <div class="stack">
          <form method="POST" action="/admin/setprices">
            <input type="hidden" name="number" value="${esc(num)}"/>
            <div class="row3">
              <div><label class="f">PDF ৳</label><input name="price"    type="number" step="any" value="${pv(u.price)}"    placeholder="${settings.cardPrice || 0}"/></div>
              <div><label class="f">SV1 ৳</label><input name="svPrice"  type="number" step="any" value="${pv(u.svPrice)}"  placeholder="${settings.svPrice || 0}"/></div>
              <div><label class="f">SV2 ৳</label><input name="sv2Price" type="number" step="any" value="${pv(u.sv2Price)}" placeholder="${settings.sv2Price || 0}"/></div>
            </div>
            <p class="muted" style="margin-bottom:8px">ফাঁকা রাখলে ধূসর অক্ষরের default price প্রযোজ্য হবে।</p>
            <button class="btn sm" style="width:100%">💾 Price সেভ করুন</button>
          </form>

          <form method="POST" action="/admin/setversion" class="row" style="flex-wrap:nowrap">
            <input type="hidden" name="number" value="${esc(num)}"/>
            <select name="version">
              ${[[0, "Auto (প্রতিবার choice)"], [1, "V1"], [2, "V2"], [3, "V3"], [4, "V4"]].map(([v, l]) => `<option value="${v}" ${(u.defaultVersion || 0) === v ? "selected" : ""}>${l}</option>`).join("")}
            </select>
            <button class="btn ghost sm">Set Version</button>
          </form>

          <div class="row">
            <a class="btn ghost sm" style="flex:1" href="/admin/user/${esc(normalizeNumber(num))}">📋 History</a>
            <form method="POST" action="/admin/toggle" style="flex:1"><input type="hidden" name="number" value="${esc(num)}"/><button class="btn warn sm" style="width:100%">${on ? "⏸ Disable" : "▶️ Enable"}</button></form>
            <form method="POST" action="/admin/delete" style="flex:1" onsubmit="return confirm('${esc(num)} কে স্থায়ীভাবে Delete করবেন?')"><input type="hidden" name="number" value="${esc(num)}"/><button class="btn bad sm" style="width:100%">🗑 Delete</button></form>
          </div>
        </div>
      </details>
    </div>`;
  };

  const todayRows = today.map(r => `
    <div class="li">
      <div><div class="a">${esc(r.name || "—")} <span class="muted">${esc(r.number)}</span></div><div class="b">কাজ: ${r.jobs} টা · কাটা: ${r.spent} ৳${r.cost ? ` · খরচ: ${r.cost} ৳` : ""}</div></div>
      <a class="btn ghost sm" href="/admin/user/${esc(r.number)}">বিস্তারিত →</a>
    </div>`).join("") || `<p class="muted" style="padding:10px 0">আজকে এখনো কেউ কাজ করেনি।</p>`;

  const body = `
  <div class="stats">
    ${statBox("আজকের কাজ", todayJobs, "var(--acc2)")}
    ${statBox("আজকের আয়", todayRev + " ৳", "var(--ok)")}
    ${statBox("আজকের লাভ", todayProfit + " ৳", todayProfit >= 0 ? "var(--ok)" : "var(--bad)")}
    ${statBox("মোট User", `${users.length} <span class="muted">(${activeCnt} active)</span>`)}
    ${statBox("User দের Balance", totalBal + " ৳", "var(--warn)")}
  </div>

  <h2 class="sec">📅 আজকের কাজের হিসাব <span>${todayJobs} কাজ · ${todayRev} ৳ কাটা</span></h2>
  <div class="card">${todayRows}</div>

  <h2 class="sec">⚙️ Default Price ও আমাদের API খরচ</h2>
  <form class="card" method="POST" action="/admin/settings">
    <div class="fields">
      <div><label class="f">PDF Card Price ৳</label><input name="cardPrice" type="number" step="any" value="${settings.cardPrice || 0}"/></div>
      <div><label class="f">SV1 Price ৳</label><input name="svPrice" type="number" step="any" value="${settings.svPrice || 0}"/></div>
      <div><label class="f">SV2 (VIP) Price ৳</label><input name="sv2Price" type="number" step="any" value="${settings.sv2Price || 0}"/></div>
      <div><label class="f">SV1 এ আমাদের খরচ ৳</label><input name="svCost" type="number" step="any" value="${settings.svCost || 0}"/></div>
      <div><label class="f">SV2 এ আমাদের খরচ ৳</label><input name="sv2Cost" type="number" step="any" value="${settings.sv2Cost || 0}"/></div>
    </div>
    <button class="btn">💾 Save Settings</button>
    <p class="muted" style="margin-top:10px">Custom price না থাকা user রা default price দেবে। "আমাদের খরচ" শুধু লাভ হিসাবের জন্য, user কে দেখানো হয় না।</p>
  </form>

  <div class="grid2" style="margin-top:12px">
    <details class="card">
      <summary class="sum">📢 Broadcast</summary>
      <p class="muted" style="margin-bottom:10px">
        ✉️ সাধারণ text: <b>${plan.free.length}</b> · 🧾 Template: <b>${plan.template.length}</b> ·
        ⏭ বাদ: <b>${plan.skipOptOut.length + plan.skipNotOptIn.length + plan.skipNoTemplate.length}</b>
        <a href="/admin/meta">(বিস্তারিত)</a><br>
        ${lastB ? `শেষ broadcast: ${fmtTime(lastB.time)} — গেছে ${lastB.counts.free + lastB.counts.template}, ব্যর্থ ${lastB.counts.failed}${lastB.stoppedEarly ? " ⛔ থামানো হয়েছে" : ""}` : "এখনো কোনো broadcast হয়নি"}
      </p>
      <form method="POST" action="/admin/broadcast" onsubmit="return confirm('${plan.free.length + plan.template.length} জনকে পাঠানো হবে। নিশ্চিত?')">
        <textarea name="message" rows="4" required placeholder="যেমন: ✅ Bot On করা হয়েছে, এখন থেকে NID Card বানাতে পারবেন।" style="margin-bottom:10px"></textarea>
        <button class="btn" style="width:100%">📤 পাঠান (${plan.free.length + plan.template.length} জন)</button>
      </form>
      <p class="muted" style="margin-top:8px">opt-out (.stop) করা user কে কখনো পাঠানো হয় না। ২৪ ঘণ্টার window পার হলে শুধু opt-in (.subscribe) করা user কে approved template দিয়ে যায়।</p>
    </details>
    <div class="card">
      <div class="sum" style="margin-bottom:12px">🔌 সিস্টেম স্ট্যাটাস</div>
      <div class="row" style="margin-bottom:12px">
        <span class="pill ${sv1OK ? "on" : "off"}">SV1 key ${sv1OK ? "✓" : "✗"}</span>
        <span class="pill ${sv2OK ? "on" : "off"}">SV2 API ${sv2OK ? "✓" : "✗"}</span>
        <span class="pill ${mongoOK ? "on" : "off"}">MongoDB ${mongoOK ? "✓" : "✗"}</span>
        <span class="pill ${ghOK ? "on" : "off"}">GitHub ${ghOK ? "✓" : "✗"}</span>
      </div>
      <form method="POST" action="/admin/backup"><button class="btn ghost" style="width:100%">☁️ MongoDB Backup এখনই</button></form>
    </div>
  </div>

  <h2 class="sec">👥 Users <span>${users.length} জন</span></h2>
  <div class="row" style="margin-bottom:12px"><input id="q" placeholder="🔍 নাম বা নম্বর দিয়ে খুঁজুন..." style="flex:1 1 220px"/></div>

  <details class="card" style="margin-bottom:12px">
    <summary class="sum">➕ নতুন User যোগ করুন</summary>
    <form method="POST" action="/admin/add">
      <div class="fields">
        <div><label class="f">WhatsApp নম্বর *</label><input name="number" placeholder="880XXXXXXXXXX" required/></div>
        <div><label class="f">নাম</label><input name="name" placeholder="Name"/></div>
        <div><label class="f">শুরুর Balance ৳</label><input name="balance" type="number" step="any" value="0"/></div>
        <div><label class="f">Default Version</label>
          <select name="defaultVersion"><option value="0">Auto (choice দেখাবে)</option><option value="1">V1</option><option value="2">V2</option><option value="3">V3</option><option value="4">V4</option></select></div>
        <div><label class="f">PDF Price (ফাঁকা = default)</label><input name="price" type="number" step="any"/></div>
        <div><label class="f">SV1 Price (ফাঁকা = default)</label><input name="svPrice" type="number" step="any"/></div>
        <div><label class="f">SV2 Price (ফাঁকা = default)</label><input name="sv2Price" type="number" step="any"/></div>
      </div>
      <button class="btn" style="width:100%">➕ User যোগ করুন</button>
    </form>
  </details>

  <div class="users" id="users">${users.map(userCard).join("") || `<div class="card muted">কোনো user নেই।</div>`}</div>

  <script>
  document.getElementById('q').addEventListener('input',function(){
    var v=this.value.trim().toLowerCase();
    document.querySelectorAll('#users .u').forEach(function(c){c.style.display=c.dataset.q.indexOf(v)>-1?'':'none'});
  });
  </script>`;

  res.send(adminPage("NID Hub Admin", body, "home"));
});

// ── User detail / history ──
app.get("/admin/user/:number", adminAuth, (req, res) => {
  const number  = normalizeNumber(req.params.number);
  const u       = getUser(number);
  const summary = getUserTxSummary(number);
  const resps   = pruneResponses().filter(r => r.number === number).reverse();

  const rows = summary.list.slice(0, 200).map(t => `<tr>
    <td>${fmtTime(t.time)}</td>
    <td>${modePill(t.mode)}</td>
    <td>V${esc(t.version)}</td>
    <td>${esc(t.name || "—")}</td>
    <td>${esc(t.nid || "—")}</td>
    <td style="color:var(--bad);font-weight:700">${t.price} ৳</td>
    <td class="muted">${t.cost || 0} ৳</td>
  </tr>`).join("") || `<tr><td colspan="7" class="muted" style="text-align:center;padding:20px">এখনো কোনো কাজ করা হয়নি</td></tr>`;

  const respRows = resps.map(r => `<div class="li">
    <div><div class="a">${esc(r.nid)} ${modePill(r.provider)}</div><div class="b">${fmtTime(r.time)}</div></div>
    <a class="btn ghost sm" href="/admin/response/${esc(r.id)}">দেখুন</a>
  </div>`).join("") || `<p class="muted">গত ২৪ ঘণ্টায় কোনো VIP response নেই।</p>`;

  const profit = summary.totalSpent - summary.totalCost;
  const body = `
  <a href="/admin#u-${esc(number)}">← Dashboard</a>
  <h2 class="sec" style="margin-top:14px">📋 ${esc(u?.name || "User")} <span>${esc(number)}</span></h2>
  <div class="stats">
    ${statBox("Balance", getUserBalance(number) + " ৳", "var(--ok)")}
    ${statBox("মোট কাজ", summary.count)}
    ${statBox("মোট কাটা", summary.totalSpent + " ৳", "var(--bad)")}
    ${statBox("আজকের কাজ", summary.todayCount, "var(--acc2)")}
    ${statBox("আজ কাটা", summary.todaySpent + " ৳", "var(--warn)")}
    ${statBox("এর থেকে লাভ", profit + " ৳", profit >= 0 ? "var(--ok)" : "var(--bad)")}
  </div>

  <h2 class="sec">🗂 গত ২৪ ঘণ্টার VIP Response <span>${resps.length} টা</span></h2>
  <div class="card">${respRows}</div>

  <h2 class="sec">📜 Job History <span>সর্বশেষ ২০০টা</span></h2>
  <div class="card tw" style="padding:6px 10px">
    <table><thead><tr><th>সময়</th><th>API</th><th>Ver</th><th>নাম</th><th>NID</th><th>কাটা</th><th>খরচ</th></tr></thead><tbody>${rows}</tbody></table>
  </div>`;

  res.send(adminPage("User History", body, "home"));
});

// ── VIP responses (২৪ ঘণ্টা) ──
app.get("/admin/responses", adminAuth, (req, res) => {
  const list  = pruneResponses().slice().reverse();
  const users = getUsers();
  const nameOf = (n) => users.find(u => normalizeNumber(u.number) === n)?.name || "";
  const ghOK  = !!(CONFIG.GITHUB_TOKEN && CONFIG.GITHUB_REPO);

  const rows = list.map(r => `<tr>
    <td>${fmtTime(r.time)}</td>
    <td>${esc(nameOf(r.number) || "—")}<br><span class="muted">${esc(r.number)}</span></td>
    <td>${esc(r.nid)}</td>
    <td>${modePill(r.provider)}</td>
    <td><a class="btn ghost sm" href="/admin/response/${esc(r.id)}">দেখুন</a> <a class="btn ghost sm" href="/admin/response/${esc(r.id)}/raw">⬇️</a></td>
  </tr>`).join("") || `<tr><td colspan="5" class="muted" style="text-align:center;padding:20px">গত ২৪ ঘণ্টায় কোনো VIP response নেই</td></tr>`;

  const body = `
  <h2 class="sec" style="margin-top:4px">🗂 VIP API Response <span>হুবহু save · ২৪ ঘণ্টা পর auto মুছে যায়</span></h2>
  <p class="muted" style="margin-bottom:12px">GitHub backup: ${ghOK ? `<b style="color:var(--ok)">চালু</b> — repo <code>${esc(CONFIG.GITHUB_REPO)}</code> এর <code>responses/&lt;user-number&gt;/</code> folder এ স্থায়ীভাবে জমা হচ্ছে` : `<b style="color:var(--warn)">বন্ধ</b> (GITHUB_TOKEN ও GITHUB_REPO env সেট করলে চালু হবে)`}</p>
  <div class="card tw" style="padding:6px 10px">
    <table><thead><tr><th>সময়</th><th>User</th><th>NID</th><th>API</th><th></th></tr></thead><tbody>${rows}</tbody></table>
  </div>`;

  res.send(adminPage("VIP Responses", body, "resp"));
});

app.get("/admin/response/:id/raw", adminAuth, (req, res) => {
  const r = pruneResponses().find(x => x.id === req.params.id);
  if (!r) return res.status(404).send("Not found");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${String(r.nid).replace(/[^\w-]/g, "")}_${r.provider}.json"`);
  res.send(JSON.stringify(r.raw, null, 2));
});

app.get("/admin/response/:id", adminAuth, (req, res) => {
  const r = pruneResponses().find(x => x.id === req.params.id);
  if (!r) {
    return res.status(404).send(adminPage("Not found",
      `<div class="card">রেসপন্স পাওয়া যায়নি (২৪ ঘণ্টা পার হয়ে গিয়ে থাকতে পারে)। <a href="/admin/responses">← ফিরে যান</a></div>`, "resp"));
  }
  const body = `
  <a href="/admin/responses">← সব Response</a>
  <h2 class="sec" style="margin-top:14px">${modePill(r.provider)} NID ${esc(r.nid)} <span>${fmtTime(r.time)} · ${esc(r.number)}</span></h2>
  <div class="row" style="margin-bottom:12px">
    <button class="btn" onclick="navigator.clipboard.writeText(document.getElementById('j').innerText);this.textContent='✅ Copied'">📋 Copy</button>
    <a class="btn ghost" href="/admin/response/${esc(r.id)}/raw">⬇️ Download JSON</a>
  </div>
  <pre id="j" class="code">${esc(JSON.stringify(r.raw, null, 2))}</pre>`;
  res.send(adminPage("Response", body, "resp"));
});

// ── 📡 Meta / WhatsApp স্বাস্থ্য পেজ ──
const sevPill = (s) => `<span class="pill ${s === "critical" ? "crit" : s === "warn" ? "warn" : "info"}">${esc(s)}</span>`;

app.get("/admin/meta", adminAuth, (req, res) => {
  const events   = getEvents().slice().reverse();
  const counters = loadJSON(COUNTERS_FILE, {});
  const days     = Object.keys(counters).sort().reverse().slice(0, 7);
  const ph       = lastPhoneHealth;
  const bLog     = getBroadcastLog().slice(-10).reverse();
  const plan     = planBroadcast();

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const byCode = {};
  events.filter(e => e.kind === "status_failed" && new Date(e.time).getTime() > cutoff)
        .forEach(e => { byCode[e.code] = (byCode[e.code] || 0) + 1; });

  const qPill = (q) => q ? `<span class="pill ${q === "GREEN" ? "on" : q === "RED" ? "off" : "sv"}">${esc(q)}</span>` : "—";
  const d = ph?.data || {};
  const healthBody = !ph
    ? `<p class="muted">এখনো চেক করা হয়নি। নিচের বাটন চাপুন।</p>`
    : ph.ok
      ? `<div class="stats">
          ${statBox("Quality", qPill(d.quality_rating))}
          ${statBox("Messaging limit", esc(d.messaging_limit_tier || "—"))}
          ${statBox("Status", esc(d.status || "—"))}
          ${statBox("Name status", esc(d.name_status || "—"))}
        </div>
        <p class="muted" style="margin-top:8px">${esc(d.verified_name || "")} ${esc(d.display_phone_number || "")} · চেক: ${fmtTime(ph.time)}</p>`
      : `<p class="err">❌ Meta থেকে তথ্য আনা যায়নি: ${esc(ph.error)}</p><p class="muted">${fmtTime(ph.time)} · টোকেনে whatsapp_business_management permission আছে কিনা দেখুন।</p>`;

  const codeRows = Object.entries(byCode).sort((a, b) => b[1] - a[1]).map(([c, n]) =>
    `<div class="li"><div><div class="a">কোড ${esc(c)} <span class="muted">× ${n}</span></div><div class="b">${esc(WA_ERROR_HINTS[c] || "Meta এর error-code docs দেখুন")}</div></div></div>`).join("")
    || `<p class="muted">গত ২৪ ঘণ্টায় কোনো failed মেসেজ নেই।</p>`;

  const dayRows = days.map(k => {
    const c = counters[k];
    return `<tr><td>${esc(k)}</td><td>${c.sent}</td><td>${c.delivered}</td><td>${c.read}</td><td style="color:${c.failed ? "var(--bad)" : "inherit"};font-weight:700">${c.failed}</td></tr>`;
  }).join("") || `<tr><td colspan="5" class="muted" style="text-align:center;padding:14px">এখনো কোনো status webhook আসেনি</td></tr>`;

  const evRows = events.slice(0, 100).map(e => `<div class="li">
      <div><div class="a">${sevPill(e.severity)} ${esc(e.title)}</div><div class="b">${fmtTime(e.time)}${e.summary ? " · " + esc(e.summary) : ""}</div></div>
      <a class="btn ghost sm" href="/admin/meta/event/${esc(e.id)}">raw</a>
    </div>`).join("") || `<p class="muted">এখনো কোনো Meta event আসেনি। (Webhook এ নিচের field গুলো subscribe করা আছে কিনা দেখুন)</p>`;

  const bRows = bLog.map(b => `<div class="li">
      <div>
        <div class="a">${fmtTime(b.time)} <span class="muted">${esc(b.message.slice(0, 50))}</span></div>
        <div class="b">সাধারণ: ${b.counts.free} · Template: ${b.counts.template} · ব্যর্থ: ${b.counts.failed} · বাদ (opt-out ${b.counts.skippedOptOut}, opt-in নেই ${b.counts.skippedNotOptIn}, template নেই ${b.counts.skippedNoTemplate})</div>
        ${b.stoppedEarly ? `<div class="b" style="color:var(--bad)">⛔ থামানো হয়েছে: ${esc(b.stoppedEarly)}</div>` : ""}
        ${b.failures.slice(0, 5).map(f => `<div class="b">↳ ${esc(f.number)} — ${esc(f.code)} ${esc(WA_ERROR_HINTS[f.code] || f.message)}</div>`).join("")}
      </div></div>`).join("") || `<p class="muted">এখনো কোনো broadcast পাঠানো হয়নি।</p>`;

  const flag = (ok, label) => `<span class="pill ${ok ? "on" : "off"}">${label} ${ok ? "✓" : "✗"}</span>`;

  const body = `
  <h2 class="sec" style="margin-top:4px">📡 Account স্বাস্থ্য <span>Meta যা জানায়, হুবহু</span></h2>
  <div class="card">
    ${healthBody}
    <form method="POST" action="/admin/meta/check" style="margin-top:12px"><button class="btn">🔄 এখনই চেক করুন</button></form>
  </div>

  <div class="grid2" style="margin-top:12px">
    <div class="card">
      <div class="sum" style="margin-bottom:10px">⚙️ সেটআপ অবস্থা</div>
      <div class="row" style="margin-bottom:10px">
        ${flag(!!CONFIG.WA_APP_SECRET, "App Secret (signature)")}
        ${flag(!!CONFIG.ADMIN_WA_NUMBER, "Admin alert নম্বর")}
        ${flag(!!CONFIG.BROADCAST_TEMPLATE_NAME, "Broadcast template")}
      </div>
      <p class="muted">Meta App → WhatsApp → Configuration → Webhook এ এই field গুলো subscribe করুন:<br>
      <code>messages, account_update, phone_number_quality_update, account_review_update, message_template_status_update, message_template_quality_update</code></p>
    </div>
    <div class="card">
      <div class="sum" style="margin-bottom:10px">📢 পরের Broadcast এর শ্রোতা</div>
      <div class="li"><span>✉️ সাধারণ text (২৪ ঘণ্টায় মেসেজ করেছে)</span><b>${plan.free.length}</b></div>
      <div class="li"><span>🧾 Template (opt-in, window পার)</span><b>${plan.template.length}</b></div>
      <div class="li"><span class="muted">⏭ বাদ — opt-out</span><b>${plan.skipOptOut.length}</b></div>
      <div class="li"><span class="muted">⏭ বাদ — opt-in নেই, window পার</span><b>${plan.skipNotOptIn.length}</b></div>
      <div class="li"><span class="muted">⏭ বাদ — template সেট নেই</span><b>${plan.skipNoTemplate.length}</b></div>
    </div>
  </div>

  <h2 class="sec">📈 মেসেজ ডেলিভারি <span>শেষ ৭ দিন</span></h2>
  <div class="card tw" style="padding:6px 10px">
    <table style="min-width:420px"><thead><tr><th>দিন</th><th>Sent</th><th>Delivered</th><th>Read</th><th>Failed</th></tr></thead><tbody>${dayRows}</tbody></table>
  </div>

  <h2 class="sec">⚠️ Failed এর কারণ <span>গত ২৪ ঘণ্টা · ব্যাখ্যা সাধারণ অর্থ, নিশ্চিত হতে Meta docs দেখুন</span></h2>
  <div class="card">${codeRows}</div>

  <h2 class="sec">🔔 Meta Events <span>সর্বশেষ ১০০টা</span></h2>
  <div class="card">${evRows}</div>

  <h2 class="sec">📢 Broadcast ইতিহাস <span>সর্বশেষ ১০টা</span></h2>
  <div class="card">${bRows}</div>`;

  res.send(adminPage("Meta Health", body, "meta"));
});

app.post("/admin/meta/check", adminAuth, async (req, res) => {
  await fetchPhoneHealth();
  res.redirect("/admin/meta");
});

app.get("/admin/meta/event/:id", adminAuth, (req, res) => {
  const e = getEvents().find(x => x.id === req.params.id);
  if (!e) return res.status(404).send(adminPage("Not found", `<div class="card">Event পাওয়া যায়নি। <a href="/admin/meta">← ফিরে যান</a></div>`, "meta"));
  res.send(adminPage("Meta Event", `
    <a href="/admin/meta">← Meta Health</a>
    <h2 class="sec" style="margin-top:14px">${sevPill(e.severity)} ${esc(e.title)} <span>${fmtTime(e.time)}</span></h2>
    ${e.summary ? `<p class="muted" style="margin-bottom:10px">${esc(e.summary)}</p>` : ""}
    <pre class="code">${esc(JSON.stringify(e.raw, null, 2))}</pre>`, "meta"));
});

// ── Actions ──
app.post("/admin/add", adminAuth, (req, res) => {
  const users = getUsers();
  const { number, name, balance, defaultVersion, price, svPrice, sv2Price } = req.body;
  const n = normalizeNumber(number);
  if (n && !users.find(u => normalizeNumber(u.number) === n)) {
    const newUser = {
      number: n, name: name || "",
      balance: parseFloat(balance) || 0,
      active: true,
      defaultVersion: parseInt(defaultVersion) || 0,
    };
    if (price    !== undefined && price    !== "") newUser.price    = parseFloat(price);
    if (svPrice  !== undefined && svPrice  !== "") newUser.svPrice  = parseFloat(svPrice);
    if (sv2Price !== undefined && sv2Price !== "") newUser.sv2Price = parseFloat(sv2Price);
    users.push(newUser);
    saveUsers(users); backupData();
  }
  backTo(res, n);
});

app.post("/admin/recharge", adminAuth, (req, res) => {
  const users = getUsers();
  const { number, amount, type } = req.body;
  const i   = users.findIndex(u => normalizeNumber(u.number) === normalizeNumber(number));
  const amt = parseFloat(amount) || 0;
  if (i !== -1 && amt > 0) {
    users[i].balance = (users[i].balance || 0) + (type === "remove" ? -amt : amt);
    saveUsers(users); backupData();
  }
  backTo(res, number);
});

// ✅ per-user SV1 / SV2 API on-off
app.post("/admin/toggleapi", adminAuth, (req, res) => {
  const api = req.body.api;
  if (api === "sv1" || api === "sv2") {
    const users = getUsers();
    const i = users.findIndex(u => normalizeNumber(u.number) === normalizeNumber(req.body.number));
    if (i !== -1) {
      users[i][api + "Enabled"] = users[i][api + "Enabled"] === false; // false → true, বাকি সব → false
      const s1 = users[i].sv1Enabled !== false, s2 = users[i].sv2Enabled !== false;
      // যে API এর ওপর mode নির্ভর করে সেটা বন্ধ হলে mode আবার PDF এ ফেরত
      if ((users[i].serviceMode === "vip" && !s2) || (users[i].serviceMode === "sv" && !s1 && !s2)) users[i].serviceMode = "default";
      saveUsers(users); backupData();
    }
  }
  backTo(res, req.body.number);
});

// ✅ admin থেকে user এর Service Mode চালু/বন্ধ: default (PDF) | sv | vip
app.post("/admin/setmode", adminAuth, (req, res) => {
  const mode = req.body.mode;
  const u    = getUser(req.body.number);
  if (u && ["default", "sv", "vip"].includes(mode)) {
    const s1 = u.sv1Enabled !== false, s2 = u.sv2Enabled !== false;
    const allowed = mode === "default" || (mode === "sv" && (s1 || s2)) || (mode === "vip" && s2);
    if (allowed) {
      setUserServiceMode(req.body.number, mode);
      if (mode !== "default") setUserDefaultVersion(req.body.number, 4); // user নিজে .sv/.vip দিলে যা হয়
      backupData();
    }
  }
  backTo(res, req.body.number);
});

// ✅ PDF / SV1 / SV2 তিনটা price একসাথে (ফাঁকা = default এ ফেরত)
app.post("/admin/setprices", adminAuth, (req, res) => {
  const users = getUsers();
  const i = users.findIndex(u => normalizeNumber(u.number) === normalizeNumber(req.body.number));
  if (i !== -1) {
    for (const k of ["price", "svPrice", "sv2Price"]) {
      const v = req.body[k];
      if (v === "" || v === undefined) delete users[i][k];
      else users[i][k] = parseFloat(v);
    }
    saveUsers(users); backupData();
  }
  backTo(res, req.body.number);
});

app.post("/admin/setversion", adminAuth, (req, res) => {
  const users = getUsers();
  const i = users.findIndex(u => normalizeNumber(u.number) === normalizeNumber(req.body.number));
  if (i !== -1) {
    users[i].defaultVersion = parseInt(req.body.version) || 0;
    saveUsers(users); backupData();
  }
  backTo(res, req.body.number);
});

app.post("/admin/toggle", adminAuth, (req, res) => {
  const users = getUsers();
  const i = users.findIndex(u => normalizeNumber(u.number) === normalizeNumber(req.body.number));
  if (i !== -1) { users[i].active = users[i].active === false; saveUsers(users); backupData(); }
  backTo(res, req.body.number);
});

app.post("/admin/delete", adminAuth, (req, res) => {
  saveUsers(getUsers().filter(u => normalizeNumber(u.number) !== normalizeNumber(req.body.number)));
  backupData();
  res.redirect("/admin");
});

app.post("/admin/settings", adminAuth, (req, res) => {
  const f = (k) => parseFloat(req.body[k]) || 0;
  saveSettings({
    ...getSettings(),
    cardPrice: f("cardPrice"), svPrice: f("svPrice"), sv2Price: f("sv2Price"),
    svCost: f("svCost"), sv2Cost: f("sv2Cost"),
  });
  backupData();
  res.redirect("/admin");
});

app.post("/admin/backup", adminAuth, async (req, res) => {
  await backupData();
  res.redirect("/admin");
});

app.post("/admin/broadcast", adminAuth, async (req, res) => {
  const message = (req.body.message || "").trim();
  res.redirect(message ? "/admin/meta" : "/admin");
  if (!message) return;
  // opt-out / ২৪ ঘণ্টার window / template নিয়ম runBroadcast এর ভেতরে প্রয়োগ হয়
  runBroadcast(message).catch(err => console.error("Broadcast error:", err.message));
});

function cleanupOldFiles() {
  try {
    const tenMin = 10 * 60 * 1000;
    fs.readdirSync(CONFIG.STORAGE_DIR).forEach(f => {
      const fp = path.join(CONFIG.STORAGE_DIR, f);
      if (Date.now() - fs.statSync(fp).mtimeMs > tenMin) fs.unlinkSync(fp);
    });
  } catch {}
}

setInterval(() => {
  const limit = 15 * 60 * 1000;
  for (const [num, p] of pendingChoices.entries()) {
    if (Date.now() - p.timestamp > limit) {
      pendingChoices.delete(num);
      console.log(`⏰ Pending expired: ${num}`);
    }
  }
  for (const [num, p] of pendingSV2.entries()) {
    if (Date.now() - p.timestamp > PENDING_SV2_TTL) pendingSV2.delete(num);
  }
}, 5 * 60 * 1000);

// ✅ VIP response ২৪ ঘণ্টা পর মুছে ফেলা (প্রতি ঘণ্টায়)
setInterval(() => { try { pruneResponses(); } catch (e) { console.error("prune error:", e.message); } }, 60 * 60 * 1000);

(async () => {
  try {
    await restoreData();
  } catch(e) { console.error("Restore failed:", e.message); }
  cleanupOldFiles();
  try { pruneResponses(); } catch {}

  if (!CONFIG.SV_API1_KEY) console.warn("⚠️ SV_API1_KEY env সেট করা নেই — SV1 কাজ করবে না");
  if (!CONFIG.SV_API2_URL || !CONFIG.SV_API2_KEY) console.warn("ℹ️ SV_API2_URL / SV_API2_KEY সেট নেই — SV2 (VIP) বন্ধ থাকবে");
  if (CONFIG.ADMIN_PASS === "admin123") console.warn("⚠️ ADMIN_PASS এখনো ডিফল্ট (admin123) — env এ বদলে দিন");
  if (!CONFIG.WA_APP_SECRET) console.warn("⚠️ WHATSAPP_APP_SECRET সেট নেই — webhook signature যাচাই বন্ধ (যে কেউ জাল মেসেজ পাঠাতে পারে)");
  if (!CONFIG.ADMIN_WA_NUMBER) console.warn("ℹ️ ADMIN_WA_NUMBER সেট নেই — গুরুতর Meta alert WhatsApp এ আসবে না (শুধু /admin/meta এ দেখা যাবে)");
  if (!CONFIG.BROADCAST_TEMPLATE_NAME) console.warn("ℹ️ BROADCAST_TEMPLATE_NAME সেট নেই — ২৪ ঘণ্টার window পার হলে broadcast যাবে না");

  app.listen(CONFIG.PORT, "0.0.0.0", () => {
    console.log(`🚀 NID Bot running on port ${CONFIG.PORT}`);
  });
})();
