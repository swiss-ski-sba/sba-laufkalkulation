/**
 * SBA Laufkalkulation – PDF-Abruf (Netlify Scheduled Function, alle 5 Min.)
 * =========================================================================
 * Zweite, robuste Datenquelle neben dem Live-Abruf (poller.js): Die FIS
 * publiziert an jedem Rennen offizielle PDFs pro Quali-Lauf – Startlisten
 * (mit Kurszuteilung blau/rot pro Startnummer) und Resultatlisten (Zeiten).
 * Diese erscheinen jeweils kurz nach Laufende. Dieser Dienst:
 *
 *   1. Renntag-Check (gleicher Kalender wie poller.js; FORCE=1 übergeht ihn).
 *   2. Findet die Quali-Rennen des Tages über die FIS-Event-Seite
 *      (Event-IDs im Kalender) und sammelt deren Codex-Nummern.
 *   3. Probiert die bekannten FIS-PDF-Adressmuster durch
 *      (data.fis-ski.com/pdf/<Saison>/SB/<Codex>/...), loggt alle Treffer.
 *   4. Extrahiert Text (pdf-parse), liest Kurszuteilung aus den Startlisten
 *      und Zeiten aus den Resultatlisten, und schreibt sie in die Firebase –
 *      gleiches Sicherheitsnetz wie der Live-Abruf (nur auto-Events).
 *
 * TESTBAR HEUTE, mit echten Daten der letzten Saison:
 *   TEST_RACE = "2026:6169"  (Saison:Codex, z.B. Cortina Quali 13.12.2025)
 *   zusammen mit FORCE=1 und DRY_RUN=1 setzen -> der Dienst holt die echten
 *   PDFs von damals, loggt gefundene Dokumente, erkannte Kurse und Zeiten.
 *   Anhand dieser Logs wird der Parser einmalig verifiziert/geschärft.
 *
 * Umgebungsvariablen: wie poller.js (CC_PASSWORD etc.), zusätzlich TEST_RACE.
 */

const pdfParse = require("pdf-parse");

// --- Konfiguration (identisch zu poller.js gehalten) -----------------------
const FB = {
  apiKey: process.env.FB_API_KEY || "AIzaSyBXZYpxJZgblLr_aBGTo7czWe_IE-giSr4",
  dbUrl: (process.env.FB_DB_URL || "https://sba-laufkalkulation-default-rtdb.europe-west1.firebasedatabase.app").replace(/\/$/, ""),
  email: process.env.CC_EMAIL || "command-center@sba.app",
  password: process.env.CC_PASSWORD || "",
};
const SEASON = "2027"; // FIS-Saisoncode 2026/27

// Kalender inkl. FIS-Event-IDs (für die Rennsuche am Renntag).
// Event-IDs der später dazugekommenen Rennen (China, Ratschings) bei Bedarf
// aus dem FIS-Kalender nachtragen (event-details.html?eventid=...).
const KALENDER = [
  { ort: "Snow Ruyi (TBC)",   disziplin: "PGS", start: "2026-11-28", end: "2026-11-29", eventid: null },
  { ort: "Mylin",             disziplin: "PGS", start: "2026-12-05", end: "2026-12-06", eventid: null },
  { ort: "Cortina d'Ampezzo", disziplin: "PGS", start: "2026-12-12", end: "2026-12-12", eventid: "62758" },
  { ort: "Carezza",           disziplin: "PGS", start: "2026-12-17", end: "2026-12-17", eventid: "62759" },
  { ort: "Davos",             disziplin: "PSL", start: "2026-12-19", end: "2026-12-19", eventid: "62760" },
  { ort: "Scuol",             disziplin: "PGS", start: "2027-01-09", end: "2027-01-09", eventid: "62761" },
  { ort: "Bansko",            disziplin: "PGS", start: "2027-01-16", end: "2027-01-17", eventid: "62762" },
  { ort: "Rogla",             disziplin: "PGS", start: "2027-01-23", end: "2027-01-23", eventid: "62763" },
  { ort: "Bad Gastein",       disziplin: "PSL", start: "2027-01-26", end: "2027-01-27", eventid: "62764" },
  { ort: "Ratschings",        disziplin: "PSL", start: "2027-01-30", end: "2027-01-30", eventid: null },
  { ort: "Krynica",           disziplin: "PGS", start: "2027-02-27", end: "2027-02-28", eventid: "62765" },
  { ort: "Winterberg",        disziplin: "PSL", start: "2027-03-20", end: "2027-03-21", eventid: "62766" },
];

const UA = { "User-Agent": "Mozilla/5.0 (sba-laufkalkulation pdf-abruf; read-only)" };

