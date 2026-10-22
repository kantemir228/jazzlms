// Собирает папки Kantemir (00 Setup, 03–07, 99 Teardown) коллекции JazzLMS API для Postman.
// Запуск из корня репозитория: node docs/postman/kantemir/build.js
// Результат: docs/postman/kantemir/JazzLMS-kantemir.postman_collection.json — его импортируют в Postman.
//
// Зачем генератор, а не ручной JSON: в коллекции ~200 запросов, и у многих одинаковые части
// (заголовок Authorization, общие проверки, опрос событий). Здесь они описаны один раз.

const fs = require('fs');
const path = require('path');

// ---------- маленькие помощники ----------

/** Тело функции -> массив строк скрипта Postman. Скрипты пишем как обычный JS, а не строками. */
function js(fn) {
  const src = fn.toString();
  const lines = src.slice(src.indexOf('{') + 1, src.lastIndexOf('}')).split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const indent = Math.min(...lines.filter(l => l.trim()).map(l => l.match(/^ */)[0].length));
  return lines.map(l => l.slice(indent));
}

const auth = role => role ? [{ key: 'Authorization', value: `Bearer {{${role}Token}}` }] : [];

/**
 * Один запрос. Ожидаемый код пишется в конце имени: "… → 201".
 * Общие проверки папки (COMMON) читают его оттуда.
 */
function req(name, method, url, opt = {}) {
  const header = [...auth(opt.as), ...(opt.headers || [])];
  const request = { method, header, url: url };
  if (opt.json !== undefined) {
    header.push({ key: 'Content-Type', value: 'application/json' });
    request.body = { mode: 'raw', raw: typeof opt.json === 'string' ? opt.json : JSON.stringify(opt.json, null, 2) };
  }
  if (opt.form) request.body = { mode: 'formdata', formdata: opt.form };
  const event = [];
  if (opt.pre) event.push({ listen: 'prerequest', script: { type: 'text/javascript', exec: [].concat(...opt.pre) } });
  if (opt.test) event.push({ listen: 'test', script: { type: 'text/javascript', exec: [].concat(...opt.test) } });
  return { name, event, request };
}

function folder(name, description, items, withCommon = true) {
  const event = withCommon ? [{ listen: 'test', script: { type: 'text/javascript', exec: COMMON } }] : [];
  return { name, description, item: items, event };
}

/** Урок CONTENT с отметкой «прочитал» (CHECKBOX): multipart, часть unit — JSON. */
function unitForm(name) {
  return [{ key: 'unit', type: 'text', contentType: 'application/json',
    value: JSON.stringify({ name, type: 'CONTENT', completionType: 'CHECKBOX', textContent: 'Текст урока для автотестов' }) }];
}

/** Сохранить id из ответа в окружение. */
const saveId = varName => js(() => {
  pm.environment.set('__VAR__', pm.response.json().id);
}).map(l => l.replace('__VAR__', varName));

// ---------- общие проверки §1.3 (висят на каждой моей папке) ----------

const COMMON = js(() => {
  // Общие проверки §1.3 чек-листа. Ожидаемый код берётся из конца имени запроса: "… → 201".
  // "→ пропущен gateway" значит: gateway не отказал сам (нет пустого 401/403), дальше решает сервис.
  const m = pm.info.requestName.match(/→\s*(\d{3}|пропущен gateway)\s*$/);
  if (m) {
    const code = pm.response.code;
    const text = pm.response.text();
    const ct = (pm.response.headers.get('Content-Type') || '').toLowerCase();
    if (m[1] === 'пропущен gateway') {
      pm.test('Gateway пропустил запрос (нет пустого 401/403 от gateway)', () =>
        pm.expect([401, 403].includes(code) && text.length === 0, `код ${code}, тело пустое`).to.be.false);
    } else {
      const expected = Number(m[1]);
      pm.test(`Код ответа ${expected}`, () => pm.response.to.have.status(expected));
      if (expected < 300) {
        pm.test('Ответ быстрее 1500 мс', () => pm.expect(pm.response.responseTime).to.be.below(1500));
        pm.test('В ответе нет passwordHash', () => pm.expect(text).to.not.include('passwordHash'));
        if (expected !== 204 && text.length && !/csv|html/.test(ct)) {
          pm.test('Content-Type: JSON', () => pm.expect(ct).to.match(/application\/([\w.-]+\+)?json/));
        }
      }
      if (expected >= 400 && text.length) {
        pm.test('Ошибка в формате application/problem+json', () => pm.expect(ct).to.include('application/problem+json'));
        pm.test('В ошибке есть title, status, detail', () => {
          const err = pm.response.json();
          pm.expect(err.title, 'title').to.be.a('string');
          pm.expect(err.status, 'status').to.eql(code);
          pm.expect(err.detail, 'detail').to.be.a('string').and.not.empty;
        });
        pm.test('detail без stack trace и имён классов', () => {
          const detail = pm.response.json().detail || '';
          pm.expect(detail).to.not.match(/Exception|\tat |kz\.jazz\.|org\.springframework/);
        });
      }
    }
  }
});

// Опрос (§7): повторяем GET раз в 500 мс, пока check(json) не станет true, но не дольше timeoutMs.
// Подключается в начало pre-request скриптов, которым нужно дождаться события из Kafka.
const POLL = js(() => {
  function poll(url, tokenVar, check, timeoutMs, done) {
    const started = Date.now();
    (function tick() {
      pm.sendRequest({ url: pm.variables.replaceIn(url), method: 'GET',
        header: { Authorization: 'Bearer ' + pm.environment.get(tokenVar) } }, (err, res) => {
        let ok = false;
        try { ok = !err && res.code === 200 && check(res.json()); } catch (e) { ok = false; }
        const elapsed = Date.now() - started;
        if (ok || elapsed > timeoutMs) return done(ok, elapsed);
        setTimeout(tick, 500);
      });
    })();
  }
});

/** pre-request: дождаться условия и записать, сколько ждали, в pollOk / pollMs. */
function waitFor(url, tokenVar, checkFn, timeoutMs = 10000, extraWaitMs = 0) {
  const check = checkFn.toString();
  return [...POLL,
    `poll(${JSON.stringify(url)}, ${JSON.stringify(tokenVar)}, ${check}, ${timeoutMs}, (ok, ms) => {`,
    `  pm.environment.set('pollOk', ok); pm.environment.set('pollMs', ms);`,
    extraWaitMs ? `  setTimeout(() => {}, ${extraWaitMs});` : '',
    `});`];
}

const POLL_OK = js(() => {
  pm.test(`Событие обработано (ждали ${pm.environment.get('pollMs')} мс, лимит 10 с)`, () =>
    pm.expect(pm.environment.get('pollOk')).to.eql(true));
});

const B = '{{baseUrl}}';

// ---------- §1.4: стандартные негативы N1–N8 сразу для всех путей сервиса ----------

/**
 * Один запрос на один вид негатива (N1…N8) для целого сервиса. Первый путь из списка — сам запрос
 * (его проверяют общие тесты папки), остальные pre-request отправляет по очереди, и на каждый
 * в Tests заводится своя проверка. Так каждый эндпоинт получает весь набор §1.4, а запросов — 8 на сервис.
 * Поле expect у пути — когда факт отличается от общего ожидания и записан как «зафиксировано».
 */
const SWEEP_PRE = js(() => {
  // испорченная подпись (N3): меняем один символ в конце токена администратора
  const t = pm.environment.get('adminToken');
  pm.variables.set('brokenAdminToken', t.slice(0, -2) + (t.slice(-2, -1) === 'A' ? 'B' : 'A') + t.slice(-1));
  const entries = __ENTRIES__;
  const authHeader = kind => kind === 'none' ? null : kind === 'garbage' ? 'Bearer abc.def.ghi'
    : kind === 'broken' ? 'Bearer ' + pm.variables.get('brokenAdminToken') : 'Bearer ' + pm.environment.get(kind + 'Token');
  const results = [];
  (function next(i) {
    if (i >= entries.length) return pm.variables.set('sweepResults', JSON.stringify(results));
    const e = entries[i];
    const header = [];
    const auth = authHeader(e.auth);
    if (auth) header.push({ key: 'Authorization', value: auth });
    const request = { url: pm.variables.replaceIn('{{baseUrl}}' + e.p), method: e.m, header };
    if (e.body !== undefined) {
      header.push({ key: 'Content-Type', value: 'application/json' });
      request.body = { mode: 'raw', raw: typeof e.body === 'string' ? e.body : JSON.stringify(e.body) };
    }
    pm.sendRequest(request, (err, res) => {
      results.push({ label: `${e.m} ${e.p} (${e.auth})`, expect: e.expect, code: err ? 'error' : res.code,
        ct: err ? '' : (res.headers.get('Content-Type') || ''), size: err ? 0 : res.text().length });
      next(i + 1);
    });
  })(0);
});

const SWEEP_TEST = js(() => {
  const group = Number('__EXPECTED__');
  JSON.parse(pm.variables.get('sweepResults') || '[]').forEach(r => {
    const expected = r.expect || group;
    pm.test(`${r.label} → ${expected}`, () => pm.expect(r.code, `пришло ${r.code}`).to.eql(expected));
    if (expected >= 400 && r.size) {
      pm.test(`${r.label}: ошибка в формате problem+json`, () => pm.expect(r.ct).to.include('application/problem+json'));
    }
  });
});

function sweep(id, title, expected, entries) {
  const [first, ...rest] = entries;
  const headers = first.auth === 'garbage' ? [{ key: 'Authorization', value: 'Bearer abc.def.ghi' }]
    : first.auth === 'broken' ? [{ key: 'Authorization', value: 'Bearer {{brokenAdminToken}}' }] : [];
  const as = ['admin', 'instructor', 'learner'].includes(first.auth) ? first.auth : undefined;
  return req(`${id} · ${title} · ${first.m} ${first.p} и ещё ${rest.length} → ${first.expect || expected}`, first.m, `${B}${first.p}`, {
    as, headers, json: first.body,
    pre: SWEEP_PRE.map(l => l.replace('__ENTRIES__', JSON.stringify(rest))),
    test: SWEEP_TEST.map(l => l.replace('__EXPECTED__', expected)) });
}

/** Пути сервиса с методом и телом -> те же пути с нужной авторизацией (N1–N4). */
const withAuth = (paths, auth) => paths.map(([m, p, body]) => ({ m, p, body, auth }));

// ======================================================================
// 00 Setup · Kantemir
// ======================================================================

