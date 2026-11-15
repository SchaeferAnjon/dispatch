# Einstellungen

> Worum es auf dieser Seite geht: die Bedeutung und der Standardwert jeder Karte und jedes Schalters auf der Einstellungsseite. Die meisten Einstellungen liegen auf dem gemeinsamen Aufgabenboard (auf beiden Macs gleich; in der Befehlszeile liest und schreibt `dispatch settings` denselben Bestand); nur was mit „Dieser Mac“ gekennzeichnet ist, betrifft allein den lokalen Rechner.

## Sprache

**Sprache der Oberfläche**: Systemsprache, Chinesisch, English, Deutsch. Bei „Systemsprache“ richtet sie sich automatisch nach der Sprache von macOS oder des Browsers; eine Auswahl wirkt sofort und gilt ebenso für die Webfassung am Handy.

## Sitzungen

- **Normale Sitzungen nach so vielen Tagen ohne Aktivität archivieren** (Vorgabe 30, 0 = nie): Als Favorit markierte (verfolgte) Sitzungen bleiben unberührt; archivierte finden Sie weiterhin unter „Archiviert“ auf der Sitzungsseite und über ⌘K.
- **Modell für Zusammenfassungen**: Die Auswahlliste nennt die verfügbaren Modelle, jeweils mit dem Vermerk „Abo“, „Key vorhanden“ oder „Key fehlt“. Abo-Modelle (etwa `claude:haiku` über das Claude-Code-Abo) brauchen keinen Schlüssel und zählen zum Verbrauch; Modelle mit API-Schlüssel (Zhipu, Kimi, MiniMax, OpenAI) nutzen die Schlüssel aus der Seite „Umgebung“. Wählen Sie ein Modell, dessen Schlüssel fehlt, erscheint ein Eingabefeld, aus dem der eingefügte Schlüssel lokal nach `dispatch env` gesichert wird. Leer lassen bedeutet automatische Wahl: die Variable `SUMMARY_MODEL` → das erste verfügbare Modell.
- **Tabelle der Verwendungszwecke**: wo Zusammenfassungen erscheinen, je Zweck ein Schalter, rechts daneben die Token-Zahl, der Zeitpunkt und das Modell des letzten Laufs. Die Zwecke sind: Sitzungszusammenfassung, aktueller Projektstand, dispatch here, Ergebnis einer Diskussion, Analysebericht, Zusammenfassung der Notizen, Bestandsaufnahme der Geräte und Index für die semantische Suche (nur mit ZHIPU_API_KEY). **Alle sind standardmäßig aktiv**; wenn nichts den Rechner verlassen soll, schalten Sie sie hier ab. In der Befehlszeile zeigt `dispatch summarize uses` die Tabelle, und `dispatch settings summary_uses '{"session":0}'` ändert sie.
- **Über das SDK von Skripten oder anderen Agenten gestartete Sitzungen als geplant behandeln** (Vorgabe: an): Geplante Sitzungen erscheinen nicht unter „Wartet auf mich“, lösen keine Mitteilungen aus und stehen nicht im Arbeitsplatz; zu finden sind sie auf der Sitzungsseite unter „Geplant oder per Skript“. Eine manuelle Markierung einer einzelnen Sitzung hat Vorrang.

## Mitteilungen aufs Handy