function heute() { return new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Zurich" }); }
function aktuellesEvent() { const h = heute(); return KALENDER.find(e => h >= e.start && h <= e.end) || null; }

// --- Schritt 2: Codex-Nummern der heutigen Rennen finden -------------------
async function findeCodexListe(meta) {
  if (process.env.TEST_RACE) {
    const [season, codex] = process.env.TEST_RACE.split(":");
    return { season, codexe: [codex] };
  }
  if (!meta.eventid) { console.log("Keine FIS-Event-ID hinterlegt für", meta.ort); return { season: SEASON, codexe: [] }; }
  const url = `https://www.fis-ski.com/DB/general/event-details.html?sectorcode=SB&eventid=${meta.eventid}&seasoncode=${SEASON}`;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error("Event-Seite: HTTP " + res.status);
  const html = await res.text();
  const codexe = [...new Set([...html.matchAll(/racecodex=(\d+)/g)].map(m => m[1]))];
  console.log("Gefundene Codex-Nummern:", codexe);
  return { season: SEASON, codexe };
}

// --- Schritt 3: PDF-Adressmuster durchprobieren ----------------------------
// Bekanntes FIS-Muster: data.fis-ski.com/pdf/<Saison>/SB/<Codex>/<Saison>SB<Codex><DOK>.pdf
// Die exakten DOK-Kürzel werden beim ersten Testlauf aus den Logs bestätigt.
const DOKTYPEN = [
  { code: "SLQ1", art: "startliste", run: "q1" }, { code: "SLQ2", art: "startliste", run: "q2" },
  { code: "SL1",  art: "startliste", run: "q1" }, { code: "SL2",  art: "startliste", run: "q2" },
  { code: "RLQ1", art: "resultat",   run: "q1" }, { code: "RLQ2", art: "resultat",   run: "q2" },
  { code: "RL1",  art: "resultat",   run: "q1" }, { code: "RL2",  art: "resultat",   run: "q2" },
  { code: "QUA1", art: "resultat",   run: "q1" }, { code: "QUA2", art: "resultat",   run: "q2" },
];

async function holePdfText(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.slice(0, 5).toString() !== "%PDF-") return null;
  try { return (await pdfParse(buf)).text; } catch (e) { console.log("PDF unlesbar:", url, e.message); return null; }
}

// --- Schritt 4: Parsen ------------------------------------------------------
const norm = {
  gender(text) {
    if (/\b(WOMEN|LADIES|DAMEN|FRAUEN)\b/i.test(text)) return "frauen";
    if (/\b(MEN|HERREN|MÄNNER)\b/i.test(text)) return "maenner";
    return null;
  },
  zeit(s) {
    const m = String(s).trim().replace(",", ".").match(/^(?:(\d+):)?(\d{1,2}\.\d{2})$/);
    if (!m) return null;
    const sec = (m[1] ? parseInt(m[1], 10) * 60 : 0) + parseFloat(m[2]);
    return sec > 5 && sec < 600 ? Math.round(sec * 100) / 100 : null;
  },
};

/** Startliste: Kurszuteilung pro Startnummer ermitteln.
 *  Erkennt Abschnitts-Überschriften ("Blue Course"/"Red Course") und
 *  Zeilen, in denen der Kurs direkt hinter dem Namen steht. */
function parseStartliste(text) {
  const bibKurs = {};
  let aktKurs = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (/BLUE/i.test(line) && /COURSE|KURS/i.test(line)) { aktKurs = "blau"; continue; }
    if (/RED/i.test(line) && /COURSE|KURS/i.test(line)) { aktKurs = "rot"; continue; }
    const inline = /\b(BLUE)\b/i.test(line) ? "blau" : /\b(RED)\b/i.test(line) ? "rot" : null;
    const m = line.match(/^(\d{1,3})\s+/);
    if (m) {
      const kurs = inline || aktKurs;
      if (kurs) bibKurs[m[1]] = kurs;
    }
  }
  return bibKurs;
}

/** Resultatliste: Rang/Startnummer/Name/Zeit pro Zeile; Kurs aus der Zeile
 *  selbst (BLUE/RED) oder über die Startlisten-Zuteilung. */
