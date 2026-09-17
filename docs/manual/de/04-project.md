# Projektseite

> Worum es auf dieser Seite geht: Die Projektseite ist der vollständige Nachweis eines Projekts. Hier steht, wie Sie die Projektliste lesen und was die acht Reiter innerhalb eines Projekts (Rückblick, Sitzungen, Aufgaben, Ergebnis, Nicht zugeordnete Aufgaben, Ordner, Dokumente, Wissensbasis) jeweils enthalten und ermöglichen.

![Projektseite](../../assets/shot-project.png)

## Projektliste

Erreichbar über „Projekte“ in der Seitenleiste. Oben stehen das Suchfeld und die Sortierung (letzte Aktivität, Name, Anzahl Sitzungen, offene Aufgaben, zugehöriger Rechner). Projekte mit Regung erscheinen als Karte mit Anzeigename, ☆, zugehörigem Rechner („Der Projektordner liegt derzeit auf diesem Mac“ oder „Das Projekt wurde an diesen Mac übergeben“), Anzahl ungelesener Antworten, einer Zusammenfassungszeile („In Arbeit · &lt;Aufgabe&gt;“, „Neuestes Ergebnis · &lt;Titel&gt;“ oder „Letzte Sitzung · &lt;Titel&gt;“) und „N Sitzungen · N offene Aufgaben · N Ergebnisse“. Projekte ohne Regung seit einer Woche wandern unter „Zuletzt nichts los · N“.

Unten zwei Schaltflächen: „Andere Ordner und nicht zugeordnet · N“ (Ordner, in denen es nur Sitzungen, aber keine Aufgaben und Ergebnisse gibt) und „Archiviert · N“. Der Rechtsklick auf eine Projektkarte bietet unter anderem Favorit, archivieren und neue Sitzung.

## Kopf der Projektseite

- **Titel**: Doppelklick ändert den Anzeigenamen (Marke und Ordner bleiben unverändert, geändert wird nur die Anzeige; leer lassen stellt den Ausgangszustand wieder her). Daneben ☆ für Favorit, die Plakette des zugehörigen Rechners und die Markierung „Archiviert“.
- Die Zeile darunter nennt den Projektordner und „N Sitzungen · N Aufgaben · N Ergebnisse“. Während einer Verschiebung steht hier ein Fortschrittsbalken.
- Schaltflächen:
  - **Terminal · &lt;Rechner&gt; ▾**: öffnet einen Terminal-Tab im Projektordner; im Menü wählen Sie einen Agenten wie Claude Code oder Codex (der entsprechende Agent wird gestartet) oder „Einfaches Terminal“ (ohne Agent).
  - **Diskutieren …**: lässt zu einem Gedanken über dieses Projekt mehrere Agenten je einmal Stellung nehmen und zieht daraus ein Ergebnis.
  - **Nach &lt;Rechner&gt; verschieben** (sobald es einen zweiten Rechner gibt): übergibt Projektordner, Git und die hier laufenden Sitzungen an jenen Rechner, erst mit einer Vorprüfung, dann mit der eigentlichen Übergabe, siehe [Zwei Macs](21-two-macs.md).
  - **Neue Sitzung in diesem Projekt**.
  - **Archivieren / Aus dem Archiv holen**.

## Reiter

### Rückblick

Die von `dispatch here <Projekt>` gezeichnete Seite, in vier Blöcken:

1. **Aktueller Stand**: ein Absatz, geschrieben vom in den Einstellungen gewählten Modell für Zusammenfassungen (beim ersten Mal kann es eine halbe Minute dauern; das Ergebnis wird zwischengespeichert und nach mehr als einem Tag automatisch neu geschrieben). Sind Zusammenfassungen abgeschaltet oder fehlt ein Modell, wird der Grund angezeigt.
2. **Letzte 14 Tage**: eine Chronik. Umschaltbar auf 3, 7 oder 14 Tage; „Vergrößern“ hebt die Höhenbegrenzung auf und lässt die ganze Seite scrollen. „Nach Aufgabe“ gruppiert (Fortschritt, Abschluss, Commits und Sitzungen derselben Aufgabe stehen zusammen, Einträge ohne Aufgabe bilden eine eigene Gruppe), „Nach Datum“ gruppiert nach Tagen, wobei der jüngste Tag vorab ausgeklappt ist und je Tag 4 Einträge vorab erscheinen. Vor jedem Eintrag steht seine Art: Fortschritt, Fertig, Commit (mit siebenstelligem Hash), Sitzung; ein Klick auf einen Sitzungs- oder Aufgabeneintrag öffnet ihn direkt.
3. **Noch offen**: die offenen Aufgaben, mit „N/N abgenommen“, zuständiger Person, Zeitpunkt des letzten Fortschritts und dem letzten Fortschrittseintrag.
4. **Aktive Sitzungen in diesem Ordner**: jede in diesem Ordner laufende Sitzung mit Titel, Agent, Status (Läuft, Wartet auf Sie, Nicht erfasst), Anzahl der geänderten Dateien, einer Zusammenfassung und einer Einschätzung: „Kann geschlossen werden“ (zweimal klicken zum Bestätigen, dann enden Herdr-Tab und Prozess) oder „Offen lassen“ (öffnen und nachsehen, warum). „Wiederherstellen“ öffnet diese Sitzung in Herdr erneut.

### Sitzungen

