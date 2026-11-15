# Häufige Fragen und Fehlerbehebung

> Worum es auf dieser Seite geht: Jeder Punkt folgt dem Muster Symptom → Ursache → Was zu tun ist. Suchen Sie zuerst mit dem Suchfeld oben auf der Seite nach einem Stichwort aus dem Symptom.

## Die Anwendung öffnet sich leer, oder es erscheint eine rote englische Fehlermeldung

**Symptom**: Der Arbeitsplatz bleibt leer, die Ersteinrichtung erscheint nicht, oder oben auf der Seite steht ein roter englischer Fehler (`SyntaxError`, `bd: command not found`, `no beads database found`).

**Ursache**: Die Logik von Dispatch steckt in einer Python-CLI, die App bringt keinen Interpreter mit. Sie sucht ein Python von Homebrew und danach das des Systems (nötig ist **3.9 oder neuer**); findet sie keines, zeigt sie die Seite „Umgebungsprüfung“. Der andere Fall ist eine fehlende Abhängigkeit (bd, dolt, herdr) oder ein noch nicht angelegtes Board: Dann erscheint oben ein Hinweis mit der Schaltfläche „Ersteinrichtung öffnen“.

**Was zu tun ist**:

1. Sehen Sie auf der Seite „Umgebungsprüfung“ die mit ✗ markierten Punkte an, klicken Sie auf „Installationsbefehl kopieren“, fügen Sie ihn im Terminal ein und klicken Sie danach auf „Erneut prüfen“. Einen bestimmten Interpreter erzwingen Sie vor dem Start mit `DISPATCH_PYTHON=/pfad/zu/python3`. Auf einem ganz neuen Mac ohne Xcode Command Line Tools sind `python3` und `git` des Systems nur Platzhalter; `xcode-select --install` installiert sie.
2. Dispatch neu öffnen und Schritt 1 „Abhängigkeiten installieren“ sowie Schritt 3 „Aufgabenboard“ der Ersteinrichtung durchlaufen.
3. Hilft das nicht, führen Sie im Terminal `python3 /Applications/Dispatch.app/Contents/Resources/cli/dispatch.py init status --json` aus und sehen sich die genaue Fehlermeldung an.

## Sitzungen werden nicht gelesen

**Symptom**: Im Terminal läuft ein Agent nachweislich, aber weder Arbeitsplatz noch Sitzungsseite zeigen ihn; oder die Sitzungsseite hängt bei „Wird indexiert …“.

**Ursache**: Möglicherweise wurde die Sitzung einem anderen Projektnamen zugeordnet, die Aufzeichnungen des Agenten liegen nicht am voreingestellten Ort, der Index muss beim ersten Mal die gesamte Historie lesen, oder die CLI läuft überhaupt nicht (siehe den vorigen Punkt).

**Was zu tun ist**:

- Beim ersten Öffnen muss die gesamte Historie gelesen werden; warten Sie ein bis zwei Minuten. `dispatch index` baut den Index von Hand neu auf.
- Sehen Sie sich Einstellungen → Projekte → Arbeitsbereich-Ordner an: Sitzungen außerhalb dieser Ordner werden nach dem Git-Wurzelverzeichnis oder nach dem Ordner zugeordnet und tauchen womöglich unter „Andere Ordner und nicht zugeordnet“ auf, oder der Projektname ist der Ordnername.
- Setzen Sie auf der Sitzungsseite den Agentenfilter auf „Alle“ und den Modus auf „Zuletzt“; vereinzelte Sitzungen sind unten in der Liste eingeklappt.
- Die Sitzungen von OpenCode, ZCode und Hermes stammen aus deren Datenbanken (`~/.local/share/opencode/opencode.db`, `~/.zcode/cli/db/db.sqlite`, `~/.hermes/state.db`). Läuft der Prozess nicht oder wurde 30 Minuten lang nichts geschrieben, gilt die Sitzung nicht als aktiv, die Historie bleibt aber sichtbar.
- `dispatch list --local -q Stichwort` fragt den Index unmittelbar ab.

## Falscher Sitzungsstatus: hält an, zeigt aber „Läuft“, oder zeigt kein „Wartet auf Sie“

**Symptom**: Der Status in der Sitzungsliste stimmt nicht mit dem überein, was Sie im Terminal sehen; im Arbeitsplatz fehlt „Wartet auf Bestätigung“.

