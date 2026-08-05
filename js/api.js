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
            updatePrefixFilterUI(cachedDashboardData);
            initStatusFilter(cachedDashboardData);
            updateFilterAndRender(false); 
        }
    }
}

function loadDashboardData(isAutoUpdate = false, retryCount = 0) {
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
    
    // すでにキャッシュデータがある場合は、読み込み開始時でもエラー画面は表示しない
    if (!cachedDashboardData) {
        errorScreen.style.display = 'none';
    }
    
    if (window.isTestMode && window.dashboardData) {
        console.log("🧪 テストモード: ローカルの dashboard_data_test.js を使用します。");
        cachedDashboardData = window.dashboardData;
        initAreaTabs(cachedDashboardData);
        updatePrefixFilterUI(cachedDashboardData);
        initStatusFilter(cachedDashboardData);
        const hasCachedPosition = localStorage.getItem('map_center_lat') !== null;
        const shouldFitBounds = !isAutoUpdate && isFirstLoad && !hasCachedPosition;
        if (typeof fetchSelfReplacements === 'function') {
            fetchSelfReplacements().finally(() => {
                updateFilterAndRender(shouldFitBounds);
            });
        } else {
            updateFilterAndRender(shouldFitBounds);
        }
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
            updatePrefixFilterUI(cachedDashboardData);
            initStatusFilter(cachedDashboardData);
            
            const hasCachedPosition = localStorage.getItem('map_center_lat') !== null;
            const shouldFitBounds = !isAutoUpdate && isFirstLoad && !hasCachedPosition;
            if (typeof fetchSelfReplacements === 'function') {
                fetchSelfReplacements().finally(() => {
                    updateFilterAndRender(shouldFitBounds);
                });
            } else {
                updateFilterAndRender(shouldFitBounds);
            }
            
            isFirstLoad = false;
            
            // 正常取得できたらエラー画面を隠す
            errorScreen.style.display = 'none';
            
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
                updatePrefixFilterUI(cachedDashboardData);
                initStatusFilter(cachedDashboardData);
                
                const hasCachedPosition = localStorage.getItem('map_center_lat') !== null;
                const shouldFitBounds = !isAutoUpdate && isFirstLoad && !hasCachedPosition;
                if (typeof fetchSelfReplacements === 'function') {
                    fetchSelfReplacements().finally(() => {
                        updateFilterAndRender(shouldFitBounds);
                    });
                } else {
                    updateFilterAndRender(shouldFitBounds);
                }
                
                isFirstLoad = false;
                errorScreen.style.display = 'none';
                loader.style.display = 'none';
            } else {
                // 自動リトライロジック
                if (retryCount < 2) {
                    const delay = 1500;
                    console.warn(`⚠️ データの読み込みに失敗しました。${delay}ms 後に自動リトライします (リトライ回数: ${retryCount + 1}/2)...`, error);
                    setTimeout(() => {
                        loadDashboardData(isAutoUpdate, retryCount + 1);
                    }, delay);
                    return;
                }

                loader.style.display = 'none';
                
                // すでに1度でもデータを読み込めている場合は、既存表示を維持しエラー画面にはしない
                if (cachedDashboardData) {
                    console.warn("⚠️ 最新データの取得に失敗しましたが、既存のキャッシュデータを維持します。");
                } else {
                    errorScreen.style.display = 'flex';
                }
            }
        });
}

// 📱 アプリがフォアグラウンドに復帰した時の自動再ロード処理
document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') {
        console.log("📱 アプリがフォアグラウンドに復帰しました。最新データを読み込みます...");
        const errorScreen = document.getElementById('error-screen');
        const isErrorVisible = errorScreen && errorScreen.style.display === 'flex';
        // エラー画面が表示されている場合は通常ロード、そうでない場合はサイレントロード
        loadDashboardData(isErrorVisible ? false : true);
    }
});

// DOMContentLoaded時に再試行ボタンのイベントを設定
document.addEventListener('DOMContentLoaded', function() {
    const retryBtn = document.getElementById('retry-btn');
    if (retryBtn) {
        retryBtn.addEventListener('click', function() {
            console.log("🔄 再試行ボタンがクリックされました。データを再読み込みします...");
            loadDashboardData(false);
        });
    }
});
