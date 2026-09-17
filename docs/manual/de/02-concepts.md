# Kernbegriffe

> Worum es auf dieser Seite geht: das gute Dutzend Begriffe, die in Dispatch immer wiederkehren, einmal vollständig erklären. Nach dieser Seite lassen sich die Schaltflächennamen in allen anderen Kapiteln zuordnen.

Dispatch hat nur einen roten Faden: **In Projekten entstehen Sitzungen, aus Sitzungen erwachsen Aufgaben, aus Aufgaben werden Ergebnisse.** Unten arbeiten die Agenten, oben schauen Sie zu, antworten und vergeben Aufgaben.

## Projekt

Sitzungen werden über ihr **Arbeitsverzeichnis** einem Projekt zugeordnet:

1. Eine manuelle Zuordnung hat Vorrang (Rechtsklick auf die Sitzung → „Projekt zuordnen …“).
2. Sitzungen im Benutzerordner selbst gehören zu keinem Projekt.
3. Jeder direkte Unterordner der „Arbeitsbereich-Ordner“ (in den Einstellungen, voreingestellt `~/Projects`) gilt als eigenes Projekt.
4. An anderen Orten wird nach dem Wurzelverzeichnis des Git-Repositorys zugeordnet, ohne Repository nach dem enthaltenden Ordner.
5. Taucht im Pfad ein Projektname auf, den das Aufgabenboard kennt, wird ebenfalls dorthin zugeordnet.

Als richtiges Projekt gilt nur, was **Aufgaben hat, Ergebnisse hat oder manuell zugeordnet wurde**; alles Übrige ist lediglich ein „Ordner“ und steht unten auf der Projektseite unter „Andere Ordner und nicht zugeordnet“. Projekte lassen sich als Favorit markieren (nach oben heften), archivieren (aus Arbeitsplatz und Liste ausblenden, jederzeit wieder auffindbar) und per Doppelklick auf den Titel umbenennen. Diese Zustände liegen auf dem gemeinsamen Aufgabenboard und sind auf beiden Rechnern gleich.

## Sitzung

Eine Sitzung ist ein vollständiges Gespräch eines Agenten in einem Verzeichnis. Dispatch liest aus den Aufzeichnungen des Agenten dessen Titel, Verzeichnis, Branch, jede Gesprächsrunde, Werkzeugaufrufe, geänderte Dateien, Bilder und Artefakte. Eine Sitzung kennt mehrere Zustände:

- **Läuft**: Der Agent arbeitet gerade, die Zeile ist grün hervorgehoben, die Sitzungsseite liest live mit.
- **Wartet auf Sie**: Der Agent hat angehalten und wartet auf Ihre Antwort oder Bestätigung; die Sitzung erscheint im Arbeitsplatz und unter „Wartet auf mich“.
- **Ungelesene Antwort**: Der Agent ist fertig, Sie haben die letzte Runde noch nicht gesehen, es gibt einen blauen Punkt. Sobald Sie bis zum Ende gelesen haben, verschwindet die Markierung von selbst; auch eine Antwort im ursprünglichen Terminal wird erkannt.
- **Verfolgt**: eine von Ihnen als Favorit markierte Sitzung, oben im Arbeitsplatz festgehalten, wird nicht automatisch archiviert.
- **Archiviert**: von Hand archiviert oder länger ohne Aktivität, als in den Einstellungen an Tagen festgelegt ist.
- **Geplant oder per Skript**: nicht von Ihnen im Terminal gestartet (zeitgesteuerte Aufgaben, Skripte, von einem anderen Agenten über eine Programmierschnittstelle gestartet). Solche Sitzungen erscheinen nicht unter „Wartet auf mich“ und lösen keine Mitteilung aus.

Der **Ursprung** einer Sitzung wird ausgewiesen: Terminal, Desktop-App, VS Code, SDK, zeitgesteuerte Aufgabe, Telegram und so weiter.

## Aufgabe

Aufgaben liegen auf dem zentralen Aufgabenboard (Beads, Verzeichnis `~/tasks/.beads`). **Aufgaben führt der Agent selbst**: Sobald er weiß, was zu tun ist, `dispatch begin`, Fortschritt mit `dispatch log`, zum Abschluss `dispatch done`. Sie können Aufgaben auch in der Oberfläche anlegen (<kbd>⌘T</kbd>), bearbeiten und verschieben. Eine Aufgabe hat:

