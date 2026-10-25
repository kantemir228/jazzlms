// Собирает общую коллекцию JazzLMS API (§8.1 чек-листа) из частей студентов.
// Запуск из корня репозитория: node docs/postman/merge.js
// Результат: docs/postman/JazzLMS.postman_collection.json
//
// Основа — каркас Astra (team/astra.postman_collection.json): 00 Setup, 01 user-service / Auth, Demo,
// 07 E2E / E2E-1, 99 Teardown. Из коллекции каждого студента берутся только его папки (PARTS) — копии
// чужого Setup и Auth в их файлах игнорируются. Сдал кто-то ещё: экспорт его коллекции кладётся в team/,
// а в PARTS дописывается строка: откуда (путь папок в его файле) → в какую общую папку.

const fs = require('fs');
const path = require('path');

const load = file => JSON.parse(fs.readFileSync(path.join(__dirname, 'team', file), 'utf8'));
const base = load('astra.postman_collection.json');

// студент, файл в team/, [путь папок в его коллекции, номер общей папки, новое имя (необязательно)]
const PARTS = [
  ['Zhyldyz', 'zhyldyz.postman_collection.json', [
    [['Zhyldyz_Course-Service'], '02', 'Courses, Categories, Enrollments (Zhyldyz)'],
    [['07 E2E'], '07', 'E2E-4 · Жизненный цикл курса (Zhyldyz)'],
    [['99 Teardown'], '99', 'Zhyldyz'],
  ]],
  ['Tamara', 'tamara.postman_collection.json', [
    [['01 user-service', 'Users'], '01'],
  ]],
  ['Alina', 'alina.postman_collection.json', [
    [['ORG · Branches (Alina)'], '01', 'Branches (Alina)'],
    [['ORG · Groups (Alina)'], '01', 'Groups (Alina)'],
    [['07 E2E · E2E-3 Default group & password policy (Alina)'], '07', 'E2E-3 · Default group & password policy (Alina)'],
    [['99 Teardown'], '99', 'Alina'],
  ]],
  ['Nazgul', 'nazgul.postman_collection.json', [
    [['02 course-service', 'Units nazgul'], '02'],
    [['02 course-service', 'Units — файлы nazgul'], '02'],
    [['02 course-service', 'Certificates nazgul'], '02'],
    [['07 E2E', 'E2E-5 Ученик проходит курс и получает сертификат'], '07'],
    [['99 Teardown', '99 Teardown (Nazgyl)'], '99'],
  ]],
  ['Ainura', 'ainura.postman_collection.json', [
    [['02 course-service', 'Tests (Ainura)'], '02'],
    [['07 E2E', 'E2E-6 · Тест: провал, пересдача, очки (Ainura)'], '07'],
    [['99 Teardown', 'Ainura · Tests'], '99'],
  ]],
];

/** Сколько запросов в папке, считая вложенные подпапки. */
const countRequests = f => f.item.reduce((s, i) => s + (i.item ? countRequests(i) : 1), 0);

const folderOf = prefix => {
  const f = base.item.find(i => i.name.startsWith(prefix + ' '));
  if (!f) throw new Error(`В каркасе нет папки «${prefix} …»`);
  return f;
};

/**
 * Подпапку ставим после уже стоящих подпапок, но перед запросами: Postman Runner сам запускает подпапки
 * раньше запросов той же папки, а Newman идёт по порядку файла — так порядок в обоих одинаковый.
 */
function insertFolder(target, folder) {
  const firstRequest = target.item.findIndex(i => !i.item);
  target.item.splice(firstRequest < 0 ? target.item.length : firstRequest, 0, folder);
}

/** Переменные коллекции (например, tstLib у Ainura): добавляем те, которых в каркасе ещё нет. */
function addVariables(source) {
  base.variable = base.variable || [];
  for (const v of source.variable || []) if (!base.variable.some(b => b.key === v.key)) base.variable.push(v);
}

for (const [student, file, parts] of PARTS) {
  const source = load(file);
  addVariables(source);
  for (const [from, to, rename] of parts) {
    let node = source;
    for (const name of from) {
      node = (node.item || []).find(i => i.name === name);
      if (!node) throw new Error(`${student}: в ${file} нет папки «${from.join(' / ')}»`);
    }
    const copy = JSON.parse(JSON.stringify(node));
    if (rename) copy.name = rename;
    // авторизация, заданная автором на уровне всей его коллекции, при переносе папок иначе потерялась бы
    if (source.auth && !copy.auth) copy.auth = source.auth;
    insertFolder(folderOf(to), copy);
  }
}

// Часть Kantemir собирается из исходника build.js: папки 03–06 целиком, в 07 и 99 — подпапкой,
// в 00 Setup — запросами в конец (после SETUP-01…03 Astra).
const kantemir = require('./kantemir/build.js').parts;
for (const [prefix, part] of Object.entries(kantemir)) {
  const target = folderOf(prefix);
  if (prefix === '00') target.item.push(...part);
  else if (Array.isArray(part)) part.forEach(f => insertFolder(target, f));
  else {
    if (target.item.length) throw new Error(`Kantemir: папка «${target.name}» уже занята`);
    Object.assign(target, { item: part.item, event: part.event, description: part.description });
  }
}

// сквозные сценарии — по номеру: E2E-1, E2E-3, E2E-5, …
const e2e = folderOf('07');
e2e.item.sort((a, b) => (a.name.match(/E2E-(\d+)/) || [0, 99])[1] - (b.name.match(/E2E-(\d+)/) || [0, 99])[1]);

const out = path.join(__dirname, 'JazzLMS.postman_collection.json');
fs.writeFileSync(out, JSON.stringify(base, null, 2) + '\n');
console.log(`OK: ${out}`);
base.item.forEach(f => {
  console.log(`  ${String(countRequests(f)).padStart(4)}  ${f.name}`);
  f.item.filter(i => i.item).forEach(s => console.log(`        ${String(countRequests(s)).padStart(4)}  ${s.name}`));
});
console.log(`  ${String(countRequests(base)).padStart(4)}  всего запросов`);
