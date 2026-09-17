# Alle Aufgaben und Aufgabendetails

> Worum es auf dieser Seite geht: die Gesamtsicht auf das Aufgabenboard. Hier steht, wie Sie Board und Tabelle nutzen, was Papierkorb und Archiv enthalten und woraus sich die Seite mit den Aufgabendetails zusammensetzt (Eigenschaften, Abnahme, Abschlussnotiz, Kommentare, Git-Commits, Dateiänderungen, passende Stolperfallen, Diskussion und Aufteilung).

## Alle Aufgaben

Erreichbar über „Alle Aufgaben“ in der Seitenleiste. Die Werkzeugleiste oben:

- Ansicht umschalten: **Board**, **Tabelle**, **Papierkorb N**, **Archiviert N**.
- Kleine Filtermarken: „Agent-Prüfung N“ und „Blockiert N“; ein Suchfeld; wenn Sie in der Seitenleiste ein Projekt oder einen Agenten angeklickt haben, steht hier „Nur <Name>“, und ✕ hebt es auf.
- Rechtsklick auf eine leere Stelle: zur Tabelle bzw. zum Board wechseln, Filter aufheben, Papierkorb, archivierte Aufgaben, „Vor 30 Tagen erledigte archivieren (N)“ sowie die globalen Aktionen.

### Board

Vier Spalten: Offen, In Arbeit, Blockiert, Erledigt. Jede Spalte ist nach Projekt gruppiert, Favoriten zuerst; die Gruppen lassen sich einklappen, und der Zustand wird je Gerät gemerkt. Die Spalte Erledigt zeigt vorab nur die letzten 7 Tage, „Noch N früher erledigte ›“ klappt den Rest auf. Der Spaltenkopf bietet „Alle einklappen / Alle ausklappen“, der Kopf der Spalte Offen zusätzlich ＋ für eine neue Aufgabe. Sortierung: nach Priorität, nach letzter Aktualisierung, nach Erstellungszeit.

Auf der Karte: Titel, Menü ⋯, „↑ Ursprung <Wurzelaufgabe>“ (die Wurzel dieses Strangs), Priorität, Projekt, Nummer, Typ, „A vergeben an B“, „⊘ Von N Abhängigkeiten blockiert“, „⏸ Zurückgestellt“, der Fortschrittsbalken der Abnahme, „Letzter Fortschritt / Fortschrittsnotiz / Abschlussnotiz“ oder „Nächstes Abnahmekriterium“, die zuständige Person und die Zeit sowie „✓ Geprüft“.

Ziehen Sie eine Karte in eine andere Spalte, ändert sich ihr Status: nach Offen heißt wieder öffnen oder auf Offen zurücksetzen, nach In Arbeit ändert nur den Status (Sie werden nicht zur zuständigen Person), und nach Erledigt schließt die Aufgabe mit der Abschlussnotiz „In Dispatch nach Erledigt gezogen“.

### Tabelle

Spalten: ID, Aufgabe, Ursprung, Status, Zuständig, Priorität, Projekt, Abhängigkeiten (← Anzahl eigener Abhängigkeiten → Anzahl abhängiger Aufgaben), Aktualisiert, Aktionen. Ein Klick auf den Spaltenkopf sortiert, ein weiterer kehrt die Richtung um, der dritte stellt die Voreinstellung wieder her (Favoritenprojekte zuerst).

### Papierkorb und Archiv

- **Papierkorb**: Entfernte Aufgaben behalten ihre Aufzeichnung und ihre Abhängigkeiten und kommen nicht in die Warteschlange der offenen Aufgaben. Über den Rechtsklick oder ⋯ und „Aus dem Papierkorb wiederherstellen“ kehren sie in ihren früheren Status zurück. In der Befehlszeile `dispatch task trash|restore <id>`.
- **Archiviert**: archivierte erledigte Aufgaben; sie stehen nicht in der Spalte Erledigt und zählen nicht mit, Aufzeichnung und Abhängigkeiten bleiben erhalten. Über den Rechtsklick oder ⋯ und „Aus dem Archiv holen“. In den Einstellungen erledigt „Erledigte Aufgaben nach so vielen Tagen automatisch archivieren“ das automatisch, von Hand geht es über „Vor 30 Tagen erledigte archivieren“.

### Kontextmenü und Menü ⋯

Aufgabendetails öffnen, in neuem Fenster öffnen, Aufgaben-ID kopieren, Aufgabeninhalt kopieren, an einen Agenten vergeben … (startet auf einem Rechner in Herdr einen Agenten, der sie übernimmt), nach Offen verschieben, nach In Arbeit verschieben, als erledigt markieren, archivieren (schon lange erledigt), in den Papierkorb verschieben.

### Neue Aufgabe (⌘T)

Titel (ein Satz, der klar sagt, was zu tun ist), Beschreibung (Hintergrund plus Aufgabe plus Bedingung für „fertig“, geschrieben für den nächsten Agenten, der übernimmt), Typ, Priorität, Projekt (ein vorhandenes Projekt, ein Ordner, in dem es nur Sitzungen gab, oder ein neuer Projektname) und Abnahmekriterien (eine Zeile je Kriterium).

