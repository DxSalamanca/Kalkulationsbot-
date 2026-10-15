// =============================================================================
// Kalkulation – Zuschlagskalkulation fuer Angebote
// -----------------------------------------------------------------------------
// Schema je Position (alle Betraege netto, je Einheit):
//
//   Einzelkosten        Material/Fremdleistung: Einkaufspreis (EK)
//                       Lohn: Stunden x Lohnkostensatz
//   + Gemeinkosten      Zuschlag in % je Kostenart (material / lohn / fremdleistung)
//   = Selbstkosten
//   + Wagnis & Gewinn   Zuschlag in % auf die Selbstkosten
//   = Verkaufspreis (VK) je Einheit, auf Cent gerundet
//
// Die Summen werden exakt wie im Nexus ERP (belegSummen) gebildet, damit die
// Vorschau hier und das spaetere Angebot im ERP centgenau uebereinstimmen.
// Reine Funktionen ohne I/O – leicht testbar.
// =============================================================================

export const KOSTENARTEN = ["material", "lohn", "fremdleistung"];
export const STUECKLISTEN_MODI = ["summe", "einzeln"];

// Beispielwerte – unbedingt an die eigene Betriebsabrechnung anpassen
// (per Kalkulationsdatei "parameter" oder Umgebungsvariablen, siehe README).
export const STANDARD_PARAMETER = Object.freeze({
  lohnkostensatz: 45,          // EUR Kosten je Arbeitsstunde (Lohn + Lohnnebenkosten)
  zuschlaege: Object.freeze({  // Gemeinkostenzuschlaege in %
    material: 15,
    lohn: 60,
    fremdleistung: 10,
  }),
  wagnisGewinn: 10,            // % auf die Selbstkosten
  steuersatz: 19,              // % MwSt
  gesamtrabatt: 0,             // % auf die Nettosumme
  mindestMargeProzent: 0,      // Warnschwelle Deckungsbeitrag in % vom VK (0 = aus)
});

// Kaufmaennisch auf zwei Nachkommastellen (Cent) runden – wie im ERP.
export function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function zahl(v, feld, fehler, { min = -Infinity, max = Infinity, pflicht = false } = {}) {
  if (v === undefined || v === null || v === "") {
    if (pflicht) fehler.push(`${feld} fehlt`);
    return undefined;
  }
  const n = Number(v);
  if (!Number.isFinite(n)) {
    fehler.push(`${feld} ist keine Zahl`);
    return undefined;
  }
  if (n < min || n > max) {
    fehler.push(`${feld} muss zwischen ${min} und ${max} liegen`);
    return undefined;
  }
  return n;
}

/**
 * Fuehrt Standardwerte, Umgebungs-Overrides und Datei-Parameter zusammen
 * und prueft die Wertebereiche.
 * @returns {{ parameter: object, fehler: string[] }}
 */
export function parameterZusammenfuehren(...quellen) {
  const fehler = [];
  const p = {
    ...STANDARD_PARAMETER,
    zuschlaege: { ...STANDARD_PARAMETER.zuschlaege },
  };
  for (const q of quellen) {
    if (!q) continue;
    for (const feld of ["lohnkostensatz", "wagnisGewinn", "steuersatz", "gesamtrabatt", "mindestMargeProzent"]) {
      const grenzen = feld === "lohnkostensatz" ? { min: 0, max: 10_000 } : { min: 0, max: 100 };
      const n = zahl(q[feld], `parameter.${feld}`, fehler, grenzen);
      if (n !== undefined) p[feld] = n;
    }
    if (q.zuschlaege) {
      for (const art of KOSTENARTEN) {
        const n = zahl(q.zuschlaege[art], `parameter.zuschlaege.${art}`, fehler, { min: 0, max: 1000 });
        if (n !== undefined) p.zuschlaege[art] = n;
      }
    }
  }
  return { parameter: p, fehler };
}

/**
 * Prueft und normalisiert die Positionen einer Kalkulation.
 * Material-Positionen mit artikelId duerfen den EK offen lassen – er kommt
 * dann aus dem ERP (siehe angebot.js).
 * @returns {{ positionen: object[], fehler: string[] }}
 */
