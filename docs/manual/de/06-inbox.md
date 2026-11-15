# Wartet auf mich

> Worum es auf dieser Seite geht: Unter „Wartet auf mich“ steht nur, was Sie selbst erledigen müssen. Hier steht, was die sieben Kategorien jeweils enthalten, welche für roten Punkt und Mitteilung zählen und wie Sie die Liste zügig leeren.

![Wartet auf mich](../../assets/shot-inbox.png)

## Kategorien

Oben eine Reihe Marken, jede mit einer Zahl:

| Marke | Inhalt | Zählt für den roten Punkt |
|:--|:--|:--|
| Ungelesene Antwort | Sitzungen, in denen der Agent fertig ist und Sie die letzte Runde noch nicht gelesen haben, nach Projekt gruppiert; je Eintrag bleibt eine Zeile mit der Zusammenfassung der ungelesenen Runde (vom Modell für Zusammenfassungen geschrieben; sind Zusammenfassungen abgeschaltet, erscheinen die ersten 300 Zeichen der Antwort) | ja |
| Läuft | Sitzungen, die gerade arbeiten | nein |
| Gelesen | die in den letzten sieben Tagen gelesenen Antworten, die jüngste zuerst, zum Nachlesen oder Weiterantworten | nein |
| Wartet auf Bestätigung | Der Agent steht an einem Bestätigungsdialog zu Berechtigungen, einem vertrauenswürdigen Verzeichnis und dergleichen. Es erscheinen nur Sitzungen, die Ereignisse melden (also in Herdr laufen); Sitzungen ohne Meldung, etwa in der Codex-Desktop-App, sehen Sie auf der Sitzungsseite | ja |
| Blockiert | Aufgaben mit offenen Abhängigkeiten; sobald die Abhängigkeiten erledigt sind, lösen sie sich von selbst | nein |
| Agent-Prüfung | erledigte Aufgaben, für die ausdrücklich eine Prüfung angefragt wurde (`dispatch done --review-by`), mit der Anzahl nicht abgehakter Abnahmekriterien und dem Hinweis, ob die Abschlussnotiz fehlt; „Abnahme ansehen“ öffnet die Aufgabe | nein |
| Inaktive Sitzungen | Sitzungen, die offen sind, aber weder laufen noch auf Sie warten | nein |

Was unter „Nur Sie können“ fällt, steht nicht auf dieser Seite, sondern in der ersten Spalte des Reiters „Aufgaben“ auf der Projektseite, siehe [Projektseite](04-project.md#aufgaben).

Die Zahl an „Wartet auf mich“ in der Seitenleiste ist die Summe aus ungelesenen Antworten, Wartet auf Bestätigung und Nur Sie können. Eine Systembenachrichtigung geht nur einmal hinaus, wenn eine Sitzung in den Zustand „Wartet auf Sie“ wechselt.

## Wie Sie die Liste leeren

- Öffnen Sie eine Sitzung, lesen Sie bis zur letzten Runde und verweilen Sie kurz, dann verschwindet der ungelesene Eintrag von selbst. Auch eine Antwort im ursprünglichen Terminal wird erkannt.
- Die Schaltfläche „Gelesen“ oder der Rechtsklick „Als gelesen markieren“ räumt einen Eintrag ab; „Alle als gelesen markieren“ räumt alles ab (oben oder per Rechtsklick auf eine leere Stelle).
- Über den Rechtsklick „Als ungelesen markieren“ holen Sie einen Eintrag zurück, um ihn später anzusehen.
- „Öffnen und antworten“ führt zur Sitzungsseite. Bei Sitzungen, die auf eine Bestätigung warten, können Sie auf der Sitzungsseite direkt Tasten senden, siehe [Sitzungsseite](05-session.md#antwortfeld).
- „✦ Zusammenfassung“ lässt das Modell einen Absatz schreiben (ruft die API auf).

Ist alles abgeräumt, erscheint „✓ Im Moment wartet nichts auf Sie. Neue Antworten erscheinen hier und verschwinden von selbst, sobald Sie sie bis zum Ende gelesen haben“.
