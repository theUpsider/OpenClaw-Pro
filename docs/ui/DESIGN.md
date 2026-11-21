# DESIGN.md — Workboard: Talk-Gate und Wirkungs-Protokoll

Verbindlicher Vertrag für diese Fläche (Vault-Notiz §2). Liegt im Repo, nicht im Chat. Jede UI-Änderung an
dieser Fläche folgt dieser Datei oder ändert sie im selben Commit.

## Prinzipien

1. **Nichts wird ohne Bestätigung ausgeführt** — Aufnahme → Gate → Absenden. Verwerfen (Knopf oder Escape)
   ändert nichts und ist immer möglich; es gibt keinen Pfad am Gate vorbei.
2. **Der handelnde Agent steht über dem Text** — die Zeile „Führt aus" nennt Agent **und** Ziel (Board bzw.
   Karte) und ist auch bei kurzem Transkript sichtbar.
3. **Der Verlauf ist die Quittung** — was ausgeführt wurde, steht mit Urheber-Agent und Zeitstempel im
   Activity-Tab der Karte; die Bestätigung nach dem Absenden ist kurz und öffnet die Antwort im Dock.
4. **Ein Satz, eine Handlung** — der Agent erhält genau den Text, den the operator gelesen und bestätigt hat.
5. **Dieselbe Sprache auf beiden Ebenen** — Board-Talk und Karten-Talk benutzen dasselbe Gate, dieselbe
   Wortwahl, dasselbe Protokoll; nur die Zielzeile unterscheidet sich.

## Zielgruppe

the operator als Board-Betreiber. Desktop mit Maus und Tastatur (kurze Korrekturen, Lesen), gelegentlich Handy
einhändig. Er kennt Karten, Spalten und Agenten, weiß aber nicht, welcher Agent einen gesprochenen Satz
ausführt — und will es nicht aus dem Verhalten erraten.

## Aufgabe der Oberfläche

- **Hauptfluss**: Mikrofon im Seitenkopf (oder im Karten-Drawer) betätigen, sprechen, stoppen, im Gate den
  erkannten Satz lesen und die Zielzeile prüfen, dann [Absenden] — der Turn geht an die Dock-Unterhaltung.
- **Zweiter Fluss**: dieselbe Aufnahme, aber der Text ist falsch — korrigieren oder [Verwerfen]; nichts wird
  gesendet.
- **Nachgelagert**: später im Activity-Tab einer Karte nachsehen, was geändert wurde und von wem.

## Tonalität

Nüchtern und zuweisend, wie eine Werkzeugleiste: „Führt aus", „Absenden", „Verwerfen". Kein Dialog, der den
Nutzer begrüßt, keine Verkaufsfloskeln, keine Zusammenfassung des Gesagten durch das System. Die Wortwahl
bleibt über den Fluss gleich: Knopf „Absenden" → Meldung „Gesendet…"; Knopf „Verwerfen" → „Verworfen."

## Nicht-Ziele

- Kein zweiter Sprachkanal, kein eigener Transkriptionspfad, kein Chat-Ersatz: das Gate reicht einen Satz an
  `chat.send` weiter, genau wie die Mikrofonaufnahme es heute tut.
- Keine Änderung daran, welcher Agent eine **Karte** bedient. Der angezeigte Agent ist der, der den Turn
  tatsächlich ausführt (die Dock-Unterhaltung des Boards); die Routing-Frage ist eine offene Produktentscheidung.
- Keine Rücknahme bereits ausgeführter Turns, keine Bearbeitung des Verlaufs, keine Benachrichtigungen.
- Keine neue Palette und kein zweiter Token-Namensraum: diese Fläche bindet an die Control-UI-Tokens.

## Design-Entscheidungen mit Grund

| Entscheidung                                                                  | Grund                                                                                                                                                                                                                                          | Datum      |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Das Gate ist ein Dialog, keine Inline-Leiste im Seitenkopf                    | Der Seitenkopf ist einzeilig und teilt sich Titel, Bedienelemente und Mikrofon; ein Textfeld dort bricht die Zeile um und verschiebt die Spalten. Die vorhandene Dialog-/Drawer-Fläche ist bereits da und wird auch vom Karten-Drawer benutzt. | 2026-11-02 |
| Verwerfen ist immer erreichbar, auch per Escape                               | Ein Gate, das man nicht verlassen kann, ist eine Sackgasse; Escape ist im Host die etablierte Abbruchgeste.                                                                                                                                    | 2026-11-02 |
| Kein eigener Farbton für Talk                                                 | Eine Feature-Farbe wäre die zweite Sprachpipeline, die der Auftrag ausschließt; `--accent-2` ist im Host belegt. Der Host-Akzent trägt die eine gefüllte Aktion.                                                                               | 2026-11-02 |
| Der Urheber-Agent kommt aus der Server-Antwort, nicht aus dem Browser-Zustand | Ein clientseitig erfundenes Protokoll überlebt keinen Reload und wäre nicht prüfbar; die Karten-Events sind die vorhandene, persistente Fläche.                                                                                                | 2026-11-02 |
| Das Protokoll hängt an den Karten-Events statt an einem neuen Audit-Store     | Events existieren bereits, werden mit der Karte persistiert und im Activity-Tab angezeigt — der kleinste Eingriff, der alle drei Belege trägt.                                                                                                 | 2026-11-02 |
| Die Zielzeile nennt Agent **und** Ziel                                        | „main" allein beantwortet nicht „welches Board / welche Karte"; umgekehrt fehlt ohne Agent die Antwort auf Davids Frage.                                                                                                                       | 2026-11-02 |

## Verweise

