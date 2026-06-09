document.addEventListener("DOMContentLoaded", function() {
    // iOS/iPadOSの判定とPWA挙動の制御
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
                  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (isIOS) {
        const manifestLink = document.querySelector('link[rel="manifest"]');
        if (manifestLink) {
            manifestLink.remove();
        }
    }

    // Initialize Map and UI
    initMapInstance();
    initUIComponents();

    // Initial load
    if (isKindaiMode()) {
        document.querySelectorAll('.legend-filter').forEach(el => {
            const val = parseInt(el.value);
            if (val === 5 || val === 4) {
                el.checked = true;
            } else {
                el.checked = false;
            }
        });
    } else {
        const cachedLevels = loadFromCache('checked_legend_levels', null);
        if (Array.isArray(cachedLevels)) {
            document.querySelectorAll('.legend-filter').forEach(el => {
                const val = parseInt(el.value);
                el.checked = cachedLevels.includes(val);
            });
        }
    }

    loadDashboardData(false);

    // 2分ごと(120000ms)にバックグラウンドでサイレント自動更新を繰り返す
    setInterval(function() {
        console.log("🔄 定期自動アップデートを実行中...");
        loadDashboardData(true);
    }, 120000);

    // E2Eテスト用に一部の内部関数・変数をwindowオブジェクトに公開
    const unlockedThresholdInput = document.getElementById('unlocked-threshold-input');
    const selectionModeCheckbox = document.getElementById('selection-mode-checkbox');

    window._testInterface = {
        loadDashboardData: loadDashboardData,
        isUserInteracting: isUserInteracting,
        checkAndApplyPendingUpdate: checkAndApplyPendingUpdate,
        getIsPendingUpdate: () => isPendingUpdate,
        getPendingUpdateData: () => pendingUpdateData,
        setIsPendingUpdate: (val) => { isPendingUpdate = val; },
        setPendingUpdateData: (val) => { pendingUpdateData = val; },
        getCachedDashboardData: () => cachedDashboardData,
        setCachedDashboardData: (val) => { cachedDashboardData = val; },
        getUnlockedThresholdHours: () => unlockedThresholdHours,
        setUnlockedThresholdHours: (val) => {
            unlockedThresholdHours = val;
            if (unlockedThresholdInput) {
                unlockedThresholdInput.value = val;
                unlockedThresholdInput.dispatchEvent(new Event('change'));
            }
        },
        updateFilterAndRender: updateFilterAndRender,
        getIsPortSelectionMode: () => isPortSelectionMode,
        setIsPortSelectionMode: (val) => {
            isPortSelectionMode = val;
            if (selectionModeCheckbox) {
                selectionModeCheckbox.checked = val;
                selectionModeCheckbox.dispatchEvent(new Event('change'));
            }
        },
        getSelectedPortNames: () => selectedPortNames,
        setSelectedPortNames: (val) => {
            selectedPortNames = val;
            saveToCache('selected_port_names', selectedPortNames);
            updateFilterAndRender(false);
        }
    };
});

// モバイル用ドロワーの開閉トグル関数 (グローバルスコープ)
function toggleSummaryMobile() {
    const panel = document.getElementById('summary-panel');
    const legend = document.getElementById('map-legend-panel');
    const statusPanel = document.getElementById('status-filter-panel');
    const basemapPanel = document.getElementById('basemap-panel');
    if (legend) legend.classList.remove('show-mobile-drawer');
    if (statusPanel) statusPanel.classList.remove('show-mobile-drawer');
    if (basemapPanel) basemapPanel.classList.remove('show-mobile-drawer');
    
    if (panel) {
        panel.classList.toggle('show-mobile-drawer');
    }
}

function toggleLegendMobile() {
    const panel = document.getElementById('map-legend-panel');
    const summary = document.getElementById('summary-panel');
    const statusPanel = document.getElementById('status-filter-panel');
    const basemapPanel = document.getElementById('basemap-panel');
    if (summary) summary.classList.remove('show-mobile-drawer');
    if (statusPanel) statusPanel.classList.remove('show-mobile-drawer');
    if (basemapPanel) basemapPanel.classList.remove('show-mobile-drawer');
    
    if (panel) {
        panel.classList.toggle('show-mobile-drawer');
    }
}

function toggleStatusMobile() {
    const panel = document.getElementById('status-filter-panel');
    const summary = document.getElementById('summary-panel');
    const legend = document.getElementById('map-legend-panel');
    const basemapPanel = document.getElementById('basemap-panel');
    if (summary) summary.classList.remove('show-mobile-drawer');
    if (legend) legend.classList.remove('show-mobile-drawer');
    if (basemapPanel) basemapPanel.classList.remove('show-mobile-drawer');
    
    if (panel) {
        panel.classList.toggle('show-mobile-drawer');
    }
}

function toggleBaseMapMobile() {
    const panel = document.getElementById('basemap-panel');
    const summary = document.getElementById('summary-panel');
    const legend = document.getElementById('map-legend-panel');
    const statusPanel = document.getElementById('status-filter-panel');
    if (summary) summary.classList.remove('show-mobile-drawer');
    if (legend) legend.classList.remove('show-mobile-drawer');
    if (statusPanel) statusPanel.classList.remove('show-mobile-drawer');
    
    if (panel) {
        panel.classList.toggle('show-mobile-drawer');
    }
}
