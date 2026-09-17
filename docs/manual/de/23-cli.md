# Referenz der Befehlszeile

> Worum es auf dieser Seite geht: die Unterbefehle von `dispatch`, nach Zweck gruppiert, je mit einem Satz, den gebräuchlichen Parametern und einem Beispiel. Alles, was die Oberfläche zeigt, liefert auch `--json`; maßgeblich ist am Ende immer `--help` des jeweiligen Befehls.

Für die Nutzung im Terminal muss Schritt 2 der Ersteinrichtung abgeschlossen sein (oder `~/.local/bin/dispatch` von Hand verlinkt werden). `dispatch --host <Rechner-ID> <Unterbefehl>` führt denselben Befehl auf dem anderen Mac aus (über SSH, Ein- und Ausgabe gehen durch). Die Daten liegen in `~/tasks/.dispatch` (Sitzungsregister, Transkriptindex) und in `$BEADS_DIR` (voreingestellt `~/tasks/.beads`).

## Aufgaben

| Befehl | Zweck | Gebräuchliche Parameter | Beispiel |
|:--|:--|:--|:--|
| `begin <标题>` | legt eine Aufgabe an und übernimmt sie | `-P Projekt`, `-d Beschreibung`, `-a "- [ ] Abnahmekriterium"`, `-t Typ`, `-p Priorität`, `--deps`, `--session`, `--force` | `dispatch begin "Captcha auf der Anmeldeseite: wird missbraucht" -P web -d "…" -a "- [ ] Tests bestanden"` |
| `claim <id>` | übernehmen; arbeitet jemand anderes daran, wird abgelehnt | `--force` | `dispatch claim task-abc` |
| `log <id> [文本]` | hält Fortschritt fest | `--tick Stichwort …` hakt Abnahmekriterien ab | `dispatch log task-abc "Schnittstelle fertig" --tick Tests` |
| `done <id>` | schließt eine Aufgabe | `--reason` (erforderlich), `--verified`, `--retro`, `--next Titel …`, `--review-by` | `dispatch done task-abc -r "veröffentlicht, e2e gelaufen" --verified` |
| `review <id>` | hält eine unabhängige Gegenprüfung fest | `--verdict pass\|changes`, `--reason` | `dispatch review task-abc --verdict pass --reason "erneuter Lauf bestanden"` |
| `need-you <标题>` | etwas, das nur der Benutzer tun kann | `-P`, `-d`, `--task`, `-p` | `dispatch need-you "Vercel bezahlen" -P web -d "Rechnung fällig"` |
| `task trash\|restore <id>` | in den Papierkorb legen bzw. wiederherstellen | `--json` | `dispatch task trash task-abc` |
| `task-archive` | archiviert erledigte Aufgaben, die älter als N Tage sind | `--days` | `dispatch task-archive --days 30` |
| `commits <id>` | die zur Aufgabe gehörenden Git-Commits | | `dispatch commits task-abc` |
| `find <id>` | Sitzungen, die diese Aufgabe im Transkript erwähnen, samt Fortsetzungsbefehl | | `dispatch find task-abc` |
| `graph` | Knoten und Kanten des Aufgabenverlaufs | | `dispatch graph --json` |
| `review`, `discuss`, `split` und andere | siehe unten unter „Mehrere Agenten“ | | |

## Sitzungen

