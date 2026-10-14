// Oberflaeche des Kalkulationsbots. Alle ERP-Daten werden per textContent
// eingefuegt (nie innerHTML), damit Kunden-/Artikelnamen kein HTML ausfuehren.

const $ = (id) => document.getElementById(id);
const eur = (n) => Number(n).toLocaleString("de-DE", { style: "currency", currency: "EUR" });

let kundeId = null;
let kundenTreffer = new Map();
let erpVerbunden = false;
let letzteDaten = null;

function el(tag, attrs = {}, ...kinder) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "list") e.setAttribute("list", v); // input.list ist nur lesbar
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  for (const k of kinder) e.append(k);
  return e;
}

function entprellt(fn, ms = 250) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

async function api(pfad, opts = {}) {
  const res = await fetch(pfad, {
    ...opts,
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
  });
  const daten = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, daten };
}

// --- Positionen -------------------------------------------------------------

function neueZeile(typ, werte = {}) {
  const lohn = typ === "lohn";
  const tr = el("tr", { "data-typ": typ });
  const feld = (name, attrs = {}) => el("td", {}, el("input", { name, value: werte[name] ?? "", ...attrs }));
  tr.append(
    el("td", {}, el("span", { class: `typ typ-${typ}` }, { material: "Material", lohn: "Lohn", fremdleistung: "Fremdl." }[typ])),
    feld("artikelId", { list: "artikelListe", disabled: lohn, placeholder: lohn ? "–" : "" }),
    feld("name"),
    feld("menge", { type: "number", step: "0.01", min: "0" }),
    feld("einheit", { placeholder: lohn ? "h" : "Stk" }),
    feld("ek", { type: "number", step: "0.01", min: "0", disabled: lohn, placeholder: lohn ? "–" : "" }),
    feld("vk", { type: "number", step: "0.01", min: "0" }),
    feld("rabatt", { type: "number", step: "0.1", min: "0", max: "100" }),
    el("td", {}, el("button", { type: "button", class: "entfernen", title: "Position entfernen", textContent: "×", onclick: () => { tr.remove(); ungueltig(); } }))
  );
  tr.addEventListener("input", ungueltig);
  $("positionen").tBodies[0].append(tr);
}

function zahlOderLeer(v) {
  return v === "" || v == null ? undefined : Number(v);
}

function sammeleDaten() {
  const positionen = [...$("positionen").tBodies[0].rows].map((tr) => {
    const w = Object.fromEntries([...tr.querySelectorAll("input")].map((i) => [i.name, i.value.trim()]));
    const typ = tr.dataset.typ;
    const p = { typ, name: w.name || undefined, einheit: w.einheit || undefined };
    if (typ === "lohn") p.stunden = zahlOderLeer(w.menge);
    else {
      p.menge = zahlOderLeer(w.menge);
      p.ek = zahlOderLeer(w.ek);
      if (w.artikelId) p.artikelId = w.artikelId;
    }
    p.vk = zahlOderLeer(w.vk);
    p.rabatt = zahlOderLeer(w.rabatt);
    return p;
  });

  const parameter = {
    lohnkostensatz: zahlOderLeer($("lohnkostensatz").value),
    wagnisGewinn: zahlOderLeer($("wagnisGewinn").value),
    steuersatz: zahlOderLeer($("steuersatz").value),
    zuschlaege: {
      material: zahlOderLeer($("zMaterial").value),
      lohn: zahlOderLeer($("zLohn").value),
      fremdleistung: zahlOderLeer($("zFremd").value),
    },
  };

  const kunde = kundeId != null
    ? { id: kundeId }
    : $("kundeName").value.trim() ? { name: $("kundeName").value.trim(), ort: $("kundeOrt").value.trim() } : undefined;

  return {
    titel: $("titel").value.trim() || undefined,
    referenz: $("referenz").value.trim() || undefined,
    gueltigTage: zahlOderLeer($("gueltigTage").value),
    kunde,
    parameter,
    positionen,
  };
}

// --- Ausgabe ----------------------------------------------------------------

function meldung(text, art = "info") {
  $("meldungen").replaceChildren(...[].concat(text).map((t) => el("p", { class: `meldung ${art}`, textContent: t })));
}

function ungueltig() {
  $("senden").disabled = true;
  letzteDaten = null;
}

