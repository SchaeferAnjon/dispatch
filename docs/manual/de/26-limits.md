# Bekannte Einschränkungen

> Worum es auf dieser Seite geht: eine ehrliche Liste der bekannten Fallstricke der aktuellen Version (v0.7.29), zusammengetragen aus der Durchsicht des Quellcodes. Wer sie vor der Installation einmal liest, spart sich einige Zeit bei der Fehlersuche. Die Liste wird mit den Versionen fortgeschrieben.

## Was neue Benutzer aufhält

- **Python 3.12 oder neuer ist zwingend, aber die Anwendung prüft und installiert es nicht.** Die Anwendung ruft das `python3` aus dem PATH auf; die von macOS mitgelieferte Version 3.9 scheitert an zwei Stellen der CLI unmittelbar mit einem Syntaxfehler, der Assistent der Ersteinrichtung erscheint nicht, und Sie sehen einen leeren Arbeitsplatz. Abhilfe: `brew install python@3.12` oder neuer, siehe [Fehlerbehebung](24-troubleshooting.md).
- **Es gibt nur ein Paket für Apple-Silicon.** README und Website erwähnen ein Intel-Paket, in den Releases liegt derzeit aber nur `macos-apple-silicon.zip`; auf Intel-Rechnern muss aus dem Quellcode gebaut werden (`cd app && npm ci && npm run tauri build`, dazu braucht es Node 20.19+ bzw. 22.12+, Rust, die Xcode-Befehlszeilenwerkzeuge und Python 3.12+). Findet das Update in der Anwendung keine passende Architektur, lädt es möglicherweise das falsche Paket.
- **Fehlen Abhängigkeiten, gibt es einen nackten Traceback statt eines lesbaren Hinweises.** Sind bd, git oder herdr nicht im PATH, werfen einige Befehle unmittelbar eine Python-Ausnahme; ohne Aufgabenboard schlägt `dispatch prime` fehl und zeigt zu Beginn jeder Claude-Code-Sitzung eine englische bd-Fehlermeldung. Schritt 1 und Schritt 3 der Ersteinrichtung vermeiden das.
- **Der Zugriff vom Handy setzt ein laufendes `dispatch serve` voraus, doch das Skript zum Einrichten eines Dauerdienstes ist nicht in der .app enthalten.** Die Einstellungsseite zeichnet den QR-Code dennoch. Als Behelf: im Terminal `dispatch serve` im Vordergrund ausführen, oder aus dem Quellverzeichnis `app/scripts/serve-setup.sh` starten.

## Zur Aussage, es werde nichts an ein Modell gesendet

Website und README sagen, es würden standardmäßig weder Ihre Dokumente noch Ihre Gespräche an ein Modell gesendet. Diese Aussage trifft auf die aktuelle Version **nicht zu**:

- Die automatische Sitzungszusammenfassung ist standardmäßig an (alle 3 Minuten werden ein bis zwei Abschnitte zusammengefasst, und ältere Sitzungen werden nach und nach nachgeholt), und die acht Punkte der Tabelle der Verwendungszwecke (Sitzungszusammenfassung, aktueller Projektstand, dispatch here, Ergebnis einer Diskussion, Analysebericht, Zusammenfassung der Notizen, Bestandsaufnahme der Geräte, Index für die semantische Suche) sind alle standardmäßig aktiv.
- Liegt kein einziger API-Schlüssel vor, genügt ein installiertes Claude Code, damit die Zusammenfassung über Ihr Claude-Code-Abo mit `claude -p` läuft.
- Das Öffnen der Seite „Agent-Notizen“, des Reiters „Rückblick“ eines Projekts und der Aufgabendetails (semantische Suche) löst ohne Rückfrage eine Anfrage aus.

Soll wirklich nichts den Rechner verlassen: Einstellungen → Sitzungen → alle Punkte der Tabelle der Verwendungszwecke abschalten, „Modell für Zusammenfassungen“ leer lassen und keinen Schlüssel hinterlegen.

## Abweichungen zwischen Oberflächentext und Umsetzung

- Das beim „Zugriff vom Handy“ genannte einmalige Anmeldetoken ist in Wirklichkeit ein dauerhaft gültiges statisches Token nebst einem Cookie mit einem Jahr Laufzeit; das Token liegt in `~/tasks/.dispatch/serve.json`. Geben Sie den Link nicht öffentlich weiter.
- Ohne Tailscale bindet sich der Webdienst an die LAN-Adresse, sodass jedes Gerät im selben WLAN den Port 7799 erreicht (durch das Token geschützt).
- In den Einstellungen gibt es keinen Hauptschalter namens „Automatische Zusammenfassung“, sondern nur die Tabelle der Verwendungszwecke.
- Die README führt DeepSeek als verfügbares Modell für Zusammenfassungen auf, im Code ist es jedoch abgeschaltet (wer nur einen DeepSeek-Schlüssel hat, bekommt keine Zusammenfassungen).
- Der Skill-Pool unterstützt nur die Bereitstellung für Claude Code und Codex; bei pi, ZCode, Gemini und OpenCode wird trotz Häkchen kein Skill bereitgestellt.
- In der Abhängigkeitstabelle von Schritt 1 der Ersteinrichtung steht tmux, in der Abhängigkeitsliste der README fehlt es.

## Für alle, die nur einen Agenten installiert haben

