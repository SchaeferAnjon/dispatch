# Regeln & Unterlagen

> Worum es auf dieser Seite geht: wie Sie die gemeinsamen Regeln aller Agenten schreiben, abgleichen und prüfen. Auf dieser Seite verwalten Sie außerdem die Unterlagen, die Schlüssel, die Notizen der einzelnen Agenten und „Über mich“.

Oben auf der Seite stehen vier Modi: **Agent-Regeln**, **Unterlagen**, **Agent-Notizen** und **Über mich**. Jeder Modus zeigt den Hinweis „Geändert wird auf <Rechner>“; haben Sie in der Seitenleiste einen anderen Rechner gewählt, wird dort geändert.

## Agent-Regeln

### Der Gedanke dahinter

`~/.agents/rules/GLOBAL.md` ist die **einzige Quelle** der gemeinsamen Regeln. Beim Abgleich wird die Datei in einen verwalteten Block in der Einstiegsdatei jedes Agenten geschrieben:

```
<!-- BEGIN DISPATCH GLOBAL RULES ... -->
… der Inhalt von GLOBAL.md …
<!-- END DISPATCH GLOBAL RULES -->
```

Einstiegsdateien sind zum Beispiel `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` sowie die entsprechenden Orte von pi, Gemini und OpenCode. Außerhalb des verwalteten Blocks steht die besondere Konfiguration des jeweiligen Agenten. Ändern Sie Regeln in GLOBAL.md und gleichen Sie danach ab; beim Bearbeiten einer Einstiegsdatei erscheint der verwaltete Block als einzeilige Platzhalterzeile und lässt sich nicht versehentlich ändern.

### Die Seite

- **Geltungsbereich**: die globalen Regeln, oder ein erkanntes Projekt (dann sehen Sie die AGENTS.md bzw. CLAUDE.md des Projekts zusammen mit den geerbten globalen Regeln).
- **Abgleichschaltfläche**: „Gemeinsame Regeln abgeglichen“ oder „Gemeinsame Regeln abgleichen · N ausstehend“; steht dort „Noch keine gemeinsamen Regeln eingerichtet“, holen Sie zuerst Schritt 5 der Ersteinrichtung nach. In der Befehlszeile `dispatch rules status|sync`.
- **Dokumentliste links**: „Gemeinsame Regeln aller Agenten“ (GLOBAL.md), die Einstiegsdateien der Agenten, die Projektregeln und die verwiesenen Dokumente; gekennzeichnet wird, was noch nicht angelegt, was überschrieben, was ein verwiesenes Dokument, was eine Projektregel und was eine globale Einstiegsdatei ist. Der Rechtsklick bietet im Editor öffnen, im Finder zeigen, Pfad kopieren und Inhalt kopieren.
- **Rechts**: der Inhalt des Dokuments (als Markdown gerendert) sowie Zeilenzahl und Größe. „Bearbeiten“ wechselt in den Bearbeitungsmodus; „Prüfen“ führt eine lokale statische Prüfung durch: Dopplungen, mögliche Widersprüche, ins Leere laufende Verweise, Geltungsbereich, Länge, Übertragbarkeit, Ringverweise und Versionsabweichungen. Die Prüfung **ruft kein Modell auf und lädt kein Dokument hoch**.
- Beim Bearbeiten: „Prüfen und Unterschiede anzeigen“ → „Änderungen an N Dateien anwenden“. Vor dem Sichern werden die Versionen aller Dokumente erneut geprüft; ändern Sie GLOBAL.md, werden alle verwalteten Kopien zusammen angezeigt und zusammen gesichert. Eine Wiederherstellungsfassung bleibt erhalten („Letzten Stand wiederherstellen“). Hat ein anderes Programm die Datei geändert, wird das Überschreiben verweigert.
- **Prüfhinweise**: jeder Hinweis mit Typ, Fundstelle, Erläuterung und Vorschlag; „Prompt für die Tiefenprüfung kopieren“ übergibt den gewählten Zusammenhang Ihrem eigenen Agenten für eine inhaltliche Prüfung. „Mögliche Widersprüche“ ist das Ergebnis einer statischen Prüfung, kein vollständiger inhaltlicher Nachweis.
- **Verweise und Prüfgrundlagen**: worauf dieses Dokument verweist, dazu die Links auf die offiziellen Dokumentationen der Agenten.

