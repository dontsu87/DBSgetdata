'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');

// vm コンテキスト内で作られた配列は別realm由来のため、assert/strict の
// deepEqual(=deepStrictEqual) がプロトタイプ比較で落ちる。ホスト側の配列へ移してから比較する。
const toHostArray = value => Array.isArray(value) ? Array.from(value) : value;

function createContextWithSearch(search) {
    const storage = new Map();
    const context = vm.createContext({
        console,
        navigator: { maxTouchPoints: 0 },
        URLSearchParams,
        window: { location: { search: search } },
        document: { querySelector: () => null },
        localStorage: {
            getItem: key => storage.has(key) ? storage.get(key) : null,
            setItem: (key, value) => storage.set(key, String(value))
        }
    });

    for (const relativePath of ['js/config.js', 'js/utils.js']) {
        vm.runInContext(
            fs.readFileSync(path.join(root, relativePath), 'utf8'),
            context,
            { filename: relativePath }
        );
    }
    return context;
}

// 1: ?areas=金沢,小松 -> ['金沢','小松']
{
    const ctx = createContextWithSearch('?areas=金沢,小松');
    const res = vm.runInContext('getRestrictedAreas()', ctx);
    assert.deepEqual(toHostArray(res), ['金沢', '小松']);
}

// 2: ?areas=金沢, 小松 , -> ['金沢','小松']
{
    const ctx = createContextWithSearch('?areas=金沢, 小松 ,');
    const res = vm.runInContext('getRestrictedAreas()', ctx);
    assert.deepEqual(toHostArray(res), ['金沢', '小松']);
}

// 3: ?areas=金沢 -> ['金沢']
{
    const ctx = createContextWithSearch('?areas=金沢');
    const res = vm.runInContext('getRestrictedAreas()', ctx);
    assert.deepEqual(toHostArray(res), ['金沢']);
}

// 4: ?areas= -> null
{
    const ctx = createContextWithSearch('?areas=');
    const res = vm.runInContext('getRestrictedAreas()', ctx);
    assert.equal(res, null);
}

// 5: (パラメータ無し) -> null
{
    const ctx = createContextWithSearch('');
    const res = vm.runInContext('getRestrictedAreas()', ctx);
    assert.equal(res, null);
}

// 6: ?kanriall&areas=金沢 -> null (kanriall優先)
{
    const ctx = createContextWithSearch('?kanriall&areas=金沢');
    const res = vm.runInContext('getRestrictedAreas()', ctx);
    assert.equal(res, null);
}

// 7: ?areas=金沢,小松 -> getRestrictedStatus() が null
{
    const ctx = createContextWithSearch('?areas=金沢,小松');
    const res = vm.runInContext('getRestrictedStatus()', ctx);
    assert.equal(res, null);
}

// 8: ?area=金沢 -> getRestrictedArea() が '金沢'、getRestrictedAreas() が null
{
    const ctx = createContextWithSearch('?area=金沢');
    const area = vm.runInContext('getRestrictedArea()', ctx);
    const areas = vm.runInContext('getRestrictedAreas()', ctx);
    assert.equal(area, '金沢');
    assert.equal(areas, null);
}

// 9: (パラメータ無し) -> getRestrictedStatus() が '利用可能'
{
    const ctx = createContextWithSearch('');
    const res = vm.runInContext('getRestrictedStatus()', ctx);
    assert.equal(res, '利用可能');
}

console.log('test_area_multi passed successfully');
