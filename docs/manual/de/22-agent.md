# Konventionen auf Agent-Seite

> Worum es auf dieser Seite geht: woher ein Agent vom Aufgabenboard weiß, wann er welchen `dispatch`-Befehl ausführen soll, wie eine Commit-Nachricht aussehen muss, damit sie zur Aufgabe passt, und wie Ergebnisse erfasst werden. Diese Konventionen stehen im Skill `task-board`, der mit der Anwendung ausgeliefert wird (`agent/skills/task-board/SKILL.md`); hier ist die Fassung für Menschen.

## Woher ein Agent das weiß

- Schritt 4 der Ersteinrichtung richtet für Claude Code die Hooks ein: Bei `SessionStart` läuft `dispatch prime --hook-json` und spielt eine Zusammenfassung an den Anfang der Sitzung ein; die übrigen Ereignisse (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Notification`, `PermissionRequest`, `Stop`, `SessionEnd`) melden den Sitzungszustand (darauf beruht „Läuft / Wartet auf Sie“ im Arbeitsplatz), und vor und nach bearbeitenden Werkzeugen läuft die Prüfung auf gleichzeitiges Bearbeiten.
- Schritt 5 gleicht die gemeinsamen Regeln in die Einstiegsdatei jedes Agenten ab und hängt den Skill `task-board` in den Skill-Pool ein; Codex, pi, ZCode (`dispatch zcode-plugin install`) und andere erfahren dasselbe über Regeln und Skills.
- Was `dispatch prime` einspielt: wer Sie sind (die Identität des Agenten), das aktuelle Projekt, ein Satz dazu, wie Aufgaben geführt werden, die Aufgaben dieses Projekts auf dem Board (die in Arbeit befindlichen, die an ihn vergebenen, die unbeantworteten Kommentare des Benutzers an Aufgaben), die verfolgten Sitzungen, die Einträge der Wissensbasis zu diesem Projekt und die allgemeinen, die Infos, die Namen der Schlüssel (ohne Werte), das Kontingent und wer sonst noch im selben Verzeichnis arbeitet.

## Der Lebenszyklus einer Aufgabe

```bash
dispatch begin "<Gegenstand> <was geändert wird>: <warum>" -P Projekt -d "Auslöser + erwartetes Ergebnis" -a "- [ ] Abnahmekriterium"
dispatch claim TASK_ID                     # eine vorhandene Aufgabe übernehmen; arbeitet jemand daran, wird abgelehnt, nur --force nimmt sie an sich
dispatch log TASK_ID "wichtiger Fortschritt"   # Fortschritt festhalten; --tick Stichwort hakt ein Abnahmekriterium ab
dispatch done TASK_ID --reason "Lieferung und Prüfung" --verified --retro "【Technik】…【Bewährt】…【Fehlgelaufen】…"
```

Die Regeln:

- Der **Titel** muss jemandem, der die Sache Wochen später kalt liest, auf einen Blick sagen, was geändert wurde und wozu (Beispiel: „Diff auf der Sitzungsseite waagerecht scrollbar gemacht: am Handy war die rechte Hälfte abgeschnitten“). 8 bis 80 Zeichen; zu kurze Titel oder solche aus einem bloßen Verb lehnt `begin` ab; über 40 Zeichen wird an einem Satzzeichen abgeschnitten und der vollständige Titel automatisch in die erste Zeile der Beschreibung übernommen. Die Beschreibung umfasst mindestens 20 Zeichen und nennt Auslöser und erwartetes Ergebnis. `--force` übergeht die Prüfung.
- Sobald die Identität der Sitzung vorliegt, setzt `begin` automatisch die Marken `session-origin:<Sitzungs-ID>` und `session:<Sitzungs-ID>`; das ist die offizielle Verbindung zwischen Aufgabe und Sitzung. Mit `--session` lässt sie sich ausdrücklich angeben.
- `--verified` bedeutet nur, dass eigenhändig geprüft wurde, nicht dass eine unabhängige Gegenprüfung stattfand; es hakt alle noch offenen Abnahmekriterien ab und zeichnet sie (die Oberfläche zeigt „Selbstprüfung · <Agent>“). Wurde einzeln geprüft, nutzen Sie `dispatch log ID --tick Stichwort`.
- `--retro` genügt in ein bis zwei Sätzen und wandert in die Wissensbasis; `--next "Titel der Folgeaufgabe"` legt eine Folgeaufgabe an; `--review-by <agent>` erbittet die Gegenprüfung durch einen anderen Agenten (`dispatch review ID --verdict pass|changes --reason`, wobei der Prüfende nicht der Ausführende sein darf).
- Offene Aufgaben werden nicht geschlossen. `bd show ID --json` zeigt eine Aufgabe, `bd update ID` ändert Felder; `bd edit`, das einen Editor öffnet, wird nicht verwendet.

## Was nur der Benutzer tun kann

```bash
dispatch need-you "was der Benutzer tun soll" -P Projekt -d "warum, wie und wo das Material liegt" [--task TASK_ID]
```

E-Mails schicken, bezahlen, sich anmelden, persönlich vorführen, entscheiden: Solche Dinge gehören nicht nur in die Antwort, sondern werden als „Nur Sie können“ festgehalten. Der Benutzer hakt sie im Reiter Aufgaben der Projektseite ab, und ans Handy geht eine Mitteilung (sofern eingeschaltet).

## Aufgaben-ID in der Commit-Nachricht

Die Commit-Nachricht trägt am Ende die Aufgaben-ID: `feat: Diff auf der Sitzungsseite waagerecht scrollbar (task-abc)`; alternativ steht der Commit-Hash in `done --reason`. Darauf stützen sich „Git-Commits“ auf der Aufgabenseite und `dispatch commits ID`, um Aufgabe und Code zusammenzubringen; gehören mehrere Commits zu einer Aufgabe, trägt jeder die ID. Für die Commit-Nachricht gilt `<type>: <desc>`.

## Wissensbasis

```bash
dispatch wiki search "Stichwort"              # vor dem Anfangen nachsehen; --semantic sucht nach Sinn
dispatch wiki add --kind pit "Symptom" --fix "Lösung" -P Projekt [--task ID]
dispatch wiki add --kind win "Vorgehen" --why "warum es richtig ist" -P Projekt
dispatch wiki add --kind howto "Schritte"
```

## Ergebnisse erfassen

Ein Ergebnis ist ein Beads-Eintrag mit Marken. Ein Agent nutzt `bd create`:

```bash
bd create "Titel des Ergebnisses" -d "was geliefert wurde und wo es zu sehen ist (Markdown, mit Dokumenten, Screenshots, Versionen oder Code-Links)" \
  -l dispatch:outcome -l project:<Projekt> -l outcome-task:<task-id> -l session:<Sitzungs-ID>
bd close <neue id> --reason "als Projektergebnis erfasst"
```

Der Benutzer kann es ebenso im Reiter „Ergebnis“ der Projektseite erfassen oder bearbeiten. Schreiben Sie Zugehörigkeiten nicht massenhaft anhand der Häufigkeit von Erwähnungen fest, und kopieren Sie nicht alle erledigten Aufgaben automatisch zu Ergebnissen.

## Weitere häufige Befehle

```bash
dispatch here [--dir <cwd>] [-P Projekt]  # dieses Projekt im Moment: Stand, Chronik über 14 Tage, offene Aufgaben, aktive Sitzungen und ob sie geschlossen werden können
dispatch editing [--dir <cwd>]           # wer welche Dateien ändert; ändern zwei oder mehr Sitzungen dieselbe Datei, wird ein Konflikt gemeldet
dispatch lineage [-P Projekt]             # Projekt → Aufgabe → Sitzung → Fortschritt
dispatch facts get "Thema" [-P Projekt]   # Infos
dispatch env get NAME                     # den Wert eines Schlüssels holen (prime nennt nur die Namen)
dispatch profile add "Tatsache" / upcoming "2026-09-20|Vorhaben|offen" "Erläuterung" / done <Stichwort>
dispatch docs add <Projekt> <Pfad|URL> --kind 调研|复审|设计|文档|其他   # Ergebnisse von Recherchen und Reviews im Reiter „Dokumente“ der Projektseite erfassen (die Werte bedeuten Recherche, Review, Design, Dokument, Sonstiges)
dispatch notify "Titel" "Text"            # eine Mitteilung ans Handy oder an den Mac senden
dispatch terminal --cwd <Verzeichnis>     # in Herdr einen Terminal-Tab ohne Agent öffnen
dispatch adopt <Sitzungs-ID|pid-N>        # eine Sitzung aus einem anderen Terminal in Herdr übernehmen
dispatch agent start <kind> --cwd … --task <id> -p "…"   # eine Aufgabe an einen anderen Agenten vergeben (darunter liegt Herdr)
```

## Übersicht der Marken (Konventionen auf dem Aufgabenboard)

| Marke | Bedeutung |
|:--|:--|
| `project:<Name>` | zugehöriges Projekt |
| `session-origin:<id>` | auslösende Sitzung, von `begin` automatisch gesetzt |
| `session:<id>` | ausdrücklich verknüpfte auslösende oder beteiligte Sitzung, mehrfach möglich |
| `dispatch:outcome` | Ergebniseintrag, zählt nicht zu den normalen Aufgaben |
| `outcome-task:<task-id>` | Ursprungsaufgabe eines Ergebnisses, mehrfach möglich |
| `dispatch:needs-you` | Nur Sie können |
| `dispatch:trashed` / `dispatch:archived` | Papierkorb / Archiviert |
| `delegated-by:` / `delegated-to:` | wer an wen vergeben hat |
| `host:<Rechner>` | auf welchem Rechner daran gearbeitet wurde |
| `dispatch-projects` (memory) | Favoriten- und Archivzustand von Projekten; Notizen, die mit `dispatch-` beginnen, kommen weder in die Wissensbasis noch in prime |