const setup = folder('00 Setup · Kantemir (временный)',
  'Логины admin и instructor, новый ученик learner_kantemir_<runId>, курс для тестов. ' +
  'Временная замена общего Setup (его делает Astra): имена переменных те же, что в §1.1 чек-листа.', [
  req('SETUP-K-01 · POST /api/auth/login · admin → 200', 'POST', `${B}/api/auth/login`, {
    json: { username: 'admin', password: 'admin123' },
    pre: js(() => {
      // runId делает имена уникальными: коллекцию можно гонять сколько угодно раз подряд
      pm.environment.set('runId', Date.now().toString(36));
    }),
    test: js(() => {
      const body = pm.response.json();
      pm.test('Токен из трёх частей через точку', () => pm.expect(body.token.split('.')).to.have.length(3));
      pm.test('Роль SUPER_ADMIN', () => pm.expect(body.user.userType).to.eql('SUPER_ADMIN'));
      pm.environment.set('adminToken', body.token);
      pm.environment.set('adminId', body.user.id);
    }) }),
  req('SETUP-K-02 · POST /api/auth/login · instructor → 200', 'POST', `${B}/api/auth/login`, {
    json: { username: 'instructor', password: 'instructor123' },
    test: js(() => {
      const body = pm.response.json();
      pm.test('Роль TRAINER', () => pm.expect(body.user.userType).to.eql('TRAINER'));
      pm.environment.set('instructorToken', body.token);
      pm.environment.set('instructorId', body.user.id);
    }) }),
  req('SETUP-K-03 · POST /api/users · создать ученика → 201', 'POST', `${B}/api/users`, {
    as: 'admin',
    json: { firstName: 'Kantemir', lastName: 'Learner', email: 'learner_k_{{runId}}@test.local',
      username: 'learner_kantemir_{{runId}}', password: 'learner123', userType: 'LEARNER' },
    test: js(() => {
      const user = pm.response.json();
      pm.test('Создан LEARNER', () => pm.expect(user.userType).to.eql('LEARNER'));
      pm.environment.set('learnerId', user.id);
      pm.environment.set('learnerUsername', user.username);
      pm.environment.set('learnerEmail', user.email);
    }) }),
  req('SETUP-K-04 · POST /api/auth/login · ученик → 200', 'POST', `${B}/api/auth/login`, {
    json: { username: '{{learnerUsername}}', password: 'learner123' },
    test: js(() => {
      const body = pm.response.json();
      pm.test('Вошёл тот самый ученик', () => pm.expect(body.user.id).to.eql(pm.environment.get('learnerId')));
      pm.environment.set('learnerToken', body.token);
    }) }),
  req('SETUP-K-05 · POST /api/courses · курс для тестов → 201', 'POST', `${B}/api/courses`, {
    as: 'instructor', json: { name: 'K course {{runId}}', active: true },
    test: js(() => {
      pm.environment.set('courseId', pm.response.json().id);
      pm.environment.set('kCourseName', pm.response.json().name);
    }) }),
]);

// ======================================================================
// 03 notification-service
// ======================================================================

const ALL_EVENTS = ['USER_CREATED', 'USER_SIGNED_UP', 'USER_LOGGED_IN', 'COURSE_CREATED', 'COURSE_UPDATED',
  'USER_ENROLLED', 'COURSE_COMPLETED', 'ASSIGNMENT_SUBMITTED', 'UNIT_ADDED', 'UNIT_COMPLETED', 'COURSE_DELETED',
  'COURSE_RESTORED', 'USER_DELETED', 'USER_IMPERSONATED', 'CERTIFICATE_ISSUED', 'TEST_COMPLETED'];

const N = `${B}/api/notifications`;
const NO_OID = '000000000000000000000000';   // ObjectId, которого нет
const NO_UUID = '00000000-0000-0000-0000-000000000000';
// все пути сервиса: [метод, путь, тело]; первый — безопасный GET, он станет самим запросом
const NTF_PATHS = [
  ['GET', '/api/notifications'], ['GET', '/api/notifications/events'], ['GET', '/api/notifications/recipients'],
  ['GET', `/api/notifications/${NO_OID}`], ['POST', '/api/notifications', {}], ['PUT', `/api/notifications/${NO_OID}`, {}],
  ['DELETE', `/api/notifications/${NO_OID}`], ['GET', '/api/notifications/history'], ['DELETE', '/api/notifications/history'],
  ['GET', '/api/notifications/pending'], ['DELETE', `/api/notifications/messages/${NO_OID}`]];
const rule = (over = {}) => Object.assign({ name: 'K rule {{runId}}', eventType: 'COURSE_COMPLETED', recipient: 'RELATED_USER',
  active: true, delayMinutes: 0, subjectTemplate: 'Done: {{courseName}}', bodyTemplate: 'Hi {{firstName}}!' }, over);

const notification = folder('03 notification-service',
  'Правила писем, история и очередь. На gateway все пути — только ADMIN. ' +
  'Письма появляются после события из Kafka, поэтому проверки истории ждут их опросом (до 10 с).', [
  req('NTF-01 · GET /api/notifications/events · admin → 200', 'GET', `${N}/events`, { as: 'admin',
    test: js(() => {
      pm.test('Все 16 типов событий EventType', () => pm.expect(pm.response.json()).to.eql(__EVENTS__));
    }).map(l => l.replace('__EVENTS__', JSON.stringify(ALL_EVENTS))) }),
  req('NTF-01 · GET /api/notifications/events · instructor → 403', 'GET', `${N}/events`, { as: 'instructor' }),
  req('NTF-01 · GET /api/notifications/events · learner → 403', 'GET', `${N}/events`, { as: 'learner' }),
  req('NTF-02 · GET /api/notifications/recipients · admin → 200', 'GET', `${N}/recipients`, { as: 'admin',
    test: js(() => {
      pm.test('Три вида получателей', () =>
        pm.expect(pm.response.json()).to.eql(['RELATED_USER', 'ACCOUNT_OWNER', 'COURSE_INSTRUCTORS']));
    }) }),
  req('NTF-02 · GET /api/notifications/recipients · learner → 403', 'GET', `${N}/recipients`, { as: 'learner' }),
  req('NTF-03 · GET /api/notifications · правила из сидера · admin → 200', 'GET', N, { as: 'admin',
    test: js(() => {
      const rules = pm.response.json();
      const names = rules.map(r => r.name);
      pm.test('Есть все 7 правил по умолчанию', () => pm.expect(names).to.include.members([
        'User signup', 'User signup (email to account owner)', 'User addition (from an admin)',
        'Course assignment to learner', 'Course completion', 'Assignment submission', 'Reminder 1 hour after signup']));
      pm.test('У каждого правила все поля нужных типов', () => rules.forEach(r => {
        pm.expect(r.id).to.match(/^[0-9a-f]{24}$/);
        pm.expect(r.eventType).to.be.a('string');
        pm.expect(r.recipient).to.be.a('string');
        pm.expect(r.active).to.be.a('boolean');
        pm.expect(r.delayMinutes).to.be.a('number');
        pm.expect(r.subjectTemplate).to.be.a('string');
        pm.expect(r.bodyTemplate).to.be.a('string');
      }));
    }) }),
  req('NTF-03 · GET /api/notifications · instructor → 403', 'GET', N, { as: 'instructor' }),

  req('NTF-05 · POST /api/notifications · валидное правило → 201', 'POST', N, { as: 'admin', json: rule(),
    test: js(() => {
      const r = pm.response.json();
      pm.test('id — ObjectId MongoDB', () => pm.expect(r.id).to.match(/^[0-9a-f]{24}$/));
      pm.test('Поля сохранились как отправили', () => {
        pm.expect(r.eventType).to.eql('COURSE_COMPLETED');
        pm.expect(r.recipient).to.eql('RELATED_USER');
        pm.expect(r.active).to.eql(true);
        pm.expect(r.delayMinutes).to.eql(0);
        pm.expect(r.subjectTemplate).to.eql('Done: {{courseName}}');
      });
      pm.environment.set('ruleId', r.id);
    }) }),
  req('NTF-05 · POST /api/notifications · пустое name → 400', 'POST', N, { as: 'admin', json: rule({ name: '' }),
    test: js(() => { pm.test('detail называет поле name', () => pm.expect(pm.response.json().detail).to.include('name')); }) }),
  req('NTF-05 · POST /api/notifications · eventType = XXX → 400', 'POST', N, { as: 'admin', json: rule({ eventType: 'XXX' }) }),
  req('NTF-05 · POST /api/notifications · delayMinutes = -1 → 400', 'POST', N, { as: 'admin', json: rule({ delayMinutes: -1 }),
    test: js(() => { pm.test('detail называет поле delayMinutes', () => pm.expect(pm.response.json().detail).to.include('delayMinutes')); }) }),
  req('NTF-05 · POST /api/notifications · без subjectTemplate → 400', 'POST', N, { as: 'admin', json: rule({ subjectTemplate: undefined }) }),
  req('NTF-05 · POST /api/notifications · тело не JSON → 400', 'POST', N, { as: 'admin', json: '{name: oops' }),
  req('NTF-05 · POST /api/notifications · instructor → 403', 'POST', N, { as: 'instructor', json: rule() }),
  req('NTF-05 · POST /api/notifications · learner → 403', 'POST', N, { as: 'learner', json: rule() }),

  req('NTF-04 · GET /api/notifications/{id} · созданное правило → 200', 'GET', `${N}/{{ruleId}}`, { as: 'admin',
    test: js(() => { pm.test('Это наше правило', () => pm.expect(pm.response.json().id).to.eql(pm.environment.get('ruleId'))); }) }),
  req('NTF-04 · GET /api/notifications/{id} · несуществующий ObjectId → 404', 'GET', `${N}/000000000000000000000000`, { as: 'admin' }),
  req('NTF-04 · GET /api/notifications/{id} · невалидный id abc → 404', 'GET', `${N}/abc`, { as: 'admin' }),
  req('NTF-04 · PATCH /api/notifications/{id} · метод не поддерживается → 405', 'PATCH', `${N}/{{ruleId}}`, { as: 'admin', json: {} }),

  req('NTF-06 · PUT /api/notifications/{id} · выключить правило → 200', 'PUT', `${N}/{{ruleId}}`, { as: 'admin',
    json: rule({ name: 'K rule {{runId}} (off)', active: false }),
    test: js(() => {
      pm.test('active = false и новое имя', () => {
        pm.expect(pm.response.json().active).to.eql(false);
        pm.expect(pm.response.json().name).to.include('(off)');
      });
    }) }),
  req('NTF-06 · PUT /api/notifications/{id} · пустое name → 400', 'PUT', `${N}/{{ruleId}}`, { as: 'admin', json: rule({ name: '' }) }),
  req('NTF-06 · PUT /api/notifications/{id} · несуществующий → 404', 'PUT', `${N}/000000000000000000000000`, { as: 'admin', json: rule() }),
  req('NTF-07 · DELETE /api/notifications/{id} → 204', 'DELETE', `${N}/{{ruleId}}`, { as: 'admin' }),
  req('NTF-07 · DELETE /api/notifications/{id} · повторно → 404', 'DELETE', `${N}/{{ruleId}}`, { as: 'admin' }),

  // --- NTF-08: событие USER_ENROLLED -> письмо ученику по правилу из сидера ---
  req('NTF-prep · POST /api/courses · курс для писем → 201', 'POST', `${B}/api/courses`, { as: 'instructor',
    json: { name: 'K ntf course {{runId}}', active: true },
    test: js(() => {
      pm.environment.set('ntfCourseId', pm.response.json().id);
      pm.environment.set('ntfCourseName', pm.response.json().name);
    }) }),
  req('NTF-prep · POST /api/courses/{id}/enrollments · записать ученика → 201', 'POST', `${B}/api/courses/{{ntfCourseId}}/enrollments`, {
    as: 'instructor', json: { userId: '{{learnerId}}' } }),
  req('NTF-08 · GET /api/notifications/history · письмо о записи пришло ученику → 200', 'GET', `${N}/history`, { as: 'admin',
    pre: waitFor(`${N}/history`, 'adminToken', list => list.some(m => m.recipientEmail === pm.environment.get('learnerEmail')
      && m.eventType === 'USER_ENROLLED' && m.subject.includes(pm.environment.get('ntfCourseName')))),
    test: [...POLL_OK, ...js(() => {
      const msg = pm.response.json().find(m => m.recipientEmail === pm.environment.get('learnerEmail')
        && m.eventType === 'USER_ENROLLED' && m.subject.includes(pm.environment.get('ntfCourseName')));
      pm.test('Письмо отправлено (status = SENT, есть sentAt)', () => {
        pm.expect(msg.status).to.eql('SENT');
        pm.expect(msg.sentAt).to.be.a('string');
      });
      pm.test('Плейсхолдеры подставлены: {{courseName}} и {{firstName}}', () => {
        pm.expect(msg.subject).to.eql(`You were added to "${pm.environment.get('ntfCourseName')}"`);
        pm.expect(msg.body).to.include('Hi Kantemir');
        pm.expect(msg.body).to.not.include('{{');
      });
    })] }),
  req('NTF-08 · GET /api/notifications/history · learner → 403', 'GET', `${N}/history`, { as: 'learner' }),

  // --- NTF-09: правило с задержкой -> письмо в очереди PENDING, не в истории ---
  req('NTF-09 · POST /api/notifications · правило с задержкой 60 мин → 201', 'POST', N, { as: 'admin',
    json: rule({ name: 'K delayed {{runId}}', eventType: 'USER_ENROLLED', delayMinutes: 60, subjectTemplate: 'Reminder {{courseName}}' }),
    test: saveId('delayedRuleId') }),
  req('NTF-prep · POST /api/courses · второй курс для писем → 201', 'POST', `${B}/api/courses`, { as: 'instructor',
    json: { name: 'K ntf course 2 {{runId}}', active: true }, test: saveId('ntfCourse2Id') }),
  req('NTF-prep · POST /api/courses/{id}/enrollments · записать ученика → 201', 'POST', `${B}/api/courses/{{ntfCourse2Id}}/enrollments`, {
    as: 'instructor', json: { userId: '{{learnerId}}' } }),
  req('NTF-09 · GET /api/notifications/pending · отложенное письмо в очереди → 200', 'GET', `${N}/pending`, { as: 'admin',
    pre: waitFor(`${N}/pending`, 'adminToken', list => list.some(m => m.ruleId === pm.environment.get('delayedRuleId'))),
    test: [...POLL_OK, ...js(() => {
      const msg = pm.response.json().find(m => m.ruleId === pm.environment.get('delayedRuleId'));
      pm.test('status = PENDING', () => pm.expect(msg.status).to.eql('PENDING'));
      pm.test('Отправка запланирована через 60 минут', () => {
        const minutes = (Date.parse(msg.scheduledAt) - Date.parse(msg.createdAt)) / 60000;
        pm.expect(minutes).to.be.within(59, 61);
      });
      pm.environment.set('pendingMessageId', msg.id);
    })] }),
  req('NTF-09 · GET /api/notifications/history · отложенного письма в истории нет → 200', 'GET', `${N}/history`, { as: 'admin',
    test: js(() => {
      pm.test('В истории нет письма по отложенному правилу', () =>
        pm.expect(pm.response.json().some(m => m.ruleId === pm.environment.get('delayedRuleId'))).to.eql(false));
    }) }),

  // --- NTF-12: неизвестный плейсхолдер ---
  req('NTF-12 · POST /api/notifications · шаблон с неизвестным {{foo}} → 201', 'POST', N, { as: 'admin',
    json: rule({ name: 'K foo {{runId}}', eventType: 'COURSE_UPDATED', recipient: 'ACCOUNT_OWNER',
      subjectTemplate: 'K foo [{{foo}}] {{runId}}' }),
    test: saveId('fooRuleId') }),
  req('NTF-prep · PUT /api/courses/{id} · изменить курс (событие COURSE_UPDATED) → 200', 'PUT', `${B}/api/courses/{{ntfCourseId}}`, {
    as: 'instructor', json: { name: 'K ntf course {{runId}} (upd)', active: true } }),
  req('NTF-12 · GET /api/notifications/history · неизвестный плейсхолдер заменён пустой строкой → 200', 'GET', `${N}/history`, { as: 'admin',
    pre: waitFor(`${N}/history`, 'adminToken', list => list.some(m => m.ruleId === pm.environment.get('fooRuleId'))),
    test: [...POLL_OK, ...js(() => {
      const msg = pm.response.json().find(m => m.ruleId === pm.environment.get('fooRuleId'));
      // зафиксировано по факту (§8 «зафиксировать»): {{foo}} превращается в пустую строку, письмо создаётся
      pm.test('Тема: "K foo [] <runId>"', () => pm.expect(msg.subject).to.eql(`K foo [] ${pm.environment.get('runId')}`));
    })] }),
  req('NTF-12 · DELETE /api/notifications/{id} · убрать правило {{foo}} → 204', 'DELETE', `${N}/{{fooRuleId}}`, { as: 'admin' }),

  // --- NTF-10/11: очистка истории не трогает очередь ---
  req('NTF-10 · DELETE /api/notifications/history · learner → 403', 'DELETE', `${N}/history`, { as: 'learner' }),
  req('NTF-10 · DELETE /api/notifications/history → 204', 'DELETE', `${N}/history`, { as: 'admin' }),
  req('NTF-10 · GET /api/notifications/history · после очистки пусто → 200', 'GET', `${N}/history`, { as: 'admin',
    test: js(() => { pm.test('История пуста', () => pm.expect(pm.response.json()).to.eql([])); }) }),
  req('NTF-10 · GET /api/notifications/pending · очередь не тронута → 200', 'GET', `${N}/pending`, { as: 'admin',
    test: js(() => {
      pm.test('Отложенное письмо на месте', () =>
        pm.expect(pm.response.json().map(m => m.id)).to.include(pm.environment.get('pendingMessageId')));
    }) }),
  req('NTF-11 · DELETE /api/notifications/messages/{id} · отложенное письмо → 204', 'DELETE', `${N}/messages/{{pendingMessageId}}`, { as: 'admin' }),
  req('NTF-11 · DELETE /api/notifications/messages/{id} · несуществующее → 404', 'DELETE', `${N}/messages/000000000000000000000000`, { as: 'admin' }),
  req('NTF-09 · DELETE /api/notifications/{id} · убрать правило с задержкой → 204', 'DELETE', `${N}/{{delayedRuleId}}`, { as: 'admin' }),

  // --- §1.4: N1–N8 для всех путей сервиса ---
  sweep('NEG-NTF · N1', 'без токена', 401, withAuth(NTF_PATHS, 'none')),
  sweep('NEG-NTF · N2', 'мусорный токен', 401, withAuth(NTF_PATHS, 'garbage')),
  sweep('NEG-NTF · N3', 'испорченная подпись', 401, withAuth(NTF_PATHS, 'broken')),
  sweep('NEG-NTF · N4', 'instructor (нужен admin)', 403, withAuth(NTF_PATHS, 'instructor')),
  sweep('NEG-NTF · N5', 'несуществующий id', 404, [
    { m: 'GET', p: `/api/notifications/${NO_OID}`, auth: 'admin' },
    { m: 'PUT', p: `/api/notifications/${NO_OID}`, auth: 'admin', body: rule() },
    { m: 'DELETE', p: `/api/notifications/${NO_OID}`, auth: 'admin' },
    { m: 'DELETE', p: `/api/notifications/messages/${NO_OID}`, auth: 'admin' }]),
  // id правил — ObjectId MongoDB; невалидный id ищется как обычная строка и не находится (зафиксировано: 404, не 400)
  sweep('NEG-NTF · N6', 'невалидный id abc · как несуществующий', 404, [
    { m: 'GET', p: '/api/notifications/abc', auth: 'admin' },
    { m: 'PUT', p: '/api/notifications/abc', auth: 'admin', body: rule() },
    { m: 'DELETE', p: '/api/notifications/abc', auth: 'admin' },
    { m: 'DELETE', p: '/api/notifications/messages/abc', auth: 'admin' }]),
  sweep('NEG-NTF · N7', 'неподдерживаемый метод', 405, [
    { m: 'PATCH', p: '/api/notifications', auth: 'admin', body: {} },
    { m: 'POST', p: '/api/notifications/events', auth: 'admin' },
    { m: 'PATCH', p: '/api/notifications/recipients', auth: 'admin', body: {} },
    { m: 'PATCH', p: `/api/notifications/${NO_OID}`, auth: 'admin', body: {} },
    // не PUT: PUT /api/notifications/history попадает в PUT /{id} с id = "history"
    { m: 'PATCH', p: '/api/notifications/history', auth: 'admin', body: {} },
    { m: 'POST', p: '/api/notifications/pending', auth: 'admin' }]),
  sweep('NEG-NTF · N8', 'тело не JSON', 400, [
    { m: 'POST', p: '/api/notifications', auth: 'admin', body: '{name: oops' },
    { m: 'PUT', p: `/api/notifications/${NO_OID}`, auth: 'admin', body: '{name: oops' }]),
]);

