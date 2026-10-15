import { test } from "node:test";
import assert from "node:assert/strict";
import { NexusClient, NexusFehler, pruefeVerbindungsdaten } from "../src/nexusClient.js";
import { angebotVorbereiten, kundePruefen, parameterAusUmgebung } from "../src/angebot.js";

// Fake-ERP: beantwortet die drei v1-Endpunkte und protokolliert Aufrufe.
function fakeErp({ artikel = [], antworten = {} } = {}) {
  const aufrufe = [];
  const fetch = async (url, opts) => {
    const u = new URL(url);
    aufrufe.push({ methode: opts.method, pfad: u.pathname, query: Object.fromEntries(u.searchParams), body: opts.body ? JSON.parse(opts.body) : null, headers: opts.headers });
    const vorgabe = antworten[`${opts.method} ${u.pathname}`];
    if (vorgabe) {
      const v = typeof vorgabe === "function" ? vorgabe(aufrufe.length) : vorgabe;
      return new Response(JSON.stringify(v.body ?? {}), { status: v.status, headers: v.headers });
    }
    if (u.pathname === "/api/v1/artikel") {
      const ids = (u.searchParams.get("id") || "").split(",").filter(Boolean);
      return Response.json({ data: artikel.filter((a) => ids.includes(a.id)) });
    }
    if (u.pathname === "/api/v1/belege" && opts.method === "POST") {
      const b = JSON.parse(opts.body);
      const subtotal = b.positions.reduce((s, p) => s + p.quantity * p.unitPrice * (1 - p.rabatt / 100), 0);
      return Response.json({ id: "A-2026-042", type: b.type, status: "entwurf", subtotal: Math.round(subtotal * 100) / 100 }, { status: 201 });
    }
    return new Response("{}", { status: 404 });
  };
  return { fetch, aufrufe };
}

const client = (erp, extra = {}) =>
  new NexusClient({ baseUrl: "https://erp.example.de/", apiKey: "nxk_test", fetch: erp.fetch, wiederholungen: 1, ...extra });

test("Verbindungsdaten: https Pflicht, http nur fuer localhost, Key-Format", () => {
  assert.equal(pruefeVerbindungsdaten("https://erp.example.de/", "nxk_a"), "https://erp.example.de");
  assert.equal(pruefeVerbindungsdaten("http://localhost:2026", "nxs_a"), "http://localhost:2026");
  assert.throws(() => pruefeVerbindungsdaten("http://erp.example.de", "nxk_a"), /https/);
  assert.throws(() => pruefeVerbindungsdaten("https://erp.example.de", "geheim"), /Format/);
  assert.throws(() => pruefeVerbindungsdaten("", "nxk_a"), /NEXUS_URL/);
});

test("EK, Name und Mindest-VK kommen aus dem ERP; eigene Angaben haben Vorrang", async () => {
  const erp = fakeErp({
    artikel: [
      { id: "ART-1", name: "Rohr DN50", purchasePrice: 20, salePrice: 30, minSalePrice: 25 },
      { id: "ART-2", name: "Muffe", purchasePrice: 2, salePrice: 5, minSalePrice: null },
    ],
  });
  const { fehler, ergebnis, payload } = await angebotVorbereiten({
    kunde: { id: 7 },
    parameter: { zuschlaege: { material: 0 }, wagnisGewinn: 0 },
    positionen: [
      { artikelId: "ART-1", menge: 2 },
      { artikelId: "ART-2", menge: 10, ek: 3, name: "Muffe verzinkt" },
      { artikelId: "ART-2", menge: 1, preisquelle: "liste" },
    ],
  }, { client: client(erp) });

  assert.deepEqual(fehler, []);
  const [a, b, c] = ergebnis.positionen;
  assert.equal(a.name, "Rohr DN50");
  assert.equal(a.einzelkosten, 20);
  assert.equal(b.einzelkosten, 3);
  assert.equal(b.name, "Muffe verzinkt");
  assert.equal(c.vkEinheit, 5);
  // VK 20 < Mindest-VK 25 -> Warnung
  assert.ok(ergebnis.warnungen.some((w) => w.includes("Mindest-VK")));
  assert.equal(payload.customerId, "7");
  // ein einziger Artikelabruf fuer alle IDs
  assert.equal(erp.aufrufe.length, 1);
  assert.equal(erp.aufrufe[0].query.id, "ART-1,ART-2");
  assert.equal(erp.aufrufe[0].headers.Authorization, "Bearer nxk_test");
});

