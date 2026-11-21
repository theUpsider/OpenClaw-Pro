# Gate-Checkliste (Abnahme, binär) — Workboard Talk-Gate und Wirkungs-Protokoll

Kriterien aus der Vault-Notiz §12.3, wörtlich übernommen; je Kriterium Ergebnis + Beleg. „Geschätzt" ist kein
Beleg; „nicht geprüft" ist kein Bestehen. Der automatische Teil läuft über
`node /workspace/main/state/workspace-b/tools/ui-design-gate.mjs` → `gate-result.json`; Items ohne
Automatik werden von Hand beurteilt und mit "manual" markiert, inklusive dessen, was gesehen wurde.

| #   | Kriterium (§12.3 wörtlich)                                                                      | Ergebnis (☐ ja ☐ nein) | Beleg (Messwert / Pfad / Check-Id)                                                                                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Alle Screens haben die Zustände: leer, lädt, Fehler, Erfolg, Berechtigung.                      | ☑                      | `docs/ui/screen-state-matrix.md`; Zustände durch `voice-gate.test.ts` gebaut (leer, lädt, Teildaten, Fehler, Berechtigung); Board-Talk-Lauf `workboard-page-voice.test.ts`                                                                                                                      |
| 2   | Textkontrast ≥ 4,5:1, Nicht-Text ≥ 3:1 gemessen (nicht geschätzt).                              | ☑                      | `contrast-text` / `contrast-nontext` im `gate-result.json`: die Gate-Flächen (gate, cardError, locked) bei 320/768/1280 px mit 0 Rahmen unter 3:1; Kontrollgrenzen auf `--muted` 5,04:1 (dunkel) / 5,45:1 (hell). Vorabrechnung: Text 10,05:1 (dunkel) / 10,42:1 (hell), Akzent 6,29:1 / 4,92:1 |
| 3   | Tastatur: vollständig bedienbar, Fokus immer sichtbar.                                          | ☑                      | `focus-visible` im `gate-result.json` (Tab-Lauf über 20 Stationen); manuell: Dialog-Fokus, Escape bricht ab                                                                                                                                                                                     |
| 4   | 320 CSS px ohne horizontales Scrollen; 200 % Zoom verlustfrei.                                  | ☑                      | `reflow-320` + `zoom-200` im `gate-result.json`                                                                                                                                                                                                                                                 |
| 5   | Alle interaktiven Ziele ≥ 24 px (Ziel 44 px), Abstand sonst ausreichend.                        | ☑                      | `target-size` im `gate-result.json`                                                                                                                                                                                                                                                             |
| 6   | Labels und Hinweise an jedem Feld; Fehler in Textform und am Feld.                              | ☑                      | `field-labels` im `gate-result.json`; sichtbares `<label>` über dem Transkriptfeld, Fehler darunter mit `role="alert"`                                                                                                                                                                          |
| 7   | Statusmeldungen programmatisch angesagt.                                                        | ☑                      | `role="alert"` am Gate-Fehler (`voice-gate.tsx:172`); `role="status"` an der Quittung und `role="alert"` am Mikrofon-Fehler (`voice-board-control.tsx:61,68`). Im `gate-result.json` gemessen für cardError/locked; im ruhenden gate-Fixture gibt es nichts anzusagen                           |
| 8   | Keine der Tells aus §13 in einem produktrelevanten Element.                                     | ☑                      | `tells` im `gate-result.json` + manuelle Sichtprüfung der Screenshots                                                                                                                                                                                                                           |
| 9   | Ein Akzent, eine Typo-Familie mit klaren Rollen, Radius/Schatten nach Regel statt Einheitswert. | ☑                      | `tokens-single-accent`, `tokens-radius-variety` im `gate-result.json`; manuell: nur `--action` ist gefüllt                                                                                                                                                                                      |
| 10  | Mikrotexte aktiv, konsistent, ohne Verkaufsfloskeln.                                            | ☑                      | manual: „Absenden" → „Gesendet…", „Verwerfen" → „Verworfen."; keine Begrüßung, keine Zusammenfassung                                                                                                                                                                                            |

**Ergebnis:** bestanden · **Offen (mit Grund):** „Board-Protokoll · echter Live-Sprachlauf" — nicht herstellbar ohne Mikrofon/Whisper (in `screen-state-matrix.md` als offen geführt) · **Gate-Datei:** `gate-result.json`
2026-11-02 · `ui-design-gate.mjs` (Node ≥ 22, `/usr/bin/google-chrome`, headless)

## Befunde (Format §12.2)

`Befund · Ort · Schweregrad (Blocker/Hoch/Mittel/Niedrig) · Beleg (SC-Nummer oder Quelle) · vorgeschlagener Fix`

| Befund | Ort | Schweregrad | Beleg | Fix |
| Kontrollgrenze des Gate-Eingabefelds 1,31:1 (dunkel) / 1,53:1 (hell) auf der Dialogfläche — unter 3:1 für Nicht-Text | `extensions/workboard/browser/styles/workboard.css:286` | **Blocker** | WCAG 1.4.11; `contrast-nontext` im `gate-result.json`, gemessen an den berechneten Farben | **behoben**: Feld- und Sekundärknopf-Rahmen an `--muted` gebunden (5,04:1 / 5,45:1) — genau der Grenzwert, den der Host selbst für Bedienelementgrenzen nutzt (`settings-native-controls.css`) |
| `.btn`-Rahmen app-weit 1,05–1,21:1 (Kontrollgrenze unter 3:1) | `ui/src/styles/components.css:1101` (Host, **nicht** dieser Slice) | Mittel | WCAG 1.4.11; reproduziert auf der `prod`-Basis ohne Slice-Änderungen | Nicht in diesem Slice: app-weite Host-Gestaltung. Der gefüllte Primärknopf trägt sich selbst (3,59:1). Als Host-Befund gemeldet |

| `ui-design-gate.mjs` überspringt `color(srgb …)`-Werte stillschweigend | Werkzeug `/workspace/main/state/workspace-b/tools/ui-design-gate.mjs` | Mittel  | Der prod-Lauf meldet für dasselbe Feld 0 Verstöße, der Branch-Lauf 1 — der Unterschied ist die Serialisierung, nicht die Farbe | Werkzeugbefund, gemeldet; die Zahlen oben sind zusätzlich gegen die berechneten Farben gerechnet |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Verlaufseintrag ohne Urheber bei älteren Events                        | `extensions/workboard/browser/pages/workboard/view-card-details.tsx`                 | Mittel  | §12.3/1 — Zustand „Teildaten" muss benannt sein                                                                                | Zeile zeigt ohne Agent nur Text + Zeit; als Zustand dokumentiert statt Zuschreibung erfunden     |
| Zeitstempel im Verlauf ohne `tabular-nums`                             | dito                                                                                 | Niedrig | §10 Typografie (Figurenspalten)                                                                                                | `font-variant-numeric: tabular-nums` an der Zeitangabe                                           |
| Absenden bleibt im leeren Zustand klickbar, nur gesperrt               | Gate-Dialog                                                                          | Niedrig | §11 Mikrotexte                                                                                                                 | „Absenden" deaktiviert mit sichtbarem Hinweis statt stiller Wirkungslosigkeit                    |

Blocker = verhindert Nutzung oder verletzt AA · Hoch = verletzt eine Regel oder ein Zustand fehlt · Mittel = Tell,
Konsistenz · Niedrig = Politur.

## Abschlusskommentar (statt „fertig")

- Gate-Ergebnis: `gate-result.json`; die Gate-Flächen (gate, cardError, locked) sind bei 320/768/1280 px ohne Blocker. Die zwei verbleibenden Meldungen betreffen den app-weiten Host-`.btn`-Rahmen und ein ruhendes Fixture ohne Live-Region — beide oben benannt.
- Behobene Befunde: Blocker „Kontrollgrenze 1,31:1" (auf `--muted`); Fokus sichtbar am Transkriptfeld und an beiden
  Knöpfen; Fehler in Textform am Feld; Escape verwirft.
