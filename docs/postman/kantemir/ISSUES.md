# Тексты GitHub Issues по найденным дефектам

Готовые тексты для https://github.com/nuta312/jazzlms/issues — один раздел = одно Issue.
Заголовок раздела — это заголовок Issue, остальное — его описание.
ID проверки — имя запроса в коллекции `docs/postman/JazzLMS.postman_collection.json`.

Во всех примерах `<admin>`, `<instructor>`, `<learner>` — токены из `POST /api/auth/login`
(admin / admin123, instructor / instructor123, ученик из `00 Setup`). Стенд: `docker compose --profile app up -d`.

| # | Сервис | Кратко | Серьёзность |
|---|---|---|---|
| 1 | notification | Повторная доставка события → второе письмо | высокая |
| 2 | все сервисы | Мусорный токен → 401 с невалидным JSON и внутренним сообщением Jackson | средняя |
| 3 | notification | Неизвестный `eventType` или битый JSON → 500 | средняя |
| 4 | analytics | `timeline?type=XXX` → 500 | средняя |
| 5 | gamification | `GET /users/abc` → 500 | средняя |
| 6 | gamification | `PUT /settings` с битым JSON → 500 | средняя |
| 7 | user-service | Табуляция внутри строки JSON → 500 (нашла Astra) | средняя |
| 8 | api-gateway | 401 и 403 без тела и без `WWW-Authenticate` | средняя |
| 9 | api-gateway | Неизвестный путь без токена → 404 вместо 401 | низкая |
| 10 | notification | Удаление несуществующего письма → 204 вместо 404 | низкая |
| 11 | analytics | `dashboard?period=year` → 200 с данными за сегодня | низкая |
| 12 | analytics | `timeline?page=-1` → 200 вместо 400 | низкая |
| 13 | analytics | Невалидный id `abc` в `/users/{id}/activity` → 200 вместо 400 | низкая |
| 14 | gamification | Профиль несуществующего пользователя → 200 вместо 404 | низкая |
| 15 | analytics | В `/summary` нет `signups` и `enrollments` из §5.2 | низкая |

## Сверка с Issues команды (25.10.2026)

Часть дефектов команда уже завела — их не дублируем:

| № здесь | Что делать | Почему |
|---|---|---|
| 7 | **не заводить** | Это и есть #10 Astra («POST-эндпоинты возвращают 500 вместо 400/415 при некорректном теле») |
| 8 | **не заводить** | Уже есть #2 Ainura (отказы gateway 401/403 без тела, problem+json и WWW-Authenticate) и его дубль #17 |
| 5 | **комментарий в #3** | #3 Ainura — «невалидный UUID в пути → 500»; gamification `/users/abc` — ещё один сервис с той же ошибкой |
| 3, 6 | завести, со ссылкой на #10 | та же причина, что #10, но в notification и gamification — чинить в других сервисах |
| 4 | завести, со ссылкой на #9 | как #9 Tamara (невалидный enum → 500), но в analytics |
| 1, 2, 9–15 | завести | в Issues команды их нет |

Итого новых Issues — 12: №1, 2, 3, 4, 6, 9, 10, 11, 12, 13, 14, 15. В заголовке каждого — ID проверки.
С `strictGatewayErrors = false` (договорённость команды) проверки формата ответов gateway в SEC-06 и SEC-07 пропускаются: это #2.

Номера 3–7 — одна причина в четырёх сервисах: в `GlobalExceptionHandler` нет обработчиков
`HttpMessageNotReadableException` (тело не читается) и `MethodArgumentTypeMismatchException`
(параметр не того типа), поэтому они попадают в `@ExceptionHandler(Exception.class)` → 500.
Их стоит чинить вместе, но заводить отдельно: правки в разных сервисах.

---

## 1. notification-service: повторная доставка того же события отправляет второе письмо

**Проверка:** E2E-7, шаг 4 (вручную, см. `docs/postman/kantemir/README.md`) · **Серьёзность:** высокая

