// =============================================================================
// Angebot vorbereiten – verbindet Kalkulation und Nexus ERP
// -----------------------------------------------------------------------------
//   1. Parameter und Positionen pruefen
//   2. Stuecklisten aufloesen, Artikelpreise (EK, Listen-VK, Mindest-VK)
//      aus dem ERP nachladen
//   3. Kalkulieren
//   4. Payload fuer POST /api/v1/belege bauen
// =============================================================================

import { parameterZusammenfuehren, positionenPruefen, kalkulieren, zuNexusPosition } from "./kalkulation.js";

/**
 * Liest Kalkulations-Parameter aus Umgebungsvariablen (alle optional).
 *   KALK_LOHNKOSTENSATZ, KALK_ZUSCHLAG_MATERIAL, KALK_ZUSCHLAG_LOHN,
 *   KALK_ZUSCHLAG_FREMDLEISTUNG, KALK_WAGNIS_GEWINN, KALK_STEUERSATZ,
 *   KALK_MINDESTMARGE
 */
export function parameterAusUmgebung(env = process.env) {
  return {
    lohnkostensatz: env.KALK_LOHNKOSTENSATZ,
    wagnisGewinn: env.KALK_WAGNIS_GEWINN,
    steuersatz: env.KALK_STEUERSATZ,
    mindestMargeProzent: env.KALK_MINDESTMARGE,
    zuschlaege: {
      material: env.KALK_ZUSCHLAG_MATERIAL,
      lohn: env.KALK_ZUSCHLAG_LOHN,
      fremdleistung: env.KALK_ZUSCHLAG_FREMDLEISTUNG,
    },
  };
}

/**
 * Ergaenzt Positionen um Daten aus dem ERP-Artikelstamm.
 * Explizit in der Kalkulation angegebene Werte haben immer Vorrang.
 */
export function artikelUebernehmen(positionen, artikelMap) {
  const fehler = [];
  for (const p of positionen) {
    if (!p.artikelId) continue;
    const a = artikelMap?.get(p.artikelId);
    if (!a) {
      if (artikelMap) fehler.push(`Position ${p.nr}: Artikel "${p.artikelId}" im ERP nicht gefunden`);
      else if (p.ek === undefined && p.typ !== "lohn") {
        fehler.push(`Position ${p.nr}: ohne ERP-Verbindung wird ein ek fuer Artikel "${p.artikelId}" benoetigt`);
      }
      continue;
    }
    if (!p.name) p.name = a.name;
    if (p.ek === undefined && p.typ !== "lohn") p.ek = Number(a.purchasePrice) || 0;
    if (a.minSalePrice != null) p.mindestVk = Number(a.minSalePrice);
    if (p.preisquelle === "liste" && p.vk === undefined) p.vk = Number(a.salePrice) || 0;
  }
  return fehler;
}

/**
 * Loest Positionen mit "stueckliste" ueber das ERP auf.
 *   summe:   EK der Zeile = Materialkosten je Einheit laut Stueckliste
 *   einzeln: die Zeile wird durch ihre Komponenten ersetzt (Menge x Stueckzahl)
 * Warnungen des ERP (Zyklen, geloeschte Komponenten) werden zu Fehlern –
 * mit unvollstaendiger Stueckliste waere der Preis zu niedrig.
 *
 * @returns {Promise<{ positionen: object[], fehler: string[] }>}
 */
