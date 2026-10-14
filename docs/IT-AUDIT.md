# IT-Audit: Anbindung Kalkulationsbot ↔ Nexus ERP

Stand: 14.10.2026 · Umfang: Repository `Kalkulationsbot-`, Public API v1 und
API-Key-Verwaltung von `nexus-erp`, Abhängigkeiten und CI von `nexus-erp`.

## 1. Zusammenfassung

| Bereich | Vorher | Nachher |
|---|---|---|
| Kalkulationsbot | Repository leer, kein Code | Kalkulation, ERP-Client, Web-Oberfläche, Kommandozeile, 28 Tests, CI |
| Public API v1 des ERP | **funktionierte nie** (jeder Aufruf 401/500) | repariert, getestet, neuer Artikel-Endpunkt |
| API-Key-Sicherheit | jeder Benutzer konnte Keys mit beliebigen Rechten ausstellen, Widerruf defekt, IP-Sperre wirkungslos | nur Admins, Widerruf funktioniert, IP-Allowlist wird durchgesetzt |
| Angebote per API | ohne Belegnummer (Anlage scheiterte), Status/Zahlung von außen setzbar | Nummer aus dem Nummernkreis, immer Entwurf, Positionen geprüft, Audit-Log |
| Abhängigkeiten | 1 kritische, 14 hohe Lücken (npm audit), Security-Scan wertete nie aus | Scan repariert. **Next.js-Update steht noch aus (kritisch, siehe O1)** |

Die Anbindung ist damit technisch möglich. Bevor sie produktiv geht, muss
**O1 (Next.js-Update)** erledigt sein.

## 2. Vorgehen

- Code-Review der Pfade, über die ein externes Programm Angebote anlegt:
  `src/lib/apiKeyAuth.js`, `src/app/api/v1/*`, `src/app/api/admin/api-keys/*`,
  `src/app/api/api-keys/*`, Migrationen 083/101.
- Abgleich API-Vertrag ↔ Implementierung ↔ OpenAPI-Dokumentation.
- `npm audit`, Durchsicht der CI-Workflows, Repository-Hygiene.
- Neue Unit-Tests für Key-Prüfung, IP-Allowlist und Belegnummern, kompletter
  Testlauf (499 Tests grün) und Produktions-Build von `nexus-erp`.
- **Nicht** geprüft: Live-Betrieb gegen eine echte Supabase-Datenbank (im
  Prüfcontainer nicht vorhanden), RLS-Policies im Detail, die übrigen ~250
  internen API-Routen, Infrastruktur/Hosting.

## 3. Behobene Befunde (nexus-erp, Branch `claude/it-audit-app-connection-vxi6w3`)

