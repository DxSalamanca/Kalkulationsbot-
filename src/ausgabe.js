// Textausgabe einer Kalkulation fuer die Kommandozeile.

const eur = (n) => n.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function spalte(text, breite, rechts = false) {
  const s = String(text);
  if (s.length > breite) return s.slice(0, breite - 1) + "…";
  return rechts ? s.padStart(breite) : s.padEnd(breite);
}

export function formatiereErgebnis(ergebnis, { titel } = {}) {
  const zeilen = [];
  if (titel) zeilen.push(titel, "=".repeat(Math.min(titel.length, 80)));

  zeilen.push(
    [
      spalte("Nr", 3, true), spalte("Bezeichnung", 28), spalte("Menge", 8, true), spalte("EK/Kosten", 10, true),
      spalte("Selbstk.", 10, true), spalte("VK", 10, true), spalte("Rab.%", 6, true), spalte("Netto", 11, true),
    ].join(" ")
  );
  zeilen.push("-".repeat(93));
  for (const p of ergebnis.positionen) {
    zeilen.push(
      [
        spalte(p.nr, 3, true),
        spalte(`${p.name}${p.typ !== "material" ? ` [${p.typ}]` : ""}`, 28),
        spalte(`${p.menge} ${p.einheit}`, 8, true),
        spalte(eur(p.einzelkosten), 10, true),
        spalte(eur(p.selbstkosten), 10, true),
        spalte(eur(p.vkEinheit), 10, true),
        spalte(p.rabatt ? p.rabatt : "", 6, true),
        spalte(eur(p.nettoZeile), 11, true),
      ].join(" ")
    );
  }
  const s = ergebnis.summen;
  zeilen.push("-".repeat(93));
  zeilen.push(`${"Einzelkosten gesamt".padEnd(30)}${eur(s.einzelkosten).padStart(14)} EUR`);
  zeilen.push(`${"Selbstkosten gesamt".padEnd(30)}${eur(s.selbstkosten).padStart(14)} EUR`);
  zeilen.push(`${"Angebot netto".padEnd(30)}${eur(s.netto).padStart(14)} EUR`);
  zeilen.push(`${`MwSt ${s.steuersatz} %`.padEnd(30)}${eur(s.mwst).padStart(14)} EUR`);
  zeilen.push(`${"Angebot brutto".padEnd(30)}${eur(s.brutto).padStart(14)} EUR`);
  zeilen.push(`${"Deckungsbeitrag".padEnd(30)}${eur(s.deckungsbeitrag).padStart(14)} EUR  (${eur(s.margeProzent)} %)`);

  if (ergebnis.warnungen.length) {
    zeilen.push("", "Warnungen:", ...ergebnis.warnungen.map((w) => `  ! ${w}`));
  }
  return zeilen.join("\n");
}
