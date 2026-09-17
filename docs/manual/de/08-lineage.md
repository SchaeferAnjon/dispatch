# Verlauf

> Worum es auf dieser Seite geht: Die Verlaufsseite zeichnet für ein Projekt „Aufgabe → Sitzung → Fortschritt bzw. Commit“ als Diagramm und beantwortet die Frage, wer in welcher Sitzung an welcher Aufgabe arbeitet und wie weit er ist. Hier steht, wie Sie das Diagramm lesen und filtern und was die Listenansicht zeigt.

## Öffnen

„Verlauf“ in der Seitenleiste, links wählen Sie das Projekt. Die Befehlszeile gibt mit `dispatch lineage [Projekt]` genau diese Daten aus. Vorab sehen Sie die letzten 14 Tage.

## Kopfbereich

Projektname, „N Aufgaben · N aktive Sitzungen · N Sitzungen ohne Aufgabe“, darunter ein Satz zur Zusammenfassung: „<Wer> arbeitet in der Sitzung ‚…‘ an ‚…‘“ oder „Zurzeit keine Aufgabe in Arbeit“. Umschalten zwischen „Diagramm / Liste“, dazu drei Filter: nur in Arbeit, nur mit aktiver Sitzung, nur worauf ich warte.

## Diagramm

Es gibt drei Arten von Knoten, von links nach rechts:

- **Aufgabe**: Titel, Status, zuständige Person, Fortschritt der Abnahme, Zeitpunkt des letzten Fortschritts, Anzahl der Erwähnungen.
- **Sitzung**: Bild und Titel des Agenten, Status (Läuft, Wartet auf Sie, Beendet), Beziehung (auslösend, in Arbeit, erwähnt), die Einschätzung „Kann geschlossen werden / Offen lassen“ und „Betrifft außerdem N Aufgaben“.
- **Fortschritt, Abschluss, Commit**: der erste Satz des Fortschrittstextes, die Abschlussnotiz, die Commit-Nachricht, jeweils mit Datum.

Die Verbindungslinien:

| Linie | Bedeutung |
|:--|:--|
| dicke durchgezogene Linie (auslösende Sitzung) | Die Aufgabe entstand in dieser Sitzung, das ist der Hauptstrang |
| dünne gestrichelte Linie (nebenbei erledigt) | eine weitere Aufgabe, die die Sitzung nebenbei übernommen hat |
| geht hervor aus | die Abhängigkeit `discovered-from` |
| gibt frei | die Abhängigkeit `blocks` |
| enthält | Eltern- und Teilaufgabe |
| aufgeteilt aus | eine aus einer Diskussion hervorgegangene Teilaufgabe |

Der Name eines Knotens ist der Aufgabentitel, der Sitzungstitel oder der erste Satz des Fortschrittstextes, ungekürzt. Beim Überfahren oder Auswählen eines Knotens wird der ganze Strang hervorgehoben und die rechte Spalte zeigt die Einzelheiten; ein Klick auf eine Aufgabe öffnet die Aufgabendetails, ein Klick auf eine Sitzung die Sitzungsseite. Über den Schieberegler zoomen Sie. „Noch nicht verbundene Aufgaben“ und „Sitzungen ohne Aufgabe“ stehen jeweils darunter.

## Liste

Dieselben Daten als Baumliste: Unter jeder Aufgabe stehen ihre Sitzungen (mit Beziehung, Status und Einschätzung) und ihre Ereignisse (Fortschritt, Abschluss, Commit), nach Zeit absteigend. Gut geeignet für das Handy.