// ======================================================================
// 04 analytics-service
// ======================================================================

const A = `${B}/api/analytics`;
const ANL_PATHS = [
  ['GET', '/api/analytics/summary'], ['GET', '/api/analytics/timeline'], ['GET', '/api/analytics/timeline/export'],
  ['GET', '/api/analytics/dashboard'], ['GET', '/api/analytics/overview'], ['GET', '/api/analytics/top-users'],
  ['GET', '/api/analytics/users/{{learnerId}}/activity'], ['GET', '/api/analytics/courses/{{anlCourseId}}/activity']];
const isSortedDesc = js(() => {
  const at = items.map(i => Date.parse(i.occurredAt));
  pm.test('Отсортировано по occurredAt, новые сверху', () => pm.expect(at).to.eql([...at].sort((a, b) => b - a)));
});

const analytics = folder('04 analytics-service',
  'Лента событий (timeline), сводки и графики. Доступ: STAFF (instructor и admin). ' +
  'События приходят из Kafka с задержкой, поэтому «до/после» сравнивается с опросом.', [
  req('ANL-prep · POST /api/courses · курс для аналитики → 201', 'POST', `${B}/api/courses`, { as: 'instructor',
    json: { name: 'K anl course {{runId}}', active: true }, test: saveId('anlCourseId') }),
  req('ANL-prep · POST /api/courses/{id}/enrollments · записать ученика → 201', 'POST', `${B}/api/courses/{{anlCourseId}}/enrollments`, {
    as: 'instructor', json: { userId: '{{learnerId}}' } }),

  req('ANL-01 · GET /api/analytics/timeline · admin → 200', 'GET', `${A}/timeline`, { as: 'admin',
    test: [...js(() => {
      const page = pm.response.json();
      const items = page.items;
      pm.test('Страница: items, total, page, size', () => {
        pm.expect(items).to.be.an('array');
        pm.expect(page.total).to.be.a('number');
        pm.expect(page.page).to.eql(0);
        pm.expect(page.size).to.eql(10);
      });
      pm.test('У событий есть type, description, occurredAt, payload', () => items.forEach(i => {
        pm.expect(i.type).to.be.a('string');
        pm.expect(i.description).to.be.a('string');
        pm.expect(Date.parse(i.occurredAt)).to.not.be.NaN;
        pm.expect(i.payload).to.be.an('object');
      }));
    }), ...isSortedDesc] }),
  req('ANL-01 · GET /api/analytics/timeline · instructor → 200', 'GET', `${A}/timeline`, { as: 'instructor' }),
  req('ANL-01 · GET /api/analytics/timeline · learner → 403', 'GET', `${A}/timeline`, { as: 'learner' }),
  req('ANL-01 · GET /api/analytics/timeline · без токена → 401', 'GET', `${A}/timeline`),
  req('ANL-02 · GET /api/analytics/timeline?type=USER_LOGGED_IN → 200', 'GET', `${A}/timeline?type=USER_LOGGED_IN&size=50`, { as: 'admin',
    test: js(() => {
      const items = pm.response.json().items;
      pm.test('Есть хотя бы один вход', () => pm.expect(items.length).to.be.above(0));
      pm.test('Все события типа USER_LOGGED_IN', () => items.forEach(i => pm.expect(i.type).to.eql('USER_LOGGED_IN')));
    }) }),
  req('ANL-02 · GET /api/analytics/timeline?type=XXX · неизвестный тип → 400', 'GET', `${A}/timeline?type=XXX`, { as: 'admin' }),
  req('ANL-03 · GET /api/analytics/timeline?userId= · события ученика → 200', 'GET', `${A}/timeline?userId={{learnerId}}&size=100`, { as: 'admin',
    test: js(() => {
      const items = pm.response.json().items;
      pm.test('Все события этого ученика', () => items.forEach(i => pm.expect(i.userId).to.eql(pm.environment.get('learnerId'))));
      pm.test('Есть USER_CREATED и USER_LOGGED_IN', () =>
        pm.expect(items.map(i => i.type)).to.include.members(['USER_CREATED', 'USER_LOGGED_IN']));
    }) }),
  req('ANL-04 · GET /api/analytics/timeline?from=&to= · сегодня → 200', 'GET', `${A}/timeline?from={{anlToday}}&to={{anlToday}}&size=100`, { as: 'admin',
    pre: js(() => { pm.environment.set('anlToday', new Date().toISOString().slice(0, 10)); }),
    test: js(() => {
      const day = pm.environment.get('anlToday');
      pm.test('Все события за сегодня (UTC)', () =>
        pm.response.json().items.forEach(i => pm.expect(i.occurredAt.slice(0, 10)).to.eql(day)));
    }) }),
  req('ANL-04 · GET /api/analytics/timeline?from > to · пусто → 200', 'GET', `${A}/timeline?from=2030-01-02&to=2030-01-01`, { as: 'admin',
    test: js(() => {
      // зафиксировано по факту: from > to даёт пустую страницу, а не 400
      pm.test('total = 0, items = []', () => { pm.expect(pm.response.json().total).to.eql(0); pm.expect(pm.response.json().items).to.eql([]); });
    }) }),
  req('ANL-05 · GET /api/analytics/timeline?page=0&size=5 → 200', 'GET', `${A}/timeline?page=0&size=5`, { as: 'admin',
    test: js(() => {
      const items = pm.response.json().items;
      pm.test('Не больше 5 событий', () => pm.expect(items.length).to.be.at.most(5));
      pm.environment.set('anlPage0', JSON.stringify(items.map(i => i.id)));
    }) }),
  req('ANL-05 · GET /api/analytics/timeline?page=1&size=5 · другие события → 200', 'GET', `${A}/timeline?page=1&size=5`, { as: 'admin',
    test: js(() => {
      const first = JSON.parse(pm.environment.get('anlPage0'));
      pm.test('Страница 1 не повторяет страницу 0', () =>
        pm.response.json().items.forEach(i => pm.expect(first).to.not.include(i.id)));
    }) }),
  req('ANL-05 · GET /api/analytics/timeline?size=1000 · ограничено 100 → 200', 'GET', `${A}/timeline?size=1000`, { as: 'admin',
    test: js(() => { pm.test('size урезан до 100', () => pm.expect(pm.response.json().size).to.eql(100)); }) }),
  req('ANL-05 · GET /api/analytics/timeline?page=-1 → 400', 'GET', `${A}/timeline?page=-1`, { as: 'admin' }),
  req('ANL-06 · GET /api/analytics/timeline/export?userId= · CSV → 200', 'GET', `${A}/timeline/export?userId={{learnerId}}`, { as: 'admin',
    test: js(() => {
      const ct = pm.response.headers.get('Content-Type');
      const text = pm.response.text();
      pm.test('Content-Type: text/csv', () => pm.expect(ct).to.include('text/csv'));
      pm.test('Скачивается файлом timeline.csv', () =>
        pm.expect(pm.response.headers.get('Content-Disposition')).to.include('attachment; filename="timeline.csv"'));
      pm.test('Первая строка — заголовки колонок (после BOM)', () =>
        pm.expect(text.replace(/^﻿/, '').split('\n')[0]).to.eql('date,event,user,course,description'));
      const rows = text.trim().split('\n').length - 1;
      pm.sendRequest({ url: pm.variables.replaceIn('{{baseUrl}}/api/analytics/timeline?userId={{learnerId}}&size=1'),
        header: { Authorization: 'Bearer ' + pm.environment.get('adminToken') } }, (err, res) => {
        pm.test('Строк в файле столько же, сколько total в ленте', () => pm.expect(rows).to.eql(res.json().total));
      });
    }) }),
  req('ANL-06 · GET /api/analytics/timeline/export · learner → 403', 'GET', `${A}/timeline/export`, { as: 'learner' }),

  // --- ANL-07, ANL-13, ANL-14: один новый вход -> +1 в сводке и ровно одно событие в ленте ---
  req('ANL-07 · GET /api/analytics/summary · запомнить входы → 200', 'GET', `${A}/summary`, { as: 'admin',
    test: js(() => {
      const s = pm.response.json();
      pm.test('Сводка today/week: logins, courseCompletions, usersWithActivity', () => ['today', 'week'].forEach(p =>
        ['logins', 'courseCompletions', 'usersWithActivity'].forEach(k => {
          pm.expect(s[p][k].value, `${p}.${k}.value`).to.be.a('number');
          pm.expect(s[p][k].previous, `${p}.${k}.previous`).to.be.a('number');
          pm.expect(s[p][k].changePercent, `${p}.${k}.changePercent`).to.be.a('number');
        })));
      pm.environment.set('anlLogins0', s.today.logins.value);
    }) }),
  req('ANL-13 · GET /api/analytics/timeline · запомнить число входов ученика → 200', 'GET',
    `${A}/timeline?userId={{learnerId}}&type=USER_LOGGED_IN&size=1`, { as: 'admin',
    test: js(() => { pm.environment.set('anlUserLogins0', pm.response.json().total); }) }),
  req('ANL-prep · POST /api/auth/login · ученик входит ещё раз → 200', 'POST', `${B}/api/auth/login`, {
    json: { username: '{{learnerUsername}}', password: 'learner123' },
    test: js(() => { pm.environment.set('learnerToken', pm.response.json().token); }) }),
  req('ANL-13 · GET /api/analytics/timeline · вход записан ровно один раз → 200', 'GET',
    `${A}/timeline?userId={{learnerId}}&type=USER_LOGGED_IN&size=1`, { as: 'admin',
    // ждём появления события, потом ещё 2 с: если бы событие записалось дважды, второе успело бы прийти
    pre: waitFor(`${A}/timeline?userId={{learnerId}}&type=USER_LOGGED_IN&size=1`, 'adminToken',
      page => page.total >= Number(pm.environment.get('anlUserLogins0')) + 1, 10000, 2000),
    test: [...POLL_OK, ...js(() => {
      pm.test('Ровно +1 USER_LOGGED_IN (идемпотентность по eventId)', () =>
        pm.expect(pm.response.json().total).to.eql(Number(pm.environment.get('anlUserLogins0')) + 1));
      pm.test('ANL-14 · событие видно в ленте за 5 с', () => pm.expect(Number(pm.environment.get('pollMs'))).to.be.below(5000));
    })] }),
  req('ANL-07 · GET /api/analytics/summary · logins +1 → 200', 'GET', `${A}/summary`, { as: 'admin',
    pre: waitFor(`${A}/summary`, 'adminToken', s => s.today.logins.value >= Number(pm.environment.get('anlLogins0')) + 1),
    test: [...POLL_OK, ...js(() => {
      pm.test('today.logins вырос на 1', () =>
        pm.expect(pm.response.json().today.logins.value).to.eql(Number(pm.environment.get('anlLogins0')) + 1));
    })] }),

  req('ANL-08 · GET /api/analytics/overview → 200', 'GET', `${A}/overview`, { as: 'admin',
    test: js(() => {
      const o = pm.response.json();
      pm.test('eventsByType: число событий по типам', () => pm.expect(o.eventsByType.USER_LOGGED_IN).to.be.above(0));
      pm.test('topUsers — массив', () => pm.expect(o.topUsers).to.be.an('array'));
    }) }),
  ...[['today', 24], ['yesterday', 24], ['week', 7], ['month', 30]].map(([period, points]) =>
    req(`ANL-09 · GET /api/analytics/dashboard?period=${period} · ${points} точек → 200`, 'GET', `${A}/dashboard?period=${period}`, { as: 'admin',
      test: js(() => {
        const d = pm.response.json();
        pm.test('__N__ точек на графике', () => pm.expect(d.labels).to.have.length(__N__));
        pm.test('labels, logins, completions одной длины', () => {
          pm.expect(d.logins).to.have.length(d.labels.length);
          pm.expect(d.completions).to.have.length(d.labels.length);
        });
      }).map(l => l.replace(/__N__/g, points)) })),
  req('ANL-09 · GET /api/analytics/dashboard?period=year · неизвестный период → 400', 'GET', `${A}/dashboard?period=year`, { as: 'admin' }),
  req('ANL-10 · GET /api/analytics/top-users?limit=3 → 200', 'GET', `${A}/top-users?limit=3`, { as: 'admin',
    test: js(() => {
      const top = pm.response.json();
      pm.test('Не больше 3', () => pm.expect(top.length).to.be.at.most(3));
      pm.test('По убыванию активности', () => pm.expect(top.map(t => t.score)).to.eql(top.map(t => t.score).sort((a, b) => b - a)));
    }) }),
  req('ANL-11 · GET /api/analytics/users/{id}/activity · ученик → 200', 'GET', `${A}/users/{{learnerId}}/activity`, { as: 'instructor',
    test: js(() => {
      const a = pm.response.json();
      pm.test('labels, logins, completions одной длины', () => {
        pm.expect(a.logins).to.have.length(a.labels.length);
        pm.expect(a.completions).to.have.length(a.labels.length);
      });
      pm.test('За неделю есть входы', () => pm.expect(a.loginsLastWeek).to.be.above(0));
    }) }),
  req('ANL-11 · GET /api/analytics/users/{id}/activity · learner → 403', 'GET', `${A}/users/{{learnerId}}/activity`, { as: 'learner' }),
  req('ANL-11 · GET /api/analytics/users/{id}/activity · несуществующий id · нули → 200', 'GET',
    `${A}/users/00000000-0000-0000-0000-000000000000/activity`, { as: 'admin',
    test: js(() => {
      // зафиксировано по факту: для неизвестного пользователя 200 с нулями, а не 404
      pm.test('Все счётчики нулевые', () => {
        const a = pm.response.json();
        pm.expect(a.logins.every(v => v === 0)).to.eql(true);
        pm.expect(a.loginsLastMonth).to.eql(0);
      });
    }) }),
  req('ANL-12 · GET /api/analytics/courses/{id}/activity · запись на курс видна → 200', 'GET', `${A}/courses/{{anlCourseId}}/activity`, {
    as: 'instructor',
    pre: waitFor(`${A}/courses/{{anlCourseId}}/activity`, 'instructorToken', a => a.logins.reduce((s, v) => s + v, 0) >= 1),
    test: [...POLL_OK, ...js(() => {
      const a = pm.response.json();
      // в отчёте по курсу первая серия (logins) — это записи на курс, вторая — завершения
      pm.test('Одна запись на курс, ноль завершений', () => {
        pm.expect(a.logins.reduce((s, v) => s + v, 0)).to.eql(1);
        pm.expect(a.completions.reduce((s, v) => s + v, 0)).to.eql(0);
      });
    })] }),
  req('ANL-12 · GET /api/analytics/courses/{id}/activity · learner → 403', 'GET', `${A}/courses/{{anlCourseId}}/activity`, { as: 'learner' }),

  // --- §1.4: N1–N8 для всех путей сервиса (N8 не применим: у сервиса нет запросов с телом) ---
  sweep('NEG-ANL · N1', 'без токена', 401, withAuth(ANL_PATHS, 'none')),
  sweep('NEG-ANL · N2', 'мусорный токен', 401, withAuth(ANL_PATHS, 'garbage')),
  sweep('NEG-ANL · N3', 'испорченная подпись', 401, withAuth(ANL_PATHS, 'broken')),
  sweep('NEG-ANL · N4', 'learner (нужен staff)', 403, withAuth(ANL_PATHS, 'learner')),
  // ANL-11 в чек-листе разрешает «200 с нулями или 404 — зафиксировать»: зафиксировано 200 с нулями
  sweep('NEG-ANL · N5', 'несуществующий id · нули', 200, [
    { m: 'GET', p: `/api/analytics/users/${NO_UUID}/activity`, auth: 'instructor' },
    { m: 'GET', p: `/api/analytics/courses/${NO_UUID}/activity`, auth: 'instructor' }]),
  sweep('NEG-ANL · N6', 'невалидный UUID abc', 400, [
    { m: 'GET', p: '/api/analytics/users/abc/activity', auth: 'instructor' },
    { m: 'GET', p: '/api/analytics/courses/abc/activity', auth: 'instructor' }]),
  sweep('NEG-ANL · N7', 'неподдерживаемый метод', 405, [
    { m: 'POST', p: '/api/analytics/timeline', auth: 'admin' },
    { m: 'POST', p: '/api/analytics/summary', auth: 'admin' },
    { m: 'POST', p: '/api/analytics/dashboard', auth: 'admin' },
    { m: 'POST', p: '/api/analytics/overview', auth: 'admin' },
    { m: 'DELETE', p: '/api/analytics/top-users', auth: 'admin' },
    { m: 'PUT', p: '/api/analytics/timeline/export', auth: 'admin', body: {} }]),
]);

