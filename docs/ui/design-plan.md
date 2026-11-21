# Design-Plan — Workboard Voice-Gate + Wirkungs-Protokoll (`board-talk-observability`)

Zwei-Durchgang-Artefakt (Vault-Notiz §14.2): erst schreiben, dann gegen den Auftrag lesen und jede Zeile
umschreiben, die „die Standardausgabe für irgendeinen ähnlichen Auftrag" wäre. Nicht Teil der ausgelieferten UI.

## 1. Auftrag

- **Ziel** (ein Satz, beobachtbar): Wer auf dem Board oder in einer Karte spricht, sieht **vor** dem Absenden
  den erkannten Text und **wer** ausführt, und findet **nach** dem Absenden im Verlauf den Eintrag mit
  Urheber-Agent und Zeitstempel.
- **Zielgruppe**: the operator als Board-Betreiber am Desktop (Maus + Tastatur, Mischung aus Lesen und kurzen
  Korrekturen), gelegentlich am Handy einhändig. Vorwissen: kennt Karten, Spalten und Agenten; weiß _nicht_,
  welcher Agent einen gesprochenen Satz ausführt, und will es nicht raten müssen.
- **Kernaufgabe**: (1) gesprochenen Satz lesen, fehlerhafte Stellen tippen, absenden oder verwerfen;
  (2) nach einer Weile im Verlauf einer Karte nachsehen, was sich geändert hat und wer es getan hat.
- **Nicht-Ziele**: kein zweiter Sprachkanal, kein eigener Transkriptionspfad, keine Chat-Oberfläche,
  keine Agenten-Umschaltung (welcher Agent eine _Karte_ bedient, ist eine Produktentscheidung, nicht Teil
  dieses Slice), keine Rücknahme-Funktion für bereits ausgeführte Turns.

## 2. Palette (4–6 benannte Werte)

Der Slice baut **keine eigene Farbwelt**. Er lebt in der Control UI; ein eigener Palettennamensraum neben
`--bg`, `--text`, `--accent` wäre die zweite Sprachpipeline, die der Auftrag ausschließt. Die Werte unten sind
die **gemessenen** Host-Werte (Control UI `ui/src/styles/base.css`), auf die dieser Slice sich bindet.

| Rolle                        | Dunkel    | Hell      | Herleitung (warum dieser Ton/Wert)                                                                         |
| ---------------------------- | --------- | --------- | ---------------------------------------------------------------------------------------------------------- |
| Fläche                       | `#0e1015` | `#faf9f7` | Host-Hintergrund; das Gate liegt als Dialog darüber, kein eigener Grund.                                   |
| Fläche erhöht (Dialog)       | `#191c24` | `#ffffff` | Die vorhandene Dialogfläche der Detail-Drawer; „erhöht" heißt hier: eine Ebene über der Seite.             |
| Text                         | `#bcbcc0` | `#403c35` | Grundtext; das Transkript muss wie Fließtext lesbar sein, nicht wie ein Zitat.                             |
| Text kräftig                 | `#f4f4f5` | `#211e1a` | Der Name des handelnden Agenten und der Karten-Titel: die zwei Zeichenketten, die man überfliegt.          |
| Linie                        | `#2e3040` | `#d6d0c5` | Rand des Eingabefelds und Trennung Kopf/Handlungen. Nicht der schwache Seitenrand.                         |
| Aktion (der **eine** Akzent) | `#ff5c5c` | `#bd4531` | Der Host-Akzent. **[Absenden]** ist die einzige gefüllte Aktion; Verwerfen bleibt sekundär.                |
| Signal negativ               | `#f87171` | `#b91c1c` | Nur für den Fehlerfall (Senden abgelehnt, Sitzung gesperrt). Keine Warnfarbe für „ noch nicht abgesendet". |

Kontrast vorab geprüft, gerechnet mit der WCAG-2.1-Formel aus relativer Luminanz (Werkzeug: eigenes
Python-Skript in `reports/`, Werte hier die Ausgabe; das Gate `ui-design-gate.mjs` misst am gerenderten DOM nach):

| Paar (dunkel)              | Verhältnis | Paar (hell)                | Verhältnis |
| -------------------------- | ---------- | -------------------------- | ---------- |
| Text auf Fläche            | 10,05:1    | Text auf Fläche            | 10,42:1    |
| Text kräftig auf Fläche    | 17,31:1    | Text kräftig auf Fläche    | 15,77:1    |
| Akzent auf Fläche          | 6,29:1     | Akzent auf Fläche          | 4,92:1     |
| Linie (kräftig) auf Fläche | 1,46:1     | Linie (kräftig) auf Fläche | 1,46:1     |

Die Linie liegt bewusst unter 3:1: sie ist kein Bedienelementrand, sondern eine Flächen-Trennung. Der Rand des
**fokussierbaren Eingabefelds** kommt nicht aus `--border`, sondern aus `--border-strong` **plus** dem
Fokusring des Hosts (siehe `gate-checklist.md`, Kriterium 2 und 3).

## 3. Typografie

| Rolle       | Familie                           | Größe/Laufweite                                  | Einsatz                                      |
| ----------- | --------------------------------- | ------------------------------------------------ | -------------------------------------------- |
| Body        | Host-Body-Familie (`--font-body`) | `--control-ui-text-sm` (13 px), Zeilenhöhe ≥ 1,5 | Bestätigungszeile, Verlaufszeilen            |
| Eingabe     | dieselbe Familie                  | 13 px, `pre-wrap`                                | Das editierbare Transkript                   |
| Zahlen/Zeit | dieselbe Familie, `tabular-nums`  | 12 px, `--muted`                                 | Zeitstempel im Verlauf (`formatUpdatedTime`) |

Eine Familie, drei Rollen. Keine Display-Größe: das Gate ist Werkzeug, nicht Ankündigung. Basislinie für
Abstände ist `--space-1` (4 px).

## 4. Layout-Konzept

Mobil zuerst; das Gate ist ein Dialog, also in beiden Breiten derselbe Bau, nur die Breite wächst:

```
Mobil (320 px)                          Desktop (620 px)
┌──────────────────────────────┐        ┌────────────────────────────────────────────┐
│ Transkript prüfen            │        │ Transkript prüfen                          │
│ ──────────────────────────── │        │ ────────────────────────────────────────── │
│ Führt aus: main · Board      │        │ Führt aus: main · Board „Planning"         │
│ Planning                     │        │                                            │
│ ┌──────────────────────────┐ │        │ ┌────────────────────────────────────────┐ │
│ │ move the login card to   │ │        │ │ move the login card to review          │ │
│ │ review▏                  │ │        │ │▏                                       │ │
│ └──────────────────────────┘ │        │ └────────────────────────────────────────┘ │
│ Gesprochener Satz. Änderbar. │        │ Gesprochen, nicht ausgeführt. Bearbeitbar. │
│                              │        │                                            │
│ [ Absenden ]  [ Verwerfen ]  │        │                     [ Verwerfen ] [Absenden]│
└──────────────────────────────┘        └────────────────────────────────────────────┘
```

Ausrichtung: linksbündig, weil gelesen wird; nur die Handlungen sitzen rechts (Desktop) bzw. untereinander
links (Mobil). Dichtheit: dicht — das Gate ersetzt einen Satz, es ist kein Formular. Breakpoints: 640 px
(Handlungszeile wechselt von gestapelt zu einzeilig), 768 px (Dialogbreite auf 620 px, wie die Detail-Drawer).

