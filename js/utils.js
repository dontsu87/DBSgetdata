// URL parameters and utility functions
let searchQuery = window.location.search;
if (searchQuery) {
    localStorage.setItem('pwa_search_query', searchQuery);
} else {
    searchQuery = localStorage.getItem('pwa_search_query') || "";
}

// Help button url update
const helpBtn = document.querySelector('.help-button');
if (helpBtn && searchQuery) {
    helpBtn.href = 'docs/manual.html' + searchQuery;
}

function saveToCache(key, value) {
    try {
        localStorage.setItem(key, typeof value === 'object' ? JSON.stringify(value) : value);
    } catch (e) {
        console.warn('Failed to save to localStorage:', e);
    }
}

function loadFromCache(key, defaultValue) {
    try {
        const value = localStorage.getItem(key);
        if (value === null) return defaultValue;
        try {
            return JSON.parse(value);
        } catch (e) {
            return value;
        }
    } catch (e) {
        console.warn('Failed to load from localStorage:', e);
        return defaultValue;
    }
}

function isMobileLayout() {
    const width = window.innerWidth;
    const isTouchDevice = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
    
    // 1. 単純に画面幅が1280px以下の場合 (余裕を持たせた閾値)
    if (width <= 1280) {
        return true;
    }
    // 2. タッチデバイスかつ画面幅が1366px以下の場合 (iPad Pro 12.9インチ横向きなど)
    if (isTouchDevice && width <= 1366) {
        return true;
    }
    
    return false;
}

function normalizeAreaName(value) {
    const name = String(value || '').trim();
    if (!name) return '';
    const areaCode = name.split('_', 1)[0].toUpperCase();
    return AREA_CODE_ALIASES[areaCode] || name;
}

function findMatchingArea(areas, requestedArea) {
    const requested = normalizeAreaName(requestedArea);
    if (!requested) return '';
    return areas.find(area => normalizeAreaName(area) === requested)
        || areas.find(area => normalizeAreaName(area).toLowerCase().includes(requested.toLowerCase()))
        || '';
}

function extractBikePrefix(bikeId) {
    const match = String(bikeId || '').match(/^[A-Za-z]+/);
    return match ? match[0].toUpperCase() : '';
}

function matchesBikePrefix(bikeId, selectedPrefixes, isAllSelected) {
    if (isAllSelected) return true;
    return Array.isArray(selectedPrefixes)
        && selectedPrefixes.includes(extractBikePrefix(bikeId));
}

function getRestrictedArea() {
    const params = new URLSearchParams(searchQuery);
    if (params.has('kanriall')) {
        return null;
    }
    return params.get('area');
}

function getRestrictedAreas() {
    const params = new URLSearchParams(searchQuery);
    if (params.has('kanriall')) {
        return null;
    }
    const raw = params.get('areas');
    if (!raw) return null;
    const list = raw.split(',').map(value => value.trim()).filter(Boolean);
    return list.length ? list : null;
}

function getRestrictedStatus() {
    const params = new URLSearchParams(searchQuery);
    if (params.has('kanriall') || params.has('area') || params.has('areas')) {
        return null;
    }
    return '利用可能';
}

function isKindaiMode() {
    const params = new URLSearchParams(searchQuery);
    return params.has('kindai');
}

function haversineMeters(lat1, lon1, lat2, lon2) {
    const radiusM = 6371000;
    const toRad = (deg) => deg * Math.PI / 180;
    const dPhi = toRad(lat2 - lat1);
    const dLambda = toRad(lon2 - lon1);
    const a = Math.sin(dPhi / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLambda / 2) ** 2;
    return 2 * radiusM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// 実測GPS座標(lat, lon)に最も近い実在ポート(GPS座標を持つポート)を、同一エリア内から探す。
// maxDistanceM以内に見つからなければnullを返す。
function findNearestPort(lat, lon, ports, areaName, maxDistanceM) {
    if (lat === null || lat === undefined || lon === null || lon === undefined) return null;
    const targetArea = normalizeAreaName(areaName);
    let nearestPort = null;
    let nearestDistance = Infinity;
    (ports || []).forEach(port => {
        if (port.has_gps === false || port.lat === null || port.lat === undefined || port.lon === null || port.lon === undefined) return;
        if (port.port_name && port.port_name.includes('ポート外')) return;
        if (targetArea && normalizeAreaName(port.area_name) !== targetArea) return;
        const distance = haversineMeters(lat, lon, port.lat, port.lon);
        if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestPort = port;
        }
    });
    if (!nearestPort || nearestDistance > maxDistanceM) return null;
    return { port_name: nearestPort.port_name, distance_m: nearestDistance };
}