export function positionenPruefen(roh) {
  const fehler = [];
  if (!Array.isArray(roh) || roh.length === 0) {
    return { positionen: [], fehler: ["Die Kalkulation braucht mindestens eine Position"] };
  }
  if (roh.length > 500) fehler.push("Hoechstens 500 Positionen je Angebot");

  const positionen = roh.slice(0, 500).map((p, i) => {
    const nr = `Position ${i + 1}`;
    const typ = p?.typ ?? "material";
    if (!KOSTENARTEN.includes(typ)) {
      fehler.push(`${nr}: unbekannter typ "${typ}" (erlaubt: ${KOSTENARTEN.join(", ")})`);
    }
    const pos = {
      nr: i + 1,
      typ,
      artikelId: p?.artikelId ? String(p.artikelId).trim() : null,
      name: p?.name ? String(p.name).trim().slice(0, 300) : "",
      beschreibung: p?.beschreibung ? String(p.beschreibung).trim().slice(0, 2000) : "",
      einheit: p?.einheit ? String(p.einheit).trim().slice(0, 20) : typ === "lohn" ? "h" : "Stk",
      rabatt: zahl(p?.rabatt, `${nr}: rabatt`, fehler, { min: 0, max: 100 }) ?? 0,
      vk: zahl(p?.vk, `${nr}: vk`, fehler, { min: 0 }),
      // "liste" = Verkaufspreis aus dem ERP-Artikelstamm statt kalkuliertem VK
      preisquelle: p?.preisquelle === "liste" ? "liste" : "kalkuliert",
    };
    if (typ === "lohn") {
      pos.menge = zahl(p?.stunden ?? p?.menge, `${nr}: stunden`, fehler, { min: 0, pflicht: true }) ?? 0;
      pos.kostensatz = zahl(p?.kostensatz, `${nr}: kostensatz`, fehler, { min: 0 });
    } else {
      pos.menge = zahl(p?.menge, `${nr}: menge`, fehler, { min: 0, pflicht: true }) ?? 0;
      pos.ek = zahl(p?.ek, `${nr}: ek`, fehler, { min: 0, pflicht: !pos.artikelId });
    }
    if (p?.stueckliste != null) {
      // "summe":   eine Zeile, EK = Materialkosten aus der ERP-Stueckliste
      // "einzeln": jede Komponente der Stueckliste als eigene Zeile
      if (!STUECKLISTEN_MODI.includes(p.stueckliste)) {
        fehler.push(`${nr}: stueckliste muss "summe" oder "einzeln" sein`);
      } else if (!pos.artikelId || typ !== "material") {
        fehler.push(`${nr}: stueckliste braucht eine artikelId und typ "material"`);
      } else {
        pos.stueckliste = p.stueckliste;
      }
    }
    if (!pos.name && !pos.artikelId) fehler.push(`${nr}: name oder artikelId erforderlich`);
    return pos;
  });
  return { positionen, fehler };
}

/**
 * Nettosumme, MwSt und Brutto – identisch zu belegSummen() im Nexus ERP.
 */
export function belegSummen(positionen, steuersatz, gesamtrabatt = 0) {
  const vorRabatt = positionen.reduce(
    (s, p) => s + (Number(p.quantity) || 0) * (Number(p.unitPrice) || 0) * (1 - (Number(p.rabatt) || 0) / 100),
    0
  );
  const netto = round2(vorRabatt * (1 - (Number(gesamtrabatt) || 0) / 100));
  const mwst = round2(netto * (Number(steuersatz) || 0) / 100);
  return { netto, mwst, brutto: round2(netto + mwst) };
}

/**
 * Kalkuliert alle Positionen. Erwartet geprufte Positionen (positionenPruefen)
 * mit bekanntem EK bzw. Kostensatz.
 *
 * @param {object[]} positionen
 * @param {object} parameter  aus parameterZusammenfuehren
 * @returns {{ positionen: object[], summen: object, warnungen: string[] }}
 */