- Tokens: `docs/ui/tokens.css` (Komponenten lesen nur semantische Namen; die Semantik bindet an die Control-UI-Tokens)
- Komponentenliste: `docs/ui/component-list.md` (geschlossen)
- Zustandsmatrix: `docs/ui/screen-state-matrix.md`
- Gate: `docs/ui/gate-checklist.md` (Abnahme, binär)
- Design-Plan/Herleitung: `docs/ui/design-plan.md`
- Regelwerk: Vault-Notiz `03-resources/software/softwareengineering/Agent-gebaute UIs — UI-Review-Guide (2026-11-01).md`

## Prüfliste für Reviews

- [ ] Kein Element auf diesen Flächen, das nicht in `component-list.md` steht
- [ ] Kein Zustand ohne Eintrag in `screen-state-matrix.md`
- [ ] Keine eigene Farbwelt: alle Farben kommen aus den semantischen Tokens, die an die Control UI binden
- [ ] Keine Aussage über den handelnden Agenten, die nicht aus der Server-Antwort stammt

---

# DESIGN.md — New-card-Dialog: Sprachentwurf

Zweite Fläche dieses Vertrags (2026-11-03). Herleitung: `design-plan.md`, Abschnitt „New-card-Dialog".

## Prinzipien — New card

1. **Sprechen füllt aus, nur Create legt an** — die Antwort schreibt nur die vorhandenen Draft-Felder; der
   Dialog bleibt offen; es gibt keinen Weg vom Mikrofon zu `workboard.cards.create`.
2. **Nichts erfinden** — fehlt ein Feld im Satz, fehlt es in der Antwort; leere Antwortfelder lassen den Wert
   des Operators stehen; Verworfenes wird als Hinweis benannt.
3. **Nur die Wörter des Boards** — Labels nur aus der Board-Palette (Palettenschreibweise), Status/Priorität nur
   aus den festen Listen, Agent nur, wenn der Server ihn als zuweisbar kennt.
4. **Der Operator behält das Formular** — kein Fokusraub, keine Feldsperre; nur das Mikrofon wartet.
5. **Fehler lassen alles stehen** — Felder unverändert, Dialog offen, Meldung im vorhandenen Fehler-Toast.

## Zielgruppe — New card

the operator als Board-Betreiber, Desktop mit Maus und Tastatur, gelegentlich Handy. Kennt Formular und Board-Labels;
will schneller anlegen, aber das Ergebnis selbst prüfen.

## Aufgabe der Oberfläche — New card

- **Hauptfluss**: „New card" öffnen → Mikrofon im Kopf → einen Satz sprechen → Statuszeile „Filling in…" →
  Felder sind befüllt, Statuszeile „Filled in…" (+ Hinweise) → prüfen/ändern → **Create**.
- **Zweiter Fluss**: Antwort passt nicht → von Hand korrigieren, erneut sprechen oder **Cancel**.

## Tonalität — New card

