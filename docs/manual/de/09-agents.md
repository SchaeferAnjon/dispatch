# Agent-Status

> Worum es auf dieser Seite geht: welcher Agent auf welchem Rechner was tut. Hier stehen die Rechnerleiste, die Karte jedes Agenten, die Symbole für den Ursprung einer Sitzung, der Hinweis auf Bearbeitungskonflikte, die Vergabebeziehungen sowie das Vergeben von Aufgaben und der Bildschirmzugriff von hier aus.

## Rechnerleiste

Ganz oben auf der Seite steht eine Reihe mit jedem Mac aus `hosts.json`: Punkt für Erreichbarkeit, Name, IP und Art des virtuellen Netzes (Tailscale, Netbird, ZeroTier). Die Schaltflächen dahinter erscheinen je nach Möglichkeit:

- **Vergeben**: startet in Herdr auf diesem Rechner einen Agenten, dem Sie eine Aufgabe übergeben können (Agent, Modell, Ordner und erster Prompt sind wählbar).
- **Seinen Bildschirm ansehen und bedienen** (wenn der andere Rechner die Bildschirmfreigabe aktiviert hat): öffnet die Systemfunktion „Bildschirmfreigabe“.
- **Handy-Link zum Bildschirm kopieren ⧉** (wenn dort noVNC eingerichtet ist): am Handy öffnen; das Handy muss mit Tailscale verbunden sein.
- **Zugriff vom Handy ⧉** (dieser Mac): kopiert den Link zur Webfassung von Dispatch.
- **Bildschirm ansehen ⧉** (wenn auf diesem Mac noVNC eingerichtet ist): kopiert den Bildschirmlink dieses Rechners für das Handy oder den anderen Rechner; lokal geöffnet ergäbe er ein Bild im Bild.
- RustDesk, Moonlight, UU-Fernzugriff: Wird eines davon erkannt, gibt es einen Einstieg dorthin.

Rechtsklick auf einen Rechner: Vergeben, SSH-Adresse kopieren, IP kopieren, Bildschirm ansehen. Rechtsklick auf eine leere Stelle: auf einem bestimmten Rechner vergeben.

Die Zeile darunter, „Laufende Anwendungen“, listet die erkannten Agent-Anwendungen auf.

## Agent-Karte

Jeder erreichbare Agent und jeder, auf den Aufgaben laufen, bekommt eine Karte: Bild, Name, ID, Zeitpunkt des letzten Schreibvorgangs und Statusmarken („N laufen“, „N inaktiv“, „N nur als Prozess sichtbar, ohne Sitzung“).

- **Ursprungszeile**: Die Sitzungen dieses Agenten werden nach Ursprung gezählt: ⌘ Terminal, ▣ Desktop-App, ◧ Editor, ✉ Chat, ⏱ geplant, wobei ein pulsierender Punkt anzeigt, dass etwas läuft.
- **Sitzungsliste**: Aktive Sitzungen (laufend oder mit Regung in der letzten Stunde) stehen unmittelbar in der Liste; ältere sind unter „Ältere Sitzungen · N“ eingeklappt. Je Eintrag: Ursprungssymbol, Titel, Status, Ursprungsanwendung oder „tatsächliche Sitzungsaufzeichnung“, Rechner und letzte Aktivität; „Ändert gerade:“ listet die in den letzten 30 Minuten geänderten Dateien auf, wobei **rot** bedeutet, dass mehrere Sitzungen dieselbe Datei ändern (nachzuschlagen mit `dispatch editing`); darunter stehen die verknüpften Aufgaben in Arbeit. Rechts „In Herdr“ (wenn die Sitzung in einem anderen Terminal läuft) und „Öffnen“ (wechselt in die Anwendung, in der die Sitzung liegt).
- **Verknüpfte Aufgaben in Arbeit · N**: die auf ihn laufenden Aufgaben, mit „← wer vergeben hat“.
- **Vergabebeziehungen**: Vergeben N (was er an andere vergeben hat), Selbst vergeben N (an eine andere eigene Sitzung vergeben), Erhalten N (was andere ihm vergeben haben).

Unten zwei eingeklappte Bereiche: „Geplante Sitzungen · N“ (zählen nicht als laufend, nicht als ungelesen und lösen keine Mitteilung aus) und „Agenten ohne erkannte Aktivität · N“.

## Agenten in der Seitenleiste

Unter der Gruppe Agent in der linken Seitenleiste stehen die erreichbaren Agenten: eine Statuszeile („N in Arbeit“, „Aufgabe übernommen, Sitzung inaktiv“, „Sitzung inaktiv“, „Aufgabe übernommen, läuft nicht“) und die erste auf sie laufende Aufgabe oder die Zählung nach Ursprung. Ein Klick auf einen Agenten wechselt in die Tabellenansicht und zeigt nur seine Aufgaben.