**Шаги**
1. Создать правило: `POST /api/notifications` (admin), `eventType: COURSE_COMPLETED`, `recipient: RELATED_USER`.
2. Ученик проходит единственный урок курса → в `GET /api/notifications/history` появляется 1 письмо по этому правилу.
3. В Kafka UI (http://localhost:8090) → topic `enrollment-events` → найти это сообщение `COURSE_COMPLETED` → Produce Message с теми же Key и Value (тот же `eventId`).
4. Снова `GET /api/notifications/history`.

**Ожидалось:** одно письмо — повторное событие с тем же `eventId` пропускается.
**Фактически:** два одинаковых письма. analytics-service и gamification-service то же сообщение пропустили
(в логах `Duplicate event … ignored` и `already processed, skipping`).

**Где:** `NotificationService.handle` не проверяет `eventId`. В analytics это делает `existsByEventId`, в gamification — коллекция `processed_events`.

---

## 2. Все сервисы: мусорный токен → 401 с невалидным JSON и внутренним сообщением Jackson

**Проверка:** `SEC-01 · GET {{…Svc}}/… напрямую · мусорный токен → 401` (5 запросов) · **Серьёзность:** средняя

**Шаги**
```bash
curl -i http://localhost:8081/api/users -H "Authorization: Bearer abc.def.ghi"
```

**Ожидалось:** 401, тело — корректный `application/problem+json`, `detail` без внутренностей.
**Фактически:** 401, но тело не парсится как JSON: внутри `detail` неэкранированный перенос строки.
Плюс в `detail` утекает сообщение парсера: `Malformed protected header JSON: Unable to deserialize: … at [Source: REDACTED (StreamReadFeature.INCLUDE_SOURCE_IN_LOCATION disabled); line: 1, …`.
Так отвечают все 5 сервисов (порты 8081–8085).

**Где:** `common/security/.../ServiceJwtFilter.reject` собирает JSON строкой и экранирует только кавычки.
Лучше отдавать общий текст («Invalid or expired token») и писать JSON через `ObjectMapper`.

---

## 3. notification-service: неизвестный eventType или тело не JSON → 500 вместо 400

> Связано с #10 — та же причина в user-service.

**Проверка:** `NTF-05 · eventType = XXX → 400`, `NTF-05 · тело не JSON → 400`, `NEG-NTF · N8` · **Серьёзность:** средняя

**Шаги**
```bash
curl -i -X POST http://localhost:8080/api/notifications -H "Authorization: Bearer <admin>" -H "Content-Type: application/json" -d '{"name":"x","eventType":"XXX","recipient":"RELATED_USER","subjectTemplate":"s","bodyTemplate":"b"}'
```
То же с телом `{name: oops` — в `POST /api/notifications` и `PUT /api/notifications/{id}`.

**Ожидалось:** 400, в `detail` — какое поле неверное.
**Фактически:** 500 `Internal server error, see service logs`.

**Где:** `notification-service/.../web/GlobalExceptionHandler` — нет обработчика `HttpMessageNotReadableException`.

---

## 4. analytics-service: timeline?type=XXX → 500 вместо 400

> Связано с #9 (Tamara: невалидный userType → 500) — та же причина в user-service.

**Проверка:** `ANL-02 · GET /api/analytics/timeline?type=XXX · неизвестный тип → 400` · **Серьёзность:** средняя

**Шаги**
```bash
curl -i "http://localhost:8080/api/analytics/timeline?type=XXX" -H "Authorization: Bearer <admin>"
```

**Ожидалось:** 400 «неизвестный тип события».
**Фактически:** 500 `Internal server error, see service logs`.

**Где:** `analytics-service/.../web/GlobalExceptionHandler` — нет обработчика `MethodArgumentTypeMismatchException`.

---

## 5. gamification-service: GET /api/gamification/users/abc → 500 вместо 400

> Не отдельное Issue, а **комментарий в #3** — та же ошибка, ещё один сервис.

**Проверка:** `GAM-06 · невалидный UUID abc → 400`, `NEG-GAM · N6` · **Серьёзность:** средняя

**Шаги**
```bash
curl -i http://localhost:8080/api/gamification/users/abc -H "Authorization: Bearer <instructor>"
```

**Ожидалось:** 400 «id должен быть UUID».
**Фактически:** 500.

**Где:** `gamification-service/.../web/GlobalExceptionHandler` — нет обработчика `MethodArgumentTypeMismatchException`.

---

## 6. gamification-service: PUT /api/gamification/settings с телом не JSON → 500 вместо 400

> Связано с #10 — та же причина в user-service.

**Проверка:** `NEG-GAM · N8 · PUT /api/gamification/settings … · тело не JSON → 400` · **Серьёзность:** средняя

**Шаги**
```bash
curl -i -X PUT http://localhost:8080/api/gamification/settings -H "Authorization: Bearer <admin>" -H "Content-Type: application/json" -d '{enabled: oops'
```

**Ожидалось:** 400.
**Фактически:** 500.

**Где:** та же причина, что в №3, но в `gamification-service`.

---

## 7. user-service: табуляция внутри строки JSON → 500 вместо 400

> **Уже заведено: #10** (Astra). Здесь — для полноты картины по четырём сервисам.

**Нашла:** Astra · **Проверка:** вручную · **Серьёзность:** средняя

Чаще всего так бывает, когда значение копируют из таблицы или редактора вместе с «прилипшим» табом.

**Шаги** (между `admin` и закрывающей кавычкой — символ табуляции):
```bash
printf '{ "username": "admin\t", "password": "admin123" }' | curl -i -X POST http://localhost:8080/api/auth/login -H "Content-Type: application/json" --data-binary @-
```

**Ожидалось:** 400 — управляющий символ в строке делает JSON невалидным.
**Фактически:** 500 `Internal server error, see service logs`.
Тот же ответ на любое тело, которое не читается как JSON (`{username: oops`). Таб *между* полями — это валидный JSON, и он работает (200).

**Где:** `user-service/.../web/GlobalExceptionHandler` — нет обработчика `HttpMessageNotReadableException`. Та же причина, что в №3 и №6.

---

## 8. api-gateway: отказ 401/403 без тела и без заголовка WWW-Authenticate

> **Уже заведено: #2** (Ainura), дубль — #17. Новое не заводим.

**Проверка:** `SEC-07 · отказ gateway без токена в стандартном формате → 401` · **Серьёзность:** средняя

**Шаги**
```bash
curl -i http://localhost:8080/api/courses
```

**Ожидалось (§1.4 чек-листа, N1):** 401, заголовок `WWW-Authenticate: Bearer`, тело `application/problem+json` — как у самих сервисов.
**Фактически:** 401 с пустым телом и без заголовка. Так же 403 при нехватке роли: клиент не узнаёт причину.

**Где:** `api-gateway/.../filter/JwtAuthFilter.reject` выставляет только статус.

---

## 9. api-gateway: неизвестный путь без токена → 404 вместо 401

**Проверка:** `SEC-06 · GET /api/nothing · без токена → 401` · **Серьёзность:** низкая

**Шаги**
```bash
curl -i http://localhost:8080/api/nothing
```

**Ожидалось:** 401 — без токена gateway ничего не раскрывает, в том числе какие пути существуют.
**Фактически:** 404 `{"timestamp":…,"path":"/api/nothing","status":404,"error":"Not Found",…}` — и не в формате problem+json.

**Где:** `JwtAuthFilter` — глобальный фильтр маршрутов, для неизвестного пути маршрута нет и фильтр не вызывается.

---

## 10. notification-service: удаление несуществующего письма → 204 вместо 404

**Проверка:** `NTF-11 · DELETE /api/notifications/messages/{id} · несуществующее → 404`, `NEG-NTF · N5/N6` · **Серьёзность:** низкая

**Шаги**
```bash
curl -i -X DELETE http://localhost:8080/api/notifications/messages/000000000000000000000000 -H "Authorization: Bearer <admin>"
```

**Ожидалось:** 404, как у `DELETE /api/notifications/{id}` для правил.
**Фактически:** 204 — будто удалили.

**Где:** `NotificationService.deleteMessage` вызывает `deleteById` без проверки существования.

---

## 11. analytics-service: dashboard?period=year → 200 с данными за сегодня

**Проверка:** `ANL-09 · GET /api/analytics/dashboard?period=year · неизвестный период → 400` · **Серьёзность:** низкая

**Шаги**
```bash
curl -s "http://localhost:8080/api/analytics/dashboard?period=year" -H "Authorization: Bearer <admin>"
```

**Ожидалось (§5.2 чек-листа):** 400 — поддерживаются только `today | yesterday | week | month`.
**Фактически:** 200 с 24 часовыми точками за сегодня, а в ответе `"period":"year"` — график выглядит как данные за год.

**Где:** `StatsService.dashboard` — `default` в `switch` молча отдаёт `today`.

---

## 12. analytics-service: timeline?page=-1 → 200 вместо 400

**Проверка:** `ANL-05 · GET /api/analytics/timeline?page=-1 · отрицательная страница → 400` · **Серьёзность:** низкая

**Шаги**
```bash
curl -s "http://localhost:8080/api/analytics/timeline?page=-1" -H "Authorization: Bearer <admin>"
```

**Ожидалось (§5.2 чек-листа):** 400.
**Фактически:** 200 — молча подставляется страница 0.

**Где:** `TimelineService.find` — `Math.max(0, page)`. Если подстановка задумана, нужно поправить чек-лист.

---

## 13. analytics-service: невалидный id в /users/{id}/activity и /courses/{id}/activity → 200 вместо 400

**Проверка:** `NEG-ANL · N6 · GET /api/analytics/users/abc/activity … → 400` · **Серьёзность:** низкая

**Шаги**
```bash
curl -s http://localhost:8080/api/analytics/users/abc/activity -H "Authorization: Bearer <instructor>"
```

**Ожидалось (§1.4 чек-листа, N6):** 400.
**Фактически:** 200 с нулями — id не проверяется на формат UUID.

**Где:** `AnalyticsController.userActivity` / `courseActivity` — `@PathVariable String id` вместо `UUID`.

---

## 14. gamification-service: профиль несуществующего пользователя → 200 вместо 404

**Проверка:** `NEG-GAM · N5 · GET /api/gamification/users/00000000-… · несуществующий пользователь → 404` · **Серьёзность:** низкая

**Шаги**
```bash
curl -s http://localhost:8080/api/gamification/users/00000000-0000-0000-0000-000000000000 -H "Authorization: Bearer <instructor>"
```

**Ожидалось (§1.4 чек-листа, N5):** 404.
**Фактически:** 200 с пустым профилем (0 очков) — нельзя отличить «нет такого пользователя» от «пользователь без очков».

**Где:** `LeaderboardService.profile` создаёт пустой профиль, если в базе ничего нет.

---

## 15. analytics-service: в /api/analytics/summary нет signups и enrollments

**Проверка:** `ANL-07 · GET /api/analytics/summary · запомнить входы → 200` (проверка «§5.2: в сводке есть logins, signups, completions, enrollments») · **Серьёзность:** низкая

**Шаги**
```bash
curl -s http://localhost:8080/api/analytics/summary -H "Authorization: Bearer <admin>"
```

**Ожидалось (§5.2 чек-листа, ANL-07):** числа `logins, signups, completions, enrollments`.
**Фактически:** `today` и `week` содержат только `logins`, `courseCompletions`, `usersWithActivity`.
Регистраций и записей на курс нет, хотя analytics их считает: `StatsService.record` пишет ключи `stats:signups:*` и `stats:enrollments:*` в Redis.

**Где:** `StatsService.summary` / `period` собирает только три метрики. Либо добавить `signups` и `enrollments`, либо поправить §5.2.

---

## Замечания без Issue (на усмотрение команды)

- Пока gamification-service выключен, gateway отвечает на `/api/gamification/**` 500; для «сервис недоступен» правильнее 503.
- user-service ничего не пишет в лог при gRPC-вызовах (`userExists`, `getUser`), поэтому в Grafana путь запроса course-service → user-service не виден; в Zipkin виден.