export async function stuecklistenAufloesen(positionen, client) {
  const fehler = [];
  if (!positionen.some((p) => p.stueckliste)) return { positionen, fehler };
  if (!client) {
    return {
      positionen,
      fehler: positionen.filter((p) => p.stueckliste).map((p) => `Position ${p.nr}: Stueckliste braucht eine ERP-Verbindung`),
    };
  }

  const cache = new Map();
  const ergebnis = [];
  for (const p of positionen) {
    if (!p.stueckliste) {
      ergebnis.push(p);
      continue;
    }
    if (!cache.has(p.artikelId)) cache.set(p.artikelId, await client.stuecklisteLaden(p.artikelId, { menge: 1 }));
    const sl = cache.get(p.artikelId);
    if (!sl) {
      fehler.push(`Position ${p.nr}: fuer Artikel "${p.artikelId}" gibt es im ERP keine aktive Stueckliste`);
      continue;
    }
    for (const w of sl.warnungen ?? []) fehler.push(`Position ${p.nr}: Stueckliste ${sl.stueckliste?.name ?? p.artikelId}: ${w}`);

    if (p.stueckliste === "summe") {
      ergebnis.push({
        ...p,
        ek: p.ek ?? sl.materialkosten,
        beschreibung: p.beschreibung || `Stückliste: ${sl.komponenten.map((k) => `${k.menge} ${k.einheit} ${k.name ?? k.artikelId}`).join(", ")}`.slice(0, 2000),
      });
    } else {
      for (const k of sl.komponenten) {
        ergebnis.push({
          nr: 0,
          typ: "material",
          artikelId: k.artikelId,
          name: k.name ?? k.artikelId,
          beschreibung: "",
          einheit: k.einheit || "Stk",
          rabatt: p.rabatt,
          vk: undefined,
          preisquelle: "kalkuliert",
          menge: Math.round(p.menge * k.menge * 100000) / 100000,
          ek: k.purchasePrice,
        });
      }
    }
  }
  ergebnis.forEach((p, i) => { p.nr = i + 1; });
  return { positionen: ergebnis, fehler };
}

function kundeAngaben(kunde) {
  if (!kunde) return {};
  if (kunde.id != null && kunde.id !== "") return { customerId: String(kunde.id) };
  return {
    customerName: kunde.name ? String(kunde.name).trim() : undefined,
    customerCity: kunde.ort ? String(kunde.ort).trim() : undefined,
  };
}

function gueltigBis(tage) {
  const n = Number(tage);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const d = new Date();
  d.setDate(d.getDate() + Math.round(n));
  return d.toISOString().slice(0, 10);
}

/**
 * Baut den Request-Body fuer POST /api/v1/belege.
 */
export function angebotPayload(daten, ergebnis, parameter) {
  const notizen = [daten.titel, daten.notizen].filter(Boolean).join("\n\n");
  return {
    ...kundeAngaben(daten.kunde),
    referenz: daten.referenz ? String(daten.referenz).slice(0, 100) : undefined,
    dueDate: gueltigBis(daten.gueltigTage),
    taxRate: parameter.steuersatz,
    gesamtrabatt: parameter.gesamtrabatt,
    notes: notizen || undefined,
    positions: ergebnis.positionen.map(zuNexusPosition),
  };
}

/**
 * Komplette Vorbereitung eines Angebots aus einer Kalkulationsdatei.
 *
 * @param {object} daten    Inhalt der Kalkulationsdatei
 * @param {object} [opts]
 * @param {import("./nexusClient.js").NexusClient} [opts.client]  ohne Client: Offline-Kalkulation
 * @param {object} [opts.envParameter]
 * @returns {Promise<{ fehler: string[], ergebnis?: object, payload?: object, parameter?: object }>}
 */
export async function angebotVorbereiten(daten, { client, envParameter } = {}) {
  if (!daten || typeof daten !== "object") return { fehler: ["Kalkulationsdatei ist leer oder kein JSON-Objekt"] };

  const { parameter, fehler: pFehler } = parameterZusammenfuehren(envParameter, daten.parameter);
  const { positionen: geprueft, fehler: posFehler } = positionenPruefen(daten.positionen);
  const fehler = [...pFehler, ...posFehler];
  if (fehler.length) return { fehler };

  const { positionen, fehler: slFehler } = await stuecklistenAufloesen(geprueft, client);
  if (slFehler.length) return { fehler: slFehler };

  const artikelIds = positionen.map((p) => p.artikelId).filter(Boolean);
  const artikelMap = client && artikelIds.length ? await client.artikelLaden(artikelIds) : null;
  fehler.push(...artikelUebernehmen(positionen, artikelMap));
  if (fehler.length) return { fehler };

  const ergebnis = kalkulieren(positionen, parameter);
  return { fehler: [], ergebnis, parameter, payload: angebotPayload(daten, ergebnis, parameter) };
}

/** Prueft, ob genug Kundenangaben fuer das Anlegen im ERP vorhanden sind. */
export function kundePruefen(daten) {
  const k = daten?.kunde;
  if (k && ((k.id != null && k.id !== "") || (k.name && String(k.name).trim()))) return null;
  return 'Zum Anlegen im ERP wird "kunde": { "id": … } oder { "name": …, "ort": … } benoetigt';
}