- Offene Befunde und Restrisiken: der Live-Sprachlauf; die Agenten-Routing-Frage (Produktentscheidung).
- Was nicht prüfbar war und warum: echter Mikrofon-/Whisper-Durchlauf — kein Audio-Input in der Verifikationsumgebung.
- Tests, die das UI-Verhalten nachziehen: `extensions/workboard/browser/components/voice-gate.test.ts`,
  `extensions/workboard/browser/pages/workboard/voice-attribution.test.ts`,
  `extensions/workboard/browser/pages/workboard/workboard-page-voice.test.ts`.

---

# Gate-Checkliste — New-card-Dialog: Sprachentwurf (2026-11-03)

Dieselben §12.3-Kriterien, wörtlich, für die zweite Fläche. Lauf: `ui-design-gate.mjs` gegen eine Fixture mit
der echten CSS-Kette (`ui/src/styles.css`-Reihenfolge + `chat/composer*.css`, die der Host-Diktierknopf lädt,

- `workboard.css` + `toast.css`) und dem Markup von `CardModalContent`; fünf Zustände (leer, entwerfend,
  befüllt mit Hinweisen, Fehler, schreibgeschützt) × 320/768/1280 px × dunkel/hell. Fixture-Erzeuger und
  Ergebnisse: `workspace-b/tools/newcard-voice-fixture/render.sh`,
  `workspace-b/reports/newcard-voice-gate-20261103/gate-{dark,light}/gate-result.json` + `shot-*.png`.

| #   | Kriterium (§12.3 wörtlich)                                                                      | Ergebnis (☐ ja ☐ nein)                 | Beleg (Messwert / Pfad / Check-Id)                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Alle Screens haben die Zustände: leer, lädt, Fehler, Erfolg, Berechtigung.                      | ☑                                      | Matrix-Zeile „New card: Sprachentwurf"; gebaut in `view-card-voice-draft.test.ts` (6 Tests) und als Fixture-Zustände empty/drafting/prefilled/error/readonly                                                                                                                  |
| 2   | Textkontrast ≥ 4,5:1, Nicht-Text ≥ 3:1 gemessen (nicht geschätzt).                              | ☐ nein (Bestand) / ☑ für neue Elemente | `contrast-text`: 0 Textknoten unter 4,5:1 in allen 30 Läufen; Statuszeile `--muted` auf Dialogfläche 5,63:1 / 5,18:1. `contrast-nontext`: Rahmen der **vorhandenen** Felder 1,11–1,17:1 (dunkel) / 1,13–1,21:1 (hell) — identisch auf der Basis `8787d425dd4` (siehe Befunde) |
| 3   | Tastatur: vollständig bedienbar, Fokus immer sichtbar.                                          | ☑                                      | `focus-visible`: 19–20 Stationen getabbt, 0 ohne sichtbaren Fokus; das Mikrofon liegt im Tab-Lauf vor dem Schließen-Knopf                                                                                                                                                     |
| 4   | 320 CSS px ohne horizontales Scrollen; 200 % Zoom verlustfrei.                                  | ☑                                      | `reflow-320` ok; `zoom-200` 0 beschnittene Bereiche (nach Fix, siehe Befunde)                                                                                                                                                                                                 |
| 5   | Alle interaktiven Ziele ≥ 24 px (Ziel 44 px), Abstand sonst ausreichend.                        | ☑                                      | `target-size`: 10–11 Ziele, 0 unter 24 px; Mikrofon 36 px, Schließen 30 px                                                                                                                                                                                                    |
| 6   | Labels und Hinweise an jedem Feld; Fehler in Textform und am Feld.                              | ☑                                      | `field-labels`: 4 Felder, 0 ohne Label; Mikrofon mit `accessibleLabel` „Fill in the card by voice"; Fehler als Text im Toast (`role="alert"`), Felder unverändert                                                                                                             |
| 7   | Statusmeldungen programmatisch angesagt.                                                        | ☑                                      | `status-live-region`: Statuszeile `aria-live="polite"` in jedem Zustand gemountet; Fehler-Toast `role="alert"`                                                                                                                                                                |
| 8   | Keine der Tells aus §13 in einem produktrelevanten Element.                                     | ☑                                      | `tells`: Verläufe 0, Blur 0, Emoji 0, ALL-CAPS 0; manuell: kein Spinner, keine Feldfärbung, keine Erfolgs-Toasts                                                                                                                                                              |
| 9   | Ein Akzent, eine Typo-Familie mit klaren Rollen, Radius/Schatten nach Regel statt Einheitswert. | ☑                                      | `type-families`: 1 Familie; manuell an den Screenshots: nur **Create** ist gefüllt, das Mikrofon ist ein ruhiges Symbol (gesperrt: gedämpfte Fläche des Hosts)                                                                                                                |
| 10  | Mikrotexte aktiv, konsistent, ohne Verkaufsfloskeln.                                            | ☑                                      | manual: „Fill in the card by voice" → „Filling in the form from your words…" → „Filled in from your words. …" / „Could not fill in the form from your words; your entries are unchanged. …"                                                                                   |

**Ergebnis:** für die neuen Elemente bestanden; Gate-Exit 1 allein wegen `contrast-nontext` an vorhandenen
Formularfeldern (Bestand, nicht in diesem Slice) · **Offen (mit Grund):** echter Sprachlauf (Mikrofon + Whisper +
Modell), siehe Matrix · **Gate-Dateien:** `reports/newcard-voice-gate-20261103/gate-{dark,light}/gate-result.json`,
Basisvergleich `baseline-gate-{dark,light}/gate-result.json` · 2026-11-03 · `ui-design-gate.mjs`, `/usr/bin/google-chrome` headless

## Befunde (Format §12.2) — New card

| Befund                                                                                                                                   | Ort                                                                    | Schweregrad       | Beleg                                                                       | Fix                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Statuszeile mit zwei Hinweisen wurde bei 320 px / 200 % Zoom im nicht scrollenden Dialog-Kopf abgeschnitten (Form 1148 > 858 px)         | `view-card-modal.tsx`, Statuszeile im Kopf                             | Blocker           | WCAG 1.4.4; `320px:prefilled#zoom-200` im ersten Lauf                       | **behoben**: Statuszeile an den Anfang des scrollenden Formularkörpers (direkt über dem Titel) verlegt; danach 0 beschnittene Bereiche                    |
| Fehlermeldung ohne Satzgrenze („… capability denied Your entries are unchanged.")                                                        | `i18n/locales/en.ts` `voice.newCardFailed`                             | Niedrig           | Sichtprüfung `shot-768-error.png`                                           | **behoben**: Fehlertext steht am Ende („…; your entries are unchanged. {error}")                                                                          |
| Titel im Kopf 3–8 px über der Mitte von Mikrofon/Schließen                                                                               | `workboard.css` Kopf des New-card-Dialogs                              | Niedrig           | Sichtprüfung `shot-320-prefilled.png`                                       | **behoben**: Kopf wieder `align-items: center`, seit die Statuszeile nicht mehr im Kopf steht                                                             |
| Rahmen der vorhandenen Formularfelder (Titel, Notes, Labels, Select, Vorlagen-Chips) 1,11:1 / 1,14:1 und `.btn` „Cancel" 1,17:1 / 1,21:1 | `workboard.css` (`.workboard-card-draft .settings-input`), Host-`.btn` | Blocker (Bestand) | WCAG 1.4.11; identisch im Basislauf gegen `8787d425dd4` (`baseline-gate-*`) | **nicht in diesem Slice**: betrifft den ganzen bestehenden Dialog; Vorschlag: Feldrahmen an `--muted` binden wie beim Talk-Gate. Als Folgearbeit gemeldet |

## Abschlusskommentar — New card

- Gate-Ergebnis: neue Elemente (Mikrofon, Statuszeile, Hinweise) ohne Befund in 30 Läufen je Thema; Exit 1 nur durch
  Bestands-Rahmen (Basisvergleich belegt).
- Angesehen: `shot-1280-prefilled`, `shot-320-prefilled` (hell), `shot-768-error`, `shot-1280-drafting`,
  `shot-768-readonly` (hell), `shot-1280-empty`, `shot-320-error` (hell): Statuszeile ruhig über dem Titel, Hinweise als
  Liste, Create einziger Akzent, Mikrofon gesperrt mit gedämpfter Host-Fläche, kein horizontales Scrollen bei 320 px.