- Status: Offen, In Arbeit, Blockiert, Zurückgestellt, Erledigt.
- Priorität P0 (am dringendsten) bis P4 (am niedrigsten).
- Abnahmekriterien: eine Liste aus `- [ ]`, eine Zeile je Kriterium; wer abgehakt hat, wird vermerkt („von Ihnen geprüft“, „Selbstprüfung · Agent“, „Gegenprüfung · Agent“).
- Abschlussnotiz: was mit `dispatch done --reason` an Lieferung und Prüfung festgehalten wurde.
- Bezug zur Sitzung: **Anerkannt werden nur** die Marken `session-origin:` (auslösende Sitzung) und `session:` (beteiligte Sitzung). Eine im Gespräch erwähnte Aufgaben-ID, derselbe Agent oder dasselbe Verzeichnis begründen keine Zugehörigkeit, sondern zählen nur als Hinweis „im Gespräch erwähnt“.
- Aufgabennummer: von Beads automatisch erzeugt, mit dem Namen des Boards als Präfix (etwa `task`) und drei zufälligen Stellen dahinter, ohne inhaltliche Bedeutung.

Aufgaben lassen sich in den **Papierkorb** verschieben (wiederherstellbar, Beschreibung, Kommentare und Abhängigkeiten bleiben erhalten); länger abgeschlossene Aufgaben lassen sich **archivieren** (stehen dann nicht mehr in der Spalte Erledigt und zählen nicht mit).

## Ergebnis

Ein Ergebnis ist ein eigener Eintrag (Marke `dispatch:outcome`), der festhält, was geliefert wurde und wo es zu sehen ist, und mehrere Aufgaben und Sitzungen verknüpfen kann. Es zählt nicht zu den normalen Aufgaben und erscheint nicht im Verlaufsdiagramm. Erfasst oder bearbeitet wird es auf der Projektseite im Reiter „Ergebnis“; ein Agent kann es auch mit `bd create` samt Marke erfassen. Die Abschlussnotizen früherer Aufgaben bleiben für sich bestehen und werden nicht automatisch zu Ergebnissen.

## Wartet auf mich

Unter „Wartet auf mich“ steht nur, wofür Sie selbst tätig werden müssen; roter Punkt und Systembenachrichtigung gelten nur für die ersten beiden Kategorien:

- **Ungelesene Antwort**: Der Agent ist fertig und wartet darauf, dass Sie es sehen. Eine laufende Sitzung gilt nicht als ungelesen.
- **Wartet auf Bestätigung**: Der Agent steht an einem Bestätigungsdialog, etwa zu Berechtigungen oder zu einem vertrauenswürdigen Verzeichnis (hier erscheinen nur Sitzungen, die Ereignisse melden, also in Herdr laufen).
- **Nur Sie können**: Der Agent stößt auf etwas, das nur Sie erledigen können (E-Mail schicken, bezahlen, sich anmelden, persönlich vorführen, entscheiden), und hält es mit `dispatch need-you` als Aufgabe fest. Sie steht auf der Projektseite im Reiter „Aufgaben“ in der Spalte „Nur Sie können“ und wird nach Erledigung abgehakt.

Blockierte Aufgaben, gegenseitige Prüfungen unter Agenten und geplante Sitzungen zählen nicht für den roten Punkt.

## Wissensbasis

Die von allen Agenten gemeinsam genutzte Wissensbasis liegt im Speicher des Aufgabenboards. Vier Arten von Einträgen:

- **Stolperfalle** (pit): Symptom plus Lösung.
- **Bewährt** (win): Vorgehen plus Begründung, warum es richtig ist.
- **Rückblick (Retro)** (retro): von `dispatch done --retro` automatisch erzeugt, mit Technik, Bewährtem und Fehlgelaufenem.
- **Anleitung** (howto): eine wiederverwendbare Abfolge von Schritten.

Beim Start einer Sitzung spielt `dispatch prime` nur die Einträge des aktuellen Projekts und die allgemeinen ein; alles Weitere holt sich der Agent bei Bedarf mit `dispatch wiki search`. Der Reiter „Wissensbasis“ auf der Projektseite zeigt nur die Einträge dieses Projekts.

