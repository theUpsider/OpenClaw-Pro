# Komponentenliste (geschlossen) — Workboard Talk-Gate und Wirkungs-Protokoll

Was nicht hier steht, wird nicht erfunden (Vault-Notiz §2.3, §7). Eine neue Komponente wird **im selben
Commit** hier ergänzt, mit Zweck und Zuständen. Ein `div` mit Klick-Handler, wo ein Button gehört, ist ein
Befund.

Status: `fest` (im Vertrag, gebaut) · `geplant` (im Vertrag, noch nicht gebaut) · `erwogen` (Fluss verlangt es,
Entscheidung offen).

Der Slice baut **keine eigene Komponentenbibliothek**. Er benutzt die Host-Bausteine, die auf diesen Flächen
schon stehen (Dialog über `host-components.tsx`), und ergänzt genau zwei plugin-eigene Bausteine.

## Liste

| Name                                    | Zweck                                                                         | Varianten                                               | Zustände                                                                           | Steht auf der Liste |
| --------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------- |
| `VoiceTranscriptGate` (Dialog)          | Erkannter Text vor dem Ausführen: lesen, korrigieren, absenden oder verwerfen | board-weit, karten-bezogen (nur die Zielzeile wechselt) | offen, gesendet, Fehler, verworfen, schreibgeschützt (Absenden gesperrt mit Grund) | fest                |
| `VoiceAttributionLine` (Textzeile)      | „Führt aus: &lt;Agent&gt; · &lt;Ziel&gt;" — wer handelt und woran             | Board, Karte                                            | Agent bekannt, Agent vorläufig (lädt), Agent nicht ermittelbar                     | fest                |
| `VoiceSentNotice` (Statuszeile)         | Kurze Quittung nach dem Absenden; öffnet gedanklich die Dock-Antwort          | Board, Karte                                            | sichtbar, nach nächster Aufnahme ersetzt                                           | fest                |
| `VoiceErrorNotice` (Statuszeile)        | Senden abgelehnt oder gescheitert; der Text bleibt erhalten                   | –                                                       | sichtbar (aria-live)                                                               | fest                |
| `EventAttributionRow` (Verlaufszeile)   | Ein Karten-Event mit Urheber-Agent und Zeitstempel                            | mit Agent, ohne Agent (ältere Einträge)                 | normal, ohne Urheber                                                               | fest                |
| Mikrofon-Affordanz (`DictationControl`) | Aufnahme starten/stoppen — Host-Baustein, unverändert                         | Board, Karte                                            | ruhend, aufnehmend, deaktiviert (sendend), nicht verfügbar                         | fest (Host)         |
| Dialogflächen-Chrome (`Dialog`)         | Umhüllung des Gates — Host-Baustein, unverändert                              | –                                                       | offen, abgebrochen                                                                 | fest (Host)         |
| Button                                  | Aktion auslösen — Host-Baustein, unverändert                                  | primär ([Absenden]), sekundär ([Verwerfen])             | normal, hover, focus-visible, aktiv, deaktiviert, ladend                           | fest (Host)         |

## Nicht auf der Liste (bewusst abgelehnt)

| Element                                              | Warum nicht                                                                                         |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Waveform / Aufnahme-Pegel-Anzeige                    | Tell und ohne Funktion: der Host-Diktierknopf zeigt den Aufnahmezustand bereits (§13)               |
| „Ich verstehe"-Bestätigungsblase mit Zusammenfassung | zweite Sprachpipeline; der Agent bekommt genau den bestätigten Text                                 |
| Eigenes Token-/Farbset für Talk                      | Feature-Farbe wäre die zweite Sprachpipeline; `--accent-2` ist im Host belegt                       |
| Toast nach dem Absenden                              | Die Quittung ist der Verlaufseintrag; ein Toast überlebt keinen Reload (siehe `DESIGN.md`)          |
| Fortschrittsbalken für den laufenden Turn            | Der Turn läuft in der Dock-Unterhaltung; ein zweiter Fortschrittsanzeiger wäre eine zweite Wahrheit |
| Rücknahme / Undo-Knopf                               | Neue Mutationsfläche, nicht im Auftrag (§Nicht-Ziele)                                               |
| „Vertrauenswürdig"-Abzeichen am Agenten              | Bewertet Agenten statt zu benennen, wer handelt — keine Datenquelle dafür                           |

## Regeln

1. Jede Komponente hat eine Datei/Exportstelle, die ihre Zustände vollständig definiert.
2. Neue Komponente = Eintrag hier + Eintrag in der Zustandsmatrix (falls Screen-relevant) im selben Commit.
3. Keine Framework-Kit-Komponente unverändert übernehmen: entweder an eigene Tokens gebunden oder bewusst als
   Ausnahme im `DESIGN.md` begründet.

---

## New-card-Dialog: Sprachentwurf (2026-11-03)