// ======================================================================
// 05 gamification-service
// ======================================================================

const G = `${B}/api/gamification`;
const GAM_PATHS = [
  ['GET', '/api/gamification/me'], ['GET', '/api/gamification/config'], ['GET', '/api/gamification/rules'],
  ['GET', '/api/gamification/leaderboard'], ['GET', '/api/gamification/users/{{learnerId}}'],
  ['GET', '/api/gamification/settings'], ['PUT', '/api/gamification/settings', {}],
  ['POST', '/api/gamification/settings/reset'], ['POST', '/api/gamification/reset-statistics']];
const ME = `${G}/me`;

/** Запомнить очки, уроки и курсы ученика до действия. */
const snapshot = id => req(`${id} · GET /api/gamification/me · запомнить очки до действия → 200`, 'GET', ME, { as: 'learner',
  test: js(() => {
    const me = pm.response.json();
    pm.environment.set('gamP0', me.points);
    pm.environment.set('gamU0', me.units);
    pm.environment.set('gamC0', me.courses);
    pm.environment.set('gamMark', new Date().toISOString());
  }) });

const passUnit = (id, n) => [
  req(`${id} · POST /api/units/{id}/start · открыть урок ${n} → 200`, 'POST', `${B}/api/units/{{gamUnit${n}}}/start`, { as: 'learner' }),
  req(`${id} · POST /api/units/{id}/complete · пройти урок ${n} → 200`, 'POST', `${B}/api/units/{{gamUnit${n}}}/complete`, { as: 'learner', json: {} }),
];

