# Glossar und Tastenkürzel

> Worum es auf dieser Seite geht: die Begriffe aus Oberfläche und Befehlen, je in einem Satz erklärt; dazu die Tastenkürzel und Mausaktionen der Desktop-Fassung.

## Glossar

| Begriff | Bedeutung |
|:--|:--|
| Agent | ein Programmierassistent: Claude Code, Codex, pi, ZCode, Gemini CLI, OpenCode, Hermes. Dispatch liest nur deren Aufzeichnungen und tritt nicht an ihre Stelle |
| Sitzung | ein vollständiges Gespräch eines Agenten in einem Verzeichnis, aus dessen eigener Transkriptdatei oder Datenbank |
| Projekt | die Einheit, der eine Sitzung über ihr Arbeitsverzeichnis zugeordnet wird; ein richtiges Projekt ist nur, was Aufgaben, Ergebnisse oder eine manuelle Zuordnung hat, alles Übrige ist ein „Ordner“ |
| Arbeitsbereich-Ordner | die Ordnerliste in den Einstellungen (voreingestellt `~/Projects`), deren direkte Unterordner je als eigenes Projekt gelten |
| Aufgabe | ein Eintrag auf dem zentralen Aufgabenboard (Beads), den ein Agent mit `dispatch begin/log/done` führt |
| Aufgabenboard | die Beads-Datenbank im Verzeichnis `~/tasks/.beads`, gespeichert in Dolt und zwischen zwei Rechnern abgeglichen |
| Beads / bd | die Software des Aufgabenboards und ihre Befehlszeile |
| Dolt | eine Datenbank mit Versionshistorie, in der das Aufgabenboard speichert und abgleicht |
| Herdr | der Multiplexer für Agenten im Terminal, über tmux dauerhaft im Hintergrund; Aufgaben vergeben, in der Ursprungssitzung antworten und den Zustand bestimmen laufen über ihn |
| Hub | der erste Mac, der die Ersteinrichtung durchlaufen hat; Aufgabenboard, Regeln und Skills liegen auf ihm |
| beitreten | wenn der zweite Mac das Aufgabenboard des Hubs nutzt |
| verschieben | ein Projekt oder eine Sitzung auf den anderen Mac bringen und dort weiterarbeiten |
| Ergebnis | ein eigenständiger Liefernachweis (`dispatch:outcome`), der mehrere Aufgaben und Sitzungen verknüpfen kann |
| Abnahmekriterien | die Liste aus `- [ ]` in einer Aufgabe; wer abhakt, wird vermerkt |
| Abschlussnotiz | was mit `dispatch done --reason` an Lieferung und Prüfung festgehalten wurde |
| Wartet auf mich | was Sie erledigen müssen: ungelesene Antwort, wartet auf Bestätigung, nur Sie können |
| Ungelesene Antwort | der Agent ist fertig und Sie haben die letzte Runde noch nicht gelesen |
| Wartet auf Bestätigung | der Agent steht an einem Bestätigungsdialog zu Berechtigungen, einem vertrauenswürdigen Verzeichnis und dergleichen |
| Nur Sie können | etwas, das nur Sie erledigen können und das ein Agent mit `dispatch need-you` festgehalten hat |
| Blockiert | eine Aufgabe mit offenen Abhängigkeiten; sind die Abhängigkeiten erledigt, löst sie sich von selbst |
| Zurückgestellt | der Status einer Aufgabe, die vorerst nicht eingeplant ist |
| Agent-Prüfung | ein Agent bittet einen anderen um eine unabhängige Gegenprüfung (`--review-by` bzw. `dispatch review`) |
| Verfolgt | eine als Favorit markierte Sitzung oder ein solches Projekt: oben angeheftet und nicht automatisch archiviert |
| Archivieren | aus Arbeitsplatz und Liste ausblenden, jederzeit wieder auffindbar; eine Sitzung ohne Aktivität wird nach der festgelegten Anzahl Tage automatisch archiviert |
| Papierkorb | entfernte Aufgaben, deren Aufzeichnung und Abhängigkeiten erhalten bleiben und die sich wiederherstellen lassen |
| Geplante Sitzung | eine von einer zeitgesteuerten Aufgabe, einem Skript oder einem anderen Agenten über eine Programmierschnittstelle gestartete Sitzung; sie erscheint nicht unter „Wartet auf mich“ und löst keine Mitteilung aus |
| Vereinzelte Sitzung | eine Sitzung ohne Titel und mit höchstens einem Satz, unten in der Sitzungsliste eingeklappt |
| Ursprung | wo eine Sitzung gestartet wurde: Terminal, Desktop-App, VS Code, SDK, zeitgesteuerte Aufgabe, Telegram und so weiter |
| In Herdr übernehmen | `dispatch adopt`: beendet den untätigen Sitzungsprozess in einem anderen Terminal und setzt dieselbe Sitzung in Herdr mit `--resume` fort |
| Fortsetzen | dieselbe Aufzeichnung in Herdr erneut öffnen, nachdem das ursprüngliche Terminal geschlossen wurde |
| In Warteschlange senden / Unterbrechen und senden | während der Agent läuft, die Nachricht hinter die laufende Runde stellen, oder zuerst mit Esc unterbrechen und dann senden |
| Zurücknehmen | eine noch unbearbeitete Nachricht aus der Warteschlange von Claude Code zurückholen |
| Geteilte Ansicht / Ablösen | 2 oder 4 Sitzungen nebeneinander auf einer Seite; die aktuelle Seite in ein eigenes Fenster verschieben |
| Wissensbasis / Wiki | die Erfahrungen aller Agenten: Stolperfalle, Bewährt, Rückblick, Anleitung, gespeichert im Beads-Speicher |
| Stolperfalle / Bewährt / Rückblick / Anleitung | die vier Arten von Einträgen der Wissensbasis |
| Regeln / GLOBAL.md | die gemeinsamen Regeln aller Agenten, mit der einzigen Quelle `~/.agents/rules/GLOBAL.md` |
| verwalteter Block | der Abschnitt aus GLOBAL.md, der in die Einstiegsdatei jedes Agenten abgeglichen wird |
| Unterlagen / FACTS.md | Server, Datenbanken und der Zweck von Konten; global in `~/.agents/rules/FACTS.md`, für ein Projekt in dessen Projektordner |
| Schlüssel / dispatch env | die API-Schlüssel und Kennwörter in `~/.config/dispatch/env`; ein Agent sieht nur die Namen |
| Notizen | die langfristigen Notizdateien, die jeder Agent über seine Sitzungen hinweg für sich sammelt |
| Über mich / PROFILE.md | das Profil über den Benutzer selbst, von den Agenten automatisch gepflegt |
| Skill-Pool | `~/.cc-switch/skills`, mit je einem Verzeichnis samt SKILL.md pro Skill |
| bereitstellen | einen Skill per symbolischem Link in das Skill-Verzeichnis eines Agenten legen |
| prime | `dispatch prime`: die Zusammenfassung, die beim Sitzungsstart eingespielt wird |
| Hook | ein Ereignishaken von Claude Code, über den der Zustand gemeldet, prime eingespielt und gleichzeitiges Bearbeiten verhindert wird |
| Verlauf | das Diagramm Aufgabe → Sitzung → Fortschritt bzw. Commit |
| Erkenntnisse | die agentenübergreifenden Rückblickssignale und der vom Modell geschriebene Bericht |
| Diskussion | mehrere Agenten sagen zu einem Gedanken je einmal etwas und ziehen ein Ergebnis |
| Vergeben | in Herdr auf einem Rechner einen Agenten für eine bestimmte Aufgabe starten |
| Kontingent | die Verbrauchsfenster und Reset-Zeiten der Abos der einzelnen Agenten |
| Modell für Zusammenfassungen | das in den Einstellungen gewählte Modell, das Sitzungszusammenfassungen, den aktuellen Projektstand und dergleichen schreibt |
| Tailscale | ein virtuelles privates Netz, über das Handy und zweiter Rechner zugreifen |
| ntfy / Bark | Kanäle für Mitteilungen aufs Handy |
| noVNC | den Bildschirm des Rechners im Browser des Handys sehen und bedienen |
| Rechner / hosts.json | jeder in `~/tasks/.dispatch/hosts.json` erfasste Mac |