| ID | Schwere | Befund | Auswirkung | Behebung |
|---|---|---|---|---|
| A1 | **kritisch** | `validateApiKey` lieferte den Datensatz oder `null`, die v1-Routen erwarteten `{ valid, key }`. | Die gesamte Public API war unbenutzbar: ein gültiger Key bekam 401, ohne Key gab es 500. Keine Integration konnte je funktionieren. | Neues `pruefeApiKey()` mit Ergebnisobjekt, `validiereApiKey` bleibt für den GoBD-Export kompatibel. Tests. |
| A2 | **hoch** | `POST /api/admin/api-keys` (von der Oberfläche genutzt) prüfte nur „angemeldet“, nicht „Administrator“. Scopes waren frei wählbar. | Jeder Benutzer konnte sich z. B. einen Key mit `audit:read` erzeugen und damit den kompletten GoBD-Export ziehen, oder `belege:write`. Keys arbeiten mit Service-Role, also ohne RLS. | `requireAdmin`, Scopes begrenzt, Audit-Log beim Ausstellen. |
| A3 | **hoch** | `DELETE`/`PATCH /api/admin/api-keys/[id]` lasen `params` synchron. In Next 16 ist `params` ein Promise. | Ein kompromittierter Key ließ sich über die Oberfläche nicht deaktivieren. | `await params`. |
| A4 | mittel | Die IP-Allowlist (`allowed_ips`, Migration 101) wurde gespeichert, aber nie geprüft. | Scheinsicherheit: eine eingetragene IP-Beschränkung hatte keine Wirkung. | Prüfung von IPv4/CIDR und IPv6 (exakt). Einschränkung siehe O5. |
| A5 | mittel | `POST /api/v1/belege` vergab keine Belegnummer (`id` ist Pflicht). Status, `paid` und eigene Nummer waren von außen setzbar, Positionen wurden ungeprüft gespeichert. | Anlage per API scheiterte. Nach einer Reparatur hätte ein Fremdprogramm Belege als „bezahlt“ oder mit eigener Nummer anlegen können, am Freigabe-Workflow und am Nummernkreis vorbei. | Nummer serverseitig aus dem Nummernkreis (`belegNummerServer.js`, mit Kollisions-Retry), Status immer `entwurf`, Positionen auf bekannte Felder reduziert, `customerId` wird geprüft, Audit-Log. |
| A6 | niedrig | Keys aus `/api/api-keys` haben das Präfix `nxs_`, geprüft wurde nur `nxk_`. | Diese Keys funktionierten nie. | Beide Präfixe werden akzeptiert. Zusammenführen siehe O3. |
| A7 | niedrig | `letzter_einsatz` wurde ohne `await`/`then()` aktualisiert, und der Supabase-Builder führt dann nichts aus. | „Zuletzt genutzt“ blieb leer, ungenutzte Keys waren nicht erkennbar. | `.then()` ergänzt. |
| A8 | niedrig | Die OpenAPI-Spezifikation dokumentierte Positionsfelder `bezeichnung/menge/einzelpreis`, der Server erwartet `name/quantity/unitPrice`. | Wer nach Doku integriert, erzeugt Belege über 0,00 €. | Spezifikation korrigiert, Artikel-Endpunkt und 422 dokumentiert. |
| A9 | mittel | Der Security-Workflow las `nexus-erp/audit-report.json` (falscher Pfad) per `require('/dev/stdin')`. | Die Prüfung auf kritische Lücken griff nie. | Pfad und Einlesen korrigiert. Der Scan meldet jetzt O1 und schlägt deshalb auf `main` fehl, bis Next.js aktualisiert ist. Das ist gewollt. |

Neu: `GET /api/v1/artikel` (Scope `artikel:read`) mit EK, VK und Mindest-VK.

## 4. Offene Befunde und Empfehlungen

