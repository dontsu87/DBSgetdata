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
    return window.innerWidth <= 768;
}

function getRestrictedArea() {
    const params = new URLSearchParams(searchQuery);
    if (params.has('kanriall')) {
        return null;
    }
    return params.get('area');
}

function getRestrictedStatus() {
    const params = new URLSearchParams(searchQuery);
    if (params.has('kanriall') || params.has('area')) {
        return null;
    }
    return '利用可能';
}

function isKindaiMode() {
    const params = new URLSearchParams(searchQuery);
    return params.has('kindai');
}
