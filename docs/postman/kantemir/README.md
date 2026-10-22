# API-тесты Kantemir: notification, analytics, gamification, безопасность, E2E-7

Здесь лежит часть коллекции Postman по `API_TEST_CHECKLIST.md` (§5, §6, E2E-7): 260 запросов, 924 проверки.

| Файл | Что это |
|---|---|
| `build.js` | Сборщик коллекции. Запросы и проверки описаны здесь, а JSON для Postman собирается из них |
| `JazzLMS-kantemir.postman_collection.json` | Готовая коллекция для импорта в Postman. Руками не правится, только через `build.js` |
| `../JazzLMS-local.postman_environment.json` | Окружение `JazzLMS local`: адреса gateway и сервисов. Токены пустые, их заполняет Setup |

## Как запустить

Стенд должен быть поднят с нуля:

```bash
docker compose --profile app down -v
docker compose --profile app up -d --build
```

Пересобрать коллекцию после правок в `build.js`:

```bash
node docs/postman/kantemir/build.js
```

Прогнать всё и получить HTML-отчёт:

```bash
newman run docs/postman/kantemir/JazzLMS-kantemir.postman_collection.json -e docs/postman/JazzLMS-local.postman_environment.json --reporters cli,htmlextra --reporter-htmlextra-export newman-report.html
```

В PowerShell список репортёров нужно взять в кавычки: `--reporters "cli,htmlextra"`.

В Postman: Import → оба файла, справа сверху выбрать окружение `JazzLMS local`, папка → Run.
Папку `00 Setup · Kantemir` нужно запускать первой: она логинит роли и создаёт ученика `learner_kantemir_<runId>`.

## Как устроены проверки

- **Ожидаемый код записан в конце имени запроса**: `NTF-05 · POST /api/notifications · пустое name → 400`.
  Общий скрипт папки (вкладка Tests у папки) читает его оттуда и проверяет всё из §1.3:
  - для позитивных запросов — код, `Content-Type`, время ответа меньше 1500 мс, отсутствие `passwordHash`;
  - для негативных — `application/problem+json` с полями `title`, `status`, `detail` и отсутствие stack trace в `detail`.

  Во вкладке Tests самого запроса остаются только его собственные проверки.
- **`→ пропущен gateway`** (матрица SEC-04): gateway не отказал сам, то есть не вернул пустой 401/403.
  Дальше отвечает сервис, иногда бизнес-ошибкой: например, 400 на пустое тело. Матрица проверяет права, а не создание записей.
- **Опрос вместо пауз.** Письма, лента событий и очки обновляются через Kafka с задержкой.
  Скрипт до запроса повторяет GET раз в 500 мс, пока результат не появится, но не дольше 10 с.
  Чтобы проверить, что что-то *не* произошло (GAM-02, GAM-12), сначала ждём, пока событие появится в аналитике.
  Это доказывает, что Kafka его доставила. После этого ждём ещё 1,5 с и смотрим, что очки не изменились.
- **Каждый прогон независим.** `runId` делает имена уникальными, каждая папка создаёт свои курсы.
  Папка `99 Teardown · Kantemir` всё удаляет и возвращает настройки геймификации к значениям по умолчанию.

## E2E-7: шаги, которые делаются руками

Сначала прогоните папки `00 Setup · Kantemir` и `07 E2E`, но не Teardown.
Нужный `learnerId` возьмите в Postman, в окружении.

**Redis и Mongo — данные действительно сохранились:**

```bash
docker exec jazzlms-redis-1 redis-cli ZSCORE leaderboard:points <learnerId>
```

```bash
docker exec jazzlms-mongo-1 mongosh gamification_db --quiet --eval "db.processed_events.countDocuments()"
```

Число из Redis должно совпасть с `points` в `GET /api/gamification/me`.

**Повторная доставка (идемпотентность):**

