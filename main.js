document.addEventListener("DOMContentLoaded", function() {
    // ヘルプマニュアルのリンクに、親アプリのURLパラメータを引き継ぐ
    const helpBtn = document.querySelector('.help-button');
    if (helpBtn && window.location.search) {
        helpBtn.href = 'docs/manual.html' + window.location.search;
    }

    let map;
    let currentPositionMarker;
    let currentPositionCircle;
    
    // データキャッシュ、マーカーレイヤーグループ、選択されたエリア、選択された車両状態の定義
    let cachedDashboardData = null;
    let markerGroup;
    let selectedArea = ""; // 選択中のエリア名
    let checkedStatuses = []; // 選択中の車両状態フィルターの配列
    
    // 自動更新保留用の制御状態
    let prevStatusesStr = ""; // 前回のステータス一覧の文字列
    let prevAreasStr = ""; // 前回のエリア一覧の文字列
    let isMapInteracting = false; // ユーザーがマップ操作中かどうかのフラグ
    let isPendingUpdate = false;  // 保留中の自動更新があるかどうか
    let pendingUpdateData = null; // 保留された最新データ
    let interactionTimer = null;  // 操作終了を検知するディレイタイマー
    let mapInteractionTimer = null; // マップ操作終了検知用の個別タイマー



    // 1. 地図の初期設定 (デフォルト表示位置は金沢)
    map = L.map('map', {
        zoomControl: false, // タブレットで邪魔にならないようズームボタンを非表示（ピンチ操作可能）
        tap: true,          // タッチ端末のクリックラグ解消
        doubleClickZoom: false, // ダブルクリックズームを無効化（ダブルタップドラッグと競合するため）
        zoomSnap: 0        // 完全に滑らかな無段階ズームを可能にする
    }).setView([36.568, 136.648], 13);

    // 【実験的機能 / 未完全】ダブルタップ＋ドラッグズームの自前実装 (Android/Chrome等のブラウザジェスチャー競合回避用)
    // ※環境（Android Chrome等）によってはブラウザ側の標準動作と競合し、正常に機能しない場合があります。
    // ※通常のドラッグや2本指ピンチズーム等の基本操作への悪影響はありません。
    (function() {
        let lastTapTime = 0;
        let isDoubleTapDragging = false;
        let startY = 0;
        let startZoom = 0;
        
        const mapContainer = map.getContainer();
        
        mapContainer.addEventListener('touchstart', function(e) {
            if (e.touches.length !== 1) return; // 指1本の場合のみ処理
            
            const currentTime = new Date().getTime();
            const tapDelay = currentTime - lastTapTime;
            
            if (tapDelay < 300) {
                // 300ms以内の連続タップでダブルタップと判定
                isDoubleTapDragging = true;
                startY = e.touches[0].clientY;
                startZoom = map.getZoom();
                // ブラウザ標準のダブルタップズーム動作を強制抑止
                e.preventDefault();
            }
            
            lastTapTime = currentTime;
        }, { passive: false });
        
        mapContainer.addEventListener('touchmove', function(e) {
            if (!isDoubleTapDragging) return;
            if (e.touches.length !== 1) return; // 指が2本以上になったら中断
            
            // スクロールやページスライドなどのブラウザデフォルト挙動を防止
            e.preventDefault();
            
            const currentY = e.touches[0].clientY;
            const diffY = startY - currentY; // 上にスライドするとズームアップ（値がプラス）
            
            // 感度調整 (80px スライドでズームが 1段階 変化する程度)
            const zoomDelta = diffY / 80; 
            let targetZoom = startZoom + zoomDelta;
            
            // マップの制限範囲内に収める
            targetZoom = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), targetZoom));
            
            // 滑らかにズーム (zoomSnap: 0 なので小数値も許容)
            map.setZoom(targetZoom, { animate: false });
        }, { passive: false });
        
        mapContainer.addEventListener('touchend', function(e) {
            if (isDoubleTapDragging) {
                isDoubleTapDragging = false;
                e.preventDefault();
            }
        }, { passive: false });
    })();

    // ベースマップレイヤーの定義
    const baseMaps = {
        googleRoad: L.tileLayer('https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', {
            maxZoom: 21,
            attribution: '&copy; <a href="https://maps.google.com/" target="_blank">Google Maps</a>'
        }),
        googleSatellite: L.tileLayer('https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
            maxZoom: 21,
            attribution: '&copy; <a href="https://maps.google.com/" target="_blank">Google Maps</a>'
        }),
        gsiStd: L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/std/{z}/{x}/{y}.png', {
            maxZoom: 18,
            attribution: '&copy; <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>'
        }),
        gsiPale: L.tileLayer('https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png', {
            maxZoom: 18,
            attribution: '&copy; <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank">国土地理院</a>'
        })
    };

    // デフォルトでGoogleマップ（道路）を表示
    let currentBaseLayer = baseMaps.googleRoad;
    currentBaseLayer.addTo(map);

    // ベースマップの切り替えイベントリスナー登録
    document.querySelectorAll('input[name="basemap-select"]').forEach(radio => {
        radio.addEventListener('change', function(e) {
            const selectedVal = e.target.value;
            if (baseMaps[selectedVal]) {
                map.removeLayer(currentBaseLayer);
                currentBaseLayer = baseMaps[selectedVal];
                currentBaseLayer.addTo(map);
            }
        });
    });

    // --- 右パネルのアコーディオン（折りたたみ）制御 ---
    function isMobileLayout() {
        return window.innerWidth <= 768;
    }

    const basemapHeader = document.getElementById('basemap-header-btn');
    const basemapPanel = document.getElementById('basemap-panel');
    const basemapContainer = document.getElementById('basemap-options-container');
    const basemapArrow = basemapHeader.querySelector('.panel-arrow');

    basemapHeader.addEventListener('click', function() {
        if (isMobileLayout()) return; // スマホドロワー内では無効化
        
        const isExpanded = basemapPanel.classList.toggle('expanded');
        if (isExpanded) {
            basemapContainer.style.maxHeight = basemapContainer.scrollHeight + 'px';
            basemapArrow.style.transform = 'rotate(180deg)';
        } else {
            basemapContainer.style.maxHeight = '0px';
            basemapArrow.style.transform = 'rotate(0deg)';
        }
    });

    const statusHeader = document.getElementById('status-header-btn');
    const statusPanel = document.getElementById('status-filter-panel');
    const statusContainer = document.getElementById('status-options-container');
    const statusArrow = statusHeader.querySelector('.panel-arrow');

    statusHeader.addEventListener('click', function() {
        if (isMobileLayout()) return; // スマホドロワー内では無効化
        
        const isExpanded = statusPanel.classList.toggle('expanded');
        if (isExpanded) {
            statusContainer.style.maxHeight = statusContainer.scrollHeight + 'px';
            statusArrow.style.transform = 'rotate(180deg)';
        } else {
            statusContainer.style.maxHeight = '0px';
            statusArrow.style.transform = 'rotate(0deg)';
        }
    });

    // 画面サイズ変更時（リサイズ）にスマホ表示とPC表示の不整合を防ぐ自動補正
    window.addEventListener('resize', function() {
        if (isMobileLayout()) {
            // スマホ用のスタイルへリセット
            basemapContainer.style.maxHeight = '';
            statusContainer.style.maxHeight = '';
            basemapArrow.style.transform = '';
            statusArrow.style.transform = '';
        } else {
            // デスクトップ用のアコーディオン状態（初期：閉じた状態）にリセット
            if (!basemapPanel.classList.contains('expanded')) {
                basemapContainer.style.maxHeight = '0px';
                basemapArrow.style.transform = 'rotate(0deg)';
            } else {
                basemapContainer.style.maxHeight = basemapContainer.scrollHeight + 'px';
                basemapArrow.style.transform = 'rotate(180deg)';
            }
            
            if (!statusPanel.classList.contains('expanded')) {
                statusContainer.style.maxHeight = '0px';
                statusArrow.style.transform = 'rotate(0deg)';
            } else {
                statusContainer.style.maxHeight = statusContainer.scrollHeight + 'px';
                statusArrow.style.transform = 'rotate(180deg)';
            }
        }
    });

    // ズームコントロールを手動で左上に小さく追加 (右上の状態フィルタと重ならないように調整)
    L.control.zoom({ position: 'topleft' }).addTo(map);
    
    // マーカーレイヤーグループを初期化して地図に追加
    markerGroup = L.layerGroup().addTo(map);

    // 2. 自動データ取得処理 (JSON/JS両対応ハイブリッド型 - タイムスタンプ付与による超強力リアルタイムキャッシュ対策)
    let openPortName = null; // 現在ポップアップが開いているポートの名前を記録
    let isFirstLoad = true; // 初回ロード判定

    // ユーザー操作中判定ロジック
    function isUserInteracting() {
        return isMapInteracting || openPortName !== null;
    }

    // 保留されていた更新を適用する関数
    function checkAndApplyPendingUpdate() {
        if (isPendingUpdate && !isUserInteracting()) {
            console.log("🔄 保留されていた自動アップデートを適用します...");
            isPendingUpdate = false;
            
            if (pendingUpdateData) {
                cachedDashboardData = pendingUpdateData;
                pendingUpdateData = null;
                
                initAreaTabs(cachedDashboardData);
                initStatusFilter(cachedDashboardData);
                updateFilterAndRender(false); // 自動更新時はズーム位置を維持
            }
        }
    }

    // マップ操作状態を検知するリスナー
    map.on('movestart', function() {
        isMapInteracting = true;
        if (mapInteractionTimer) clearTimeout(mapInteractionTimer);
    });

    map.on('moveend', function() {
        // 操作終了後、5秒待ってから保留中の更新があれば適用
        if (mapInteractionTimer) clearTimeout(mapInteractionTimer);
        mapInteractionTimer = setTimeout(function() {
            isMapInteracting = false;
            checkAndApplyPendingUpdate();
        }, 5000);
    });


    // ポップアップの開閉を監視して開いているポート名を記録
    map.on('popupopen', function(e) {
        const source = e.source || (e.popup && e.popup._source); // ポップアップを開いたマーカー
        if (source && source.portName) {
            openPortName = source.portName;
            console.log("Popup opened for:", openPortName);
        }
        if (interactionTimer) clearTimeout(interactionTimer);
    });

    map.on('popupclose', function(e) {
        openPortName = null;
        // ポップアップが閉じた後、5秒待ってから保留中の更新があれば適用
        if (interactionTimer) clearTimeout(interactionTimer);
        interactionTimer = setTimeout(function() {
            checkAndApplyPendingUpdate();
        }, 5000);
    });

    function loadDashboardData(isAutoUpdate = false) {
        const params = new URLSearchParams(window.location.search);
        
        // 許可されている有効なパラメータがあるかチェック
        const hasKanriall = params.has('kanriall');
        const hasArea = params.has('area');
        const hasKindai = params.has('kindai');
        
        // status パラメータの検証 (指定されている場合は 'available' または '利用可能' のみ有効とする)
        let hasValidStatus = false;
        if (params.has('status')) {
            const statusVal = params.get('status');
            if (statusVal && (statusVal.toLowerCase() === 'available' || statusVal === '利用可能')) {
                hasValidStatus = true;
            }
        }
        
        // いずれの有効なパラメータも存在しない場合は、描画を行わず空のマップを表示 (入力されていないのと同じ扱い)
        if (!hasKanriall && !hasArea && !hasKindai && !hasValidStatus) {
            console.log("Info: 有効なURLパラメータがありません。データをロードしません。");
            const loader = document.getElementById('loader');
            if (loader) loader.style.display = 'none';
            // ヘルプボタン自体も非表示にする
            const helpBtn = document.querySelector('.help-button');
            if (helpBtn) helpBtn.style.display = 'none';
            return;
        }

        const timestamp = new Date().getTime();
        const loader = document.getElementById('loader');
        const errorScreen = document.getElementById('error-screen');
        
        // 初回ロードまたは手動エリア変更等の時のみローダーを表示
        // 2分ごとの定期自動更新時は画面を白く点滅させず、裏側でサイレントに更新します
        if (!isAutoUpdate) {
            loader.style.display = 'flex';
        }
        errorScreen.style.display = 'none';
        
        // サーバー上（GitHub Pages等）での実行時は、動的にタイムスタンプを付与してキャッシュを強制バイパスして最新JSONを取得します
        fetch('https://pub-1c068f2df9ab42a0b9dcc5d112078269.r2.dev/dashboard_data.json?t=' + timestamp)
            .then(response => {
                if (!response.ok) {
                    throw new Error('JSON fetch failed, fallback to dashboard_data.js');
                }
                return response.json();
            })
            .then(data => {
                console.log("Success: 最新の dashboard_data.json を取得しました。");
                
                // ユーザーが操作中またはポップアップ表示中の場合は、更新を保留する
                if (isAutoUpdate && isUserInteracting()) {
                    console.log("⏳ ユーザー操作中またはポップアップ表示中のため、再描画を保留します。");
                    pendingUpdateData = data;
                    isPendingUpdate = true;
                    return;
                }

                cachedDashboardData = data;
                initAreaTabs(cachedDashboardData);
                initStatusFilter(cachedDashboardData);
                
                // 自動更新（isAutoUpdate=true）の時はズーム・位置を動かさない（維持する）
                const shouldFitBounds = !isAutoUpdate && isFirstLoad;
                updateFilterAndRender(shouldFitBounds);
                
                isFirstLoad = false;
                
                // ロード終了処理
                setTimeout(() => {
                    loader.style.display = 'none';
                }, 500);
            })
            .catch(error => {
                console.log("Info: JSON直接取得をバイパスし、フォールバックJSの読み込みを試みます...", error);
                
                // JSON取得がコケた場合（ローカルファイル実行時など）は、静的ロードした window.dashboardData を使用
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
                    
                    const shouldFitBounds = !isAutoUpdate && isFirstLoad;
                    updateFilterAndRender(shouldFitBounds);
                    
                    isFirstLoad = false;
                    loader.style.display = 'none';
                } else {
                    loader.style.display = 'none';
                    errorScreen.style.display = 'flex';
                }
            });
    }

    // 金沢大学サポーター用の設定と判定
    function isKindaiMode() {
        const params = new URLSearchParams(window.location.search);
        return params.has('kindai');
    }

    const KINDAI_PORTS_MASTER = {
        "00001685": { name: "E13_臨時 角間キャンパス北地区駐車場", lat: 36.5485, lon: 136.7025 },
        "00001686": { name: "E14_臨時 角間キャンパス南地区駐車場", lat: 36.54614, lon: 136.703719 },
        "00001684": { name: "101.ネッツトヨタ石川田上もりの里店", lat: 36.544754, lon: 136.690079 },
        "00001683": { name: "E12_臨時 イオンもりの里店", lat: 36.552681, lon: 136.691265 },
        "00000352": { name: "100.若松バス停前駐輪場", lat: 36.553937, lon: 136.69042 },
        "00001682": { name: "108.アルビスくらす杜の里店", lat: 36.559986, lon: 136.683003 },
        "00004334": { name: "104.浅野川すずかけ公園", lat: 36.55598, lon: 136.68486 },
        "00089057": { name: "55.天神高架橋下第２自転車駐輪場", lat: 36.559343, lon: 136.67713 }
    };

    const KINDAI_STATION_IDS = Object.keys(KINDAI_PORTS_MASTER);

    // 初期ロードの実行
    if (isKindaiMode()) {
        // kindaiモード時は凡例フィルタをサポーター用に設定 (5,4,3のみON、他はOFF)
        document.querySelectorAll('.legend-filter').forEach(el => {
            const val = parseInt(el.value);
            if (val === 5 || val === 4 || val === 3) {
                el.checked = true;
            } else {
                el.checked = false;
            }
        });
    }
    loadDashboardData(false);

    // 2分ごと(120000ms)にバックグラウンドでサイレント自動更新を繰り返す
    setInterval(function() {
        console.log("🔄 定期自動アップデートを実行中...");
        loadDashboardData(true);
    }, 120000);

    // URLパラメータから制限エリアを取得
    function getRestrictedArea() {
        const params = new URLSearchParams(window.location.search);
        // kanriallモードのときは制限なし
        if (params.has('kanriall')) {
            return null;
        }
        return params.get('area'); // 例: "KNZ" または "KNZ_金沢市公共シェアサイクルまちのり事務局"
    }

    // 3. エリア選択タブの動的初期生成
    function initAreaTabs(data) {
        if (!data || !data.ports) return;
        
        // 数据に含まれる全てのエリア名をユニークに抽出
        let areas = Array.from(new Set(data.ports.map(p => p.area_name))).filter(Boolean);
        
        // URLパラメータによるエリア制限
        const limitAreaParam = getRestrictedArea();
        if (isKindaiMode()) {
            // 金沢大学モードのときは金沢エリアに強制固定
            const matchedArea = areas.find(a => a.includes("KNZ"));
            if (matchedArea) {
                areas = [matchedArea];
                selectedArea = matchedArea;
            }
        } else if (limitAreaParam) {
            // 部分一致するエリア名だけを抽出 (例: "KNZ" が指定されたら "KNZ_金沢..." に一致させる)
            const matchedArea = areas.find(a => a.toLowerCase().includes(limitAreaParam.toLowerCase()));
            if (matchedArea) {
                areas = [matchedArea];
                selectedArea = matchedArea; // 強制的にそのエリアを選択
            }
        }
        
        // デフォルトは金沢エリア（KNZを含むもの）を最優先、なければ最初のエリア
        if (!selectedArea) {
            selectedArea = areas.find(a => a.includes("KNZ")) || areas[0] || "";
        }

        const currentAreasStr = areas.sort().join(',');
        const tabsContainer = document.getElementById('area-tabs');

        // エリアリストに変更がない場合は、DOMの再生成をスキップしてタブのアクティブクラスの切り替えのみ行う
        if (currentAreasStr === prevAreasStr) {
            const tabs = tabsContainer.querySelectorAll('.area-tab');
            tabs.forEach(tab => {
                const tabAreaName = tab.getAttribute('data-area');
                if (tabAreaName === selectedArea) {
                    tab.classList.add('active');
                } else {
                    tab.classList.remove('active');
                }
            });
            return;
        }

        prevAreasStr = currentAreasStr;
        tabsContainer.innerHTML = '';
        
        // タブが1つだけの場合は、エリアタブバー自体を非表示にして画面を広くする
        if (areas.length <= 1) {
            tabsContainer.style.display = 'none';
        } else {
            tabsContainer.style.display = 'flex';
        }
        
        areas.forEach(area => {
            const btn = document.createElement('button');
            btn.className = 'area-tab' + (area === selectedArea ? ' active' : '');
            btn.setAttribute('data-area', area);
            
            // 表示名を見栄え良く調整 (KNZ_まちのり -> KNZ まちのり)
            btn.innerText = area.replace(/_/g, ' ');
            
            btn.addEventListener('click', () => {
                document.querySelectorAll('.area-tab').forEach(t => t.classList.remove('active'));
                btn.classList.add('active');
                selectedArea = area;
                updateFilterAndRender();
            });
            
            tabsContainer.appendChild(btn);
        });
    }

    // URLパラメータから制限する車両状態を取得
    function getRestrictedStatus() {
        const params = new URLSearchParams(window.location.search);
        // kanriallモード、またはarea指定モードのときは制限なし
        if (params.has('kanriall') || params.has('area')) {
            return null;
        }
        // それ以外（通常モードなど）はすべて「利用可能」に固定制限する
        return '利用可能';
    }

    // 3-2. 車両状態 (Status) フィルターの動的初期生成
    function initStatusFilter(data) {
        if (!data || !data.ports) return;

        // URLパラメータによる車両状態の制限確認
        const restrictedStatus = getRestrictedStatus();

        if (restrictedStatus) {
            // 「利用可能」のみにロック
            checkedStatuses = [restrictedStatus];
            
            // パネル全体とスマホ用トグルボタンを非表示
            const statusPanel = document.getElementById('status-filter-panel');
            if (statusPanel) statusPanel.style.display = 'none';
            
            const statusBtn = document.querySelector('.btn-status');
            if (statusBtn) statusBtn.style.display = 'none';
            
            return; // チェックボックスの動的生成自体をスキップ
        }

        // データに含まれる全ての車両状態（status）をユニークに抽出
        const statuses = new Set();
        data.ports.forEach(port => {
            port.bikes.forEach(bike => {
                if (bike.status) {
                    statuses.add(bike.status.trim());
                }
            });
        });

        const sortedStatuses = Array.from(statuses).sort();
        const currentStatusesStr = sortedStatuses.join(',');

        // 初回ロード時、または checkedStatuses が空のときはすべて選択状態にする
        if (checkedStatuses.length === 0) {
            checkedStatuses = [...sortedStatuses];
        } else {
            // 以前選択されていたステータスのうち、現在も存在するものだけを維持
            // かつ、もし新しいステータスがデータ内に出現した場合は、デフォルトでONにする
            const newStatuses = sortedStatuses.filter(s => !checkedStatuses.includes(s) && !prevStatusesStr.split(',').includes(s));
            checkedStatuses = checkedStatuses.filter(s => sortedStatuses.includes(s)).concat(newStatuses);
        }

        // ステータスの種類に変化がない場合は、DOMの再生成をスキップしてチェック状態のみを同期
        if (currentStatusesStr === prevStatusesStr) {
            const container = document.getElementById('status-checkboxes-container');
            if (container) {
                const checkboxes = container.querySelectorAll('.status-filter');
                checkboxes.forEach(cb => {
                    cb.checked = checkedStatuses.includes(cb.value);
                });
            }
            return;
        }

        prevStatusesStr = currentStatusesStr;
        const container = document.getElementById('status-checkboxes-container');
        container.innerHTML = '';

        sortedStatuses.forEach(status => {
            const label = document.createElement('label');
            label.className = 'status-filter-item';
            
            const isChecked = checkedStatuses.includes(status);
            label.innerHTML = `
                <div style="display: flex; align-items: center;">
                    <span><b>${status}</b></span>
                </div>
                <input type="checkbox" class="status-filter" value="${status}" ${isChecked ? 'checked' : ''}>
            `;

            const checkbox = label.querySelector('input');
            checkbox.addEventListener('change', function() {
                if (checkbox.checked) {
                    if (!checkedStatuses.includes(status)) {
                        checkedStatuses.push(status);
                    }
                } else {
                    checkedStatuses = checkedStatuses.filter(s => s !== status);
                }
                updateFilterAndRender();
            });

            container.appendChild(label);
        });
    }

    // 4. フィルター状態の更新と再描画
    function updateFilterAndRender(shouldFitBounds = true) {
        if (!cachedDashboardData) return;
        
        // チェックされている警告レベルの値を取得
        const checkedLevels = Array.from(document.querySelectorAll('.legend-filter:checked'))
                                   .map(el => parseInt(el.value));
                                   
        renderDashboardWithFilter(cachedDashboardData, checkedLevels, checkedStatuses, shouldFitBounds);
    }

    // 凡例のチェックボックス変更時に再描画を連動 (この時はマップ範囲をフィットさせる)
    document.querySelectorAll('.legend-filter').forEach(checkbox => {
        checkbox.addEventListener('change', () => updateFilterAndRender(true));
    });

    // 5. フィルター（警告レベル ＆ 車両状態 ＆ 選択エリア）適用済みのダッシュボード描画関数
    function renderDashboardWithFilter(data, checkedLevels, targetStatuses, shouldFitBounds = true) {
        if (!data || !data.ports) return;

        // 引数がない場合の安全なフォールバック
        if (!targetStatuses) {
            targetStatuses = checkedStatuses;
        }

        // 以前のマーカーを全てクリア
        markerGroup.clearLayers();

        // 更新日時の反映
        document.getElementById('update-time').innerHTML = `
            最終更新: ${data.updated_at || "不明"}
            <span class="update-note">リアルタイムではないため、数分前の情報が表示されている可能性があります</span>
        `;

        let validCoordinates = [];
        let filteredPortsCount = 0;
        let filteredBikesCount = 0;
        let allFilteredBikes = []; // フィルターに合致した全自転車を蓄積
        let activePopupMarker = null; // 現在開いていたポート名に一致する新しいマーカー

        data.ports.forEach(port => {
            const lat = parseFloat(port.lat);
            const lon = parseFloat(port.lon);
            
            if (isNaN(lat) || isNaN(lon) || lat === 0.0 || lon === 0.0) {
                return; // 位置情報のないポートはスキップ
            }

            // 1. エリアフィルターを適用：選択されていないエリアは描画対象外
            if (port.area_name !== selectedArea) {
                return;
            }

            // 金沢大学モード時のポートID絞り込み (station_id がリストにない場合は描画対象外)
            if (isKindaiMode()) {
                if (!port.station_id || !KINDAI_STATION_IDS.includes(port.station_id)) {
                    return;
                }
            }

            // 自転車が0台のポートかどうかを判定
            const isEmptyPort = (parseInt(port.total_bikes) === 0 || !port.bikes || port.bikes.length === 0);

            // 2. 警告レベルフィルター ＆ 車両状態フィルターを適用：合致する自転車のみを抽出
            const matchingBikes = isEmptyPort ? [] : port.bikes.filter(bike => 
                checkedLevels.includes(bike.alert_level) && 
                (bike.status ? targetStatuses.includes(bike.status.trim()) : false)
            );

            // 描画判定
            // 自転車が0台のポートは凡例のチェック(-1)が入っている時のみ表示。それ以外はフィルターに合致する自転車が1台以上いる場合のみ表示
            let isDrawPort = (isEmptyPort && checkedLevels.includes(-1)) || (!isEmptyPort && matchingBikes.length > 0);

            // 金沢大学モードのときは、対象8ポートであれば自転車0台(または表示対象0台)であっても常にピンを表示する
            if (isKindaiMode()) {
                isDrawPort = true;
            }

            if (!isDrawPort) {
                return; // 該当する自転車がいないポートは描画しない
            }

            // 合致した自転車を全体バッファに蓄積
            allFilteredBikes.push(...matchingBikes);

            validCoordinates.push([lat, lon]);
            filteredPortsCount++;
            filteredBikesCount += matchingBikes.length;

            // 表示対象の自転車が0台かどうかのフラグ
            const isActuallyEmpty = isEmptyPort || matchingBikes.length === 0;

            let markerIcon;
            let zIndexOrder = 100;
            
            if (isActuallyEmpty) {
                // 自転車0台：正常より目立たない薄いグレー、中に「0」を薄く表示、サイズ[20,20]
                markerIcon = L.divIcon({
                    className: 'port-marker-empty',
                    html: '<div>0</div>',
                    iconSize: [20, 20],
                    iconAnchor: [10, 10]
                });
                zIndexOrder = 10; // 最背面
            } else {
                // 抽出された自転車の中での最大警告レベルを算出
                const maxLevel = Math.max(...matchingBikes.map(b => b.alert_level));
                let className = 'port-marker-base ';
                
                // 同一深刻度内では台数が多いものが上に表示されるよう、台数をオフセットとして加算
                const bikeCountOffset = matchingBikes.length;
                if (maxLevel === 5) {
                    className += 'port-marker-level5';
                    zIndexOrder = 20000 + bikeCountOffset; // AT異常
                } else if (maxLevel === 4) {
                    className += 'port-marker-level4';
                    zIndexOrder = 15000 + bikeCountOffset; // 電圧閾値
                } else if (maxLevel === 3) {
                    className += 'port-marker-level3';
                    zIndexOrder = 10000 + bikeCountOffset; // Lv1
                } else if (maxLevel === 2) {
                    className += 'port-marker-level2';
                    zIndexOrder = 5000 + bikeCountOffset;  // Lv2
                } else if (maxLevel === 1) {
                    className += 'port-marker-level1';
                    zIndexOrder = 1000 + bikeCountOffset;  // Lv3
                } else {
                    className += 'port-marker-normal';
                    zIndexOrder = 500 + bikeCountOffset;   // 正常
                }

                // 正常(0)も含むすべてのレベルで台数を表示するように統一
                markerIcon = L.divIcon({
                    className: className,
                    html: `<div>${matchingBikes.length}</div>`,
                    iconSize: maxLevel >= 4 ? [32, 32] : [28, 28],
                    iconAnchor: maxLevel >= 4 ? [16, 16] : [14, 14]
                });
            }

            const marker = L.marker([lat, lon], {
                icon: markerIcon,
                zIndexOffset: zIndexOrder,
                riseOnHover: true
            }).addTo(markerGroup);

            // Leafletの「緯度ベースY座標 + zIndexOffset」による自動z-index計算を上書き
            // デフォルトでは南側ポートほどz-indexが高くなり、台数差を上回る場合がある
            // _updateZIndex をオーバーライドして「深刻度→台数」の純粋な優先順序を保証する
            // riseOnHover の offset引数（デフォルト250）はそのまま残してホバー動作を維持
            const fixedZIndex = zIndexOrder;
            marker._updateZIndex = function(offset) {
                if (this._icon) {
                    this._icon.style.zIndex = fixedZIndex + (offset || 0);
                }
            };
            // addTo直後（markerGroupがmapに既に追加済みの場合）に即時適用
            if (marker._icon) {
                marker._icon.style.zIndex = fixedZIndex;
            }

            // 後でポップアップ状態を復旧するためにマーカーにポート名を付与
            marker.portName = port.port_name;

            // ポップアップの構成（空ポートと自転車ありポートで分岐）
            let popupContent = `
                <div class="popup-title">${port.port_name}</div>
                <div class="popup-desc">総駐輪台数: ${port.total_bikes}台</div>
            `;

            if (isActuallyEmpty) {
                popupContent += `
                    <div class="popup-desc" style="font-weight:bold; color:#64748b; margin-top: 8px;">
                        表示対象の利用可能車両はありません。
                    </div>
                `;
            } else {
                popupContent += `
                    <div class="popup-desc" style="font-weight:bold; color:#ef4444">
                        表示対象車両: ${matchingBikes.length}台
                    </div>
                    <ul class="popup-bike-list">
                `;
                matchingBikes.forEach(bike => {
                    let badgeClass = `badge-level${bike.alert_level}`;
                    let badgeName = bike.alert_level_name;
                    
                    // 表示名を「極低」「低」に補正
                    if (badgeName === "AT異常") badgeName = "極低";
                    if (badgeName === "電圧閾値") badgeName = "低";
                    
                    popupContent += `
                        <li class="popup-bike-item" style="align-items: flex-start;">
                            <div>
                                <span class="popup-bike-id">${bike.bike_id}</span>
                                <span class="popup-desc" style="font-size:11px; margin-left:5px; color: #0284c7; font-weight: bold;">[${bike.status}]</span>
                                <span class="badge ${badgeClass}">${badgeName}</span>
                                <div class="popup-desc" style="font-size:10px; margin: 2px 0 0 0; color: #64748b;">車種: ${bike.model_name}</div>
                            </div>
                            <span class="popup-bike-volt" style="margin-top: 2px;">${bike.voltage}V</span>
                        </li>
                    `;
                });
                popupContent += `</ul>`;
            }

            marker.bindPopup(popupContent, {
                maxWidth: 320,
                autoPan: true,
                autoPanPadding: L.point(50, 50)
            });

            // もしこのポート名が、さきほど開いていたポート名と一致すれば記憶する
            if (openPortName && port.port_name === openPortName) {
                activePopupMarker = marker;
            }
        });

        // サマリー値のリアルタイム連動更新 (選択されたエリア内での合計値になります)
        document.getElementById('alert-ports-count').innerText = filteredPortsCount;
        document.getElementById('alert-bikes-count').innerText = filteredBikesCount;

        // --- 車種名 × 警告レベル(閾値) マトリクス表の動的生成 ---
        const tableContainer = document.getElementById('summary-table-container');
        if (allFilteredBikes.length > 0) {
            // ユニークな車種リストをソートして抽出 (例: ['DD', 'PasCityC', 'その他'])
            const uniqueModels = Array.from(new Set(allFilteredBikes.map(b => b.model_name))).sort();
            
            // マトリクスデータの初期化
            const matrix = {};
            uniqueModels.forEach(m => {
                matrix[m] = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0, 0: 0 };
            });
            
            // 集計実行
            allFilteredBikes.forEach(bike => {
                if (matrix[bike.model_name]) {
                    matrix[bike.model_name][bike.alert_level]++;
                }
            });
            
            // マトリクス表のHTML構築
            let tableHtml = '<table class="summary-table">';
            tableHtml += '<thead><tr><th>車種</th><th>極低</th><th>低</th><th>Lv.1</th><th>Lv.2</th><th>Lv.3</th><th>正常</th></tr></thead><tbody>';
            
            uniqueModels.forEach(model => {
                tableHtml += `<tr><td><b>${model}</b></td>`;
                [5, 4, 3, 2, 1, 0].forEach(lvl => {
                    const count = matrix[model][lvl];
                    const isChecked = checkedLevels.includes(lvl);
                    const hasCountClass = count > 0 && isChecked ? ' class="count-cell has-count"' : '';
                    // フィルターされていないレベルの列は少しグレーアウトする
                    const styleStr = !isChecked ? ' style="opacity: 0.4;"' : '';
                    tableHtml += `<td${hasCountClass}${styleStr}>${count}</td>`;
                });
                tableHtml += '</tr>';
            });
            
            tableHtml += '</tbody></table>';
            tableContainer.innerHTML = tableHtml;
            tableContainer.style.display = 'block';
        } else {
            tableContainer.innerHTML = '';
            tableContainer.style.display = 'none';
        }

        // スマホ表示でオーバーレイされないよう、inline styleのdisplay:noneをクリアし、CSSクラス制御に委ねます。
        document.getElementById('summary-panel').style.display = '';
        
        const restrictedStatus = getRestrictedStatus();
        if (restrictedStatus) {
            document.getElementById('status-filter-panel').style.display = 'none';
            document.getElementById('basemap-panel').style.right = '15px'; // フィルター非表示時は右寄せにする
            
            // スマホ用ボタンも念のため確実に非表示にする
            const statusBtn = document.querySelector('.btn-status');
            if (statusBtn) statusBtn.style.display = 'none';
        } else {
            document.getElementById('status-filter-panel').style.display = '';
            document.getElementById('basemap-panel').style.right = ''; // 通常位置に戻す
        }

        // エリアやフィルター変更時に、存在するピンが綺麗に収まる範囲へ地図をスムーズズーム (自動更新時はズーム・中心座標を維持するためスキップ)
        if (shouldFitBounds) {
            if (isKindaiMode()) {
                // 金沢大学モードのときは環境によるズーム計算バグを防ぐため、8ポートの中間座標と最適なズームレベルで固定セット
                map.setView([36.5526, 136.6903], 14.5);
            } else if (validCoordinates.length > 0) {
                const bounds = L.latLngBounds(validCoordinates);
                map.fitBounds(bounds, { padding: [40, 40] });
            }
        }

        // 開いていたポップアップを新しいマーカーで復元する
        if (activePopupMarker) {
            // 少し時間差を設けて確実に描画完了後にポップアップを開く
            setTimeout(() => {
                activePopupMarker.openPopup();
            }, 50);
        }
    }

    // 6. GPS現在地トラッキング機能
    const gpsBtn = document.getElementById('gps-btn');
    gpsBtn.addEventListener('click', function() {
        if (!navigator.geolocation) {
            alert("お使いの端末はGPS機能に対応していません。");
            return;
        }

        const btnText = gpsBtn.querySelector('span');
        btnText.innerText = "追跡中...";
        gpsBtn.style.backgroundColor = "#ff9500";

        navigator.geolocation.getCurrentPosition(
            function(position) {
                const lat = position.coords.latitude;
                const lon = position.coords.longitude;
                const accuracy = position.coords.accuracy;

                map.setView([lat, lon], 16);

                if (currentPositionMarker) map.removeLayer(currentPositionMarker);
                if (currentPositionCircle) map.removeLayer(currentPositionCircle);

                currentPositionMarker = L.circleMarker([lat, lon], {
                    radius: 9,
                    fillColor: "#007aff",
                    color: "#ffffff",
                    weight: 2,
                    fillOpacity: 1.0
                }).addTo(map);
                
                currentPositionMarker.bindPopup("<b>あなたの現在地</b>");

                currentPositionCircle = L.circle([lat, lon], {
                    radius: accuracy,
                    color: "#007aff",
                    fillColor: "#007aff",
                    fillOpacity: 0.15,
                    weight: 1
                }).addTo(map);

                btnText.innerText = "現在地";
                gpsBtn.style.backgroundColor = "#007aff";
            },
            function(error) {
                btnText.innerText = "現在地";
                gpsBtn.style.backgroundColor = "#007aff";
                let errMsg = "位置情報の取得に失敗しました。";
                if (error.code === error.PERMISSION_DENIED) {
                    errMsg += "\nブラウザの位置情報アクセス権限を許可してください。";
                }
                alert(errMsg);
            },
            {
                enableHighAccuracy: true,
                timeout: 10000,
                maximumAge: 0
            }
        );
    });

    // E2Eテスト用に一部の内部関数・変数をwindowオブジェクトに公開
    window._testInterface = {
        loadDashboardData: loadDashboardData,
        isUserInteracting: isUserInteracting,
        checkAndApplyPendingUpdate: checkAndApplyPendingUpdate,
        getIsPendingUpdate: () => isPendingUpdate,
        getPendingUpdateData: () => pendingUpdateData,
        setIsPendingUpdate: (val) => { isPendingUpdate = val; },
        setPendingUpdateData: (val) => { pendingUpdateData = val; },
        getCachedDashboardData: () => cachedDashboardData,
        setCachedDashboardData: (val) => { cachedDashboardData = val; }
    };
});

// モバイル用ドロワーの開閉トグル関数 (グローバルスコープ)
function toggleSummaryMobile() {
    const panel = document.getElementById('summary-panel');
    const legend = document.getElementById('map-legend-panel');
    const statusPanel = document.getElementById('status-filter-panel');
    const basemapPanel = document.getElementById('basemap-panel');
    // 反対側のパネルは閉じる
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
    // 反対側のパネルは閉じる
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
    // 反対側のパネルは閉じる
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
    // 反対側のパネルは閉じる
    if (summary) summary.classList.remove('show-mobile-drawer');
    if (legend) legend.classList.remove('show-mobile-drawer');
    if (statusPanel) statusPanel.classList.remove('show-mobile-drawer');
    
    if (panel) {
        panel.classList.toggle('show-mobile-drawer');
    }
}