export function kalkulieren(positionen, parameter) {
  const warnungen = [];

  const ergebnis = positionen.map((p) => {
    const einzelkosten = p.typ === "lohn" ? (p.kostensatz ?? parameter.lohnkostensatz) : (p.ek ?? 0);
    const gkProzent = parameter.zuschlaege[p.typ] ?? 0;
    const gemeinkosten = einzelkosten * gkProzent / 100;
    const selbstkosten = einzelkosten + gemeinkosten;
    const wagnisGewinn = selbstkosten * parameter.wagnisGewinn / 100;
    const kalkulierterVk = round2(selbstkosten + wagnisGewinn);
    // Fester VK (z. B. Listenpreis) hat Vorrang vor dem kalkulierten Preis.
    const vkEinheit = p.vk != null ? round2(p.vk) : kalkulierterVk;

    const nettoZeile = round2(p.menge * vkEinheit * (1 - p.rabatt / 100));
    const kostenZeile = round2(p.menge * selbstkosten);
    const db = round2(nettoZeile - round2(p.menge * einzelkosten));

    if (p.mindestVk != null && vkEinheit * (1 - p.rabatt / 100) < p.mindestVk) {
      warnungen.push(
        `Position ${p.nr} (${p.name}): VK ${vkEinheit.toFixed(2)} EUR nach Rabatt liegt unter dem Mindest-VK ${p.mindestVk.toFixed(2)} EUR aus dem ERP`
      );
    }
    if (nettoZeile < kostenZeile) {
      warnungen.push(`Position ${p.nr} (${p.name}): Verkaufspreis deckt die Selbstkosten nicht`);
    }
    if (einzelkosten === 0 && p.vk == null) {
      warnungen.push(`Position ${p.nr} (${p.name}): Einzelkosten sind 0 – Preis wird 0,00 EUR`);
    }

    return {
      ...p,
      einzelkosten: round2(einzelkosten),
      gemeinkosten: round2(gemeinkosten),
      selbstkosten: round2(selbstkosten),
      wagnisGewinn: round2(wagnisGewinn),
      kalkulierterVk,
      vkEinheit,
      nettoZeile,
      deckungsbeitrag: db,
    };
  });

  const nexusPositionen = ergebnis.map(zuNexusPosition);
  const { netto, mwst, brutto } = belegSummen(nexusPositionen, parameter.steuersatz, parameter.gesamtrabatt);
  const einzelkosten = round2(ergebnis.reduce((s, p) => s + p.menge * p.einzelkosten, 0));
  const selbstkosten = round2(ergebnis.reduce((s, p) => s + p.menge * p.selbstkosten, 0));
  const deckungsbeitrag = round2(netto - einzelkosten);
  const margeProzent = netto > 0 ? round2((deckungsbeitrag / netto) * 100) : 0;

  if (netto < selbstkosten) {
    warnungen.push(`Gesamt: Nettosumme ${netto.toFixed(2)} EUR liegt unter den Selbstkosten ${selbstkosten.toFixed(2)} EUR`);
  }
  if (parameter.mindestMargeProzent > 0 && margeProzent < parameter.mindestMargeProzent) {
    warnungen.push(`Gesamt: Deckungsbeitrag ${margeProzent} % liegt unter der Mindestmarge ${parameter.mindestMargeProzent} %`);
  }

  return {
    positionen: ergebnis,
    summen: {
      einzelkosten,
      selbstkosten,
      netto,
      steuersatz: parameter.steuersatz,
      mwst,
      brutto,
      deckungsbeitrag,
      margeProzent,
    },
    warnungen,
  };
}

/**
 * Wandelt eine kalkulierte Position in das Positionsformat des Nexus ERP
 * (POST /api/v1/belege). purchasePrice = Einzelkosten, damit die
 * Deckungsbeitragsauswertung im ERP stimmt.
 */
export function zuNexusPosition(p) {
  const pos = {
    articleId: p.artikelId ?? "",
    name: p.name,
    quantity: p.menge,
    unit: p.einheit,
    unitPrice: p.vkEinheit,
    purchasePrice: p.einzelkosten,
    rabatt: p.rabatt,
  };
  if (p.beschreibung) pos.description = p.beschreibung;
  return pos;
}