Im Seitenkopf und im Karten-Drawer bleibt die Mikrofonzeile **unverändert schmal**: das Gate erscheint als
Dialog, nicht inline. Der Kopf ist eine Zeile mit Titel und Bedienelementen; ein Textfeld dort würde ihn
umbrechen und die Spalte verschieben.

## 5. Prinzipien

1. **Nichts wird ohne Bestätigung ausgeführt.** Aufnahme → Gate → Absenden. Daraus folgt: Verwerfen ist immer
   möglich, auch mit Escape, und ändert nichts; es gibt keinen Pfad, der das Gate überspringt.
2. **Der handelnde Agent steht über dem Text, nicht darunter.** Wer ausführt, ist die Frage, die the operator heute
   nicht beantworten kann; sie wird zuerst beantwortet, mit dem Ziel daneben („Board Planning" / Karte „X").
   Daraus folgt: die Zeile ist immer sichtbar, auch wenn das Transkript kurz ist.
3. **Der Verlauf ist die Quittung.** Kein Toast, der verschwindet: Was ausgeführt wurde, landet mit Urheber und
   Zeit im Activity-Tab der Karte. Daraus folgt: das Protokoll muss aus dem Datenmodell kommen, nicht aus dem
   Browser-Zustand, sonst ist es nach einem Reload weg.
4. **Ein Satz, eine Handlung.** Keine Zusammenfassung, kein „ich habe verstanden": der Agent bekommt genau den
   Text, den the operator gelesen hat.
5. **Dieselbe Sprache auf beiden Ebenen.** Board-Talk und Karten-Talk benutzen dasselbe Gate und dieselbe
   Wortwahl; nur die Zeile „Führt aus" ändert sich. Daraus folgt: eine Komponente, kein zweiter Entwurf.

## 6. Zweiter Durchgang

| Teil des Plans                                     | Warum das die Standardausgabe für irgendeinen ähnlichen Auftrag wäre                                                                                                                                                       | Überarbeitet zu                                                                                                                                                                                                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| „Bestätigungsdialog mit Textfeld und zwei Buttons" | Das ist die generische Antwort auf jede Sprachbestätigung; sie sagt nichts über _diese_ Oberfläche — und der Dialog ist hier nicht die einzige Option.                                                                     | Geprüft wurde alternativ eine Inline-Leiste unter dem Mikrofon. Verworfen, weil der Seitenkopf einzeilig bleiben muss und die Karte denselben Bau braucht. Dialog **mit** Begründung im `DESIGN.md`, plus die Regel „Verwerfen über Escape".       |
| Eigene Palette „Voice = Türkis"                    | Ein eigener Farbton für ein Feature ist genau die zweite Sprachpipeline, die der Auftrag verbietet, und `--accent-2` ist im Host schon vergeben.                                                                           | Keine eigene Farbe: der Host-Akzent trägt [Absenden], `--danger` nur den Fehler. Der Plan nennt die gebundenen Host-Werte mit Messwerten statt neuer Hex-Werte.                                                                                    |
| Verlaufseintrag als Toast nach dem Absenden        | Standard-Feedback, aber the operator fragt nach „was wurde geändert und von wem" — ein Toast ist nach 4 s weg und überlebt keinen Reload.                                                                                         | Verlaufseintrag im Datenmodell (Karten-Events mit Urheber) und im UI am Ort der Änderung; die Bestätigung direkt nach dem Absenden bleibt kurz und nennt nur den Agenten.                                                                          |
| „Board-Ebene = main" als Konstante annehmen        | Bequem und wahrscheinlich richtig, aber es ist eine Produktentscheidung: Der ausgeführte Turn läuft in der Dock-Unterhaltung des Boards, deren Agent der gewählte/Standard-Agent ist — nicht zwingend die Karte-Zuordnung. | Der Plan zeigt den **tatsächlich ausgeführten** Agenten an (aus der Dock-Unterhaltung) und trägt die offene Frage „soll ein kartengebundener Turn an den zugeordneten Agenten der Karte geroutet werden?" als Designfrage aus, statt sie zu raten. |
| Zustandsmatrix nur mit „leer/gefüllt" für das Gate | Der häufigste Agentenfehler (§7): der Fehler- und der Berechtigungszustand fehlen, und die sind hier real (gesperrte Sitzung, send abgelehnt, Verlauf leer).                                                               | Matrix mit sechs Zuständen je Fläche, inklusive „keine Berechtigung" (nur Aufnahme erlaubt) und „Fehler" (Senden abgelehnt, Text bleibt erhalten).                                                                                                 |

Nicht umgesetzt (mit Grund): eine Rücknahme bereits ausgeführter Turns. Das wäre eine neue Mutationsfläche
und der Auftrag verlangt sie nicht; die Grenze steht unter „Nicht-Ziele".

---

# Design-Plan — New-card-Dialog: Sprachentwurf (`newcard-voice-draft`)

Zweite Fläche dieses Vertrags (Stand 2026-11-03). Der Talk-Gate-Plan oben bleibt gültig; dieser Abschnitt
gilt nur für den Dialog „New card" (`extensions/workboard/browser/pages/workboard/view-card-modal.tsx`,
`CardModalContent`). Erst geschrieben, dann gegen den Auftrag gelesen (§6 unten).

## 1. Auftrag — New card

- **Ziel** (ein Satz, beobachtbar): Wer im offenen Dialog „New card" spricht, sieht danach Titel, Notes,
  Labels, Priorität (und, wenn gesagt, Status/Agent) **im Formular eingetragen**, der Dialog ist **noch offen**,
  und die Karte entsteht erst, wenn er **Create** drückt.
- **Zielgruppe**: the operator als Board-Betreiber am Desktop (Maus + Tastatur), der eine Aufgabe schneller sagt als
  tippt; gelegentlich am Handy. Vorwissen: kennt das Formular und die Labels seines Boards. Er erwartet, dass
  er das Ergebnis prüft — nicht, dass das System für ihn speichert.
