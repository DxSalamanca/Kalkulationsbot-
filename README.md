# Kalkulationsbot

Kalkuliert Angebote nach dem Zuschlagsverfahren und legt sie als **Entwurf im
Nexus ERP** an. Einkaufspreise, Artikelbezeichnungen, Mindest-VK und
**Stücklisten** kommen direkt aus dem ERP, die Angebotsnummer vergibt das ERP.

```
Kalkulationsbot ──GET /api/v1/artikel──▶ Nexus ERP   (EK, VK, Mindest-VK)
                ──GET /api/v1/stuecklisten─▶         (Komponenten + Materialkosten)
                ──GET /api/v1/kunden───▶             (Kundensuche)
                ──POST /api/v1/belege──▶             (Angebot als Entwurf, Nummer vom ERP)
```

Den IT-Audit-Bericht zur Anbindung findest du in [`docs/IT-AUDIT.md`](docs/IT-AUDIT.md).

## Voraussetzungen

- Node.js ab 20.12, keine weiteren Abhängigkeiten
- Nexus ERP mit Public API v1 (ab Branch `claude/it-audit-app-connection-vxi6w3`,
  davor war die API defekt, siehe Audit)
- ein API-Key aus **Nexus > Einstellungen > API-Keys** (nur Administratoren) mit den
  Berechtigungen `artikel:read` (gilt auch für Stücklisten), `kunden:read`, `belege:write`. Am besten zusätzlich
  mit Ablaufdatum und auf die IP des Rechners beschränkt, auf dem der Bot läuft.

## Einrichtung

```bash
cp .env.example .env      # NEXUS_URL und NEXUS_API_KEY eintragen
npm test                  # Selbsttest
npm run beispiel          # Beispiel offline durchrechnen
```

`.env` steht in `.gitignore` und darf nie eingecheckt werden.

## Nutzung

### Web-Oberfläche

```bash
npm start                 # http://127.0.0.1:3210
```

Positionen erfassen, **Berechnen**, Ergebnis prüfen, dann **Als Angebot ins ERP**.
Der Server läuft standardmäßig nur auf diesem Rechner. Soll er im Netz erreichbar
sein, `HOST`, `KALKBOT_PASSWORT` und `KALKBOT_HOSTS` setzen. Ohne Passwort startet er
dann nicht.

### Kommandozeile

```bash
node bin/kalkulation.js examples/badsanierung.json            # Vorschau mit ERP-Preisen
node bin/kalkulation.js examples/badsanierung.json --offline  # ohne ERP
node bin/kalkulation.js examples/badsanierung.json --senden   # Angebot im ERP anlegen
node bin/kalkulation.js examples/badsanierung.json --json     # maschinenlesbar
```

## Kalkulationsdatei

```jsonc
{
  "titel": "Badsanierung Erdgeschoss",      // landet in den Notizen des Angebots
  "referenz": "Anfrage vom 10.10.2026",
  "kunde": { "id": 17 },                    // ERP-Kunde … oder { "name": "…", "ort": "…" }
  "gueltigTage": 30,                        // -> Fälligkeitsdatum des Angebots
  "parameter": { "wagnisGewinn": 12 },      // überschreibt .env-Werte
  "positionen": [
    { "artikelId": "ART-0815", "menge": 4 },                        // EK + Name aus dem ERP
    { "artikelId": "ART-0816", "menge": 1, "preisquelle": "liste" }, // Listen-VK aus dem ERP
    { "artikelId": "TISCH-01", "menge": 2, "stueckliste": "summe" },  // EK = Materialkosten der Stückliste
    { "artikelId": "TISCH-01", "menge": 2, "stueckliste": "einzeln" },// jede Komponente als eigene Zeile
    { "name": "Fliesen", "menge": 18, "einheit": "m²", "ek": 32.5 },
    { "name": "Montage", "typ": "lohn", "stunden": 6 },
    { "name": "Meister", "typ": "lohn", "stunden": 1, "kostensatz": 62 },
    { "name": "Entsorgung", "typ": "fremdleistung", "menge": 1, "ek": 380, "rabatt": 5 },
    { "name": "Pauschale", "menge": 1, "ek": 50, "vk": 99 }          // fester VK
  ]
}
```