| ID | Schwere | Befund | Empfehlung |
|---|---|---|---|
| O1 | **kritisch** | `next@16.2.9`: Middleware/Proxy-Bypass (App Router, Turbopack). Dazu PostCSS-XSS und `sharp`/libvips-Lücken über dieselbe Abhängigkeit. | Auf `next@16.4.0` (oder neuer) aktualisieren, `eslint-config-next` mitziehen, danach `npm run check` und die Playwright-E2E-Tests laufen lassen. **Vor dem Produktivgang der API erledigen.** |
| O2 | hoch | `nodemailer` (Mail an falsche Domain möglich, Fix erst in v10, Breaking Change). `xlsx` 0.18.5 (Prototype Pollution), auf npm gibt es keinen Fix mehr. | nodemailer gezielt aktualisieren und Mailversand testen. `xlsx` durch den SheetJS-CDN-Build ≥ 0.20.2 oder `exceljs` ersetzen, bis dahin nur vertrauenswürdige Dateien importieren. |
| O3 | mittel | Zwei parallele API-Key-Verwaltungen (`/api/api-keys` mit `nxs_`, `/api/admin/api-keys` mit `nxk_`) mit unterschiedlichen Feldern. Die IP-Allowlist lässt sich nur über die alte Route setzen, die Oberfläche bietet sie nicht an. | Auf eine Route zusammenführen und die IP-Allowlist samt Ablaufdatum in die Oberfläche aufnehmen. |
| O4 | mittel | `belege:write` erlaubt einem Key, **jeden** Belegtyp anzulegen, auch Rechnungen und Gutschriften. | Feineren Scope einführen, z. B. `angebote:write`. Der Kalkulationsbot braucht nur Angebote (Prinzip der geringsten Rechte). |
| O5 | mittel | Die IP-Allowlist verlässt sich auf `X-Forwarded-For`. Das ist nur verlässlich hinter einem Proxy, der den Header setzt (Vercel, korrekt konfiguriertes nginx/Caddy). | `next start` nie direkt ins Internet stellen. Reverse-Proxy so konfigurieren, dass er `X-Forwarded-For` überschreibt. |
| O6 | mittel | Rate-Limit standardmäßig im Speicher (`RATE_LIMIT_STORE=memory`). Mit mehreren Instanzen oder Serverless ist es praktisch wirkungslos. | In Produktion `RATE_LIMIT_STORE=redis` (Upstash) setzen. |
| O7 | mittel | Belegnummern werden im Browser (`getNextBelegNummer`) und an mehreren Stellen im Server je eigen berechnet. Kollisionen fängt nur ein Retry ab. | Mittelfristig Nummernvergabe in der Datenbank (Sequenz bzw. RPC je Nummernkreis, `FOR UPDATE`). Das ist für GoBD-konforme, lückenlose Nummernkreise ohnehin sauberer. |
| O8 | mittel | Für die v1-API gab es keinen einzigen Test. Nur deshalb konnte A1 unbemerkt bleiben. | Vertragstests (OpenAPI ↔ Routen) und einen E2E-Test „Angebot per API anlegen“ in CI aufnehmen. |
| O9 | niedrig | CORS `*` auf v1. Das ist für Server-zu-Server in Ordnung, verleitet aber dazu, Keys in Browser-Code einzubauen. | Key-Nutzung im Browser dokumentiert untersagen, optional CORS auf eine Liste beschränken. |
| O10 | niedrig | Repository-Hygiene: 13 `*.bak`-Dateien eingecheckt, `023_aktivitaeten.sql` im Wurzelverzeichnis, Notizdatei `Info SQL` im Migrationsordner, README ist noch die Next.js-Vorlage. | Aufräumen, `*.bak` in `.gitignore`, README mit Setup und Betrieb füllen. |
| O11 | niedrig | Der Security-Scan läuft nur bei Push auf `main`/`develop` und bei PRs nach `main`. | Zusätzlich auf Feature-Branches laufen lassen, dann fallen Lücken vor dem Merge auf. |

## 5. Architektur der Anbindung

```
┌──────────────── Kalkulationsbot (lokal / Firmenserver) ───────────────┐
│  Browser-Oberfläche ──▶ src/server.js ──▶ src/angebot.js              │
│  (kein API-Key)          CSP, Host-/Origin-   ├─ src/kalkulation.js   │
│                          Prüfung, Basic-Auth  └─ src/nexusClient.js ──┼──HTTPS + Bearer nxk_…──┐
│  CLI bin/kalkulation.js ───────────────────────▶                      │                        │
└───────────────────────────────────────────────────────────────────────┘                        ▼
                                                    ┌────────────── Nexus ERP ──────────────┐
                                                    │ pruefeApiKey: Hash, aktiv, Ablauf, IP │
                                                    │ Scope-Prüfung, Rate-Limit je Key      │
                                                    │ GET  /api/v1/artikel  (artikel:read)  │
                                                    │ GET  /api/v1/kunden   (kunden:read)   │
                                                    │ POST /api/v1/belege   (belege:write)  │
                                                    │  └ Nummernkreis, Entwurf, Audit-Log   │
                                                    └───────────────────────────────────────┘
```

Grundsätze:
- **Das ERP bleibt führend.** Nummer, Status und Summen bestimmt das ERP, der
  Bot liefert nur Positionen und Preise. Freigabe-Workflow und GoBD-Nummernkreis
  bleiben unberührt.
- **Rechenweg identisch.** Der Bot rechnet die Summen mit derselben Formel wie
  `belegSummen()` im ERP und vergleicht nach dem Anlegen.