Zwei neue Bausteine, beide in `view-card-modal.tsx`; alles andere ist vorhanden.

| Name                                                     | Zweck                                                                                              | Varianten                       | Zustände                                                                                                | Steht auf der Liste |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------- |
| `NewCardVoiceDraft` (Mikrofon im Dialog-Kopf)            | Einen Satz aufnehmen, der das Formular befüllt — Host-`DictationControl`, plugin-seitig verdrahtet | nur New card (nicht Bearbeiten) | ruhend, aufnehmend (Host), entwerfend (gesperrt mit Grund), gesperrt (schreibgeschützt/busy, mit Grund) | fest                |
| `NewCardDraftStatus` (Statuszeile, `aria-live="polite"`) | Sagt, was das Mikrofon gerade tut bzw. getan hat, und listet verworfene Angaben                    | –                               | verborgen (nie gesprochen), entwerfend, befüllt, befüllt mit Hinweisen, nichts erkannt                  | fest                |
| `WorkboardErrorToast` (vorhanden)                        | Fehler des Entwurfs (Server/Aufnahme) — unverändert wiederverwendet                                | –                               | sichtbar, verborgen                                                                                     | fest (Bestand)      |

### Nicht auf der Liste (bewusst abgelehnt) — New card

| Element                                  | Warum nicht                                                                               |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| Transkript-Gate vor dem Befüllen         | Nichts wird ausgeführt; das Formular ist die Bestätigung (siehe `DESIGN.md`)              |
| „Übernehmen"/„Verwerfen"-Knöpfe pro Feld | Das Formular ist schon editierbar; ein zweiter Bestätigungsweg pro Feld verdoppelt Create |
| Hervorhebung/Färbung befüllter Felder    | Farbe wäre einziges Signal; die Statuszeile benennt den Vorgang in Text                   |
| Erfolgs-Toast                            | Toast ist die Fehlerfläche des Dialogs und verschwindet vor dem Prüfen                    |
| Spinner über dem Formular                | Sperrt optisch, was bedienbar bleibt; die Statuszeile trägt den Ladezustand               |

---

## Artefakt per Kanal teilen (2026-11-03)

Vier plugin-eigene Bausteine; Dialog, `SelectPicker` und Button sind Host-Bestand.

