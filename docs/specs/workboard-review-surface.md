---
title: Workboard review surface
summary: "Requirements for reviewing annotated documents on a Workboard card: line markers, per-annotation resolution, and one overall verdict that names what was still open."
read_when:
  - Changing how a document is reviewed or annotated on a Workboard card
  - Adding per-annotation resolution or an overall review verdict to a card
  - Deciding whether a review case belongs on a card at all
doc-schema-version: 1
---

# Workboard review surface

**Status: requirements. Nothing here is implemented.** This page is the acceptance basis for the
work; code lands separately and must be read against these numbers.

## 1. Zielbild

Ein Review-Fall — heute ein annotiertes PDF-Paket, das an mehreren Orten gleichzeitig liegt —
erscheint als **eine Karte**: das Dokument liegt in der Karte, jede Anmerkung hängt an einer Stelle im
Dokument (Zeile/Marker) statt in einem Kommentar-Thread, jede Anmerkung trägt ihre eigene Auflösung,
und das Gesamturteil ist **ein** Datensatz, der **benennt, welche Anmerkungen beim Urteil noch offen
waren**. Die Spracheingabe läuft über die Kette, die schon im Workboard hängt — keine zweite Aufnahme-
und Transkriptionsstrecke. Damit fällt die Doppelsicht weg, und der Entscheidungsdurchsatz steigt, weil
der Operator nicht zwischen mehreren Repräsentationen derselben Sache wechselt.

## 2. Herkunft der Anforderungen (die geschnittenen Gruppen)

Der Schnitt ist **G1 + G3**, nicht „alles abdecken":

- **G1 — Dokument-Inhalt mit Zeilenmarkern ist die größte und reifste Gruppe.** Zwei gebaute,
  laufende Instanzen: ein Datenschutz-Review-Paket mit **14 Dokumenten / 59 Kommentaren**, davon
  **43 an eine Person adressiert**, Kategorien AENDERUNG 20 · HINWEIS 14 · RECHTSFRAGE 14 ·
  ENTSCHEIDUNG 11; davor eine Adjudikations-Oberfläche mit **43** Grenzfällen. Die echte Ja/Nein-Last
  im großen Paket war **~11**, nicht 59.
- **G3 — Optionenwahl existiert schon als Picker.** **50** Karten tragen `decisionOptions`, davon
  **18 offen** (10 mit Label `decision`); 13 offene `decision`-Karten ohne Rohmaterial-Label. Der
  Picker lässt **genau eine** Antwort zu
  (`packages/workboard-contract/src/index.ts:386-397`, Verhalten `docs/plugins/workboard.md:1183`).

Alles Übrige ist ausdrücklich **nicht** Teil dieser Anforderungen (Abschnitt 5). Die Zählungen stammen
aus einer belegten Erhebung des Review-Bedarfs; die Messmethode und die Einzelfälle liegen im
internen Bericht zu diesem Vorhaben, nicht in dieser veröffentlichten Seite.

## 3. Anforderungen

Muss = ohne das ist die Abnahme rot. Soll = gehört dazu, Abweichung ist begründbar. Kann = bewusst
außerhalb des ersten Lieferumfangs. Jede Anforderung nennt ihre Prüfung.

### 3.1 Auslöser und Ort (was den Review öffnet)

- **R1 (muss).** Ein Review öffnet sich an einer **bestehenden Karte**, nicht als eigene Seite und
  nicht als eigener Navigationspunkt. _Prüfung:_ die Oberfläche ist ohne Neuladen der Control UI
  erreichbar; die Karte bleibt in der Inbox sichtbar, solange sie wartet.
- **R2 (muss).** Der Review-Zustand steht **im Card-Detail**, aber als **eigener Abschnitt** neben
  `Your decision`; er ersetzt den Picker nicht und wird von ihm nicht ersetzt. _Prüfung:_ eine Karte
  mit `decisionOptions` **und** Review zeigt beides, und beide Schreibvorgänge bleiben unabhängig.
