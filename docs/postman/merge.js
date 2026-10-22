// Собирает общую коллекцию JazzLMS API (§8.1 чек-листа) из частей студентов.
// Запуск из корня репозитория: node docs/postman/merge.js
// Результат: docs/postman/JazzLMS.postman_collection.json
//
// Основа — экспорт каркаса Astra (team/astra.postman_collection.json): её 00 Setup, 01 user-service
// и пустые папки остальных. Части других студентов вставляются в эти папки по номеру.
// Добавился студент — экспорт его папки кладётся в team/, и сюда дописывается одна строка в PARTS.

const fs = require('fs');
const path = require('path');

const base = JSON.parse(fs.readFileSync(path.join(__dirname, 'team', 'astra.postman_collection.json'), 'utf8'));

const PARTS = [
  ['Kantemir', require('./kantemir/build.js').parts],
];

/** Сколько запросов в папке, считая вложенные подпапки. */
const countRequests = f => f.item.reduce((s, i) => s + (i.item ? countRequests(i) : 1), 0);

for (const [student, parts] of PARTS) {
  for (const [prefix, part] of Object.entries(parts)) {
    const target = base.item.find(f => f.name.startsWith(prefix + ' '));
    if (!target) throw new Error(`${student}: в каркасе нет папки «${prefix} …»`);
    if (Array.isArray(part)) {
      // общая папка (Setup, E2E, Teardown): у каждого студента своя подпапка
      target.item.push(...part);
    } else {
      // папка сервиса целиком принадлежит одному студенту
      if (target.item.length) throw new Error(`${student}: папка «${target.name}» уже занята`);
      Object.assign(target, { item: part.item, event: part.event, description: part.description });
    }
  }
}

const out = path.join(__dirname, 'JazzLMS.postman_collection.json');
fs.writeFileSync(out, JSON.stringify(base, null, 2) + '\n');
console.log(`OK: ${out}`);
base.item.forEach(f => console.log(`  ${String(countRequests(f)).padStart(3)}  ${f.name}`));
console.log(`  ${String(countRequests(base)).padStart(3)}  всего запросов`);