## Regeln

`~/.agents/rules/GLOBAL.md` enthält die gemeinsamen Regeln aller Agenten und ist die einzige Quelle. Die Seite „Regeln & Unterlagen“ gleicht sie als **verwalteten Block** in die Einstiegsdatei jedes Agenten ab (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` und so weiter) und prüft sie statisch (Dopplungen, mögliche Widersprüche, ins Leere laufende Verweise, Länge). Ändern Sie Regeln in GLOBAL.md und gleichen Sie danach ab; ein direkt im verwalteten Block der Einstiegsdatei geänderter Text wird beim nächsten Abgleich überschrieben.

Dieselbe Seite verwaltet auch „Unterlagen“ (Server, Datenbanken, Obsidian-Bibliotheken), „Schlüssel & APIs“ (`dispatch env`), die „Agent-Notizen“ der einzelnen Agenten und „Über mich“ (`~/.agents/rules/PROFILE.md`).

## Skill-Pool

Ein Skill ist ein Verzeichnis mit einer `SKILL.md`; alle liegen gesammelt im Skill-Pool `~/.cc-switch/skills`. Die Seite „Skills“ zeigt, welchem Agenten ein Skill zugeordnet ist (Claude Code, Codex), und erlaubt es, SKILL.md in der Anwendung zu bearbeiten, neue Skills anzulegen und Skills aus GitHub zu importieren. Einhängen bedeutet einen symbolischen Link in das Skill-Verzeichnis des Agenten und wirkt ab der nächsten Sitzung; Aushängen löscht nur den Link, der Skill selbst bleibt unangetastet.

## Zwei Macs und der Hub

Der Rechner, auf dem die Ersteinrichtung zuerst durchlief, ist der **Hub**: Aufgabenboard, Regeln und Skills liegen auf ihm. Der zweite Rechner tritt in Schritt 3 der Ersteinrichtung bei; danach wird das Aufgabenboard alle 2 Minuten in beide Richtungen abgeglichen (über die Dolt-Fernschnittstelle), und auch Regeln und Skills bleiben einfach vorhanden. Oben in der Seitenleiste können Sie nach Rechner filtern. Projekte und Sitzungen lassen sich zwischen beiden Rechnern **verschieben**. Näheres unter [Zwei Macs](21-two-macs.md).

## Herdr

Herdr ist ein Multiplexer für Agenten im Terminal und bleibt über tmux im Hintergrund am Laufen. Dispatch nutzt ihn, um:

- **Aufgaben zu vergeben**: in einem neuen Tab einen Agenten starten, eine Aufgabe übernehmen, den ersten Prompt senden.
- **In der Ursprungssitzung zu antworten**: Was Sie in Dispatch oder am Handy tippen, wird in das Eingabefeld jenes Agenten in Herdr zugestellt; läuft er gerade, wird es eingereiht oder zuvor mit Esc unterbrochen.
- **Den Zustand zu bestimmen**: Nur Sitzungen, die in Herdr laufen, haben einen Tab-Titel, eine Einschätzung Läuft oder Wartet auf Sie, Antwortmöglichkeit vom Handy und Tastendrücke für Bestätigungsdialoge.

Sitzungen, die in Warp, iTerm, Terminal oder VS Code laufen, lassen sich „In Herdr übernehmen“ (`dispatch adopt`): Der untätige ursprüngliche Prozess wird beendet, und in einem neuen Herdr-Tab wird dieselbe Sitzung mit `--resume` fortgesetzt.

## Rechner, Agenten und „Sie“

- **Rechner**: jeder Mac in `~/tasks/.dispatch/hosts.json`; unter Einstellungen → Rechner lassen sie sich umbenennen, erneut prüfen und löschen.
- **Agent**: Claude Code, Codex, pi, ZCode, OpenCode und Hermes gelten jeweils als eigene Identität; mehrere Sitzungen desselben Agenten teilen sich ein Bild.
- **Sie**: maßgeblich ist der lokale Benutzername; Kommentare in Aufgaben und abgehakte Abnahmekriterien werden damit gezeichnet.
