'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'js/map.js'), 'utf8');
const start = source.indexOf('function filterPortsByServiceState');
const end = source.indexOf('\nfunction preparePositionMismatchData', start);
assert.ok(start >= 0 && end > start, 'filterPortsByServiceStateを抽出できること');

const context = vm.createContext({ isOutOfServiceVisible: false });
vm.runInContext(source.slice(start, end), context);

const data = {
  ports: [
    { port_name: '公開運用中', service_state: '運用中', publish_flag: true },
    { port_name: '非公開運用中', service_state: '運用中', publish_flag: false },
    { port_name: '公開停止中', service_state: '停止中', publish_flag: true },
    { port_name: '状態不明', service_state: null, publish_flag: null },
    { port_name: '旧データ', service_state: '運用中' }
  ]
};

const filtered = context.filterPortsByServiceState(data);
assert.deepEqual(
  Array.from(filtered.ports, (port) => port.port_name),
  ['公開運用中', '状態不明', '旧データ'],
  '提供外OFFでは停止中とpublish_flag=falseだけを除外すること'
);
assert.equal(data.ports.length, 5, '入力データを破壊しないこと');

context.isOutOfServiceVisible = true;
assert.strictEqual(
  context.filterPortsByServiceState(data),
  data,
  '提供外ONでは全ポートをそのまま返すこと'
);

console.log('out-of-service filter: service_state and publish_flag boundaries ok');