**Ursache**: Die Einschätzung Läuft bzw. Wartet auf Sie stammt aus den Meldungen der Hooks von Claude Code und aus Herdr. Sind keine Hooks eingerichtet (in Schritt 4 der Ersteinrichtung war Claude Code nicht angehakt) oder läuft die Sitzung in Warp, iTerm oder Terminal statt in Herdr, lässt sich der Zustand nur aus dem Schreibzeitpunkt der Transkriptdatei erschließen.

**Was zu tun ist**: Schritt 4 der Ersteinrichtung noch einmal durchlaufen; die Sitzung „In Herdr übernehmen“ (im Kopfbereich der Sitzungsseite oder per Rechtsklick); prüfen, ob Herdr läuft (der Befehl `herdr` ist vorhanden, tmux hält ihn im Hintergrund).

## Die Antwort ist nicht angekommen

**Symptom**: Nach einem Klick auf „Senden“ erscheint „Verbindung vorübergehend nicht verfügbar“, „Nicht bestätigt“ oder „Zustellung unbekannt“, oder Ihre Nachricht taucht im ursprünglichen Terminal nicht auf.

**Ursache**: Zugestellt wird nur an die Ursprungssitzung auf dem gewählten Rechner, und das Herdr-Terminal muss zugleich Sitzungs-ID und Vordergrundprozess treffen; während der Agent etwas ausführt oder auf eine Berechtigungsbestätigung wartet, wird nichts in die Eingabe geschrieben. Die Codex-Desktop-App hängt an der lokalen IPC-Schnittstelle ihrer jeweiligen Fassung; ist diese nicht verträglich oder die Sitzung nicht geöffnet, schlägt es fehl.

**Was zu tun ist**:

- Lesen Sie die Statuszeile über dem Antwortfeld: Sie sagt, wo die Sitzung liegt. Läuft sie in einem anderen Terminal, klicken Sie auf „In Herdr übernehmen und senden“; ist das ursprüngliche Terminal geschlossen, auf „Auf dem Mac fortsetzen und senden“; läuft sie gerade, auf „In Warteschlange senden“ oder „Unterbrechen und senden“.
- Steht sie an einem Bestätigungsdialog, erledigen Sie diesen zuerst mit den Tasten darüber (⏎, y, 1 …).
- „Zustellung prüfen“ fragt die Bestätigung erneut ab; dieselbe Nachricht geht nie zweimal hinaus.
- Bittet die Codex-Desktop-App darum, die Verbindung neu aufzubauen, öffnen Sie die betreffende Sitzung dort und versuchen es erneut.
- Ist das Terminal nicht Ghostty, kann „Zur Sitzung springen“ nur einen Hinweis geben; die Antwort geht dennoch über Herdr.

## Handy verbindet nicht

**Symptom**: Nach dem Scannen erscheint „Keine Verbindung“, oder beim Kopieren des Links auf der Einstellungsseite kommt die Meldung, dass der Webdienst auf jenem Rechner nicht läuft.

**Ursache**: Die Webfassung stellt `dispatch serve` bereit (Port 7799). Der Dienst muss durchgehend laufen; die aktuelle Fassung der .app enthält kein Skript zum Einrichten eines Dauerdienstes, und stellt `serve url` fest, dass der Dienst nicht läuft, meldet es einen Fehler, zeichnet den QR-Code aber trotzdem. Ein anderer häufiger Grund ist, dass das Handy nicht mit Tailscale verbunden ist, oder dass ohne Tailscale auf dem Rechner der Dienst an die LAN-Adresse gebunden ist und das Handy nicht im selben WLAN hängt.

**Was zu tun ist**:

1. Führen Sie im Terminal des Macs `dispatch serve` aus (im Vordergrund, lassen Sie das Fenster offen) und scannen Sie dann erneut.
2. Für einen Dauerbetrieb: Das Skript `app/scripts/serve-setup.sh` im Repository richtet einen launchd-Dienst ein (Bezeichnung `dev.schaefer.dispatch-serve`); es genügt, es einmal aus dem Quellverzeichnis auszuführen. Das ist ein bekannter Verbesserungspunkt, siehe [Bekannte Einschränkungen](26-limits.md).
3. Prüfen Sie am Handy, dass Tailscale verbunden und im selben Tailnet wie der Mac ist; ohne Tailscale muss dasselbe WLAN genutzt werden.
4. Nachdem Sie gewechselt haben, auf welchem Rechner „die Handy-Fassung läuft“, müssen Sie den neuen Link am Handy einmal neu öffnen.
5. Ist ein alter Link ungültig, scannen Sie erneut: Das Token liegt in `~/tasks/.dispatch/serve.json`.

## Keine Mitteilungen auf dem Handy