| Name                                                    | Zweck                                                                                                    | Varianten                                  | Zustände                                                                                                     | Steht auf der Liste |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------- |
| `ArtifactShareAction` (Textknopf „Share…" an der Zeile) | Öffnet den Teilen-Dialog für genau diese Zeile; danach trägt er die Quittung daneben                     | – (nur Zeilen mit `href` oder `reference`) | ruhend, Dialog offen, gesendet (Quittung `role="status"` an der Zeile), verborgen (kein Verweis / offline)   | fest                |
| `ArtifactShareDialog` (Host-`Dialog`)                   | Vorschau der Nachricht, Kanal-/Konto-Wahl, Ziel, Send/Cancel                                             | ein Konto, mehrere Konten (Konto-Picker)   | Kanäle laden, keine Kanäle, Kanäle-Ladefehler, bereit, kein Ziel, schreibgeschützt, sendet, Fehler, gesendet | fest                |
| `ShareMessagePreview` (`code`-Block)                    | Zeigt genau den Text, der gesendet wird (Label + Verweis bzw. nur Verweis)                               | zwei Zeilen, eine Zeile (Label = Verweis)  | statisch                                                                                                     | fest                |
| `ShareRecipientField` (`settings-input` + `datalist`)   | Ziel im Kanalformat; sichtbares Label, Hilfetext, Grund/Fehler darunter; optional Vorschläge (nur Admin) | mit Vorschlägen, ohne Vorschläge           | leer (Grund), gefüllt, gesperrt (sendet), Fehler (am Feld)                                                   | fest                |
| `SelectPicker` (Host, vorhanden)                        | Kanal- und Konto-Auswahl                                                                                 | Kanal, Konto                               | normal, gesperrt (sendet)                                                                                    | fest (Host)         |
| `Dialog` (Host, vorhanden)                              | Umhüllung, Fokus-Policy, Escape                                                                          | –                                          | offen, abgebrochen (Escape während des Sendens gesperrt)                                                     | fest (Host)         |
| Button (Host, vorhanden)                                | **Send** primär (der eine Akzent), **Cancel** sekundär, „Share…" sekundär                                | primär, sekundär                           | normal, hover, focus-visible, deaktiviert mit Grund                                                          | fest (Host)         |

### Nicht auf der Liste (bewusst abgelehnt) — Artefakt teilen

| Element                                   | Warum nicht                                                          |
| ----------------------------------------- | -------------------------------------------------------------------- |
| Datei-Upload / „als Anhang senden"        | Neue Authority-Fläche; der Artefakt-Block inlinet bewusst nie Medien |
| Editierbares Nachrichtenfeld              | Würde die feste Form „Label + Verweis" aufheben                      |
| Kanal-Kacheln mit Logos/Farben            | Fremde Farbwelt pro Kanal; skaliert nicht auf Konten                 |
| Teilen-Icon ohne Text                     | Einziges Icon in einer Textknopf-Leiste, mehrdeutig                  |
| Erfolgs-Toast                             | Toast ist die Fehlerfläche des Drawers und verschwindet              |
| Verlaufseintrag „geteilt"                 | Server-Event = neue Schreibfläche im Store (Nicht-Ziel)              |
| Thread-/Konto-Auswahl aus dem Verzeichnis | Das Verzeichnis ist nur Vorschlagsquelle, nie Routing-Wahrheit       |

---

## Entscheidungskarte als Ask-Dialog (2026-11-03)

Vier plugin-eigene Bausteine in `view-card-decision.tsx`; Button und Fehler-Toast sind Bestand.

| Name                                                                       | Zweck                                                                                                  | Varianten                                                                                                   | Zustände                                                                                                                              | Steht auf der Liste |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `DecisionOptionList` (`role="radiogroup"`)                                 | Die Antworten des Agenten als nummerierte Auswahl; Tastatur: Ziffern, Pfeile/Home/End, Enter/Leertaste | strukturiert (Stufe 1), Notes-Checkboxen (Stufe 2); fehlt ganz ohne Optionen (Stufe 3)                      | bereit, gesperrt (busy/offline), Entscheidung läuft, Entscheidung gespeichert aber nicht verschoben (gewählte Option bleibt markiert) | fest                |
| `DecisionOptionRow` (`button role="radio"`, `.workboard-decision__option`) | Eine Option: Nummer `1.`, Label, optional Beschreibung und Badge; Klick entscheidet                    | mit Beschreibung, ohne Beschreibung, empfohlen                                                              | normal, hover, focus-visible (Roving-Tabindex `0`), gewählt (`aria-checked="true"`), deaktiviert                                      | fest                |
| `DecisionRecommendedBadge` (`.workboard-decision__recommended`)            | Markiert die eine empfohlene Option in Text („Recommended")                                            | –                                                                                                           | sichtbar (höchstens einmal), fehlt (Stufe 2 / keine Empfehlung)                                                                       | fest                |
| `DecisionCustomAnswer` (vorhandener `textarea` + Knöpfe)                   | Eigene Antwort; **Add note** (bleibt blockiert) / **Decision made** (Ready)                            | mit sichtbarer Zeile „Or write your own answer" (wenn Optionen da sind), ohne (Stufe 3, Überschrift genügt) | leer (Knöpfe gesperrt), gefüllt, gesperrt (busy/offline), Text bleibt nach Refusal                                                    | fest (Bestand)      |
| `DecisionSavingStatus` (`p role="status"`, `.workboard-decision__status`)  | Sagt an, dass die Entscheidung gespeichert wird; immer gemountet, damit die Ansage ankommt             | –                                                                                                           | leer (verborgen), „Saving your decision...“                                                                                           | fest                |
| Button (Host, vorhanden)                                                   | **Decision made** primär (der eine Akzent), **Add note** sekundär                                      | primär, sekundär                                                                                            | normal, hover, focus-visible, deaktiviert                                                                                             | fest (Host)         |
| `WorkboardErrorToast` (vorhanden)                                          | Refusal-/Schreibfehler (`decisionMoveFailed`) — unverändert                                            | –                                                                                                           | sichtbar, verborgen                                                                                                                   | fest (Bestand)      |

### Nicht auf der Liste (bewusst abgelehnt) — Ask-Dialog

| Element                                        | Warum nicht                                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Checkboxen für Mehrfachauswahl (`multiSelect`) | `Decision: …` ist eine Zeile; mehrere Antworten machen Note-Form und Ready-Move undeutbar     |
| Sortierung nach Empfehlung                     | Bricht die Nummern, die der Agent in der Frage nennt; die Listenreihenfolge ist die Nummer    |
| Auto-Submit beim Tippen / bei Pause            | Jede Pause würde die Karte verschieben; nur **Add note**/**Decision made** lösen Freitext aus |
| „Bestätigen"-Knopf nach Optionswahl            | Verdoppelt den Klick; die bestehende Semantik entscheidet sofort                              |
| Optionsvorschau (`preview`)                    | Nicht in der vereinbarten Form `{label, description?, recommended?}`                          |
| Leerer Optionscontainer „Keine Optionen"       | Rauschen; ohne Optionen ist das Freitextfeld die vollständige Oberfläche                      |
| Farbiges/akzentgefülltes Empfehlungs-Badge     | Zweiter Akzent; Farbe wäre das einzige Signal                                                 |

---

## „Braucht dich“-Marker auf Workboard-Karten (2026-11-04)

Ein plugin-eigener Baustein in `view-card-content.tsx` plus ein Kartenstreifen; Karte, Chips und
Klassifikationsstreifen sind Bestand.

| Name                                                           | Zweck                                                                                                                 | Varianten                                                                  | Zustände                                                                                                                                                          | Steht auf der Liste |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `CardNeedsYouMarker` (Pill `.workboard-card__needs-you`)       | Sagt in Text „Needs you“ / „Braucht dich“, dass die Karte auf den Operator wartet; `title` nennt die drei Gründe      | Grid-Karte (Meta-Zeile), Listen-Zeile (Titelzeile), kompakt                | sichtbar (Review, `blocked` + Label `decision`, oder ohne Agent in `triage`/`backlog`/`todo`/`ready`; nie archiviert), fehlt (kein Grund trifft zu) — nie doppelt | fest                |
| Aufmerksamkeits-Streifen (`.workboard-card--needs-you::after`) | Zweiter linker Streifen in `--workboard-card-attention` (= `--danger`), unabhängig vom Paletten-Streifen (`::before`) | Seite, Widget kompakt, Seite kompakt, Listen-Zeile (Insets wie `::before`) | allein (an der Paletten-Position), neben dem Klassifikationsstreifen (+4px), fehlt                                                                                | fest                |

### Nicht auf der Liste (bewusst abgelehnt) — „Braucht dich“-Marker

| Element                            | Warum nicht                                                                                                      |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Ein Marker je Grund (drei Pills)   | Überlappende Gründe wären Rauschen; die eine Frage ist „wartet sie auf mich?“, die Gründe stehen im `title`      |
| Gespeichertes Feld `needsOperator` | Zweite Wahrheit neben Status/Labels/Agent; müsste bei jedem Schreiben nachgezogen werden                         |
| Paletten-Slot „Braucht dich“       | Würde einen der 10 Klassifikations-Slots belegen und die Karte umfärben; Aufmerksamkeit ist kein Kartentyp       |
| Marker in `--accent`               | `--accent` ist der Fokusring der Karte und die eine gefüllte Aktion; ein Streifen in derselben Farbe verschwimmt |

---

## „Braucht dich“-Inbox (Lens) (2026-11-04)

Plugin-eigene Bausteine in `view-inbox.tsx`; Karte, Spaltenkopf, Chips und Leerzustand sind Bestand.

| Name                                                                           | Zweck                                                                                                                                   | Varianten                                                               | Zustände                                                                                | Steht auf der Liste   |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------- |
| `InboxToggle` (`button.workboard-inbox-toggle`)                                | Schaltet den Lens; `aria-pressed`, `aria-label` „Needs you (N)“, `title` erklärt Filter und Reihenfolge                                 | Desktop (neben Status-Tabs), mobil (neben dem Status-Picker, bricht um) | aus, an (`.active`), Zähler 0 (gedämpft), Zähler > 0 (`--danger`-Tönung), focus-visible | fest                  |
| `WorkboardInbox` (`section.workboard-column.workboard-inbox`)                  | Eine Spalte „Needs you“ mit Zähler, Karten in Inbox-Reihenfolge                                                                         | Board (Spalte bis 720px breit), Liste (Listen-Kopf + Zeilen)            | gefüllt; leer wird nie gerendert (dann Leerzustand)                                     | fest                  |
| `InboxWhy` (`p.workboard-inbox__why`)                                          | Über jeder Karte: alle Gründe („Review · Decision · No agent“) und „Entered {Status} {vor …}“ (`<time>`, `title` mit genauem Zeitpunkt) | Board, Liste                                                            | ein bis drei Gründe; Zeit tickt über `RelativeTime`                                     | fest                  |
| Lens-Chip (`ActiveFilters`, id `inbox`)                                        | Beschreibt das Ergebnis ehrlich als gefiltert; ✕ schaltet den Lens aus                                                                  | –                                                                       | sichtbar solange der Lens an ist                                                        | fest (Bestand)        |
| Leerzustand „Nothing needs you“ / „No cards that need you match these filters“ | Unterscheidet „nichts wartet“ von „Filter verdecken Wartendes“                                                                          | „Show all cards“ (Lens aus) / „Clear other filters“ (Lens bleibt)       | `role="status"`                                                                         | fest (Bestand-Muster) |

### Nicht auf der Liste (bewusst abgelehnt) — Inbox-Lens

| Element                                      | Warum nicht                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| Statusspalten mit Inbox-Sortierung je Spalte | Keine globale Reihenfolge; die dringendste Karte stünde irgendwo rechts             |
| „Wartet seit“ für Label/Agent                | Der Store zeichnet nicht auf, wann `decision` gesetzt oder der Agent entfernt wurde |
| Gespeicherter Lens-Zustand / Kartenfeld      | Reine Ansicht; nichts davon gehört in den Store                                     |
| Eigene Sortierwahl im Lens                   | Die Reihenfolge ist der Sinn des Lens; eine zweite Wahl würde ihn verwässern        |

---

## „Braucht dich“-Fläche im Lens (Entscheiden/Review) (2026-11-12)

Ein neuer Baustein und zwei erweiterte; Karte, Grundstreifen-Glyphen und Knöpfe sind Host-Bestand.
Die Fläche steht **neben** der Karte, nie in ihr: `article[role="button"]` darf keine
Formularfelder enthalten (WCAG 4.1.2), und der Drag der Karte würde die Textauswahl schlagen.

| Name                                                 | Zweck                                                                                                                                                                                             | Varianten                                                       | Zustände                                                                                                                                                | Steht auf der Liste |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `WorkboardInboxFace` (`section.workboard-face`)      | Entscheidet eine wartende Karte ohne Drawer: Grundstreifen, Frage/Ergebnis, Optionen bzw. Belegzeile, Aktionen; eigener `aria-label` + eigene `h3`, Tastatur auf das fokussierte Panel beschränkt | Entscheiden (`--decision`), Review (`--review`)                 | schreibbar, gesperrt (read-only/busy), pending (`Deciding: … - Undo`, `role="status"`), Fehler (`role="alert"`), Beleg fehlt („No proof“ in `--danger`) | fest                |
| `FaceStrip` (`.workboard-face__strip`)               | Glyph + Grund (Decide/Review) + „in {Status} {vor …}“ + Priorität nur bei high/urgent                                                                                                             | Entscheiden (4 Gründe), Review                                  | Priorität hoch/urgent, Priorität normal (kein Chip)                                                                                                     | fest                |
| Optionszeile (`.workboard-face__option`, `.btn`)     | Eine Option aus `resolveWorkboardDecisionOptions`: Nummer, Label, `* Recommendation` als **Text**; Klick entscheidet nach Ablauf                                                                  | empfohlen (`.primary`, zuerst), normal                          | normal, hover, focus-visible, gesperrt, pending (Karte schreibt noch nicht)                                                                             | fest                |
| Belegzeile (`.workboard-face__evidence`)             | „{N} proof · {N} files“ plus ein Link je Eintrag mit URL; ohne Beleg explizit „No proof“ in Warnfarbe                                                                                             | mit Beleg (Links), ohne Beleg („No proof“)                      | Fehlt der Beleg, wird `Accept` zur Nebenaktion statt zum Primärknopf                                                                                    | fest                |
| Rückgabe-Feld (`.workboard-face__send-back`)         | „Send back“ verlangt einen Grund: 2–3 Chips plus eine freie Zeile; ohne Grund bleibt der Knopf gesperrt                                                                                           | Chips (No proof / Not what was asked / Unfinished), freie Zeile | leer (Knopf gesperrt), Chip gewählt, eigener Text, gesperrt                                                                                             | fest                |
| `UnownedRow` (`button.workboard-inbox__unowned-row`) | Die agentenlose Restmenge als **eine** Zählzeile „No agent · N“, `aria-expanded` trägt den Zustand, Standard **eingeklappt**                                                                      | Lens an (nur wenn agentenlose Karten da sind)                   | eingeklappt (Karten nicht gerendert), aufgeklappt (Karten darunter), focus-visible                                                                      | fest                |

### Nicht auf der Liste (bewusst abgelehnt) — „Braucht dich“-Fläche

| Element                                   | Warum nicht                                                                                                                                                                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sofortiger Schreibvorgang + „Undo“-Knopf  | Sobald die Karte `ready` ist, kann ein Dispatch sie greifen, bevor Undo geklickt wird; ein Move ohne `expectedUpdatedAt` ist last-writer-wins und kann eine laufende Karte zurückziehen. Deshalb: erst nach Ablauf schreiben, Undo bricht nur den geplanten Schreibvorgang ab |
| Knöpfe **in** `article.workboard-card`    | Genestete interaktive Inhalte in einem `role="button"` (WCAG 4.1.2) und Drag gegen Textauswahl; die Fläche ist darum ein Geschwister                                                                                                                                          |
| Eigener Zähler-/Chip-Block auf der Fläche | Die Karte daneben trägt keine Zählzeile mehr; die Belegzeile der Fläche ist der einzige Beleg-Ort                                                                                                                                                                             |
| Zifferntasten global im Lens              | Mehrere Entscheid-Flächen würden alle 1–4 beanspruchen; die Tasten gelten nur für das fokussierte Panel                                                                                                                                                                       |
| Prioritäts-Chip bei `normal`              | Vorhandene Regel der Karte (`CardPriority` zeigt `normal` nie) bleibt die einzige Wahrheit                                                                                                                                                                                    |
| Farbe als einziges Signal der Empfehlung  | `* Recommendation` steht als Text im Knopf; die Füllung des Knopfes ist der eine Akzent                                                                                                                                                                                       |

---

## Board-Palette im Board-Dialog (2026-11-04)

Zwei neue Bausteine in `view-board-palette.tsx`; Feld, Knopf und Dialog sind Host-Bestand.

| Name                                                           | Zweck                                                                                      | Varianten                     | Zustände                                                                                     | Steht auf der Liste |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------- | -------------------------------------------------------------------------------------------- | ------------------- |
| `BoardPaletteEditor` (Feldgruppe im Board-Dialog)              | Bis zu zehn Slots pflegen: Name, Farbe, Reihenfolge, hinzufügen, entfernen                 | Cards-Board (Sessions: keine) | leer, ein/zwei/zehn Slots, ungültig (Fehler am Feld), schreibgeschützt (gesperrt), speichert | fest                |
| `WorkboardPaletteDraftEntry` (Draft + `readBoardPaletteDraft`) | Draft-Zeilen mit stabiler `key`; `changed`/`palette`/`error` gegen den gespeicherten Stand | –                             | unverändert, geändert, ungültig                                                              | fest                |

### Nicht auf der Liste (bewusst abgelehnt) — Board-Palette

| Element                        | Warum nicht                                                                 |
| ------------------------------ | --------------------------------------------------------------------------- |
| Drag-&-Drop-Sortierung         | Tastatur/Touch-unzuverlässig; Auf/Ab genügt für ≤10 Zeilen                  |
| Freies Hex-Farbfeld            | Zweite Farbwelt; die acht Session-Farben sind der Vertrag                   |
| Farbige Slot-Badges            | Divergiert nur die Optik; die Karte trägt die Farbe über den Akzentstreifen |
| „Labels mit umbenennen"-Option | Verändert Kartendaten, die der Auftrag ausnimmt                             |

---

## Anhang öffnen und herunterladen (2026-11-06)

Drei plugin-eigene Bausteine; Dialog und Markdown-Mount sind Host-Bestand. Die Zeile ist dieselbe
`.workboard-artifacts__row` wie bei Artefakten — es kommt keine zweite Zeilenkomponente dazu.

| Name                                                        | Zweck                                                                                                             | Varianten                                                                                           | Zustände                                                                                      | Steht auf der Liste |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------- |
| `AttachmentActions` (Knopfleiste an der Anhang-Zeile)       | **Download** an jeder Anhang-Zeile, **Open** nur für Typen, die diese App selbst rendert; Quittung/Fehler daneben | Download allein (text/html, image/svg+xml, application/pdf), Download + Open (Markdown, Rasterbild) | ruhend, ladend (Knopf gesperrt), Fehler (`role="status"` an der Zeile), ohne Client verborgen | fest                |
| `AttachmentViewerDialog` (Host-`Dialog`)                    | Zeigt genau einen Anhang, dessen Typ die App selbst rendert; Bytes bleiben hinter dem Gateway-RPC                 | Markdown (Host-Mount), Rasterbild (`<img>` mit Blob-URL)                                            | lädt, bereit, nicht darstellbar, abgelehnt, Fehler                                            | fest                |
| `attachmentViewKind` / `attachmentReadFailure` (Funktionen) | Eine Stelle entscheidet, welcher Typ in-app geöffnet wird und was ein gescheiterter Lesevorgang sagt              | –                                                                                                   | Typ mit Viewer, Typ ohne Viewer; abgelehnt (Scope), Fehler (Transport)                        | fest                |
| `Dialog` (Host, vorhanden)                                  | Umhüllung, Fokus-Policy, Escape                                                                                   | –                                                                                                   | offen, abgebrochen                                                                            | fest (Host)         |
| `Markdown` (Host, vorhanden)                                | Sanitisierender Mount für Markdown-Anhänge                                                                        | document                                                                                            | lädt (Host), bereit                                                                           | fest (Host)         |
| Button (Host, vorhanden)                                    | **Download** und **Open** sekundär, Rand an `--muted` wie `Copy path`/`Share…`                                    | sekundär                                                                                            | normal, hover, focus-visible, deaktiviert (Lesevorgang läuft)                                 | fest (Host)         |

### Nicht auf der Liste (bewusst abgelehnt) — Anhang ansehen

| Element                                       | Warum nicht                                                                                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Viewer für `text/html` und `image/svg+xml`    | Vom Angreifer beeinflussbarer Typ mit Skriptausführung; die Zeile lädt sie nur als undurchsichtige Bytes herunter                            |
| PDF-Viewer im Dialog                          | Gemessen: ein sandboxed Frame rendert kein PDF (nur Platzhalter), ein unsandboxed Frame gäbe die Bytes dieser Origin — deshalb Download-only |
| Navigation zu `blob:`/Anhang-URL als Rückfall | Der Blob wäre ein Dokument dieser Origin; „Open" navigiert nie, es öffnet den Dialog                                                         |
| Eigener Ladeindikator in der Zeile            | Der Knopf sperrt sich selbst; ein zweiter Zustandsanzeiger wäre eine zweite Wahrheit                                                         |
| Vorschau/Fortschrittsbalken für die Bytegröße | Die Zeile nennt Größe und Typ bereits als Text                                                                                               |

---

## Karten-Inhalt als Markdown + Diagramme (2026-11-06)

Kein neuer eigener Baustein: die bestehende `Markdown`-Host-Mount-Wrapper-Komponente bekommt ein
`inline`-Merkmal; der Host-Renderer bekommt einen Inline-Modus. Diagramme laufen über den vorhandenen
`MarkdownBlocks`-Besitzer des Hosts.

| Name                                                     | Zweck                                                                                           | Varianten                                                                   | Zustände                                                                                       | Steht auf der Liste |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------- |
| `Markdown` (`{ inline?: true }`)                         | Text als gerendertes Markdown; `inline` = Phrasing ohne Block-Hülle und ohne interaktive Kinder | block (Notes/Kommentar/Proof/Waiting), inline (Options-Label/-Beschreibung) | gerendert, Rohquelle (Editor), Render-Fehler (Quelle + Hinweis), Mermaid, inline↔block-Wechsel | fest                |
| Host-Renderer: `toSanitizedInlineMarkdownHtml`           | Eine Zeile als Phrasing-Content; teilt Parser/Sanitizer mit dem Block-Pfad                      | –                                                                           | leer → "", gerendert, Fehler → escapter Text                                                   | fest                |
| Host: `MarkdownBlocks` am Plugin-Markdown (Mermaid lazy) | ` ```mermaid ` → Diagramm; Codeblock-/Tabellen-Bedienung                                        | –                                                                           | vor Mount (Codeblock), gemountet (`openclaw-mermaid`), Renderer-Fehler                         | fest (Bestand)      |

### Nicht auf der Liste (bewusst abgelehnt) — Karten-Markdown

| Element                              | Warum nicht                                                       |
| ------------------------------------ | ----------------------------------------------------------------- |
| Plugin-eigener Markdown-Parser       | Zweiter Owner für Parser/Sanitizer; verletzt den Plugin-Vertrag   |
| Diagramme in Options-Labels          | Fences sind block-level; Labels sind einzeilig/Phrasing im Button |
| `innerHTML` der Option direkt setzen | Umgeht den Host-Sanitizer — XSS-Grenze bleibt der Host            |

---

## Karten-Interaktions-Verweis (2026-11-07)

Kein neuer Baustein: die Karte zeigt in ihrer **vorhandenen** Sitzungszeile
(`CardSession` in `view-card-content.tsx`) bzw. im **vorhandenen** Sitzungskopf
(`CardSessionHeading` in `view-card-session-heading.tsx`) einen Verweis, den es bisher nicht gab.
Kein `div` mit Klick-Handler — der Verweis benutzt den vorhandenen `OpenSessionCardAction`.

| Name                                        | Zweck                                                                                                                                          | Varianten                                      | Zustände                                                                                                                         | Steht auf der Liste |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| `CardSession` (vorhanden, erweitert)        | Zeile der Karte: Agent, Sitzungsname, Zustandsmarker — zeigt bei fehlender Ausführungssitzung den Dialog, der die Karte zuletzt bearbeitet hat | Grid-Karte, Listenzeile                        | keine Interaktion (unverändert), Interaktion läuft (Spinner), Interaktion beendet (Name), Interaktion verschwunden (unverändert) | fest (Erweiterung)  |
| `CardSessionHeading` (vorhanden, erweitert) | Sitzungskopf im Detail-Drawer und im Tab _Session_ mit derselben Reihenfolge: Ausführungssitzung, sonst Interaktions-Dialog                    | Übersicht-Tab, Session-Tab                     | wie oben; ohne auflösbaren Verweis exakt der Zustand „No session yet"                                                            | fest (Erweiterung)  |
| `OpenSessionCardAction` (Host-Bestand)      | „Open session" — derselbe Baustein wie für die Ausführungssitzung; liest zusätzlich das additive Interaktionsziel                              | Karte (Aktionsmenü), Detail (leiser Textknopf) | kein Ziel (verborgen), Ziel vorhanden (sichtbar)                                                                                 | fest (Bestand)      |
| `.session-run-spinner` (Host-Bestand)       | Laufanzeige der Interaktion — derselbe Marker wie für die Ausführungssitzung (`components.css`)                                                | –                                              | läuft, beendet (entfernt)                                                                                                        | fest (Host)         |
| `.workboard-agent-chip` (Host-Bestand)      | Agenten-Chip der Zeile — unverändert                                                                                                           | –                                              | –                                                                                                                                | fest (Bestand)      |

### Nicht auf der Liste (bewusst abgelehnt) — Karten-Interaktion

| Element                                           | Warum nicht                                                                                                                |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Eigene Interaktions-Zeile unter der Sitzungszeile | Zwei Zeilen für dieselbe Frage („welche Unterhaltung?") — der Kartenplatz gehört dem Titel                                 |
| Warn-/Stale-Abzeichen für die Interaktion         | Der Verweis ist Information, keine Ausführung: ein gelöschter Dialog lässt ihn fallen, statt zu warnen (siehe `DESIGN.md`) |
| Stop-Knopf für die Interaktion                    | Der Stop-Knopf bricht die **Ausführung** ab; ein zweiter Abbruchziel-Pfad wäre ein zweiter Wahrheitsstand                  |
| Interaktions-Chip im Kartenkopf                   | Doppelung zur Sitzungszeile; der Kopf trägt Aktionen, nicht Identität                                                      |
| Zeitstempel der Interaktion in der Karte          | Die Karte hat schon „Updated"; ein zweiter Zeitstempel derselben Sache wäre eine zweite Uhr                                |

---

## Karten-Notes als Label/Wert-Liste (2026-11-12)

Der Lesepfad der Notes, abgetrennt von den editierbaren Feldern: `view-card-notes.tsx` rendert die
vorhandene Klartext-Konvention (101 von 108 offenen Karten) als Liste; `InlineText` bleibt der Editor
und bindet weiterhin `card.notes` verbatim. Kein neuer Markdown-Renderer — alles läuft über die
vorhandene `Markdown`-Host-Mount-Wrapper-Komponente.

| Name                                                     | Zweck                                                                                                                                  | Varianten                                                                  | Zustände                                                                                                                                         | Steht auf der Liste |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- |
| `CardNotes` (`view-card-notes.tsx`)                      | Notes als `<dl>`-Liste (Label/Wert) in fester Reihenfolge `Stand → Naechster Schritt → Beleg → Was`; nicht konforme Notes als Fallback | strukturiert (Konvention erkannt), unstrukturiert (Fallback)               | konform (Liste), fehlende Sektion (Zeile entfällt), Teildaten (Preamble vor der Liste), Fallback (Lead + Aufklapper + Marker), leer (kein Mount) | fest                |
| `Was`-Aufklapper (`details.workboard-notes__disclosure`) | Klappt einen `Was`-Wert ab vier nicht-leeren Zeilen auf; nativ `<details>/<summary>`, tastaturbedienbar, sichtbarer Fokusring          | zugeklappt (Standard), aufgeklappt                                         | fokussiert (`:focus-visible`), Maus/Tastatur                                                                                                     | fest                |
| Fallback-Aufklapper                                      | „Show full note ({count} characters)“ zeigt den Rest hinter dem Lead-Satz; `{count}` = Länge der getrimmten Note                       | –                                                                          | zugeklappt (Standard), aufgeklappt                                                                                                               | fest                |
| `Unstructured note`-Marker (`p.workboard-notes__marker`) | Sagt als Text, dass die Note der Konvention nicht folgt; informativ, **kein** `role="alert"`; Rand `--muted`, Text `--text`            | –                                                                          | sichtbar (nur im Fallback), fehlt (konforme Note)                                                                                                | fest                |
| `Markdown` (Host, vorhanden)                             | Rendert jeden Wert als Markdown; linkifiziert und saniert URLs, markiert Pfade/IDs als Code-Span                                       | block (`CardNotes`-Werte), Trigger-Innenraum mit `codeBlockChrome: "none"` | gerendert, Rohquelle (Editor)                                                                                                                    | fest (Host)         |

### Nicht auf der Liste (bewusst abgelehnt) — Karten-Notes

| Element                                                     | Warum nicht                                                                                                                                              |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Eigener Parser/Sanitizer im Plugin                          | Zweiter Owner für Link-Grammatik und XSS-Grenze; der Host-Mount `mountMarkdown` ist der eine Owner                                                       |
| Erfundener `href` für Pfade und Karten-IDs                  | Die Fläche hat keinen Dateiöffner und keinen Karten-Deep-Link erreichbar aus den Notes; ein Link, der nur scheitern kann, wäre schlechter als keiner     |
| Schreibende Normalisierung der Note (Umsortieren beim Save) | Die gespeicherte Zeichenkette ist die Wahrheit; die Struktur ist eine Render-Zeit-Projektion einer Kopie, der Editor schreibt das Original-Layout zurück |
| Aufklapper mit eigenem Klick-Handler (`div`)                | Natives `<details>/<summary>` ist ohne Zusatzcode tastaturbedienbar und bringt den Fokusring mit                                                         |
| Farbe als Träger eines Zustands                             | Marker und Fallback sagen ihren Zustand in Text; Farbe bleibt Dekoration aus Host-Variablen                                                              |
