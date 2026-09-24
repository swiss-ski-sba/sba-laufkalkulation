# SBA Live-Abruf – FIS-Daten → Firebase

Zwei kleine Hintergrund-Dienste (Netlify Scheduled Functions), beide nur an
Weltcup-Renntagen aktiv (Kalender in den Funktionen; sonst beenden sie sich
sofort):

- **`poller`** (jede Minute): holt die FIS-**Live**-Resultate während des
  Laufs und schreibt die Zeiten in die Firebase der SBA Laufkalkulation.
- **`pdf-poller`** (alle 5 Minuten): holt die **offiziellen Quali-PDFs**
  (Startlisten mit Kurszuteilung, Resultatlisten Run 1/2), die die FIS kurz
  nach jedem Lauf publiziert – als robuste zweite Quelle, falls ein
  Veranstalter keine Live-Quali einspeist. Zeiten kommen hier jeweils kurz
  nach Laufende.

Beide schreiben als «automatisches Command Center» in dieselbe App.

**Sicherheitsnetz (beide Dienste):** Es werden nur Events angefasst, die die
Automatik selbst angelegt hat (`auto: true`). Manuell im Command Center
erfasste Events werden nie verändert – die manuelle Erfassung bleibt als
Fallback voll funktionsfähig. Bestehende Kurslisten werden nie mit «leer»
überschrieben. `DRY_RUN=1` = nur loggen, nichts schreiben.

## Vorab-Test – jederzeit möglich, ohne auf ein Rennen zu warten

Die ganze Kette (Zeitplan → Abruf → Parser → Firebase-Login → Schreiben →
Anzeige in der App) lässt sich sofort mit den mitgelieferten Mock-Daten
testen. Einziger Teil, der sich erst am echten Rennen prüfen lässt, ist das
exakte Datenformat der FIS-Live-Seite.

1. Site deployen (siehe unten), Umgebungsvariablen setzen:
   - `CC_PASSWORD` = Command-Center-Passwort
   - `LIVE_URL` = `https://DEINE-SITE.netlify.app/mock-live.json`
   - `FORCE` = `1` (Renntag-Check übergehen)
   - `DRY_RUN` **nicht** setzen
2. Warten (max. 1 Minute) – der Poller liest die Mock-Daten und schreibt sie
   in die Firebase. In der App erscheint ein Event **«TEST»** mit vollständigen
   Q1/Q2-Zeiten für Frauen und Männer – inkl. Kernaussage-Banner, Paarvergleich
   und Live-Aktualisierung bei den Coaches.
3. Aufräumen: `FORCE` und `LIVE_URL` wieder entfernen, `DRY_RUN=1` setzen,
   und das TEST-Event im Command Center löschen (Menü ⋮ → Event löschen).

Zusätzlich sinnvoll, **vor** dem Saisonstart:

- **PDF-Pfad mit echten Daten der letzten Saison testen:** In Netlify
  `TEST_RACE=2026:6169` (= Cortina-Quali vom 13.12.2025), `FORCE=1` und
  `DRY_RUN=1` setzen. Der `pdf-poller` probiert dann die FIS-PDF-Adressen
  dieses Rennens durch und loggt gefundene Dokumente, erkannte Kurszuteilungen
  und Zeiten – echte FIS-PDFs, heute testbar. Anhand der Logs wird der
  Parser einmalig geschärft. Danach `TEST_RACE` wieder entfernen.
- **Generalprobe Sölden (24./25. Okt. 2026):** Beim Ski-Alpin-Saisonstart
  läuft die echte FIS-Live-Infrastruktur zum ersten Mal in der Saison.
  Am Rennmorgen (Damen Sa 24.10., Herren So 25.10., Läufe ca. 10:00/13:00)
  `FORCE=1` und `DRY_RUN=1` setzen – der `poller` findet die echten
  Live-Links und loggt die Datenstruktur. Logs sichern (Netlify → Functions
  → poller), damit der Live-Parser vor Snow Ruyi fertig geschärft ist.
  Danach `FORCE` wieder entfernen.

## Einrichten (einmalig, ~10 Minuten)

1. In Netlify: **Add new site → Import from Git**, dieses Repository wählen,
   als **Base directory** `live-abruf` angeben. (Die App selbst bleibt, wo sie
   ist – das hier wird eine eigene kleine Site ohne Oberfläche.)
2. Umgebungsvariablen setzen:

   | Variable      | Wert                                                       |
   |---------------|------------------------------------------------------------|
   | `CC_PASSWORD` | Passwort des Command-Center-Kontos (**geheim**, Pflicht)   |
   | `DRY_RUN`     | `1` – bis der Parser am ersten Rennen verifiziert ist      |

   Optional: `CC_EMAIL`, `FB_API_KEY`, `FB_DB_URL` (Standard = Werte der App),
   `LIVE_URL` (direkte Datenquelle, sobald bekannt), `FORCE=1` (Test ausserhalb
   von Renntagen).
3. Deployen. Fertig – der Dienst schläft, bis der erste Renntag kommt.

## Verifikation am ersten Rennen (Snow Ruyi, 28./29. Nov 2026)

Die genaue Struktur der FIS-Live-Seiten ist erst sichtbar, wenn ein Rennen
wirklich live ist. Darum:

1. `DRY_RUN=1` lassen. Am Renntag in Netlify → **Functions → poller → Logs**
   schauen: Der Dienst loggt die gefundenen Live-Links, und – falls der Parser
   die Struktur noch nicht erkennt – einen Ausschnitt der Antwort.
2. Mit diesem Log-Ausschnitt passen wir `parseLive()` an (bzw. setzen
   `LIVE_URL` direkt auf die Datenquelle). Der generische Parser erkennt
   gängige JSON-Strukturen bereits von selbst.
3. Wenn die geparsten Zeiten in den Logs stimmen: `DRY_RUN` entfernen –
   ab dann schreibt der Dienst live in die App.

**Wichtig:** Ob die Quali-Läufe live eingespiesen werden, hängt vom
Timing-Anbieter des Veranstalters ab. An Rennen ohne Live-Quali bleibt die
manuelle Erfassung im Command Center der Weg.

## Betrieb

- Kosten: praktisch keine (an Nicht-Renntagen beendet sich der Dienst sofort;
  Netlify Free reicht locker).
- Kalender fürs nächste Jahr: Liste `KALENDER` in `functions/poller.js`
  aktualisieren (eine Zeile pro Event).
- Not-Aus: In Netlify die Funktion deaktivieren oder `DRY_RUN=1` setzen.
