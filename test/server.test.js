import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { erstelleHandler, starte } from "../src/server.js";

let zaehler = 0;
const fakeClient = {
  baseUrl: "https://erp.example.de",
  async artikelLaden() { return new Map(); },
  async kundenSuchen(q) { return [{ id: 1, name: `Kunde ${q}`, city: "Berlin" }]; },
  async artikelSuchen() { return []; },
  async angebotAnlegen(payload) { zaehler += 1; return { id: `A-2026-${String(zaehler).padStart(3, "0")}`, subtotal: 100, payload }; },
};

const server = createServer(erstelleHandler({ client: fakeClient, env: {}, erlaubteHosts: undefined }));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const basis = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

const daten = { kunde: { name: "Muster" }, positionen: [{ name: "Fliesen", menge: 2, ek: 10 }] };
const post = (pfad, body, headers = {}) =>
  fetch(basis + pfad, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("Oberflaeche wird mit Sicherheits-Headern ausgeliefert", async () => {
  const res = await fetch(basis + "/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-security-policy"), /default-src 'self'/);
  assert.match(await res.text(), /Kalkulationsbot/);
});

test("Status zeigt die ERP-Verbindung, aber nie den Key", async () => {
  const res = await fetch(basis + "/api/status");
  const json = await res.json();
  assert.deepEqual(json, { erpVerbunden: true, erpUrl: "https://erp.example.de" });
});

test("Kalkulieren liefert Ergebnis, Fehler kommen als 422", async () => {
  const ok = await (await post("/api/kalkulieren", daten)).json();
  assert.ok(ok.ergebnis.summen.netto > 0);
  const fehler = await post("/api/kalkulieren", { positionen: [] });
  assert.equal(fehler.status, 422);
});

test("Angebot anlegen + Doppelklick-Schutz", async () => {
  const erst = await post("/api/angebot", daten);
  assert.equal(erst.status, 201);
  const zweit = await post("/api/angebot", daten);
  assert.equal(zweit.status, 409);
  assert.equal(zaehler, 1);
});

test("Angebot ohne Kunde wird abgewiesen", async () => {
  const res = await post("/api/angebot", { positionen: daten.positionen });
  assert.equal(res.status, 422);
});

test("CSRF: fremde Origin und falscher Content-Type werden abgelehnt", async () => {
  assert.equal((await post("/api/angebot", daten, { Origin: "https://boese.example" })).status, 403);
  const res = await fetch(basis + "/api/kalkulieren", { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(daten) });
  assert.equal(res.status, 415);
});

test("Host-Pruefung und Passwortschutz", async () => {
  const geschuetzt = createServer(erstelleHandler({ client: null, env: { KALKBOT_PASSWORT: "geheim" }, erlaubteHosts: ["127.0.0.1:1"] }));
  await new Promise((r) => geschuetzt.listen(0, "127.0.0.1", r));
  const port = geschuetzt.address().port;
  try {
    // Host passt nicht zur Allowlist -> 421 (DNS-Rebinding)
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/status`)).status, 421);
  } finally {
    geschuetzt.close();
  }
  const mitPw = createServer(erstelleHandler({ client: null, env: { KALKBOT_PASSWORT: "geheim" } }));
  await new Promise((r) => mitPw.listen(0, "127.0.0.1", r));
  const p2 = mitPw.address().port;
  try {
    assert.equal((await fetch(`http://127.0.0.1:${p2}/api/status`)).status, 401);
    const auth = "Basic " + Buffer.from("chef:geheim").toString("base64");
    assert.equal((await fetch(`http://127.0.0.1:${p2}/api/status`, { headers: { Authorization: auth } })).status, 200);
  } finally {
    mitPw.close();
  }
});

test("Start auf oeffentlicher Adresse ohne Passwort wird verweigert", () => {
  assert.throws(() => starte({ HOST: "0.0.0.0", PORT: "0" }), /KALKBOT_PASSWORT/);
});