## Aufgabendetails

Ein Klick auf eine beliebige Aufgabe öffnet rechts die Detailansicht (am Handy als ganze Seite). <kbd>Esc</kbd> schließt sie; ⇥ klappt die linke Spalte ein, damit Dateiänderungen und Artefakte in der rechten Spalte die volle Breite bekommen.

### Linke Spalte

- **Kopfbereich**: Nummer (beim Überfahren mit Erläuterung), Projekt und „Eigenschaften bearbeiten“ (danach lassen sich Titel, Status und Priorität ändern, die Aufgabe über „Als erledigt markieren“ samt Abschlussnotiz schließen oder über „Wieder öffnen“ erneut öffnen).
- **Eigenschaften**: Status, Zuständig, Priorität, Vergabe (wer an wen), Typ, Projekt, Ursprung (Wurzelaufgabe), Marken, Abhängigkeiten, abhängige Aufgaben, Erstellungszeit und Ersteller, Abschlusszeit.
- **Diskussion und Aufteilung** (bei offenen Aufgaben oder sobald es eine Diskussion oder Teilaufgaben gab): das Ergebnis der Diskussion, jeder Beitrag mit dem Vermerk [Diskussion] und die Liste der Teilaufgaben. „Diskussion starten …“ ruft die gewählten Agenten ohne Oberfläche direkt auf, damit jeder einen Kommentar mit dem Vermerk [Diskussion] hinterlässt (meist innerhalb einer Minute vollständig). „Aufteilen und vergeben …“ legt nach den von Ihnen eingetragenen Zeilen Teilaufgaben an und startet in Herdr die passenden Agenten.
- **Lieferung und Prüfung** (bei erledigten Aufgaben): „N/N abgehakt · N noch zu prüfen“, die noch zu prüfenden Abnahmekriterien und die Belege (die drei jüngsten Fortschrittseinträge, die verknüpften Sitzungen). Rechts vom Titel steht der Status: „Erledigt · keine Freigabe von Ihnen nötig“, „Wartet auf Agent-Prüfung“ oder „Prüfung als bestanden erfasst“. Fehlt die Abschlussnotiz, wird darauf hingewiesen.
- **Abschlussnotiz**: der Inhalt von `done --reason`, aufklappbar.
- **Beschreibung**: Markdown, Doppelklick zum Bearbeiten; ist sie leer, erscheint der Hinweis „Noch keine Beschreibung. Der nächste Agent, der übernimmt, wird nicht wissen, warum das gemacht wird“.
- **Abnahmekriterien**: die Liste aus `- [ ]`; ein Klick auf das Kästchen hakt ab oder nimmt das Häkchen zurück und zeichnet mit „von Ihnen geprüft“. Von einem Agenten Abgehaktes erscheint als „Selbstprüfung · <Agent>“ oder „Gegenprüfung · <Agent>“; bei alten Aufzeichnungen kann „ohne Signatur“ stehen. „Bearbeiten“ ändert den Text unmittelbar.
- **Aktivität**: Statusänderungen, Übernahmen, Kommentare, jeweils mit Verfasser und Zeit.
- **Kommentarfeld**: „Kommentar für den nächsten Agenten, der übernimmt …“, <kbd>⌘⏎</kbd> sendet. Beim nächsten Sitzungsstart des Agenten spielt `dispatch prime` ihm die unbeantworteten Kommentare zu den auf ihn laufenden Aufgaben ein.

### Rechte Spalte

- **Passende Stolperfallen**: die Stolperfallen, die sich zum Inhalt dieser Aufgabe in der Wissensbasis finden (mit semantischer Suche projektübergreifend und mit Ähnlichkeitswert, sonst nur aus diesem Projekt), mit Symptom und Lösung.
- **Git-Commits**: Commits, deren Nachricht am Ende diese Aufgaben-ID trägt, oder deren Hash in der Abschlussnotiz steht; je Eintrag Kurzhash, Titel, +N −M und Zeit. Aufgeklappt sehen Sie die Dateiliste, dazu „Auf GitHub öffnen ↗“ und „Hash kopieren“. Ist der Bereich leer, wird der Grund genannt (noch kein passender Commit, oder das Projekt liegt nicht in einem Git-Repository).
- **Dateiänderungen und Artefakte**: die in den ausdrücklich verknüpften Sitzungen festgehaltenen Dateiänderungen (jede mit Diff) und Artefakte (Bildraster, Schaltflächen für Dateien). Gibt es keine verknüpfte Sitzung, erscheint der Hinweis, dass die Verknüpfung automatisch entsteht, sobald ein Agent die Aufgabe übernimmt oder Fortschritt festhält.
- **Im Gespräch erwähnt**: Sitzungen, in deren Transkript diese Aufgaben-ID vorkommt. Das ist nur ein Anhaltspunkt und begründet keine Zugehörigkeit; je Eintrag gibt es „Aufzeichnung ansehen“ und „Fortsetzungsbefehl kopieren“.