- **R3 (muss).** Die Karte erscheint in der „Needs you"-Inbox nach derselben Ableitung wie heute —
  abgeleitet, **nicht gespeichert**. Der Review darf **keine** neue gespeicherte Statusart einführen.
  _Prüfung:_ die Karte eines offenen Reviews, die im Status `review` bzw. `blocked` mit Label
  `decision` steht, ist in der Inbox; die Listenableitung bleibt rein
  (`browser/lib/workboard/operator-attention.ts` — „Derived on every render, never stored.").
- **R4 (soll).** Ein Review-Fall, der als solcher erkannt ist, setzt an der Karte ein Label, das die
  vorhandene Klassifikationspalette nutzt, statt ein neues Farbkonzept. _Prüfung:_ das Label ist ein
  Paletteneintrag; die Board-Sicht zeigt keine zusätzliche Farbe.
- **R5 (kann).** Ein Batch „alle Reviews dieses Boards annehmen" über die vorhandene Batch-Mechanik
  (`workboard.cards.bulk`, Doku `docs/plugins/workboard.md:979-1004`). _Prüfung:_ der Batch bricht bei
  Konflikt ab, statt neuere Revision zu überschreiben (bestehende Semantik).

### 3.2 Dokumentdarstellung

- **R6 (muss).** Ein PDF-Anhang/ein PDF-Artefakt einer Karte ist **in der Karte lesbar**, ohne die
  Karte zu verlassen. _Prüfung:_ in einer Plugin-eigenen Workboard-Ansicht wird ein PDF dargestellt;
  **gemessen**, nicht angenommen — offen ist, ob die Chat-Mechanik (unsandboxed `same-origin` iframe
  auf eine Blob-URL, `ui/src/pages/chat/components/chat-pdf-preview.ts`, 16 MiB, 10 s) in einer
  Plugin-Ansicht trägt. Trägt sie nicht, ist die **Bild-Projektion** der Ausweichweg, und die Abnahme
  wird gegen die Bild-Projektion geführt.
- **R7 (muss).** Die Byte-Herkunft bleibt dieselbe wie heute: die Bytes kommen über die bestehende
  RPC (`workboard.cards.attachments.get`) und werden **auf `%PDF-` geprüft**, bevor sie in einen
  Frame gehen. Ein **fehlendes** Attribut `sandbox` ist eine bewusste, im Code benannte Entscheidung
  (Herkunft = Control-UI-Origin, also CSP-konform: `frame-src 'self' blob: http: https:`), keine
  Auslassung. Kein `<embed>`/`<object>` (`object-src 'none'`). _Prüfung:_ ein deklariertes
  `application/pdf` ohne `%PDF-`-Signatur wird abgelehnt (rot-Bedingung, siehe A3).
- **R8 (muss).** Anmerkungen erscheinen **an ihrer Stelle**: Seitenzahl **und** Marker/Rechteck,
  nicht nur als Liste. _Prüfung:_ zu jeder Anmerkung mit `kind: "pdf-rect"` ist die Seite und das
  Rechteck sichtbar; die Ankerdaten kommen aus der Anmerkung, nicht aus einer Neuberechnung im
  Browser.
- **R9 (soll).** Eine Liste **aller** Anmerkungen des Dokuments ist zusätzlich durchblätterbar
  (Sprung zur Stelle), weil 59 Anmerkungen auf 14 Dokumenten nicht durch Scrollen gefunden werden.
  _Prüfung:_ von jedem Listeneintrag führt ein Schritt zur Stelle.
- **R10 (soll).** Das Dokument wird **nicht verändert**. Kein Zeichnen, kein Umbrechen, kein
  Speichern ins Original. _Prüfung:_ die Bytes des Anhangs sind nach dem Review unverändert
  (Digest-Vergleich vor/nach).
- **R11 (kann).** Textprojektion (Markdown/TXT) als zusätzliche Anzeige für Dokumente ohne PDF.

### 3.3 Anmerkung, Auflösung, Urteil

- **R12 (muss).** Jede Anmerkung trägt **ihre eigene Auflösung** — ein Schreibvorgang pro Anmerkung,
  **ohne** dass ein Agent dazwischen antworten muss. _Prüfung:_ eine Anmerkung wird aufgelöst, während
  die Karte `blocked` bleibt; kein Agent-Lauf wird dabei gestartet.
- **R13 (muss).** Anmerkungen sind **Kandidaten**, keine Behauptungen: Herkunft (wer/wann) und Wortlaut
  bleiben unverändert erhalten. _Prüfung:_ Lesen liefert den ursprünglichen `body` byte-gleich nach
  jeder Auflösung.
- **R14 (muss).** Das **Gesamturteil ist ein Datensatz** und **protokolliert die beim Urteil noch
  offenen Anmerkungen** (`unresolvedAnnotationIds`). Ein Gesamt-Accept, das offene Einwände
  verschweigt, ist **nicht** möglich. _Prüfung:_ rot-Bedingung A5.
- **R15 (muss).** Das Urteil fällt **durch die Identität des Entscheidenden**, nicht durch einen
  Status: das Feld `decidedBy` trägt die Identität, und die Prüfung liest sie, nicht den Kartenstatus.
  _Prüfung:_ dieselbe Identität, die den Review eröffnete, kann ihn nicht als fremde Instanz
  abschließen — die Abnahme nennt, **wer** geurteilt hat.
- **R16 (muss).** Zulässige Urteile sind **`accept` | `rework` | `reject` | `hold`**; alles andere
  (fehlend, leer, falsch typisiert, unbekannter Wert) wird **abgelehnt**, nicht auf einen Default
  gezogen. _Prüfung:_ rot-Bedingung A6.
- **R17 (muss).** Ein Urteil hält den **Dokumentstand** fest, gegen den es gefallen ist
  (`documentHashes`: Ref → Quell-Hash). Wird das Dokument danach neu gesetzt, ist „dieselbe Anmerkung,
  neues Dokument" **erkennbar**, statt still falsch zu treffen. _Prüfung:_ ein Anmerkungs-Anker mit
  abweichendem Quell-Hash zeigt den Drift an, statt still zu treffen.
- **R18 (soll).** Zu jedem Dokument mit Anmerkungen ist auf einen Blick erkennbar: wie viele
  Anmerkungen, wie viele aufgelöst, welche Kategorie. _Prüfung:_ die Anzeige nennt Zahlen, die gegen
  die gespeicherten Anmerkungen nachzählbar sind (nicht gegen ein abgeleitetes Label).
- **R19 (soll).** Der Review-Zustand ist **exportierbar** als Markdown (für die Rückgabe an den
  bearbeitenden Agenten) — die bestehende Referenz-Oberfläche leistet genau das und ist die Vorlage.
- **R20 (kann).** Wiedereröffnen eines abgeschlossenen Reviews; das frühere Urteil bleibt erhalten
  (Historie), es wird nicht überschrieben.

### 3.4 Sprache

- **R21 (muss).** Spracheingabe nutzt **ausschließlich** die bestehende Host-Kette: Plugin-Mount
  `mountDictationControl` (`extensions/workboard/browser/components/host-components.tsx`),
  Bestätigungs-Gate (`voice-board-control.tsx` + `voice-gate.tsx`), Host-Aufnahme über die
  Composer-Sitzung, Transkription über den bereits verdrahteten Dienst. **Keine zweite Aufnahme-,
  Upload- oder Fehlerstrecke.** _Prüfung:_ das Plugin enthält **kein** `getUserMedia`,
  `MediaRecorder` oder `SpeechRecognition` — rot-Bedingung A7.
- **R22 (muss).** Nichts wird gesprochen und gesendet, ohne dass es im Gate bestätigt wurde.
  _Prüfung:_ ein Transkript, das nicht bestätigt wird, erzeugt keine Anmerkung und kein Urteil.
- **R23 (soll).** Die Spracheingabe kann (a) eine Anmerkung diktieren und (b) ein Urteil diktieren;
  die Zielbestimmung darf beim Sprechen nicht durch Umnavigieren kippen. _Prüfung:_ die Aufnahme
  friert das Ziel beim Start der Aufnahme ein (Vorbild: `voice-board-control.tsx`).

### 3.5 Technischer Träger und Fork-Hygiene

- **R24 (muss).** Der Kern bleibt **im gebündelten Workboard** (`extensions/workboard/`), also **ohne**
  den Labs-Schalter `gateway.controlUi.experimental.customPlugins`. _Prüfung:_ es wird keine
  Konfiguration geändert und kein separat installiertes Plugin eingeführt; die Funktion ist ohne
  Schalter erreichbar (`docs/plugins/feature-plugins.md:58-61`).
- **R25 (muss).** Neue Daten liegen in **eigenen Feldern und eigenen Dateien**, nicht als Erweiterung
  bestehender Typen (`WorkboardComment`, `WorkboardAttachment` in
  `packages/workboard-contract/src/index.ts`). Bestehende Typen bleiben unverändert. _Prüfung:_ der
  Diff berührt die beiden Typen nicht; rot-Bedingung A8.
- **R26 (muss).** `decisionOptions` wird **nicht** um Mehrfachantworten erweitert. Ein Review mit N
  Einzelauflösungen ist ein **eigener** Datensatz. _Prüfung:_ `WORKBOARD_DECISION_OPTION_LIMITS` ist
  unverändert; der Picker bietet weiterhin genau eine Antwort (`docs/plugins/workboard.md:1183`).
- **R27 (muss).** Die neue Feld-Familie ist **begrenzt** und kann die übrigen Kartendaten nicht
  verdrängen: überschreitet der Review-Zustand seine Grenzen, **scheitert der Schreibvorgang mit
  benanntem Fehler**, statt still andere Metadaten zu kürzen (`trimMetadataToBudget` in
  `store-normalizers.ts` kennt einen Review-Zustand heute nicht). _Prüfung:_ rot-Bedingung A9.
- **R28 (soll).** Keine neuen UI-Wörter ohne Bedacht: jedes neue Wort erzeugt Konfliktfläche in den
  Locale-Dateien (heißeste Einzeldatei `browser/i18n/locales/en.ts`, 6 Upstream-Touches). Soweit
  möglich werden bestehende Wörter wiederverwendet. _Prüfung:_ die Zahl neuer Locale-Schlüssel wird
  im PR genannt.
- **R29 (soll).** Der Delta meidet die upstream-heißen Dateien, wo es ohne Umweg geht
  (`store-core.ts`, `store-inputs.ts`, `tools.ts`, `view.tsx`, `workboard.css`, …).

## 4. Datenform (Entwurf, vertraglich)

Die Form ist Teil der Anforderung, weil R14/R15/R17 nur mit ihr prüfbar sind.

```ts
/** Wo eine Anmerkung im Dokument sitzt. Eigene Familie, nicht in WorkboardComment. */
export type WorkboardReviewAnchor =
  | { kind: "pdf-rect"; page: number; rect: [number, number, number, number] }
  | { kind: "text-quote"; quote: string; hash: string; page?: number }
  | { kind: "text-range"; start: number; end: number; hash: string };

/** Eine Anmerkung mit eigener Auflösung. */
export type WorkboardReviewAnnotation = {
  id: string;
  documentRef: string; // Anhang-/Artefakt-ID, auf die sich der Anker bezieht
  anchor: WorkboardReviewAnchor;
  body: string;
  author: string; // "operator" oder Agent-Kennung
  createdAt: number;
  resolvedAt?: number; // "aufgelöst" ist eine eigene Zeit, keine Statusänderung
  resolution?: "accepted" | "changed" | "rejected" | "deferred" | "answered";
};

/** Das Gesamturteil — ein Datensatz, kein Status. */
export type WorkboardReviewVerdict = {
  verdict: "accept" | "rework" | "reject" | "hold";
  note?: string;
  decidedAt: number;
  decidedBy: string; // Identität des Entscheidenden (R15)
  unresolvedAnnotationIds: string[]; // was beim Urteil offen war (R14)
  documentHashes: Record<string, string>; // Ref -> Quell-Hash (R17)
};

export type WorkboardReviewSession = {
  id: string;
  cardId: string;
  documents: Array<{ ref: string; label: string; sourceHash: string }>;
  annotations: WorkboardReviewAnnotation[];
  overall?: WorkboardReviewVerdict;
};
```

**Anker-Wahl.** `pdf-rect` (Seite + Rechteck) ist direkt aus PDF-Annotationen/Quadpoints
extrahierbar — die lokale Referenz-Implementierung tut das schon. `text-quote` + Hash ist der robuste
Primär-Anker bei neu gesetztem Dokument; `pdf-rect` bleibt der **Anzeige**-Hinweis. Beide zusammen mit
`documentHashes` sind der belastbare Weg: der Rect zeigt, der Quote hält, der Hash warnt. **Welcher
Anker unter Neu-Setzen trägt, ist eine Messung**, nicht eine Annahme (Abschnitt 7).

**Ablage (Fork-Hygiene, R25).** Eigene Spalte und eigene Datei nach dem Vorbild von
`metadata.interaction` → `interaction_json`: eine eigene Feld-Familie `metadata.review`, serialisiert
in `review_json`, normalisiert in einer **eigenen** Datei (`store-review.ts`), mit eigenen Grenzen. Die
bestehenden Typen und die bestehende Trim-Reihenfolge bleiben unberührt.

## 5. Abgrenzung — was **nicht** in die Karte gehört

Übernommen als **Abgrenzung mit Prüfwert**: taucht einer dieser Fälle in der Oberfläche auf, ist das
ein Fehler, keine Bereicherung.

- **A. Mehrundige Verhandlungen.** Eine Vertragsseite, die um Bestätigung oder Korrektur der Laufzeiten
  je Person bittet, ist ein Gespräch, keine Einzelentscheidung.
- **B. Fälle, die die Maske selbst abweisen.** Ein Mietvertrag mit 7 Einzelentscheiden (M-1…M-7), der
  als Option selbst sagt „einzelne Entscheide abweichend — im Chat": 4 Optionen reichen dafür nicht.
- **C. Live-/Zugriffsentscheidungen.** Zwei-Faktor-Freigaben vor Ort, Live-Tausch von Zugangsdaten,
  Broker-Logins: brauchen Zugriff oder Anwesenheit, nicht eine Ansicht.
- **D. Irreversibles mit Kontexturteil.** Das Löschen eines Arbeitsverzeichnisses mit zwei
  widersprechenden Listen: ein Knopf „Ja" ohne beide Listen wäre gefährlich.
- **E. Physische Handlungen.** Unterschreiben, installieren, beurkunden. Anzeigen ja, „in einem Zug
  erledigen" nein.
- **F. Rein visuelle Wahl.** Referenzbild unter mehreren Varianten: braucht Bild, nicht Textzeile.
- **G. Relay-Entscheide zwischen Agenten.** Der Großteil der internen `[decision]`-Queue-Zeilen; nicht
  die Operator-Maske.
- **H. Interne Ops-Review.** Der überwiegende Teil der `review`-Karten sind Selbst-Reviews eigener
  Sessionvorfälle: gehören in den Selbstlauf, dürfen die Fläche nicht fluten.

**Technische Nicht-Ziele.** Kein PDF-Editor (R10). Kein Karten-Ersatz und keine zweite Projektfläche.
Keine zweite Sprachstrecke (R21). Kein Labs-Schalter (R24). Keine Mehrfachantwort im bestehenden
Picker (R26). Kein Volltextindex und keine Suche über Dokumentinhalte — nicht gefordert und nicht
belegt. Keine eigene Zustellung an Dritte: das Ergebnis bleibt im Gateway.

## 6. Aufwand in Stufen

**Stufe P — Prototyp (misst die offenen Fragen, kein Produktivweg).**
Ziel: die zwei unbelegten Punkte messen, bevor Struktur entsteht.
(a) Trägt der PDF-iframe in einer **Plugin-eigenen** Workboard-Ansicht? (b) Trägt ein `text-quote`-Anker
unter einem neu gesetzten Dokument? Umfang: Anzeige eines PDFs aus vorhandenen Bytes in der
Kartenansicht, Rendern von Anmerkungen aus einer Fixture, keine Persistenz, kein Schreibweg. Ergebnis:
eine Messung, kein Feature.

**Stufe B — benutzbar (der erste Lieferumfang).**
Datenform (Abschnitt 4) in eigenen Feldern; Persistenz; Anlegen/Auflösen einzelner Anmerkungen;
Gesamturteil mit erzwungenem `unresolvedAnnotationIds`; Dokumentanzeige mit Markern; Sprache über die
bestehende Kette; Markdown-Export. Deckt R1–R3, R6–R8, R12–R17, R21, R22, R24–R27.

**Stufe D — dauerhaft.**
Drift-Behandlung bei neu gesetztem Dokument (R17 in der Anzeige), Anmerkungsliste mit Sprungfunktion
(R9), Zählanzeige (R18), Export-Feinschliff (R19), Locale-/Rebase-Hygiene (R28, R29), Wiedereröffnung
mit Historie (R20), Batch-Abnahme (R5), Textprojektion (R11), Doku in `docs/plugins/workboard.md`.

## 7. Abnahmekriterien (jedes kann rot werden)

Jedes Kriterium nennt die Prüfung und die **rot-Bedingung**; ohne eine rot-Bedingung beweist ein
grüner Lauf nur, dass die Prüfung läuft.

- **A1 (R1/R2).** _Prüfung:_ eine Karte mit `decisionOptions` **und** Review zeigt beide Abschnitte;
  beide Schreibwege bleiben unabhängig. _Rot:_ der Review verdrängt den Picker, oder der Picker
  verdrängt den Review.
- **A2 (R6).** _Prüfung:_ PDF-Darstellung **in** der Plugin-Ansicht, mit den tatsächlichen Bytes.
  _Rot:_ der Frame bleibt leer bzw. zeigt den Ersatz-Platzhalter — dann greift der Ausweichweg
  (Bild-Projektion) und die Abnahme wird gegen ihn geführt.
- **A3 (R7).** _Prüfung:_ ein Anhang mit deklariertem `application/pdf` aber **ohne**
  `%PDF-`-Signatur. _Rot:_ er wird dargestellt. (Vorbild-Prüfung existiert heute schon:
  `isPdfBytes` in `attachment-bytes.ts`.)
- **A4 (R17).** _Prüfung:_ Anmerkung setzen, Dokument **neu setzen**, Anker erneut auflösen.
  _Rot:_ die Anmerkung trifft **still** eine andere Stelle, ohne Drift-Anzeige.
- **A5 (R14).** _Prüfung:_ zwei Anmerkungen anlegen, **eine** auflösen, Gesamt-Accept setzen.
  _Rot:_ das gespeicherte Urteil nennt die offene Anmerkung **nicht** in `unresolvedAnnotationIds`
  — oder das Urteil wird ohne sie überhaupt angenommen.
- **A6 (R16).** _Prüfung:_ Urteil mit fehlendem, leerem, falsch typisiertem und unbekanntem Wert.
  _Rot:_ irgendeine dieser Formen wird angenommen oder auf einen Default gezogen.
- **A7 (R21).** _Prüfung:_ `grep -rn "getUserMedia\|MediaRecorder\|SpeechRecognition"`
  in `extensions/workboard/browser/`. _Rot:_ ein Treffer. **Positivkontrolle:** dasselbe Muster trifft
  im Host-Bundle — ein leeres Ergebnis ist sonst bedeutungslos.
- **A8 (R25).** _Prüfung:_ `git diff` gegen `WorkboardComment` und `WorkboardAttachment` in
  `packages/workboard-contract/src/index.ts`. _Rot:_ eine geänderte Zeile darin.
- **A9 (R27).** _Prüfung:_ ein Review-Zustand **über** den Grenzen schreiben. _Rot:_ der Schreibvorgang
  ist erfolgreich und hat dabei Kommentare/Proof/Artefakte der Karte verdrängt.
- **A10 (R10).** _Prüfung:_ Digest des Anhangs vor und nach einem vollen Review-Durchlauf.
  _Rot:_ die Bytes haben sich geändert.
- **A11 (R24).** _Prüfung:_ `git diff` auf Konfiguration + Suche nach einem neuen Plugin-Manifest.
  _Rot:_ eine Konfigurationsänderung oder ein zweites Plugin ist für die Funktion nötig.
- **A12 (R22).** _Prüfung:_ diktieren, **nicht** bestätigen. _Rot:_ es entsteht eine Anmerkung oder
  ein Urteil.
- **A13 (R3).** _Prüfung:_ Ableitung der Inbox-Zeile aus dem Kartenzustand. _Rot:_ die Ableitung liest
  ein neues **gespeichertes** Flag.

## 8. Was vor der Umsetzung bewiesen sein muss

1. **PDF in einer Plugin-Ansicht** — trägt die vorhandene Chat-Mechanik auch dort? Falls nein:
   Bild-Projektion (und die Abnahme wird gegen sie geführt).
2. **Anker unter Neu-Setzen** — hält eine `text-quote`-Anmerkung ihre Fundstelle (A4)?
3. **Trim-Wechselwirkung** — wie verhält sich die neue Feld-Familie zur Metadaten-Grenze (A9)?
4. **Fork-Hygiene** — wie klein lässt sich der Delta halten, und wie verhält er sich gegen den
   nächsten Upstream-Sync?

## 9. Offener Punkt, der nur der Operator entscheiden kann

Die **Sprach-Route** ist entschieden (bestehende Host-Kette, R21) — die Feingranularität ist es nicht:
die Host-Kette liefert **nur den fertigen Text**, keine Zwischenergebnisse und keinen Pegel
(`packages/plugin-sdk/src/plugin-sdk/control-ui-components.d.ts`). Eine sichtbare Aufnahme-
Rückmeldung im Review wäre nur mit einer **zweiten** Strecke zu haben und ist damit nach R21
ausgeschlossen. Bleibt es dabei, ist nichts zu tun; andernfalls ist es eine Entscheidung, keine
Annahme.
