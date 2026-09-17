# Dispatch Benutzerhandbuch

> Worum es auf dieser Seite geht: zuerst klären, was Dispatch ist, für wen es taugt und was es nicht macht, und dann entscheiden, mit welchem Kapitel Sie anfangen. Das gesamte Handbuch lässt sich über das Suchfeld links oben im Volltext durchsuchen.

Dispatch ist ein **lokaler Agent-Arbeitsplatz**, der auf Ihrem Mac läuft. Sie arbeiten im Terminal oder im Editor wie gewohnt mit Programmier-Agenten: Claude Code, Codex, pi, ZCode, Gemini CLI, OpenCode, Hermes. Dispatch liest nur die Aufzeichnungen, die diese Agenten ohnehin schon lokal geschrieben haben, und stellt jede Sitzung, jede Aufgabe und jedes Ergebnis nach **Projekt** sortiert auf einen Tisch: wer auf Sie wartet, wer läuft, wie weit etwas gediehen ist. Wenn ein Agent auf Sie wartet, antworten Sie am Rechner oder am Handy direkt in der Ursprungssitzung.

Aktuelle Version v0.7.29, unterstützt macOS 14 und neuer, quelloffen (MIT). Website und Demovideo unter <https://schaeferanjon.github.io/dispatch/>, Quellcode unter <https://github.com/SchaeferAnjon/dispatch>.

![Arbeitsplatz: der aktuelle Stand jedes Projekts](../../assets/shot-home.png)

## Was es macht

- **Liest nur lokale Aufzeichnungen**: die Transkriptdateien von Claude Code und Codex (auch für Sitzungen aus der VS-Code-Erweiterung), die Sitzungsdateien von pi sowie die Datenbanken von OpenCode, ZCode und Hermes. Es braucht weder einen API-Schlüssel noch ein vorher angelegtes Aufgabenboard, damit Sie Sitzungen sehen.
- **Ordnet nach Projekt**: Sitzungen werden über ihr Arbeitsverzeichnis einem Projekt zugeordnet; Aufgaben und Ergebnisse hängen an Sitzungen; die Projektseite ist der vollständige Nachweis eines Projekts (Rückblick, Sitzungen, Aufgaben, Ergebnisse, Dokumente, Wissensbasis).
- **Antworten gehen in die Ursprungssitzung zurück**: Wenn Sie vom Arbeitsplatz, aus „Wartet auf mich“ oder vom Handy in eine Sitzung gehen und dort antworten, wird die Nachricht an die Ursprungssitzung in jenem Terminal zugestellt. Läuft sie gerade, wird die Nachricht eingereiht; eine falsch abgeschickte Nachricht lässt sich zurückziehen.
- **Aufgaben führt der Agent selbst**: Jede neue Sitzung erhält zu Beginn automatisch ihre Identität, die Aufgaben des Projekts und das passende Wissen. Der Agent führt Aufgaben mit `dispatch begin / log / done` und trägt Stolperfallen mit `dispatch wiki` ein. Sie müssen nichts einzeln in der Oberfläche abhaken.
- **Ein Datenbestand für zwei Rechner**: Aufgabenboard, Regeln und Skills werden abgeglichen; ein Projekt lässt sich samt nicht übernommener Änderungen, Git-Historie und laufender Sitzungen mit einem Klick auf den anderen Rechner verschieben.
- **Handy**: Zugriff auf dieselbe Oberfläche über Tailscale; Mitteilungen über ntfy, Bark oder die Systembenachrichtigungen; bei Bedarf sehen Sie den Bildschirm des Rechners über noVNC.
- **Keine zusätzlichen Modellaufrufe**: Die Oberfläche selbst ruft kein Modell auf. Nur die Funktionen der Kategorie „Zusammenfassung“ (Sitzungszusammenfassung, aktueller Projektstand, Ergebnis einer Diskussion, Analysebericht, Überblick über die Notizen, semantische Suche) übergeben Auszüge an das Modell, das Sie in den Einstellungen gewählt haben. Diese Verwendungszwecke sind standardmäßig aktiv und lassen sich in den [Einstellungen](14-settings.md) einzeln abschalten; Näheres unter [Bekannte Einschränkungen](26-limits.md).

## Für wen es taugt

- Für alle, die mehrere Terminals und mehrere Agenten gleichzeitig offen haben und dabei regelmäßig vergessen, welcher auf eine Bestätigung wartet und wie weit welches Projekt ist.
- Für alle, die möchten, dass der Agent Aufgaben und Stolperfallen selbst festhält, statt ein Board von Hand zu pflegen.
- Für alle mit zwei Macs (etwa einem stationären und einem mobilen), die Aufgabenboard und Regeln nur einmal vorhalten wollen.
- Für alle, die unterwegs am Handy den Fortschritt sehen, kurz antworten und eine Bestätigung geben möchten.

## Was es nicht ist

- **Kein weiterer Agent**: Dispatch erzeugt keinen Code und führt das Gespräch mit dem Agenten nicht an Ihrer Stelle. Es schaut zu und leitet weiter.
- **Kein Cloud-Dienst**: Alle Daten bleiben auf Ihrem Mac. Der Zugriff vom Handy läuft über das private Tailscale-Netz und ist nicht im offenen Internet erreichbar.
- **Keine allgemeine Projektmanagement-Software**: Das Aufgabenboard (Beads) führt der Agent; Felder und Abläufe sind auf die Frage zugeschnitten, was der Agent getan hat und was Sie tun müssen.
- **Liest keine ChatGPT-Websitzungen** und bekommt auch keine Lesebestätigung aus der ursprünglichen Agent-Anwendung (ungelesene Antworten verschwinden erst, nachdem Sie geantwortet haben).
- **Derzeit nur für macOS**. Die Oberfläche ist Tauri plus React, die Logik steckt in einer Python-CLI. Eine Portierung ist möglich, aber noch nicht erfolgt.

## Wie Sie dieses Handbuch lesen

| Sie wollen | Lesen Sie |
|:--|:--|
| Installieren und das erste Projekt sehen | [In fünf Minuten startklar](01-quickstart.md) |
| Die Begriffe Projekt, Sitzung, Aufgabe, Ergebnis, Wartet auf mich verstehen | [Kernbegriffe](02-concepts.md) |
| Wissen, wofür eine bestimmte Schaltfläche da ist | Die Gruppe „Jede Seite“, etwa [Sitzungsseite](05-session.md) |
| Wissen, was am Handy geht und wie Sie sich verbinden | [Handy](20-phone.md) |
| Den zweiten Mac anbinden und Projekte verschieben | [Zwei Macs](21-two-macs.md) |
| Wissen, wie Agenten Aufgaben führen und Commit-Nachrichten schreiben | [Konventionen auf Agent-Seite](22-agent.md) |
| Die Parameter eines Befehls nachschlagen | [Referenz der Befehlszeile](23-cli.md) |
| Einen Fehler beheben | [Häufige Fragen und Fehlerbehebung](24-troubleshooting.md) |
| Wissen, wo es noch hakt | [Bekannte Einschränkungen](26-limits.md) |

Die Quellsprache der Oberflächentexte ist vereinfachtes Chinesisch; die Schaltflächennamen in der englischen und der deutschen Fassung stimmen mit der jeweiligen Sprache in der Anwendung überein. In den Einstellungen können Sie die Sprache der Oberfläche auf Systemsprache, Chinesisch, English oder Deutsch stellen.
