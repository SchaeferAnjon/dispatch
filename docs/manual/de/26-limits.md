# Bekannte Einschränkungen

> Wozu diese Seite dient: eine ehrliche Liste dessen, was die aktuelle Version (v0.7.34) noch einschränkt. Die Probleme aus der vollständigen Quellcode-Durchsicht vom 17.09.2026 wurden zwischen v0.7.29 und v0.7.34 Punkt für Punkt behoben; was behoben wurde, steht am Ende, hier bleibt nur, was weiterhin gilt. Wird mit jeder Version aktualisiert.

## Installation und Verteilung

- **Nur ein Paket für Apple-Silicon.** In den Releases liegt nur `macos-apple-silicon.zip`; auf einem Intel-Mac bauen Sie aus dem Quellcode (`cd app && npm ci && npm run tauri build`, benötigt Node.js, Rust und die Xcode Command Line Tools). Der Updater in der App sagt das auf einem Intel-Mac klar und installiert nie ein Paket für die falsche Architektur.
- **Nicht von Apple notarisiert.** Gatekeeper blockiert den ersten Start; geben Sie ihn einmal frei, wie im [Schnelleinstieg](01-quickstart.md) beschrieben.
- **Benötigt Python 3.9 oder neuer.** Jeder Mac mit den Xcode Command Line Tools oder Homebrew hat es; fehlt beides, zeigt die App die Seite „Umgebungsprüfung“ mit dem, was fehlt, und wie Sie es installieren.

## Funktionsumfang

- **Skills lassen sich nur für Claude Code und Codex einbinden.** pi, ZCode, Gemini CLI und OpenCode zeigen Sitzungen und Aufgaben, der Skill-Pool wird für sie aber nicht eingebunden.
- **Antworten in die Originalsitzung**: Sitzungen in Herdr können alles (Warteschlange, Unterbrechen, Zurückziehen, Tasten). Eine direkt in Ghostty geöffnete Sitzung kann warten lassen und unterbrechen; eine in Terminal.app oder iTerm2 nur warten lassen, nicht unterbrechen (der iTerm2-Weg folgt dessen Skript-Schnittstelle; auf dem Mac des Autors gibt es kein iTerm2, er ist daher ungetestet); eine Sitzung in einer VS-Code-Erweiterung muss zuerst in Herdr übernommen werden.
- **Die Modellnamen in den Auswahllisten stehen in der Oberfläche** (Antwortfeld, Vergeben, Diskutieren); ein neues Modell erscheint erst nach einem App-Update. Ein eigener Modellname lässt sich weiterhin eintippen.
- **Indexgrenzen**: 500 Sitzungen in der lokalen Liste, 200 vom anderen Mac; ältere Einträge zeigen keinen Ungelesen-Status und keinen abgeleiteten Laufstatus.
- **Git-Unterschiede im Arbeitsbereich** können Änderungen anderer Sitzungen enthalten.
- **Anhänge**: Lesbar sind nur Dateien, die in der aktuellen Sitzung ausdrücklich angehängt oder verlinkt wurden, 20 MB pro Bild und 50 MB pro sonstiger Datei; HTML-Ergebnisse mit externen Bibliotheken müssen im eigenen Projekt laufen.
- **„Möglicher Konflikt“ ist eine statische Prüfung**, kein vollständiger semantischer Beweis.
- ChatGPT-Websitzungen sind nicht angebunden; es gibt keine Lesebestätigung der ursprünglichen Agent-App.

## Zwei Macs

- **Der Sync-Port des Hubs (3309) lauscht auf allen Schnittstellen.** Dolts remotesapi lässt sich nicht an eine Adresse binden; geschützt wird er durch das Passwort des Sync-Benutzers. Leiten Sie diesen Port nicht ins Internet weiter.
- Laufen auf den beiden Macs verschiedene Versionen, gehen beim Speichern der Einstellungen auf dem älteren die neueren Einstellungen verloren, die er nicht kennt (etwa die Schalter für Handy-Benachrichtigungen). Beide gemeinsam zu aktualisieren vermeidet das.