/** Тело PUT /settings: настройки из GAM-10, изменённые функцией change(s). */
const settingsBody = change => [...js(() => {
  const s = JSON.parse(pm.environment.get('gamSettings'));
}), `(${change.toString()})(s);`, `pm.variables.set('gamBody', JSON.stringify(s));`];

const gamification = folder('05 gamification-service',
  'Очки, уровни, бейджи и рейтинг. Ученик проходит 4 урока курса, между уроками меняем настройки. ' +
  'В конце папки настройки сбрасываются (GAM-15), а статистика обнуляется (GAM-16). ' +
  'Не покрыто здесь: +20 за сданный тест (это E2E-6 у Ainura) и повторная доставка события (E2E-7, вручную).', [
  req('GAM-prep · POST /api/courses · курс из 4 уроков → 201', 'POST', `${B}/api/courses`, { as: 'instructor',
    json: { name: 'K gam course {{runId}}', active: true }, test: saveId('gamCourseId') }),
  ...[1, 2, 3, 4].map(n => req(`GAM-prep · POST /api/courses/{id}/units · урок ${n} → 201`, 'POST', `${B}/api/courses/{{gamCourseId}}/units`, {
    as: 'instructor', form: unitForm(`K unit ${n} {{runId}}`), test: saveId(`gamUnit${n}`) })),
  req('GAM-prep · POST /api/courses/{id}/enrollments · записать ученика → 201', 'POST', `${B}/api/courses/{{gamCourseId}}/enrollments`, {
    as: 'instructor', json: { userId: '{{learnerId}}' } }),

  req('GAM-01 · GET /api/gamification/me · профиль ученика → 200', 'GET', ME, { as: 'learner',
    pre: waitFor(ME, 'learnerToken', me => me.logins >= 1),
    test: js(() => {
      const me = pm.response.json();
      pm.test('Все поля профиля', () => {
        ['points', 'level', 'logins', 'units', 'courses'].forEach(k => pm.expect(me[k], k).to.be.a('number'));
        pm.expect(me.badges).to.be.an('array');
        pm.expect(me.history).to.be.an('array');
        pm.expect(me.enabled).to.be.a('boolean');
        pm.expect(me).to.have.property('rank');
        pm.expect(me).to.have.property('nextLevelPoints');
      });
      pm.test('Это профиль самого ученика', () => pm.expect(me.userId).to.eql(pm.environment.get('learnerId')));
    }) }),
  req('GAM-01 · GET /api/gamification/me · без токена → 401', 'GET', ME),
  req('GAM-02 · GET /api/gamification/me · первый вход дал +10 и бейдж newcomer → 200', 'GET', ME, { as: 'learner',
    test: js(() => {
      const me = pm.response.json();
      const signIns = me.history.filter(h => h.action === 'Sign in');
      pm.test('Одна запись «Sign in» на 10 очков', () => {
        pm.expect(signIns).to.have.length(1);
        pm.expect(signIns[0].points).to.eql(10);
      });
      pm.test('Бейдж newcomer', () => pm.expect(me.badges.map(b => b.code)).to.include('newcomer'));
    }) }),
  req('GAM-02 · POST /api/auth/login · ещё один вход в тот же день → 200', 'POST', `${B}/api/auth/login`, {
    json: { username: '{{learnerUsername}}', password: 'learner123' },
    pre: js(() => { pm.environment.set('gamMark', new Date().toISOString()); }),
    test: js(() => { pm.environment.set('learnerToken', pm.response.json().token); }) }),
  req('GAM-02 · GET /api/gamification/me · повторный вход за день очков не даёт → 200', 'GET', ME, { as: 'learner',
    // ждём, пока событие входа дойдёт до аналитики (значит, Kafka его доставила), и ещё 1,5 с на геймификацию
    pre: waitFor(`${A}/timeline?userId={{learnerId}}&type=USER_LOGGED_IN&size=1`, 'adminToken',
      page => page.items.length && page.items[0].occurredAt > pm.environment.get('gamMark'), 10000, 1500),
    test: [...POLL_OK, ...js(() => {
      const me = pm.response.json();
      pm.test('Всё ещё одна запись «Sign in», logins = 1', () => {
        pm.expect(me.history.filter(h => h.action === 'Sign in')).to.have.length(1);
        pm.expect(me.logins).to.eql(1);
      });
    })] }),

  snapshot('GAM-03'),
  ...passUnit('GAM-03', 1),
  req('GAM-03 · GET /api/gamification/me · урок дал +15 и бейдж first-step → 200', 'GET', ME, { as: 'learner',
    pre: waitFor(ME, 'learnerToken', me => me.units >= Number(pm.environment.get('gamU0')) + 1),
    test: [...POLL_OK, ...js(() => {
      const me = pm.response.json();
      pm.test('+15 очков', () => pm.expect(me.points).to.eql(Number(pm.environment.get('gamP0')) + 15));
      pm.test('Бейдж first-step', () => pm.expect(me.badges.map(b => b.code)).to.include('first-step'));
      pm.environment.set('gamPoints', me.points);
    })] }),

  req('GAM-06 · GET /api/gamification/users/{id} · instructor → 200', 'GET', `${G}/users/{{learnerId}}`, { as: 'instructor',
    test: js(() => {
      pm.test('Те же очки, что видит сам ученик', () =>
        pm.expect(pm.response.json().points).to.eql(Number(pm.environment.get('gamPoints'))));
    }) }),
  req('GAM-06 · GET /api/gamification/users/{id} · learner → 403', 'GET', `${G}/users/{{learnerId}}`, { as: 'learner' }),
  req('GAM-06 · GET /api/gamification/users/{id} · невалидный UUID abc → 400', 'GET', `${G}/users/abc`, { as: 'instructor' }),
  req('GAM-07 · GET /api/gamification/leaderboard?by=points&limit=3 → 200', 'GET', `${G}/leaderboard?by=points&limit=3`, { as: 'learner',
    test: js(() => {
      const board = pm.response.json();
      pm.test('Не больше 3 строк', () => pm.expect(board.top.length).to.be.at.most(3));
      pm.test('Места 1, 2, 3 по убыванию очков', () => {
        pm.expect(board.top.map(e => e.rank)).to.eql(board.top.map((e, i) => i + 1));
        pm.expect(board.top.map(e => e.score)).to.eql(board.top.map(e => e.score).sort((a, b) => b - a));
      });
      pm.test('Строка ученика (me) есть', () => {
        pm.expect(board.me.userId).to.eql(pm.environment.get('learnerId'));
        pm.expect(board.me.score).to.eql(Number(pm.environment.get('gamPoints')));
      });
      pm.environment.set('gamTopPoints', JSON.stringify(board.top.map(e => e.userId)));
    }) }),
  req('GAM-07 · GET /api/gamification/leaderboard?by=xxx · считается по очкам → 200', 'GET', `${G}/leaderboard?by=xxx&limit=3`, { as: 'learner',
    test: js(() => {
      pm.test('Тот же топ, что by=points', () =>
        pm.expect(pm.response.json().top.map(e => e.userId)).to.eql(JSON.parse(pm.environment.get('gamTopPoints'))));
    }) }),
  req('GAM-07 · GET /api/gamification/leaderboard?limit=100 · не больше 50 → 200', 'GET', `${G}/leaderboard?limit=100`, { as: 'learner',
    test: js(() => { pm.test('top ≤ 50', () => pm.expect(pm.response.json().top.length).to.be.at.most(50)); }) }),
  req('GAM-08 · GET /api/gamification/rules → 200', 'GET', `${G}/rules`, { as: 'learner',
    test: js(() => {
      const r = pm.response.json();
      pm.test('points[], levels[], badges[]', () => ['points', 'levels', 'badges'].forEach(k => pm.expect(r[k], k).to.be.an('array')));
      pm.test('first-step получен, master — нет', () => {
        pm.expect(r.badges.find(b => b.code === 'first-step').earned).to.eql(true);
        pm.expect(r.badges.find(b => b.code === 'master').earned).to.eql(false);
      });
    }) }),
  req('GAM-09 · GET /api/gamification/config → 200', 'GET', `${G}/config`, { as: 'learner',
    test: js(() => {
      const c = pm.response.json();
      pm.test('enabled, points, badges, levels — флаги', () => ['enabled', 'points', 'badges', 'levels'].forEach(k => pm.expect(c[k], k).to.be.a('boolean')));
      pm.test('leaderboard — объект', () => pm.expect(c.leaderboard).to.be.an('object'));
    }) }),
  req('GAM-10 · GET /api/gamification/settings · admin → 200', 'GET', `${G}/settings`, { as: 'admin',
    test: js(() => {
      const s = pm.response.json();
      pm.test('Документ целиком: points, badges, levels, leaderboard', () =>
        ['points', 'badges', 'levels', 'leaderboard'].forEach(k => pm.expect(s[k], k).to.be.an('object')));
      pm.environment.set('gamSettings', JSON.stringify(s));
    }) }),
  req('GAM-10 · GET /api/gamification/settings · instructor → 403', 'GET', `${G}/settings`, { as: 'instructor' }),
  req('GAM-10 · GET /api/gamification/settings · learner → 403', 'GET', `${G}/settings`, { as: 'learner' }),

  req('GAM-11 · PUT /api/gamification/settings · за урок 99 очков → 200', 'PUT', `${G}/settings`, { as: 'admin', json: '{{gamBody}}',
    pre: settingsBody(s => { s.points.unit.points = 99; }),
    test: js(() => { pm.test('points.unit.points = 99', () => pm.expect(pm.response.json().points.unit.points).to.eql(99)); }) }),
  req('GAM-11 · PUT /api/gamification/settings · instructor → 403', 'PUT', `${G}/settings`, { as: 'instructor', json: '{{gamBody}}' }),
  snapshot('GAM-11'),
  ...passUnit('GAM-11', 2),
  req('GAM-11 · GET /api/gamification/me · урок дал 99 очков → 200', 'GET', ME, { as: 'learner',
    pre: waitFor(ME, 'learnerToken', me => me.units >= Number(pm.environment.get('gamU0')) + 1),
    test: [...POLL_OK, ...js(() => {
      const me = pm.response.json();
      pm.test('+99 очков', () => pm.expect(me.points).to.eql(Number(pm.environment.get('gamP0')) + 99));
      pm.test('В истории «Unit completed» на 99', () =>
        pm.expect(me.history.find(h => h.action === 'Unit completed').points).to.eql(99));
    })] }),

  req('GAM-12 · PUT /api/gamification/settings · выключить игру → 200', 'PUT', `${G}/settings`, { as: 'admin', json: '{{gamBody}}',
    pre: settingsBody(s => { s.enabled = false; }) }),
  req('GAM-12 · GET /api/gamification/config · enabled = false → 200', 'GET', `${G}/config`, { as: 'learner',
    test: js(() => { pm.test('enabled = false', () => pm.expect(pm.response.json().enabled).to.eql(false)); }) }),
  snapshot('GAM-12'),
  ...passUnit('GAM-12', 3),
  req('GAM-12 · GET /api/gamification/me · при выключенной игре очков нет → 200', 'GET', ME, { as: 'learner',
    // доказательство, что событие было: аналитика его записала; потом ещё 1,5 с на геймификацию
    pre: waitFor(`${A}/timeline?userId={{learnerId}}&type=UNIT_COMPLETED&size=5`, 'adminToken',
      page => page.items.some(i => i.payload.unitName === `K unit 3 ${pm.environment.get('runId')}`), 10000, 1500),
    test: [...POLL_OK, ...js(() => {
      const me = pm.response.json();
      pm.test('Очки и счётчик уроков не изменились', () => {
        pm.expect(me.points).to.eql(Number(pm.environment.get('gamP0')));
        pm.expect(me.units).to.eql(Number(pm.environment.get('gamU0')));
      });
    })] }),

  req('GAM-13 · PUT /api/gamification/settings · скрыть бейджи в рейтинге → 200', 'PUT', `${G}/settings`, { as: 'admin', json: '{{gamBody}}',
    pre: settingsBody(s => { s.leaderboard.showBadges = false; }) }),
  req('GAM-13 · GET /api/gamification/config · showBadges = false → 200', 'GET', `${G}/config`, { as: 'learner',
    test: js(() => {
      const c = pm.response.json();
      pm.test('leaderboard.showBadges = false', () => pm.expect(c.leaderboard.showBadges).to.eql(false));
      pm.test('Игра снова включена', () => pm.expect(c.enabled).to.eql(true));
    }) }),

  req('GAM-14 · PUT /api/gamification/settings · новый уровень каждые 50 очков → 200', 'PUT', `${G}/settings`, { as: 'admin', json: '{{gamBody}}',
    pre: settingsBody(s => { s.levels.byPoints.every = 50; }) }),
  snapshot('GAM-14'),
  ...passUnit('GAM-14', 4),
  req('GAM-14 · GET /api/gamification/me · уровень пересчитан → 200', 'GET', ME, { as: 'learner',
    // последний урок завершает курс: придут UNIT_COMPLETED (+15), COURSE_COMPLETED (+100), CERTIFICATE_ISSUED (+50)
    pre: waitFor(ME, 'learnerToken', me => me.points >= Number(pm.environment.get('gamP0')) + 165),
    test: [...POLL_OK, ...js(() => {
      const me = pm.response.json();
      const expected = Math.min(20, Math.max(1 + Math.floor(me.points / 50), 1 + Math.floor(me.courses / 5), 1 + Math.floor(me.badges.length / 5)));
      pm.test(`level = ${expected} (1 + очки / 50)`, () => pm.expect(me.level).to.eql(expected));
      pm.test('nextLevelPoints = level × 50', () => pm.expect(me.nextLevelPoints).to.eql(me.level * 50));
    })] }),
  req('GAM-04 · GET /api/gamification/me · курс дал +100 и бейдж graduate → 200', 'GET', ME, { as: 'learner',
    test: js(() => {
      const me = pm.response.json();
      pm.test('«Course completed» на 100 очков', () => pm.expect(me.history.find(h => h.action === 'Course completed').points).to.eql(100));
      pm.test('Бейдж graduate', () => pm.expect(me.badges.map(b => b.code)).to.include('graduate'));
      pm.test('courses +1', () => pm.expect(me.courses).to.eql(Number(pm.environment.get('gamC0')) + 1));
    }) }),
  req('GAM-05 · GET /api/gamification/me · сертификат дал +50 → 200', 'GET', ME, { as: 'learner',
    test: js(() => {
      pm.test('«Certificate» на 50 очков', () =>
        pm.expect(pm.response.json().history.find(h => h.action === 'Certificate').points).to.eql(50));
    }) }),

  // --- GAM-05: тест — проваленный не даёт очков, сданный даёт +20 ---
  req('GAM-prep · POST /api/courses · курс с тестом → 201', 'POST', `${B}/api/courses`, { as: 'instructor',
    json: { name: 'K gam test course {{runId}}', active: true }, test: saveId('gamTestCourseId') }),
  req('GAM-prep · POST /api/courses/{id}/questions · вопрос «2 + 2» → 201', 'POST', `${B}/api/courses/{{gamTestCourseId}}/questions`, {
    as: 'instructor', json: { type: 'MULTIPLE_CHOICE', text: '2 + 2 = ?', data: { answers: [{ text: '4', correct: true }, { text: '5', correct: false }] } },
    test: saveId('gamQuestionId') }),
  req('GAM-prep · POST /api/courses/{id}/tests · тест из одного вопроса → 201', 'POST', `${B}/api/courses/{{gamTestCourseId}}/tests`, {
    as: 'instructor', json: { name: 'K gam test {{runId}}', passScore: 100, repetitions: 'ALWAYS', questions: [{ questionId: '{{gamQuestionId}}', weight: 1 }] },
    test: js(() => { pm.environment.set('gamTestUnitId', pm.response.json().unitId); }) }),
  req('GAM-prep · POST /api/courses/{id}/enrollments · записать ученика → 201', 'POST', `${B}/api/courses/{{gamTestCourseId}}/enrollments`, {
    as: 'instructor', json: { userId: '{{learnerId}}' } }),
  req('GAM-05 · POST /api/units/{id}/test/attempts · первая попытка → 201', 'POST', `${B}/api/units/{{gamTestUnitId}}/test/attempts`, {
    as: 'learner', test: saveId('gamAttempt1') }),
  req('GAM-05 · POST …/attempts/{id}/submit · неверный ответ → 200', 'POST', `${B}/api/units/{{gamTestUnitId}}/test/attempts/{{gamAttempt1}}/submit`, {
    as: 'learner', json: '{ "answers": { "{{gamQuestionId}}": 1 } }',
    test: js(() => { pm.test('Тест не сдан', () => pm.expect(pm.response.json().passed).to.eql(false)); }) }),
  req('GAM-05 · GET /api/gamification/me · проваленный тест очков не даёт → 200', 'GET', ME, { as: 'learner',
    pre: waitFor(`${A}/timeline?userId={{learnerId}}&type=TEST_COMPLETED&size=5`, 'adminToken',
      page => page.items.some(i => i.payload.unitId === pm.environment.get('gamTestUnitId') && i.payload.passed === 'false'), 10000, 1500),
    test: [...POLL_OK, ...js(() => {
      pm.test('Нет записи «Test passed»', () =>
        pm.expect(pm.response.json().history.filter(h => h.action === 'Test passed')).to.have.length(0));
    })] }),
  req('GAM-05 · POST /api/units/{id}/test/attempts · вторая попытка → 201', 'POST', `${B}/api/units/{{gamTestUnitId}}/test/attempts`, {
    as: 'learner', test: saveId('gamAttempt2') }),
  req('GAM-05 · POST …/attempts/{id}/submit · верный ответ → 200', 'POST', `${B}/api/units/{{gamTestUnitId}}/test/attempts/{{gamAttempt2}}/submit`, {
    as: 'learner', json: '{ "answers": { "{{gamQuestionId}}": 0 } }',
    test: js(() => { pm.test('Тест сдан', () => pm.expect(pm.response.json().passed).to.eql(true)); }) }),
  req('GAM-05 · GET /api/gamification/me · сданный тест дал +20 → 200', 'GET', ME, { as: 'learner',
    pre: waitFor(ME, 'learnerToken', me => me.history.some(h => h.action === 'Test passed')),
    test: [...POLL_OK, ...js(() => {
      const passed = pm.response.json().history.filter(h => h.action === 'Test passed');
      pm.test('Одна запись «Test passed» на 20 очков', () => {
        pm.expect(passed).to.have.length(1);
        pm.expect(passed[0].points).to.eql(20);
      });
    })] }),

  req('GAM-15 · POST /api/gamification/settings/reset · instructor → 403', 'POST', `${G}/settings/reset`, { as: 'instructor' }),
  req('GAM-15 · POST /api/gamification/settings/reset · значения по умолчанию → 200', 'POST', `${G}/settings/reset`, { as: 'admin',
    test: js(() => {
      const s = pm.response.json();
      pm.test('Очки: вход 10, урок 15, курс 100, сертификат 50, тест 20', () => {
        pm.expect([s.points.login.points, s.points.unit.points, s.points.course.points, s.points.certificate.points, s.points.test.points])
          .to.eql([10, 15, 100, 50, 20]);
      });
      pm.test('Игра включена, уровень каждые 300 очков', () => {
        pm.expect(s.enabled).to.eql(true);
        pm.expect(s.levels.byPoints.every).to.eql(300);
      });
    }) }),
  req('GAM-16 · POST /api/gamification/reset-statistics · instructor → 403', 'POST', `${G}/reset-statistics`, { as: 'instructor' }),
  req('GAM-16 · POST /api/gamification/reset-statistics → 204', 'POST', `${G}/reset-statistics`, { as: 'admin' }),
  req('GAM-16 · GET /api/gamification/me · очки обнулены → 200', 'GET', ME, { as: 'learner',
    test: js(() => {
      const me = pm.response.json();
      pm.test('points = 0, бейджей нет, места в рейтинге нет', () => {
        pm.expect(me.points).to.eql(0);
        pm.expect(me.badges).to.eql([]);
        pm.expect(me.rank).to.eql(null);
      });
    }) }),
  req('GAM-16 · GET /api/gamification/leaderboard · рейтинг пуст → 200', 'GET', `${G}/leaderboard`, { as: 'learner',
    test: js(() => { pm.test('top = []', () => pm.expect(pm.response.json().top).to.eql([])); }) }),

  // --- §1.4: N1–N8 для всех путей сервиса (запросы с отказом не меняют данные: до сервиса они не доходят) ---
  sweep('NEG-GAM · N1', 'без токена', 401, withAuth(GAM_PATHS, 'none')),
  sweep('NEG-GAM · N2', 'мусорный токен', 401, withAuth(GAM_PATHS, 'garbage')),
  sweep('NEG-GAM · N3', 'испорченная подпись', 401, withAuth(GAM_PATHS, 'broken')),
  sweep('NEG-GAM · N4', 'роль ниже требуемой', 403, [
    { m: 'GET', p: '/api/gamification/settings', auth: 'instructor' },
    { m: 'PUT', p: '/api/gamification/settings', auth: 'instructor', body: {} },
    { m: 'POST', p: '/api/gamification/settings/reset', auth: 'instructor' },
    { m: 'POST', p: '/api/gamification/reset-statistics', auth: 'instructor' },
    { m: 'GET', p: '/api/gamification/settings', auth: 'learner' },
    { m: 'GET', p: '/api/gamification/users/{{learnerId}}', auth: 'learner' }]),
  sweep('NEG-GAM · N5', 'несуществующий пользователь', 404, [
    { m: 'GET', p: `/api/gamification/users/${NO_UUID}`, auth: 'instructor' }]),
  sweep('NEG-GAM · N6', 'невалидный UUID abc', 400, [
    { m: 'GET', p: '/api/gamification/users/abc', auth: 'instructor' }]),
  sweep('NEG-GAM · N7', 'неподдерживаемый метод', 405, [
    { m: 'POST', p: '/api/gamification/me', auth: 'learner' },
    { m: 'PATCH', p: '/api/gamification/settings', auth: 'admin', body: {} },
    { m: 'DELETE', p: '/api/gamification/settings', auth: 'admin' },
    { m: 'POST', p: '/api/gamification/config', auth: 'learner' },
    { m: 'POST', p: '/api/gamification/leaderboard', auth: 'learner' },
    { m: 'POST', p: '/api/gamification/rules', auth: 'learner' },
    { m: 'GET', p: '/api/gamification/reset-statistics', auth: 'admin' }]),
  sweep('NEG-GAM · N8', 'тело не JSON', 400, [
    { m: 'PUT', p: '/api/gamification/settings', auth: 'admin', body: '{enabled: oops' }]),
]);