| Befehl | Zweck | Gebräuchliche Parameter | Beispiel |
|:--|:--|:--|:--|
| `sessions` | die laufenden Sitzungen (wer wo ist, beschäftigt oder wartend) | `--local` | `dispatch sessions` |
| `list` | alle Sitzungen durchblättern | `--agent`, `--project`, `--cwd`, `-q`, `--limit`, `--cached`, `--local` | `dispatch list --project web -q Anmeldung` |
| `session <id\|task>` | Chronik und Dateiänderungen einer Sitzung | `--since offset` (tail in Echtzeit) | `dispatch session 3fa2 --json` |
| `resume <id\|task>` | gibt den Fortsetzungsbefehl aus | `--copy`, `--on Rechner` | `dispatch resume 3fa2 --copy` |
| `focus <id\|task>` | springt zu jenem Tab in Herdr | `--on` | `dispatch focus task-abc` |
| `adopt <id\|pid-N>` | übernimmt eine Sitzung aus einem anderen Terminal in Herdr | `--keep`, `--force` | `dispatch adopt 3fa2` |
| `reply status\|send\|commands\|answer\|control\|revive <id>` | antwortet in der Ursprungssitzung (die Schnittstelle der Oberfläche) | `--agent`, `--mode queue\|interrupt`, `--image`, `--request` | `echo "weiter" \| dispatch reply send 3fa2 --agent claude-code` |
| `seen <key> <reply\|unread>` | als gelesen bzw. ungelesen markieren | | `dispatch seen claude-code:3fa2 unread` |
| `session-preferences <key> <json>` | Favorit, Archiv, Umbenennen, Projektzuordnung, Markierung als geplant | | `dispatch session-preferences claude-code:3fa2 '{"starred":true}'` |
| `activity` | neu hinzugekommene Sitzungsaktivität und ungelesene Antworten | `--events`, `--key`, `--local` | `dispatch activity --json` |
| `editing` | die Dateien, die jede Sitzung in den letzten 30 Minuten geändert hat, samt Konflikten | `--dir`, `--window` | `dispatch editing --dir .` |
| `attachment <key> [ref]` | liest die in der Sitzung verlinkten Dateien | `--thumbs` | `dispatch attachment claude-code:3fa2 --thumbs` |
| `save-image` / `save-file` | sichert ein Bild oder eine Datei von stdin (für die Oberfläche) | | |
| `index` | baut den Transkriptindex neu auf | | `dispatch index` |
| `folders` | Ordner durchblättern (für neue Sitzungen) | `-q`, `--cached` | |
| `session-control open\|browse\|start\|status\|adopt` | Sitzungen öffnen, durchblättern, anlegen, abfragen (für die Oberfläche) | | |
| `terminal` | öffnet in Herdr ein Terminal ohne Agent | `--cwd`, `--host`, `--label` | `dispatch terminal --cwd ~/Projects/x` |
| `session-summary run\|auto\|providers\|unread <key>` | lässt ein Modell eine Sitzung zusammenfassen | `--force`, `--limit` | `dispatch session-summary run claude-code:3fa2` |
| `move <id>` | verschiebt eine Sitzung samt Verzeichnis auf den anderen Rechner | `--to`, `--prompt`, `--no-files`, `--dry-run`, `--force`, `--keep-original` | `dispatch move 3fa2 --to mini` |
| `moves list\|mark` | welche Fassung einer verschobenen Sitzung das Original ist | `--to`, `--from` | `dispatch moves` |

## Projekte

| Befehl | Zweck | Gebräuchliche Parameter | Beispiel |
|:--|:--|:--|:--|
| `projects` | listet die Projekte auf | `--json` | `dispatch projects` |
| `project <名>` | Favorit, Archiv, Verschieben, Zugehörigkeit | `--star/--unstar`, `--archive/--unarchive`, `--move-to`, `--owner`, `--dry-run`, `--background`, `--force`, `--keep-original` | `dispatch project web --move-to mini --background` |
| `project-moves` | Fortschritt der Verschiebungen im Hintergrund | | `dispatch project-moves` |
| `here [项目]` / `project-view` | das Projekt im Moment: Stand, Chronik, Offenes, aktive Sitzungen | `--dir`, `--days`, `--no-summary`, `--refresh-summary`, `--summary-model`, `--local` | `dispatch here --no-summary` |
| `lineage [项目]` | Projekt → Aufgabe → Sitzung → Fortschritt | `--dir`, `--days` | `dispatch lineage web --json` |
| `project-summary <名>` | lässt ein Modell einen Absatz zum Projekt schreiben | `--force`, `--if-stale` | `dispatch project-summary web --if-stale` |
| `docs <项目>` | Dokumentliste des Projekts | | `dispatch docs web --json` |
| `docs add\|rm\|read <项目> <路径\|URL\|id>` | Dokumente erfassen, entfernen, lesen | `--title`, `--kind`, `--asset` | `dispatch docs add web design/x.md --kind 设计` |
| `facts show\|get\|search\|write\|sections\|docs\|vaults\|topics\|import` | Infos | `-P Projekt`, `--path` | `dispatch facts get 服务器 -P web` |

## Wissensbasis und Notizen

| Befehl | Zweck | Gebräuchliche Parameter | Beispiel |
|:--|:--|:--|:--|
| `wiki add\|list\|search\|show\|related` | Stolperfalle, Bewährt, Rückblick, Anleitung | `-k`, `--fix`, `--why`, `--tech/--good/--bad`, `-P`, `--task`, `--semantic`, `--limit`, `--all` | `dispatch wiki search "Port belegt" --semantic` |
| `pit add\|list\|show` | = `wiki --kind pit` | `--fix`, `-P` | `dispatch pit add "Symptom" --fix "Lösung"` |
| `memories list\|show\|archive\|summary` | die langfristigen Notizen der einzelnen Agenten | `--agent`, `--path`, `-P`, `--force` | `dispatch memories list --agent codex` |
| `profile show\|add\|upcoming\|done\|inventory\|write\|path` | Über mich | `--refresh`, `--due` | `dispatch profile add "auf zsh umgestiegen"` |
| `insights [report\|list\|show\|open\|schedule\|due]` | agentenübergreifender Rückblick | `--days`, `--alerts`, `--ack`, `--every`, `--wait`, `--force`, `--model` | `dispatch insights report --days 14` |

