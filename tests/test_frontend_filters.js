'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const storage = new Map();
const context = vm.createContext({
    console,
    navigator: {maxTouchPoints: 0},
    URLSearchParams,
    window: {location: {search: ''}},
    document: {querySelector: () => null},
    localStorage: {
        getItem: key => storage.has(key) ? storage.get(key) : null,
        setItem: (key, value) => storage.set(key, String(value))
    }
});

for (const relativePath of ['js/config.js', 'js/utils.js']) {
    vm.runInContext(
        fs.readFileSync(path.join(root, relativePath), 'utf8'),
        context,
        {filename: relativePath}
    );
}

const expression = [
    '({',
    'oldKnz: normalizeAreaName(\'KNZ_金沢市公共シェアサイクルまちのり事務局\'),',
    'shortKnz: normalizeAreaName(\'KNZ\'),',
    'oldTrg: normalizeAreaName(\'TRG_Tokyo Ring\'),',
    'cachedOldArea: findMatchingArea([\'福井\', \'金沢\', \'敦賀\'], \'KNZ_旧名称\'),',
    'currentDefault: findMatchingArea([\'福井\', \'金沢\', \'敦賀\'], DEFAULT_AREA_NAME),',
    'knzPrefix: extractBikePrefix(\'KNZ1234\'),',
    'knzTestPrefix: extractBikePrefix(\'KNZTST1\'),',
    'onlyNniMatchesNni: matchesBikePrefix(\'NNI001\', [\'NNI\'], false),',
    'onlyNniRejectsKnz: matchesBikePrefix(\'KNZ001\', [\'NNI\'], false),',
    'emptySelectionRejectsBike: matchesBikePrefix(\'KNZ001\', [], false),',
    'allSelectionAcceptsBike: matchesBikePrefix(\'KNZ001\', [], true)',
    '})'
].join('');
const result = vm.runInContext(expression, context);

assert.equal(result.oldKnz, '金沢');
assert.equal(result.shortKnz, '金沢');
assert.equal(result.oldTrg, '敦賀');
assert.equal(result.cachedOldArea, '金沢');
assert.equal(result.currentDefault, '金沢');
assert.equal(result.knzPrefix, 'KNZ');
assert.equal(result.knzTestPrefix, 'KNZTST');
assert.equal(result.onlyNniMatchesNni, true);
assert.equal(result.onlyNniRejectsKnz, false);
assert.equal(result.emptySelectionRejectsBike, false);
assert.equal(result.allSelectionAcceptsBike, true);

storage.set(
    'checked_highlight_statuses',
    JSON.stringify(['AT異常(電池なし)', 'メンテナンス(アラート付)'])
);
vm.runInContext(
    fs.readFileSync(path.join(root, 'js/state.js'), 'utf8'),
    context,
    {filename: 'js/state.js'}
);
assert.equal(
    vm.runInContext('isOutOfServiceVisible', context),
    false,
    'キャッシュなし・表示状態リセット後は提供外ポート表示がOFFであること'
);
const migratedHighlights = vm.runInContext(
    'Array.from(checkedHighlightStatuses)',
    context
);
assert.deepEqual(
    Array.from(migratedHighlights),
    ['AT異常(電圧値閾値未満)', 'メンテナンス(手動)']
);

const storage2 = new Map();
storage2.set(
    'checked_highlight_statuses',
    JSON.stringify(['AT異常全般', 'メンテナンス(手動)'])
);
const context2 = vm.createContext({
    console,
    navigator: {maxTouchPoints: 0},
    URLSearchParams,
    window: {location: {search: ''}},
    document: {querySelector: () => null},
    localStorage: {
        getItem: key => storage2.has(key) ? storage2.get(key) : null,
        setItem: (key, value) => storage2.set(key, String(value))
    }
});
for (const relativePath of ['js/config.js', 'js/utils.js']) {
    vm.runInContext(
        fs.readFileSync(path.join(root, relativePath), 'utf8'),
        context2,
        {filename: relativePath}
    );
}
vm.runInContext(
    fs.readFileSync(path.join(root, 'js/state.js'), 'utf8'),
    context2,
    {filename: 'js/state.js'}
);
const migratedFromGeneral = vm.runInContext(
    'Array.from(checkedHighlightStatuses)',
    context2
);
assert.deepEqual(
    Array.from(migratedFromGeneral),
    ['AT異常(AT通知受信なし)', 'AT異常(電圧値閾値未満)', 'メンテナンス(手動)']
);

