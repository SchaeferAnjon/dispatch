# Zwei Macs

> Worum es auf dieser Seite geht: wie der zweite Mac beitritt, was abgeglichen wird, wie Projekte und Sitzungen auf den anderen Rechner wandern, wie Sie nach Rechner filtern und wie sich das Ganze verhält, wenn ein Rechner nicht erreichbar ist.

## Beitreten

Der erste Rechner ist nach der Ersteinrichtung der **Hub**: Aufgabenboard (die Dolt-Datenbank), Regeln und Skills liegen auf ihm. Für den zweiten Rechner:

1. Aktivieren Sie auf dem Hub unter Systemeinstellungen → Allgemein → Freigabe die **Entfernte Anmeldung** (der Beitritt braucht SSH).
2. Installieren Sie Dispatch auf dem zweiten Rechner, wählen Sie in Schritt 3 der Ersteinrichtung „Auf einem Rechner ist Dispatch bereits installiert“ und tragen Sie `Benutzername@Adresse` des Hubs ein: im selben WLAN die LAN-IP, unterwegs die Tailscale-Adresse (auf der Seite lässt sich ein Rechner aus der Tailscale-Liste wählen). Unter Einstellungen → Rechner können Sie ebenso auf „Weiteren Mac verbinden …“ klicken.
3. Geben Sie einmalig das Anmeldekennwort des Hubs ein (nur einmal verwendet, nicht gespeichert). Dispatch legt den öffentlichen Schlüssel dieses Rechners dort ab, danach geht der Zugriff in beide Richtungen ohne Kennwort. Wenn Sie kein Kennwort eingeben möchten, klicken Sie auf „Den lokalen Agenten machen lassen“, dann erledigt ein Agent das im Terminal.
4. Klicken Sie auf „Verbinden und beitreten“. Nach dem Beitritt zeigt die Seite „Verbunden mit &lt;Name&gt;, Abgleich in beide Richtungen alle 2 Minuten“.
5. „Jetzt prüfen“ prüft, ob der Hub den Weg zurück zu diesem Rechner findet (das braucht der Hub, um die Sitzungen dieses Rechners zusammenzuführen). Schlägt es fehl, sagt die Seite, wo Sie die entfernte Anmeldung aktivieren müssen.

Haben Sie lokal bereits ein Board und wollen stattdessen beitreten, wählen Sie in Schritt 3 „Auf das Aufgabenboard eines anderen Rechners wechseln …“. Das lokale Board wird angehalten und unter neuem Namen aufbewahrt (`~/tasks/.beads.retired-DATUM`), nicht gelöscht.

## Was abgeglichen wird

| Inhalt | Verfahren |
|:--|:--|
| Aufgabenboard (Aufgaben, Ergebnisse, Wissensbasis, Einstellungen, Favoriten- und Archivzustand von Projekten) | alle 2 Minuten in beide Richtungen (Dolt-Fernschnittstelle) |
| gemeinsame Regeln GLOBAL.md, FACTS.md, PROFILE.md | `dispatch rules push\|pull\|auto`, der Zeitgeber der Anwendung gleicht jede halbe Stunde ab |
| Skill-Pool | in Schritt 5 der Ersteinrichtung vom Hub kopiert; danach über die Befehle der Reihe `dispatch rules` |
| Sitzungsaufzeichnungen | werden nicht kopiert. Jede bleibt auf ihrem Rechner, und Dispatch liest Liste und Einzelheiten des anderen Rechners über SSH (die entfernte Liste umfasst höchstens 200 Einträge) |
| Schlüssel (dispatch env) | werden nicht abgeglichen, jeder Rechner wird eigens eingerichtet |
| Sendebestätigungen, Handy-Token | werden nicht abgeglichen |

Oben in der Seitenleiste erscheint „Alle / Rechner A / Rechner B“: Wählen Sie einen Rechner, folgen ihm Aufgaben, Sitzungen, Kontingent und Statistik; „Alle“ führt beide zusammen. Am Handy gibt es oben dieselbe Auswahl. Über die Rechnerleiste oben auf der Seite „Agent-Status“ vergeben Sie Aufgaben und sehen Bildschirme an.

## Ein Projekt verschieben