function parseResultate(text, runId, bibKurs) {
  const gender = norm.gender(text.slice(0, 1500)) || norm.gender(text);
  const entries = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    // typisch: "1 12 9530000 MUSTERMANN Max 1995 SUI 36.75" (Varianten toleriert)
    const m = line.match(/^(\d{1,2})\s+(\d{1,3})\s+(?:\d{6,8}\s+)?([A-Za-zÄÖÜäöüéèàŽŠČĆžšćč'’\-. ]{3,40}?)\s+(?:\d{4}\s+)?([A-Z]{3})\b.*?(\d{1,2}:\d{2}\.\d{2}|\d{2,3}\.\d{2})\s*$/);
    if (!m) continue;
    const zeit = norm.zeit(m[5]);
    if (zeit == null) continue;
    const kurs = /\bBLUE\b/i.test(line) ? "blau" : /\bRED\b/i.test(line) ? "rot" : bibKurs[m[2]] || null;
    entries.push({ bib: m[2], name: m[3].replace(/\s[A-ZÄÖÜ][a-zäöüéè\-']+.*$/, "").trim(), zeit, run: runId, kurs, gender });
  }
  return entries;
}

// --- Firebase (identisch zu poller.js) --------------------------------------
async function fbLogin() {
  const res = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" + FB.apiKey,
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
  if (!ev.auto) return null;
  for (const runId of ["q1", "q2"]) {
    const run = ev.runs.find(r => r.id === runId);
    for (const g of ["frauen", "maenner"]) {
      for (const k of ["blau", "rot"]) {
        const zeiten = entries
          .filter(e => e.run === runId && e.gender === g && e.kurs === k)
          .sort((a, b) => a.zeit - b.zeit).slice(0, 8)
          .map(e => ({ name: e.name, zeit: e.zeit }));
        if (zeiten.length) run[g][k] = zeiten;
      }
    }
  }
  return { v: 1, events, updatedAt: new Date().toISOString() };
}

// --- Handler ----------------------------------------------------------------
exports.handler = async () => {
  const ok = (msg) => { console.log(msg); return { statusCode: 200, body: msg }; };
  try {
    const evMeta = aktuellesEvent();
    if (!evMeta && process.env.FORCE !== "1") return ok("Kein Renntag – nichts zu tun.");
    const meta = evMeta || { ort: "TEST", disziplin: "PGS", start: heute(), end: heute() };

    const { season, codexe } = await findeCodexListe(meta);
    if (!codexe.length) return ok("Keine Rennen/Codex gefunden.");

    const alle = [];
    for (const codex of codexe) {
      const base = `https://data.fis-ski.com/pdf/${season}/SB/${codex}/${season}SB${codex}`;
      const startlisten = {};
      // zuerst Startlisten (Kurszuteilung), dann Resultate
      for (const art of ["startliste", "resultat"]) {
        for (const d of DOKTYPEN.filter(x => x.art === art)) {
          const url = base + d.code + ".pdf";
          const text = await holePdfText(url);
          if (!text) continue;
          console.log("PDF gefunden:", url);
          if (d.art === "startliste") {
            startlisten[d.run] = parseStartliste(text);
            console.log(`Startliste ${d.run}: ${Object.keys(startlisten[d.run]).length} Kurszuteilungen`);
          } else {
            const entries = parseResultate(text, d.run, startlisten[d.run] || {});
            const ohneKurs = entries.filter(e => !e.kurs).length;
            const ohneGender = entries.filter(e => !e.gender).length;
            console.log(`Resultate ${d.run} (Codex ${codex}): ${entries.length} Zeilen, davon ohne Kurs: ${ohneKurs}, ohne Geschlecht: ${ohneGender}`);
            if (!entries.length) console.log("Text-Ausschnitt zur Diagnose:\n" + text.slice(0, 1500));
            alle.push(...entries.filter(e => e.kurs && e.gender));
          }
        }
      }
    }
    if (!alle.length) return ok("Noch keine verwertbaren PDF-Daten (oder Parser braucht Schärfung – siehe Logs).");
    console.log(`Total verwertbar: ${alle.length} Zeiten.`, alle.slice(0, 6));

    if (process.env.DRY_RUN === "1") return ok("DRY_RUN – nichts geschrieben.");
    if (!FB.password) return ok("CC_PASSWORD fehlt – nichts geschrieben.");
    const token = await fbLogin();
    const state = await fbGetState(token);
    const neu = upsert(state, meta, alle);
    if (!neu) return ok("Event ist manuell verwaltet – nicht angefasst.");
    await fbPutState(token, neu);
    return ok(`Firebase aktualisiert (${alle.length} Zeiten aus PDFs, Event ${meta.ort}).`);
  } catch (err) {
    console.error(err);
    return { statusCode: 500, body: String(err.message || err) };
  }
};

// Lokaler Selbsttest der Text-Parser: node functions/pdf-poller.js --selftest
if (process.argv.includes("--selftest")) {
  const sl = "QUALIFICATION RUN 1\nBlue Course\n1 ZOGG Julie SUI\n3 MIKI Tsubaki JPN\nRed Course\n2 CORATTI Elisa ITA\n4 RIEGLER Claudia ITA\n";
  const bk = parseStartliste(sl);
  console.log("Startliste:", bk);
  const rl = "CORTINA (ITA) WOMEN QUALIFICATION RUN 1\n" +
    "1 1 9515159 ZOGG Julie 1994 SUI 36.75\n" +
    "2 2 9295086 CORATTI Elisa 2001 ITA 36.98\n" +
    "3 3 9205062 MIKI Tsubaki 2002 JPN 37.24\n" +
    "4 4 9295031 RIEGLER Claudia 1973 ITA 1:37.16\n";
  console.log("Resultate:", parseResultate(rl, "q1", bk));
}
