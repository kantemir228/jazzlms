# Общий прогон коллекции JazzLMS API (§8.3)

Собирает и прогоняет Kantemir. Коллекция: `docs/postman/JazzLMS.postman_collection.json`,
окружение: `docs/postman/JazzLMS-local.postman_environment.json`.

## Как собрать и запустить

```bash
node docs/postman/merge.js
```

```bash
newman run docs/postman/JazzLMS.postman_collection.json -e docs/postman/JazzLMS-local.postman_environment.json --reporters cli,htmlextra --reporter-htmlextra-export docs/postman/reports/newman-report.html
```

`merge.js` берёт каркас Astra (`team/astra.postman_collection.json`) и вставляет в него только папки каждого студента
из его экспорта в `team/`. Копии чужого Setup и Auth в этих файлах не используются.
Подпапки в общих папках стоят перед запросами: так порядок одинаковый и в Postman Runner, и в Newman.

## Откуда взяты части (25.10.2026)

| Студент | PR | Что вошло |
|---|---|---|
| Astra | nuta312/jazzlms#13 | 00 Setup, 01 / Auth, Demo, 07 / E2E-1, 99 Teardown (TD-01, TD-02) |
| Tamara | nuta312/jazzlms#14 | 01 / Users |
| Alina | nuta312/jazzlms#15 | 01 / Branches, Groups; 07 / E2E-3; 99 / Alina |
| Nazgul | nazgulzh/jazzlms → nuta312/jazzlms#26 | 02 / Units, файлы, Certificates; 07 / E2E-5; 99 / Nazgyl |
| Ainura | nuta312/jazzlms#7 | 02 / Tests; 07 / E2E-6; 99 / Ainura |
| Kantemir | ветка tests/kantemir-postman | 03–06; 07 / E2E-7; 99 / Kantemir; запросы SETUP-K в 00 Setup |
| Zhyldyz | — | **ещё не сдано**: CAT, CRS, ENR, RPT и E2E-4 в коллекции отсутствуют |

## Результат

Чистый стенд, `strictGatewayErrors = false`. Три прогона подряд дали одинаковый результат, без единого отличия:
**878 запросов в коллекции (1210 вызовов вместе с запросами из скриптов), 3614 проверок, 177 красных, 132 пропущено.**

| Часть | Красных проверок | Красных запросов | Совпадает с прогоном своего файла |
|---|---|---|---|
| Astra | 0 | 0 | да |
| Alina | 0 | 0 | да |
| Kantemir | 39 | 21 | да (отдельно — тоже 39) |
| Ainura | 48 | 23 | да |
| Tamara | 43 | 20 | да |
| Nazgul | 48 + 3 ошибки запроса | 16 | да |

У каждого красные в общей коллекции — ровно те же запросы, что и при прогоне его собственного файла:
сборка ничего не сломала, а красные — найденные дефекты (их Issues) или замечания ниже.
Пропущенные проверки — известные дефекты, которые авторы пометили сами (`strictGatewayErrors` и т. п.).

HTML-отчёт: `docs/postman/reports/newman-report.html` (в git не кладётся — в нём токены тестовых пользователей;
прикладывается к PR файлом).

## Замечания по частям

- **Zhyldyz:** нет PR — зоны курсов, категорий, записей и отчётов (§4.1) и E2E-4 в общей коллекции нет.
- **Tamara:** нет E2E-2 (§7). `USR-04 · … instructor смотрит ученика` падает с `getaddrinfo ENOTFOUND usr-04` —
  в URL запроса, похоже, попало его имя.
- **Nazgul:** загрузки уроков (UNT-02) ссылаются на файлы `video.mp4`, `doc.pdf`, `doc.docx`, `table.xlsx`, `slides.pptx`,
  которых нет в репозитории — в Newman и у других они не прикрепляются; отсюда 3 ошибки «request url is empty»
  в UNT-03 и UNT-05. Нужно положить файлы рядом с коллекцией (например, `docs/postman/nazgul/files/`) и указать относительный путь.
- **Astra и Nazgul:** оба PR добавляют `docs/postman/JazzLMS.postman_collection.json` — тот же файл, что собирает `merge.js`.
  Предложение: каждый держит свою коллекцию в своей папке, а общий файл собирает только `merge.js` (PR Kantemir — последним).
- Переменные коллекции из частей (`tstLib` у Ainura, `bearer_token_14lb` у Nazgul) переносятся в общую коллекцию.
- Имена переменных: моё `courseId` переименовано в `kCourseId` — его использует Nazgul.
