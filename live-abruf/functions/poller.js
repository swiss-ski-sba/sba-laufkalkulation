/**
 * SBA Laufkalkulation – Live-Abruf (Netlify Scheduled Function)
 * =============================================================
 * Läuft jede Minute (Zeitplan in netlify.toml). Ablauf pro Aufruf:
 *
 *   1. Renntag-Check: Ist heute ein Weltcup-Termin (Kalender unten)?
 *      Nein -> sofort Schluss. (Mit FORCE=1 lässt sich der Check übergehen.)
 *   2. Live-Quelle finden: LIVE_URL aus den Umgebungsvariablen, sonst
 *      Best-Effort-Suche über die FIS-Live-Übersichtsseite.
 *   3. Daten abrufen und parsen (siehe parseLive – wird am ersten Renntag
 *      gegen die echte Seite verifiziert; bis dahin loggt der Dienst im
 *      DRY_RUN, was er sieht).
 *   4. Zeiten in die Firebase Realtime Database der App schreiben – als
 *      "automatisches Command Center". Der Dienst meldet sich dazu mit dem
 *      normalen Command-Center-Konto an (Firebase Auth, E-Mail/Passwort).
 *
 * WICHTIG – Sicherheitsnetz:
 *   - Der Dienst fasst NUR Events an, die er selbst angelegt hat
 *     (gekennzeichnet mit auto:true). Manuell angelegte Events werden nie
 *     verändert – das Command Center kann also immer manuell übernehmen.
 *   - DRY_RUN=1: alles wie gewohnt, aber ohne Schreiben (nur Logs).
 *
 * Umgebungsvariablen (Netlify -> Site settings -> Environment variables):
 *   CC_PASSWORD   Passwort des Command-Center-Kontos  (PFLICHT, geheim!)
 *   CC_EMAIL      Standard: command-center@sba.app
 *   FB_API_KEY    Standard: API-Key aus der App (index.html)
 *   FB_DB_URL     Standard: Datenbank-URL aus der App (index.html)
 *   LIVE_URL      Direkte URL der FIS-Live-Daten, sobald bekannt (optional)
 *   DRY_RUN       "1" = nichts schreiben, nur loggen (für die Verifikation)
 *   FORCE         "1" = auch ausserhalb von Renntagen laufen (zum Testen)
 */

// ---------------------------------------------------------------------------
// Firebase-Zugang (Standardwerte = Konfiguration der App; Passwort ist Pflicht)
// ---------------------------------------------------------------------------
const FB = {
  apiKey: process.env.FB_API_KEY || "AIzaSyBXZYpxJZgblLr_aBGTo7czWe_IE-giSr4",
  dbUrl: (process.env.FB_DB_URL || "https://sba-laufkalkulation-default-rtdb.europe-west1.firebasedatabase.app").replace(/\/$/, ""),
  email: process.env.CC_EMAIL || "command-center@sba.app",
  password: process.env.CC_PASSWORD || "",
};

// FIS-Weltcup-Kalender Snowboard Alpin 2026/27 (Parallel-Disziplinen)
const KALENDER = [
  { ort: "Snow Ruyi (TBC)",   disziplin: "PGS", start: "2026-11-28", end: "2026-11-29" },
  { ort: "Mylin",             disziplin: "PGS", start: "2026-12-05", end: "2026-12-06" },
  { ort: "Cortina d'Ampezzo", disziplin: "PGS", start: "2026-12-12", end: "2026-12-12" },
  { ort: "Carezza",           disziplin: "PGS", start: "2026-12-17", end: "2026-12-17" },
  { ort: "Davos",             disziplin: "PSL", start: "2026-12-19", end: "2026-12-19" },
  { ort: "Scuol",             disziplin: "PGS", start: "2027-01-09", end: "2027-01-09" },
  { ort: "Bansko",            disziplin: "PGS", start: "2027-01-16", end: "2027-01-17" },
  { ort: "Rogla",             disziplin: "PGS", start: "2027-01-23", end: "2027-01-23" },
  { ort: "Bad Gastein",       disziplin: "PSL", start: "2027-01-26", end: "2027-01-27" },
  { ort: "Ratschings",        disziplin: "PSL", start: "2027-01-30", end: "2027-01-30" },
  { ort: "Krynica",           disziplin: "PGS", start: "2027-02-27", end: "2027-02-28" },
  { ort: "Winterberg",        disziplin: "PSL", start: "2027-03-20", end: "2027-03-21" },
];