Siehe [Handy → Mitteilungen](20-phone.md#mitteilungen-aufs-handy). Auf dieser Karte finden Sie: den Bark-Key, die ntfy-Themenadresse (gesichert als `BARK_KEY` bzw. `NTFY_URL` in `dispatch env`; sind beide gesetzt, gilt ntfy), die vier Ereignisschalter (Agent hat geantwortet, Agent wartet auf Bestätigung oder stellt eine Frage, Aufgabe erledigt, nur Sie können es tun) und „Testmitteilung senden“.

## Projekte

- **Arbeitsbereich-Ordner** (Vorgabe `~/Projects`, einer pro Zeile): Jeder direkte Unterordner dieser Ordner gilt als eigenes Projekt. An anderen Orten wird nach dem Wurzelverzeichnis des Git-Repositorys zugeordnet, ohne Repository nach dem enthaltenden Ordner.
- Als richtiges Projekt gilt nur, was Aufgaben hat, Ergebnisse hat oder manuell zugeordnet wurde; alles Übrige ist lediglich ein „Ordner“.

## Diskussionen

Die Rolle jedes Mitglieds in „Eine Idee besprechen“ und die Regeln der Runde; beides geht in deren Systemprompt ein, und in jeder weiteren Runde werden nur die neuen Beiträge nachgereicht. Leer lassen verwendet die Vorgaben.

- **Regeln der Runde**: wie lang ein Beitrag sein darf, wann Small Talk erlaubt ist und wann nur SKIP geantwortet wird (wird nicht angezeigt).
- **Rolle von Claude, Codex und pi**: je ein Satz dazu, worauf die Rolle achtet, wie sie sich ausdrückt und was sie gewohnheitsmäßig hinterfragt.

## Arbeitsplatz

- **Erledigte Aufgaben nach so vielen Tagen automatisch archivieren** (Vorgabe 0 = nicht automatisch): Aufgaben, die länger als so lange erledigt sind, werden als archiviert markiert und verschwinden aus der Spalte Erledigt und deren Zählung; auf dem Board bleibt die Schaltfläche „Vor 30 Tagen erledigte archivieren“.
- **Wie viele Projekte vorab ausklappen** (Vorgabe 2): Die übrigen werden auf eine Zeile gefaltet; Projekte, in denen eine Antwort oder eine Bestätigung auf Sie wartet, sind immer ausgeklappt.

## Dieser Mac

- **Erscheinungsbild**: Systemeinstellung, Hell, Dunkel; betrifft nur die Fenster auf diesem Rechner.
- **Zugriff vom Handy**: ein eingebetteter QR-Code (der Link enthält ein Anmeldetoken; einmal scannen genügt) und „Link kopieren“. Bei zwei Rechnern lässt sich wählen, auf welchem „die Handy-Fassung läuft“: Wählen Sie den Mac, der stehen bleibt, dann funktioniert das Handy auch, wenn Sie den anderen mitnehmen; nach einem Wechsel müssen Sie den Link am Handy einmal neu öffnen.
- **Bildschirmzugriff**: „Einrichten“ installiert noVNC samt Dauerdienst und richtet Tailscale-HTTPS ein (entspricht `dispatch screen setup`) und listet das Ergebnis jedes Schritts auf. Den Schalter für die Bildschirmfreigabe können nur Sie selbst unter Systemeinstellungen → Allgemein → Freigabe aktivieren. Nach der Einrichtung erscheinen der Link und „Bildschirmlink kopieren“.
- **Version und Updates**: „Aktuell vX, neueste vY“. „Nach Updates suchen“ fragt die GitHub-Releases ab; gibt es eine neue Fassung, lädt „Auf vY aktualisieren“ das ZIP für die passende Architektur herunter, ersetzt `/Applications/Dispatch.app`, entfernt die Quarantänemarkierung und startet neu, wobei Berechtigungen und Anmeldungen erhalten bleiben. Die Webfassung kann die Version nur anzeigen. In der Befehlszeile `dispatch update check|apply [--no-relaunch]`.
- **Ersteinrichtung**: „Ersteinrichtung öffnen“ ruft den Assistenten mit seinen sechs Schritten erneut auf; jeder Schritt lässt sich wiederholen.
- **Rechner**: jeder Mac aus `~/tasks/.dispatch/hosts.json`, mit Punkt für Erreichbarkeit, Name, „Umbenennen“ (wird an alle bekannten Rechner verteilt), „Erneut prüfen“ (leert den Zwischenspeicher und prüft erneut per SSH) und „Löschen“ (zweimal klicken; danach versucht dieser Mac keine Verbindung mehr). „Weiteren Mac verbinden …“ öffnet die Ersteinrichtung.

## Unten

„Sichern“ und „Zurücksetzen“. Die Werte liegen auf dem gemeinsamen Aufgabenboard und sind auf beiden Macs gleich. Der Rechtsklick auf eine leere Stelle bietet „Nach Updates suchen“.

## Entsprechungen in der Befehlszeile

```sh
dispatch settings                      # alles anzeigen
dispatch settings session_archive_days 60
dispatch settings summary_model claude:haiku
dispatch settings summary_uses '{"session": 0, "project": 0}'
dispatch summarize providers | uses | set-key zhipu
dispatch update check | apply
dispatch screen status | setup
dispatch serve url | qr | host <Rechner>
dispatch hosts [rename <id|local|Name> <neuer Name>]
dispatch init status | run <Schritt>
```