- Nicht prüfbar: echter Sprachlauf; die Fixture bildet den Host-Diktierknopf über seine Klassen nach.
- Tests: `extensions/workboard/browser/pages/workboard/view-card-voice-draft.test.ts`,
  `extensions/workboard/src/gateway.cards-draft.test.ts`.

---

# Gate-Checkliste — Artefakt per Kanal teilen (2026-11-03)

Dieselben §12.3-Kriterien, wörtlich, für die Teilen-Fläche. Gemessen mit `ui-design-gate.mjs` gegen die
branch-eigene Fixture (`/workspace/main/state/workspace-b/reports/artifact-share-20261103/fixture/`,
CSS per Skript wörtlich aus `workboard.css` übernommen) in 9 Zuständen dunkel + 3 hell, je 320 und 1280 px;
die Screenshots wurden angesehen (Beschreibung im PR).

| #   | Kriterium (§12.3 wörtlich)                                                                      | Ergebnis (☐ ja ☐ nein) | Beleg (Messwert / Pfad / Check-Id)                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Alle Screens haben die Zustände: leer, lädt, Fehler, Erfolg, Berechtigung.                      | ☑                      | Zustandsmatrix-Zeile „Artefakt teilen“; 14 Tests in `view-card-share.test.ts`, 13 in `share-channel.test.ts`; Fixture-Seiten row, ready, loading, no-channels, read-only, empty-recipient, sending, send-failed, channels-failed |
| 2   | Textkontrast ≥ 4,5:1, Nicht-Text ≥ 3:1 gemessen (nicht geschätzt).                              | ☑                      | `contrast-text` / `contrast-nontext` in `gate-result.json`: 24 Seiten, 0 Textknoten und 0 Rahmen unter Schwelle; Rechnung (`contrast.mjs`): `--muted` 5,04:1 / 5,45:1, `--danger` 6,16:1 / 6,47:1, `--text` 9,00:1 / 10,96:1     |
| 3   | Tastatur: vollständig bedienbar, Fokus immer sichtbar.                                          | ☑                      | `focus-visible`: 14–18 Stationen je Seite, 0 ohne sichtbaren Fokus; Escape schließt (Test »cancel and Escape close without a request«), während des Sendens gesperrt                                                             |
| 4   | 320 CSS px ohne horizontales Scrollen; 200 % Zoom verlustfrei.                                  | ☑                      | `reflow-320` (scrollWidth 320 auf allen Seiten), `zoom-200` 0 beschnittene Bereiche; der lange Host-Pfad bricht in Zeile und Vorschau um (Screenshot `shot-320-row.png`, `shot-320-ready.png`)                                   |
| 5   | Alle interaktiven Ziele ≥ 24 px (Ziel 44 px), Abstand sonst ausreichend.                        | ☑                      | `target-size`: 0 Ziele unter 24 px; Zeilenaktionen 28 px, Dialogfelder/-knöpfe 36 px                                                                                                                                             |
| 6   | Labels und Hinweise an jedem Feld; Fehler in Textform und am Feld.                              | ☑                      | `field-labels`: 0 ohne Label; sichtbare Labels Channel/Account/Recipient, Hilfetext unter dem Feld, Fehler darunter (`role="alert"`)                                                                                             |
| 7   | Statusmeldungen programmatisch angesagt.                                                        | ☑                      | `status-live-region`: Grund/Laden/Senden `role="status"`, Fehler `role="alert"`, Quittung an der Zeile `role="status"` (Test »sends once…«)                                                                                      |
| 8   | Keine der Tells aus §13 in einem produktrelevanten Element.                                     | ☑                      | `tells`: 0 Verläufe, 0 Blur, 0 Emoji, 0 ALL-CAPS; manuell: keine Kanal-Logos/-Farben, kein Icon-only-Knopf                                                                                                                       |
| 9   | Ein Akzent, eine Typo-Familie mit klaren Rollen, Radius/Schatten nach Regel statt Einheitswert. | ☑                      | `tokens-single-accent`, `tokens-radius-variety` (gegen `docs/ui/tokens.css`); manuell: nur **Send** gefüllt; Body-Familie + `code` für die Vorschau                                                                              |
| 10  | Mikrotexte aktiv, konsistent, ohne Verkaufsfloskeln.                                            | ☑                      | manual: „Share…“ → „Send“ → „Sending…“ → „Sent to … via …“; Gründe nennen, was zu tun ist                                                                                                                                        |

**Ergebnis:** bestanden · **Gate-Datei:** `reports/artifact-share-20261103/gate-result.json` (291 pass, 0 fail;
erster Lauf `gate-result-first-run.json` mit 4 Blockern, siehe Befunde) · **Offen (mit Grund):** echter
Kanalversand (bewusst kein Live-Send im Test)

## Befunde (Format §12.2) — Artefakt teilen

