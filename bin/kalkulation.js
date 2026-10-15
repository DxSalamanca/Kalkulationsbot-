#!/usr/bin/env node
// =============================================================================
// Kalkulationsbot – Kommandozeile
//
//   node bin/kalkulation.js <kalkulation.json>            Vorschau (mit ERP-Preisen)
//   node bin/kalkulation.js <kalkulation.json> --offline  Vorschau ohne ERP
//   node bin/kalkulation.js <kalkulation.json> --senden   Angebot im ERP anlegen
//   node bin/kalkulation.js <kalkulation.json> --json     Ergebnis als JSON
//   node bin/kalkulation.js --stuecklisten                Stuecklisten im ERP auflisten
// =============================================================================

import { readFile } from "node:fs/promises";
import { NexusClient, NexusFehler } from "../src/nexusClient.js";
import { angebotVorbereiten, kundePruefen, parameterAusUmgebung } from "../src/angebot.js";
import { formatiereErgebnis } from "../src/ausgabe.js";

function hilfe() {
  console.log(`Kalkulationsbot – Angebote kalkulieren und im Nexus ERP anlegen

Aufruf:
  node bin/kalkulation.js <datei.json> [--offline] [--senden] [--json]
  node bin/kalkulation.js --stuecklisten [ARTIKELNUMMER]

Optionen:
  --offline  ohne ERP rechnen (alle EK-Preise muessen in der Datei stehen)
  --senden   Angebot als Entwurf im Nexus ERP anlegen
  --json     Ergebnis maschinenlesbar ausgeben
  --stuecklisten  aktive Stuecklisten im ERP auflisten, mit Artikelnummer:
                  Komponenten und Materialkosten anzeigen

Umgebung (.env): NEXUS_URL, NEXUS_API_KEY, KALK_* (siehe README)`);
}

async function stuecklistenAnzeigen(client, artikelId) {
  if (!artikelId) {
    const liste = await client.stuecklistenListe();
    if (!liste.length) console.log("Im ERP sind keine aktiven Stuecklisten angelegt.");
    for (const s of liste) console.log(`${s.artikelId.padEnd(16)} ${s.name}`);
    return 0;
  }
  const sl = await client.stuecklisteLaden(artikelId);
  if (!sl) {
    console.error(`Fuer Artikel ${artikelId} gibt es keine aktive Stueckliste.`);
    return 2;
  }
  console.log(`${sl.stueckliste.name} (Artikel ${artikelId}), je 1 Einheit:`);
  for (const k of sl.komponenten) {
    const kosten = (k.menge * k.purchasePrice).toFixed(2);
    console.log(`  ${String(k.menge).padStart(8)} ${k.einheit.padEnd(5)} ${(k.name ?? k.artikelId).padEnd(32)} ${kosten.padStart(10)} EUR`);
  }
  console.log(`  Materialkosten: ${sl.materialkosten.toFixed(2)} EUR`);
  for (const w of sl.warnungen) console.log(`  ! ${w}`);
  console.log(`\nIn der Kalkulation: { "artikelId": "${artikelId}", "menge": 1, "stueckliste": "summe" }  (oder "einzeln")`);
  return 0;
}

async function main(argv) {
  const args = argv.slice(2);
  if (args.includes("-h") || args.includes("--help") || args.length === 0) {
    hilfe();
    return args.length === 0 ? 1 : 0;
  }
  const datei = args.find((a) => !a.startsWith("--"));

  if (args.includes("--stuecklisten")) {
    try { process.loadEnvFile?.(); } catch { /* keine .env vorhanden */ }
    const client = new NexusClient({ baseUrl: process.env.NEXUS_URL, apiKey: process.env.NEXUS_API_KEY });
    return stuecklistenAnzeigen(client, datei);
  }
  const offline = args.includes("--offline");
  const senden = args.includes("--senden");
  const alsJson = args.includes("--json");

  if (offline && senden) {
    console.error("--offline und --senden schliessen sich aus.");
    return 1;
  }

  try { process.loadEnvFile?.(); } catch { /* keine .env vorhanden */ }

  let daten;
  try {
    daten = JSON.parse(await readFile(datei, "utf8"));
  } catch (e) {
    console.error(`Kalkulationsdatei konnte nicht gelesen werden: ${e.message}`);
    return 1;
  }

  const client = offline
    ? null
    : new NexusClient({ baseUrl: process.env.NEXUS_URL, apiKey: process.env.NEXUS_API_KEY });

  const { fehler, ergebnis, payload } = await angebotVorbereiten(daten, {
    client,
    envParameter: parameterAusUmgebung(),
  });
  if (fehler.length) {
    console.error("Die Kalkulation ist nicht vollstaendig:\n" + fehler.map((f) => `  - ${f}`).join("\n"));
    return 2;
  }

  let angebot = null;
  if (senden) {
    const kundeFehler = kundePruefen(daten);
    if (kundeFehler) {
      console.error(kundeFehler);
      return 2;
    }
    angebot = await client.angebotAnlegen(payload);
  }

  if (alsJson) {
    console.log(JSON.stringify({ ergebnis, payload, angebot }, null, 2));
  } else {
    console.log(formatiereErgebnis(ergebnis, { titel: daten.titel }));
    if (angebot) {
      console.log(`\nAngebot ${angebot.id} als Entwurf im Nexus ERP angelegt (Netto ${angebot.subtotal.toFixed(2)} EUR).`);
      if (Math.abs(angebot.subtotal - ergebnis.summen.netto) > 0.005) {
        console.log(`ACHTUNG: Das ERP hat eine abweichende Nettosumme berechnet (${angebot.subtotal.toFixed(2)} statt ${ergebnis.summen.netto.toFixed(2)} EUR).`);
      }
    } else if (!senden) {
      console.log("\nVorschau – nichts gesendet. Mit --senden als Angebot im ERP anlegen.");
    }
  }
  return 0;
}

main(process.argv).then(
  (code) => { process.exitCode = code; },
  (e) => {
    console.error(e instanceof NexusFehler ? `Nexus ERP: ${e.message}` : e);
    process.exitCode = 3;
  }
);