**Symptom**: Ein Agent hat geantwortet oder wartet auf eine Bestätigung, aber am Handy tut sich nichts.

**Ursache**: Eines von dreien: Es ist kein Kanal eingerichtet (weder `BARK_KEY` noch `NTFY_URL`, dann geht nur eine Systembenachrichtigung am Mac hinaus); `dispatch serve` läuft nicht (die Fälle „Agent hat geantwortet“ und „Wartet auf Bestätigung“ prüft der Dienst alle 20 Sekunden); die App Bark oder ntfy hat keine Benachrichtigungsberechtigung, oder in ntfy ist das Thema nicht abonniert.

**Was zu tun ist**:

1. Einstellungen → Mitteilungen aufs Handy: Prüfen Sie, ob „Aktueller Kanal: ntfy / Bark“ erscheint; fehlt die Zeile, tragen Sie Key oder Themenadresse ein und sichern Sie.
2. Klicken Sie auf „Testmitteilung senden“ oder führen Sie im Terminal `dispatch notify "Test" "Text"` aus: Kommt sie am Handy an, funktioniert der Kanal.
3. Prüfen Sie, dass `dispatch serve` läuft (siehe den vorigen Punkt). `dispatch notify-watch --json` führt einen Lauf von Hand aus und zeigt die Zahl unter `sent` sowie die Gründe unter `skipped`.
4. Prüfen Sie, ob die vier Ereignisschalter an sind. Antworten, die älter als 6 Stunden sind, gehen nicht hinaus; beim ersten Einschalten wird nichts nachgeholt; geplante Sitzungen und Sitzungen auf dem anderen Rechner lösen keine Mitteilung aus.
5. Geben Sie Bark bzw. ntfy in den Systemeinstellungen des Handys die Benachrichtigungsberechtigung; abonnieren Sie in ntfy dasselbe Thema.

## Kontingent leer, „Keine Kontingentdaten verfügbar“ oder veraltete Daten

**Symptom**: Auf der Kontingentseite fehlen die Zahlen eines Agenten, oder es erscheint der Hinweis, dass die Daten älter sind.

**Ursache**: Das Kontingent von Claude Code stammt aus der offiziellen Verbrauchsschnittstelle und erfordert das Lesen der lokalen Anmeldung (die Claude-Code-Zugangsdaten im Schlüsselbund; beim ersten Mal erscheint die Frage, ob python3 auf den Schlüsselbund zugreifen darf, und nach einer Ablehnung lässt sich nichts lesen). Codex und ZCode lesen ihre jeweiligen lokalen Zustandsdateien; ohne Anmeldung oder Installation gibt es nichts. Auch nicht installierte Agenten werden aufgeführt, dann aber ohne Daten.

**Was zu tun ist**: Wählen Sie im Dialog des Schlüsselbunds „Immer erlauben“; vergewissern Sie sich, dass der Agent angemeldet ist und mindestens einmal genutzt wurde; klicken Sie auf „Kontingent aktualisieren“; wollen Sie nur Agenten mit Daten sehen, klappen Sie „Keine Kontingentdaten“ ein. Weichen die Zahlen auf beiden Rechnern voneinander ab, lesen Sie den Hinweis auf der Karte; bei demselben Konto sollten beide Seiten übereinstimmen.

## Keine Zusammenfassung, Fehler zum Key, Einrichten eines Zhipu- oder OpenAI-Keys

**Symptom**: Der „Aktuelle Stand“ eines Projekts bleibt leer, eine Sitzung hat keine Zusammenfassung, die Zusammenfassung einer ungelesenen Antwort unter „Wartet auf mich“ hängt bei „Wird geschrieben …“, oder es erscheint „Key fehlt“ bzw. „Zusammenfassungen sind in den Einstellungen abgeschaltet“.

**Ursache**: Das Modell für Zusammenfassungen kommt aus Einstellungen → Sitzungen → Modell für Zusammenfassungen: Abo-Modelle laufen über das Claude-Code-Abo (der Befehl `claude` muss angemeldet sein), Modelle mit API-Schlüssel nutzen `ZHIPU_API_KEY`, `KIMI_API_KEY`, `MINIMAX_API_KEY` oder `OPENAI_API_KEY` aus `dispatch env`. Ein vorhandener DeepSeek-Schlüssel wird nicht automatisch gewählt (im Code ist das abgeschaltet). Ist der betreffende Zweck in der Tabelle der Verwendungszwecke abgeschaltet, entsteht ebenfalls nichts.

**Was zu tun ist**:

