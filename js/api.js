// Data Fetching and Polling Logic

function isUserInteracting() {
    return isMapInteracting || openPortName !== null;
}

function checkAndApplyPendingUpdate() {
    if (isPendingUpdate && !isUserInteracting()) {
        console.log("🔄 保留されていた自動アップデートを適用します...");
        isPendingUpdate = false;
        
        if (pendingUpdateData) {
            cachedDashboardData = pendingUpdateData;
            pendingUpdateData = null;
            
            initAreaTabs(cachedDashboardData);
            initStatusFilter(cachedDashboardData);
            updateFilterAndRender(false); 
        }
    }
}

function loadDashboardData(isAutoUpdate = false) {
    const params = new URLSearchParams(searchQuery);
    
    const hasKanriall = params.has('kanriall');
    const hasArea = params.has('area');
    const hasKindai = params.has('kindai');
    
    let hasValidStatus = false;
    if (params.has('status')) {
        const statusVal = params.get('status');
        if (statusVal && (statusVal.toLowerCase() === 'available' || statusVal === '利用可能')) {
            hasValidStatus = true;
        }
    }
    
    if (!hasKanriall && !hasArea && !hasKindai && !hasValidStatus) {
        console.log("Info: 有効なURLパラメータがありません。データをロードしません。");
        const loader = document.getElementById('loader');
        if (loader) loader.style.display = 'none';
        const helpBtn = document.querySelector('.help-button');
        if (helpBtn) helpBtn.style.display = 'none';
        return;
    }

    const timestamp = new Date().getTime();
    const loader = document.getElementById('loader');
    const errorScreen = document.getElementById('error-screen');
    
    if (!isAutoUpdate) {
        loader.style.display = 'flex';
    }
    errorScreen.style.display = 'none';
    
    if (window.isTestMode && window.dashboardData) {
        console.log("🧪 テストモード: ローカルの dashboard_data_test.js を使用します。");
        cachedDashboardData = window.dashboardData;
        initAreaTabs(cachedDashboardData);
        initStatusFilter(cachedDashboardData);
        const hasCachedPosition = localStorage.getItem('map_center_lat') !== null;
        const shouldFitBounds = !isAutoUpdate && isFirstLoad && !hasCachedPosition;
        updateFilterAndRender(shouldFitBounds);
        isFirstLoad = false;
        setTimeout(() => {
            loader.style.display = 'none';
        }, 500);
        return;
    }

    fetch('https://pub-1c068f2df9ab42a0b9dcc5d112078269.r2.dev/dashboard_data.json?t=' + timestamp)
        .then(response => {
            if (!response.ok) {
                throw new Error('JSON fetch failed, fallback to dashboard_data.js');
            }
            return response.json();
        })
        .then(data => {
            console.log("Success: 最新の dashboard_data.json を取得しました。");
            
            if (isAutoUpdate && isUserInteracting()) {
                console.log("⏳ ユーザー操作中またはポップアップ表示中のため、再描画を保留します。");
                pendingUpdateData = data;
                isPendingUpdate = true;
                return;
            }

            cachedDashboardData = data;
            initAreaTabs(cachedDashboardData);
            initStatusFilter(cachedDashboardData);
            
            const hasCachedPosition = localStorage.getItem('map_center_lat') !== null;
            const shouldFitBounds = !isAutoUpdate && isFirstLoad && !hasCachedPosition;
            updateFilterAndRender(shouldFitBounds);
            
            isFirstLoad = false;
            
            setTimeout(() => {
                loader.style.display = 'none';
            }, 500);
        })
        .catch(error => {
            console.log("Info: JSON直接取得をバイパスし、フォールバックJSの読み込みを試みます...", error);
            
            if (window.dashboardData) {
                console.log("Success: ローカルJS経由でデータを読み込みました (CORS制限回避)");
                const data = window.dashboardData;

                if (isAutoUpdate && isUserInteracting()) {
                    console.log("⏳ ユーザー操作中のため、ローカルデータの再描画を保留します。");
                    pendingUpdateData = data;
                    isPendingUpdate = true;
                    return;
                }

                cachedDashboardData = data;
                initAreaTabs(cachedDashboardData);
                initStatusFilter(cachedDashboardData);
                
                const hasCachedPosition = localStorage.getItem('map_center_lat') !== null;
                const shouldFitBounds = !isAutoUpdate && isFirstLoad && !hasCachedPosition;
                updateFilterAndRender(shouldFitBounds);
                
                isFirstLoad = false;
                loader.style.display = 'none';
            } else {
                loader.style.display = 'none';
                errorScreen.style.display = 'flex';
            }
        });
}