- **Kernaufgabe**: (1) Mikrofon im Dialog-Kopf, einen Satz sprechen („Login-Bug fixen, dringend, Label
  frontend"), Felder prüfen, ggf. korrigieren, **Create**; (2) dasselbe, aber die Antwort passt nicht —
  Felder von Hand ändern oder **Cancel**; nichts wurde gespeichert.
- **Nicht-Ziele**: kein Auto-Submit, kein Auto-Save, kein zweiter Sprachkanal (das Board-/Karten-Mikrofon mit
  Talk-Gate bleibt unverändert), kein Chat-Turn (`chat.send`), keine neuen Labels anlegen, kein Mikrofon im
  Bearbeiten-Dialog einer bestehenden Karte, keine Auswahl des Entwurfsmodells im Browser.

## 2. Palette (4–6 benannte Werte) — New card

Wie beim Talk-Gate: **keine eigene Farbwelt**. Die Fläche sitzt im vorhandenen Dialog und benutzt nur, was der
Dialog schon benutzt. Neu ist allein die ruhige Statuszeile; sie liegt auf der Dialogfläche.

| Rolle                    | Dunkel    | Hell      | Herleitung                                                                                          |
| ------------------------ | --------- | --------- | --------------------------------------------------------------------------------------------------- |
| Fläche (Dialog)          | `#0e1015` | `#faf9f7` | `--panel` (96 % mit `--bg`), die vorhandene Fläche des New-card-Formulars (nachgemessen in Phase 3) |
| Text                     | `#bcbcc0` | `#403c35` | `--text`: die Felder selbst, unverändert                                                            |
| Statuszeile / Hinweise   | `#8b8b94` | `#6e6960` | `--muted`: ruhig, weil sie berichtet und nicht auffordert; trotzdem Fließtextkontrast (siehe unten) |
| Aktion (der eine Akzent) | `#ff5c5c` | `#bd4531` | `--accent`: bleibt bei **Create**; das Mikrofon zeigt Aufnahme selbst (Host-Baustein)               |
| Signal negativ           | `#f87171` | `#b91c1c` | `--danger`: nur über den vorhandenen Fehler-Toast des Dialogs, nicht in der Statuszeile             |

Kontrast vorab gerechnet (WCAG-2.1-Formel, relative Luminanz; `node -e` mit den Hex-Werten aus
`ui/src/styles/base.css`): Statuszeile `--muted` auf der Formularfläche `--panel` **5,63:1** (dunkel) / **5,18:1**
(hell); der erste Entwurf rechnete gegen `--bg-elevated` (5,04:1 / 5,45:1) — die Fixture zeigte, dass das Formular
auf `--panel` liegt. Das Gate hat am gerenderten DOM 0 Textknoten unter 4,5:1 gemessen.

## 3. Typografie — New card

| Rolle       | Familie                           | Größe/Laufweite                                | Einsatz                                   |
| ----------- | --------------------------------- | ---------------------------------------------- | ----------------------------------------- |
| Body        | Host-Body-Familie (`--font-body`) | Felder unverändert                             | Titel/Notes/Labels wie bisher             |
| Statuszeile | dieselbe Familie                  | `0.82rem` (wie die Kopf-Hilfe), Zeilenhöhe 1,5 | „Filling in…", „Filled in…", Hinweisliste |

Eine Familie, keine neue Größe: die Statuszeile übernimmt die Größe der vorhandenen Kopfbeschreibung
(`.workboard-modal__header p`), damit sie als Teil des Dialogs liest und nicht als Banner.

## 4. Layout-Konzept — New card

```
Mobil (320 px)                          Desktop (700 px Dialog)
┌──────────────────────────────┐        ┌───────────────────────────────────────────────┐
│ New card            [🎙] [×] │        │ New card                            [🎙]  [×] │
│ Filled in from your words.   │        │ Filled in from your words. Check the fields;  │
│ Check the fields; nothing is │        │ nothing is created until you press Create.    │
│ created until you press      │        │ · Label "infra" is not on this board; left out│
│ Create.                      │        │ [Title ......................................] │
│ · Label "infra" … left out.  │        │ Suggestions (+ Bugfix) (+ Docs) …              │
│ [Title ....................] │        │ [Notes ......................................] │
│ …                            │        │ Status · Agent · Session · Priority · Labels   │
│            [Cancel] [Create] │        │                              [Cancel] [Create] │
└──────────────────────────────┘        └───────────────────────────────────────────────┘
```

Ausrichtung: Das Mikrofon sitzt **rechts im Kopf, links neben dem Schließen-Knopf** — dieselbe Ecke, in der
das Board-Mikrofon im Seitenkopf steht, und weit weg von **Create** (keine Verwechslung „sprechen = anlegen").
Die Statuszeile steht **direkt unter dem Kopf, über dem Titel**, am Anfang des scrollenden Formularkörpers: dort,
wo das Auge nach dem Sprechen hinsieht, und vor den Feldern, die sie beschreibt. Sie nimmt nur Platz ein, solange es
etwas zu sagen gibt. (Erster Entwurf: im Kopf — bei 320 px / 200 % Zoom abgeschnitten, siehe Gate-Befunde.)
Dichtheit: dicht, wie der Dialog. Breakpoints: keine neuen; der Dialog bricht wie bisher bei 768 px.

## 5. Prinzipien — New card

1. **Sprechen füllt aus, nur Create legt an.** → Die Antwort schreibt ausschließlich die vorhandenen
   Draft-Felder; `saveWorkboardCardDraft` hat genau einen Aufrufer (Create). Der Dialog bleibt offen.
2. **Nichts erfinden.** → Ein Feld, das der Satz nicht hergibt, bleibt leer bzw. behält den Wert des Operators.
   Leere Antwortfelder überschreiben nichts. Was verworfen wurde, steht als Hinweis da — nicht still.
3. **Nur die Wörter des Boards.** → Labels nur aus der Board-Palette, in ihrer Schreibweise; Status und
   Priorität nur aus den festen Listen; Agent nur, wenn der Server ihn kennt.
4. **Der Operator behält das Formular.** → Kein Fokusraub, keine Sperre der Felder während des Entwurfs; nur das
   Mikrofon ist gesperrt, solange ein Entwurf läuft.
5. **Fehler lassen alles stehen.** → Scheitert der Entwurf, bleibt jedes Feld wie vorher und der Dialog offen;
   die Meldung kommt über den vorhandenen Fehler-Toast.

## 6. Zweiter Durchgang — New card

| Teil des Plans                                          | Warum das die Standardausgabe wäre                                                                                                                       | Überarbeitet zu                                                                                                                                                 |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| „Transkript-Gate wiederverwenden, dann Formular füllen" | Naheliegend, weil es das Gate schon gibt — aber hier gibt es nichts auszuführen; ein zweiter Dialog über dem Dialog wäre Bestätigung einer Nicht-Aktion. | Kein Gate: das **Formular selbst ist die Bestätigung**. Der Operator sieht das Ergebnis in den Feldern und entscheidet mit Create/Cancel.                       |
| „Erfolgs-Toast: Karte vorbereitet"                      | Standard-Feedback; ein Toast verschwindet, bevor man die Felder geprüft hat, und Toast ist hier die Fehlerfläche.                                        | Ruhige Statuszeile im Dialog (`aria-live="polite"`), die stehen bleibt, bis erneut gesprochen wird oder der Dialog schließt; Hinweise als Liste darunter.       |
| „Felder während des Entwurfs sperren"                   | Typischer Ladezustand für Formulare, der den Nutzer zum Warten zwingt.                                                                                   | Nur das Mikrofon ist gesperrt (mit Grund); die Felder bleiben bedienbar. Eine Antwort ersetzt, was sie füllt — das ist gewollt, er hat gerade bewusst diktiert. |
| „Unbekannte Labels als neue Labels anlegen"             | Bequem, aber es würde die Palette des Boards von einem Sprachfehler aus verändern.                                                                       | Unbekannte Labels werden verworfen und benannt; die Palette ändert sich nur über den bestehenden Label-Editor.                                                  |
| „Mikrofon auch im Bearbeiten-Dialog"                    | Symmetrie-Reflex.                                                                                                                                        | Nicht im Auftrag; Ersetzen eines bestehenden Karteninhalts per Sprache ist eine andere Entscheidung. Nur im New-card-Dialog.                                    |

Nicht umgesetzt (mit Grund): Übersetzung der Server-Hinweise in die Oberflächensprache. Die Hinweise kommen
als kurze englische Klartexte vom Server (wie dessen Fehlermeldungen); eine strukturierte Hinweisliste wäre ein
größerer Vertrag als dieser Slice braucht.

---

# Design-Plan — Artefakt per Kanal teilen (`artifact-share-channel`)

Weitere Fläche dieses Vertrags (Stand 2026-11-03). Die Pläne oben bleiben gültig; dieser Abschnitt gilt nur
für die Aktion „Share…" an einer Artefakt-Zeile im Karten-Drawer
(`extensions/workboard/browser/pages/workboard/view-card-artifacts.tsx`) und den Dialog, den sie öffnet
(`view-card-share.tsx`). Erst geschrieben, dann gegen den Auftrag gelesen (§6 unten).

## 1. Auftrag — Artefakt teilen

- **Ziel** (ein Satz, beobachtbar): An jeder Artefakt-Zeile mit URL oder Host-Pfad gibt es „Share…"; der
  Dialog zeigt **vor** dem Senden genau den Text, der rausgeht (Label + Verweis), lässt Kanal (und bei mehreren
  Konten das Konto) wählen und ein Ziel eingeben, sendet erst auf **Send** über die Gateway-Methode `send` und
  quittiert danach an der Zeile — oder zeigt den Fehler im offenen Dialog, ohne Ziel oder Kanal zu verlieren.
- **Zielgruppe**: the operator als Board-Betreiber am Desktop (Maus + Tastatur), gelegentlich am Handy. Vorwissen:
  kennt seine Kanäle (WhatsApp, Telegram, …) und die Zieladressen in deren Format; weiß, dass ein Artefakt
  ein Pfad auf `gateway` oder eine URL ist. Er will einen Verweis schnell weitergeben, nicht eine Datei hochladen.
- **Kernaufgabe**: (1) Artefakt-Zeile → „Share…" → Kanal prüfen → Ziel eintippen (oder Vorschlag wählen) →
  **Send** → Quittung „Sent to … via …" an der Zeile. (2) Senden scheitert (Ziel ungültig, Kanal getrennt) →
  Fehlermeldung im Dialog lesen → Ziel korrigieren → erneut **Send**.
- **Nicht-Ziele**: kein Upload und keine Medien (`mediaUrl`, `mediaUrls`, `buffer` bleiben leer); keine zweite
  Send-Route (`conversations.send` nie); keine neue Gateway-Methode; kein Server-Event, kein Kommentar, kein
  Status an der Karte (der Workboard-Store wird nicht geschrieben); kein Konto- oder Thread-Routing aus dem
  Verzeichnis; kein Senden beim Wählen eines Kanals; kein Teilen mehrerer Artefakte auf einmal; keine Kanal-
  Einrichtung aus dem Dialog.

## 2. Palette (4–6 benannte Werte) — Artefakt teilen

Keine eigene Farbwelt — wie bei Talk-Gate und New-card-Dialog. Der Dialog liegt auf der Host-Dialogfläche und
bindet nur Host-Werte (`ui/src/styles/base.css`). Kein neuer Token in `tokens.css`: jede Rolle unten hat dort
schon ihren semantischen Namen.

| Rolle                            | Dunkel    | Hell      | Semantik (tokens.css) | Herleitung                                                                                       |
| -------------------------------- | --------- | --------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| Fläche (Dialog)                  | `#191c24` | `#ffffff` | `--surface-elevated`  | `--bg-elevated`, dieselbe Dialogfläche wie Talk-Gate                                             |
| Text                             | `#bcbcc0` | `#403c35` | `--text`              | `--text`: Feldbeschriftungen, Vorschau der Nachricht                                             |
| Hinweis / Grund / Kontrollgrenze | `#8b8b94` | `#6e6960` | `--text-muted`        | `--muted`: Hilfetext, gesperrt-Gründe **und** Rand von Feld und Sekundärknopf (Nicht-Text ≥ 3:1) |
| Trennung                         | `#1e2028` | `#e8e4dc` | `--line`              | `--border`: nur Trennlinie über der Fußzeile — **kein** Bedienelementrand                        |
| Aktion (der eine Akzent)         | `#ff5c5c` | `#bd4531` | `--action`            | `--accent`: nur **Send** ist gefüllt; „Share…" an der Zeile bleibt sekundär                      |
| Signal negativ                   | `#f87171` | `#b91c1c` | `--negative`          | `--danger`: nur der Sendefehler und der Ladefehler der Kanäle                                    |

Kontrast vorab gerechnet (WCAG-2.1-Formel aus relativer Luminanz; Werkzeug: `node contrast.mjs` in
`/workspace/main/state/workspace-b/reports/artifact-share-20261103/`, Ausgabe `contrast.txt`):

| Paar                                     | Dunkel  | Hell    |
| ---------------------------------------- | ------- | ------- |
| `--text` auf Dialogfläche                | 9,00:1  | 10,96:1 |
| `--text-strong` auf Dialogfläche         | 15,50:1 | 16,60:1 |
| `--muted` auf Dialogfläche (Text + Rand) | 5,04:1  | 5,45:1  |
| `--danger` auf Dialogfläche              | 6,16:1  | 6,47:1  |
| `--accent` auf Dialogfläche              | 5,63:1  | 5,17:1  |
| `--accent-foreground` auf `--accent`     | 6,29:1  | 5,17:1  |
| `--border` auf Dialogfläche (Trennung)   | 1,05:1  | 1,27:1  |

`--border` liegt bewusst unter 3:1 und trägt deshalb **nichts**, was bedient wird — Feld- und Knopfrand
binden an `--muted` wie im Talk-Gate (Befund 2026-11-02, `gate-checklist.md`). Das Gate misst am gerenderten
DOM nach.

## 3. Typografie — Artefakt teilen

| Rolle             | Familie                           | Größe/Laufweite                                           | Einsatz                                           |
| ----------------- | --------------------------------- | --------------------------------------------------------- | ------------------------------------------------- |
| Titel             | Host-Body-Familie (`--font-body`) | 1.1rem, wie `.workboard-voice-gate h2`                    | „Share artifact"                                  |
| Body              | dieselbe Familie                  | `--control-ui-text-sm` (13 px), 1,5                       | Einleitung, Feldbeschriftungen, Gründe, Fehler    |
| Nachrichtvorschau | Host-Monospace (`code`)           | 0.76rem wie `.workboard-artifacts__reference`, `pre-wrap` | Label + Verweis, genau wie gesendet, umbruchfähig |
| Hilfe             | dieselbe Body-Familie             | 0.82rem, `--muted`                                        | Zielformat-Hinweis unter dem Feld                 |

Eine Body-Familie mit klaren Rollen; `code` ist keine zweite Gestaltungsfamilie, sondern die schon an der
Zeile benutzte Verweis-Optik — derselbe Verweis soll im Dialog wiedererkannt werden.

## 4. Layout-Konzept — Artefakt teilen

```
Mobil (320 px)                          Desktop (Dialog 620 px)
┌──────────────────────────────┐        ┌────────────────────────────────────────────┐
│ Share artifact               │        │ Share artifact                             │
│ Sends this reference as text.│        │ Sends this reference as a text message.    │
│ The file is not uploaded.    │        │ The file itself is not uploaded.           │
│ Message                      │        │ Message                                    │
│ ┌──────────────────────────┐ │        │ ┌────────────────────────────────────────┐ │
│ │ demo.mp4                 │ │        │ │ demo.mp4                               │ │
│ │ /workspace/main/ │ │        │ │ /workspace/main/state/…/demo.mp4│ │
│ │ state/…/demo.mp4         │ │        │ └────────────────────────────────────────┘ │
│ └──────────────────────────┘ │        │ Channel             Account                │
│ Channel                      │        │ [WhatsApp      ▾]   [Personal       ▾]     │
│ [WhatsApp               ▾]   │        │ Recipient                                  │
│ Account (nur bei >1 Konto)   │        │ [+4915…                                  ] │
│ [Personal               ▾]   │        │ Phone number, user or chat ID in the       │
│ Recipient                    │        │ channel's own format.                      │
│ [+4915…                    ] │        │ Enter a recipient to send.  (Grund/Fehler) │
│ Phone number, user or chat … │        │ ────────────────────────────────────────── │
│ Enter a recipient to send.   │        │                          [Cancel] [ Send ] │
│ ──────────────────────────── │        └────────────────────────────────────────────┘
│ [Cancel] [ Send ]            │
└──────────────────────────────┘

Artefakt-Zeile (unverändert bis auf eine sekundäre Aktion am Ende der Aktionsleiste):
│ demo.mp4                                   video/mp4 │
│ /workspace/main/state/…/demo.mp4             │
│ [Copy path] [Share…]   Sent to +4915… via WhatsApp.  │
```

Ausrichtung: linksbündig, Felder in Lesereihenfolge **Was → Wohin → Senden**; die Vorschau steht vor den
Feldern, weil sie die Frage „was geht raus?" beantwortet, bevor gefragt wird „an wen?". Kanal und Konto stehen
ab 640 px nebeneinander, darunter gestapelt. Gründe und Fehler stehen **direkt unter dem Ziel-Feld**, also am
Feld, nicht in einem Toast. Die Quittung erscheint nach dem Schließen an der Zeile, an der man geklickt hat.
Dichtheit: dicht, wie der Drawer. Breakpoints: 640 px (Kanal/Konto nebeneinander, Fußzeile einzeilig rechts);
die Dialogbreite 620 px kommt vom Host-Dialog.

## 5. Prinzipien — Artefakt teilen

1. **Geteilt wird der Verweis, nie die Bytes.** → Der Request enthält nur `{ channel, accountId, to, message,
idempotencyKey }`; die Vorschau zeigt genau `message`. Kein Upload-Feld, kein Anhang-Hinweis.
2. **Erst Send sendet.** → Kanalwechsel, Kontowechsel, Vorschlag wählen, Enter im leeren Feld: nichts davon
   ruft `send`. Abbrechen und Escape schließen ohne Request.
3. **Der eingegebene Text ist die Wahrheit.** → Vorschläge aus `conversations.list` (nur mit Admin-Recht) füllen
   nur die `datalist`; aus ihnen werden weder Konto noch Thread abgeleitet; ihr Fehlen ist kein Fehler.
4. **Gesperrt heißt: mit Grund.** → Jeder gesperrte Send-Knopf hat einen sichtbaren Satz daneben (lädt, keine
   Kanäle, schreibgeschützt, kein Ziel), per `aria-describedby` verknüpft.
5. **Der Fehler zerstört nichts.** → Ziel, Kanal und Konto bleiben, der Dialog bleibt offen, Send ist sofort
   wieder möglich (mit neuem `idempotencyKey`; ein Doppelklick während des Sendens erzeugt keinen zweiten
   Request).

## 6. Zweiter Durchgang — Artefakt teilen

| Teil des Plans                                 | Warum das die Standardausgabe für irgendeinen ähnlichen Auftrag wäre                                                                          | Überarbeitet zu                                                                                                                                                                   |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| „Share-Icon (Pfeil aus Kasten) an jeder Zeile" | Das generische Teilen-Symbol; an einer Zeile mit Textknöpfen („Copy path", „Open") wäre es das einzige Icon und ohne Beschriftung mehrdeutig. | Textknopf „Share…" neben „Copy path", gleiche Größe und Optik; die Ellipse sagt „öffnet einen Dialog". `aria-label` nennt das Artefakt, weil mehrere Zeilen denselben Text haben. |
| „Freitext-Nachricht mit vorausgefülltem Text"  | Typisches Teilen-Formular — aber dann ist nicht mehr garantiert, dass nur der Verweis rausgeht, und der Auftrag schreibt die Form fest.       | Feste, deterministische Nachricht als **nicht editierbare** Vorschau (`code`-Block). Wer mehr schreiben will, schreibt im Kanal weiter.                                           |
| „Kanal-Kacheln mit Logos zur Auswahl"          | Die übliche „Teilen über…"-Ansicht von Mobil-OS; braucht Logos/Farben pro Kanal (fremde Farbwelt) und skaliert nicht auf Konten.              | Host-`SelectPicker` mit den Kanal-Labels aus `channels.status`; Konto-Picker nur bei >1 Konto. Keine Kanalfarben.                                                                 |
| „Erfolgs-Toast unten rechts"                   | Standard-Feedback; im Drawer ist der Toast die Fehlerfläche und verschwindet, bevor man die Zeile wiederfindet.                               | Quittung als `role="status"`-Text an der geteilten Zeile, wie „Copied" beim Kopieren — derselbe Ort, dieselbe Wortwahl („Send" → „Sent to …").                                    |
| „Gesendet-Eintrag im Karten-Verlauf"           | Naheliegend nach dem Talk-Gate („der Verlauf ist die Quittung") — wäre aber ein Server-Event und damit eine neue Schreibfläche im Store.      | Bewusst **kein** Store-Schreibzugriff (Nicht-Ziel); die Quittung lebt nur im Browser. Der Kanal selbst ist der dauerhafte Beleg.                                                  |
| „Fehler als Toast + Dialog schließt"           | Der häufigste Agentenfehler: der Fehlerfall verliert die Eingabe.                                                                             | Fehler `role="alert"` unter dem Ziel-Feld, Dialog bleibt offen, Eingaben bleiben, Send erneut möglich.                                                                            |

Nicht umgesetzt (mit Grund): Vorschläge ohne Admin-Recht. `conversations.list` verlangt `operator.admin`; für
Schreib-Verbindungen bleibt das Ziel ein reines Freitextfeld. Eine neue, schwächer berechtigte Methode wäre
eine neue Gateway-Fläche, die der Auftrag ausschließt.

---

# Design-Plan — Entscheidungskarte als Ask-Dialog (`workboard-ask-dialog`)

Weitere Fläche dieses Vertrags (Stand 2026-11-03). Die Pläne oben bleiben gültig; dieser Abschnitt gilt nur
für das Entscheidungs-Panel im Karten-Drawer
(`extensions/workboard/browser/pages/workboard/view-card-decision.tsx`, `CardDecision`), das nur auf einer
blockierten Karte mit Label `decision` auf einem schreibbaren, nicht archivierten Board erscheint. Erst
geschrieben, dann gegen den Auftrag gelesen (§6 unten).

## 1. Auftrag — Ask-Dialog

- **Ziel** (ein Satz, beobachtbar): Auf einer Entscheidungskarte wählt der Operator eine **nummerierte,
  anklickbare Option** (1..N, Label + Beschreibung, Empfehlung als Text markiert) — per Klick oder Zifferntaste —
  **oder** tippt eine eigene Antwort; jede Auswahl wird als Kommentar `Decision: <Antwort>` gespeichert und
  verschiebt die Karte nach **Ready**; Karten **ohne** Optionen zeigen weiter nur das Freitextfeld.
- **Zielgruppe**: the operator als Board-Betreiber am Desktop (Maus + Tastatur), der eine Rückfrage eines Agenten
  schnell beantworten will, gelegentlich am Handy. Vorwissen: kennt die Karte und meist die Frage; kennt das
  Ask-Muster aus Claude Code / Codex (Ziffer wählt, „Other" ist Freitext). Er will die Empfehlung des Agenten
  sehen, ohne die Notes nach „Empfehlung: (2)" zu durchsuchen.
- **Kernaufgabe**: (1) Karte öffnen → Optionen lesen → Empfehlung erkennen → Option anklicken oder Ziffer
  drücken → Karte steht in Ready, Label `decision` weg. (2) Keine Option passt → eigene Antwort tippen →
  **Decision made** (Ready) oder **Add note** (bleibt blockiert, z. B. „Frage erst Alex").
- **Nicht-Ziele**: kein `multiSelect` (der Kommentar `Decision: …` ist eine Zeile; mehrere Antworten würden die
  Note-Form ändern und den Ready-Move undeutbar machen); kein Auto-Submit beim Tippen; keine Sortierung nach
  Empfehlung (die Listenreihenfolge ist die Nummer); keine neue Gateway-Methode und keine Schemaänderung; keine
  Bearbeitung der Optionen im Browser (die Optionen kommen vom Agenten); keine Änderung am Antwortweg.

## 2. Palette (4–6 benannte Werte) — Ask-Dialog

Keine eigene Farbwelt — das Panel liegt im Karten-Drawer auf der Host-Fläche `--bg-elevated` und bindet nur
Host-Werte (`ui/src/styles/base.css`). Kein neuer Token in `tokens.css`: jede Rolle hat dort schon ihren
semantischen Namen.

| Rolle                                 | Dunkel    | Hell      | Semantik (tokens.css) | Herleitung                                                                                                      |
| ------------------------------------- | --------- | --------- | --------------------- | --------------------------------------------------------------------------------------------------------------- |
| Fläche (Drawer)                       | `#191c24` | `#ffffff` | `--surface-elevated`  | `--bg-elevated`: die Drawer-Fläche, auf der auch die Optionszeilen (`.btn`-Füllung) liegen                      |
| Option-Label                          | `#f4f4f5` | `#211e1a` | `--text-strong`       | Das, was überflogen wird: die Antwort selbst                                                                    |
| Nummer, Badge-Text                    | `#bcbcc0` | `#403c35` | `--text`              | Nummer und „Recommended" sind Lesetext, keine Aufforderung; Badge bewusst **nicht** im Akzent                   |
| Beschreibung, Hinweis, Kontrollgrenze | `#8b8b94` | `#6e6960` | `--text-muted`        | `--muted`: Beschreibung, Tastaturhinweis **und** Rand von Optionszeile, Badge, Textfeld, „Add note" (≥ 3:1)     |
| Aktion (der eine Akzent)              | `#d13c3c` | `#bd4531` | `--action`            | `--primary`/`--accent`: nur **Decision made** ist gefüllt; eine Option ist eine Zeile, kein zweiter Primärknopf |
| Signal negativ                        | `#f87171` | `#b91c1c` | `--negative`          | `--danger`: nur der vorhandene Fehler-Toast (`decisionMoveFailed`); das Panel selbst färbt nichts rot           |

Kontrast vorab gerechnet (WCAG-2.1-Formel aus relativer Luminanz; Werkzeug: `node contrast.mjs` in
`/workspace/main/state/workspace-b/reports/workboard-ask-dialog-gate/`, Ausgabe `contrast.txt`):

| Paar                                                         | Dunkel  | Hell    |
| ------------------------------------------------------------ | ------- | ------- |
| `--text-strong` (Label) auf Drawer-Fläche                    | 15,50:1 | 16,60:1 |
| `--text` (Nummer, Badge) auf Drawer-Fläche                   | 9,00:1  | 10,96:1 |
| `--muted` (Beschreibung, Hinweis) auf Drawer-Fläche          | 5,04:1  | 5,45:1  |
| `--muted` (Beschreibung) auf `--bg-hover` (Zeile unter Maus) | 4,64:1  | 4,59:1  |
| `--muted` als Rand (Zeile, Badge, „Add note") auf Fläche     | 5,04:1  | 5,45:1  |
| `--muted` als Rand des Textfelds auf dessen Füllung          | 5,54:1  | 5,23:1  |
| `--ring` (Fokusring) auf Drawer-Fläche                       | 5,63:1  | 5,17:1  |
| `--primary-foreground` auf `--primary` (Decision made)       | 4,75:1  | 5,17:1  |
| `--border` auf Drawer-Fläche (Host-Standardrand)             | 1,05:1  | 1,27:1  |

`--border` liegt unter 3:1 und trägt deshalb **keinen** Bedienelementrand dieses Panels — Optionszeilen,
Textfeld und „Add note" binden an `--muted` wie Talk-Gate und Share-Dialog. Das Gate misst am gerenderten DOM
nach.

## 3. Typografie — Ask-Dialog

| Rolle        | Familie                           | Größe/Laufweite                                   | Einsatz                                          |
| ------------ | --------------------------------- | ------------------------------------------------- | ------------------------------------------------ |
| Abschnitt    | Host-Body-Familie (`--font-body`) | wie die übrigen `h3` im Drawer                    | „Your decision"                                  |
| Option-Label | dieselbe Familie                  | 13 px (`.btn`), Gewicht 600, `--text-strong`      | die Antwort, darf umbrechen                      |
| Nummer       | dieselbe Familie, `tabular-nums`  | 13 px, `--text`, feste Spaltenbreite `2ch`        | „1." … „6." — eine Spalte, die nicht springt     |
| Beschreibung | dieselbe Familie                  | 0.82rem, `--muted`, Zeilenhöhe 1,5, Gewicht 400   | eine Zeile Begründung unter dem Label            |
| Badge        | dieselbe Familie                  | 0.74rem, `--text`, normale Schreibung (kein CAPS) | „Recommended" rechts im Label-Kopf, umbruchfähig |
| Hinweis      | dieselbe Familie                  | wie `.workboard-decision__hint`, `--muted`        | Bedienhinweis (Klick/Ziffer/eigene Antwort)      |

Eine Familie, klare Rollen; keine Display-Größe. Die Nummer ist die einzige Figurenspalte und bekommt deshalb
`tabular-nums`.

## 4. Layout-Konzept — Ask-Dialog

```
Mobil (320 px Drawer)                    Desktop (Drawer 620 px)
┌──────────────────────────────┐         ┌──────────────────────────────────────────────┐
│ Your decision                │         │ Your decision                                │
│ Pick an option — click it or │         │ Pick an option — click it or press its       │
│ press its number — or write  │         │ number — or write your own answer below.     │
│ your own answer below.       │         │ ┌──────────────────────────────────────────┐ │
│ ┌──────────────────────────┐ │         │ │ 1.  SQLite                               │ │
│ │1. SQLite                 │ │         │ │     One file, no server to run.          │ │
│ │   One file, no server.   │ │         │ ├──────────────────────────────────────────┤ │
│ ├──────────────────────────┤ │         │ │ 2.  Postgres              [Recommended]  │ │
│ │2. Postgres               │ │         │ │     Scales past one writer; needs a host.│ │
│ │   [Recommended]          │ │         │ ├──────────────────────────────────────────┤ │
│ │   Scales past one writer │ │         │ │ 3.  Keep JSON files                      │ │
│ ├──────────────────────────┤ │         │ └──────────────────────────────────────────┘ │
│ │3. Keep JSON files        │ │         │ Or write your own answer                     │
│ └──────────────────────────┘ │         │ ┌──────────────────────────────────────────┐ │
│ Or write your own answer     │         │ │ Write the decision...                    │ │
│ ┌──────────────────────────┐ │         │ └──────────────────────────────────────────┘ │
│ │ Write the decision...    │ │         │                     [Add note] [Decision made]│
│ └──────────────────────────┘ │         └──────────────────────────────────────────────┘
│ [Add note] [Decision made]   │
└──────────────────────────────┘
```

Ausrichtung: linksbündig, weil gelesen wird. Die Optionen stehen **untereinander als volle Zeilen** (nicht als
Pillen in einer Reihe): Beschreibung und Badge brauchen Platz, und die Nummer muss eine eigene Spalte haben, damit
„2" und „2. Postgres" sofort zusammenpassen. Das Badge sitzt im Label-Kopf und bricht bei 320 px unter das Label.
Reihenfolge im Panel: Hinweis → Optionen → eigene Antwort → Knöpfe — die Optionen zuerst, weil sie die schnelle
Antwort sind; das Freitextfeld ist immer da, aber nachgeordnet. Dichtheit: dicht wie der Drawer, Zeilen ≥ 44 px
hoch. Breakpoints: keine neuen; der Drawer bestimmt die Breite.

## 5. Prinzipien — Ask-Dialog

1. **Die Reihenfolge des Agenten ist die Nummer.** → `1..N` sind die Indizes der gespeicherten Liste; der
   Browser sortiert nicht um, auch nicht nach Empfehlung.
2. **Ein Klick ist eine Entscheidung.** → Option anklicken, Ziffer drücken oder Enter/Leertaste auf der
   fokussierten Option gehen denselben Weg wie heute „Decision made": Kommentar, dann Ready ohne `decision`-Label.
3. **Tippen entscheidet nie.** → Ziffern zählen nur außerhalb von Textfeldern; das Freitextfeld löst nichts aus,
   bis **Add note** oder **Decision made** gedrückt wird; ein Klick auf eine Option füllt das Feld nicht.
4. **Die Empfehlung steht in Text da.** → Badge „Recommended" + Zusatz im zugänglichen Namen; keine Farbe als
   einziges Signal; höchstens eine Empfehlung (die erste gewinnt).
5. **Fehler lassen alles stehen.** → Scheitert der Ready-Move (Dispatch lief an), bleibt die Karte blockiert, die
   gewählte Option bleibt markiert, der getippte Text bleibt; erneut entscheiden ist sofort möglich.

## 6. Zweiter Durchgang — Ask-Dialog

| Teil des Plans                                        | Warum das die Standardausgabe für irgendeinen ähnlichen Auftrag wäre                                                                                | Überarbeitet zu                                                                                                                                                                 |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| „Radio-Buttons + Absenden-Knopf"                      | Das generische Formular für „wähle eins" — es verdoppelt den Klick und widerspricht der bestehenden Semantik, in der die Pillen sofort entscheiden. | Die Zeile **ist** der Knopf (`role="radio"`): Klick/Ziffer/Enter entscheidet sofort; Pfeiltasten bewegen nur den Fokus, damit Tastaturnutzer lesen können, ohne zu entscheiden. |
| „Empfohlene Option nach oben sortieren, grün färben"  | Übliche Hervorhebung; sie ändert die Nummern, die der Agent in seiner Frage nennt („(2) empfohlen"), und Grün wäre eine zweite Farbwelt.            | Reihenfolge unangetastet; Empfehlung als Text-Badge im neutralen `--text` mit `--muted`-Rand, plus „recommended" im zugänglichen Namen.                                         |
| „Badge im Akzent"                                     | Der naheliegende Weg, Wichtiges zu markieren — dann gäbe es zwei Akzente (Badge und **Decision made**) und die Empfehlung sähe wie eine Aktion aus. | Badge ohne Füllung; der eine Akzent bleibt beim Primärknopf.                                                                                                                    |
| „Ziffern-Shortcut global auf der Seite"               | Schnell gebaut; er würde beim Tippen im Freitextfeld oder in anderen Feldern des Drawers Karten verschieben.                                        | Ziffern nur im Panel und **nur** außerhalb von `input`/`textarea`/`select`/`contenteditable`, ohne Modifier; ein Test hält genau das fest.                                      |
| „Pillen wie bisher, nur mit Nummer davor"             | Kleinster Eingriff — aber Pillen haben keinen Platz für eine Beschreibung und brechen bei 320 px in eine unlesbare Wolke um.                        | Volle Zeilen untereinander mit Nummernspalte; Notes-Checkbox-Optionen (Stufe 2) nutzen dieselbe Zeile, nur ohne Beschreibung und Badge.                                         |
| „Leerer Optionsbereich mit ‚Keine Optionen' anzeigen" | Standard-Leerzustand — hier aber Rauschen: ohne Optionen ist das Freitextfeld die vollständige, gewohnte Oberfläche.                                | Stufe 3 rendert **keinen** Auswahlblock (kein leerer Container, kein `aria-label` ohne Inhalt) und keinen Tastaturhinweis; nur der bisherige Hinweis und das Feld.              |

Nicht umgesetzt (mit Grund): eine Vorschau (`preview`) je Option wie bei `ask_user`. Der Auftrag legt die Form
`{label, description?, recommended?}` fest; eine Vorschau wäre ein weiteres Feld im Contract.

---

# Design-Plan — Board-Palette (Klassifizierungen) im Board-Dialog (`workboard-labels-cli-ui`, 2026-11-04)

Zwei-Durchgang-Artefakt (§14.2): erst schreiben, dann gegen den Auftrag lesen und die Standardausgabe-Zeilen
umschreiben. Nicht Teil der ausgelieferten UI.

## 1. Auftrag — Board-Palette

- **Ziel** (beobachtbar): Ein Board-Betreiber kann im **Edit board**-Dialog die Klassifizierungs-Palette eines
  Cards-Boards selbst bearbeiten — Namen umbenennen, Farbe aus den acht Session-Farben wählen, Reihenfolge
  ändern, Einträge hinzufügen und entfernen — und beim Speichern wird genau diese Liste zur Palette.
- **Zielgruppe**: the operator als Board-Betreiber am Desktop (Maus + Tastatur), gelegentlich am Handy. Vorwissen:
  kennt Karten, Labels und dass Labels aus der Palette kommen; will die Palette pflegen, ohne den Agenten oder
  die CLI zu rufen.
- **Kernaufgabe**: Palette an einer Stelle pflegen; danach zieht die Karten-Label-Bearbeitung aus der neuen Liste.
- **Nicht-Ziele**: keine Karten-Labels umschreiben (das Umbenennen/Entfernen lässt bestehende Labels als
  einfache Chips stehen, wie ein `replaces`); keine Farbwelt außerhalb der acht Session-Farben; keine
  Sessions-Boards (die haben keine Palette); keine Neuanordnung durch Ziehen (Knöpfe Auf/Ab genügen).

## 2. Palette (Werte)

Der Slice baut **keine eigene Farbwelt**. Er bindet an die Control-UI-Tokens; die Slot-Farben sind die acht
`--session-color-*`-Werte des Hosts (Rot, Blau, Grün, Gelb, Violett, Orange, Rosa, Cyan). Kontrollgrenzen der
neuen Felder und Knöpfe sind an `--muted` gebunden (dunkel 5,04:1 / hell 5,45:1 gegenüber der Dialogfläche), weil
der Host-Default `--border` dort 1,11:1/1,14:1 misst — unter 3:1.

## 3. Layout (ASCII)

```
Edit board                                            [×]
  Name
  ┌────────┐  ┌───────────────────────────────────────┐
  │ (glyph)│  │ Planning                              │
  └────────┘  └───────────────────────────────────────┘
  Classification palette
   Up to 10 classifications card labels draw from. …
  ┌───────────────────────────────────────────────────┐
  │ Name                         Color                │
  │ [bug                        ] (●) [Red ▾]         │
  │ [Up] [Down] [🗑]                                  │
  ├───────────────────────────────────────────────────┤
  │ Name                         Color                │
  │ [feature                    ] (●) [Blue ▾]        │
  │ [Up] [Down] [🗑]                                  │
  └───────────────────────────────────────────────────┘
  [＋ Add classification]                 2 / 10 used
                                        (Fehler, role=alert)
  ────────────────────────────────────────────────────
                                      [Cancel] [Save]
```

Regeln: eine Zeile = ein Slot; Name-Feld wächst, Farbe ist Punkt + benannter Auswahl (Farbe nie einziges
Signal); Auf/Ab als Textknöpfe mit `aria-label` je Name, Entfernen als Mülleimer-Icon mit `aria-label`;
Zähler `aria-live="polite"`; Fehler als Text am Feld. Unter 520 px stapelt die Zeile (Name über Farbe).

## 4. Zweiter Durchgang

| Teil des Plans                         | Warum das die Standardausgabe wäre                                                         | Überarbeitet zu                                                                                                       |
| -------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| „Swatch-Reihe mit freiem Hex-Feld"     | Naheliegend, aber eine freie Farbwahl wäre eine zweite Farbwelt neben den Session-Farben   | Acht benannte `--session-color-*`-Werte als Auswahl; die Farbe bleibt an den Host gebunden.                           |
| „Zeile per Drag & Drop sortieren"      | Übliche Listeninteraktion; auf Tastatur und Touch unzuverlässig und für ≤10 Zeilen unnötig | Auf/Ab-Textknöpfe je Zeile, an den Rändern gesperrt; Zähler zeigt die Grenze.                                         |
| „Farbige Badges je Klassifizierung"    | Divergiert nur die Optik; die Karte selbst trägt die Farbe schon über den Akzentstreifen   | Neutraler Punkt neben der Auswahl; die Farbe lebt dort, wo sie gilt (Karte), nicht doppelt im Dialog.                 |
| „Umbenennen schreibt Karten-Labels um" | Der bequeme Pfad — verändert aber Daten, die der Auftrag ausdrücklich ausnimmt             | Die Palette allein wird geschrieben; bestehende Labels bleiben als einfache Chips, identisch zum `replaces`-Ergebnis. |

---

# Design-Plan — Karten-Inhalt als Markdown + Diagramme (`workboard-card-markdown-mermaid`, 2026-11-06)

Weitere Fläche dieses Vertrags. Der Karten-Drawer rendert bisher Notes, Kommentare und Proof-Notes als Markdown
(via Host-Mount `mountMarkdown`), aber Decision-Optionen, Waiting-Zeile und der Plugin-Markdown-Renderer taten
das nicht: Diagramme (` ```mermaid `) erschienen dort nur als Codeblock. Zwei-Durchgang-Artefakt (§14.2).

## 1. Auftrag

- **Ziel** (beobachtbar): Jeder Inhaltstext einer Karte — Notes, Decision-Optionen (Label + Beschreibung),
  Waiting-Zeile und Kommentare — erscheint als **gerendertes Markdown**; ein ` ```mermaid `-Fence wird als
  **Diagramm** angezeigt (nicht als Codeblock), im Karten-Detail **und** im Plugin-Markdown-Renderer; bei
  Renderfehler bleibt die Quelle als Klartext lesbar.
- **Zielgruppe**: the operator als Board-Betreiber; der Agent, der Karten anlegt und Notizen/Diagramme einbettet.
- **Nicht-Ziele**: kein neuer Parser/Sanitizer/Dependency; keine Änderung an Notes/Decision-Logik selbst;
  keine Roh-HTML-Ausgabe (Host-Sanitizer bleibt Grenze); kein Merge/Deploy in diesem Slice.

## 2. Palette

Keine eigene Farbwelt. Der Inline-Modus übernimmt **Farbe, Größe und Zeilenhöhe seines Steuerelements**
(`color: inherit`, `font-size: inherit`); nur `strong`/`code`/`em` nutzen die vorhandenen
`.sidebar-markdown`-Regeln. Kein neuer Token.

## 3. Typografie

Wie `.sidebar-markdown`, außer im Inline-Modus: dort erbt das Label die Typo der Optionszeile (`.btn`,
13 px). Eine Familie, klare Rollen.

## 4. Layout-Konzept

````
Karten-Drawer                         Optionszeile (button role=radio)
┌──────────────────────────────┐      ┌──────────────────────────────────────────┐
│ Waiting: …inline markdown…   │      │ 1.  SQLite          ← Label: inline-md    │
│ ┌──────────────────────────┐ │      │     One file, no server.  ← descr: inline │
│ │ Notes (block markdown)   │ │      └──────────────────────────────────────────┘
│ │  ```mermaid → Diagramm   │ │      Inline-Labels sind Phrasing-Content im
│ └──────────────────────────┘ │      <button> → kein <p> im <button> (HTML gültig).
└──────────────────────────────┘
````

## 5. Prinzipien

1. **Ein Renderer, kein zweiter.** → Jeder Text geht durch `mountMarkdown`/`toSanitizedMarkdownHtml`; Inline
   nutzt denselben Parser/Sanitizer über `renderInline`, nur ohne `<p>`-Hülle.
2. **Markdown, wo es gelesen wird.** → Labels/Beschreibungen/Waiting sind Text; sie werden gerendert, nicht
   als Rohtext gezeigt. Die Notes-**Editor**-Ansicht bleibt bewusst Rohquelle.
3. **Diagramme sind Inhalt, kein Code.** → Ein ` ```mermaid `-Fence wird zum Diagramm; scheitert das Rendern,
   erscheint die Quelle mit Fehlerhinweis (Host-Verhalten), nie eine leere Fläche.

## 6. Zweiter Durchgang

| Teil des Plans                                  | Warum Standardausgabe                                                                         | Überarbeitet zu                                                                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| „Markdown in die Option setzen (`innerHTML`)"   | Naheliegend, aber das würde den Host-Sanitizer umgehen und eine zweite Render-Quelle schaffen | Eigener Inline-Modus im bestehenden Host-Renderer (`renderInline` + derselbe DOMPurify-Durchlauf).                       |
| „Input/Buttons in Optionen, damit mermaid geht" | Fences sind block-level; ein Diagramm passt nicht in ein Button-Label                         | Inline-Modus ist bewusst **phrasing-only**: Labels/Beschreibungen sind einzeilig; Diagramme gehören in Notes/Kommentare. |
| „`<div>`-Wrapper in der Waiting-Zeile behalten" | Kleinster Eingriff — aber ein `<p>` mit Block-Markdown darin wäre ungültig                    | Waiting wird ein `<div>` mit Inline-Markdown; die Copy bleibt ein Satz ohne Blockstruktur.                               |