Eine Regeländerung lädt laufende Agent-Sitzungen nicht sofort neu; sie wirkt erst in einer neu geöffneten Sitzung.

## Unterlagen

Drei Blöcke:

- **Keys und APIs**: die Oberfläche zu `dispatch env`. Die Schlüssel liegen in `~/.config/dispatch/env` (nur für Sie lesbar) und kommen weder auf das Aufgabenboard noch in die Wissensbasis noch nach Git. Jeder Eintrag hat Namen, Zweck, wahlweise ein Projekt (gehört er nur zu einem Projekt, sieht ein Agent ihn nur in dessen Sitzungen, und die Projektseite listet ihn ebenfalls auf) und den maskierten Wert. Aktionen: einblenden, kopieren, bearbeiten, Abrufbefehl kopieren (`dispatch env get Name`) und löschen (zweimal klicken zum Bestätigen, der Wert ist danach unwiederbringlich). Ein Agent sieht zu Beginn einer Sitzung nur Namen und Zweck und holt sich den Wert bei Bedarf selbst; Sie müssen also nicht jedes Mal einen Schlüssel einfügen.
- **Server und Datenbanken**: die globale `~/.agents/rules/FACTS.md`, in der Rechner, Cloud-Dienste, Datenbanken und der Zweck von Konten stehen. Der Abschnitt `## Allgemein` wird in jede Sitzung eingespielt; Passwörter und Token gehören zu den Schlüsseln. Die kurzen Fakten eines einzelnen Projekts stehen in dessen FACTS.md im Reiter „Dokumente“ der Projektseite.
- **Obsidian-Ablagen**: listet die auf dem gewählten Rechner erkannten Ablagen auf, mit „In Obsidian öffnen“ und „Pfad kopieren“. Gelesen werden nur die Metadaten; Notizen werden weder verschoben noch hochgeladen.

## Agent-Notizen

Die langfristigen Notizen, die jeder Agent über seine Sitzungen hinweg für sich sammelt (die Notizdateien von Claude Code, Codex, ZCode und Hermes), gruppiert nach Agent und Projekt. Die Seite ist schreibgeschützt.

- Baum links: Agent → Projekt → Eintrag. Die Marke „Index“ kennzeichnet die Indexdatei eines Projekts, die Marke „veraltet“ diejenigen, deren Projektverzeichnis nicht mehr vorhanden ist; letztere lassen sich in den Ordner `archived/` im selben Verzeichnis archivieren.
- Rechts: Ohne Auswahl sehen Sie die **Übersicht** (vom Modell für Zusammenfassungen geschrieben, ein Gesamtbild und je Projekt ein Satz, zwischengespeichert; „Neu zusammenfassen“ schreibt sie neu). Wählen Sie ein Projekt, sehen Sie dessen Einträge; wählen Sie einen Eintrag, sehen Sie den Text und können „Pfad kopieren“, „Mit der Standardanwendung öffnen“ und „Zu ‚Über mich‘“ nutzen (hängt diesen Eintrag an „Über mich“ an, sodass alle Agenten ihn künftig sehen).

In der Befehlszeile `dispatch memories list|show|archive|summary`. Beim Öffnen dieser Seite wird automatisch einmal die Übersicht angefordert (das ruft ein Modell auf), siehe [Bekannte Einschränkungen](26-limits.md).

## Über mich

`~/.agents/rules/PROFILE.md`: das Profil über Sie selbst, unterteilt in aktueller Stand, was künftig geschieht und was bereits geschehen ist. Agenten pflegen es selbst (`dispatch profile add|upcoming|done`), und `dispatch prime` spielt es ein. Hier können Sie es unmittelbar bearbeiten; „Neu erfassen“ lässt einen Agenten den Stand jedes Rechners tatsächlich nachmessen und den Abschnitt „Stand der Geräte und Dienste“ neu schreiben (das ruft ein Modell auf).