function zeigeErgebnis(ergebnis) {
  const kopf = ["#", "Bezeichnung", "Menge", "Einzelkosten", "Selbstkosten", "VK/Einheit", "Netto", "DB"];
  const tabelle = el("table", { class: "ergebnis" },
    el("thead", {}, el("tr", {}, ...kopf.map((k) => el("th", { textContent: k })))),
    el("tbody", {}, ...ergebnis.positionen.map((p) => el("tr", {},
      el("td", { textContent: p.nr }),
      el("td", { textContent: p.name }),
      el("td", { textContent: `${p.menge} ${p.einheit}` }),
      el("td", { textContent: eur(p.einzelkosten) }),
      el("td", { textContent: eur(p.selbstkosten) }),
      el("td", { textContent: eur(p.vkEinheit) }),
      el("td", { textContent: eur(p.nettoZeile) }),
      el("td", { textContent: eur(p.deckungsbeitrag) }),
    )))
  );
  const s = ergebnis.summen;
  const summen = el("dl", { class: "summen" },
    ...[
      ["Einzelkosten", eur(s.einzelkosten)],
      ["Selbstkosten", eur(s.selbstkosten)],
      ["Netto", eur(s.netto)],
      [`MwSt ${s.steuersatz} %`, eur(s.mwst)],
      ["Brutto", eur(s.brutto)],
      ["Deckungsbeitrag", `${eur(s.deckungsbeitrag)} (${s.margeProzent.toLocaleString("de-DE")} %)`],
    ].flatMap(([k, v]) => [el("dt", { textContent: k }), el("dd", { textContent: v })])
  );
  $("ergebnis").replaceChildren(tabelle, summen);
  if (ergebnis.warnungen.length) meldung(ergebnis.warnungen, "warnung");
}

// --- Aktionen ---------------------------------------------------------------

async function berechnen() {
  const daten = sammeleDaten();
  const { ok, daten: antwort } = await api("/api/kalkulieren", { method: "POST", body: JSON.stringify(daten) });
  if (!ok) {
    ungueltig();
    $("ergebnis").replaceChildren();
    return meldung(antwort.fehler ?? [antwort.error ?? "Fehler bei der Berechnung"], "fehler");
  }
  meldung("Berechnet.", "info");
  zeigeErgebnis(antwort.ergebnis);
  letzteDaten = daten;
  $("senden").disabled = !erpVerbunden;
}

async function senden() {
  if (!letzteDaten) return;
  if (!letzteDaten.kunde) return meldung("Bitte zuerst einen Kunden wählen oder einen Kundennamen eingeben.", "fehler");
  if (!confirm("Angebot jetzt als Entwurf im Nexus ERP anlegen?")) return;
  $("senden").disabled = true;
  const { ok, daten: antwort } = await api("/api/angebot", { method: "POST", body: JSON.stringify(letzteDaten) });
  if (!ok) {
    $("senden").disabled = false;
    return meldung(antwort.fehler ?? [antwort.error ?? "Angebot konnte nicht angelegt werden"], "fehler");
  }
  meldung(`Angebot ${antwort.angebot.id} wurde als Entwurf im ERP angelegt (netto ${eur(antwort.angebot.subtotal)}).`, "erfolg");
}

const kundenSuchen = entprellt(async () => {
  const q = $("kundeSuche").value.trim();
  const treffer = kundenTreffer.get(q);
  if (treffer) {
    kundeId = treffer.id;
    $("kundeGewaehlt").textContent = `Gewählt: ${treffer.name}${treffer.city ? `, ${treffer.city}` : ""} (ERP-Kunde ${treffer.id})`;
    ungueltig();
    return;
  }
  kundeId = null;
  $("kundeGewaehlt").textContent = "";
  if (!erpVerbunden || q.length < 2) return;
  const { ok, daten } = await api(`/api/kunden?q=${encodeURIComponent(q)}`);
  if (!ok) return;
  kundenTreffer = new Map(daten.data.map((k) => [`${k.name}${k.city ? ` – ${k.city}` : ""} #${k.id}`, k]));
  $("kundenListe").replaceChildren(...[...kundenTreffer.keys()].map((v) => el("option", { value: v })));
});

const artikelSuchen = entprellt(async (q) => {
  if (!erpVerbunden || q.length < 2) return;
  const { ok, daten } = await api(`/api/artikel?q=${encodeURIComponent(q)}`);
  if (!ok) return;
  $("artikelListe").replaceChildren(...daten.data.map((a) =>
    el("option", { value: a.id, label: `${a.name} – EK ${eur(a.purchasePrice)}` })));
});

async function init() {
  const { ok, daten } = await api("/api/status");
  erpVerbunden = ok && daten.erpVerbunden;
  $("status").textContent = erpVerbunden ? `Verbunden mit ${daten.erpUrl}` : "Offline – keine ERP-Verbindung konfiguriert";
  $("status").classList.add(erpVerbunden ? "online" : "offline");

  $("neuMaterial").onclick = () => neueZeile("material");
  $("neuLohn").onclick = () => neueZeile("lohn");
  $("neuFremd").onclick = () => neueZeile("fremdleistung");
  $("berechnen").onclick = berechnen;
  $("senden").onclick = senden;
  $("kundeSuche").addEventListener("input", kundenSuchen);
  for (const id of ["kundeName", "kundeOrt", "titel", "referenz", "gueltigTage", "lohnkostensatz", "zMaterial", "zLohn", "zFremd", "wagnisGewinn", "steuersatz"]) {
    $(id).addEventListener("input", ungueltig);
  }
  $("positionen").addEventListener("input", (e) => {
    if (e.target.name === "artikelId") artikelSuchen(e.target.value.trim());
  });

  neueZeile("material");
  neueZeile("lohn");
}

init();