## Handy

- QR-Code und Link zum Koppeln tragen ein dauerhaft gültiges Token (gespeichert in `~/tasks/.dispatch/serve.json`; nach einmaligem Scannen merkt es sich das Handy per Cookie): Es wird nur auf der Einstellungsseite gezeigt, posten Sie es nicht öffentlich. Links in Benachrichtigungen verwenden einen Einmal-Code, der 24 Stunden gilt.
- Ohne Tailscale lauscht der Dienst standardmäßig nur auf diesem Mac; mit „LAN zulassen“ erreicht jedes Gerät im selben WLAN Port 7799 (das Token bleibt nötig). In öffentlichen WLANs ausschalten.
- Die Web-Version kann keine Systembenachrichtigungen zeigen; für Pushes braucht es Bark oder ntfy.

## Zwischen v0.7.29 und v0.7.34 behoben (für Leser älterer Hinweise)

- Die CLI läuft mit dem Python 3.9 des Systems; die App sucht selbst einen Interpreter und zeigt bei unvollständiger Umgebung eine Selbstprüfung; fehlt bd / git / herdr oder das Board, gibt es eine lesbare Zeile statt eines Tracebacks.
- Modellnutzung nur nach Ihrer Wahl: In der Ersteinrichtung wählen Sie unter „Modelle & Zusammenfassungen“ aus, das Claude-Code-Abo oder einen API-Schlüssel und haken die einzelnen Verwendungen an; standardmäßig wird nichts gesendet. DeepSeek ist nicht mehr im Code deaktiviert, sondern eine Einstellung.
- Der Handy-Zugriff wird in den Einstellungen mit einem Klick eingeschaltet (der Hintergrunddienst wird mit der App ausgeliefert); für eine Adresse, auf der nichts antwortet, wird kein QR-Code gezeichnet; das Protokoll enthält kein Token und ist nur für Sie lesbar.
- Die Ersteinrichtung überschreibt Ihre Claude-Code-Statuszeile nicht mehr (sie bleibt erhalten und wird weitergereicht) und sichert settings.json vorher; Hooks nutzen absolute Pfade; der Bearbeitungsschutz ist optional und standardmäßig aus; Sie unterschreiben auf dem Board mit dem Benutzernamen dieses Macs.
- Neue Sitzung, Vergeben und Diskutieren wählen standardmäßig einen Agent, den Sie haben, die übrigen sind ausgegraut; die Kontingent-Seite listet nur installierte Agents; Insight-Berichte nutzen das gewählte Zusammenfassungsmodell.
- Wachhalten ist eine Einstellung pro Mac und verhindert standardmäßig nur den Ruhezustand des Systems; Terminal.app / iTerm2 werden unterstützt; der Ort des Skill-Pools passt sich an (der Ordner von cc-switch, sonst `~/.agents/skill-pool`); Befehle an den anderen Mac nutzen dessen eigenen Board-Ordner; auch per LAN gekoppelte Macs markieren umgezogene Sitzungen.
- Der Updater funktioniert an jedem Installationsort, nutzt bei gedrosselter API die öffentliche Download-Adresse und prüft vor der Installation SHA256; jedes ssh, jeder Kindprozess und jede Handy-Anfrage hat ein Zeitlimit; die App läuft als Einzelinstanz, hat eine Content Security Policy, bringt ihre Schriften mit und schreibt kein `__pycache__` mehr in die .app.
- Leistung: `prime` ist schneller; der Arbeitsplatz holt Kommentare nur, wenn sich eine Aufgabe ändert; Insights werden pro Sitzung zwischengespeichert.
- `dispatch env` schreibt zusätzlich `env.sh` für zsh / bash, geheime Dateien werden atomar geschrieben.
