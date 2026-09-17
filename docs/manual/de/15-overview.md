# Übersicht und Diskussionen

> Worum es auf dieser Seite geht: zwei recht unterschiedliche Seiten. Die „Übersicht“ ist die mitgelieferte Karte der Anwendung mit einem Satz zu jeder Seite; unter „Diskussionen“ lassen Sie mehrere Agenten zu einem Gedanken je einmal Stellung nehmen, ziehen ein Ergebnis und vergeben die Umsetzung.

## Übersicht

Ganz unten in der Seitenleiste über „Übersicht“ oder mit einem Klick auf das Logo links oben. Ein Satz fasst das Produkt zusammen: Ein roter Faden zieht sich durch alle Seiten, denn in Projekten entstehen Sitzungen, aus Sitzungen erwachsen Aufgaben, aus Aufgaben werden Ergebnisse. Unten arbeiten die Agenten, oben schauen Sie zu, antworten und vergeben Aufgaben.

- Jede Seite bekommt eine Karte mit einem Satz dazu, was sie tut, samt Zahlen in Echtzeit (laufende Sitzungen, offene Aufgaben, Projekte, was auf Sie wartet, Skills, Einträge der Wissensbasis, ob die Regeln abgeglichen sind, Version). Ein Klick auf die Karte führt hin.
- „Rundgang ansehen“: fünf Schritte als Dialog, jeder Schritt wechselt auf die passende Seite.
- „Ersteinrichtung“: ruft den Assistenten erneut auf.
- Fünf Punkte unter „So geht es“: Rechtsklick, Tastenkürzel, Handy, zwei Macs und wie ein Agent vom Aufgabenboard erfährt.

## Diskussionen

Über „Diskussionen“ in der Seitenleiste oder über „Eine Idee besprechen“ im Arbeitsplatz bzw. „Diskutieren …“ auf der Projektseite.

**Was es ist**: Sie geben einen Gedanken an mehrere Agenten weiter (Claude, Codex, pi und andere, mit wählbarem Modell und wählbarer Leitung). Diese werden ohne Oberfläche direkt aufgerufen (`claude -p`, `codex exec`, `pi -p`) und hinterlassen je einen Kommentar mit dem Vermerk [Diskussion]; die Leitung spricht in jeder Runde zuletzt und fasst zusammen. Am Ende schreibt das Modell für Zusammenfassungen das [Ergebnis], das sich zudem zu einem Dokument aufbereiten lässt (Hintergrund, Ergebnis, Lösungsweg, Schritte, Risiken, Abnahme). Danach folgt „Einen Agenten damit beauftragen“ oder das „Aufteilen“ in Teilaufgaben. Jeder Gedanke ist auf dem Aufgabenboard eine Aufgabe mit dem Vermerk [Diskussion].

**Die Seite**: Links steht die Liste der Diskussionen (mit Suche, einschließlich der archivierten), rechts die gewählte Diskussion: der Gedanke (auch mit Bild), die Teilnehmer (die Leitung ist gekennzeichnet), der Verlauf der Beiträge, das Ergebnis und das Dokument. Die Schaltflächen: Noch eine Runde, Zu einem Dokument aufbereiten, Einen Agenten damit beauftragen →, Aufteilen, Archivieren. „Kurzfassung“ klappt die Kopfinformationen ein.

**Der runde Tisch und „Nebenbei gefragt“**: Über den Beiträgen sitzt der runde Tisch, eine kleine Figur pro Teilnehmer, sodass Sie auf einen Blick sehen, wer überlegt, wer spricht und wer nicht zu Wort kam. Diskussionsliste und Zusammenfassung lassen sich jeweils zu einer schmalen Leiste einklappen; ist die Chat-Spalte breit genug, wandert das Gespräch nach links und der runde Tisch nimmt vergrößert die rechte Seite ein. Am Rand sitzt ein „Kommilitone“: Wenn ein Wort oder Satz unklar ist, klicken Sie ihn an und fragen, oder markieren Sie einen Satz in der Diskussion und klicken auf „Kommilitonen fragen“. Er liest die Diskussion als Kontext und erklärt in einfachen Worten mit einem kleinen Beispiel. Fragen und Antworten liegen neben der Diskussion, stehen nie in der Aufgabe, die Teilnehmer sehen sie nicht, und die Diskussion bleibt unberührt. Verwendet wird das Zusammenfassungsmodell (oder das Modell des Leiters, wenn keines gesetzt ist); es gilt der Schalter „Diskussionsergebnis“ unter Einstellungen → Zusammenfassungen.

**Hinweis zu den Kosten**: Jeder Teilnehmer verbraucht die Token einer vollständigen neuen Sitzung. Ein Agent beginnt von sich aus keine Diskussion; das geschieht nur, wenn Sie es in der Oberfläche oder in der Befehlszeile ausdrücklich verlangen. Rollen und Regeln finden Sie unter [Einstellungen → Diskussionen](14-settings.md#diskussionen).

In der Befehlszeile: `dispatch discuss --topic "Gedanke" -P Projekt --with claude:opus,codex --leader pi --rounds 2 --conclude`, `dispatch discuss-doc <id>` und `dispatch split <id> --to codex:"Teilaufgabe|Erläuterung"`.