- **Keine automatischen Wiederholungen beim Anlegen**, damit keine doppelten
  Angebote entstehen. Lesende Abfragen werden bei 429/5xx wiederholt.

## 6. Einrichtung Schritt für Schritt

1. Branch `claude/it-audit-app-connection-vxi6w3` in `nexus-erp` prüfen und mergen,
   **O1 (Next.js-Update) erledigen**, deployen.
2. In Nexus als Administrator unter *Einstellungen > API-Keys* einen Key
   „Kalkulationsbot“ mit `artikel:read`, `kunden:read`, `belege:write` und
   Ablaufdatum (z. B. 1 Jahr) anlegen. Den Key sofort in den Passwortmanager übernehmen.
3. Im Kalkulationsbot `cp .env.example .env`, dann `NEXUS_URL` (https) und
   `NEXUS_API_KEY` eintragen und die Zuschlagssätze aus der eigenen
   Betriebsabrechnung setzen.
4. `npm test`, danach `node bin/kalkulation.js examples/badsanierung.json` (Vorschau
   mit Live-Verbindung). Bei Erfolg einmal `--senden` und den Entwurf im ERP unter
   *Verkauf* prüfen.
5. Optional `npm start` für die Web-Oberfläche.

## 7. Verbesserungsvorschläge

### Kalkulationsbot

1. **Gewerke-Vorlagen**: wiederkehrende Kalkulationen (z. B. „Bad 6 m²“) als
   Vorlage speichern und mit Mengen skalieren.
2. **Stundensätze aus dem ERP**: Nexus kennt Lohngruppen (`/api/lohngruppen`).
   Ein v1-Endpunkt dafür macht den Lohnkostensatz pro Mitarbeitergruppe pflegbar,
   statt ihn in `.env` zu führen.
3. **Nachkalkulation**: Ist-Stunden aus Zeiterfassung/Projekteinsätzen gegen die
   kalkulierten Stunden halten und die Zuschläge anhand echter Werte nachjustieren.
4. **KI-Vorschläge mit Freigabe**: Freitext-Anfrage des Kunden → Positionsvorschlag
   (Nexus hat bereits `/api/ki/angebotsgenerator`). Ein Mensch prüft immer, bevor gesendet wird.
5. **GAEB-/Leistungsverzeichnis-Import** (DA83/X83) für Ausschreibungen.
6. **Kalkulation am Angebot ablegen**: Rechenweg als Anhang/Dokument im ERP
   speichern. So bleibt nachvollziehbar, wie ein Preis zustande kam.
7. **Preisaktualität**: warnen, wenn ein EK im ERP älter als X Tage ist (Preishistorie
   gibt es bereits: `/api/artikel/[id]/preishistorie`).
8. **Rückkanal**: Webhook aus Nexus, wenn ein Angebot angenommen wird. Daraus
   automatisch Material bestellen oder Einsatz planen.

### Nexus ERP

1. O1 bis O4 zeitnah umsetzen, danach O8 (Tests für die API).
2. Dashboard „API-Nutzung“: welcher Key wann was angelegt hat. Die Daten liegen
   jetzt im Audit-Log und in `letzter_einsatz`.
3. Keys mit Ablaufdatum erzwingen (max. 12 Monate) und vor Ablauf benachrichtigen.

## 8. Ergebnis der Prüfläufe

- `nexus-erp`: `vitest` 499/499 grün (davon 17 neu), `eslint` ohne Warnungen auf allen
  geänderten Dateien, `next build` erfolgreich. Der Spaltencheck (`npm run db:spalten`)
  braucht eine Datenbank und läuft in CI.
- `Kalkulationsbot-`: `node --test` 28/28 grün, Web-Oberfläche im Browser
  durchgeklickt (Berechnung offline, keine JS-Fehler).
- **Nicht** durchgeführt: Ende-zu-Ende-Test gegen ein laufendes Nexus mit echter
  Datenbank. Das ist Schritt 4 der Einrichtung.
