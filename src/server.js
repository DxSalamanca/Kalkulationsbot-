// =============================================================================
// Kalkulationsbot – lokaler Web-Server
// -----------------------------------------------------------------------------
// Liefert die Oberflaeche (public/) und eine kleine JSON-API. Der Nexus-API-Key
// bleibt hier auf dem Server; der Browser sieht ihn nie.
//
// Sicherheit:
//   - lauscht standardmaessig nur auf 127.0.0.1
//   - auf anderen Adressen nur mit KALKBOT_PASSWORT (HTTP Basic Auth)
//   - Host-Pruefung gegen DNS-Rebinding, Origin-Pruefung gegen CSRF
//   - strikte Content-Security-Policy, Body-Limit 256 KB
//   - Doppelklick-Schutz: identisches Angebot wird 2 Minuten nicht erneut angelegt
// =============================================================================

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { NexusClient, NexusFehler } from "./nexusClient.js";
import { angebotVorbereiten, kundePruefen, parameterAusUmgebung } from "./angebot.js";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const DATEIEN = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/app.css": ["app.css", "text/css; charset=utf-8"],
};
const MAX_BODY = 256 * 1024;
const DOPPEL_SPERRE_MS = 2 * 60_000;

const SICHERHEITS_HEADER = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
};

function istLokal(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function sendeJson(res, status, daten) {
  res.writeHead(status, { ...SICHERHEITS_HEADER, "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(daten));
}

function gleich(a, b) {
  const x = createHash("sha256").update(String(a)).digest();
  const y = createHash("sha256").update(String(b)).digest();
  return timingSafeEqual(x, y);
}

async function liesJson(req) {
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) {
    throw Object.assign(new Error("Content-Type muss application/json sein"), { status: 415 });
  }
  let groesse = 0;
  const teile = [];
  for await (const teil of req) {
    groesse += teil.length;
    if (groesse > MAX_BODY) throw Object.assign(new Error("Anfrage zu gross"), { status: 413 });
    teile.push(teil);
  }
  try {
    return JSON.parse(Buffer.concat(teile).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Ungueltiges JSON"), { status: 400 });
  }
}

/**
 * Erzeugt den Request-Handler. Fuer Tests mit eigenem Client/Env aufrufbar.
 * @param {object} opts
 * @param {NexusClient|null} opts.client
 * @param {object} opts.env
 * @param {string[]} opts.erlaubteHosts  Host-Header-Werte (inkl. Port)
 */
export function erstelleHandler({ client, env = process.env, erlaubteHosts }) {
  const passwort = env.KALKBOT_PASSWORT || "";
  const zuletztAngelegt = new Map(); // payload-hash -> { zeit, angebot }

  return async function handler(req, res) {
    try {
      // DNS-Rebinding: nur bekannte Host-Header akzeptieren.
      if (erlaubteHosts && !erlaubteHosts.includes(req.headers.host)) {
        return sendeJson(res, 421, { error: "Unbekannter Host" });
      }
      if (passwort) {
        const [art, wert] = String(req.headers.authorization || "").split(" ");
        const [, pw = ""] = art === "Basic" && wert ? Buffer.from(wert, "base64").toString("utf8").split(/:(.*)/s) : [];
        if (!gleich(pw, passwort)) {
          res.writeHead(401, { ...SICHERHEITS_HEADER, "WWW-Authenticate": 'Basic realm="Kalkulationsbot", charset="UTF-8"' });
          return res.end();
        }
      }

      const url = new URL(req.url, "http://localhost");

      if (req.method === "GET" && DATEIEN[url.pathname]) {
        const [datei, typ] = DATEIEN[url.pathname];
        const inhalt = await readFile(path.join(PUBLIC, datei));
        res.writeHead(200, { ...SICHERHEITS_HEADER, "Content-Type": typ });
        return res.end(inhalt);
      }

      if (!url.pathname.startsWith("/api/")) return sendeJson(res, 404, { error: "Nicht gefunden" });

      // CSRF: schreibende Aufrufe nur von der eigenen Oberflaeche.
      if (req.method === "POST") {
        const origin = req.headers.origin;
        let originHost = null;
        try { originHost = origin ? new URL(origin).host : null; } catch { originHost = "ungueltig"; }
        if (origin && originHost !== req.headers.host) {
          return sendeJson(res, 403, { error: "Fremde Herkunft abgelehnt" });
        }
      }

      if (req.method === "GET" && url.pathname === "/api/status") {
        return sendeJson(res, 200, { erpVerbunden: Boolean(client), erpUrl: client?.baseUrl ?? null });
      }

      if (req.method === "GET" && (url.pathname === "/api/kunden" || url.pathname === "/api/artikel")) {
        if (!client) return sendeJson(res, 503, { error: "Keine ERP-Verbindung konfiguriert" });
        const q = (url.searchParams.get("q") || "").slice(0, 100);
        const daten = url.pathname === "/api/kunden" ? await client.kundenSuchen(q) : await client.artikelSuchen(q);
        return sendeJson(res, 200, { data: daten });
      }

      if (req.method === "POST" && (url.pathname === "/api/kalkulieren" || url.pathname === "/api/angebot")) {
        const daten = await liesJson(req);
        const anlegen = url.pathname === "/api/angebot";
        if (anlegen && !client) return sendeJson(res, 503, { error: "Keine ERP-Verbindung konfiguriert" });

        const vorbereitet = await angebotVorbereiten(daten, { client, envParameter: parameterAusUmgebung(env) });
        if (vorbereitet.fehler.length) return sendeJson(res, 422, { fehler: vorbereitet.fehler });
        if (!anlegen) return sendeJson(res, 200, { ergebnis: vorbereitet.ergebnis, payload: vorbereitet.payload });

        const kundeFehler = kundePruefen(daten);
        if (kundeFehler) return sendeJson(res, 422, { fehler: [kundeFehler] });

        const schluessel = createHash("sha256").update(JSON.stringify(vorbereitet.payload)).digest("hex");
        const jetzt = Date.now();
        for (const [k, v] of zuletztAngelegt) if (jetzt - v.zeit > DOPPEL_SPERRE_MS) zuletztAngelegt.delete(k);
        const vorher = zuletztAngelegt.get(schluessel);
        if (vorher) return sendeJson(res, 409, { error: `Dieses Angebot wurde gerade schon als ${vorher.angebot.id} angelegt`, angebot: vorher.angebot });

        const angebot = await client.angebotAnlegen(vorbereitet.payload);
        zuletztAngelegt.set(schluessel, { zeit: jetzt, angebot });
        return sendeJson(res, 201, { ergebnis: vorbereitet.ergebnis, angebot });
      }

      return sendeJson(res, 404, { error: "Nicht gefunden" });
    } catch (e) {
      if (e instanceof NexusFehler) return sendeJson(res, 502, { error: `Nexus ERP: ${e.message}` });
      if (e.status) return sendeJson(res, e.status, { error: e.message });
      console.error(e);
      return sendeJson(res, 500, { error: "Interner Fehler" });
    }
  };
}

export function starte(env = process.env) {
  const host = env.HOST || "127.0.0.1";
  const port = Number(env.PORT || 3210);
  if (!istLokal(host) && !env.KALKBOT_PASSWORT) {
    throw new Error(`HOST=${host} ist von aussen erreichbar – bitte KALKBOT_PASSWORT setzen.`);
  }

  let client = null;
  if (env.NEXUS_URL || env.NEXUS_API_KEY) {
    client = new NexusClient({ baseUrl: env.NEXUS_URL, apiKey: env.NEXUS_API_KEY });
  } else {
    console.warn("NEXUS_URL/NEXUS_API_KEY nicht gesetzt – nur Offline-Kalkulation moeglich.");
  }

  const erlaubteHosts = istLokal(host)
    ? [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]
    : (env.KALKBOT_HOSTS ? env.KALKBOT_HOSTS.split(",").map((h) => h.trim()) : undefined);

  const server = createServer(erstelleHandler({ client, env, erlaubteHosts }));
  server.listen(port, host, () => {
    console.log(`Kalkulationsbot laeuft auf http://${host === "::1" ? "[::1]" : host}:${port}`);
  });
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  try { process.loadEnvFile?.(); } catch { /* keine .env vorhanden */ }
  try {
    starte();
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
