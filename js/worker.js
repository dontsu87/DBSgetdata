// Worker Location Tracking and Mapping Logic
(function() {
    let workerPollInterval = null;
    let workerMarkers = {}; // tid をキーとしてマーカーオブジェクトを保持

    // APIのURL設定
    const R2_WORKER_LOCATIONS_URL = 'https://pub-1c068f2df9ab42a0b9dcc5d112078269.r2.dev/worker_locations.json';
    const LOCAL_WORKER_LOCATIONS_URL = 'http://localhost:5000/api/worker-locations';

    // ドキュメント読み込み完了時にセレクトボックスのリスナーを設定
    document.addEventListener("DOMContentLoaded", function() {
        // kindaiモード判定
        if (typeof isKindaiMode === "function" && isKindaiMode()) {
            const container = document.querySelector(".worker-select-container");
            if (container) {
                container.style.display = "none";
            }
            return;
        }

        const workerSelectCheckbox = document.getElementById("worker-select-checkbox");
        const workerSelectText = document.querySelector(".worker-select-text");

        if (workerSelectCheckbox) {
            // キャッシュから前回の選択状態を読み込み適用
            const cachedMode = typeof loadFromCache === "function" ? loadFromCache("selected_worker_mode", "none") : "none";
            const isChecked = (cachedMode === "admin");
            workerSelectCheckbox.checked = isChecked;
            updateWorkerToggleUI(isChecked);
            handleWorkerModeChange(cachedMode);

            workerSelectCheckbox.addEventListener("change", function() {
                const checked = workerSelectCheckbox.checked;
                const mode = checked ? "admin" : "none";
                updateWorkerToggleUI(checked);
                if (typeof saveToCache === "function") {
                    saveToCache("selected_worker_mode", mode);
                }
                handleWorkerModeChange(mode);
            });
        }

        function updateWorkerToggleUI(checked) {
            if (workerSelectText) {
                workerSelectText.innerText = checked ? '作業員位置 ON' : '作業員位置 OFF';
            }
        }
    });

    /**
     * 作業選択モードが変更されたときの処理
     */
    function handleWorkerModeChange(mode) {
        // 既存の定期更新タイマーをクリア
        if (workerPollInterval) {
            clearInterval(workerPollInterval);
            workerPollInterval = null;
        }

        if (mode === "admin") {
            console.log("👤 管理者モード: 作業員位置情報の表示を開始します。");
            // 即時フェッチ
            fetchAndPlotWorkerLocations();
            // 20秒ごとに定期ポーリング
            workerPollInterval = setInterval(fetchAndPlotWorkerLocations, 20000);
        } else {
            console.log("👤 作業員選択解除: マップ上の作業員マーカーを消去します。");
            clearWorkerMarkers();
        }
    }

    /**
     * サーバー(R2またはローカルAPI)から位置情報を取得してプロットする
     */
    function fetchAndPlotWorkerLocations() {
        const timestamp = new Date().getTime();
        
        // テストモード、またはローカル検証URLがクエリにある場合はローカルを優先
        const isLocalTest = window.isTestMode || 
                            window.location.hostname === 'localhost' || 
                            window.location.hostname === '127.0.0.1' ||
                            window.location.protocol === 'file:';
        
        const fetchUrl = isLocalTest ? `${LOCAL_WORKER_LOCATIONS_URL}?t=${timestamp}` : `${R2_WORKER_LOCATIONS_URL}?t=${timestamp}`;
 
        console.log(`🌐 作業員位置情報をフェッチ中: ${fetchUrl}`);
 
        fetch(fetchUrl)
            .then(response => {
                if (!response.ok) {
                    throw new Error("Fetch failed");
                }
                return response.json();
            })
            .then(data => {
                plotWorkers(data);
            })
            .catch(error => {
                if (fetchUrl === LOCAL_WORKER_LOCATIONS_URL) {
                    console.log("Warning: ローカルAPIからのフェッチに失敗しました。クラウド(R2)への接続を試みます...", error);
                    fetch(`${R2_WORKER_LOCATIONS_URL}?t=${timestamp}`)
                        .then(res => {
                            if (!res.ok) throw new Error("Cloud fetch failed");
                            return res.json();
                        })
                        .then(data => plotWorkers(data))
                        .catch(err => console.error("Error: クラウド(R2)への接続も失敗しました:", err));
                } else {
                    console.log("Warning: クラウド(R2)からのフェッチに失敗しました。ローカルAPIへの接続を試みます...", error);
                    fetch(`${LOCAL_WORKER_LOCATIONS_URL}?t=${timestamp}`)
                        .then(res => {
                            if (!res.ok) throw new Error("Local fetch failed");
                            return res.json();
                        })
                        .then(data => plotWorkers(data))
                        .catch(err => console.error("Error: ローカルAPIへの接続も失敗しました:", err));
                }
            });
    }

    /**
     * 取得した位置情報オブジェクトをマップ上に描画する
     */
    function plotWorkers(workerData) {
        if (!window.map) {
            console.error("Error: Leaflet map instance is not initialized.");
            return;
        }

        const activeTids = new Set();

        // データをループしてマーカーを作成・更新
        for (const tid in workerData) {
            const worker = workerData[tid];
            if (!worker.lat || !worker.lon) continue;

            // 時間経過によるフィルタリング（日本時間 JST 基準）
            let isOffline = false;
            let isHidden = false;
            if (worker.updated_at) {
                try {
                    // 'YYYY-MM-DD HH:MM:SS' を 'YYYY-MM-DDTHH:MM:SS+09:00' にしてパース
                    const formattedDateStr = worker.updated_at.trim().replace(' ', 'T') + '+09:00';
                    const updateTime = new Date(formattedDateStr);
                    const now = new Date();
                    const diffMs = now - updateTime;

                    if (diffMs >= 24 * 60 * 60 * 1000) {
                        isHidden = true; // 1日以上通信なしなら非表示
                    } else if (diffMs >= 30 * 60 * 1000) {
                        isOffline = true; // 30分以上通信なしなら灰色
                    }
                } catch (e) {
                    console.error("Error parsing worker updated_at:", e);
                }
            }

            if (isHidden) continue;

            const latlng = [parseFloat(worker.lat), parseFloat(worker.lon)];
            activeTids.add(tid);

            // すでにマーカーが存在する場合は位置を更新
            if (workerMarkers[tid]) {
                workerMarkers[tid].setLatLng(latlng);
                
                // オフライン状態に応じてDOMクラスを更新
                const markerElem = workerMarkers[tid].getElement();
                if (markerElem) {
                    if (isOffline) {
                        markerElem.classList.add('offline');
                    } else {
                        markerElem.classList.remove('offline');
                    }
                }
                
                // ポップアップの内容を常に最新に更新
                workerMarkers[tid].setPopupContent(createPopupContent(worker, isOffline));
            } else {
                // 新規マーカーを作成 (パルス波を付与したカスタムDivIcon)
                const workerIcon = L.divIcon({
                    className: 'worker-map-marker-container' + (isOffline ? ' offline' : ''),
                    html: `
                        <div class="worker-marker-pulse"></div>
                        <div class="worker-map-marker">${tid}</div>
                    `,
                    iconSize: [32, 32],
                    iconAnchor: [16, 38] // 下部中央に配置
                });

                const marker = L.marker(latlng, { 
                    icon: workerIcon,
                    zIndexOffset: 1000 // 車両ピンより手前に表示
                })
                .addTo(window.map)
                .bindPopup(createPopupContent(worker, isOffline), {
                    offset: [0, -28]
                });

                workerMarkers[tid] = marker;
            }
        }

        // 送信データに存在しなくなった古い作業員マーカーをマップから削除
        for (const tid in workerMarkers) {
            if (!activeTids.has(tid)) {
                window.map.removeLayer(workerMarkers[tid]);
                delete workerMarkers[tid];
            }
        }
    }

    /**
     * マーカー内のポップアップHTMLを生成する
     */
    function createPopupContent(worker, isOffline) {
        const offlineWarning = isOffline ? ' <span style="color: #ef4444; font-weight: bold;">(長時間通信なし)</span>' : '';
        return `
            <div style="font-size: 13px; line-height: 1.4; padding: 4px; min-width: 150px; color: #1e293b;">
                <div style="font-weight: bold; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                    👤 作業員 (TID: ${worker.tid})${offlineWarning}
                </div>
                <div style="margin-bottom: 4px;">
                    <b>現在位置:</b> <span style="font-family: monospace;">${parseFloat(worker.lat).toFixed(5)}, ${parseFloat(worker.lon).toFixed(5)}</span>
                </div>
                <div style="font-size: 11px; color: #64748b;">
                    <b>最終更新:</b> ${worker.updated_at || '不明'}
                </div>
            </div>
        `;
    }

    /**
     * すべての作業員マーカーをマップから削除
     */
    function clearWorkerMarkers() {
        for (const tid in workerMarkers) {
            if (window.map) {
                window.map.removeLayer(workerMarkers[tid]);
            }
        }
        workerMarkers = {};
    }
})();