- Bei neuer Sitzung, Vergabe und Diskussion ist Claude Code bzw. Claude der voreingestellte Agent, unabhängig davon, was lokal installiert ist; auch nicht installierte Agenten erscheinen in der Auswahlliste.
- Die Kontingentseite führt alle Agenten auf und zeigt bei nicht installierten „Keine Daten“.
- Der Analysebericht wird fest mit `claude -p` erzeugt, ungeachtet des „Modells für Zusammenfassungen“; ohne installiertes Claude Code erscheint „No such file: claude“.
- Der Helfer für Verschiebungskonflikte ist fest auf pi mit einem GLM-Modell verdrahtet und braucht einen Zhipu-Schlüssel.

## Nebenwirkungen der Hooks von Claude Code

- Schritt 4 der Ersteinrichtung **überschreibt bedingungslos** eine vorhandene `statusLine`-Einstellung in Ihrer `~/.claude/settings.json`, und zwar ohne Sicherung; im Skript der Statuszeile ist die claude-hud-Erweiterung des Autors fest verdrahtet, sodass fremde Statuszeilen leer bleiben können.
- Die Hook-Befehle setzen `~/.local/bin/dispatch` voraus (den Link aus Schritt 2); wer Schritt 2 überspringt, bekommt bei jedem Sitzungsstart eine Fehlermeldung.
- Der Hook gegen gleichzeitiges Bearbeiten wird standardmäßig eingerichtet: Wurde dieselbe Datei innerhalb von 30 Minuten von einer anderen Sitzung geändert, wird abgelehnt; auch ein `/clear` auf einem Einzelrechner oder das Öffnen eines zweiten Fensters wird einmal aufgehalten.
- Selbst mit warmem Zwischenspeicher braucht der prime-Hook einige Sekunden; ist der andere Rechner offline, kann es bis zum SSH-Zeitablauf dauern.

## Sonstiges

- **Der Bildschirm eines Tischrechners geht nie in den Ruhezustand**: Auf Macs ohne Batterie verhindert die dauerhaft laufende Anwendung mit `caffeinate` das Abschalten des Bildschirms, und ein Schalter dafür fehlt.
- **Als Terminal wird nur Ghostty erkannt**: „Zur Sitzung springen“ und der automatische Wechsel beim Antworten in der Ursprungssitzung sind nur für Ghostty umgesetzt; wer iTerm2, Terminal oder Warp nutzt, kann den Weg über Herdr gehen, muss das Fenster aber von Hand wechseln.
- **Der Pfad des Skill-Pools ist fest verdrahtet** auf `~/.cc-switch/skills`.
- **`BEADS_DIR` wirkt nur für einen Teil des lokalen Betriebs**: In den Befehlen für den anderen Rechner und in den Abgleichskripten steht weiterhin fest `~/tasks/.beads`.
- **Nach einer Verschiebung bei einem Beitritt über das LAN (ohne Tailscale)** kennzeichnet die Gegenseite die Sitzung nicht automatisch als verschoben, sodass sie auf beiden Seiten je einmal erscheint.
- **Der Updater** kennt nur `/Applications/Dispatch.app`; der Hinweis in einer Fehlermeldung, das Repository sei privat, ist überholt; nach dem Herunterladen gibt es keine Prüfsumme; scheitert nach dem erfolgreichen Ersetzen der Neustart des Webdienstes, wird das als fehlgeschlagenes Update gemeldet.
- **Signatur**: Das Paket ist mit dem Entwicklerzertifikat des Autors signiert und nicht notarisiert; beim ersten Lauf der CLI wird ein `__pycache__` in die .app geschrieben, was die Signaturprüfung bricht, sodass Berechtigungen wiederholt abgefragt werden können.
- **Leistung**: Der Arbeitsplatz holt alle 10 Sekunden die Kommentare sämtlicher Aufgaben in Arbeit neu; die Aktivitätsprüfung geht alle 3 Sekunden alle Transkripte durch; der Zwischenspeicher der Erkenntnisse wird bei jedem Schreibvorgang einer beliebigen Sitzung vollständig neu berechnet. Bei vielen Sitzungen ist das spürbar.
- **`dispatch env` erzeugt nur die Datei zum automatischen Laden für fish** (`env.fish`); wer zsh oder bash nutzt, braucht `eval "$(dispatch env export)"`.
- **Obergrenzen beim Lesen des Index**: 500 Einträge in der lokalen Sitzungsliste, 200 auf dem anderen Rechner; bei älteren Einträgen werden weder ungelesene Antworten noch ein erschlossener Laufzustand angezeigt.
- **Die Git-Unterschiede des Arbeitsbereichs** können die Änderungen anderer Sitzungen enthalten.
- **Anhänge**: Es lassen sich nur Dateien lesen, die die aktuelle Sitzung ausdrücklich angehängt oder verlinkt hat, je Datei höchstens 20 MB; HTML-Artefakte, die auf externe Bibliotheken angewiesen sind, müssen im ursprünglichen Projekt laufen.
- **„Mögliche Widersprüche“ ist eine statische Prüfung** und kein vollständiger inhaltlicher Nachweis.
- **Die globalen Tastenkürzel lösen auch in Eingabefeldern aus.**
- ChatGPT-Websitzungen werden nicht angebunden; eine Lesebestätigung aus der ursprünglichen Agent-Anwendung ist nicht zu bekommen.
