# Handy

> Worum es auf dieser Seite geht: wie Sie Dispatch am Handy öffnen, was dort geht und was nicht, wie Sie eine nicht laufende Sitzung fortsetzen, wie Sie Tasten senden, wenn ein Bestätigungsdialog blockiert, wie Mitteilungen aufs Handy gelangen und wie Sie den Bildschirm des Rechners sehen.

![Handy-Fassung](../../assets/shot-phone.png)

## Verbindung

Das Handy muss den Mac erreichen können, auf dem Dispatch läuft. Empfohlen ist **Tailscale**: Installieren Sie es auf beiden Seiten und melden Sie sich mit demselben Konto an, dann erreicht das Handy den Rechner aus jedem Netz. Ohne Tailscale bindet sich der Webdienst an die LAN-Adresse und funktioniert nur im selben WLAN. **Geben Sie den Dienst nicht ins offene Internet.**

1. Öffnen Sie am Mac Einstellungen → Dieser Mac → **Zugriff vom Handy**: Dort ist ein QR-Code eingebettet, dessen Link ein Anmeldetoken trägt; einmal scannen genügt, der Browser merkt es sich (Cookie ein Jahr). Sie können den Link auch kopieren und ans Handy schicken oder im Terminal `dispatch serve url` bzw. `dispatch serve qr` ausführen.
2. Öffnen Sie den Link im Browser des Handys; die Oberfläche richtet sich automatisch nach der Breite des Handys, und über „Zum Home-Bildschirm hinzufügen“ nutzen Sie sie wie eine App.
3. Bei zwei Macs lässt sich in den Einstellungen wählen, auf welchem „die Handy-Fassung läuft“: Nehmen Sie den Mac, der stehen bleibt; nach einem Wechsel müssen Sie den neuen Link am Handy einmal neu öffnen.