// ======================================================================
// 06 security
// ======================================================================

const JWT_LIB = js(() => {
  // Сборка JWT вручную: header.payload.signature, всё в base64url, подпись HMAC-SHA384.
  const cryptoJs = require('crypto-js');
  const b64url = s => s.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  const enc = obj => b64url(btoa(JSON.stringify(obj)));
  const dec = part => JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - part.length % 4) % 4)));
  const sign = (data, secret) => b64url(cryptoJs.enc.Base64.stringify(cryptoJs.HmacSHA384(data, secret)));
  function makeJwt(payload, secret) {
    const data = enc({ alg: 'HS384' }) + '.' + enc(payload);
    return data + '.' + sign(data, secret);
  }
  const learnerClaims = () => dec(pm.environment.get('learnerToken').split('.')[1]);
  // учебный секрет по умолчанию из services/api-gateway/src/main/resources/application.yml (jwt.secret);
  // если стенд поднят с другим JWT_SECRET, задайте переменную jwtSecret в окружении
  const jwtSecret = pm.environment.get('jwtSecret') || 'jazzlms-super-secret-key-for-teaching-purposes-only-32b';
});
const bearerVar = v => [{ key: 'Authorization', value: `Bearer {{${v}}}` }];

const DIRECT = [
  ['userSvc', '/api/users'], ['courseSvc', '/api/courses'], ['notifSvc', '/api/notifications'],
  ['analyticsSvc', '/api/analytics/summary'], ['gameSvc', '/api/gamification/me']];