### Stücklisten

Für gefertigte Artikel holt der Bot die Stückliste aus Nexus. Baugruppen werden
dabei bis auf die Kaufteile aufgelöst, jeweils mit aktuellem Einkaufspreis.

| `"stueckliste"` | Ergebnis im Angebot |
|---|---|
| `"summe"` | **eine** Zeile für den Artikel. Einzelkosten = Materialkosten laut Stückliste, die Zusammensetzung steht in der Positionsbeschreibung. Ein `ek` in der Datei hat Vorrang. |
| `"einzeln"` | **jede Komponente** als eigene Materialzeile (Menge × Stückzahl), Rabatt der Zeile wird übernommen |

Arbeitszeit für Montage oder Fertigung gehört als eigene `lohn`-Position dazu.
Meldet Nexus einen Zyklus oder eine gelöschte Komponente, bricht die
Kalkulation ab, denn der Preis wäre sonst zu niedrig.

```bash
node bin/kalkulation.js --stuecklisten            # welche Stücklisten gibt es?
node bin/kalkulation.js --stuecklisten TISCH-01   # Komponenten + Materialkosten
node bin/kalkulation.js examples/esstisch.json    # Beispiel-Kalkulation mit Stückliste
```

In der Web-Oberfläche gibt es dafür die Spalte **Stückliste** (bei Material-Zeilen).

### Rechenweg je Position

| Schritt | Material / Fremdleistung | Lohn |
|---|---|---|
| Einzelkosten | EK | Stunden × Lohnkostensatz |
| + Gemeinkosten | `zuschlaege.material` bzw. `.fremdleistung` % | `zuschlaege.lohn` % |
| = Selbstkosten | | |
| + Wagnis & Gewinn | `wagnisGewinn` % | `wagnisGewinn` % |
| = VK je Einheit | auf Cent gerundet (oder fester `vk`) | |

Die Summen (Netto, MwSt, Brutto, Gesamtrabatt) werden **genau wie im Nexus ERP**
berechnet. Nach dem Senden vergleicht die Kommandozeile die Nettosumme des ERP mit
der eigenen und warnt bei Abweichung. Im ERP wird je Position `purchasePrice` =
Einzelkosten gespeichert, damit die Deckungsbeitragsauswertung dort stimmt.

Der Bot warnt, wenn
- ein Preis (nach Rabatt) die Selbstkosten nicht deckt,
- der VK unter dem **Mindest-VK** aus dem ERP liegt,
- die Gesamtmarge unter `mindestMargeProzent` fällt,
- Einzelkosten 0 sind.

### Parameter

| Datei (`parameter`) | Umgebung | Beispielwert |
|---|---|---|
| `lohnkostensatz` | `KALK_LOHNKOSTENSATZ` | 45 €/h |
| `zuschlaege.material` | `KALK_ZUSCHLAG_MATERIAL` | 15 % |
| `zuschlaege.lohn` | `KALK_ZUSCHLAG_LOHN` | 60 % |
| `zuschlaege.fremdleistung` | `KALK_ZUSCHLAG_FREMDLEISTUNG` | 10 % |
| `wagnisGewinn` | `KALK_WAGNIS_GEWINN` | 10 % |
| `steuersatz` | `KALK_STEUERSATZ` | 19 % |
| `gesamtrabatt` | – | 0 % |
| `mindestMargeProzent` | `KALK_MINDESTMARGE` | 0 (aus) |

Die Beispielwerte sind Platzhalter. Trag die Sätze aus deiner eigenen
Betriebsabrechnung bzw. von deinem Steuerberater ein.

## Sicherheit

- Der API-Key bleibt auf dem Server bzw. in der Kommandozeile und geht nie an den Browser.
- Zum ERP nur per `https://` (`http://` ist nur für `localhost` erlaubt).
- Angebote werden nicht automatisch erneut gesendet, wenn eine Anfrage fehlschlägt
  (sonst könnten Dubletten entstehen). Die Oberfläche blockiert doppelte Klicks 2 Minuten lang.
- Web-Server: CSP, Host-Prüfung (DNS-Rebinding), Origin-Prüfung (CSRF), Body-Limit.
