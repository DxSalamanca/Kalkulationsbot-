// =============================================================================
// Nexus ERP – Client fuer die Public API v1
// -----------------------------------------------------------------------------
// Authentifizierung per API-Key (Bearer nxk_…). Benoetigte Scopes:
//   artikel:read  – Einkaufs-/Verkaufspreise lesen
//   kunden:read   – Kunden suchen
//   belege:write  – Angebot als Entwurf anlegen
//
// Der Key bleibt immer serverseitig (CLI bzw. lokaler Server) und wird nie an
// einen Browser ausgeliefert.
// =============================================================================

export class NexusFehler extends Error {
  constructor(message, { status = 0, details = null } = {}) {
    super(message);
    this.name = "NexusFehler";
    this.status = status;
    this.details = details;
  }
}

const MELDUNGEN = {
  401: "API-Key ungueltig, abgelaufen oder deaktiviert (Nexus: Einstellungen > API-Keys)",
  403: "Zugriff verweigert – fehlender Scope oder IP nicht auf der Allowlist des Keys",
  404: "Endpunkt nicht gefunden – ist NEXUS_URL richtig und die ERP-Version aktuell?",
  422: "Daten vom ERP abgelehnt",
  429: "Rate-Limit des ERP erreicht – bitte kurz warten",
  503: "ERP ist nicht konfiguriert oder voruebergehend nicht erreichbar",
};

function istLokal(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

/**
 * Prueft Basis-URL und Key. Unverschluesseltes HTTP ist nur fuer localhost
 * erlaubt – sonst ginge der API-Key im Klartext uebers Netz.
 */
export function pruefeVerbindungsdaten(baseUrl, apiKey) {
  if (!baseUrl) throw new NexusFehler("NEXUS_URL ist nicht gesetzt");
  if (!apiKey) throw new NexusFehler("NEXUS_API_KEY ist nicht gesetzt");
  if (!/^nx[ks]_/.test(apiKey)) throw new NexusFehler("NEXUS_API_KEY hat kein gueltiges Format (nxk_…)");
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new NexusFehler(`NEXUS_URL ist keine gueltige URL: ${baseUrl}`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && istLokal(url.hostname))) {
    throw new NexusFehler("NEXUS_URL muss https:// verwenden (http nur fuer localhost)");
  }
  return url.origin + url.pathname.replace(/\/+$/, "");
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export class NexusClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl   z. B. https://erp.firma.de
   * @param {string} opts.apiKey    nxk_…
   * @param {Function} [opts.fetch] fuer Tests austauschbar
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.wiederholungen]  Retries bei 429/5xx/Netzfehler
   */
  constructor({ baseUrl, apiKey, fetch: fetchFn = globalThis.fetch, timeoutMs = 15_000, wiederholungen = 2 } = {}) {
    this.baseUrl = pruefeVerbindungsdaten(baseUrl, apiKey);
    this.apiKey = apiKey;
    this.fetch = fetchFn;
    this.timeoutMs = timeoutMs;
    this.wiederholungen = wiederholungen;
  }

  async #anfrage(methode, pfad, { query, body } = {}) {
    const url = new URL(`${this.baseUrl}/api/v1${pfad}`);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }

    // POST wird nicht automatisch wiederholt: bei einem Timeout weiss man
    // nicht, ob das Angebot schon angelegt wurde (sonst Doppelanlage).
    const maxVersuche = methode === "GET" ? this.wiederholungen + 1 : 1;
    let letzterFehler;

    for (let versuch = 1; versuch <= maxVersuche; versuch++) {
      let res;
      try {
        res = await this.fetch(url, {
          method: methode,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            Accept: "application/json",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        letzterFehler = new NexusFehler(`ERP nicht erreichbar (${e.name === "TimeoutError" ? "Zeitueberschreitung" : e.message})`);
        if (versuch < maxVersuche) { await pause(500 * 2 ** (versuch - 1)); continue; }
        throw letzterFehler;
      }

      const text = await res.text();
      let daten = null;
      try { daten = text ? JSON.parse(text) : null; } catch { daten = null; }

      if (res.ok) return daten;

      const grund = daten?.error ? `: ${daten.error}` : "";
      letzterFehler = new NexusFehler(`${MELDUNGEN[res.status] ?? `ERP-Fehler ${res.status}`}${grund}`, {
        status: res.status,
        details: daten,
      });
      const wiederholbar = res.status === 429 || res.status >= 500;
      if (wiederholbar && versuch < maxVersuche) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await pause(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 500 * 2 ** (versuch - 1));
        continue;
      }
      throw letzterFehler;
    }
    throw letzterFehler;
  }

  /** Artikel nach Artikelnummern laden (Map id -> Artikel). */
  async artikelLaden(ids) {
    const eindeutig = [...new Set(ids.filter(Boolean))];
    const map = new Map();
    // Die API liefert hoechstens 100 Datensaetze je Seite.
    for (let i = 0; i < eindeutig.length; i += 100) {
      const teil = eindeutig.slice(i, i + 100);
      const antwort = await this.#anfrage("GET", "/artikel", { query: { id: teil.join(","), limit: 100 } });
      for (const a of antwort?.data ?? []) map.set(String(a.id), a);
    }
    return map;
  }

  /** Artikel per Freitext suchen. */
  async artikelSuchen(q, limit = 20) {
    const antwort = await this.#anfrage("GET", "/artikel", { query: { q, limit } });
    return antwort?.data ?? [];
  }

  /**
   * Stueckliste eines Erzeugnisses mit Einkaufspreisen der Komponenten.
   * Liefert null, wenn der Artikel keine aktive Stueckliste hat.
   * @param {string} artikelId
   * @param {{ menge?: number, rekursiv?: boolean }} [opts]
   */
  async stuecklisteLaden(artikelId, { menge = 1, rekursiv = true } = {}) {
    try {
      return await this.#anfrage("GET", "/stuecklisten", { query: { artikelId, menge, rekursiv } });
    } catch (e) {
      if (e instanceof NexusFehler && e.status === 404) return null;
      throw e;
    }
  }

  /** Aktive Stuecklisten auflisten. */
  async stuecklistenListe(limit = 100) {
    const antwort = await this.#anfrage("GET", "/stuecklisten", { query: { limit } });
    return antwort?.data ?? [];
  }

  /** Kunden per Freitext suchen. */
  async kundenSuchen(q, limit = 20) {
    const antwort = await this.#anfrage("GET", "/kunden", { query: { q, limit } });
    return antwort?.data ?? [];
  }

  /** Angebot als Entwurf anlegen. Liefert den Beleg inkl. Angebotsnummer (id). */
  async angebotAnlegen(payload) {
    return this.#anfrage("POST", "/belege", { body: { ...payload, type: "angebot" } });
  }
}
