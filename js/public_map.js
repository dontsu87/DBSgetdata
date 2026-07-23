/**
 * 利用者向けポートマップ (public_map.js)
 * IFRAME 埋め込み対応 & URLパラメータ(?area=...) 必須安全仕様
 */

(function () {
    'use strict';

    // UI要素
    const mapElement = document.getElementById('map');
    const noParamsScreen = document.getElementById('no-params-screen');
    const searchInput = document.getElementById('public-search-input');
    const searchClearBtn = document.getElementById('public-search-clear');
    const langToggleBtn = document.getElementById('lang-toggle-btn');
    const areaBadge = document.getElementById('area-badge');
    const updateTimeDisplay = document.getElementById('update-time-display');
    const appTitleText = document.getElementById('app-title-text');

    // 状態管理
    let map = null;
    let markersGroup = null;
    let allPorts = [];
    let filteredPorts = [];
    let currentLang = 'ja'; // 'ja' or 'en'
    let currentAreaParam = '';

    // 言語ごとのテキスト定義
    const I18N = {
        ja: {
            title: 'ポート利用状況',
            searchPlaceholder: 'ポート名を検索...',
            bikesAvailable: '利用可能',
            capacity: 'ラック数',
            updatedAt: '更新日時',
            noPortsFound: '該当するポートが見つかりません',
            units: '台'
        },
        en: {
            title: 'Bike Share Availability',
            searchPlaceholder: 'Search port...',
            bikesAvailable: 'Available',
            capacity: 'Docks',
            updatedAt: 'Updated',
            noPortsFound: 'No ports found',
            units: 'bikes'
        }
    };

    /**
     * URLパラメータからエリア制約を取得
     */
    function getAreaParam() {
        const params = new URLSearchParams(window.location.search);
        return params.get('area') || '';
    }

    /**
     * パラメータ未指定時の安全画面（データ非表示）の展開
     */
    function showNoParamsNotice() {
        if (noParamsScreen) {
            noParamsScreen.style.display = 'flex';
        }
        const appContainer = document.getElementById('public-app-container');
        if (appContainer) {
            appContainer.style.display = 'none';
        }
    }

    /**
     * 地図の初期化
     */
    function initMap() {
        // ダークベースの標準 Leaflet マップ (CartoDB Dark Matter / OpenStreetMap)
        map = L.map('map', {
            zoomControl: false,
            attributionControl: false
        }).setView([36.56, 136.65], 13); // 初期仮位置（金沢近辺）

        // Zoom コントロールを右下に配置
        L.control.zoom({ position: 'bottomright' }).addTo(map);

        // キャロDB / OpenStreetMap タイル
        L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
            maxZoom: 19,
            subdomains: 'abcd'
        }).addTo(map);

        markersGroup = L.layerGroup().addTo(map);
    }

    const R2_PUBLIC_PORTS_URL = 'https://pub-1c068f2df9ab42a0b9dcc5d112078269.r2.dev/public_ports.json';

    /**
     * ポートデータのロード（Cloudflare R2 からのデータフェッチ & ローカルフォールバック）
     */
    async function loadPublicData() {
        let data = null;
        const timestamp = new Date().getTime();

        // 1. 作業員用マップと同等の Cloudflare R2 からのフェッチ
        try {
            const response = await fetch(`${R2_PUBLIC_PORTS_URL}?t=${timestamp}`);
            if (response.ok) {
                data = await response.json();
                console.log('Success: Cloudflare R2 から最新ポートデータを取得しました。');
            }
        } catch (e) {
            console.warn('Warning: Cloudflare R2 からのフェッチに失敗しました。ローカル相対パスを試行します...', e);
        }

        // 2. ローカル相対パスからのフェッチフォールバック（開発・ローカルテスト環境用）
        if (!data) {
            try {
                const response = await fetch(`public_ports.json?t=${timestamp}`);
                if (response.ok) {
                    data = await response.json();
                }
            } catch (e) {
                console.warn('Warning: ローカル JSON のフェッチにも失敗しました。', e);
            }
        }

        // 3. 静的 window.PUBLIC_PORTS_DATA のフォールバック
        if (!data && window.PUBLIC_PORTS_DATA) {
            data = window.PUBLIC_PORTS_DATA;
        }


        if (!data || !data.ports) {
            console.error('Failed to load public ports data.');
            return;
        }

        // 更新日時の反映
        if (updateTimeDisplay && data.updated_at) {
            updateTimeDisplay.innerText = `${I18N[currentLang].updatedAt}: ${data.updated_at}`;
        }

        allPorts = data.ports;
        filterAndRender();
    }

    /**
     * エリア制限および検索ワードによるポートのフィルタリング & マップ描画
     */
    function filterAndRender() {
        if (!allPorts.length) return;

        // 1. エリアパラメータによる必須絞り込み
        const targetArea = currentAreaParam.toLowerCase();
        let areaPorts = allPorts.filter(p => {
            const aName = (p.area_name || '').toLowerCase();
            return aName.includes(targetArea);
        });

        // エリア名バッジの更新
        if (areaBadge) {
            const matchedAreaName = areaPorts.length > 0 ? areaPorts[0].area_name : currentAreaParam;
            areaBadge.innerText = matchedAreaName;
        }

        // 2. 検索キーワードによる追加絞り込み
        const keyword = (searchInput ? searchInput.value : '').trim().toLowerCase();
        if (keyword) {
            filteredPorts = areaPorts.filter(p => {
                const pNameJa = (p.port_name || '').toLowerCase();
                const pNameEn = (p.port_name_en || '').toLowerCase();
                return pNameJa.includes(keyword) || pNameEn.includes(keyword);
            });
        } else {
            filteredPorts = areaPorts;
        }

        // 3. マーカーのプロット
        renderMarkers();
    }

    /**
     * マーカーの描画 & fitBounds によるズーム自動調整
     */
    function renderMarkers() {
        if (!markersGroup) return;
        markersGroup.clearLayers();

        if (!filteredPorts.length) return;

        const bounds = L.latLngBounds();

        filteredPorts.forEach(port => {
            const lat = port.lat;
            const lon = port.lon;
            if (!lat || !lon) return;

            bounds.extend([lat, lon]);

            const bikes = port.bikes_available || 0;
            const capacity = port.capacity || 0;

            // バッジのカラークラス
            let colorClass = 'marker-high';
            if (bikes === 0) {
                colorClass = 'marker-zero';
            } else if (bikes <= 2) {
                colorClass = 'marker-med';
            }

            // アイコン作成
            const customIcon = L.divIcon({
                className: 'custom-div-icon',
                html: `<div class="public-port-marker ${colorClass}">${bikes}</div>`,
                iconSize: [28, 28],
                iconAnchor: [14, 14],
                popupAnchor: [0, -14]
            });

            const marker = L.marker([lat, lon], { icon: customIcon });

            // ポップアップ内容の作成
            const displayName = currentLang === 'en' ? (port.port_name_en || port.port_name) : port.port_name;
            const subName = currentLang === 'en' ? port.port_name : (port.port_name_en || '');

            const pct = capacity > 0 ? Math.min(100, Math.round((bikes / capacity) * 100)) : 0;
            const zeroClass = bikes === 0 ? 'zero' : '';

            const popupContent = `
                <div class="public-popup-card">
                    <h3 class="popup-port-title">${displayName}</h3>
                    ${subName && subName !== displayName ? `<div class="popup-port-sub">${subName}</div>` : ''}
                    <div class="popup-capacity-block">
                        <div class="capacity-labels">
                            <span>${I18N[currentLang].bikesAvailable}: <strong class="capacity-count ${zeroClass}">${bikes} ${I18N[currentLang].units}</strong></span>
                            <span class="capacity-total">(${I18N[currentLang].capacity}: ${capacity})</span>
                        </div>
                        <div class="capacity-bar-track">
                            <div class="capacity-bar-fill ${zeroClass}" style="width: ${pct}%;"></div>
                        </div>
                    </div>
                </div>
            `;

            marker.bindPopup(popupContent);
            markersGroup.addLayer(marker);
        });

        // エリアのポート全体が収まるようにマップの表示位置を自動フィット
        if (bounds.isValid()) {
            map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
        }
    }

    /**
     * 言語切り替え処理
     */
    function setLanguage(lang) {
        if (!I18N[lang]) return;
        currentLang = lang;

        // ボタンのアクティブ状態
        const labels = langToggleBtn.querySelectorAll('.lang-label');
        labels.forEach(lbl => {
            if (lbl.getAttribute('data-lang') === lang) {
                lbl.classList.add('active');
            } else {
                lbl.classList.remove('active');
            }
        });

        // UIテキストの更新
        if (appTitleText) appTitleText.innerText = I18N[lang].title;
        if (searchInput) searchInput.placeholder = I18N[lang].searchPlaceholder;

        // マーカーの再描画
        renderMarkers();
    }

    /**
     * イベントリスナーの登録
     */
    function setupEvents() {
        // 検索窓入力イベント
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                if (searchClearBtn) {
                    searchClearBtn.style.display = searchInput.value ? 'block' : 'none';
                }
                filterAndRender();
            });
        }

        // 検索クリアボタン
        if (searchClearBtn) {
            searchClearBtn.addEventListener('click', () => {
                searchInput.value = '';
                searchClearBtn.style.display = 'none';
                filterAndRender();
            });
        }

        // 言語切替ボタン
        if (langToggleBtn) {
            langToggleBtn.addEventListener('click', () => {
                const nextLang = currentLang === 'ja' ? 'en' : 'ja';
                setLanguage(nextLang);
            });
        }
    }

    /**
     * メイン初期化エントリーポイント
     */
    function init() {
        currentAreaParam = getAreaParam();

        // 【作業員用マップと同等の安全仕様】
        // URLパラメータ ?area=... が指定されていない場合はデータフェッチを行わずに安全画面を表示
        if (!currentAreaParam) {
            console.log('Safety check: No ?area parameter provided. Stopping initialization.');
            showNoParamsNotice();
            return;
        }

        initMap();
        setupEvents();
        loadPublicData();
    }

    // DOMロード時に初期化実行
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();
