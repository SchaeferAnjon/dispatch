# Wissensbasis

> Worum es auf dieser Seite geht: wie die von allen Agenten gemeinsam genutzte Erfahrungssammlung aussieht, wie die vier Arten von Einträgen festgehalten werden und wie die Agenten sie nutzen.

![Wissensbasis](../../assets/shot-wiki.png)

## Was sie ist

Die Wissensbasis liegt im Speicher des Aufgabenboards (Beads memory), wird von allen Agenten gemeinsam genutzt und zwischen beiden Rechnern abgeglichen. Beim Start einer Sitzung spielt `dispatch prime` nur die Einträge des aktuellen Projekts und die allgemeinen ein; alles Weitere holt sich ein Agent bei Bedarf mit `dispatch wiki search <Stichwort>`, mit `--semantic` auch nach Sinn. Beim Abschluss einer Aufgabe erzeugt `dispatch done --retro` automatisch einen Rückblick.

## Vier Arten von Einträgen

| Typ | Text | Zusatzfelder | Woher er kommt |
|:--|:--|:--|:--|
| Stolperfalle (pit) | Symptom plus Ursache | Lösung | Agent: `dispatch wiki add --kind pit "Symptom" --fix "Lösung" -P Projekt`, oder in der Oberfläche „＋ Stolperfalle festhalten“ |
| Bewährt (win) | welches Vorgehen sich als richtig erwiesen hat | warum es richtig ist | `--kind win --why` |
| Rückblick (retro) | was in dieser Aufgabe getan wurde | Technik, Bewährt, Fehlgelaufen | von `dispatch done --retro "【Technik】…【Bewährt】…【Fehlgelaufen】…"` automatisch erzeugt |
| Anleitung (howto) | eine wiederverwendbare Abfolge von Schritten oder Befehlen | | `--kind howto` oder „＋ Anleitung“ |

Jeder Eintrag kann ein Projekt und eine verknüpfte Aufgabe tragen; der key wird automatisch aus dem Text erzeugt, lässt sich aber auch selbst eintragen.

## Die Seite

- Suchfeld: Stichwort, Projekt, Aufgaben-ID.
- Filter: **Wichtige** (Stolperfalle, Bewährt, Anleitung, ohne die automatischen Rückblicke; Voreinstellung), Alle, Stolperfalle, Bewährt, Rückblick, Anleitung, Weitere Notizen (gewöhnliche Einträge ohne Typ).
- Je Eintrag: Typmarke, key, Projekt, Aufgabe, Text und Felder; dazu „Bearbeiten“ und „Löschen“ (zweimal klicken zum Bestätigen). Rechtsklick: bearbeiten, Inhalt kopieren, key kopieren, Aufgabe öffnen, nur die Einträge dieses Projekts zeigen, löschen.
- Rechtsklick auf eine leere Stelle: Stolperfalle festhalten, Bewährtes festhalten, Anleitung festhalten, Wissensbasis neu laden.
- Nach dem Festhalten erscheint der Hinweis „Festgehalten. Agenten desselben Projekts sehen es beim nächsten Sitzungsstart“.

Notizen, die mit `dispatch-` beginnen, sind die eigenen Aufzeichnungen von Dispatch (etwa Favoriten- und Archivzustand von Projekten). Sie erscheinen nicht hier und werden den Agenten nicht eingespielt.

## Wo sie sonst noch auftaucht

- Reiter „Wissensbasis“ auf der Projektseite: nur die Einträge dieses Projekts.
- Rechte Spalte der Aufgabendetails, „Passende Stolperfallen“: die dem Sinn der Aufgabe nach gefundenen Stolperfallen.
- Der Rückblick beim Abschluss einer Aufgabe landet hier.

## Befehlszeile

```sh
dispatch wiki search "Stichwort" [--semantic] [--limit 5]
dispatch wiki list [-k pit|win|retro|howto|all] [-P Projekt]
dispatch wiki show <key>
dispatch wiki add --kind pit "Symptom" --fix "Lösung" -P Projekt [--task task-xxx]
dispatch wiki add --kind win "Vorgehen" --why "warum es richtig ist" -P Projekt
dispatch wiki related <task-id>      # die dem Sinn dieser Aufgabe nächsten Stolperfallen
dispatch pit add|list|show           # = wiki --kind pit
```

Die semantische Suche braucht einen Schlüssel von OpenAI oder Zhipu (`OPENAI_API_KEY` bzw. `ZHIPU_API_KEY`) und legt den Index mit sqlite-vec an.
