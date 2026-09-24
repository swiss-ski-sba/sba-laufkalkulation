# SBA Live-Abruf – FIS-Livedaten → Firebase

Kleiner Hintergrund-Dienst (Netlify Scheduled Function): Läuft **jede Minute**,
prüft, ob heute ein Weltcup-Renntag ist (Kalender in `functions/poller.js`),
holt dann die FIS-Live-Resultate und schreibt die Zeiten als «automatisches
Command Center» in die Firebase der SBA Laufkalkulation. Die App selbst bleibt
unverändert – die Coaches sehen die Zeiten wie gewohnt live.

**Sicherheitsnetz:** Der Dienst fasst nur Events an, die er selbst angelegt hat
(`auto: true`). Manuell im Command Center erfasste Events werden nie verändert –
die manuelle Erfassung bleibt als Fallback voll funktionsfähig. Bestehende
Kurslisten werden nie mit «leer» überschrieben.

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