- Wählen Sie in den Einstellungen ein Modell; steht dort „Key fehlt“, fügen Sie den Schlüssel in das Eingabefeld darunter ein und sichern Sie ihn. Im Terminal geht auch `echo "sk-…" | dispatch env set ZHIPU_API_KEY --stdin --note "Zusammenfassungen"`.
- Nutzen Sie bei Zhipu den Coding-Plan-Endpunkt, achten Sie auf den passenden Schlüssel und Endpunkt; der nutzungsabhängige Endpunkt meldet ein unzureichendes Guthaben.
- Prüfen Sie, ob der zugehörige Schalter in der Tabelle der Verwendungszwecke an ist; `dispatch summarize providers` zeigt, was verfügbar ist, und `dispatch session-summary run <key> --force` führt einen Lauf von Hand aus und nennt den Fehler.

## Update schlägt fehl

**Symptom**: „Nach Updates suchen“ meldet einen Fehler, oder nach „Auf vX aktualisieren“ erscheint eine Fehlermeldung.

**Ursache**: Die GitHub-Schnittstelle drosselt die Anfragen oder das Netz ist nicht erreichbar; der Updater ersetzt nur `/Applications/Dispatch.app`, eine anderswo installierte Fassung gilt als nicht installiert; scheitert nach dem Ersetzen der Neustart des Webdienstes, wird das als fehlgeschlagenes Update gemeldet (die Anwendung ist dann tatsächlich schon ausgetauscht); für Intel-Rechner gibt es kein passendes Paket.