test("unbekannter Artikel wird gemeldet", async () => {
  const { fehler } = await angebotVorbereiten({ positionen: [{ artikelId: "GIBTS-NICHT", menge: 1 }] }, { client: client(fakeErp()) });
  assert.match(fehler[0], /nicht gefunden/);
});

test("offline: Artikel ohne EK wird gemeldet", async () => {
  const { fehler } = await angebotVorbereiten({ positionen: [{ artikelId: "ART-1", menge: 1 }] });
  assert.match(fehler[0], /ohne ERP-Verbindung/);
});

test("Angebot anlegen: type=angebot, Payload mit Kunde, Gueltigkeit und Notizen", async () => {
  const erp = fakeErp();
  const daten = {
    titel: "Bad EG", notizen: "Nur Q4", referenz: "Anfrage 1", gueltigTage: 30,
    kunde: { name: "Muster GmbH", ort: "Berlin" },
    positionen: [{ name: "Fliesen", menge: 10, ek: 10 }],
  };
  const { payload, ergebnis } = await angebotVorbereiten(daten, { client: client(erp) });
  const angebot = await client(erp).angebotAnlegen(payload);

  assert.equal(angebot.id, "A-2026-042");
  assert.equal(angebot.subtotal, ergebnis.summen.netto);
  const body = erp.aufrufe.at(-1).body;
  assert.equal(body.type, "angebot");
  assert.equal(body.customerName, "Muster GmbH");
  assert.equal(body.customerCity, "Berlin");
  assert.equal(body.notes, "Bad EG\n\nNur Q4");
  assert.match(body.dueDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(body.id, undefined);
  assert.equal(body.status, undefined);
});

test("Kundenpruefung vor dem Senden", () => {
  assert.equal(kundePruefen({ kunde: { id: 3 } }), null);
  assert.equal(kundePruefen({ kunde: { name: "A" } }), null);
  assert.match(kundePruefen({}), /kunde/);
  assert.match(kundePruefen({ kunde: { name: "  " } }), /kunde/);
});

test("Fehlermeldungen des ERP werden verstaendlich uebersetzt", async () => {
  const erp = fakeErp({ antworten: { "GET /api/v1/kunden": { status: 403, body: { error: "Scope 'kunden:read' fehlt" } } } });
  await assert.rejects(client(erp).kundenSuchen("x"), (e) => {
    assert.ok(e instanceof NexusFehler);
    assert.equal(e.status, 403);
    assert.match(e.message, /Scope 'kunden:read' fehlt/);
    return true;
  });
});

test("GET wird bei 429 wiederholt, POST nie (keine Doppelanlage)", async () => {
  const erp = fakeErp({
    antworten: {
      "GET /api/v1/kunden": (n) => (n === 1 ? { status: 429, headers: { "retry-after": "0" } } : { status: 200, body: { data: [{ id: 1 }] } }),
      "POST /api/v1/belege": { status: 503, body: { error: "not_configured" } },
    },
  });
  assert.deepEqual(await client(erp).kundenSuchen("x"), [{ id: 1 }]);
  await assert.rejects(client(erp).angebotAnlegen({ positions: [] }), /nicht konfiguriert/);
  assert.equal(erp.aufrufe.filter((a) => a.methode === "POST").length, 1);
});

test("Parameter aus Umgebungsvariablen", () => {
  const p = parameterAusUmgebung({ KALK_LOHNKOSTENSATZ: "52", KALK_ZUSCHLAG_LOHN: "55" });
  assert.equal(p.lohnkostensatz, "52");
  assert.equal(p.zuschlaege.lohn, "55");
  assert.equal(p.zuschlaege.material, undefined);
});

// --- Stuecklisten -----------------------------------------------------------

const TISCH = {
  artikelId: "TISCH", menge: 1, rekursiv: true,
  stueckliste: { id: 1, name: "Tisch komplett" },
  komponenten: [
    { artikelId: "PLATTE", name: "Tischplatte", menge: 1, einheit: "Stk", purchasePrice: 80 },
    { artikelId: "BEIN", name: "Tischbein", menge: 4, einheit: "Stk", purchasePrice: 12.5 },
  ],
  materialkosten: 130,
  warnungen: [],
};

function erpMitStueckliste(stueckliste = TISCH) {
  return fakeErp({
    artikel: [
      { id: "TISCH", name: "Esstisch Eiche", purchasePrice: 0, salePrice: 499, minSalePrice: 150 },
      { id: "PLATTE", name: "Tischplatte", purchasePrice: 80, salePrice: 0, minSalePrice: null },
      { id: "BEIN", name: "Tischbein", purchasePrice: 12.5, salePrice: 0, minSalePrice: null },
    ],
    antworten: {
      "GET /api/v1/stuecklisten": () => (stueckliste ? { status: 200, body: stueckliste } : { status: 404, body: { error: "keine" } }),
    },
  });
}

const OHNE_ZUSCHLAG = { zuschlaege: { material: 0 }, wagnisGewinn: 0 };

test("Stueckliste als Summe: eine Zeile, EK = Materialkosten, Name aus dem ERP", async () => {
  const erp = erpMitStueckliste();
  const { fehler, ergebnis } = await angebotVorbereiten({
    parameter: OHNE_ZUSCHLAG,
    positionen: [{ artikelId: "TISCH", menge: 2, stueckliste: "summe" }, { name: "Montage", typ: "lohn", stunden: 1 }],
  }, { client: client(erp) });

  assert.deepEqual(fehler, []);
  const [tisch, lohn] = ergebnis.positionen;
  assert.equal(tisch.name, "Esstisch Eiche");
  assert.equal(tisch.einzelkosten, 130);
  assert.equal(tisch.nettoZeile, 260);
  assert.match(tisch.beschreibung, /4 Stk Tischbein/);
  assert.equal(lohn.nr, 2);
  // Mindest-VK 150 des Erzeugnisses wird geprueft (VK 130 < 150)
  assert.ok(ergebnis.warnungen.some((w) => w.includes("Mindest-VK")));
  const sl = erp.aufrufe.find((a) => a.pfad === "/api/v1/stuecklisten");
  assert.deepEqual(sl.query, { artikelId: "TISCH", menge: "1", rekursiv: "true" });
});

test("Stueckliste einzeln: Komponenten werden eigene Zeilen (Menge x Stueckzahl)", async () => {
  const { fehler, ergebnis } = await angebotVorbereiten({
    parameter: OHNE_ZUSCHLAG,
    positionen: [{ artikelId: "TISCH", menge: 3, stueckliste: "einzeln", rabatt: 5 }],
  }, { client: client(erpMitStueckliste()) });

  assert.deepEqual(fehler, []);
  assert.deepEqual(
    ergebnis.positionen.map((p) => [p.nr, p.artikelId, p.menge, p.einzelkosten, p.rabatt]),
    [[1, "PLATTE", 3, 80, 5], [2, "BEIN", 12, 12.5, 5]]
  );
});

test("Stueckliste: fehlende Stueckliste, ERP-Warnungen und Offline-Betrieb sind Fehler", async () => {
  const ohne = await angebotVorbereiten({ positionen: [{ artikelId: "TISCH", menge: 1, stueckliste: "summe" }] },
    { client: client(erpMitStueckliste(null)) });
  assert.match(ohne.fehler[0], /keine aktive Stueckliste/);

  const zyklus = await angebotVorbereiten({ positionen: [{ artikelId: "TISCH", menge: 1, stueckliste: "summe" }] },
    { client: client(erpMitStueckliste({ ...TISCH, warnungen: ["Zyklus in der Stueckliste: BEIN"] })) });
  assert.match(zyklus.fehler[0], /Zyklus/);

  const offline = await angebotVorbereiten({ positionen: [{ artikelId: "TISCH", menge: 1, stueckliste: "summe" }] });
  assert.match(offline.fehler[0], /ERP-Verbindung/);
});

test("Stueckliste: ungueltiger Modus oder ohne artikelId wird abgewiesen", async () => {
  const { fehler } = await angebotVorbereiten({
    positionen: [
      { artikelId: "TISCH", menge: 1, stueckliste: "alles" },
      { name: "X", menge: 1, ek: 1, stueckliste: "summe" },
    ],
  });
  assert.equal(fehler.length, 2);
});