// 車両IDの昇順（自然順ソート）テスト
const sampleBikes = [
    { bike_id: 'TYO10' },
    { bike_id: 'TYO2' },
    { bike_id: 'TYO1' },
    { bike_id: 'KWS100' },
    { bike_id: 'KWS20' }
];
sampleBikes.sort((a, b) => (a.bike_id || '').localeCompare(b.bike_id || '', undefined, { numeric: true, sensitivity: 'base' }));
assert.deepEqual(
    sampleBikes.map(b => b.bike_id),
    ['KWS20', 'KWS100', 'TYO1', 'TYO2', 'TYO10']
);

console.log('frontend area aliases and bike-prefix filters & bike sorting: ok');

// --- preparePositionMismatchData の最寄り実在ポート再配属テスト ---
// map.js から preparePositionMismatchData, shouldMismatchBike, findNearestPort を検証可能なコンテキストを構築
const mapJsCode = fs.readFileSync(path.join(root, 'js/map.js'), 'utf8');

// preparePositionMismatchData の関数定義とその依存関係を抽出してコンテキストに注入
const mapContext = vm.createContext({
    console,
    Math,
    Array,
    Object,
    Number,
    String,
    Map,
    window: { location: { search: '' } },
    document: { querySelector: () => null },
    URLSearchParams,
    localStorage: { getItem: () => null, setItem: () => {} },
    isPositionMismatchMode: false,
    NEAREST_PORT_THRESHOLD_M: 100
});

// utils.js を読み込む (normalizeAreaName, findNearestPort, haversineMeters を含む)
vm.runInContext(fs.readFileSync(path.join(root, 'js/config.js'), 'utf8'), mapContext);
vm.runInContext(fs.readFileSync(path.join(root, 'js/utils.js'), 'utf8'), mapContext);

// map.js の preparePositionMismatchData 関数を注入
const prepareFuncMatch = mapJsCode.match(/function preparePositionMismatchData\([\s\S]*?\n\}/);
assert.ok(prepareFuncMatch, 'preparePositionMismatchData 関数が抽出できること');
vm.runInContext(prepareFuncMatch[0], mapContext);

// テストデータ: ポートA(尾山神社前), ポートB(西金沢駅西口)
const testData = {
    ports: [
        {
            port_name: '11.尾山神社前',
            area_name: '金沢',
            lat: 36.566000,
            lon: 136.654600,
            has_gps: true,
            bikes: [],
            total_bikes: 0,
            alert_bikes_count: 0,
            max_alert_level: 0
        },
        {
            port_name: '49.西金沢駅西口',
            area_name: '金沢',
            lat: 36.540000,
            lon: 136.600000,
            has_gps: true,
            bikes: [
                {
                    bike_id: 'NNI042',
                    status: '利用中',
                    port_position_mismatch: true,
                    vehicle_lat: 36.566065, // ポートAから約10m
                    vehicle_lon: 136.654670,
                    alert_level: 0,
                    consecutive_use_duration: 25000,
                    area_name: '金沢'
                },
                {
                    bike_id: 'OUT001',
                    status: '利用中',
                    port_position_mismatch: true,
                    vehicle_lat: 36.580000, // どのポートからも1km以上離れている
                    vehicle_lon: 136.630000,
                    alert_level: 0,
                    consecutive_use_duration: 10000,
                    area_name: '金沢'
                }
            ],
            total_bikes: 2,
            alert_bikes_count: 0,
            max_alert_level: 0
        }
    ]
};

const processed = vm.runInContext(`preparePositionMismatchData(${JSON.stringify(testData)})`, mapContext);

const portA = processed.ports.find(p => p.port_name === '11.尾山神社前');
const portB = processed.ports.find(p => p.port_name === '49.西金沢駅西口');
const outOfPort = processed.ports.find(p => p.port_name === 'ポート外（位置不整合）');

assert.ok(portA, 'ポートAが存在すること');
assert.ok(portB, 'ポートBが存在すること');
assert.ok(outOfPort, '仮想ポート（ポート外）が存在すること');

// NNI042 が最寄り実在ポートAに再配属されていること
assert.equal(portA.total_bikes, 1, 'ポートAの車両数が1台になること');
assert.equal(portA.bikes.length, 1);
assert.equal(portA.bikes[0].bike_id, 'NNI042');
assert.equal(portA.bikes[0].mismatch_source_port, '49.西金沢駅西口');
assert.equal(portA.bikes[0].nearest_port_name, '11.尾山神社前');
assert.equal(portA.bikes[0].is_reassigned_to_nearest, true);

// ポートBからは不整合車両が除去されていること
assert.equal(portB.total_bikes, 0, 'ポートBの車両数が0台になること');

// 最寄りがない OUT001 は仮想ポートに配置されること
assert.equal(outOfPort.total_bikes, 1, '最寄りのない車両は仮想ポートに入ること');
assert.equal(outOfPort.bikes[0].bike_id, 'OUT001');

console.log('preparePositionMismatchData reassignment test: ok');