**Was zu tun ist**: Später erneut versuchen oder das ZIP unter [Releases](https://github.com/SchaeferAnjon/dispatch/releases) von Hand herunterladen und darüber kopieren; die Anwendung gehört nach `/Applications`; sehen Sie nach einer Fehlermeldung auf die Versionsnummer in den Einstellungen, denn wenn dort schon die neue Fassung steht, ist alles in Ordnung. Im Terminal zeigt `dispatch update check --json` den genauen Fehler.

## Gatekeeper: „Kann nicht geöffnet werden, da der Entwickler nicht überprüft werden kann“

**Symptom**: Das erste Öffnen wird blockiert.

**Ursache**: Das Paket trägt weder eine Apple-Entwicklersignatur noch eine Notarisierung.

**Was zu tun ist**: `xattr -dr com.apple.quarantine /Applications/Dispatch.app`, oder Systemeinstellungen → Datenschutz & Sicherheit → „Dennoch öffnen“. Nach jedem Update von Hand kann das erneut nötig sein (ein Update aus der Anwendung heraus entfernt die Quarantänemarkierung selbst). Nach dem ersten Lauf der CLI entsteht in der .app ein `__pycache__`; dadurch meldet `codesign --verify` einen Fehler, was den Betrieb aber nicht stört, nur können Berechtigungen für Automatisierung, Mitteilungen und dergleichen noch einmal abgefragt werden.

## Herdr läuft nicht

**Symptom**: Vergeben, neue Sitzung, „In Herdr übernehmen“ und die Terminal-Schaltflächen melden Fehler; „Wartet auf Bestätigung“ erscheint nicht.

**Ursache**: Herdr braucht eine dauerhafte tmux-Sitzung; tmux fehlt, läuft nicht, oder Schritt 1 der Ersteinrichtung ist fehlgeschlagen.

**Was zu tun ist**: `brew install herdr tmux`; Schritt 1 und Schritt 4 der Ersteinrichtung erneut durchlaufen (Schritt 4 prüft, ob Herdr läuft, und nennt das Ergebnis); im Terminal mit `herdr` prüfen, ob sich die Tabs auflisten lassen. Ein automatischer Wechsel in die Terminal-Anwendung funktioniert nur bei Ghostty; andere Terminals lassen sich nutzen, nur gibt „Zur Sitzung springen“ dann bloß einen Hinweis.

## Zwei Macs synchronisieren nicht

**Symptom**: Nach dem Beitritt stimmen die Aufgaben nicht überein, der Abgleich alle 2 Minuten in beide Richtungen bleibt aus, eine Verschiebung hängt bei „Vorprüfung“, oder der andere Rechner ist dauerhaft „vorübergehend nicht erreichbar“.

**Ursache**: SSH kommt nicht durch (die entfernte Anmeldung ist nicht aktiviert, der öffentliche Schlüssel fehlt, Tailscale ist offline oder der Rechner schläft); der Port der Dolt-Fernschnittstelle ist nicht erreichbar; beide Seiten haben dieselbe Aufgabe gleichzeitig geändert, was einen Konflikt ergibt; die Vorprüfung der Verschiebung hat einen Git-Konflikt gefunden.

**Was zu tun ist**:

1. Prüfen Sie auf dem Hub, dass unter Systemeinstellungen → Allgemein → Freigabe die entfernte Anmeldung aktiviert ist, und dass Tailscale auf beiden Seiten online ist. Im Terminal sollte `ssh Benutzername@Adresse echo ok` ohne Kennwort antworten.
2. Einstellungen → Rechner → „Erneut prüfen“; in Schritt 3 der Ersteinrichtung die Rückverbindung mit „Jetzt prüfen“ testen.
3. `dispatch rules status` und `dispatch init status --json` zeigen den Zustand von Board und Regeln; auf einem Einzelrechner beendet sich `rules sync` mit dem Hinweis, dass kein Abgleich nötig ist, was kein Fehler ist.
4. Gibt es bei einer Verschiebung Konflikte, übernehmen oder stashen Sie zuerst auf beiden Seiten und verschieben danach; wollen Sie die Gegenseite ausdrücklich überschreiben, nutzen Sie `--force`.
5. Wird die Sitzung nach einer Verschiebung auf dem anderen Rechner nicht als „verschoben nach“ gekennzeichnet: Bei einem Beitritt über das LAN (ohne Tailscale) geschieht das nicht automatisch, nutzen Sie von Hand `dispatch moves mark <id> --to <Rechner>`.

## Nach dem Abgleich der Regeln ändert sich beim Agenten nichts

**Symptom**: Sie haben GLOBAL.md geändert und abgeglichen, aber eine laufende Sitzung hält sich weiter an die alten Regeln.

**Ursache**: Eine Regeländerung lädt bestehende Sitzungen nicht neu.

**Was zu tun ist**: eine neue Sitzung öffnen; mit `dispatch rules status` prüfen, dass der verwaltete Block jeder Einstiegsdatei aktualisiert ist.

## Falscher Projektname, oder ein Projekt zerfällt in zwei

**Symptom**: Derselbe Code steht unter zwei Projektnamen, oder der Projektname ist ein Stück des Pfads.

**Ursache**: Die Zuordnung folgt festen Regeln: manuelle Zuordnung > Benutzerordner > direkte Unterordner der Arbeitsbereich-Ordner > ein im Pfad vorkommender, dem Aufgabenboard bekannter Projektname > Git-Wurzelverzeichnis > Ordnername. Eine in einem Unterverzeichnis geöffnete Sitzung kann dem Namen des Unterverzeichnisses zugeordnet werden.

**Was zu tun ist**: Nehmen Sie den übergeordneten Ordner des Codes in die Arbeitsbereich-Ordner auf; ordnen Sie bestehende Sitzungen per Rechtsklick über „Projekt zuordnen …“ von Hand zu; Aufgaben werden über die Marke `project:<Name>` zugeordnet. Ein geänderter Anzeigename wirkt sich auf die Zuordnung nicht aus.

## Bearbeitung abgelehnt: „Eine andere Sitzung hat diese Datei in den letzten 30 Minuten geändert“

**Symptom**: In Claude Code lehnt ein Hook die Änderung einer Datei ab.

**Ursache**: Der Hook gegen gleichzeitiges Bearbeiten (in Schritt 4 der Ersteinrichtung eingerichtet) lehnt ab, wenn dieselbe Datei innerhalb von 30 Minuten von einer anderen Sitzung geändert wurde, damit sich zwei Agenten nicht gegenseitig überschreiben. Auch ein `/clear` auf einem Einzelrechner oder das Öffnen eines zweiten Fensters löst ihn einmal aus.

**Was zu tun ist**: `dispatch editing` zeigt, wer gerade ändert; ist niemand dabei, versuchen Sie es erneut oder warten Sie kurz. Wollen Sie diesen Schutz nicht, entfernen Sie die beiden edit-guard-Einträge aus den hooks in `~/.claude/settings.json`.

## Der Bildschirm eines Tischrechners geht nicht mehr in den Ruhezustand

**Symptom**: Auf einem Mac mini oder iMac sperrt sich der Bildschirm nach der Installation von Dispatch nicht mehr von selbst.

**Ursache**: Auf Rechnern ohne Batterie verhindert Dispatch mit `caffeinate` den Ruhezustand; einen Schalter dafür gibt es derzeit nicht.

**Was zu tun ist**: Beenden Sie Dispatch, wenn Sie es nicht brauchen; siehe [Bekannte Einschränkungen](26-limits.md).