Die Webfassung stellt `dispatch serve` bereit (Port 7799, Konfiguration in `~/tasks/.dispatch/serve.json`). Lässt sich der Link nicht kopieren oder erscheint nach dem Scannen „Keine Verbindung“, läuft der Dienst nicht: Führen Sie im Terminal des Macs `dispatch serve` im Vordergrund aus oder richten Sie ihn als launchd-Dauerdienst ein, siehe [Fehlerbehebung](24-troubleshooting.md#handy-verbindet-nicht).

## Was geht

Es ist dieselbe Oberfläche: unten vier Reiter (Arbeitsplatz, Projekte, Wartet auf mich, Sitzungen), und unter „Mehr“ finden Sie Alle Aufgaben, Diskussionen, Agent-Status, Statistik & Kontingent, Verlauf, Skills, Regeln & Unterlagen, Wissensbasis, Einstellungen und Übersicht. Oben lässt sich der Rechner wählen.

- Den Stand jedes Projekts ansehen, ebenso den vollständigen Sitzungsverlauf, Werkzeugaufrufe, Dateiänderungen und Bilder.
- **In der Ursprungssitzung antworten**: Das Antwortfeld unten auf der Sitzungsseite entspricht dem am Rechner: in Warteschlange senden, unterbrechen und senden, zurücknehmen, Bild senden (fotografieren oder aus dem Album), das Befehlsmenü mit /, Berechtigungsmodus und Modell umschalten.
- **Neue Sitzung** (über „Neue Sitzung“ im Arbeitsplatz): startet auf einem Mac eine neue Sitzung, mit Bildern und Dateien.
- Aufgaben: ansehen, kommentieren, Abnahmekriterien abhaken, Status ziehen (der Rechtsklick wird zum langen Drücken von etwa einer halben Sekunde).
- „Nur Sie können“ abhaken, Projekte und Sitzungen als Favorit markieren und archivieren, Einstellungen ändern (Sprache, Zusammenfassungen, Tage bis zur Archivierung).
- Kontingent und Statistik ansehen sowie den Analysebericht (der HTML-Bericht öffnet sich am Handy über den Webdienst).

## Was nicht geht

- Die Anwendung aktualisieren: In den Einstellungen sehen Sie nur die Version, das Update erfolgt in Dispatch.app auf dem Mac.
- Mit dem Finder einen Ordner wählen, eine lokale Datei öffnen, im Finder zeigen: Diese Schaltflächen erscheinen in der Webfassung nicht.
- Das „Einrichten“ des Bildschirmzugriffs muss am Mac geschehen (danach können Sie den Bildschirm am Handy ansehen).
- Systembenachrichtigungen einblenden: Der Browser kann sie nicht erzeugen, deshalb brauchen Sie die weiter unten beschriebenen Mitteilungen.

## Fortsetzen, wenn die Sitzung nicht läuft

Öffnen Sie am Handy eine Sitzung, dann sagt die Statuszeile über dem Antwortfeld, wo die Ursprungssitzung gerade liegt:

- **In Herdr und untätig**: einfach senden.
- **In einem anderen Terminal oder in VS Code**: „In Herdr übernehmen und senden“. Dispatch beendet auf dem Rechner den dort untätigen Prozess, setzt dieselbe Sitzung in Herdr mit `--resume` fort und schickt dann Ihre Nachricht hinaus.
- **Das ursprüngliche Terminal ist bereits geschlossen**: „Auf dem Mac fortsetzen und senden“ oder „Diese Sitzung auf dem Mac fortsetzen“. In Herdr auf dem Rechner wird ein neuer Tab geöffnet, der dieselbe Aufzeichnung fortsetzt, und danach geht Ihre Nachricht hinaus. Ein Fingertipp genügt, und niemand muss am Rechner sitzen.
- **Sie läuft gerade**: Sie können „In Warteschlange senden“ oder „Unterbrechen und senden“ wählen.

## Tasten senden, wenn ein Bestätigungsdialog blockiert

Steht der Agent an einem Bestätigungsdialog zu einem vertrauenswürdigen Verzeichnis, zu Berechtigungen, zu einer Hook-Prüfung und dergleichen, erscheinen am Handy über dem Antwortfeld „Wartet auf dem Mac auf eine Bestätigung“ und die letzten 14 Zeilen jenes Bildschirms, darunter eine Reihe Tasten: ↑ ↓ ⏎ Esc y n 1 2 3. Ein Tipp schickt sie unmittelbar an das ursprüngliche Terminal. Ist die Bestätigung erteilt, wird das Antwortfeld von selbst wieder nutzbar.

Die Bestätigungen der Codex-Desktop-App (ein Befehl soll laufen, eine Datei soll geändert werden, eine Berechtigung wird angefragt, eine Frage steht im Raum) erscheinen als Schaltflächen: Erlauben, Für diese Sitzung immer erlauben, Ablehnen, Antworten.

## Mitteilungen aufs Handy

Die Webfassung kann keine Systembenachrichtigungen erzeugen, deshalb laufen die Mitteilungen über eine App auf dem Handy:

- **Bark** (iOS, im App Store kostenlos): nach der Installation der Schlüssel auf der Startseite (oder die vollständige Adresse `https://api.day.app/…`).
- **ntfy** (iOS und Android, kostenlos und quelloffen): Sie abonnieren ein Thema; die Themenadresse lautet etwa `https://ntfy.sh/ihr-thema` (ein eigener Server geht ebenso).

Tragen Sie am Mac unter Einstellungen → **Mitteilungen aufs Handy** den Bark-Key oder die ntfy-Themenadresse ein und klicken Sie auf „Sichern“ (gesichert wird als `BARK_KEY` bzw. `NTFY_URL` in `dispatch env`; sind beide gesetzt, gilt ntfy; „Löschen“ entfernt den Eintrag). Danach folgen die vier Ereignisschalter, alle standardmäßig an:

| Ereignis | Wann gesendet wird | Erläuterung |
|:--|:--|:--|
| Agent hat geantwortet (Runde beendet, noch nicht gesehen) | eine Runde ist zu Ende und die Antwort ist ungelesen | Der Text enthält den Anfang der Antwort, ein Tipp führt direkt in die Sitzung |
| Agent wartet auf Bestätigung oder stellt eine Frage | steht an einer Berechtigungsabfrage oder einer Frage | hohe Priorität |
| Aufgabe erledigt (dispatch done) | wenn ein Agent eine Aufgabe schließt | ein Tipp führt zur Aufgabenseite |
| Nur Sie können es tun (dispatch need-you) | wenn ein Agent etwas festhält, das Sie persönlich erledigen müssen | hohe Priorität |

So arbeitet es:

- Die ersten beiden Fälle prüft der Webdienst (`dispatch serve`) **alle 20 Sekunden**. Die Desktop-Anwendung muss dafür nicht offen sein, aber `dispatch serve` muss laufen. Die letzten beiden Fälle senden die Befehle `dispatch done` und `dispatch need-you` selbst im Augenblick des Geschehens.
- Ein Tipp auf die Mitteilung öffnet unmittelbar die betreffende Sitzung oder Aufgabenseite.
- Beim ersten Einschalten wird nichts nachgeholt: Fehlt die Zustandsdatei `~/tasks/.dispatch/notify-watch.json`, wird nur der aktuelle Stand gemerkt und nichts gesendet.
- Ist kein Kanal eingerichtet, erscheint lediglich eine Systembenachrichtigung dieses Macs (die Desktop-Anwendung zeigt sie selbst an). Antworten, die älter als 6 Stunden sind, werden nicht gesendet, und derselbe Bestätigungsdialog meldet sich nur einmal.
- Zum Testen: „Testmitteilung senden“ oder in der Befehlszeile `dispatch notify "Titel" "Text"`; `dispatch notify-watch --json` führt einen Prüflauf von Hand aus und gibt aus, wie viele Mitteilungen hinausgingen.

Kommen keine Mitteilungen an, siehe [Fehlerbehebung](24-troubleshooting.md#keine-mitteilungen-auf-dem-handy).

## Bildschirm ansehen (noVNC)

Wenn Sie den ganzen Bildschirm des Rechners sehen und einen Dialog anklicken müssen:

1. Am Mac Einstellungen → Bildschirmzugriff → „Einrichten“ (entspricht `dispatch screen setup`): installiert noVNC und websockify als Dauerdienst und richtet Tailscale Serve mit HTTPS ein. Die Seite listet das Ergebnis jedes Schritts auf und nennt, was noch fehlt.
2. Aktivieren Sie unter Systemeinstellungen → Allgemein → Freigabe die „Bildschirmfreigabe“ (diesen Schritt können nur Sie selbst tun).
3. „Bildschirmlink kopieren“ und ans Handy schicken, oder „Bildschirm ansehen ⧉“ im Arbeitsplatz oder auf der Seite Agent-Status. Öffnen Sie den Link im Browser des Handys und melden Sie sich mit Benutzernamen und Anmeldekennwort dieses Macs an, dann sehen und bedienen Sie den Bildschirm. Das Handy muss mit Tailscale verbunden sein.

Öffnen Sie den eigenen Bildschirmlink lokal, ergibt das ein Bild im Bild; er ist für das Handy oder den anderen Rechner gedacht. `dispatch screen status` zeigt den Zustand.