1. Откройте http://localhost:8090 → Topics → `enrollment-events` → Messages.
2. Найдите последнее сообщение с `"type":"COURSE_COMPLETED"`, скопируйте Key и Value.
3. Нажмите Produce Message и вставьте те же Key и Value.
4. В Postman повторите `E2E-7 · 10` и `E2E-7 · 09`: очки не изменились, второго письма нет.

**Сервис был выключен — событие не потерялось:**

```bash
docker compose stop gamification-service
```

Пока сервис выключен, пройдите учеником ещё один урок: создайте курс с двумя уроками или используйте `gamCourseId`.
Затем включите сервис обратно:

```bash
docker compose start gamification-service
```

В течение 30 с `GET /api/gamification/me` покажет начисленные очки: Kafka хранила событие, пока сервис был недоступен.

**Grafana:** http://localhost:3001 → Explore → источник Loki → запрос `{service="course-service"} |= "completed"`.
Из строки лога возьмите traceId (второе значение в квадратных скобках: `[course-service,<traceId>,…]`).
Поиск `{service=~".+"} |= "<traceId>"` покажет путь этого запроса через сервисы.

## Найденные дефекты

Прогоны стабильны: 10 из 11 дали одинаковые 28 красных проверок в 15 запросах.
В одном прогоне упала ещё одна проверка, какая — не записалось. Все остальные красные проверки — дефекты ниже.

| ID проверки | Что не так | Ожидалось | Фактически |
|---|---|---|---|
| NTF-05 | `eventType = XXX` или тело не JSON | 400 | 500 «Internal server error»: `HttpMessageNotReadableException` попадает в общий обработчик `Exception` |
| NTF-11 | Удаление несуществующего письма `DELETE /messages/{id}` | 404 | 204: `deleteById` не проверяет, что запись есть |
| ANL-02 | `timeline?type=XXX` | 400 | 500: ошибка преобразования enum уходит в общий обработчик |
| ANL-05 | `timeline?page=-1` | 400 (§5.2) | 200, тихо подставляется страница 0. Это вопрос к требованиям |
| ANL-09 | `dashboard?period=year` | 400 | 200 с данными за сегодня, а в ответе `"period":"year"` — вводит в заблуждение |
| GAM-06 | `GET /users/abc` (невалидный UUID) | 400 | 500 |
| SEC-01 N2 | Прямой вызов сервиса с мусорным токеном `abc.def.ghi` | 401 с корректным problem+json | 401, но тело — невалидный JSON (перенос строки внутри `detail`), и в `detail` утекает внутреннее сообщение Jackson. Во всех 5 сервисах: `ServiceJwtFilter.reject` |
| SEC-07 (N1 §1.4) | Отказ gateway без токена | 401 + `WWW-Authenticate: Bearer` + problem+json | 401 и 403 от gateway — без тела и без заголовка (`JwtAuthFilter.reject`) |
| SEC-06 | `GET /api/nothing` без токена | 401 | 404: фильтр gateway срабатывает только для известных маршрутов. Вдобавок тело 404 не в формате problem+json |

### Зафиксировано по факту (вопрос к требованиям, тесты зелёные)

- NTF-04: невалидный ObjectId `abc` → 404, как и несуществующий.
- NTF-12: неизвестный плейсхолдер `{{foo}}` заменяется пустой строкой, письмо создаётся.
- ANL-04: `from > to` → 200 с пустой страницей.
- ANL-07: в `/summary` поля `logins`, `courseCompletions`, `usersWithActivity` (за today и week), а не `logins, signups, completions, enrollments`, как в §5.2.
- ANL-11: активность несуществующего пользователя → 200 с нулями.
- SEC-03: `bearer` строчными → 401.

### Не покрыто автотестами

- GAM-05: +20 за сданный тест — нужен тест с вопросами, это зона Ainura (E2E-6).
- GAM-17 и E2E-7, шаги 4–6 — вручную, см. выше.
- Redis `ZCARD leaderboard:points = 0` в GAM-16 проверяется косвенно: рейтинг `top = []`.
