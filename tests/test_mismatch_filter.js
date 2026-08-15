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
    document: {
        querySelector: () => null,
        querySelectorAll: () => [],
        getElementById: () => null,
        addEventListener: () => {}
    },
    localStorage: {
        getItem: key => storage.has(key) ? storage.get(key) : null,
        setItem: (key, value) => storage.set(key, String(value))
    }
});

for (const relativePath of ['js/config.js', 'js/utils.js', 'js/state.js']) {
    vm.runInContext(
        fs.readFileSync(path.join(root, relativePath), 'utf8'),
        context,
        {filename: relativePath}
    );
}

// map.js の中から preparePositionMismatchData および関連ヘルパー（findNearestPort等）をロード
const mapJsContent = fs.readFileSync(path.join(root, 'js/map.js'), 'utf8');
vm.runInContext(mapJsContent, context, {filename: 'js/map.js'});

const sampleData = {
    ports: [
        {
            port_name: '01.近江町市場',
            area_name: '金沢',
            lat: 36.5700,
            lon: 136.6500,
            has_gps: true,
            bikes: [
                {
                    bike_id: 'KNZ001',
                    status: '利用中',
                    port_position_mismatch: true,
                    vehicle_lat: 36.5600,
                    vehicle_lon: 136.6400,
                },
                {
                    bike_id: 'KNZ002',
                    status: '利用可能',
                    port_position_mismatch: true,
                    vehicle_lat: 36.5600,
                    vehicle_lon: 136.6400,
                },
                {
                    bike_id: 'KNZ003',
                    status: '利用可能',
                    port_position_mismatch: false,
                    vehicle_lat: null,
                    vehicle_lon: null,
                }
            ]
        }
    ]
};

// 1. 位置不整合モード OFF の場合
vm.runInContext('isPositionMismatchMode = false', context);
const resultOff = vm.runInContext(`preparePositionMismatchData(${JSON.stringify(sampleData)})`, context);

// 「利用中」かつ不整合の KNZ001 は「ポート外（位置不整合）」に移動していること
const normalPortOff = resultOff.ports.find(p => p.port_name === '01.近江町市場');
const mismatchPortOff = resultOff.ports.find(p => p.port_name === 'ポート外（位置不整合）');

assert.equal(normalPortOff.bikes.length, 2, '通常ポートには KNZ002 と KNZ003 が残る');
assert.equal(JSON.stringify(normalPortOff.bikes.map(b => b.bike_id)), JSON.stringify(['KNZ002', 'KNZ003']));
assert.equal(mismatchPortOff.bikes.length, 1, 'ポート外には利用中の KNZ001 のみ移動する');
assert.equal(mismatchPortOff.bikes[0].bike_id, 'KNZ001');

// 2. 位置不整合モード ON の場合
vm.runInContext('isPositionMismatchMode = true', context);
const resultOn = vm.runInContext(`preparePositionMismatchData(${JSON.stringify(sampleData)})`, context);

const normalPortOn = resultOn.ports.find(p => p.port_name === '01.近江町市場');
const mismatchPortOn = resultOn.ports.find(p => p.port_name === 'ポート外（位置不整合）');

assert.equal(normalPortOn.bikes.length, 1, '通常ポートには不整合無しの KNZ003 のみ残る');
assert.equal(normalPortOn.bikes[0].bike_id, 'KNZ003');
assert.equal(mismatchPortOn.bikes.length, 2, 'ポート外には不整合フラグのある KNZ001, KNZ002 の両方が移動する');
assert.equal(JSON.stringify(mismatchPortOn.bikes.map(b => b.bike_id)), JSON.stringify(['KNZ001', 'KNZ002']));

console.log('preparePositionMismatchData: using vehicle mismatch & mode toggle tests passed successfully');
