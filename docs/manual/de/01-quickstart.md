# In fünf Minuten startklar

> Worum es auf dieser Seite geht: der vollständige Weg vom Download bis zum ersten sichtbaren Projekt, einschließlich der Freigabe durch Gatekeeper, der sechs Schritte der Ersteinrichtung und der drei Dinge, die Sie nach dem ersten Blick auf den Arbeitsplatz zuerst erledigen.

## 0. Voraussetzungen

- Ein Mac mit macOS 14 oder neuer.
- [Homebrew](https://brew.sh): Die Ersteinrichtung installiert damit Dolt, Beads, Herdr und tmux. Fehlt Homebrew, zeigt Schritt 1 der Ersteinrichtung den Installationsbefehl an.
- **Python 3.12 oder neuer**, und `python3` im Terminal muss darauf zeigen (jedes über Homebrew installierte `python@3.12` oder höher genügt). Die Logik von Dispatch steckt in einer Python-CLI, die Anwendung bringt selbst keinen Interpreter mit; die von macOS mitgelieferte Version 3.9 reicht nicht, die Oberfläche bleibt dann leer. Prüfen Sie es im Terminal mit `python3 --version`.
- Mindestens ein installierter Agent (Claude Code, Codex, pi, ZCode, Gemini CLI, OpenCode oder Hermes), der auf diesem Rechner schon ein- bis zweimal gelaufen ist, damit Dispatch beim ersten Start etwas anzeigen kann.

## 1. Installation

1. Laden Sie unter [Releases](https://github.com/SchaeferAnjon/dispatch/releases/latest) die Datei `Dispatch-<Version>-macos-apple-silicon.zip` herunter (derzeit wird nur ein Paket für Apple-Silicon veröffentlicht; auf Intel-Rechnern müssen Sie selbst aus dem Quellcode bauen, siehe [Bekannte Einschränkungen](26-limits.md)).
2. Entpacken Sie das Archiv per Doppelklick und ziehen Sie **Dispatch.app** in den Ordner „Programme“.
3. Das Paket trägt keine Apple-Entwicklersignatur, deshalb hält Gatekeeper es beim ersten Öffnen auf. Wählen Sie eine der beiden Freigaben:
   - Öffnen Sie das Terminal und fügen Sie ein:
     ```sh
     xattr -dr com.apple.quarantine /Applications/Dispatch.app
     ```
     Danach öffnen Sie die Anwendung erneut.
   - Oder versuchen Sie einmal per Doppelklick zu öffnen, lassen Sie sich blockieren, gehen dann in Systemeinstellungen → Datenschutz & Sicherheit, scrollen ganz nach unten und klicken auf „Dennoch öffnen“.
4. Nach dem Öffnen startet automatisch die **Ersteinrichtung**.

## 2. Ersteinrichtung (sechs Schritte)

Beim ersten Öffnen läuft sie einmal durch. Jeder Schritt lässt sich wiederholen; über „Überspringen und nicht mehr fragen“ rechts oben gelangen Sie vorab zum Arbeitsplatz und später über Einstellungen → Ersteinrichtung → „Ersteinrichtung öffnen“ wieder zurück. Oben auf der Seite stehen der Name dieses Rechners und seine Tailscale- oder LAN-Adresse.

### Schritt 1: Abhängigkeiten installieren

Die Seite listet sechs Dinge auf, gefundene mit ✓, fehlende mit ✗:

| Name | Zweck | Erforderlich |
|:--|:--|:--|
| brew | Paketverwaltung für macOS, über die alles Folgende installiert wird | ja |
| dolt | Datenbank des Aufgabenboards (mit Versionshistorie, abgleichbar zwischen zwei Rechnern) | ja |
| bd | das Aufgabenboard selbst (Beads), damit führt der Agent seine Aufgaben | ja |
| herdr | Multiplexer für Agenten im Terminal, über den Dispatch Aufgaben an Agenten vergibt | ja |
| tmux | hält Herdr im Hintergrund am Laufen, damit Dispatch jederzeit Aufgaben vergeben kann | ja |
| tailscale | gegenseitiger Zugriff, wenn beide Rechner nicht im selben WLAN sind; bei nur einem Rechner verzichtbar | nein |

- Fehlt Homebrew, zeigt die Seite eine Zeile mit dem Installationsbefehl und eine Schaltfläche zum Kopieren: im Terminal einfügen und ausführen (das Administratorkennwort wird abgefragt), danach zurückkommen und auf „Erneut prüfen“ klicken.
- Ist Homebrew vorhanden, klicken Sie auf „dolt, bd, herdr … installieren“. Dispatch installiert sie nacheinander über brew, was einige Minuten dauern kann. Bei Fehlschlägen werden der Grund und der Befehl angezeigt, den Sie von Hand im Terminal ausführen können.

### Schritt 2: Befehl im Terminal

Klicken Sie auf „Befehl dispatch anlegen“, damit die mitgelieferte CLI nach `~/.local/bin/dispatch` verlinkt wird. Danach genügt im Terminal der Aufruf `dispatch`; auch die Hooks der Agenten stützen sich darauf, und bei einem Update der Anwendung wird die CLI mit aktualisiert.

Von Hand geht es ebenso:

```sh
ln -sf /Applications/Dispatch.app/Contents/Resources/cli/dispatch.py ~/.local/bin/dispatch
```

Vergewissern Sie sich, dass `~/.local/bin` in Ihrem PATH liegt.

### Schritt 3: Aufgabenboard

Eines von beiden:

- **„Nur dieser eine Rechner, oder dies ist der erste“**: Klicken Sie auf „Aufgabenboard anlegen“, um unter `~/tasks/.beads` ein neues Board anzulegen. Dieser Rechner wird damit zum **Hub**, dem andere Rechner beitreten.
- **„Auf einem Rechner ist Dispatch bereits installiert“**: Tragen Sie dessen `Benutzername@Adresse` ein (Sie können einen Rechner aus der Tailscale-Liste wählen und den Benutzernamen ergänzen), geben Sie einmalig das Anmeldekennwort jenes Rechners ein (es wird nur einmal verwendet, nicht gespeichert, und dient dem Hinterlegen des öffentlichen Schlüssels) und klicken Sie auf „Verbinden und beitreten“. Voraussetzung ist, dass dort die Ersteinrichtung schon gelaufen ist und die „Entfernte Anmeldung“ aktiviert wurde. Wenn Sie kein Kennwort eingeben möchten, klicken Sie auf „Den lokalen Agenten machen lassen“: Dispatch startet einen Agenten, der das im Terminal für Sie erledigt.

Nach dem Beitritt zeigt die Seite „Verbunden mit &lt;Name&gt;, Abgleich in beide Richtungen alle 2 Minuten“ an, und Sie können einmal prüfen lassen, ob der Hub den Weg zurück zu diesem Rechner findet (das braucht der Hub, um die Sitzungen dieses Rechners zusammenzuführen).

### Schritt 4: Agenten

Die Seite prüft, welche Agenten lokal installiert sind, und hakt die gefundenen vorab an. Die angehakten Agenten erhalten denselben Regelsatz; bei Claude Code werden zusätzlich Hooks eingerichtet (Sitzungsstatus, Zusammenfassung des Aufgabenboards, Sperre gegen gleichzeitiges Bearbeiten, Kontingent). Die Erweiterungen Claude Code und Codex in VS Code nutzen dieselben Aufzeichnungen und dieselben Hooks; es genügt, den entsprechenden Agenten anzuhaken, ihre Sitzungen werden als „VS Code“ gekennzeichnet. Klicken Sie auf „Diese verwenden“.

### Schritt 5: Regeln und Skills

Klicken Sie auf „Regeln vorbereiten und abgleichen“:

- Gibt es noch keine gemeinsamen Regeln, wird eine vorhandene `CLAUDE.md` oder `AGENTS.md` als Ausgangspunkt übernommen; andernfalls dient eine knappe Vorlage als Grundlage. Geschrieben wird nach `~/.agents/rules/GLOBAL.md`.
- Sind Sie einem Hub beigetreten, werden GLOBAL.md und der Skill-Pool vom Hub kopiert.
- Anschließend wird GLOBAL.md in die Einstiegsdatei jedes Agenten abgeglichen (als verwalteter Block), und der Skill-Pool wird in die Skill-Verzeichnisse von Claude Code und Codex eingehängt.

Die Seite listet für jeden Agenten den Pfad der Einstiegsdatei und den Abgleichstatus auf.

### Schritt 6: Prüfen und verbessern (optional)

Wählen Sie einen Agenten mit Befehlszeile und klicken Sie auf „Prüfen und verbessern lassen“: Er liest alle Regeln und Skills, die sich die Agenten auf diesem Rechner teilen, räumt zuerst auf (entfernt Verhaltensregeln, die nur ältere Modelle brauchten, Schritt-für-Schritt-Rezepte und Dopplungen zu den globalen Regeln), behält Architekturvorgaben, Sicherheitsgrenzen und Projektwissen, ändert das Ergebnis direkt und gleicht es ab. Alternativ kopieren Sie über „Prompt kopieren“ den Text und geben ihn einem beliebigen Agenten. Auch bei nur einem Rechner lohnt sich das einmal.

Erst wenn die ersten fünf Schritte abgehakt sind, wird unten die Schaltfläche „Fertig“ anklickbar, die Sie zum Arbeitsplatz bringt.

## 3. Die drei Dinge nach dem ersten Blick auf den Arbeitsplatz

1. **Eine Sitzung öffnen und zusehen, wie sie auf dem Tisch erscheint.** Starten Sie im Terminal wie gewohnt Claude Code oder Codex (oder drücken Sie in Dispatch <kbd>⌘N</kbd> für „Neue Sitzung“ und wählen einen Ordner). Zurück im Arbeitsplatz von Dispatch erscheint diese Sitzung binnen Sekunden auf der Karte des passenden Projekts unter „Läuft“; sobald der Agent anhält und auf Sie wartet, wechselt sie zu „Wartet auf Sie“. Zu Beginn jeder neuen Sitzung erhält der Agent eine über `dispatch prime` eingespielte Zusammenfassung; so erfährt er vom Aufgabenboard und von der Wissensbasis.
2. **Die Projektzuordnung prüfen.** Öffnen Sie Einstellungen → Projekte → „Arbeitsbereich-Ordner“, voreingestellt ist `~/Projects`: Jeder direkte Unterordner dieser Ordner gilt als eigenes Projekt. Liegt Ihr Code woanders, tragen Sie den Wurzelordner dort ein (einen pro Zeile). Sonst werden Sitzungen nach dem Wurzelverzeichnis des Git-Repositorys oder nach ihrem Ordner zugeordnet, und der Projektname ist möglicherweise nicht der gewünschte.
3. **Entscheiden, ob Zusammenfassungen laufen sollen.** Einstellungen → Sitzungen → „Modell für Zusammenfassungen“: Wählen Sie ein Abomodell (etwa haiku aus dem Claude-Code-Abo) oder fügen Sie einen API-Schlüssel ein. Die Tabelle darunter entscheidet für jeden Zweck einzeln, ob „Sitzungszusammenfassung“, „Aktueller Projektstand“ und so weiter ein Modell aufrufen dürfen. Wenn nichts den Rechner verlassen soll, schalten Sie alle Zwecke ab. Näheres unter [Einstellungen](14-settings.md).

Und werfen Sie gleich noch einen Blick auf:

- „Übersicht“ ganz unten in der Seitenleiste: ein Satz zu jeder Seite, von dort kommen Sie direkt hin.
- Einstellungen → Zugriff vom Handy: Wenn Sie das Handy nutzen möchten, scannen Sie diesen QR-Code, siehe [Handy](20-phone.md).
- Bei einem zweiten Mac siehe [Zwei Macs](21-two-macs.md).
