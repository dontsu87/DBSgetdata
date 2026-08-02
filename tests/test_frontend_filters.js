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
const migratedHighlights = vm.runInContext(
    'Array.from(checkedHighlightStatuses)',
    context
);
assert.deepEqual(
    Array.from(migratedHighlights),
    ['AT異常全般', 'メンテナンス(手動)']
);

console.log('frontend area aliases and bike-prefix filters: ok');