const LIVE_INDEX = "https://www.fis-ski.com/DB/snowboard/live.html";
const UA = { "User-Agent": "Mozilla/5.0 (sba-laufkalkulation live-abruf; read-only)" };

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------
function heute() {
  // Renntage sind in Europa – Datum in Europe/Zurich bestimmen
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Zurich" }); // YYYY-MM-DD
}
function aktuellesEvent() {
  const h = heute();
  return KALENDER.find(e => h >= e.start && h <= e.end) || null;
}
const norm = {
  kurs(v) { v = String(v || "").toLowerCase(); if (/(blau|blue|^b$)/.test(v)) return "blau"; if (/(rot|red|^r$)/.test(v)) return "rot"; return null; },
  gender(v) { v = String(v || "").toLowerCase(); if (/(women|frauen|damen|ladies|^w$|^f$)/.test(v)) return "frauen"; if (/(men|männer|maenner|herren|^m$)/.test(v)) return "maenner"; return null; },
  run(v) { v = String(v || "").toLowerCase().replace(/\s/g, ""); if (/(q1|run1|lauf1|^1$)/.test(v)) return "q1"; if (/(q2|run2|lauf2|^2$)/.test(v)) return "q2"; return null; },
  zeit(v) {
    const s = String(v).trim().replace(",", ".");
    const m = s.match(/^(\d+):(\d{1,2}(?:\.\d+)?)$/);
    const sec = m ? parseInt(m[1], 10) * 60 + parseFloat(m[2]) : parseFloat(s);
    return isFinite(sec) && sec > 5 && sec < 600 ? Math.round(sec * 100) / 100 : null;
  },
};