const DIRECT_401 = js(() => {
  pm.test('Заголовок WWW-Authenticate: Bearer', () => pm.expect(pm.response.headers.get('WWW-Authenticate')).to.eql('Bearer'));
});

const MATRIX = [ // путь, метод, тело, [learner, instructor, admin]; true = gateway пропускает
  ['GET', '/api/users', null, [false, true, true]],
  ['POST', '/api/users', {}, [false, false, true]],
  ['GET', '/api/settings', null, [false, false, true]],
  ['POST', '/api/branches', {}, [false, false, true]],
  ['GET', '/api/branches', null, [false, true, true]],
  ['POST', '/api/courses', {}, [false, true, true]],
  ['GET', '/api/courses', null, [true, true, true]],
  ['POST', '/api/courses/{{courseId}}/enroll', null, [true, true, true]],
  ['GET', '/api/courses/deleted', null, [false, false, true]],
  ['GET', '/api/courses/{{courseId}}/questions', null, [false, true, true]],
  ['POST', '/api/units/{{secUnitId}}/test/attempts', null, [true, true, true]],
  ['GET', '/api/notifications', null, [false, false, true]],
  ['GET', '/api/analytics/timeline', null, [false, true, true]],
  ['GET', '/api/gamification/settings', null, [false, false, true]],
  ['GET', '/api/gamification/me', null, [true, true, true]],
  ['GET', '/api/certificates/templates', null, [false, true, true]],
  ['POST', '/api/certificates/templates', {}, [false, false, true]],
];

const security = folder('06 security',
  'SEC-01 прямой доступ в сервисы (порты 8081–8085) — только администратор. SEC-02 подделка заголовков. ' +
  'SEC-03 испорченные и чужие токены. SEC-04 матрица ролей gateway: «пропущен gateway» значит, что gateway не отказал ' +
  '(дальше бизнес-ответ сервиса, например 400 на пустое тело), «403» — gateway отказал. SEC-05 лимит запросов, SEC-06 неизвестный путь.', [
  ...DIRECT.flatMap(([svc, p]) => [
    req(`SEC-01 · GET {{${svc}}}${p} напрямую · без токена → 401`, 'GET', `{{${svc}}}${p}`, { test: DIRECT_401 }),
    req(`SEC-01 · GET {{${svc}}}${p} напрямую · мусорный токен → 401`, 'GET', `{{${svc}}}${p}`, {
      headers: [{ key: 'Authorization', value: 'Bearer abc.def.ghi' }], test: DIRECT_401 }),
    req(`SEC-01 · GET {{${svc}}}${p} напрямую · learner → 401`, 'GET', `{{${svc}}}${p}`, { as: 'learner',
      test: [...DIRECT_401, ...js(() => {
        pm.test('detail: «administrators only»', () => pm.expect(pm.response.json().detail).to.include('administrators only'));
      })] }),
    req(`SEC-01 · GET {{${svc}}}${p} напрямую · instructor → 401`, 'GET', `{{${svc}}}${p}`, { as: 'instructor', test: DIRECT_401 }),
    req(`SEC-01 · GET {{${svc}}}${p} напрямую · admin → 200`, 'GET', `{{${svc}}}${p}`, { as: 'admin' }),
  ]),
  req('SEC-01 · POST {{userSvc}}/api/auth/login напрямую · публичный → 200', 'POST', '{{userSvc}}/api/auth/login', {
    json: { username: 'admin', password: 'admin123' } }),
  req('SEC-01 · GET {{userSvc}}/swagger-ui/index.html · публичный → 200', 'GET', '{{userSvc}}/swagger-ui/index.html'),
  req('SEC-01 · GET {{userSvc}}/actuator/health · публичный → 200', 'GET', '{{userSvc}}/actuator/health',
    { test: js(() => { pm.test('status = UP', () => pm.expect(pm.response.json().status).to.eql('UP')); }) }),

  req('SEC-02 · GET {{userSvc}}/api/users напрямую · X-User-Role: SUPER_ADMIN без токена → 401', 'GET', '{{userSvc}}/api/users', {
    headers: [{ key: 'X-User-Role', value: 'SUPER_ADMIN' }] }),
  req('SEC-02 · GET /api/users · learner + X-User-Role: SUPER_ADMIN → 403', 'GET', `${B}/api/users`, { as: 'learner',
    headers: [{ key: 'X-User-Role', value: 'SUPER_ADMIN' }] }),
  req('SEC-02 · GET /api/auth/me · learner + чужой X-User-Id → 200', 'GET', `${B}/api/auth/me`, { as: 'learner',
    headers: [{ key: 'X-User-Id', value: '{{adminId}}' }],
    test: js(() => { pm.test('В ответе сам ученик, а не admin', () => pm.expect(pm.response.json().id).to.eql(pm.environment.get('learnerId'))); }) }),
  req('SEC-02 · GET {{gameSvc}}/api/gamification/me напрямую · admin + чужой X-User-Id → 200', 'GET', '{{gameSvc}}/api/gamification/me', {
    as: 'admin', headers: [{ key: 'X-User-Id', value: '{{learnerId}}' }],
    test: js(() => { pm.test('Профиль admin: личность берётся из токена', () => pm.expect(pm.response.json().userId).to.eql(pm.environment.get('adminId'))); }) }),
  req('SEC-02 · GET {{userSvc}}/api/users напрямую · learner + X-Gateway-Token наугад → 401', 'GET', '{{userSvc}}/api/users', {
    as: 'learner', headers: [{ key: 'X-Gateway-Token', value: 'guess-123' }] }),

  req('SEC-03 · GET /api/courses · исправный токен, собранный вручную · контроль → 200', 'GET', `${B}/api/courses`, {
    headers: bearerVar('secToken'),
    // контроль: доказывает, что токены ниже ломаются именно тем, что мы испортили, а не сборкой
    pre: [...JWT_LIB, ...js(() => {
      const now = Math.floor(Date.now() / 1000);
      pm.variables.set('secToken', makeJwt(Object.assign(learnerClaims(), { iat: now, exp: now + 3600 }), jwtSecret));
    })] }),
  req('SEC-03 · GET /api/courses · истёкший токен → 401', 'GET', `${B}/api/courses`, { headers: bearerVar('secToken'),
    pre: [...JWT_LIB, ...js(() => {
      const now = Math.floor(Date.now() / 1000);
      pm.variables.set('secToken', makeJwt(Object.assign(learnerClaims(), { iat: now - 36000, exp: now - 3600 }), jwtSecret));
    })] }),
  req('SEC-03 · GET /api/courses · токен другого секрета → 401', 'GET', `${B}/api/courses`, { headers: bearerVar('secToken'),
    pre: [...JWT_LIB, ...js(() => {
      pm.variables.set('secToken', makeJwt(learnerClaims(), 'some-other-secret-key-that-is-long-enough-for-hs384-ok'));
    })] }),
  req('SEC-03 · GET /api/settings · learner поменял role в payload на SUPER_ADMIN → 401', 'GET', `${B}/api/settings`, { headers: bearerVar('secToken'),
    pre: [...JWT_LIB, ...js(() => {
      const [h, , s] = pm.environment.get('learnerToken').split('.');
      pm.variables.set('secToken', [h, enc(Object.assign(learnerClaims(), { role: 'SUPER_ADMIN' })), s].join('.'));
    })] }),
  req('SEC-03 · GET /api/courses · испорчен последний символ подписи → 401', 'GET', `${B}/api/courses`, { headers: bearerVar('secToken'),
    pre: js(() => {
      const t = pm.environment.get('learnerToken');
      pm.variables.set('secToken', t.slice(0, -2) + (t.slice(-2, -1) === 'A' ? 'B' : 'A') + t.slice(-1));
    }) }),
  req('SEC-03 · GET /api/courses · Authorization: Basic → 401', 'GET', `${B}/api/courses`, {
    headers: [{ key: 'Authorization', value: 'Basic YWRtaW46YWRtaW4xMjM=' }] }),
  req('SEC-03 · GET /api/courses · «bearer» строчными → 401', 'GET', `${B}/api/courses`, {
    headers: [{ key: 'Authorization', value: 'bearer {{learnerToken}}' }] }),
  req('SEC-03 · OPTIONS /api/courses · CORS preflight без токена → 200', 'OPTIONS', `${B}/api/courses`, {
    headers: [{ key: 'Origin', value: 'http://localhost:3000' }, { key: 'Access-Control-Request-Method', value: 'GET' }],
    test: js(() => {
      pm.test('Разрешён фронтенд на :3000', () =>
        pm.expect(pm.response.headers.get('Access-Control-Allow-Origin')).to.eql('http://localhost:3000'));
    }) }),

  req('SEC-prep · POST /api/courses/{id}/units · урок для матрицы → 201', 'POST', `${B}/api/courses/{{courseId}}/units`, {
    as: 'instructor', form: unitForm('K sec unit {{runId}}'), test: saveId('secUnitId') }),
  ...MATRIX.flatMap(([method, p, body, allowed]) => ['learner', 'instructor', 'admin'].map((role, i) =>
    req(`SEC-04 · ${method} ${p} · ${role} → ${allowed[i] ? 'пропущен gateway' : '403'}`, method, `${B}${p}`, {
      as: role, json: body === null ? undefined : body }))),

  req('SEC-05 · GET /api/courses · 60 запросов за секунду → часть 429 → 200', 'GET', `${B}/api/courses`, { as: 'learner',
    pre: js(() => {
      // 60 запросов разом одним токеном; лимит gateway: 20 в секунду, всплеск до 40
      const codes = {};
      let left = 60;
      for (let i = 0; i < 60; i++) {
        pm.sendRequest({ url: pm.variables.replaceIn('{{baseUrl}}/api/courses'),
          header: { Authorization: 'Bearer ' + pm.environment.get('learnerToken') } }, (err, res) => {
          const c = err ? 'error' : res.code;
          codes[c] = (codes[c] || 0) + 1;
          if (--left === 0) {
            pm.environment.set('secCodes', JSON.stringify(codes));
            setTimeout(() => {}, 3000); // ждём, пока «ведро» токенов наполнится
          }
        });
      }
    }),
    test: js(() => {
      const codes = JSON.parse(pm.environment.get('secCodes'));
      pm.test(`Часть запросов получила 429 (${JSON.stringify(codes)})`, () => pm.expect(codes['429'] || 0).to.be.above(0));
      pm.test('Остальные прошли (200)', () => pm.expect(codes['200'] || 0).to.be.above(0));
      // сам этот запрос ушёл через 3 с — лимит восстановился, поэтому 200 (проверка в общих тестах)
    }) }),
  req('SEC-06 · GET /api/nothing · с токеном → 404', 'GET', `${B}/api/nothing`, { as: 'admin' }),
  req('SEC-06 · GET /api/nothing · без токена → 401', 'GET', `${B}/api/nothing`),
  req('SEC-07 · GET /api/courses · отказ gateway без токена в стандартном формате → 401', 'GET', `${B}/api/courses`, {
    test: js(() => {
      // N1 из §1.4: 401 должен приходить с WWW-Authenticate: Bearer и телом problem+json, как у сервисов
      pm.test('Заголовок WWW-Authenticate: Bearer', () => pm.expect(pm.response.headers.get('WWW-Authenticate')).to.eql('Bearer'));
      pm.test('Тело application/problem+json', () =>
        pm.expect(pm.response.headers.get('Content-Type') || '').to.include('application/problem+json'));
    }) }),
]);