Nüchtern, ein Verb durch den Fluss: Mikrofon „Fill in the card by voice" → „Filling in the form from your
words…" → „Filled in from your words. Check the fields; nothing is created until you press Create." Hinweise
benennen, was weggelassen wurde, und warum („… is not on this board's labels; left out."). Keine Begrüßung,
keine Zusammenfassung des Gesagten.

## Nicht-Ziele — New card

- Kein Auto-Submit, kein Auto-Save, kein Chat-Turn, kein zweiter Sprachkanal.
- Keine neuen Palette-Einträge aus Sprache; keine Modell- oder Agentenwahl aus dem Browser.
- Kein Mikrofon im Bearbeiten-Dialog bestehender Karten.

## Design-Entscheidungen mit Grund — New card

| Entscheidung                                                                   | Grund                                                                                                                                                       | Datum      |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Mikrofon im Dialog-Kopf links neben dem Schließen-Knopf                        | Gleiche Ecke wie das Board-Mikrofon im Seitenkopf; weit weg von Create, damit „sprechen" nicht als „anlegen" gelesen wird; der Kopf bleibt einzeilig.       | 2026-11-03 |
| Kein Transkript-Gate vor dem Befüllen                                          | Es wird nichts ausgeführt; das Formular ist die Bestätigung. Ein Dialog über dem Dialog wäre Reibung ohne Schutz.                                           | 2026-11-03 |
| Statuszeile `aria-live="polite"` statt Toast                                   | Bleibt stehen, solange man prüft; der Toast ist die Fehlerfläche des Dialogs und verschwindet.                                                              | 2026-11-03 |
| Felder während des Entwurfs bedienbar                                          | Warten erzwingen kostet mehr als ein seltenes Überschreiben; Sprache ersetzt bewusst, was sie füllt (der Operator hat gerade diktiert).                     | 2026-11-03 |
| Statuszeile am Anfang des scrollenden Formularkörpers, nicht im Kopf           | Im nicht scrollenden Kopf schnitt sie bei 320 px / 200 % Zoom ab (Gate `zoom-200`); über dem Titel bleibt sie dort, wo das Auge nach dem Sprechen hinsieht. | 2026-11-03 |
| Entwurf über eigene Gateway-Methode `workboard.cards.draft`, nicht `chat.send` | Ein Chat-Turn schreibt eine Session, liefert Freitext und könnte die Karte selbst anlegen. Die Methode liest nur und liefert ein festes Schema.             | 2026-11-03 |

## Prüfliste für Reviews — New card

- [ ] Kein Aufruf von `saveWorkboardCardDraft` / `workboard.cards.create` auf dem Sprachpfad
- [ ] Mikrofon und Statuszeile stehen in `component-list.md`; Zustände in `screen-state-matrix.md`
- [ ] Statuszeile nur `--muted` auf Dialogfläche; Fehler nur im vorhandenen Toast

---

# DESIGN.md — Artefakt per Kanal teilen

Weitere Fläche dieses Vertrags (2026-11-03). Herleitung: `design-plan.md`, Abschnitt „Artefakt per Kanal
teilen".

## Prinzipien — Artefakt teilen

1. **Geteilt wird der Verweis, nie die Bytes** — die Nachricht ist reiner Text: erste Zeile Label, zweite Zeile
   URL bzw. Host-Pfad; ist das Label gleich dem Verweis, steht er nur einmal da.
2. **Erst Send sendet** — kein Direktversand aus der Zeile, kein Senden beim Kanal-/Kontowechsel oder beim
   Wählen eines Vorschlags; Cancel und Escape schließen ohne Request.
3. **Der eingegebene Text ist die Wahrheit** — das Verzeichnis (`conversations.list`) ist nur Vorschlagsquelle;
   Konto und Thread werden nie daraus abgeleitet.
4. **Gesperrt heißt: mit Grund** — jeder gesperrte Send-Knopf hat einen sichtbaren Satz am Feld.
5. **Der Fehler zerstört nichts** — Dialog offen, Ziel/Kanal/Konto erhalten, erneut sendbar.

## Zielgruppe — Artefakt teilen

the operator als Board-Betreiber, Desktop mit Maus und Tastatur, gelegentlich Handy. Kennt seine Kanäle und deren
Zielformate; will einen Pfad oder Link weitergeben, ohne ihn in einen anderen Client zu kopieren.

## Aufgabe der Oberfläche — Artefakt teilen

- **Hauptfluss**: Karte öffnen → Artefakt-Zeile → **Share…** → Vorschau lesen → Kanal (ggf. Konto) prüfen →
  Ziel eingeben oder Vorschlag wählen → **Send** → „Sending…" → Dialog schließt, an der Zeile steht
  „Sent to +4915… via WhatsApp."
- **Zweiter Fluss**: Send scheitert → Meldung „Could not send: …" unter dem Ziel-Feld → Ziel korrigieren →
  erneut **Send**; oder **Cancel**, nichts wurde gesendet.

## Tonalität — Artefakt teilen

Nüchtern, ein Verb durch den Fluss: „Share…" öffnet, „Send" → „Sending…" → „Sent to … via …". Gründe sagen,
was fehlt und was zu tun ist („Enter a recipient to send."). Keine Einleitung, kein Suffix in der Nachricht,
keine Verkaufsfloskel.

## Nicht-Ziele — Artefakt teilen

- Kein Upload, keine Medien: `mediaUrl`, `mediaUrls`, `buffer` werden nie gesetzt.
- Keine zweite Send-Route: nie `conversations.send` (Admin-Scope, anderes Recht), kein Chat-Turn.
- Keine neue Gateway-Methode; benutzt werden nur `channels.status` (read), `send` (write) und optional
  `conversations.list` (admin, nur Vorschläge).
- Kein Server-Event, kein Kommentar, kein Status: der Workboard-Store wird von diesem Slice nicht geschrieben;
  die Quittung lebt nur im Browser bis zum Schließen des Drawers.
- Keine Kanal-Einrichtung, kein Teilen mehrerer Artefakte, keine editierbare Nachricht.

## Design-Entscheidungen mit Grund — Artefakt teilen

| Entscheidung                                                                                     | Grund                                                                                                                                                            | Datum      |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Textknopf „Share…" neben „Copy path", sekundär                                                   | Gleiche Optik wie die vorhandenen Zeilenaktionen; die Ellipse kündigt den Dialog an; der eine gefüllte Knopf ist **Send** im Dialog                              | 2026-11-03 |
| Aktion nur an Zeilen mit `href` oder `reference`                                                 | Anhänge ohne Pfad/URL haben nichts zu teilen; eine Aktion ohne Inhalt wäre eine leere Zeile im Fluss                                                             | 2026-11-03 |
| Aktion nur mit Gateway-Verbindung                                                                | Ohne Client gibt es weder Kanalliste noch `send`; „Copy path" bleibt offline verfügbar. Angenommener Randfall statt eines eigenen Offline-Zustands im Dialog     | 2026-11-03 |
| Nachricht als nicht editierbare `code`-Vorschau                                                  | Garantiert, dass nur der Verweis rausgeht, und zeigt vor dem Senden genau den gesendeten Text                                                                    | 2026-11-03 |
| `accountId` wird immer mitgeschickt                                                              | Der Operator sieht das Konto (oder es gibt nur eins); explizites Routing statt Server-Default, der sich zwischen Öffnen und Senden ändern könnte                 | 2026-11-03 |
| Kein `agentId` im `send`                                                                         | Der Brief legt die Parameter fest; ohne Medien gibt es keine agentenbezogenen Medienwurzeln aufzulösen                                                           | 2026-11-03 |
| Vorschläge nur mit `canAdmin`, Fehler still                                                      | `conversations.list` ist `operator.admin`; Vorschläge sind Komfort, kein Vertrag — ein Fehler dort darf den Sendeweg nicht als kaputt erscheinen lassen          | 2026-11-03 |
| `idempotencyKey` pro Klick, neu nach Fehler                                                      | Ein Doppelklick während des Sendens erzeugt keinen zweiten Request (Knopf gesperrt + Guard); ein bewusster neuer Versuch nach einem Fehler ist ein neuer Versand | 2026-11-03 |
| Quittung an der Zeile (`role="status"`), kein Toast, kein Verlaufseintrag                        | Toast ist die Fehlerfläche des Drawers; ein Verlaufseintrag wäre ein Store-Schreibzugriff                                                                        | 2026-11-03 |
| Fehler am Feld (`role="alert"`), Gründe als `role="status"`                                      | Fehler sind zeitkritisch; Gründe beschreiben den Zustand und sollen beim Öffnen nicht als Alarm angesagt werden                                                  | 2026-11-03 |
| Feld- und Sekundärknopf-Rand an `--muted`                                                        | `--border` misst 1,05:1 / 1,27:1 auf der Dialogfläche; `--muted` 5,04:1 / 5,45:1 — wie im Talk-Gate                                                              | 2026-11-03 |
| Zeilenaktionen (`Copy path`, `Open`, `Share…`) mit Rand an `--muted`                             | Gate-Lauf 1: alle drei Knöpfe der Zeile 1,05:1 / 1,27:1 (`.btn` füllt wie die Drawer-Fläche); ein gemeinsamer Rand hält die Leiste einheitlich                   | 2026-11-03 |
| Host-Picker-Trigger im Dialog an `--muted` gebunden (`.workboard-share .picker-select__trigger`) | Host-Rand ist `--border` zu 70 % (< 3:1); Workboard überschreibt den Trigger bereits an vier Stellen im selben Muster                                            | 2026-11-03 |
| Platzhalter „e.g. +15551234567“                                                                  | Sichtprüfung: ohne „e.g.“ las sich der Platzhalter im leeren Zustand wie ein eingetragener Wert                                                                  | 2026-11-03 |

## Prüfliste für Reviews — Artefakt teilen

- [ ] Genau ein `send`-Request pro Klick; kein `conversations.send`; kein `mediaUrl`/`mediaUrls`/`buffer`
- [ ] Kein Aufruf einer Workboard-Mutation (`workboard.*`) auf dem Teilen-Pfad
- [ ] Kanalwechsel/Kontowechsel/Vorschlag sendet nichts; Cancel/Escape sendet nichts
- [ ] Bausteine in `component-list.md`, Zustände in `screen-state-matrix.md`
- [ ] Farben nur über Host-Variablen (`--text`, `--muted`, `--border`, `--bg-elevated`, `--accent`, `--danger`)

---

# DESIGN.md — Entscheidungskarte als Ask-Dialog

Weitere Fläche dieses Vertrags (2026-11-03). Herleitung: `design-plan.md`, Abschnitt „Entscheidungskarte als
Ask-Dialog".

## Prinzipien — Ask-Dialog

1. **Die Reihenfolge des Agenten ist die Nummer** — `1..N` = Listenindex in
   `metadata.automation.decisionOptions`; nichts wird umsortiert.
2. **Ein Klick ist eine Entscheidung** — Klick, Ziffer `1..N` und Enter/Leertaste auf der fokussierten Option
   schreiben `Decision: {label}` und verschieben nach Ready ohne `decision`-Label, genau wie **Decision made**.
3. **Tippen entscheidet nie** — Ziffern zählen nur außerhalb von Textfeldern; Freitext wirkt nur über **Add
   note** / **Decision made**; eine Option füllt das Feld nicht.
4. **Die Empfehlung steht in Text da** — Badge „Recommended" und „recommended" im zugänglichen Namen; höchstens
   eine (die erste gewinnt).
5. **Fehler lassen alles stehen** — Refusal-Pfad (`decisionMoveFailed`) wörtlich wie bisher; Auswahl und Text
   bleiben, erneut entscheidbar.

## Zielgruppe — Ask-Dialog

the operator als Board-Betreiber, Desktop mit Maus und Tastatur, gelegentlich Handy. Kennt das Ask-Muster aus Claude
Code / Codex und will die Rückfrage eines Agenten mit einem Klick oder einer Ziffer beantworten.

## Aufgabe der Oberfläche — Ask-Dialog

- **Hauptfluss**: Entscheidungskarte öffnen → Optionen 1..N mit Beschreibung lesen → Empfehlung sehen → Option
  klicken oder Ziffer drücken → Karte in Ready, Panel verschwindet.
- **Zweiter Fluss**: Keine Option passt → eigene Antwort tippen → **Decision made** (Ready) oder **Add note**
  (bleibt blockiert).
- **Rückwärtskompatibel**: ohne strukturierte Optionen erscheinen die Notes-Checkboxen `- [ ] …` als
  nummerierte Optionen (ohne Beschreibung/Badge); ohne beides nur das Freitextfeld.

## Tonalität — Ask-Dialog

Nüchtern, ein Verb durch den Fluss: „Decide: Postgres" (zugänglicher Name) → Kommentar „Decision: Postgres";
„Decision made" → Karte in Ready. Hinweis sagt, was geht: „Pick an option — click it or press its number — or
write your own answer below." Kein „Wir empfehlen Ihnen", nur „Recommended".

## Nicht-Ziele — Ask-Dialog

- Kein `multiSelect`: `Decision: {decision}` ist eine Zeile; mehrere Antworten würden die Note-Form ändern und
  den Ready-Move undeutbar machen.
- Kein Auto-Submit beim Tippen, keine Sortierung nach Empfehlung, keine Optionsbearbeitung im Browser.
- Keine neue Gateway-Methode, keine Schemaänderung: die Optionen liegen in der vorhandenen `automation`-Struktur.

## Design-Entscheidungen mit Grund — Ask-Dialog

| Entscheidung                                                                                             | Grund                                                                                                                                                    | Datum      |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Klick auf eine Option entscheidet sofort (Kommentar + Ready)                                             | Bestehende Semantik der Notes-Pillen (`record(option, true)`) und das Codex-/Claude-Code-Muster; ein zusätzlicher Bestätigungsknopf verdoppelt den Klick | 2026-11-03 |
| Ziffern `1..N` nur im Panel und nur außerhalb von `input`/`textarea`/`select`/`contenteditable`          | Sonst verschiebt „2" beim Tippen einer eigenen Antwort die Karte — der teuerste Fehler dieser Fläche; ein Regressionstest hält ihn fest                  | 2026-11-03 |
| `role="radiogroup"` + `role="radio"` je Option, Roving-Tabindex, Pfeile bewegen nur den Fokus            | Genau eine Antwort → Radio ist die richtige Rolle; Pfeile ohne Wirkung erlauben Lesen per Tastatur, Enter/Leertaste entscheidet                          | 2026-11-03 |
| Kein `multiSelect`                                                                                       | Der Kommentar ist eine Zeile `Decision: …`; der Ready-Move braucht eine eindeutige Antwort                                                               | 2026-11-03 |
| Stufe-2-Optionen (Notes-Checkboxen) ohne Badge und Beschreibung, `aria-label` „Decide: {option}"         | Die Notes tragen keine Empfehlung; eine geratene Empfehlung wäre erfunden. Bestandstests und Gate-Fixtures hängen am alten Namen                         | 2026-11-03 |
| Keine Optionen → kein Auswahlblock, kein Tastaturhinweis                                                 | Ein leerer Container mit `aria-label` wäre ein leerer Orientierungspunkt; das Freitextfeld ist dann die vollständige Oberfläche                          | 2026-11-03 |
| Empfehlung als Text-Badge im neutralen `--text`, nicht im Akzent; Reihenfolge unverändert                | Der eine Akzent bleibt bei **Decision made**; Umsortieren würde die Nummern brechen, die der Agent in seiner Frage nennt                                 | 2026-11-03 |
| Die gewählte Option bleibt `aria-checked="true"`, bis die Karte das Panel verlässt                       | Im Refusal-Fall sieht der Operator, welche Antwort als Note gespeichert wurde, und entscheidet dieselbe Zeile erneut                                     | 2026-11-03 |
| Ränder von Optionszeile, Badge, Textfeld und „Add note" an `--muted`                                     | `--border` misst 1,05:1 / 1,27:1 auf der Drawer-Fläche; `--muted` 5,04:1 / 5,45:1 — dieselbe Regel wie Talk-Gate und Share-Dialog                        | 2026-11-03 |
| Optionen kommen aus `metadata.automation.decisionOptions` (Agent über `workboard_create/_update/_block`) | Ein Feld in der vorhandenen `automation_json`-Spalte: keine Schemaänderung; die Notes-Checkbox-Prosa bleibt als Rückfall                                 | 2026-11-03 |
| Statuszeile `role="status"` „Saving your decision...“ im Panel                                           | Gate-Lauf 1: Speichern sperrte die Knöpfe ohne Ansage (§12.3/7); immer gemountet, leer verborgen wie im Share-Dialog                                     | 2026-11-03 |

## Prüfliste für Reviews — Ask-Dialog

- [ ] Klick/Ziffer/Enter erzeugen genau `workboard.cards.comment` (`Decision: {label}`) und
      `workboard.cards.move` (`ready`, `labelsRemove: ["decision"]`) — keine andere Methode
- [ ] Ziffer im Freitextfeld entscheidet nichts (Test »a digit typed into the answer field…«)
- [ ] Keine Sortierung, höchstens ein Badge, kein `multiSelect`
- [ ] Bausteine in `component-list.md`, Zustände in `screen-state-matrix.md`
- [ ] Farben nur über Host-Variablen (`--text`, `--text-strong`, `--muted`, `--bg-elevated`, `--bg-hover`, `--primary`)

---

# DESIGN.md — „Braucht dich“-Marker auf Workboard-Karten

Weitere Fläche dieses Vertrags (2026-11-04): ein abgeleiteter Marker auf Board-Karten und Listen-Zeilen.

## Prinzipien — „Braucht dich“-Marker

1. **Eine Frage, ein Marker** — „Wartet diese Karte auf mich?“ Überlappende Gründe ergeben genau eine Pill
   und einen Streifen.
2. **Abgeleitet, nicht gespeichert** — aus Status, Labels, Agent und Archivzeitpunkt der Karte.
3. **Palette-unabhängig** — Host-Token `--danger`, eigener Streifen; kein Klassifikations-Slot.

## Design-Entscheidungen mit Grund — „Braucht dich“-Marker

| Entscheidung                                                                                                                               | Grund                                                                                                                                                                                                                                                                  | Datum      |
| ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Marker abgeleitet (`needsOperatorAttention`: `review`, Label `decision`, oder ohne Agent und nicht `done`), archivierte Karten ausgenommen | Ein gespeichertes Feld wäre eine zweite Wahrheit, die jeder Schreibweg (Agent, Dispatch, Sync, Bulk) nachziehen müsste; die Fakten liegen schon auf der Karte. Archivieren nimmt die Karte vom Tisch — eine archivierte Karte fordert niemanden mehr, auch in `review` | 2026-11-04 |
| Farbe `--danger` statt `--accent`                                                                                                          | `--accent` ist der Fokusring der Karte (`:focus-visible`) und die eine gefüllte Aktion; ein Streifen in derselben Farbe verschwimmt mit dem Fokus und wäre ein zweiter Akzent. `--danger` misst 6,27:1 / 6,42:1 gegen die Karte, Pill-Text 5,12:1 / 5,06:1             | 2026-11-04 |
| Zweiter Streifen in `::after`, eigene Border-Deklaration                                                                                   | `::before` gehört dem Klassifikationsstreifen; eine geteilte `border`-Deklaration mit `var(--workboard-card-accent)` ist auf unklassifizierten Karten ungültig und hätte den Aufmerksamkeitsstreifen gelöscht (im Fixture-Screenshot gefunden)                         | 2026-11-04 |
| Pill vor Labels und Abnahme-Marker, `flex: 0 0 auto`                                                                                       | Wichtigstes Signal zuerst; in der Listen-Zeile schrumpft der Titel mit Ellipse statt dass die Zeile umbricht                                                                                                                                                           | 2026-11-04 |

---

# DESIGN.md — „Braucht dich“-Inbox (Lens) im Workboard

Weitere Fläche dieses Vertrags (2026-11-04): ein Umschalter „Needs you (N)“ macht aus dem Board eine Inbox.

## Prinzipien — Inbox-Lens

1. **Eine Reihenfolge** — mit aktivem Lens gibt es keine Statusspalten, sondern eine global sortierte Folge:
   Priorität (dringend zuerst), dann Zeit im aktuellen Zustand (älteste zuerst), dann Karten-ID.
2. **Ehrliche Zeitangabe** — „Entered Review 3h ago“ ist der letzte `moved`-Event in den aktuellen Status,
   sonst `createdAt`; der genaue Zeitpunkt steht im `title` („In this state since …“). Wann ein Label
   `decision` gesetzt oder der Agent entfernt wurde, zeichnet der Store nicht auf; das wird nicht erfunden.
3. **Lens ist ein Filter** — er schneidet die übrigen Filter, steht als löschbarer Chip in der Filterzeile,
   und die Zahl im Umschalter ist genau die Zahl der Zeilen, die er unter den aktuellen Filtern zeigt.
4. **Abgeleitet, nicht gespeichert** — wie der Marker; kein Kartenfeld, kein Server-, Schema- oder Tool-Wechsel.

## Design-Entscheidungen mit Grund — Inbox-Lens

| Entscheidung                                                                                          | Grund                                                                                                                                                              | Datum      |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| Eine globale Folge statt Sortierung je Spalte, in Board- und Listenansicht                            | Gefordert ist eine Reihenfolge „nach Priorität, dann Alter“; je Spalte sortiert müsste man die dringendste Karte erst über neun Spalten suchen                     | 2026-11-04 |
| Alter = Eintritt in den aktuellen Status (`moved` → Status, sonst `createdAt`), nie `updatedAt`       | Nur Statuswechsel tragen Daten; `edited` hat keine Label-/Agent-Nutzlast. `updatedAt` springt bei jedem Kommentar und würde wartende Karten jünger aussehen lassen | 2026-11-04 |
| Alle zutreffenden Gründe als Text („Review · Decision · No agent“)                                    | Der Marker beantwortet „wartet sie?“, die Inbox „warum?“; Text statt Farbe, damit kein zweiter Akzent entsteht                                                     | 2026-11-04 |
| Umschalter als nativer `<button aria-pressed>` neben den Status-Tabs                                  | Gleiches Muster wie Status-Tabs und Anzeigeoptionen; Tastatur und Fokusring kommen vom Host-Button                                                                 | 2026-11-04 |
| Zähler in `--danger`-Tönung nur wenn > 0, sonst wie der Filterzähler                                  | Gleiche Farbe wie der Marker auf den Karten; bei 0 gibt es nichts, das Aufmerksamkeit verdient                                                                     | 2026-11-04 |
| Zwei Leerzustände: „Nothing needs you“ (Lens aus) vs. „… match these filters“ (andere Filter löschen) | Leer wegen Filter ist kein „alles erledigt“; jede Meldung bietet genau die Aktion, die wieder Karten zeigt                                                         | 2026-11-04 |
| Sortier-Chip ausgeblendet, solange der Lens an ist                                                    | Die Inbox hat ihre feste Reihenfolge; ein Chip „Sort: …“ würde eine Wirkung behaupten, die nicht stattfindet                                                       | 2026-11-04 |

# DESIGN.md — Board-Palette im Board-Dialog (2026-11-04)

Verbindlicher Vertrag für die Palette-Sektion des **Edit board**-Dialogs. Liegt im Repo; jede UI-Änderung an
dieser Fläche folgt dieser Datei oder ändert sie im selben Commit.

## Prinzipien — Board-Palette

1. **Ein Ort für die Palette** — die Sektion im Board-Dialog ist der einzige Editor für die Klassifizierungen;
   die Karten-Label-Bearbeitung zieht daraus, sie schreibt die Palette nicht.
2. **Die Palette ändert keine Karten** — Umbenennen oder Entfernen lässt die Labels auf Karten stehen (als
   einfache Chips); nur die Liste selbst ändert sich.
3. **Farbe ist benannt, nicht frei** — jeder Slot trägt eine der acht Session-Farben; der Name ist die Identität.
4. **Fehler am Feld** — eine ungültige Liste (leerer Name, Doppelung ohne Groß-/Kleinschreibung, `parallelizable`,
   > 10) wird vor dem Schreiben gemeldet und Save blockiert, statt eine Ablehnung des Gateways durchzureichen.
5. **Grenzen sichtbar** — der Zähler (`n / 10 used`) und der gesperrte **Add**-Knopf machen das Limit sichtbar.

## Aufgabe der Oberfläche — Board-Palette

- **Hauptfluss**: Board öffnen → **Edit board** → Slot umbenennen / Farbe wählen / Auf/Ab / hinzufügen / entfernen
  → **Save**; die Palette wird über `workboard.boards.classifications` geschrieben und gilt für die nächste
  Karten-Schreibung.
- **Zweiter Fluss**: leere Palette — der Hinweis sagt, dass hier der erste Eintrag entsteht.
- **Fehlerfluss**: ungültiger Eintrag — Fehler unter der Liste, Save blockiert, Draft bleibt.

## Nicht-Ziele — Board-Palette

- Keine Änderung der Karten-Labels, keine Migration bestehender Labels.
- Keine freie Farbwahl, keine zweite Farbwelt.
- Keine Palette für Sessions-Boards (die Sektion erscheint dort nicht).

## Design-Entscheidungen mit Grund — Board-Palette

| Entscheidung                                                       | Grund                                                                                         | Datum      |
| ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ---------- |
| Die Palette lebt im bestehenden Board-Dialog, nicht in einem neuen | Der Dialog ist schon die Board-Metadaten-Fläche; eine zweite Fläche wäre eine zweite Wahrheit | 2026-11-04 |
| Auf/Ab-Knöpfe statt Drag & Drop                                    | Tastatur- und Touch-bedienbar, für ≤10 Zeilen ausreichend                                     | 2026-11-04 |
| Farbe als Punkt + benannte Auswahl                                 | Farbe nie einziges Signal; bleibt an die Host-Session-Farben gebunden                         | 2026-11-04 |
| Der Write geht über `workboard.boards.classifications`             | Eine Methode, die die ganze Liste setzt; die Karten-Gates und `replaces` bleiben unangetastet | 2026-11-04 |
| Lokale Validierung vor dem Write                                   | Der Nutzer sieht den Grund am Feld; kein Round-Trip einer Gateway-Ablehnung                   | 2026-11-04 |

## Verweise — Board-Palette

- Tokens: `docs/ui/tokens.css`.
- Gate: `workspace-b/reports/board-palette-gate-20261104/`.

---

# DESIGN.md — Anhang öffnen und herunterladen

Weitere Fläche dieses Vertrags (2026-11-06). Die Anhang-Zeile im Karten-Drawer hatte bisher gar keine
Aktion: Typ und Größe standen als Text da, die Bytes waren über die Oberfläche nicht erreichbar.

## Prinzipien — Anhang ansehen

1. **Erst holen, dann zeigen** — Markdown und Rasterbilder kommen über `workboard.cards.attachments.get`
   (Scope `operator.read`) und werden von dieser App selbst gerendert, nie von einem Dokument des Browsers.
2. **Der erklärte Typ ist kein Vertrauensbeweis** — jede Anhang-Datei kann von jedem Agenten oder Operator
   stammen; gerendert wird nur, was diese App kennt (Host-Markdown-Mount, `<img>`), alles andere wird
   heruntergeladen.
3. **Download ist undurchsichtig** — der Blob wird auf `application/octet-stream` festgelegt, nie auf den
   erklärten Typ, und geht an einen Anker mit `download`; HTML, SVG und Skripte bekommen so nie ein Dokument.
4. **Kein Rückfall auf die Bytes** — scheitert das Lesen, steht der Fehler im Dialog bzw. an der Zeile;
   es gibt keinen Weg, der stattdessen zu den Bytes navigiert.
5. **Ein Klick, ein Request** — der Download-Knopf ist während des Lesens gesperrt.

## Zielgruppe — Anhang ansehen

the operator als Board-Betreiber, Desktop mit Maus und Tastatur. Er sieht im Drawer, dass eine Karte eine Datei
rerzeugt hat, und will sie entweder kurz ansehen (Markdown-Notiz, Screenshot) oder auf die Platte holen.

## Aufgabe der Oberfläche — Anhang ansehen

- **Hauptfluss ansehen**: Karte öffnen → Artefakt-/Anhang-Zeile → **Open** → Inhalt im Dialog lesen →
  **Close** oder Escape.
- **Hauptfluss holen**: Zeile → **Download** → die Datei landet im Download-Ordner des Browsers.
- **Fehlerfluss**: Lesen scheitert → Meldung im Dialog („Could not read the file…“) bzw. an der Zeile
  (`role="status"`); die Zeile bleibt bedienbar, der Anhang bleibt herunterladbar.

## Tonalität — Anhang ansehen

Knapp und sachlich: „Open“, „Download“, „Close“. Gründe sagen, was fehlt („This connection may not read
the file. Ask the operator for read access.“). Kein Datei-Icon, keine Vorschau-Metapher, keine Animation.

## Nicht-Ziele — Anhang ansehen

- Keine neue Gateway-Route, keine Änderung an `src/**`: benutzt wird die vorhandene Methode
  `workboard.cards.attachments.get` (read) — dieselbe, die auch die anderen Anhangspfade nutzen.
- Kein Inline-Medien im Artefakt-Block: die Zeile inlinet weiterhin nichts, sie öffnet einen Dialog.
- Kein Viewer für `text/html`, `image/svg+xml` oder `application/pdf`.
- Keine Änderung an CSP, kein `window.open`, keine Top-Level-Navigation zu Anhang-Bytes.
- Kein Löschen, kein Ersetzen, kein Hochladen von Anhängen.

## Design-Entscheidungen mit Grund — Anhang ansehen

| Entscheidung                                                             | Grund                                                                                                                                                                                                                                                                                              | Datum      |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| In-App-Viewer statt Navigation zu einer Blob-URL                         | Eine Top-Level-Blob-URL wäre ein Dokument dieser Origin mit den Bytes des Anhangs; HTML/SVG könnten dort Skript ausführen. Der Viewer hält die Bytes hinter dem RPC und rendert nur selbst gekannte Typen                                                                                          | 2026-11-06 |
| Download zwingt den Blob auf `application/octet-stream`                  | Ein Blob mit dem erklärten Typ (`text/html`, `image/svg+xml`) bekäme beim Öffnen ein Dokument; undurchsichtige Bytes lassen sich nur speichern                                                                                                                                                     | 2026-11-06 |
| Objekt-URL erst nach dem konsumierten Klick widerrufen                   | Der Browser liest den Blob asynchron nach `click()`; ein sofortiger `revokeObjectURL` kann den Download abbrechen                                                                                                                                                                                  | 2026-11-06 |
| `application/pdf` ist Download-only                                      | Gemessen (Headless-Chrome, 900×700): ein sandboxed `iframe` rendert nie ein PDF — Viewer-Plugin blockiert, nur der Platzhalter; auch `sandbox=""`, `allow-scripts`, `allow-same-origin`, `allow-plugins`, blob: und http: ändern das nicht. Unsandboxed rendert, gäbe aber die Bytes dieser Origin | 2026-11-06 |
| **Download** an jeder Anhang-Zeile, **Open** nur bei vorhandenem Viewer  | Eine Zeile ohne Download wäre die gemeldete Lücke; ein Open ohne Viewer wäre eine Aktion, die nur scheitern kann                                                                                                                                                                                   | 2026-11-06 |
| Aktion nur mit Client (`Show when={client}`)                             | Ohne Verbindung gibt es keine Bytes zu holen; das Muster ist dasselbe wie bei `Preview` und `Share…`                                                                                                                                                                                               | 2026-11-06 |
| Markdown-Text mit `TextDecoder(..., { fatal: true })` dekodieren         | `atob` liefert Latin-1 und würde UTF-8 zerstören; ein als Markdown erklärter Binärinhalt wird verworfen statt als Mojibake gerendert                                                                                                                                                               | 2026-11-06 |
| Fehler an der Zeile (`role="status"`), Fehler im Dialog (`role="alert"`) | Gleiche Aufteilung wie bei `CopyReference` (Status) und dem Share-Dialog (Alarm) — Statusmeldungen sollen beim Öffnen nicht als Alarm angesagt werden                                                                                                                                              | 2026-11-06 |
| Ein Markdown-_Dateiname_ hebt eine widersprechende Typangabe nicht auf   | Sonst könnte eine als `text/html` oder `image/svg+xml` erklärte Datei allein durch die Endung `.md` in den Textpfad geraten. Der Typ entscheidet, wenn er widerspricht; die Endung zählt nur ohne Angabe oder bei `text/plain`                                                                     | 2026-11-06 |

## Prüfliste für Reviews — Anhang ansehen

- [ ] Genau ein `workboard.cards.attachments.get` pro Klick; Knopf während des Lesens gesperrt
- [ ] Download-Bytes sind `application/octet-stream`, auch wenn der Datensatz `text/html` erklärt
- [ ] Kein `window.open`, keine Top-Level-Navigation, kein `target`-Link auf Anhang-Bytes, keine CSP-Änderung
- [ ] Kein Open für `text/html`, `image/svg+xml`, `application/pdf`
- [ ] Eine widersprechende Typangabe schlägt die Dateiendung (`.md` öffnet kein `text/html`)
- [ ] Viewer rendert nur über Host-Mount bzw. `<img>`; Blob-URL wird beim Schließen widerrufen
- [ ] Bausteine in `component-list.md`, Zustände in `screen-state-matrix.md`
- [ ] Farben nur über Host-Variablen (`--text`, `--muted`, `--border`, `--bg`, `--bg-elevated`)

---

# DESIGN.md — Karten-Inhalt als Markdown + Diagramme (2026-11-06)

Weitere Fläche dieses Vertrags. Herleitung: `design-plan.md`, Abschnitt „Karten-Inhalt als Markdown +
Diagramme".

## Prinzipien — Karten-Markdown

1. **Ein Renderer, kein zweiter** — jeder Text (Notes, Optionen, Waiting, Kommentare) geht durch den
   Host-Mount `mountMarkdown`; der Host besitzt Parser und DOMPurify-Allowlist.
2. **Markdown, wo es gelesen wird** — Labels, Beschreibungen und die Waiting-Zeile werden gerendert; nur die
   Notes-**Editor**-Ansicht zeigt die Rohquelle (bestand).
3. **Diagramme sind Inhalt** — ein ` ```mermaid `-Fence erscheint als Diagramm; scheitert das Rendern, bleibt
   die Quelle mit Fehlerhinweis lesbar (Host-Verhalten), nie eine leere Fläche.
4. **Inline bleibt Phrasing** — Labels in einem `button role="radio"` dürfen keinen Block-Wrapper enthalten:
   der Inline-Modus rendert ohne `<p>`, die Farbe erbt vom Steuerelement.

## Design-Entscheidungen mit Grund — Karten-Markdown

| Entscheidung                                                                                      | Grund                                                                                                                                             | Datum      |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| Neuer Host-Modus `mountMarkdown({ inline: true })` statt Plugin-eigenem Renderer                  | Der Plugin-Vertrag verbietet Host-Interna; derselbe Parser/Sanitizer bleibt der eine Owner, nur `renderInline` ohne `<p>`                         | 2026-11-06 |
| Plugin-Markdown-Renderer mountet Mermaid über den vorhandenen `MarkdownBlocks`-Besitzer           | Chat und Plugin teilen sich einen Lifecycle-Owner fuer Diagramme und Codeblock-Bedienung; kein zweiter Mermaid-Mount-Weg                          | 2026-11-06 |
| Options-Label/Beschreibung und Waiting-Zeile als Inline-Markdown                                  | Konsistenz mit Notes/Kommentaren; die sichtbare Rohquelle (`**fett**`) war die gemeldete Luecke; der zugaengliche Name bleibt der reine Labeltext | 2026-11-06 |
| Waiting-Zeile wechselt `p` → `div` mit Inline-Markdown                                            | Block-Markdown in einem `<p>` waere ungueltig; die Copy bleibt ein Satz, der nur Inline-Auszeichnung tragen darf                                  | 2026-11-06 |
| Kein neuer Parser/Sanitizer/Dependency; `toSanitizedInlineMarkdownHtml` teilt `markdownSanitizer` | XSS-Grenze bleibt der Host-Sanitizer; kein Lockfile-Churn                                                                                         | 2026-11-06 |

## Prüfliste für Reviews — Karten-Markdown

- [ ] Notes, Kommentare, Proof-Notes, Decision-Label/-Beschreibung und Waiting-Zeile laufen über `mountMarkdown`
- [ ] ` ```mermaid ` wird im Karten-Detail und im Plugin-Renderer als Diagramm gemountet, nicht als Codeblock
- [ ] Inline-Modus erzeugt kein `<p>`; Labels bleiben Phrasing-Content im `button role="radio"`
- [ ] Roh-HTML/`javascript:` bleiben inert (Host-Sanitizer); keine neuen Deps