// ---------------------------------------------------------------------------
// Schritt 2: Live-Quelle finden
// ---------------------------------------------------------------------------
async function findeLiveUrl() {
  if (process.env.LIVE_URL) return process.env.LIVE_URL;
  const res = await fetch(LIVE_INDEX, { headers: UA });
  if (!res.ok) throw new Error("Live-Übersicht: HTTP " + res.status);
  const html = await res.text();
  const links = [...new Set(html.match(/https?:\/\/live\.fis-ski\.com\/[^\s"'<>]+/g) || [])];
  console.log("Gefundene Live-Links:", links);
  return links[0] || null;
}

// ---------------------------------------------------------------------------
// Schritt 3: Parsen
// ---------------------------------------------------------------------------
// TODO (Verifikation am ersten Renntag): Die genaue Struktur der FIS-Live-
// Seite/-Daten ist erst am Live-Event sichtbar. Dieser Parser versucht der
// Reihe nach: (a) JSON direkt, (b) im HTML eingebettetes JSON, (c) nichts –
// dann loggt er einen Ausschnitt der Antwort, damit wir den Parser anhand
// der Logs fertigstellen können (DRY_RUN=1 lassen, Logs anschauen).
//
// Erwartetes Resultat: Liste von Einträgen
//   { name, zeit (Sek.), gender: 'frauen'|'maenner', run: 'q1'|'q2', kurs: 'blau'|'rot' }
function parseLive(text, contentType) {
  // (a) JSON direkt
  let data = null;
  if (/json/.test(contentType || "") || /^[\[{]/.test(text.trim())) {
    try { data = JSON.parse(text); } catch (e) { /* weiter */ }
  }
  // (b) im HTML eingebettetes JSON (häufig: window.__XXX__ = {...};)
  if (!data) {
    const m = text.match(/=\s*(\{[\s\S]{200,}?\});?\s*<\/script>/);
    if (m) { try { data = JSON.parse(m[1]); } catch (e) { /* weiter */ } }
  }
  if (!data) return null;

  // Generischer Versuch: alle Objekte mit Name + Zeit einsammeln.
  // Feldnamen decken die üblichen Varianten ab; wird am Live-Event geschärft.
  const out = [];
  (function walk(node, ctx) {
    if (Array.isArray(node)) { for (const x of node) walk(x, ctx); return; }
    if (!node || typeof node !== "object") return;
    const c = { ...ctx };
    for (const [k, v] of Object.entries(node)) {
      if (/^(gender|sex|category)$/i.test(k)) c.gender = norm.gender(v) || c.gender;
      if (/^(run|heat|lauf)$/i.test(k)) c.run = norm.run(v) || c.run;
      if (/^(course|kurs|lane)$/i.test(k)) c.kurs = norm.kurs(v) || c.kurs;
    }
    const name = node.name || node.athlete || node.lastname || node.familyname;
    const zeitRoh = node.time || node.runtime || node.result || node.zeit;
    if (name && zeitRoh != null) {
      const zeit = norm.zeit(zeitRoh);
      if (zeit && c.gender && c.run && c.kurs)
        out.push({ name: String(name).trim().toUpperCase(), zeit, gender: c.gender, run: c.run, kurs: c.kurs });
    }
    for (const v of Object.values(node)) walk(v, c);
  })(data, {});
  return out.length ? out : null;
}

// ---------------------------------------------------------------------------
// Schritt 4: Firebase (Anmeldung als Command Center, dann State-Update)
// ---------------------------------------------------------------------------
async function fbLogin() {
  const res = await fetch(
    "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + FB.apiKey,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: FB.email, password: FB.password, returnSecureToken: true }) });
  if (!res.ok) throw new Error("Firebase-Login fehlgeschlagen (CC_PASSWORD prüfen): HTTP " + res.status);
  return (await res.json()).idToken;
}
async function fbGetState(token) {
  const res = await fetch(FB.dbUrl + "/state.json?auth=" + token, { headers: UA });
  if (!res.ok) throw new Error("Firebase lesen: HTTP " + res.status);
  return (await res.json()) || { v: 1, events: [], updatedAt: null };
}
async function fbPutState(token, state) {
  const res = await fetch(FB.dbUrl + "/state.json?auth=" + token,
    { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state) });
  if (!res.ok) throw new Error("Firebase schreiben: HTTP " + res.status);
}

/** Einträge in den App-State einarbeiten. Fasst nur das eigene Auto-Event an. */
function upsert(state, evMeta, entries) {
  const events = Array.isArray(state.events) ? state.events.filter(Boolean) : Object.values(state.events || {});
  const id = "auto-" + evMeta.start;
  let ev = events.find(e => e && e.id === id);
  if (!ev) {
    ev = { id, ort: evMeta.ort, disziplin: evMeta.disziplin, datum: heute(), auto: true,
           runs: [{ id: "q1", label: "Q1", frauen: { blau: [], rot: [] }, maenner: { blau: [], rot: [] } },
                  { id: "q2", label: "Q2", frauen: { blau: [], rot: [] }, maenner: { blau: [], rot: [] } }] };
    events.push(ev);
  }
  if (!ev.auto) return null; // Sicherheitsnetz: nie ein manuelles Event überschreiben

  for (const runId of ["q1", "q2"]) {
    const run = ev.runs.find(r => r.id === runId);
    for (const g of ["frauen", "maenner"]) {
      for (const k of ["blau", "rot"]) {
        const zeiten = entries
          .filter(e => e.run === runId && e.gender === g && e.kurs === k)
          .sort((a, b) => a.zeit - b.zeit)
          .slice(0, 8) // wie im Excel: max. Top 8
          .map(e => ({ name: e.name, zeit: e.zeit }));
        if (zeiten.length) run[g][k] = zeiten; // nie mit leer überschreiben
      }
    }
  }
  return { v: 1, events, updatedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
exports.handler = async () => {
  const ok = (msg) => { console.log(msg); return { statusCode: 200, body: msg }; };
  try {
    const evMeta = aktuellesEvent();
    if (!evMeta && process.env.FORCE !== "1") return ok("Kein Renntag – nichts zu tun.");
    const meta = evMeta || { ort: "TEST", disziplin: "PGS", start: heute(), end: heute() };
    console.log("Renntag:", meta.ort, meta.disziplin);

    const liveUrl = await findeLiveUrl();
    if (!liveUrl) return ok("Keine Live-Quelle gefunden (noch kein Rennen live?).");
    console.log("Live-Quelle:", liveUrl);

    const res = await fetch(liveUrl, { headers: UA });
    if (!res.ok) return ok("Live-Quelle HTTP " + res.status);
    const text = await res.text();
    const entries = parseLive(text, res.headers.get("content-type"));
    if (!entries) {
      console.log("Parser hat die Struktur (noch) nicht erkannt. Antwort-Ausschnitt für die Diagnose:");
      console.log(text.slice(0, 2000));
      return ok("Noch nicht parsebar – Ausschnitt geloggt (DRY_RUN-Phase).");
    }
    console.log(`Geparst: ${entries.length} Zeiten.`, entries.slice(0, 6));

    if (process.env.DRY_RUN === "1") return ok("DRY_RUN – nichts geschrieben.");
    if (!FB.password) return ok("CC_PASSWORD fehlt – nichts geschrieben.");

    const token = await fbLogin();
    const state = await fbGetState(token);
    const neu = upsert(state, meta, entries);
    if (!neu) return ok("Event ist manuell verwaltet – nicht angefasst.");
    await fbPutState(token, neu);
    return ok(`Firebase aktualisiert (${entries.length} Zeiten, Event ${meta.ort}).`);
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: String(err.message || err) };
  }
};

// Lokaler Selbsttest der Zuordnungslogik: node functions/poller.js --selftest
if (process.argv.includes("--selftest")) {
  const entries = [
    { name: "ZOGG", zeit: 36.75, gender: "frauen", run: "q1", kurs: "blau" },
    { name: "MIKI", zeit: 36.78, gender: "frauen", run: "q1", kurs: "rot" },
    { name: "CAVIEZEL", zeit: 34.20, gender: "maenner", run: "q2", kurs: "rot" },
  ];
  const state = upsert({ v: 1, events: [{ id: "manuell-1", ort: "Scuol", runs: [] }] },
    { ort: "Cortina d'Ampezzo", disziplin: "PGS", start: "2026-12-12" }, entries);
  console.log(JSON.stringify(state, null, 2));
  console.log("Manuelles Event unangetastet:", state.events[0].id === "manuell-1" && !state.events[0].auto ? "JA" : "NEIN");
}