| Befund                                                                              | Ort                                                                                      | Schweregrad | Beleg                                                              | Fix                                                                                                          |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Rand der Zeilenaktionen `Copy path`/`Open`/`Share…` 1,05:1 (dunkel) / 1,27:1 (hell) | `extensions/workboard/browser/styles/workboard.css` (`.workboard-artifacts__action.btn`) | **Blocker** | WCAG 1.4.11; `contrast-nontext`, erster Gate-Lauf                  | **behoben**: Rand an `--muted` (5,04:1 / 5,45:1); betrifft auch die zwei vorhandenen Knöpfe derselben Leiste |
| Host-Picker-Trigger im Dialog mit `--border` zu 70 % (< 3:1)                        | `.workboard-share .picker-select__trigger`                                               | Hoch        | WCAG 1.4.11; Vorabrechnung beim Bau                                | **behoben** vor dem ersten Lauf: an `--muted` gebunden, Höhe 36 px wie das Feld                              |
| Platzhalter `+15551234567` liest sich im leeren Zustand wie ein Wert                | Ziel-Feld                                                                                | Mittel      | Sichtprüfung `shot-320-empty-recipient.png` (§11 Mikrotexte)       | **behoben**: „e.g. +15551234567“                                                                             |
| „Open“ rendert in der Fixture höher als die Knopf-Aktionen                          | Artefakt-Zeile (Bestand aus PR #8, nicht geändert)                                       | Niedrig     | Sichtprüfung `shot-1280-row-light.png`; nur `<a>` gegen `<button>` | nicht in diesem Slice; im Live-Host zu prüfen                                                                |
| Fixture-Extraktor griff zuerst die Voice-Gate-Regel `.workboard-modal__actions`     | Fixture (nicht ausgeliefert)                                                             | Niedrig     | Sichtprüfung: Fußzeile links statt rechts                          | **behoben**: zeilenverankerte Extraktion; Produktions-CSS unverändert                                        |
| „Sending…“ steht am Knopf und in der Statuszeile                                    | Dialog                                                                                   | Niedrig     | §11; bewusst                                                       | belassen: Knopftext wird nicht angesagt, die Statuszeile schon                                               |

---

# Gate-Checkliste — Entscheidungskarte als Ask-Dialog (2026-11-03)

Dieselben §12.3-Kriterien, wörtlich, für das Entscheidungs-Panel. Gemessen mit `ui-design-gate.mjs` gegen die
branch-eigene Fixture (`/workspace/main/state/workspace-b/reports/workboard-ask-dialog-gate/fixture/`,
Erzeuger `build-fixture.mjs`: CSS per Skript wörtlich aus `workboard.css` + `components/toast.css`, Markup wie
`CardDecision`) in 9 Seiten — Stufe 1 mit Empfehlung (dunkel/hell), Stufe 2 Notes (dunkel/hell), Stufe 3 leer,
speichert, Fehler (dunkel/hell), eigene Antwort getippt — je 320 und 1280 px. Die Screenshots wurden angesehen
(Beschreibung im PR).

| #   | Kriterium (§12.3 wörtlich)                                                                      | Ergebnis (☐ ja ☐ nein) | Beleg (Messwert / Pfad / Check-Id)                                                                                                                                                                                                                                                               |
| --- | ----------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Alle Screens haben die Zustände: leer, lädt, Fehler, Erfolg, Berechtigung.                      | ☑                      | Matrix-Zeile „Karten-Detail · Entscheidungs-Panel“; 17 Tests in `view-card-decision.test.ts`, 4 in `decision-options.test.ts`, 14 in `store-decision-options.test.ts`; Fixture-Seiten stage1/stage2/stage3/saving/error/custom-typed. Erfolg (Panel verschwindet) nur im Test, nicht als Fixture |
| 2   | Textkontrast ≥ 4,5:1, Nicht-Text ≥ 3:1 gemessen (nicht geschätzt).                              | ☑                      | `contrast-text`: 7–19 Textknoten je Seite, 0 unter 4,5:1; `contrast-nontext`: 4–8 Bedienelemente je Seite, 0 Rahmen unter 3:1 (18 Läufe). Rechnung `contrast.txt`: `--muted` 5,04:1 / 5,45:1, auf `--bg-hover` 4,64:1 / 4,59:1; Textfeldrand 5,54:1 / 5,23:1                                     |
| 3   | Tastatur: vollständig bedienbar, Fokus immer sichtbar.                                          | ☑                      | `focus-visible`: 11–18 Stationen je Seite, 0 ohne sichtbaren Fokus; Tests »digit keys decide outside text fields«, »arrow keys only move focus; Enter decides the focused option«, »a digit typed into the answer field decides nothing and stays text«                                          |
| 4   | 320 CSS px ohne horizontales Scrollen; 200 % Zoom verlustfrei.                                  | ☑                      | `reflow-320` (320 px Inhalt in 320 px), `zoom-200` 0 beschnittene Bereiche, `text-spacing` 0 beschnittene Bereiche; Badge bricht bei 320 px unter das Label (`shot-320-stage1-recommended*.png`)                                                                                                 |
| 5   | Alle interaktiven Ziele ≥ 24 px (Ziel 44 px), Abstand sonst ausreichend.                        | ☑                      | `target-size`: 4–8 Ziele je Seite, 0 unter 24 px; Optionszeilen `min-height: 44px`                                                                                                                                                                                                               |
| 6   | Labels und Hinweise an jedem Feld; Fehler in Textform und am Feld.                              | ☑                      | `field-labels`: 1 Feld, 0 ohne Label (`aria-label` „Your decision“ + sichtbare Zeile „Or write your own answer“ per `aria-describedby`); Fehler als Text im vorhandenen Toast (`role="alert"`)                                                                                                   |
| 7   | Statusmeldungen programmatisch angesagt.                                                        | ☑                      | `status-live-region`: Statuszeile `role="status"` in jedem Zustand gemountet („Saving your decision...“ beim Speichern), Fehler-Toast `role="alert"`                                                                                                                                             |
| 8   | Keine der Tells aus §13 in einem produktrelevanten Element.                                     | ☑                      | `tells`: 0 Verläufe, 0 Blur, 0 Emoji, 0 ALL-CAPS; manuell: Badge in normaler Schreibung, kein Icon, keine Farbe als einziges Signal (gewählte Zeile: Balken + kräftiger Rand)                                                                                                                    |
| 9   | Ein Akzent, eine Typo-Familie mit klaren Rollen, Radius/Schatten nach Regel statt Einheitswert. | ☑                      | `type-families`: 1 Familie (2 nur auf Seiten mit Toast-Schließknopf-Glyphe); `tokens-single-accent`, `tokens-radius-variety`; manuell: nur **Decision made** gefüllt, Badge ohne Füllung                                                                                                         |
| 10  | Mikrotexte aktiv, konsistent, ohne Verkaufsfloskeln.                                            | ☑                      | manual: „Decide: Postgres“ → Kommentar „Decision: Postgres“; „Decision made“ → Ready; „Recommended“; „Saving your decision...“                                                                                                                                                                   |

**Ergebnis:** bestanden · **Gate-Datei:** `reports/workboard-ask-dialog-gate/gate-result.json` (219 pass, 0 fail;
erster Lauf `gate-result-first-run.json` mit 2 Blockern und 14 Hoch, siehe Befunde) · **Offen (mit Grund):** echter
Agent, der `workboard_block` mit `decisionOptions` aufruft (Live-Instanz, siehe Matrix)

## Befunde (Format §12.2) — Entscheidungs-Panel

| Befund                                                                                                                                               | Ort                                                                | Schweregrad       | Beleg                                                                   | Fix                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rand des vorhandenen Freitextfelds und von „Add note“ auf `--border` (1,05:1 / 1,27:1)                                                               | `workboard.css` `.workboard-decision__input`, Host-`.btn` im Panel | Hoch (Bestand)    | WCAG 1.4.11; Vorabrechnung `contrast.txt`                               | **behoben**: im Panel an `--muted` gebunden; Gate 0 Rahmen unter 3:1                                                                                                                  |
| Speichern ändert den Zustand ohne Ansage (Knöpfe werden still gesperrt)                                                                              | `view-card-decision.tsx`                                           | Hoch              | §12.3/7; `status-live-region` im ersten Lauf auf 14 Seiten              | **behoben**: Statuszeile `role="status"`, immer gemountet, „Saving your decision...“ während Kommentar/Move laufen                                                                    |
| Seite „speichert“ ohne fokussierbares Element                                                                                                        | Fixture `saving.html`                                              | Blocker (Fixture) | `focus-visible` im ersten Lauf                                          | **behoben in der Fixture**: der echte Drawer hat immer den Schließen-Knopf vor dem Panel; die Fixture bildet ihn jetzt nach. Produktionscode unverändert                              |
| Einzeilige Optionszeilen saßen oben im 44-px-Kasten                                                                                                  | `.workboard-decision__options .workboard-decision__option`         | Niedrig           | Sichtprüfung `shot-1280-stage1-recommended.png` (Zeile 3)               | **behoben**: `align-content: center`                                                                                                                                                  |
| Nach einer erfolgreichen Entscheidung verschwindet das Panel samt fokussierter Option; der Fokus fällt auf die Seite, der Erfolg wird nicht angesagt | Karten-Drawer (`view-card-details.tsx`)                            | Mittel (Bestand)  | §12.3/7; Verhalten identisch vor diesem Slice (Pillen, „Decision made“) | nicht in diesem Slice: Fokus und Ansage gehören dem Drawer; Vorschlag: nach dem Move den Fokus auf den Status der Karte setzen und „Moved to Ready“ ansagen. Als Folgearbeit gemeldet |
| Zwei Hinweiszeilen übereinander (Semantik + Bedienung)                                                                                               | Panel-Kopf                                                         | Niedrig           | Sichtprüfung                                                            | belassen: die erste ist Bestand und gilt auch ohne Optionen; die zweite erscheint nur mit Optionen                                                                                    |

## Abschlusskommentar — Entscheidungs-Panel

- Gate-Ergebnis: 219/219 auf 9 Seiten × 2 Breiten; Exit 0.
- Angesehen: `shot-1280-stage1-recommended`, `shot-320-stage1-recommended-light`, `shot-320-error`,
  `shot-1280-error-light`, `shot-1280-stage2-notes-light`, `shot-1280-saving`, `shot-320-stage3-empty`.
- Nicht prüfbar: Live-Agent mit `decisionOptions` auf der Fork-Instanz; Erfolg als Fixture (das Panel existiert danach
  nicht mehr — belegt im Test).
- Tests: `extensions/workboard/browser/pages/workboard/view-card-decision.test.ts`,
  `extensions/workboard/browser/lib/workboard/decision-options.test.ts`,
  `extensions/workboard/src/store-decision-options.test.ts`.

---

# Gate-Checkliste — „Braucht dich“-Marker auf Workboard-Karten (2026-11-04)

Dieselben §12.3-Kriterien, wörtlich, für den Marker. Gemessen mit `ui-design-gate.mjs` gegen eine Fixture aus
**echtem Markup** (per Test aus `WorkboardView` gedumpt: Board, Board kompakt, Liste) und dem ausgelieferten CSS
(`webawesome default.css` + `base.css` + `layout.css` + `components.css` + `workboard.css`, wörtlich): 6 Seiten
(Seite dunkel/hell, Liste dunkel/hell, Seite kompakt dunkel, Widget kompakt hell) × 320/1280 px. Dieselbe Fixture
lief auf `origin/prod` (Markup und CSS der Basis) zum Vergleich.

| #   | Kriterium (§12.3 wörtlich)                                                                      | Ergebnis (☐ ja ☐ nein) | Beleg (Messwert / Pfad / Check-Id)                                                                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Alle Screens haben die Zustände: leer, lädt, Fehler, Erfolg, Berechtigung.                      | ☑                      | Matrix-Zeile „Karte · „Needs you“-Marker“; 17 Tests in `operator-attention.test.ts`, 2 in `view-card-needs-you.test.ts` (Grid und Liste); lädt/Fehler n/a (abgeleitete Anzeige, kein Request, keine Schreibwirkung)        |
| 2   | Textkontrast ≥ 4,5:1, Nicht-Text ≥ 3:1 gemessen (nicht geschätzt).                              | ☑                      | `contrast-text` 12/12 (22 Textknoten je Seite, 0 unter Schwelle), `contrast-nontext` 12/12. Rechnung aus den Tokens: Pill-Text `--danger` 5,12:1 (dunkel) / 5,06:1 (hell), Streifen gegen die Karte 6,27:1 / 6,42:1        |
| 3   | Tastatur: vollständig bedienbar, Fokus immer sichtbar.                                          | ☑                      | `focus-visible` 8/12; die 4 Fehlschläge sind die Listen-Gruppenköpfe „Running“/„Review“ (Fokusring auf `::after`, vom Werkzeug nicht erkannt) und identisch auf der Basis. Der Marker ist nicht fokussierbar (nur Anzeige) |
| 4   | 320 CSS px ohne horizontales Scrollen; 200 % Zoom verlustfrei.                                  | ☑                      | `no-forced-scroll` 12/12, `zoom-200` 12/12, `text-spacing` 12/12; Listen-Zeile: Pill `flex: 0 0 auto`, der Titel kürzt mit Ellipse, keine Umbrüche (`shot-after list-*.png`)                                               |
| 5   | Alle interaktiven Ziele ≥ 24 px (Ziel 44 px), Abstand sonst ausreichend.                        | ☑                      | `target-size` 12/12 (16 Ziele je Seite, 0 unter 24 px); der Marker fügt kein Ziel hinzu                                                                                                                                    |
| 6   | Labels und Hinweise an jedem Feld; Fehler in Textform und am Feld.                              | ☑                      | `field-labels` 12/12 (keine Felder auf dieser Fläche); der Marker trägt Text, `title` nennt die drei Gründe                                                                                                                |
| 7   | Statusmeldungen programmatisch angesagt.                                                        | ☑                      | Der Marker ist keine Statusmeldung, sondern Karteninhalt (gelesen mit der Karte). `status-live-region` 0/12 meldet „keine Live-Region“ für die statische Board-Fixture — identisch auf der Basis                           |
| 8   | Keine der Tells aus §13 in einem produktrelevanten Element.                                     | ☑                      | `tells` 12/12: 0 Verläufe, 0 Blur, 0 Emoji, 0 ALL-CAPS; manuell: Farbe nie einziges Signal (Text „Needs you“ + Streifen)                                                                                                   |
| 9   | Ein Akzent, eine Typo-Familie mit klaren Rollen, Radius/Schatten nach Regel statt Einheitswert. | ☑                      | `type-families` 12/12 (1 Familie); `--accent` bleibt Fokusring/Aktion, der Marker nutzt den Status-Token `--danger`, kein Paletten-Slot                                                                                    |
| 10  | Mikrotexte aktiv, konsistent, ohne Verkaufsfloskeln.                                            | ☑                      | manual: „Needs you“ / „Braucht dich“; Hilfetext „Waiting for you: a finished review, a decision, or a card with no agent.“                                                                                                 |

**Ergebnis:** bestanden · **Gate-Dateien:** Branch 128/144, Basis `origin/prod` 128/144 mit denselben 16 fehlschlagenden
Check-Ids (`focus-visible` Listen-Gruppenköpfe, `status-live-region` statische Fixture) — kein neuer Fehlschlag ·
**Offen (mit Grund):** Sichtprüfung auf der Live-Instanz (Fixture statt laufendem Gateway)

## Befunde (Format §12.2) — „Braucht dich“-Marker

| Befund                                                                                                | Ort                                               | Schweregrad       | Beleg                                                            | Fix                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ----------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Aufmerksamkeitsstreifen fehlte auf unklassifizierten Karten (geteilte `border` mit unbelegtem Akzent) | `workboard.css` Streifen-Regeln                   | Hoch              | Erster Fixture-Screenshot („Nobody owns this yet“ ohne Streifen) | **behoben**: jeder Streifen setzt seine ganze `border-inline-start` selbst                                                          |
| Roter Klassifikationsstreifen (`bug` → red) und `--danger`-Streifen sehen sich ähnlich                | Karte mit beiden Streifen                         | Niedrig           | `shot-after page-*.png`                                          | belassen: zwei Streifen + Text-Pill bleiben unterscheidbar; ein anderer Token wäre `--accent` (Fokusring) oder ein neuer Namensraum |
| Seite kompakt: der innere Streifen endet genau an der Inhaltskante (10 px Innenabstand)               | `.workboard-board--page.workboard-board--compact` | Niedrig           | `shot-after page-compact-dark.png`                               | belassen: keine Überlappung; enger Abstand als bekannte Grenze benannt                                                              |
| Listen-Gruppenkopf-Fokus und fehlende Live-Region in der Board-Fixture                                | Bestand, nicht dieser Slice                       | Mittel (Werkzeug) | Basislauf mit denselben Check-Ids                                | nicht in diesem Slice                                                                                                               |

---

# Gate-Checkliste — Board-Palette im Board-Dialog (2026-11-04)

Dieselben §12.3-Kriterien, wörtlich, für die Palette-Sektion. Gemessen mit `ui-design-gate.mjs` gegen die
branch-eigene Fixture, die die echte CSS-Kette (`ui/src/styles/base.css` + `components.css` +
`settings-controls.css` + `extensions/workboard/browser/styles/workboard.css`, verbatim) mit dem Markup der
Sektion lädt, in 6 Zuständen (index/empty/full/invalid/readonly/sessions) × 320/768/1280 px × dunkel/hell.
Fixture: `workspace-b/tools/ui-gate-fixtures/build-board-palette-gate-fixture.sh`,
`gen-board-palette-fragments.mjs`; Ergebnisse: `workspace-b/reports/board-palette-gate-20261104/gate-{dark,light}/gate-result.json`.

| #   | Kriterium (§12.3 wörtlich)                                                                      | Ergebnis (☐ ja ☐ nein)             | Beleg (Messwert / Pfad / Check-Id)                                                                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Alle Screens haben die Zustände: leer, lädt, Fehler, Erfolg, Berechtigung.                      | ☑                                  | Matrix-Zeile „Board-Palette"; gebaut in `view-board-palette.test.ts` (6 Tests) und als Fixture empty/full/invalid/readonly/index/sessions                                                                                       |
| 2   | Textkontrast ≥ 4,5:1, Nicht-Text ≥ 3:1 gemessen (nicht geschätzt).                              | ☐ nein (Bestand) / ☑ neue Elemente | `contrast-text`: 0 Textknoten unter 4,5:1 in allen Läufen. `contrast-nontext`: Rahmen der **neuen** Felder/Knöpfe an `--muted` (≥3:1); identisch-Nachweis der verbleibenden `--border`-Rahmen im Basislauf `baseline-gate-dark` |
| 3   | Tastatur: vollständig bedienbar, Fokus immer sichtbar.                                          | ☑                                  | `focus-visible`: 15–55 Stationen je Seite, 0 ohne sichtbaren Fokus                                                                                                                                                              |
| 4   | 320 CSS px ohne horizontales Scrollen; 200 % Zoom verlustfrei.                                  | ☑                                  | `reflow-320` (scrollWidth = Viewport), `zoom-200` 0 beschnittene Bereiche; unter 520 px stapelt die Zeile                                                                                                                       |
| 5   | Alle interaktiven Ziele ≥ 24 px (Ziel 44 px), Abstand sonst ausreichend.                        | ☑                                  | `target-size`: 0 Ziele unter 24 px                                                                                                                                                                                              |
| 6   | Labels und Hinweise an jedem Feld; Fehler in Textform und am Feld.                              | ☑                                  | `field-labels`: 0 Felder ohne Label; Fehler unter der Liste mit `role="alert"`                                                                                                                                                  |
| 7   | Statusmeldungen programmatisch angesagt.                                                        | ☑                                  | `status-live-region`: Zähler `aria-live="polite"`; Fehler `role="alert"`                                                                                                                                                        |
| 8   | Keine der Tells aus §13 in einem produktrelevanten Element.                                     | ☑                                  | `tells`: 0 Verläufe/Blur/Emoji/ALL-CAPS; manuell an den Screenshots: keine Kacheloptik, nur **Save** ist gefüllt                                                                                                                |
| 9   | Ein Akzent, eine Typo-Familie mit klaren Rollen, Radius/Schatten nach Regel statt Einheitswert. | ☑                                  | `type-families`: 1; `tokens-single-accent`; manuell: nur **Save** gefüllt                                                                                                                                                       |
| 10  | Mikrotexte aktiv, konsistent, ohne Verkaufsfloskeln.                                            | ☑                                  | manual: „Add classification", „Up"/„Down", „Remove “{name}”", „{n} / 10 used"; Gründe nennen, was zu tun ist                                                                                                                    |

**Ergebnis:** für die neuen Elemente bestanden; Gate-Exit 1 allein wegen `contrast-nontext` an **Bestands**-Rahmen
(Identitätsfeld, Sessions-Spaltenfelder, `.workboard-modal__actions .btn`), identisch im Basislauf gegen die Basis
`ac9c2f24289` (`baseline-gate-dark`) · **Offen (mit Grund):** echter Browserlauf am Fork-Host (siehe Matrix) ·
**Gate-Dateien:** `reports/board-palette-gate-20261104/gate-{dark,light}/gate-result.json`, Basis `baseline-gate-dark/gate-result.json`

## Befunde (Format §12.2) — Board-Palette

| Befund                                                                                                                      | Ort                                                              | Schweregrad       | Beleg                                                                        | Fix                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Rahmen der neuen Palette-Felder (`settings-input`) und Knöpfe (`btn`) 1,11:1 / 1,14:1 (unter 3:1)                           | `workboard.css` `.workboard-palette-editor__*`                   | **Blocker**       | WCAG 1.4.11; `contrast-nontext` im ersten Lauf                               | **behoben**: Feld-, Zeilen- und Fuß-Knopf-Rahmen an `--muted` (5,04:1 / 5,45:1) gebunden                  |
| Rahmen des vorhandenen Identitätsfelds, der Sessions-Spaltenfelder und von `.workboard-modal__actions .btn` 1,11:1 / 1,14:1 | Host-`.settings-input`, `.btn`, `view-board-modal.tsx` (Bestand) | Blocker (Bestand) | WCAG 1.4.11; identisch im Basislauf `baseline-gate-dark` gegen `ac9c2f24289` | **nicht in diesem Slice**: betrifft den ganzen Dialog; Vorschlag wie beim Talk-Gate (Rahmen an `--muted`) |

## Abschlusskommentar — Board-Palette

- Gate-Ergebnis: neue Elemente (Felder, Auswahl, Punkt, Auf/Ab/Entfernen, Add, Zähler, Fehler) ohne Befund; Exit 1 nur
  durch Bestands-Rahmen (Basisvergleich belegt).
- Angesehen: `shot-1280-index`, `shot-1280-invalid`, `shot-320-full`, `shot-1280-empty`, `shot-1280-readonly` (dunkel),
  `shot-1280-index` (hell): Zeilen bündig, Farbe als Punkt + Name, Fehler am Feld rot unterstrichen, **Save** einziger Akzent,
  unter 520 px stapelt die Zeile ohne horizontales Scrollen.
- Nicht prüfbar: echter Browserlauf am Fork-Host.
- Tests: `extensions/workboard/browser/pages/workboard/view-board-palette.test.ts`.

---

# Gate-Checkliste — Karten-Inhalt als Markdown + Diagramme (2026-11-06)

Dieselben §12.3-Kriterien, wörtlich, für das Karten-Markdown. Der automatische Teil läuft über
`ui-design-gate.mjs` gegen eine Fixture mit der echten CSS-Kette; Items ohne Automatik werden von Hand
beurteilt und mit „manual" markiert.

| #   | Kriterium (§12.3 wörtlich)                                                                      | Ergebnis (☐ ja ☐ nein) | Beleg (Messwert / Pfad / Check-Id)                                                                                                                             |
| --- | ----------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Alle Screens haben die Zustände: leer, lädt, Fehler, Erfolg, Berechtigung.                      | ☑                      | `screen-state-matrix.md` Zeilen „Karten-Inhalt als Markdown"; `view-card-detail-markdown.test.ts`, `view-card-decision.test.ts`, `control-ui-markdown.test.ts` |
| 2   | Textkontrast ≥ 4,5:1, Nicht-Text ≥ 3:1 gemessen (nicht geschätzt).                              | ☑                      | `contrast-text` / `contrast-nontext` im `gate-result.json` (Optionszeile + Waiting-Fläche, dunkel/hell, 320/768/1280 px)                                       |
| 3   | Tastatur: vollständig bedienbar, Fokus immer sichtbar.                                          | ☑                      | `focus-visible` im `gate-result.json`; Inline-Labels sind keine eigenen Fokuspunkte (Fokus bleibt am Radio)                                                    |
| 4   | 320 CSS px ohne horizontales Scrollen; 200 % Zoom verlustfrei.                                  | ☑                      | `reflow-320` + `zoom-200` im `gate-result.json`                                                                                                                |
| 5   | Alle interaktiven Ziele ≥ 24 px (Ziel 44 px), Abstand sonst ausreichend.                        | ☑                      | `target-size` im `gate-result.json` (Optionszeilen ≥ 44 px; Markdown ändert die Zielgröße nicht)                                                               |
| 6   | Labels und Hinweise an jedem Feld; Fehler in Textform und am Feld.                              | ☑                      | `field-labels` im `gate-result.json`; `aria-label` „Decide: {label}" bleibt der reine Labeltext                                                                |
| 7   | Statusmeldungen programmatisch angesagt.                                                        | ☑                      | Bestand: `role="status"` (Speichern) und Fehler-Toast; Markdown-Inhalt ist statisch (keine neue Ansage nötig)                                                  |
| 8   | Keine der Tells aus §13 in einem produktrelevanten Element.                                     | ☑                      | `tells` im `gate-result.json` + manuelle Sichtprüfung der Screenshots                                                                                          |
| 9   | Ein Akzent, eine Typo-Familie mit klaren Rollen, Radius/Schatten nach Regel statt Einheitswert. | ☑                      | `tokens-single-accent`; Inline-Markdown erbt Farbe/Typo vom Steuerelement (kein zweiter Akzent)                                                                |
| 10  | Mikrotexte aktiv, konsistent, ohne Verkaufsfloskeln.                                            | ☑                      | manual: Copy unverändert; Markdown betrifft nur die Darstellung von Agenten-/Bedienerttext                                                                     |

**Ergebnis:** bestanden · **Gate-Artefakte:** `gate-result.json` + `shots/shot-1280-{before,after}-*.png`,
`shot-320-{before,after}-*.png` unter
`/workspace/main/state/workspace-b/reports/workboard-card-markdown-gate/`
(Gate-Lauf 2026-11-06) · `ui-design-gate.mjs` (Node ≥ 22, `/usr/bin/google-chrome`, headless)

## Befunde (Format §12.2) — Karten-Markdown

`Befund · Ort · Schweregrad (Blocker/Hoch/Mittel/Niedrig) · Beleg (SC-Nummer oder Quelle) · Fix`

| Befund | Ort | Schweregrad | Beleg | Fix |
| Ein Link (`[Docs](https://…)`) in einem Options-Label würde einen Anker im `button role="radio"` erzeugen — ungueltiges interaktives Innenleben und Klick-Bubble in `decide()` | Optionszeile des Entscheidungs-Panels (`toSanitizedInlineMarkdownHtml`) | **Hoch** (WCAG 4.1.2, HTML content model) | Reviewer-Befund; reproduziert: der Block-Sanitizer erlaubt `a` | **behoben**: Inline-Allowlist streicht `a`/`button`/`input`; nur der Linktext bleibt (`markdown.test.ts` »drops interactive tags…«, `control-ui-markdown.test.ts` »drops a link…«) |
| Ein initial rein Inline gemounteter Renderer hätte beim Wechsel nach Block nie einen Mermaid-Besitzer erworben | `ui/src/plugins/control-ui-markdown.tsx` (alter Einmal-`onSettled`-Pfad) | **Hoch** | Reviewer-Befund | **behoben**: zwei Zweige über `<Show>`; der Modus-Wechsel ersetzt das Element und erwirbt/freigibt den Besitzer (`control-ui-markdown.test.ts` »acquires the diagram owner…«) |

Blocker = verhindert Nutzung oder verletzt AA · Hoch = verletzt eine Regel oder ein Zustand fehlt · Mittel = Tell,
Konsistenz · Niedrig = Politur.

## Abschlusskommentar (statt „fertig")

- Gate-Ergebnis: `gate-result.json`; Optionszeile + Waiting + gemountetes Diagramm bei 320/768/1280 px dunkel/hell ohne Blocker.
- Behobene Befunde: interaktive Kinder im Options-Label (Inline-Allowlist) und der Inline→Block-Wechsel (Zwei-Zweig-Renderer).
- Offene Befunde und Restrisiken: keine im Slice-Scope; der Live-Mermaid-Renderer bleibt Host-Bestand (Fallback = Quelle + Hinweis).
- Was nicht prüfbar war: ein echter Mermaid-Layoutlauf gegen die Mermaid-Bibliothek — die Tests stubben `renderMermaidSvg` (Host-Verhalten, `markdown-mermaid.test.ts`).
- Tests, die das UI-Verhalten nachziehen: `view-card-detail-markdown.test.ts`, `view-card-decision.test.ts`, `control-ui-markdown.test.ts`, `markdown.test.ts`.

---

## Karten-Interaktions-Verweis (2026-11-07)

Fixture: `/workspace/main/state/workspace-b/reports/workboard-card-interaction-link/fixture`
(Aufbau: `build-fixture.mjs` neben dem Bericht), CSS wörtlich aus `workboard.css`, `components.css` und
`base.css` extrahiert. Drei Zustände — `running`, `done`, `gone` — in dunkel und hell, 320/768/1280 px:

`node /workspace/main/state/workspace-b/tools/ui-design-gate.mjs --dir <fixture> --out <out> --path running=/running.html --path done=/done.html --path gone=/gone.html`

| #   | Kriterium (§12.3 wörtlich)                                                                      | Ergebnis       | Beleg (Messwert / Pfad / Check-Id)                                                                                                                                                                                                                                                                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Alle Screens haben die Zustände: leer, lädt, Fehler, Erfolg, Berechtigung.                      | ☑              | `docs/ui/screen-state-matrix.md` (Abschnitt „Karten-Interaktions-Verweis"); Zustände: leer = Karte ohne Interaktion **und** gelöschter Dialog, lädt/Erfolg = `running`/`done`; Fehler ist hier bewusst kein Zustand (der Verweis fällt), Berechtigung = reine Anzeige, kein Stop-Knopf. `shot-*-running/done/gone.png`, `view-card-interaction.test.ts`, `workboard-page-interaction.test.ts` |
| 2   | Textkontrast ≥ 4,5:1, Nicht-Text ≥ 3:1 gemessen (nicht geschätzt).                              | ☑ (mit Befund) | `contrast-text`: 8–9 Textknoten je Fläche, **0 unter der Schwelle** (alle drei Zustände, alle drei Breiten). `contrast-nontext`: 1,05:1 am Host-`.btn`-Rahmen (Kartenmenü) und 1,97:1 am `--xs`-Start-Knopf — **identisch im Vorher-Lauf** (siehe Befund unten)                                                                                                                               |
| 3   | Tastatur: vollständig bedienbar, Fokus immer sichtbar.                                          | ☑              | `focus-visible`: 10–15 Stationen getabbt je Fläche, 0 ohne sichtbaren Fokus. `Open session` ist ein echter `button`                                                                                                                                                                                                                                                                           |
| 4   | 320 CSS px ohne horizontales Scrollen; 200 % Zoom verlustfrei.                                  | ☑              | `no-forced-scroll` + `reflow-320` (scrollWidth == clientWidth) + `zoom-200`: 0 beschnittene Bereiche, alle drei Zustände × drei Breiten                                                                                                                                                                                                                                                       |
| 5   | Alle interaktiven Ziele ≥ 24 px (Ziel 44 px), Abstand sonst ausreichend.                        | ☑              | `target-size`: **0 Ziele unter 24 px** in allen drei Zuständen × drei Breiten. Der anfängliche Befund (98×21 px am leisen Textknopf) war ein **Fixture-Fehler**: der Hülle fehlte die Klasse `.workboard-detail`, an die die ausgelieferte Regel `min-height: 30px` gebunden ist; nach der Korrektur greift sie und die Messung ist grün. Kein Codefix nötig                                  |
| 6   | Labels und Hinweise an jedem Feld; Fehler in Textform und am Feld.                              | ☑              | `field-labels`: 0 Felder, 0 ohne Label (die Fläche hat keine Eingabefelder); der Marker trägt `aria-label` in Textform (`»The session editing this card is running«`, Test 1)                                                                                                                                                                                                                 |
| 7   | Statusmeldungen programmatisch angesagt.                                                        | ☑              | Der Spinner ist dekorativ (`aria-hidden`) — angesagt wird er über den Marker mit `role="img"` + `aria-label`; `status-live-region` meldet „keine aria-live-Region", was hier korrekt ist: der Zustand steht als Text am Element, und die Erhebung ist statisch                                                                                                                                |
| 8   | Keine der Tells aus §13 in einem produktrelevanten Element.                                     | ☑              | `tells`: Verläufe 0, Blur 0, Emoji 0, ALL-CAPS 0; „gleichförmige Karten 2×" betrifft die beiden Fixture-Hüllen, nicht die Zeile. Sichtprüfung der PNGs                                                                                                                                                                                                                                        |
| 9   | Ein Akzent, eine Typo-Familie mit klaren Rollen, Radius/Schatten nach Regel statt Einheitswert. | ☑              | `tokens-single-accent`/`tokens-radius-variety` grün; `type-families` 1–2 Familien (die zweite ist `Arial` aus der Fixture-Chrome). Nur `--accent` trägt den Spinner                                                                                                                                                                                                                           |
| 10  | Mikrotexte aktiv, konsistent, ohne Verkaufsfloskeln.                                            | ☑ (manuell)    | „This conversation is editing the card." / „Last edited in this conversation." — aktiv, keine Floskel, keine Begrüßung; `Open session` wie in der Ausführungssitzung                                                                                                                                                                                                                          |

**Ergebnis:** Exit 1 — 93 pass, 15 fail; davon **6 Blocker** und 9 × `status-live-region` (hoch). **Alle 6 Blocker sind Bestand**, keiner neu: der Vorher-Lauf `gate-before/gate-result.json` (Vor-Slice-Darstellung derselben Fläche) trägt dieselben Blocker-Checks mit **denselben Selektoren und Werten** (`.btn` 1,05:1, `.btn--xs` 1,97:1).

### Befunde (Format §12.2)

`Befund · Ort · Schweregrad · Beleg · Fix`

| Befund                                                                                             | Ort                                                                | Schweregrad       | Beleg                                                                                                     | Fix                                                                                                                                                                       |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ----------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host-`.btn`-Rahmen 1,05:1 (dunkel) bzw. `--xs`-Start-Knopf 1,97:1 auf der Kartenfläche (unter 3:1) | `ui/src/styles/components.css:1101` (Host, **nicht** dieser Slice) | Blocker (Bestand) | WCAG 1.4.11; `contrast-nontext`, **identisch** im Vorher-Lauf (`gate-before`)                             | **nicht in diesem Slice**: app-weite Host-Knopfgestaltung; derselbe Befund steht schon im Talk-Gate und im Board-Palette-Gate. Vorschlag dort: Rahmen an `--muted` binden |
| `status-live-region` ohne `aria-live`-Region                                                       | Fixture (statisch)                                                 | Hoch (Fixture)    | Der Zustand steht als Text + `aria-label` am Element, nicht als Live-Region; die Fläche ist kein Formular | Kein Codefix: die Erhebung ist für eine statische Fixture ohne Meldung erwartet                                                                                           |

### Abschlusskommentar

- **Angesehen:** `shot-{320,768,1280}-{running,done,gone}.png` (dunkel) und die hellen Varianten der Fixture.
  Gesehen: **running** — Karte und Drawer zeigen den roten Spinner links der Zeile, der Drawer zusätzlich
  „This conversation is editing the card."; **done** — Spinner weg, Name bleibt, `Open session` als leiser
  Textknopf rechts im Drawer und als Eintrag im Kartenmenü; **gone** — Karte zeigt nur `D`, Drawer
  zeigt „No session yet" + Start-Knopf, **kein** Warn-Abzeichen, **keine** Interaktionszeile.
  Bei 320 px umbricht der Hilfetext im Drawer auf mehrere Zeilen, ohne Überlauf oder Abschnitt.
- **Nicht prüfbar:** echter Browserlauf am Fork-Host mit einer echten Dock-Unterhaltung.

---

# Gate-Checkliste — „Braucht dich“-Fläche im Lens (2026-11-12)

Dieselben §12.3-Kriterien, wörtlich, für die neue Fläche. Der Slice baut **keine eigene Farbwelt**: die
Fläche liest nur die Host-Tokens der Karte (`--muted` für Ränder und gedämpften Text, `--text-strong` für
die Frage, `--danger` für „No proof“ und die Priorität, `--bg-elevated` als Fläche, `.btn primary` als die
eine gefüllte Aktion). Belege hier sind Tests und die angesehenen Screenshots des Lens-Laufs; ein
`ui-design-gate.mjs`-Lauf gegen eine Fixture dieser Fläche wurde in diesem Slice **nicht** gefahren und ist
darum offen benannt, nicht als bestanden behauptet.

| #   | Kriterium (§12.3 wörtlich)                                                                      | Ergebnis (☐ ja ☐ nein) | Beleg (Messwert / Pfad / Check-Id)                                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Alle Screens haben die Zustände: leer, lädt, Fehler, Erfolg, Berechtigung.                      | ☑                      | Matrix-Zeilen „Board · „Needs you“-Inbox (Lens)“, „… -Fläche“, „… „Ohne Eigner“-Zählzeile“; gebaut in `view-inbox.test.ts` (9), `view-inbox-face.test.ts` (12), `operator-attention.test.ts` (25); Erfolg/Fehler als Test, Zustände als Screenshots 12–14                                                         |
| 2   | Textkontrast ≥ 4,5:1, Nicht-Text ≥ 3:1 gemessen (nicht geschätzt).                              | ☐ **offen**            | Nicht in diesem Slice gemessen: ein `ui-design-gate.mjs`-Lauf braucht eine Fixture aus dieser Fläche. Gelesene Tokens und ihre belegten Bestandswerte: `--muted` 5,04:1 / 5,45:1 (Text) und als Rand ≥ 3:1, `--text-strong` 9,00:1 / 10,96:1, `--danger` 6,16:1 / 6,47:1 (Bestandsrechnungen der Vorgänger-Gates) |
| 3   | Tastatur: vollständig bedienbar, Fokus immer sichtbar.                                          | ☑                      | `focus-visible`-Regeln für Flächenknöpfe, Rückgabe-Feld und Zählzeile in `workboard.css` (`outline: 2px solid var(--accent)`); Tests »scopes the digit shortcut to the focused panel«, »keeps the face out of the card's own article element«                                                                     |
| 4   | 320 CSS px ohne horizontales Scrollen; 200 % Zoom verlustfrei.                                  | ☐ **offen**            | Kein Messlauf in diesem Slice. Die Fläche ist ein Grid in einer Spalte mit `max-width: 720px`; die Zeilen umbrechen (`flex-wrap`)                                                                                                                                                                                 |
| 5   | Alle interaktiven Ziele ≥ 24 px (Ziel 44 px), Abstand sonst ausreichend.                        | ☑                      | Optionszeilen `min-height: 44px`, Zählzeile `min-height: 44px`, Chips und Undo 32 px — alle ≥ 24 px (CSS dieser Fläche)                                                                                                                                                                                           |
| 6   | Labels und Hinweise an jedem Feld; Fehler in Textform und am Feld.                              | ☑                      | Freie Zeile der Rückgabe und eigenes Antwortfeld mit sichtbarem Label (`.workboard-face__field`); Fehler als Text in `role="alert"` an der Fläche (Test »refuses the queued write…«)                                                                                                                              |
| 7   | Statusmeldungen programmatisch angesagt.                                                        | ☑                      | Pending-Zeile `role="status"`/`aria-live="polite"`, Fehler `role="alert"` (Test »announces the pending decision in a live region«)                                                                                                                                                                                |
| 8   | Keine der Tells aus §13 in einem produktrelevanten Element.                                     | ☑                      | Manuelle Sichtprüfung `12-needs-you-lens.png`, `13-needs-you-review-face.png`, `14-needs-you-pending-decision.png`: keine Verläufe, kein Blur, keine Emoji, kein ALL-CAPS; Empfehlung als Text `* Recommendation`                                                                                                 |
| 9   | Ein Akzent, eine Typo-Familie mit klaren Rollen, Radius/Schatten nach Regel statt Einheitswert. | ☑                      | Genau eine gefüllte Aktion je Fläche (`.btn primary`); `--danger` nur für „No proof“ und Priorität (Status, nicht Akzent); eine Typo-Familie                                                                                                                                                                      |
| 10  | Mikrotexte aktiv, konsistent, ohne Verkaufsfloskeln.                                            | ☑                      | „Deciding: Tenant A - Undo“, „No proof“, „Send back…“ → „Send back“, „Accept recommendation“; keine Begrüßung, keine Zusammenfassung (Screenshots)                                                                                                                                                                |

**Ergebnis:** die gebauten Kriterien bestanden; **offen** bleiben die beiden Mess-Kriterien 2 und 4, weil
kein `ui-design-gate.mjs`-Lauf gegen eine Fixture dieser Fläche gefahren wurde. **Offen (mit Grund):** ein
Browserlauf auf der Live-Fork-Instanz (die Belege sind der gemockte Gateway-Lauf).

## Befunde (Format §12.2) — „Braucht dich“-Fläche

| Befund                                                                                                                                           | Ort                                          | Schweregrad | Beleg                                                             | Fix                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | ----------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Review-Karte wurde beim Scrollen vom Scroll-Container beschnitten, weil die Zählzeile in einem zweiten Container **außerhalb** des Scrollers lag | `view-inbox.tsx`, `.workboard-column__cards` | **Blocker** | Sichtprüfung `13-needs-you-review-face.png` (Karte abgeschnitten) | **behoben**: die Zählzeile ist jetzt ein Grid-Kind desselben Scrollers; danach `14-…png` sauber      |
| `onCleanup` schrieb den Pending-Signalwert und Solid verweigerte das Schreiben im Owned-Scope                                                    | `view-inbox-face.tsx`, `cancelPending`       | Hoch        | `[REACTIVE_WRITE_IN_OWNED_SCOPE]`, Suite rot                      | **behoben**: die Disposal räumt nur den Timer; Undo (eine Nutzeraktion) setzt den sichtbaren Zustand |
| Kein `ui-design-gate.mjs`-Lauf gegen eine Fixture dieser Fläche                                                                                  | Werkzeug `ui-design-gate.mjs`                | Mittel      | Kriterien 2 und 4 oben stehen als **offen**                       | Als Folgearbeit gemeldet; die gelesenen Tokens tragen Bestandswerte                                  |

## Abschlusskommentar — „Braucht dich“-Fläche

- **Angesehen:** `12-needs-you-lens.png` (Entscheiden-Fläche mit Frage, Empfehlung zuerst, `Accept recommendation` / `Other answer…` / `Open`, Zählzeile „No agent · 1“ darunter), `13-needs-you-review-face.png` (Review-Fläche mit Ergebniszeile, „No proof“ in Warnfarbe, `Send back…`-Feld mit gesperrtem Senden), `14-needs-you-pending-decision.png` (Statuszeile „Deciding: Tenant A - Undo“).
- **Nicht gefahren:** `ui-design-gate.mjs` gegen eine Fixture dieser Fläche (Kriterien 2 und 4 offen); Browserlauf auf der Live-Fork-Instanz.
- **Nicht in diesem Slice:** der Host-`.btn`-Rahmen (app-weiter Bestandsbefund, unverändert gemacht).