// ======================================================================
// 07 E2E-7
// ======================================================================

const e2e = folder('07 E2E · E2E-7 Событие проходит через все сервисы',
  'Порядок запросов важен. Ученик проходит единственный урок курса — одно действие порождает ' +
  'UNIT_COMPLETED, COURSE_COMPLETED и CERTIFICATE_ISSUED, которые должны дойти до аналитики, писем и очков. ' +
  'Шаги 4–6 чек-листа (повторная доставка через Kafka UI, остановка gamification-service, Grafana) выполняются вручную ' +
  'по docs/postman/kantemir/README.md.', [
  req('E2E-7 · 01 · POST /api/notifications · правило на COURSE_COMPLETED → 201', 'POST', N, { as: 'admin',
    json: rule({ name: 'E2E-7 {{runId}}', subjectTemplate: 'E2E-7 {{runId}}: {{courseName}}' }), test: saveId('e2eRuleId') }),
  req('E2E-7 · 02 · POST /api/courses · курс из одного урока → 201', 'POST', `${B}/api/courses`, { as: 'instructor',
    json: { name: 'K e2e course {{runId}}', active: true },
    test: js(() => {
      pm.environment.set('e2eCourseId', pm.response.json().id);
      pm.environment.set('e2eCourseName', pm.response.json().name);
    }) }),
  req('E2E-7 · 03 · POST /api/courses/{id}/units · урок → 201', 'POST', `${B}/api/courses/{{e2eCourseId}}/units`, {
    as: 'instructor', form: unitForm('K e2e unit {{runId}}'), test: saveId('e2eUnitId') }),
  req('E2E-7 · 04 · POST /api/courses/{id}/enrollments · записать ученика → 201', 'POST', `${B}/api/courses/{{e2eCourseId}}/enrollments`, {
    as: 'instructor', json: { userId: '{{learnerId}}' } }),
  req('E2E-7 · 05 · GET /api/gamification/me · запомнить очки → 200', 'GET', ME, { as: 'learner',
    test: js(() => { pm.environment.set('e2eP0', pm.response.json().points); }) }),
  req('E2E-7 · 06 · POST /api/units/{id}/start → 200', 'POST', `${B}/api/units/{{e2eUnitId}}/start`, { as: 'learner' }),
  req('E2E-7 · 07 · POST /api/units/{id}/complete · урок и курс пройдены → 200', 'POST', `${B}/api/units/{{e2eUnitId}}/complete`, {
    as: 'learner', json: {} }),
  req('E2E-7 · 08 · GET /api/analytics/timeline · три события курса за 10 с → 200', 'GET',
    `${A}/timeline?userId={{learnerId}}&courseId={{e2eCourseId}}&size=50`, { as: 'admin',
    pre: waitFor(`${A}/timeline?userId={{learnerId}}&courseId={{e2eCourseId}}&size=50`, 'adminToken',
      page => ['UNIT_COMPLETED', 'COURSE_COMPLETED', 'CERTIFICATE_ISSUED'].every(t => page.items.some(i => i.type === t))),
    test: [...POLL_OK, ...js(() => {
      const types = pm.response.json().items.map(i => i.type);
      pm.test('UNIT_COMPLETED, COURSE_COMPLETED, CERTIFICATE_ISSUED — по одному', () =>
        ['UNIT_COMPLETED', 'COURSE_COMPLETED', 'CERTIFICATE_ISSUED'].forEach(t => pm.expect(types.filter(x => x === t), t).to.have.length(1)));
    })] }),
  req('E2E-7 · 09 · GET /api/notifications/history · письмо по новому правилу → 200', 'GET', `${N}/history`, { as: 'admin',
    pre: waitFor(`${N}/history`, 'adminToken', list => list.some(m => m.ruleId === pm.environment.get('e2eRuleId'))),
    test: [...POLL_OK, ...js(() => {
      const mails = pm.response.json().filter(m => m.ruleId === pm.environment.get('e2eRuleId'));
      pm.test('Ровно одно письмо, на email ученика', () => {
        pm.expect(mails).to.have.length(1);
        pm.expect(mails[0].recipientEmail).to.eql(pm.environment.get('learnerEmail'));
      });
      pm.test('Тема с названием курса', () =>
        pm.expect(mails[0].subject).to.eql(`E2E-7 ${pm.environment.get('runId')}: ${pm.environment.get('e2eCourseName')}`));
    })] }),
  req('E2E-7 · 10 · GET /api/gamification/me · +15 +100 +50 → 200', 'GET', ME, { as: 'learner',
    pre: waitFor(ME, 'learnerToken', me => me.points >= Number(pm.environment.get('e2eP0')) + 165),
    test: [...POLL_OK, ...js(() => {
      pm.test('Ровно +165 очков', () => pm.expect(pm.response.json().points).to.eql(Number(pm.environment.get('e2eP0')) + 165));
      pm.environment.set('e2ePoints', pm.response.json().points);
    })] }),
  req('E2E-7 · 11 · GET /api/gamification/leaderboard · ученик в рейтинге → 200', 'GET', `${G}/leaderboard?limit=50`, { as: 'learner',
    test: js(() => {
      const board = pm.response.json();
      pm.test('Ученик в рейтинге с теми же очками', () => {
        pm.expect(board.me.userId).to.eql(pm.environment.get('learnerId'));
        pm.expect(board.me.score).to.eql(Number(pm.environment.get('e2ePoints')));
      });
    }) }),
  req('E2E-7 · 12 · DELETE /api/notifications/{id} · убрать правило → 204', 'DELETE', `${N}/{{e2eRuleId}}`, { as: 'admin' }),
]);

// ======================================================================
// 99 Teardown · Kantemir
// ======================================================================

const COURSE_VARS = ['courseId', 'ntfCourseId', 'ntfCourse2Id', 'anlCourseId', 'gamCourseId', 'gamTestCourseId', 'e2eCourseId'];

const teardown = folder('99 Teardown · Kantemir',
  'Возвращает стенд как было: настройки геймификации по умолчанию, тестовые правила писем, курсы и ученик удалены.', [
  req('TD-K · POST /api/gamification/settings/reset · настройки по умолчанию → 200', 'POST', `${G}/settings/reset`, { as: 'admin' }),
  req('TD-K · GET /api/notifications · тестовых правил не осталось → 200', 'GET', N, { as: 'admin',
    pre: js(() => {
      // удаляем правила, оставшиеся от упавших прогонов: все, чьё имя начинается с "K " или "E2E-7 "
      pm.sendRequest({ url: pm.variables.replaceIn('{{baseUrl}}/api/notifications'),
        header: { Authorization: 'Bearer ' + pm.environment.get('adminToken') } }, (err, res) => {
        res.json().filter(r => /^(K |E2E-7 )/.test(r.name)).forEach(r => pm.sendRequest({
          url: pm.variables.replaceIn('{{baseUrl}}/api/notifications/' + r.id), method: 'DELETE',
          header: { Authorization: 'Bearer ' + pm.environment.get('adminToken') } }, () => {}));
      });
      setTimeout(() => {}, 1500);
    }),
    test: js(() => {
      pm.test('Нет правил с именами K … и E2E-7 …', () =>
        pm.expect(pm.response.json().filter(r => /^(K |E2E-7 )/.test(r.name))).to.eql([]));
    }) }),
  ...COURSE_VARS.flatMap(v => [
    req(`TD-K · DELETE /api/courses/{${v}} · в корзину → 204`, 'DELETE', `${B}/api/courses/{{${v}}}`, { as: 'instructor' }),
    req(`TD-K · DELETE /api/courses/{${v}}/permanent · навсегда → 204`, 'DELETE', `${B}/api/courses/{{${v}}}/permanent`, { as: 'admin' }),
  ]),
  req('TD-K · DELETE /api/users/{learnerId} · ученик → 204', 'DELETE', `${B}/api/users/{{learnerId}}`, { as: 'admin' }),
]);

// ======================================================================

const collection = {
  info: {
    name: 'JazzLMS API · Kantemir',
    description: 'Папки Kantemir: notification, analytics, gamification, безопасность gateway, E2E-7. ' +
      'Собрано скриптом docs/postman/kantemir/build.js — правьте его и пересобирайте, а не JSON руками.',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  item: [setup, notification, analytics, gamification, security, e2e, teardown],
};

const out = path.join(__dirname, 'JazzLMS-kantemir.postman_collection.json');
fs.writeFileSync(out, JSON.stringify(collection, null, 2) + '\n');
const count = f => f.item.length;
console.log(`OK: ${out}`);
collection.item.forEach(f => console.log(`  ${String(count(f)).padStart(3)}  ${f.name}`));
console.log(`  ${String(collection.item.reduce((s, f) => s + count(f), 0)).padStart(3)}  всего запросов`);