## Regeln, Skills, Schlüssel

| Befehl | Zweck | Gebräuchliche Parameter | Beispiel |
|:--|:--|:--|:--|
| `rules show\|path\|open\|status\|sync\|write\|inspect\|optimize\|check\|apply\|restore\|push\|pull\|peers\|auto` | gemeinsame Regeln | `--path`, `--project`, `--profile`, `--model`, `--backup`, `--host`, `--file`, `--refresh`, `--due` | `dispatch rules sync` |
| `skills list\|show\|path\|open\|enable\|disable\|improve\|write\|trash\|new\|import` | Skill-Pool und Bereitstellung | `--agent claude\|codex\|all`, `--file`, `--reveal`, `--description`, `--trigger`, `--constraint`, `--path`, `--as`, `--force`, `--days`, `--copy` | `dispatch skills enable pdf --agent claude` |
| `catalog` | Skills und Erweiterungen, die standardmäßig nicht bereitgestellt sind | `-q`, `--kind skill\|plugin` | `dispatch catalog -q pdf` |
| `env list\|get\|set\|unset\|export\|import\|path` | Schlüssel | `--note`, `-P`, `--stdin`, `--fish` | `echo sk-… \| dispatch env set OPENAI_API_KEY --stdin --note "für Zusammenfassungen"` |
| `zcode-plugin install\|status\|remove` | die ZCode-Erweiterung (spielt prime und Skills ein) | | `dispatch zcode-plugin install` |

## Mehrere Agenten

| Befehl | Zweck | Gebräuchliche Parameter | Beispiel |
|:--|:--|:--|:--|
| `agent list\|start\|ask\|read\|wait\|keys\|close` | Aufgaben über Herdr vergeben | `--host`, `--cwd`, `--label`, `--name`, `--model`, `--task`, `-p`, `--no-wait`, `--timeout`, `--lines`, `--extra`, `--auto`, `--focus` | `dispatch agent start codex --cwd ~/Projects/x --task task-abc -p "Tests reparieren"` |
| `discuss [task]` | mehrere Agenten sagen je einmal etwas | `--topic`, `-P`, `--with`, `--leader`, `--rounds`, `-q`, `--conclude`, `--image`, `--everyone`, `--fresh`, `--tui` | `dispatch discuss --topic "Framework wechseln?" --with claude:opus,codex` |
| `discuss-judge`, `discuss-conclude`, `discuss-doc`, `discuss-live` | Probelauf der Bewertung, Ergebnis schreiben, Dokument aufbereiten, Zustand in Echtzeit | | `dispatch discuss-doc task-abc` |
| `split <id>` | legt nach der Diskussion Teilaufgaben an und vergibt sie | `--to kind:"标题\|说明"` | `dispatch split task-abc --to codex:"Schnittstelle\|…"` |

## Rechner, Handy, System

| Befehl | Zweck | Gebräuchliche Parameter | Beispiel |
|:--|:--|:--|:--|
| `hosts [rename …]` | dieser und die anderen Macs, Möglichkeiten zum Fernzugriff | `--local`, `--refresh` | `dispatch hosts rename local Arbeitszimmer` |
| `serve [run\|url\|qr\|host]` | die Webfassung fürs Handy | `--svg` | `dispatch serve qr` |
| `screen [status\|setup]` | die Einrichtung des Bildschirmzugriffs fürs Handy mit einem Klick | | `dispatch screen setup` |
| `notify <标题> [正文]` | sendet eine Mitteilung ans Handy oder an den Mac | `--url`, `--level normal\|high`, `--key` | `dispatch notify "Fertig" "Kann angesehen werden"` |
| `notify-watch` | führt die Prüfung für die Mitteilungen aufs Handy von Hand aus | `--json` | `dispatch notify-watch --json` |
| `quota` | das Kontingent der einzelnen Agenten | `--local` | `dispatch quota` |
| `stats` | Token, Heatmap, Werkzeuge, Skills | `--agent`, `--days`, `--local`, `--cached` | `dispatch stats --days 30` |
| `settings [key] [value]` | die gemeinsamen Einstellungen | | `dispatch settings session_archive_days 60` |
| `summarize providers\|set-key\|uses` | Modell und Zwecke für Zusammenfassungen | | `dispatch summarize uses` |
| `update [check\|apply]` | nach einer neuen Fassung suchen bzw. sie installieren | `--no-relaunch` | `dispatch update apply` |
| `init [wizard\|status\|run\|…]` | der Assistent der Ersteinrichtung | `run deps\|cli\|board\|agents\|rules\|review\|reverse-ssh`, `rename-self`, `rename-peer`, `remove-host`, `skip`, `finish`, `reset`, `peers` | `dispatch init status --json` |
| `prime` | die Einspielung beim Sitzungsstart | `--hook-json`, `--cwd`, `--limit` | `dispatch prime` |