Über „Nach &lt;Rechner&gt; verschieben“ im Kopf der Projektseite:

1. **Vorprüfung**: Unterschiede in Git und Dateien sowie fehlende Werkzeuge; bei Konflikten wird abgelehnt (nur `--force` überschreibt die Änderungen der Gegenseite).
2. Nach der Bestätigung wandern das Verzeichnis (samt nicht übernommener Änderungen), die Git-Historie, die laufenden Sitzungen und alle Aufzeichnungen hinüber, und dort geht es unmittelbar weiter.
3. Das Verschieben läuft im Hintergrund, und auf der Projektkarte sowie auf der Projektseite steht ein Fortschrittsbalken (ein Seitenwechsel oder eine Aktualisierung geht nicht verloren); `dispatch project-moves` zeigt den Fortschritt.
4. Danach ist der „zugehörige Rechner“ des Projekts der andere, und neue Sitzungen öffnen sich vorab dort.

In der Befehlszeile:

```sh
dispatch project <Projektname> --move-to <Rechner-ID oder Name> [--dry-run] [--background] [--keep-original]
dispatch project <Projektname> --owner <Rechner|local|none>     # nur die Zugehörigkeit vermerken, ohne Dateien zu verschieben
```

## Eine einzelne Sitzung verschieben

Rechtsklick auf die Sitzung → „Nach &lt;Rechnername&gt; verschieben und dort weiterarbeiten“, oder:

```sh
dispatch move <Anfang der Sitzungs-ID> --to <Rechner> [--prompt "zusätzlicher Hinweis"] [--no-files] [--dry-run]
```

Nachdem die Gegenseite übernommen hat, steht die Sitzung auf beiden Seiten in der Liste: die ursprüngliche mit „verschoben nach &lt;Rechner&gt;“, die neue mit „verschoben von &lt;Rechner&gt;“. Die Ursprungssitzung wird vorab angehalten (mit `--keep-original` nicht). Unterstützt werden Claude Code und Codex; die Sitzungen von pi liegen in einer eigenen Datenbank und lassen sich vorerst nicht verschieben. `dispatch resume <id> --on <Rechner>` legt fest, auf welchem Rechner fortgesetzt wird.

## Verhalten bei fehlender Verbindung

- Oben im Arbeitsplatz steht „&lt;Rechner&gt; vorübergehend nicht erreichbar“, und die bereits gelesenen Aufzeichnungen bleiben erhalten. Öffnen Sie eine Sitzung des anderen Rechners, erscheint der Hinweis „Diese Sitzung liegt auf &lt;Rechner&gt;; dieser Mac ist gerade nicht erreichbar (sein Tailscale ist offline oder er schläft). Sobald er wieder online ist, wird sie automatisch gelesen“.
- In der Auswahlliste des ausführenden Rechners beim Anlegen einer neuen Sitzung sind nicht erreichbare Rechner nicht wählbar; wählen Sie auf einer Konfigurationsseite (Skills, Regeln, Notizen) einen nicht erreichbaren Rechner, wird der Grund angezeigt („Tailscale ist auf diesem Mac nicht aktiv“ oder „&lt;Rechner&gt; ist offline“).
- Aufgabenboard: Jede Seite lässt sich lokal lesen und beschreiben, und nach dem Verbinden wird in beide Richtungen zusammengeführt. Wird dieselbe Aufgabe auf beiden Seiten geändert, kann ein Dolt-Konflikt entstehen, siehe [Fehlerbehebung](24-troubleshooting.md#zwei-macs-synchronisieren-nicht).
- Kontingent: Ein Konto teilt sich sein Kontingent über beide Rechner, es summiert sich nicht; ist ein Datensatz veraltet, weist die Karte darauf hin.

## Rechner verwalten

Einstellungen → Rechner: umbenennen (wird an alle bekannten Rechner verteilt), erneut prüfen, löschen. `dispatch hosts` listet diesen und die anderen Rechner auf, dazu die Art des virtuellen Netzes, die Möglichkeiten zum Fernzugriff und den empfohlenen Weg; `dispatch hosts rename <id|local|Name> <neuer Name>`. `dispatch --host <id> <beliebiger Unterbefehl>` führt einen Befehl auf dem anderen Rechner aus.
