import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parameterZusammenfuehren, positionenPruefen, kalkulieren, belegSummen, zuNexusPosition, round2,
} from "../src/kalkulation.js";

const P = parameterZusammenfuehren({
  lohnkostensatz: 40,
  zuschlaege: { material: 10, lohn: 50, fremdleistung: 5 },
  wagnisGewinn: 10,
  steuersatz: 19,
}).parameter;

function rechne(positionen, parameter = P) {
  const { positionen: geprueft, fehler } = positionenPruefen(positionen);
  assert.deepEqual(fehler, []);
  return kalkulieren(geprueft, parameter);
}

test("Material: EK + Gemeinkosten + Wagnis/Gewinn", () => {
  const { positionen, summen } = rechne([{ name: "Rohr", menge: 10, ek: 20 }]);
  // 20 * 1,10 = 22 Selbstkosten; * 1,10 = 24,20 VK
  assert.equal(positionen[0].selbstkosten, 22);
  assert.equal(positionen[0].vkEinheit, 24.2);
  assert.equal(summen.netto, 242);
  assert.equal(summen.mwst, 45.98);
  assert.equal(summen.brutto, 287.98);
  assert.equal(summen.deckungsbeitrag, 42);
});

test("Lohn: Stunden x Lohnkostensatz, eigener Satz je Position", () => {
  const { positionen } = rechne([
    { name: "Montage", typ: "lohn", stunden: 2 },
    { name: "Meister", typ: "lohn", stunden: 1, kostensatz: 60 },
  ]);
  assert.equal(positionen[0].einzelkosten, 40);
  assert.equal(positionen[0].vkEinheit, 66); // 40 * 1,5 * 1,1
  assert.equal(positionen[0].einheit, "h");
  assert.equal(positionen[1].vkEinheit, 99); // 60 * 1,5 * 1,1
});

test("fester VK hat Vorrang, Rabatt wirkt auf die Zeile", () => {
  const { positionen, summen, warnungen } = rechne([{ name: "Pauschale", menge: 2, ek: 50, vk: 100, rabatt: 10 }]);
  assert.equal(positionen[0].vkEinheit, 100);
  assert.equal(positionen[0].nettoZeile, 180);
  assert.equal(summen.netto, 180);
  assert.deepEqual(warnungen, []);
});

test("Warnung, wenn Rabatt die Selbstkosten unterschreitet", () => {
  const { warnungen } = rechne([{ name: "Teuer", menge: 1, ek: 100, rabatt: 20 }]);
  assert.ok(warnungen.some((w) => w.includes("deckt die Selbstkosten nicht")));
});

test("Warnung bei Mindest-VK aus dem ERP und Mindestmarge", () => {
  const { positionen: geprueft } = positionenPruefen([{ name: "X", menge: 1, ek: 10 }]);
  geprueft[0].mindestVk = 20;
  const parameter = { ...P, mindestMargeProzent: 50 };
  const { warnungen } = kalkulieren(geprueft, parameter);
  assert.ok(warnungen.some((w) => w.includes("Mindest-VK")));
  assert.ok(warnungen.some((w) => w.includes("Mindestmarge")));
});

test("Summen identisch zur ERP-Formel (belegSummen) inkl. Gesamtrabatt", () => {
  const { positionen, summen } = rechne(
    [{ name: "A", menge: 3, ek: 13.37 }, { name: "B", menge: 7, ek: 0.99, rabatt: 5 }],
    { ...P, gesamtrabatt: 3 }
  );
  const erp = belegSummen(positionen.map(zuNexusPosition), 19, 3);
  assert.equal(summen.netto, erp.netto);
  assert.equal(summen.brutto, erp.brutto);
});

test("Nexus-Position: purchasePrice = Einzelkosten, unitPrice = VK", () => {
  const { positionen } = rechne([{ artikelId: "ART-1", name: "Rohr", menge: 1, ek: 20, beschreibung: "DN 50" }]);
  assert.deepEqual(zuNexusPosition(positionen[0]), {
    articleId: "ART-1", name: "Rohr", quantity: 1, unit: "Stk", unitPrice: 24.2, purchasePrice: 20, rabatt: 0, description: "DN 50",
  });
});

test("Pruefung meldet fehlende und ungueltige Angaben", () => {
  assert.deepEqual(positionenPruefen([]).fehler, ["Die Kalkulation braucht mindestens eine Position"]);
  const { fehler } = positionenPruefen([
    { name: "ohne Menge", ek: 1 },
    { name: "ohne EK", menge: 1 },
    { typ: "maschine", name: "x", menge: 1, ek: 1 },
    { name: "Rabatt", menge: 1, ek: 1, rabatt: 120 },
    { menge: 1, ek: 1 },
  ]);
  assert.equal(fehler.length, 5);
});

test("Artikel-Position darf EK offen lassen (kommt aus dem ERP)", () => {
  assert.deepEqual(positionenPruefen([{ artikelId: "ART-1", menge: 1 }]).fehler, []);
});

test("Parameter: Bereichspruefung und Vorrang der spaeteren Quelle", () => {
  const { parameter, fehler } = parameterZusammenfuehren(
    { wagnisGewinn: "12", zuschlaege: { lohn: "70" } },
    { wagnisGewinn: 15, steuersatz: 150 }
  );
  assert.equal(parameter.wagnisGewinn, 15);
  assert.equal(parameter.zuschlaege.lohn, 70);
  assert.equal(parameter.steuersatz, 19);
  assert.equal(fehler.length, 1);
  // leere Strings (z. B. leere Formularfelder / Env) aendern nichts
  assert.equal(parameterZusammenfuehren({ lohnkostensatz: "" }).parameter.lohnkostensatz, 45);
});

test("round2 rundet auf Cent wie das ERP", () => {
  assert.equal(round2(1.234), 1.23);
  assert.equal(round2(1.236), 1.24);
  assert.equal(round2("abc"), 0);
});