## Tastenkürzel (Desktop-Fassung)

| Taste | Wirkung |
|:--|:--|
| <kbd>⌘K</kbd> | Projekte, Sitzungen und Aufgaben durchsuchen |
| <kbd>⌘N</kbd> | neue Sitzung |
| <kbd>⌘T</kbd> | neue Aufgabe |
| <kbd>⌘R</kbd> | aktualisieren |
| <kbd>⌘⏎</kbd> | Antwort senden, Kommentar senden, Dialog sichern (neue Aufgabe, Eintrag festhalten, Schlüssel, Skill) |
| <kbd>⌘S</kbd> | die gerade bearbeitete SKILL.md sichern |
| <kbd>Esc</kbd> | Dialog schließen, Aufgabendetails schließen (beim Bearbeiten der Eigenschaften zuerst die Bearbeitung verlassen), das Befehlsmenü mit / schließen, Suchfeld leeren |
| <kbd>↑</kbd> <kbd>↓</kbd> <kbd>⏎</kbd> | im Suchfeld, im Befehlsmenü mit / und im Kontextmenü bewegen und auswählen |
| <kbd>→</kbd> <kbd>←</kbd> | im Rundgang einen Schritt vor bzw. zurück |
| <kbd>⌘</kbd> plus Klick | Projekt, Sitzung oder Aufgabe in einem neuen Fenster öffnen |
| Rechtsklick | eigene Menüs für Aufgaben, Sitzungen, Projekte, Skills, Dateien, Rechner, Einträge der Wissensbasis und Regeldokumente; auf einer leeren Stelle die Aktionen dieser Seite. Am Handy langes Drücken von etwa einer halben Sekunde |
| Doppelklick | Anzeigename eines Projekts über den Titel ändern; Aufgabenbeschreibung zum Bearbeiten öffnen |
| Ziehen | eine Karte auf dem Board in eine andere Spalte bringen |

Die Tastenkürzel lösen auch in Eingabefeldern aus (bekannte Einschränkung).