Die Sitzungsliste dieses Projekts, Favoriten zuerst. Das Suchfeld durchsucht Titel, Ordner und Zusammenfassungen; „Archiviert N“ wechselt zu den archivierten Sitzungen (von Hand archiviert oder länger ohne Aktivität als in den Einstellungen festgelegt); „Geplante Sitzungen N“ wechselt zu den geplanten oder per Skript gestarteten. Jede Zeile enthält: dieser Mac bzw. Rechnername, ★, Titel, Statusmarke, Zusammenfassung der ungelesenen Runde oder die Modellzusammenfassung, „Was Sie gesagt haben“ (die Anforderungen, die Sie in dieser Sitzung genannt haben), die jüngste Antwort oder den jüngsten Fortschritt, „Arbeitet gerade“, den Agenten, die Anzahl der Dateiänderungen und die Zeit. Darunter stehen die verknüpften Aufgaben und die Einschätzung „Kann geschlossen werden / Offen lassen“. Die Schaltflächen rechts: „Gelesen“, „Öffnen und antworten“, „✦ Zusammenfassung / Neu zusammenfassen“ (ruft ein Modell auf) und „Mehr“ (das Kontextmenü).

### Aufgaben

Ein Board mit vier Spalten: **Nur Sie können**, Offen, In Arbeit, Erledigt (die letzten 7 Tage; „Alle N ›“ öffnet die vollständige, nach Wochen gruppierte und durchsuchbare Liste).

- In der Spalte „Nur Sie können“ steht, was ein Agent mit `dispatch need-you` festgehalten hat; davor steht ein Kontrollkästchen, das Abhaken schließt den Eintrag. Ist die Spalte leer, erscheint der Hinweis: Wenn ein Agent auf etwas stößt, das nur Sie erledigen können (E-Mail schicken, bezahlen, sich anmelden, vorführen), trägt er es hier ein.
- In den übrigen Spalten zeigt jeder Eintrag Titel, Status und die auslösende bzw. beteiligte Sitzung; über „Sitzung zuordnen“ wählen Sie auslösende und beteiligte Sitzung von Hand.

### Ergebnis

„Ergebnis erfassen“ öffnet ein Formular: Name des Ergebnisses, was geliefert wurde und wo es zu sehen ist (Markdown, Sie können Dokumente, Screenshots, Versionen oder Code-Links einfügen), Ursprungsaufgaben (Mehrfachauswahl möglich), zusätzliche Ursprungssitzungen (die Sitzungen der gewählten Aufgaben werden ohnehin mit verknüpft). Nach dem Sichern zeigt die Ergebniskarte den Text und die verknüpften Aufgaben und Sitzungen; „Bearbeiten“ ändert sie. Unten listet „Frühere Abschlüsse · N“ die Abschlussnotizen aller erledigten Aufgaben auf, die noch nicht zu eigenen Ergebnissen aufbereitet wurden.

### Nicht zugeordnete Aufgaben

Aufgaben ohne eindeutig verknüpfte Sitzung. Dispatch rät die Zugehörigkeit nicht anhand der Häufigkeit von Erwähnungen; hier ordnen Sie über „Sitzung zuordnen“ selbst zu.

### Ordner

In welchen Ordnern die Sitzungen dieses Projekts stattgefunden haben, je Ordner mit Anzahl der Sitzungen, jüngstem Zeitpunkt sowie „Neue Sitzung in diesem Ordner“, „Im Finder zeigen“ und „cd kopieren“.

### Dokumente

Der obere Teil sind die **Infos**: die Datei `FACTS.md` im Projektordner, in der kurze Fakten stehen, die allein dieses Projekt betreffen (Serverzugänge, Anmeldung, Ansprechpartner). Agenten laden sie nicht jedes Mal, sondern lesen sie bei Bedarf mit `dispatch facts get -P <Projekt> <Thema>`. Fehlt die Datei, legen Sie sie über „Anlegen“ an (mit Vorlage), sonst über „Bearbeiten“ ändern; denken Sie nach dem Sichern an den Commit. Darunter stehen Name und Zweck der für dieses Projekt erfassten Schlüssel (die Werte liegen unter „Regeln & Unterlagen → Schlüssel & APIs“), jeweils mit „Abrufbefehl kopieren“.

Der untere Teil ist die **Dokumentliste**: Sie durchsucht die Ordner `design/`, `docs/` und Recherche-Ordner des Projekts nach `.md` und `.html` und ergänzt die von Ihnen erfassten Pfade oder URLs (`dispatch docs add`). Als Typ gibt es Recherche, Review, Design, Dokumente und Sonstiges. Markdown lesen Sie direkt in der Anwendung (auch Bilder mit relativem Pfad werden angezeigt), HTML öffnet die Standardanwendung, eine URL öffnet den Link. Dokumente auf dem anderen Rechner tragen dessen Namen; dort lassen sich vorerst nur Markdown-Dokumente lesen.

### Wissensbasis

Die Einträge der Wissensbasis, die den Namen dieses Projekts tragen: Stolperfalle, Bewährt, Rückblick (Retro), Anleitung, filterbar nach Typ und durchsuchbar. Ist der Reiter leer, erscheint der Hinweis, dass Agenten mit `dispatch wiki add --kind pit/win -P <Projekt>` eintragen. Die globale Sicht finden Sie unter [Wissensbasis](13-wiki.md).
