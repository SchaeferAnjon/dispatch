# Skills

> Worum es auf dieser Seite geht: was im Skill-Pool liegt, welchem Agenten ein Skill bereitgestellt ist, wie Sie SKILL.md in der Anwendung ändern und wie Sie einen Skill neu anlegen oder aus GitHub importieren.

## Skill-Pool

Ein Skill ist ein Verzeichnis mit einer `SKILL.md`; alle liegen gesammelt in `~/.cc-switch/skills` (dem Skill-Pool). Die Agenten arbeiten mit symbolischen Links: für Claude Code bereitgestellt, führt der Link nach `~/.claude/skills`, für Codex bereitgestellt nach `~/.agents/skills` oder `~/.codex/skills`. Eine Bereitstellung wirkt ab der nächsten Sitzung; das Entfernen löscht nur den Link, der Skill selbst bleibt unangetastet. Derzeit ist die Bereitstellung nur für diese beiden Agenten möglich.

Oben auf der Seite steht eine Zeile „Geändert wird auf <Rechner>“: Haben Sie in der Seitenleiste einen anderen Rechner gewählt, wird dort geändert (ist er nicht erreichbar, wird der Grund genannt).

## Liste links

- Durchsucht Skill-Namen und Beschreibungen; filterbar nach „Alle / Claude Code N / Codex N“.
- „Nach Nutzung“ sortiert nach der Anzahl der Aufrufe aus dem Sitzungsindex (C = Claude Code, X = Codex; Codex und ZCode zeichnen Skill-Aufrufe nicht auf).
- Je Eintrag: Name, „nur an einer Stelle“ (nicht im Skill-Pool, sondern nur im Verzeichnis eines Agenten installiert), Anzahl der Aufrufe, Beschreibung und die beiden Bereitstellungsmarken.
- „✦ Skills anhand der jüngsten Arbeitsabläufe verbessern“: kopiert einen Startbefehl, den Sie im Terminal einfügen und ausführen. Der Agent prüft dann anhand der Sitzungen der letzten 14 Tage die meistgenutzten Skills und verbessert sie.
- „＋ Neuer Skill“: Skill-Name (der Verzeichnisname), Auslöser in einem Satz, Auslösebedingungen, wichtigste Vorgaben und die Bereitstellung. Der Skill wird nach der Vorlage SKILL.md im Skill-Pool angelegt und bereitgestellt.
- „Von GitHub importieren“: Sie tragen `owner/repo` oder die URL des Repositorys ein (Unterverzeichnis und Name im Pool sind wählbar); das öffentliche Repository wird heruntergeladen und das Verzeichnis mit der SKILL.md in den Skill-Pool kopiert. Fehlt dem Repository eine SKILL.md, wird ein Einstieg zum späteren Ausarbeiten erzeugt; Herkunft und LICENSE werden mit festgehalten.

Rechtsklick auf einen Skill: ansehen, für einen Agenten bereitstellen bzw. von dort entfernen, im Editor öffnen, im Finder zeigen, Pfad kopieren, Inhalt der SKILL.md kopieren, in den Papierkorb legen (oder die Bereitstellung entfernen). Rechtsklick auf eine leere Stelle: Skill-Liste aktualisieren, Skills anhand der jüngsten Arbeitsabläufe verbessern, Skill-Pool im Finder zeigen.

## Details rechts

Skill-Name, Pfad und die gerade geöffnete Datei (voreingestellt SKILL.md; relative Links im Markdown führen innerhalb des Skill-Verzeichnisses weiter, und „Dateien dieses Skills · N“ listet alle Dateien auf). Die Schaltflächen: im Finder zeigen, im Editor öffnen und „Hier bearbeiten“ (bearbeiten in der Anwendung, <kbd>⌘S</kbd> sichert, die vorherige Fassung bleibt als `.bak` erhalten). Darunter zwei Zeilen mit Kontrollkästchen für die Bereitstellung: Claude Code und Codex, jeweils mit dem Bereitstellungsverzeichnis.

## Befehlszeile

```sh
dispatch skills list --json
dispatch skills show <Name> [--file detail-04.md]
dispatch skills enable <Name> --agent claude    # oder codex / all; ohne Angabe = beide
dispatch skills disable <Name> --agent codex
dispatch skills new <Name> --description "…" --trigger "…" --constraint "…" --agent claude
dispatch skills import owner/repo [--path skills/pdf] [--as Name] [--force]
dispatch skills open <Name> [--reveal]
dispatch skills trash <Name>
```

`dispatch catalog` listet die Skills und Erweiterungen auf, die standardmäßig nicht bereitgestellt sind; hält ein Agent einen davon für offensichtlich nützlich, schlägt er die Aktivierung vor.
