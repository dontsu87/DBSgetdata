// Map Initialization and Render Logic

function getHighlightBadgeSvg(color, size = 16) {
    let fillColor = '#eab308'; // 黄色 (tailwind yellow-500)
    let textColor = '#000000'; // 黒字
    if (color === 'red') {
        fillColor = '#f87171'; // 薄めの赤色 (tailwind red-400)
    } else if (color === 'brown') {
        fillColor = '#a0522d'; // 薄めの赤茶色 (Sienna)
        textColor = '#ffffff'; // 茶色は白字
    }
    
    return `<svg class="warning-badge-svg" viewBox="0 0 24 24" width="${size}" height="${size}">
        <path d="M12 2L2 22h20L12 2z" fill="${fillColor}" stroke="${fillColor}" stroke-width="2" stroke-linejoin="round"/>
        <text x="12" y="19" fill="${textColor}" font-size="15" font-weight="900" text-anchor="middle" font-family="sans-serif" style="text-shadow: none !important;">!</text>
    </svg>`;
}

function initMapInstance() {
    const cachedLat = loadFromCache('map_center_lat', 36.568);
    const cachedLng = loadFromCache('map_center_lng', 136.648);
    const cachedZoom = loadFromCache('map_zoom', 13);
    map = L.map('map', {
        zoomControl: false, 
        tap: true,          
        doubleClickZoom: false, 
        zoomSnap: 0        
    }).setView([cachedLat, cachedLng], cachedZoom);
    window.map = map;

    // ダブルタップ＋ドラッグズームの自前実装
    (function() {
        let lastTapTime = 0;
        let isDoubleTapDragging = false;
        let startY = 0;
        let startZoom = 0;
        let startTapX = 0;
        let startTapY = 0;
        let startLatLng = null;
        let finalZoomDelta = 0;
        
        const mapContainer = map.getContainer();
        
        mapContainer.addEventListener('touchstart', function(e) {
            if (e.touches.length !== 1) return; 
            const currentTime = new Date().getTime();
            const tapDelay = currentTime - lastTapTime;
            const currentTapX = e.touches[0].clientX;
            const currentTapY = e.touches[0].clientY;
            
            // 2つのタップ位置が離れすぎていないか検証 (30px以内)
            const distance = Math.sqrt(Math.pow(currentTapX - startTapX, 2) + Math.pow(currentTapY - startTapY, 2));
            
            if (tapDelay < 300 && distance < 30) {
                isDoubleTapDragging = true;
                startY = currentTapY;
                startZoom = map.getZoom();
                finalZoomDelta = 0;
                
                // 進行中のスクロール・アニメーションを即座に停止
                map.stop();

                // Leafletの標準ドラッグを無効化
                if (map.dragging) {
                    map.dragging.disable();
                }
                
                // ズーム中心を「現在の画面の中心」に固定し、開始時の座標ズレ（ワープ）を防ぐ
                startLatLng = map.getCenter();
                
                e.preventDefault();
            } else {
                // 1タップ目の位置を記録
                startTapX = currentTapX;
                startTapY = currentTapY;
            }
            lastTapTime = currentTime;
        }, { passive: false });
        
        mapContainer.addEventListener('touchmove', function(e) {
            if (!isDoubleTapDragging) return;
            if (e.touches.length !== 1) return; 
            e.preventDefault();
            
            const currentY = e.touches[0].clientY;
            const diffY = startY - currentY; 
            finalZoomDelta = diffY / 80; 
            
            let targetZoom = startZoom + finalZoomDelta;
            targetZoom = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), targetZoom));
            
            // Leafletの内部ズームアニメーションメソッドを画面中心基準で呼び出す
            // これにより、ピンチズーム中と完全に同じ滑らかさで、マーカー（バブル）もリアルタイムに拡大縮小します
            if (startLatLng && map._animateZoom) {
                map._animateZoom(startLatLng, targetZoom);
            }
        }, { passive: false });
        
        mapContainer.addEventListener('touchend', function(e) {
            if (isDoubleTapDragging) {
                isDoubleTapDragging = false;
                
                if (map.dragging) {
                    map.dragging.enable();
                }
                
                // 最終確定したズームを適用
                // animate: trueにすることで、引き伸ばし状態から新しいタイルへ滑らかにフェードインします
                let targetZoom = startZoom + finalZoomDelta;
                targetZoom = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), targetZoom));
                if (startLatLng) {
                    map.setView(startLatLng, targetZoom, { animate: true });
                } else {
                    map.setZoom(targetZoom, { animate: true });
                }
                
                e.preventDefault();
            }
        }, { passive: false });
        
        mapContainer.addEventListener('touchcancel', function(e) {
            if (isDoubleTapDragging) {
                isDoubleTapDragging = false;
                
                if (map.dragging) {
                    map.dragging.enable();
                }
                
                let targetZoom = startZoom + finalZoomDelta;
                targetZoom = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), targetZoom));
                if (startLatLng) {
                    map.setView(startLatLng, targetZoom, { animate: true });
                } else {
                    map.setZoom(targetZoom, { animate: true });
                }
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

    const cachedBasemap = loadFromCache('selected_basemap', 'googleRoad');
    let currentBaseLayer = baseMaps[cachedBasemap] || baseMaps.googleRoad;
    currentBaseLayer.addTo(map);

    const selectedRadio = document.querySelector(`input[name="basemap-select"][value="${cachedBasemap}"]`);
    if (selectedRadio) {
        selectedRadio.checked = true;
    }

    document.querySelectorAll('input[name="basemap-select"]').forEach(radio => {
        radio.addEventListener('change', function(e) {
            const selectedVal = e.target.value;
            console.log("DEBUG - basemap change event triggered:", selectedVal);
            if (baseMaps[selectedVal]) {
                map.removeLayer(currentBaseLayer);
                currentBaseLayer = baseMaps[selectedVal];
                currentBaseLayer.addTo(map);
                saveToCache('selected_basemap', selectedVal);
            }
        });
    });

    L.control.zoom({ position: 'topleft' }).addTo(map);
    markerGroup = L.layerGroup().addTo(map);

    // マップ操作状態を検知するリスナー
    map.on('movestart', function() {
        isMapInteracting = true;
        if (mapInteractionTimer) clearTimeout(mapInteractionTimer);
    });

    map.on('moveend', function() {
        const center = map.getCenter();
        saveToCache('map_center_lat', center.lat);
        saveToCache('map_center_lng', center.lng);
        saveToCache('map_zoom', map.getZoom());

        if (mapInteractionTimer) clearTimeout(mapInteractionTimer);
        mapInteractionTimer = setTimeout(function() {
            isMapInteracting = false;
            checkAndApplyPendingUpdate();
        }, 5000);
    });

    map.on('popupopen', function(e) {
        const source = e.source || (e.popup && e.popup._source); 
        if (source && source.portName) {
            openPortName = source.portName;
            console.log("Popup opened for:", openPortName);
        }
        if (e.popup && e.popup._container) {
            L.DomEvent.disableClickPropagation(e.popup._container);
        }
        if (interactionTimer) clearTimeout(interactionTimer);
    });

    map.on('popupclose', function(e) {
        openPortName = null;
        if (interactionTimer) clearTimeout(interactionTimer);
        // ポップアップが閉じられたら、裏側でマーカーを最新状態に再描画して HTML バインドを更新
        updateFilterAndRender(false);
        interactionTimer = setTimeout(function() {
            checkAndApplyPendingUpdate();
        }, 5000);
    });

    // GPSボタン
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
}

function updateFilterAndRender(shouldFitBounds = true) {
    if (!cachedDashboardData) return;
    
    const checkedLevels = Array.from(document.querySelectorAll('.legend-filter:checked'))
                               .map(el => parseInt(el.value));
                               
    renderDashboardWithFilter(cachedDashboardData, checkedLevels, checkedStatuses, shouldFitBounds);
}

function renderDashboardWithFilter(data, checkedLevels, targetStatuses, shouldFitBounds = true) {
    if (!data || !data.ports) return;

    // 自己申告データの有効期限切れ(2時間超)をクリーンアップ
    cleanupSelfReplacedBikes();

    if (!targetStatuses) {
        targetStatuses = checkedStatuses;
    }

    markerGroup.clearLayers();

    let alertHtml = '';
    let alertClass = '';
    if (data.updated_at) {
        try {
            const updateDate = new Date(data.updated_at.replace(/-/g, '/'));
            const now = new Date();
            const diffMs = now - updateDate;
            const diffMins = Math.floor(diffMs / 60000);
            if (diffMins >= 30) {
                alertHtml = ` <span class="update-delay-alert" style="color: #ef4444; font-weight: bold; background-color: rgba(239, 68, 68, 0.1); padding: 2px 6px; border-radius: 4px; border: 1px solid rgba(239, 68, 68, 0.3); display: inline-flex; align-items: center; gap: 4px; margin-left: 4px;">⚠️ 更新遅延 (${diffMins}分経過)</span>`;
                alertClass = 'has-update-delay';
            }
        } catch (e) {
            console.error("Error parsing update time:", e);
        }
    }

    const updateTimeEl = document.getElementById('update-time');
    if (updateTimeEl) {
        if (alertClass) {
            updateTimeEl.classList.add(alertClass);
        } else {
            updateTimeEl.classList.remove('has-update-delay');
        }
        updateTimeEl.innerHTML = `
            最終更新: ${data.updated_at || "不明"}${alertHtml}
            <span class="update-note">数分前の情報が表示されている可能性があります</span>
        `;
    }

    let validCoordinates = [];
    let filteredPortsCount = 0;
    let filteredBikesCount = 0;
    let allFilteredBikes = []; 
    let activePopupMarker = null; 

    const hasSelectedPorts = isPortSelectionMode && selectedPortNames.length > 0;
    const evaluatedPorts = [];
    const thresholdSec = unlockedThresholdHours * 3600;
    const unlockedFilterCheckbox = document.getElementById('unlocked-filter-checkbox');
    const isUnlockedFilterChecked = unlockedFilterCheckbox ? unlockedFilterCheckbox.checked : true;

    data.ports.forEach(port => {
        const lat = parseFloat(port.lat);
        const lon = parseFloat(port.lon);
        
        if (isNaN(lat) || isNaN(lon) || lat === 0.0 || lon === 0.0) {
            return; 
        }

        if (port.area_name !== selectedArea) {
            return;
        }

        if (isKindaiMode()) {
            if (!port.station_id || !KINDAI_STATION_IDS.includes(port.station_id)) {
                return;
            }
        }

        const isEmptyPort = (parseInt(port.total_bikes) === 0 || !port.bikes || port.bikes.length === 0);
        const hasBikes = !isEmptyPort;
        const availableBikes = hasBikes ? port.bikes.filter(bike => bike.status && bike.status.trim() === '利用可能') : [];
        const isRentalEmpty = hasBikes && availableBikes.length === 0;

        const matchingBikes = isEmptyPort ? [] : port.bikes.filter(bike => {
            const isUnlocked = bike.consecutive_use_duration >= thresholdSec;
            
            let evalAlertLevel = bike.alert_level;
            if (isReplacedModeEnabled && bike.replaced_at && bike.replace_original_volt !== null && bike.replace_original_volt !== undefined && bike.replace_original_volt !== "") {
                let isWithin2Hours = false;
                try {
                    const replacedDate = new Date(bike.replaced_at.replace(/-/g, '/'));
                    const now = new Date();
                    if (!isNaN(replacedDate.getTime())) {
                        const diffMs = now - replacedDate;
                        if (diffMs >= 0 && diffMs <= 7200000) {
                            isWithin2Hours = true;
                        }
                    }
                } catch (e) {
                    isWithin2Hours = false;
                }

                if (isWithin2Hours) {
                    const origV = parseFloat(bike.replace_original_volt);
                    const th = bike.thresholds;
                    if (!isNaN(origV) && th) {
                        if (origV <= th.at_error) {
                            evalAlertLevel = 5; 
                        } else if (origV <= th.strong) {
                            evalAlertLevel = 4; 
                        } else if (th.lv1 && origV <= th.lv1) {
                            evalAlertLevel = 3; 
                        } else if (th.lv2 && origV <= th.lv2) {
                            evalAlertLevel = 2; 
                        } else {
                            evalAlertLevel = 0; 
                        }
                    }
                }
            }
            
            // 自己申告の考慮 (システム自動検知で元の警告レベルが再評価されていない場合)
            if (isReplacedModeEnabled && selfReplacedBikes[bike.bike_id]) {
                const selfReplacedItem = selfReplacedBikes[bike.bike_id];
                evalAlertLevel = selfReplacedItem.alert_level;
            }
            
            const isLevelMatch = checkedLevels.includes(evalAlertLevel);
            const isStatusMatch = bike.status ? targetStatuses.includes(bike.status.trim()) : false;
            const isHighlighted = bike.status ? checkedHighlightStatuses.includes(bike.status.trim()) : false;
            
            let isPrefixMatch = true;
            if (!isAllPrefixesChecked && checkedPrefixes && checkedPrefixes.length > 0) {
                const bikePrefixMatch = bike.bike_id ? bike.bike_id.match(/^[A-Za-z]+/) : null;
                const bikePrefix = bikePrefixMatch ? bikePrefixMatch[0].toUpperCase() : "";
                isPrefixMatch = checkedPrefixes.includes(bikePrefix);
            }
            
            let isReplaced = false;
            if (isReplacedModeEnabled && bike.replaced_at) {
                try {
                    const replacedDate = new Date(bike.replaced_at.replace(/-/g, '/'));
                    const now = new Date();
                    if (!isNaN(replacedDate.getTime())) {
                        const diffMs = now - replacedDate;
                        if (diffMs >= 0 && diffMs <= 7200000) {
                            isReplaced = true;
                        }
                    }
                } catch (e) {
                    isReplaced = false;
                }
            }
            
            return (isReplaced || isLevelMatch || (isUnlocked && isUnlockedFilterChecked) || isHighlighted) && isStatusMatch && isPrefixMatch;
        });

        // バッテリー警告対象が1台でもいれば、利用可能0台より警告マーカーを優先する
        const showAsRentalEmpty = isRentalEmpty && matchingBikes.length === 0;

        let isDrawPort = (isEmptyPort && checkedLevels.includes(-1)) || 
                         (showAsRentalEmpty && checkedLevels.includes(-2)) ||
                         (!isEmptyPort && matchingBikes.length > 0);

        if (isKindaiMode()) {
            isDrawPort = true;
        }

        if (!isDrawPort) {
            return; 
        }

        evaluatedPorts.push({
            port: port,
            lat: lat,
            lon: lon,
            isEmptyPort: isEmptyPort,
            // 利用可能0台として表示するのは、matchingBikesが0台のときだけ
            isRentalEmpty: showAsRentalEmpty,
            isActuallyEmpty: isEmptyPort || (showAsRentalEmpty),
            matchingBikes: matchingBikes
        });
    });

    evaluatedPorts.forEach(item => {
        const isSelected = selectedPortNames.includes(item.port.port_name);
        
        if (!hasSelectedPorts || isSelected) {
            allFilteredBikes.push(...item.matchingBikes);
            filteredPortsCount++;
            filteredBikesCount += item.matchingBikes.length;
            validCoordinates.push([item.lat, item.lon]);
        }
    });

    evaluatedPorts.forEach(item => {
        const port = item.port;
        const lat = item.lat;
        const lon = item.lon;
        const isActuallyEmpty = item.isActuallyEmpty;
        const matchingBikes = item.matchingBikes;
        const isSelected = isPortSelectionMode && selectedPortNames.includes(port.port_name);

        let markerIcon;
        let zIndexOrder = 100;
        
        let hasUnlockedBike = false;
        let hasRedHighlight = false;
        let hasBrownHighlight = false;
        let hasYellowHighlight = false;

        matchingBikes.forEach(bike => {
            if (bike.consecutive_use_duration >= thresholdSec) {
                hasUnlockedBike = true;
            }
            if (bike.status) {
                const statusTrimmed = bike.status.trim();
                if (checkedHighlightStatuses.includes(statusTrimmed)) {
                    if (statusTrimmed.startsWith('AT異常')) {
                        hasRedHighlight = true;
                    } else if (statusTrimmed.startsWith('メンテナンス')) {
                        hasBrownHighlight = true;
                    } else {
                        hasYellowHighlight = true;
                    }
                }
            }
        });
        const hasHighlightedBike = hasRedHighlight || hasBrownHighlight || hasYellowHighlight;
        
        if (item.isRentalEmpty) {
            let className = 'port-marker-rental-empty';
            if (isSelected) {
                className += ' port-marker-selected';
            }
            markerIcon = L.divIcon({
                className: className,
                html: '<div>0</div>',
                iconSize: [28, 28],
                iconAnchor: [14, 14]
            });
            zIndexOrder = 11; 
        } else if (item.isEmptyPort) {
            let className = 'port-marker-empty';
            if (isSelected) {
                className += ' port-marker-selected';
            }
            markerIcon = L.divIcon({
                className: className,
                html: '<div>0</div>',
                iconSize: [28, 28],
                iconAnchor: [14, 14]
            });
            zIndexOrder = 10; 
        } else {
            const maxLevel = Math.max(...matchingBikes.map(b => b.alert_level));
            let className = 'port-marker-base ';
            
            const bikeCountOffset = matchingBikes.length;
            if (maxLevel === 5) {
                className += 'port-marker-level5';
                zIndexOrder = 20000 + bikeCountOffset; 
            } else if (maxLevel === 4) {
                className += 'port-marker-level4';
                zIndexOrder = 15000 + bikeCountOffset; 
            } else if (maxLevel === 3) {
                className += 'port-marker-level3';
                zIndexOrder = 10000 + bikeCountOffset; 
            } else if (maxLevel === 2) {
                className += 'port-marker-level2';
                zIndexOrder = 5000 + bikeCountOffset;  
            } else if (maxLevel === 0) {
                className += 'port-marker-level1';
                zIndexOrder = 1000 + bikeCountOffset;  
            } else {
                className += 'port-marker-normal';
                zIndexOrder = 500 + bikeCountOffset;   
            }

            if (hasUnlockedBike || hasHighlightedBike) {
                className += ' port-marker-attention';
                if (hasUnlockedBike) {
                    className += ' port-marker-has-unlocked';
                }
                zIndexOrder += 30000; 
            }

            if (isSelected) {
                className += ' port-marker-selected';
                zIndexOrder += 50000; 
            }

            let badgesHtml = '';
            if (hasUnlockedBike || hasHighlightedBike) {
                badgesHtml += '<div class="marker-badges-container">';
                if (hasUnlockedBike) {
                    badgesHtml += `<span class="marker-badge-item">${EMOJI_UNLOCKED}</span>`;
                }
                if (hasRedHighlight) {
                    badgesHtml += `<span class="marker-badge-item">${getHighlightBadgeSvg('red')}</span>`;
                }
                if (hasBrownHighlight) {
                    badgesHtml += `<span class="marker-badge-item">${getHighlightBadgeSvg('brown')}</span>`;
                }
                if (hasYellowHighlight) {
                    badgesHtml += `<span class="marker-badge-item">${getHighlightBadgeSvg('yellow')}</span>`;
                }
                badgesHtml += '</div>';
            }

            markerIcon = L.divIcon({
                className: className,
                html: `<div>${matchingBikes.length}${badgesHtml}</div>`,
                iconSize: maxLevel >= 4 ? [32, 32] : [28, 28],
                iconAnchor: maxLevel >= 4 ? [16, 16] : [14, 14]
            });
        }

        const marker = L.marker([lat, lon], {
            icon: markerIcon,
            zIndexOffset: zIndexOrder,
            riseOnHover: true
        }).addTo(markerGroup);

        const fixedZIndex = zIndexOrder;
        marker._updateZIndex = function(offset) {
            if (this._icon) {
                this._icon.style.zIndex = fixedZIndex + (offset || 0);
            }
        };
        if (marker._icon) {
            marker._icon.style.zIndex = fixedZIndex;
        }

        marker.portName = port.port_name;
        item.marker = marker;

        const legendHtml = isReplacedModeEnabled 
            ? `<div class="popup-title-legend" style="font-size: 8px; font-weight: normal; color: #64748b; text-align: right; line-height: 1.0; margin-left: auto; flex-shrink: 0; padding-left: 6px; user-select: none; display: flex; flex-direction: column; justify-content: center; gap: 1px;">
                 <div style="font-weight: bold; color: #475569; font-size: 8px; line-height: 1.0;">交換済み</div>
                 <div style="line-height: 1.0;"><span style="color: #22c55e; font-weight: bold; font-size: 9px; margin-right: 1px; line-height: 1.0;">☑</span>自己申告</div>
                 <div style="line-height: 1.0;"><span style="font-size: 8px; margin-right: 1px; line-height: 1.0;">✅</span>自動検知</div>
               </div>` 
            : '';
        let popupContent = `
            <div class="popup-title" style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 0%;" title="${port.port_name}">${port.port_name}</span>
                ${legendHtml}
            </div>
        `;

        if (item.isEmptyPort) {
            popupContent += `
                <div class="popup-desc">総駐輪台数: ${port.total_bikes}台</div>
                <div class="popup-desc" style="font-weight:bold; color:#64748b; margin-top: 8px;">
                    表示対象の利用可能車両はありません。
                </div>
            `;
        } else {
            // 表示対象の自転車リスト。表示対象(matchingBikes)があればそれを、なければそのポートにあるすべての自転車(port.bikes)を表示
            const filterBikesByPrefix = (bikes) => {
                if (isAllPrefixesChecked || !checkedPrefixes || checkedPrefixes.length === 0) return bikes;
                return bikes.filter(bike => {
                    const bikePrefixMatch = bike.bike_id ? bike.bike_id.match(/^[A-Za-z]+/) : null;
                    const bikePrefix = bikePrefixMatch ? bikePrefixMatch[0].toUpperCase() : "";
                    return checkedPrefixes.includes(bikePrefix);
                });
            };
            const displayBikes = filterBikesByPrefix((matchingBikes.length > 0) ? matchingBikes : port.bikes);

            const modelCounts = {};
            displayBikes.forEach(bike => {
                const model = bike.model_name || "その他";
                modelCounts[model] = (modelCounts[model] || 0) + 1;
            });
            const modelCountsStr = Object.entries(modelCounts)
                .map(([model, count]) => `<span class="popup-model-count-item"><span class="popup-model-name">${model}</span><span class="popup-model-count-num">${count}</span></span>`)
                .join("");

            const statusDesc = item.isRentalEmpty
                ? `<div class="popup-desc" style="font-weight:bold; color:#0ea5e9; margin: 0;">利用可能：0台</div>`
                : `<div class="popup-desc" style="font-weight:bold; color:#ef4444; margin: 0;">表示対象車両: ${matchingBikes.length}台</div>`;

            const sectionTitle = item.isRentalEmpty ? "車両内訳（車種別）" : "表示対象車両（車種別）";

            popupContent += `
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; gap: 8px;">
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <div class="popup-desc" style="margin: 0;">総駐輪台数: ${port.total_bikes}台</div>
                        ${statusDesc}
                    </div>
                    <div style="display: flex; flex-direction: column; align-items: center; gap: 2px;">
                        <div style="font-size: 8px; font-weight: bold; color: #ef4444; line-height: 1;">${sectionTitle}</div>
                        <div class="popup-model-counts-container">
                            ${modelCountsStr}
                        </div>
                    </div>
                </div>
                <ul class="popup-bike-list">
            `;
            displayBikes.forEach(bike => {
                let badgeClass = `badge-level${bike.alert_level}`;
                let badgeName = bike.alert_level_name;
                let unregisteredBadge = bike.is_unregistered ? '<span class="badge" style="background-color:#dc2626; margin-left:4px;">⚠️未登録（要CSV追加）</span>' : '';
                
                if (bike.alert_level === 0) {
                    badgeClass = 'badge-level1';
                }
                
                const isUnlocked = bike.consecutive_use_duration >= thresholdSec;
                let bikeUnlockedBadge = '';
                if (isUnlocked) {
                    const hours = Math.floor(bike.consecutive_use_duration / 3600);
                    const mins = Math.floor((bike.consecutive_use_duration % 3600) / 60);
                    const durationStr = hours > 0 ? `${hours}時間${mins}分` : `${mins}分`;
                    bikeUnlockedBadge = `<span style="font-size: 12px; margin-right: 2px; display: inline-flex; align-items: center;" title="未施錠未返却 (${durationStr})">${EMOJI_UNLOCKED}</span>`;
                }
                
                const displayModel = (bike.model_name || '').substring(0, 2);

                const bikeStatusTrimmed = bike.status ? bike.status.trim() : '';
                const isBikeHighlighted = checkedHighlightStatuses.includes(bikeStatusTrimmed);
                let bikeHighlightBadge = '';
                if (isBikeHighlighted) {
                    let color = 'yellow';
                    if (bikeStatusTrimmed.startsWith('AT異常')) {
                        color = 'red';
                    } else if (bikeStatusTrimmed.startsWith('メンテナンス')) {
                        color = 'brown';
                    }
                    bikeHighlightBadge = `<span style="margin-right: 2px; display: inline-flex; align-items: center;">${getHighlightBadgeSvg(color, 14)}</span>`;
                }
                
                let isSystemReplaced = false;
                let tooltipStr = '';
                if (isReplacedModeEnabled && bike.replaced_at) {
                    let isWithin2Hours = false;
                    try {
                        const replacedDate = new Date(bike.replaced_at.replace(/-/g, '/'));
                        const now = new Date();
                        if (!isNaN(replacedDate.getTime())) {
                            const diffMs = now - replacedDate;
                            if (diffMs >= 0 && diffMs <= 7200000) {
                                  isWithin2Hours = true;
                            }
                        }
                    } catch (e) {
                        isWithin2Hours = false;
                    }

                    if (isWithin2Hours) {
                        isSystemReplaced = true;
                        tooltipStr = `交換前: ${bike.replace_original_volt}V -> 交換後: ${bike.replace_increased_volt}V (交換日時: ${bike.replaced_at})`;
                    }
                }

                let selfReplacedIcon = '';
                let systemReplacedIcon = '';
                let itemClass = 'popup-bike-item';
                
                if (isReplacedModeEnabled) {
                    const isSelfReplaced = !!selfReplacedBikes[bike.bike_id];
                    if (isSelfReplaced) {
                        const mySelfReplaced = loadFromCache('my_self_replaced_bikes', {});
                        const isMyCheck = !!mySelfReplaced[bike.bike_id] && mySelfReplaced[bike.bike_id].action === 'check';
                        if (isMyCheck) {
                            selfReplacedIcon = `<span style="font-size: 11px; line-height: 1; color: #22c55e;" title="自己申告バッテリー交換済み (タップで解除)">☑</span>`;
                            itemClass += ' self-replaced my-check';
                        } else {
                            selfReplacedIcon = `<span style="font-size: 11px; line-height: 1; color: #64748b;" title="自己申告バッテリー交換済み (他の作業員がチェック)">☑</span>`;
                            itemClass += ' self-replaced other-check';
                        }
                    }
                    if (isSystemReplaced) {
                        systemReplacedIcon = `<span style="font-size: 11px; line-height: 1; cursor: help;" title="${tooltipStr}">✅</span>`;
                    }
                }
                
                let iconsStackHtml = '';
                if (selfReplacedIcon || systemReplacedIcon) {
                    iconsStackHtml = `
                        <div class="replacement-icons-stack">
                            ${selfReplacedIcon}
                            ${systemReplacedIcon}
                        </div>
                    `;
                }

                popupContent += `
                    <li class="${itemClass}" data-bike-id="${bike.bike_id}" data-alert-level="${bike.alert_level}" data-voltage="${bike.voltage || ''}">
                        <div class="popup-bike-col-id">
                            <span class="popup-bike-id">${bike.bike_id}</span>
                        </div>
                        <div class="popup-bike-col-model">
                            <span class="popup-bike-model-tag">${displayModel}</span>
                        </div>
                        <div class="popup-bike-col-status">
                            <span class="popup-bike-status">[${bike.status}]</span>
                        </div>
                        <div class="popup-bike-col-badges">
                            ${bikeHighlightBadge}
                            ${bikeUnlockedBadge}
                            <span class="badge ${badgeClass}">${badgeName}</span>
                            ${iconsStackHtml}
                            ${unregisteredBadge}
                        </div>
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

        marker.off('click'); 
        marker.on('click', function(e) {
            if (isPortSelectionMode) {
                L.DomEvent.stopPropagation(e);
                
                const index = selectedPortNames.indexOf(port.port_name);
                if (index > -1) {
                    selectedPortNames.splice(index, 1);
                } else {
                    selectedPortNames.push(port.port_name);
                    const summaryPanel = document.getElementById('summary-panel');
                    if (summaryPanel && isMobileLayout()) {
                        summaryPanel.classList.add('show-mobile-drawer');
                    }
                }
                console.log("Selected Ports:", selectedPortNames);
                saveToCache('selected_port_names', selectedPortNames);
                updateFilterAndRender(false);
            } else {
                marker.openPopup();
            }
        });

        if (!isPortSelectionMode && openPortName && port.port_name === openPortName) {
            activePopupMarker = marker;
        }
    });

    const selectedPortsContainer = document.getElementById('selected-ports-container');
    const selectedPortsList = document.getElementById('selected-ports-list');
    if (selectedPortsContainer && selectedPortsList) {
        if (isPortSelectionMode && selectedPortNames.length > 0) {
            selectedPortsContainer.style.display = 'block';
            selectedPortsList.innerHTML = '';
            
            selectedPortNames.forEach(portName => {
                const portItem = evaluatedPorts.find(item => item.port.port_name === portName);
                const bikeCount = portItem ? portItem.matchingBikes.length : 0;
                
                const card = document.createElement('div');
                card.className = 'selected-port-card';
                card.innerHTML = `
                    <div class="selected-port-card-info" title="${portName}">
                        <span class="selected-port-card-name">${portName}</span>
                        ${bikeCount > 0 ? `<span class="selected-port-card-badge">${bikeCount}台</span>` : ''}
                    </div>
                    <button class="selected-port-card-remove" data-port="${portName}">✕</button>
                `;
                
                card.querySelector('.selected-port-card-remove').addEventListener('click', function(e) {
                    L.DomEvent.stopPropagation(e);
                    const targetName = this.getAttribute('data-port');
                    selectedPortNames = selectedPortNames.filter(name => name !== targetName);
                    saveToCache('selected_port_names', selectedPortNames);
                    updateFilterAndRender(false);
                });
                
                card.addEventListener('click', function() {
                    if (portItem) {
                        map.panTo([portItem.lat, portItem.lon]);
                        if (portItem.marker) {
                            if (portItem.marker.isPopupOpen && portItem.marker.isPopupOpen()) {
                                portItem.marker.closePopup();
                            } else {
                                portItem.marker.openPopup();
                            }
                        }
                    }
                });

                selectedPortsList.appendChild(card);
            });
        } else {
            selectedPortsContainer.style.display = 'none';
            selectedPortsList.innerHTML = '';
        }
    }

    let unlockedBikesCount = 0;
    const highlightCounts = {};
    checkedHighlightStatuses.forEach(status => {
        highlightCounts[status] = 0;
    });

    allFilteredBikes.forEach(bike => {
        if (bike.consecutive_use_duration >= thresholdSec) {
            unlockedBikesCount++;
        }
        if (bike.status) {
            const trimmedStatus = bike.status.trim();
            if (trimmedStatus in highlightCounts) {
                highlightCounts[trimmedStatus]++;
            }
        }
    });

    document.getElementById('alert-ports-count').innerText = filteredPortsCount;
    document.getElementById('alert-bikes-count').innerText = filteredBikesCount;

    const highlightSummaryContainer = document.getElementById('highlight-summary-container');
    if (highlightSummaryContainer) {
        const activeItems = [];

        // 未施錠未返却フィルターがONかつ、1台以上ある場合にバッジを追加
        const unlockedFilterCheckbox = document.getElementById('unlocked-filter-checkbox');
        const isUnlockedFilterChecked = unlockedFilterCheckbox ? unlockedFilterCheckbox.checked : true;
        if (isUnlockedFilterChecked && unlockedBikesCount > 0) {
            activeItems.push(`<span class="highlight-summary-item-unlocked">🔑 未施錠未返却: <span class="count" style="color: #db2777; font-size: 15px; margin-left: 2px;">${unlockedBikesCount}</span> 台</span>`);
        }

        // 強調アラートで1台以上ある項目をバッジとして追加
        Object.entries(highlightCounts)
            .filter(([_, count]) => count > 0)
            .forEach(([status, count]) => {
                let color = 'yellow';
                if (status.startsWith('AT異常')) {
                    color = 'red';
                } else if (status.startsWith('メンテナンス')) {
                    color = 'brown';
                }
                const badgeHtml = getHighlightBadgeSvg(color, 14);
                activeItems.push(`<span class="highlight-summary-item" style="display: inline-flex; align-items: center; gap: 4px;">${badgeHtml}${status}: <span class="count" style="color: #c084fc; font-size: 15px; margin-left: 2px;">${count}</span> 台</span>`);
            });

        if (activeItems.length > 0) {
            highlightSummaryContainer.innerHTML = activeItems.join('');
            highlightSummaryContainer.style.display = 'flex';
        } else {
            highlightSummaryContainer.innerHTML = '';
            highlightSummaryContainer.style.display = 'none';
        }
    }

    // 車種マトリクス表の生成
    const tableContainer = document.getElementById('summary-table-container');
    if (allFilteredBikes.length > 0) {
        const uniqueModels = Array.from(new Set(allFilteredBikes.map(b => b.model_name))).sort();
        
        const matrix = {};
        uniqueModels.forEach(m => {
            matrix[m] = { 5: 0, 4: 0, 3: 0, 2: 0, 0: 0 };
        });
        
        allFilteredBikes.forEach(bike => {
            if (matrix[bike.model_name]) {
                if (bike.alert_level in matrix[bike.model_name]) {
                    matrix[bike.model_name][bike.alert_level]++;
                }
            }
        });
        
        const allLevels = [
            { val: 5, label: "最低" },
            { val: 4, label: "低" },
            { val: 3, label: "中" },
            { val: 2, label: "高" },
            { val: 0, label: "最高" }
        ];
        
        const activeLevels = allLevels.filter(lvl => checkedLevels.includes(lvl.val));
        
        let tableHtml = '<table class="summary-table">';
        tableHtml += '<thead><tr><th>車種</th>';
        
        activeLevels.forEach(lvl => {
            tableHtml += `<th>${lvl.label}</th>`;
        });
        
        tableHtml += '<th>合計</th>';
        tableHtml += '</tr></thead><tbody>';
        
        uniqueModels.forEach(model => {
            tableHtml += `<tr><td><b>${model}</b></td>`;
            let batteryTotal = 0;
            activeLevels.forEach(lvl => {
                const count = matrix[model][lvl.val];
                batteryTotal += count;
                const hasCountClass = count > 0 ? ' class="count-cell has-count"' : '';
                tableHtml += `<td${hasCountClass}>${count}</td>`;
            });
            
            const hasTotalCountClass = batteryTotal > 0 ? ' class="count-cell has-count" style="background-color: rgba(0, 122, 255, 0.35); color: #93c5fd;"' : '';
            tableHtml += `<td${hasTotalCountClass}>${batteryTotal}</td>`;
            tableHtml += '</tr>';
        });
        
        tableHtml += '</tbody></table>';
        tableContainer.innerHTML = tableHtml;
        tableContainer.style.display = 'block';
    } else {
        tableContainer.innerHTML = '';
        tableContainer.style.display = 'none';
    }

    const summaryPanel = document.getElementById('summary-panel');
    if (summaryPanel) {
        summaryPanel.style.display = '';
        const isMobile = isMobileLayout();
        if (isMobile && isPortSelectionMode && selectedPortNames.length > 0) {
            summaryPanel.classList.add('selection-active-mobile');
            document.body.classList.add('selection-active-mode-layout');
        } else {
            summaryPanel.classList.remove('selection-active-mobile');
            document.body.classList.remove('selection-active-mode-layout');
        }
    }
    
    const restrictedStatus = getRestrictedStatus();
    if (restrictedStatus) {
        document.getElementById('status-filter-panel').style.display = 'none';
        const statusBtn = document.querySelector('.btn-status');
        if (statusBtn) statusBtn.style.display = 'none';
    } else {
        document.getElementById('status-filter-panel').style.display = '';
    }

    if (shouldFitBounds) {
        if (isKindaiMode()) {
            map.setView([36.5526, 136.6903], 14.5);
        } else if (validCoordinates.length > 0) {
            const bounds = L.latLngBounds(validCoordinates);
            map.fitBounds(bounds, { padding: [40, 40] });
        }
    }

    if (activePopupMarker) {
        setTimeout(() => {
            activePopupMarker.openPopup();
        }, 50);
    }
}

// --- 自己申告バッテリー交換機能の追加コード ---

/**
 * 自己申告データの有効期限切れ（2時間超）をクリーンアップし、最新データを返す
 */
function cleanupSelfReplacedBikes() {
    const selfReplaced = loadFromCache('self_replaced_bikes', {});
    const mySelfReplaced = loadFromCache('my_self_replaced_bikes', {});
    const now = Date.now();
    let updatedSelf = false;
    let updatedMy = false;
    
    for (const bikeId in selfReplaced) {
        const item = selfReplaced[bikeId];
        // 2時間 (7200000 ms) 以上経過、または未来の不正なタイムスタンプは削除
        if (now - item.timestamp > 7200000 || now - item.timestamp < 0) {
            delete selfReplaced[bikeId];
            updatedSelf = true;
        }
    }
    
    for (const bikeId in mySelfReplaced) {
        const item = mySelfReplaced[bikeId];
        // uncheck かつ同期済みのデータは、サーバー反映の遅延を考慮して10分間（600000ms）保持した後に削除
        if (item.action === 'uncheck' && item.synced === true) {
            if (now - item.timestamp > 600000 || now - item.timestamp < 0) {
                delete mySelfReplaced[bikeId];
                updatedMy = true;
            }
        } else {
            // 通常のチェックデータ、または未同期の解除データは2時間保持
            if (now - item.timestamp > 7200000 || now - item.timestamp < 0) {
                delete mySelfReplaced[bikeId];
                updatedMy = true;
            }
        }
    }
    
    if (updatedSelf) {
        saveToCache('self_replaced_bikes', selfReplaced);
    }
    if (updatedMy) {
        saveToCache('my_self_replaced_bikes', mySelfReplaced);
    }
    selfReplacedBikes = selfReplaced;
    return selfReplaced;
}

/**
 * 開発環境と本番環境でAPIのURLを切り分ける
 */
function getSelfReplaceApiUrl(endpoint) {
    const isLocal = window.isTestMode || 
                    window.location.hostname === 'localhost' || 
                    window.location.hostname === '127.0.0.1' ||
                    window.location.protocol === 'file:';
    return isLocal ? `http://localhost:5000${endpoint}` : endpoint;
}

/**
 * サーバーへ自己申告データを送信する
 */
function sendSelfReplacementToServer(bikeId, alertLevel, voltage, action) {
    const url = getSelfReplaceApiUrl('/api/self-replacement');
    const postData = {
        bike_id: bikeId,
        action: action,
        alert_level: isNaN(alertLevel) ? 0 : alertLevel,
        voltage: voltage ? parseFloat(voltage) : null
    };
    
    return fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(postData)
    })
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        return response.json();
    })
    .then(result => {
        console.log(`[Self-Replace] Successfully synced with server for bike: ${bikeId} (${action})`);
        
        // 送信成功時、my_self_replaced_bikes 内の synced を true に更新
        const mySelfReplaced = loadFromCache('my_self_replaced_bikes', {});
        if (mySelfReplaced[bikeId]) {
            // uncheckの場合も即座に消さず、サーバー側遅延（整合性ラグ）への防御用として10分保持するために synced: true で残す
            mySelfReplaced[bikeId].synced = true;
            // タイムスタンプを送信成功時刻（＝ここから10分カウント）に更新
            mySelfReplaced[bikeId].timestamp = Date.now();
            saveToCache('my_self_replaced_bikes', mySelfReplaced);
        }
        
        // サーバー側の最新データを反映（マージ）
        if (result.data) {
            mergeAndApplySelfReplacements(result.data);
        }
    })
    .catch(error => {
        console.warn(`[Self-Replace] Failed to sync with server (will retry later) for bike: ${bikeId}:`, error);
        // 送信失敗した場合は my_self_replaced_bikes の synced: false を維持する
        const mySelfReplaced = loadFromCache('my_self_replaced_bikes', {});
        if (mySelfReplaced[bikeId]) {
            mySelfReplaced[bikeId].synced = false;
            saveToCache('my_self_replaced_bikes', mySelfReplaced);
        }
    });
}

/**
 * 未同期の自己申告データをバックグラウンドで再送する
 */
function retryUnsyncedSelfReplacements() {
    const mySelfReplaced = loadFromCache('my_self_replaced_bikes', {});
    const promises = [];
    
    for (const bikeId in mySelfReplaced) {
        const item = mySelfReplaced[bikeId];
        if (item.synced === false) {
            console.log(`[Self-Replace] Retrying unsynced bike: ${bikeId} (${item.action})`);
            promises.push(
                sendSelfReplacementToServer(bikeId, item.alert_level, item.voltage, item.action)
            );
        }
    }
    return Promise.all(promises);
}

/**
 * 自己申告データのトグル処理（本人操作ガード付き、ローカル即時反映 ＆ サーバー非同期送信）
 */
function toggleSelfReplacement(bikeId, alertLevel, voltage, itemEl) {
    // 期限切れを整理
    cleanupSelfReplacedBikes();
    
    // 本人操作ガード：他の人がチェックした車両（other-check）の場合は操作をブロック
    if (itemEl && itemEl.classList.contains('other-check')) {
        console.log(`[Self-Replace] Action blocked: Bike ${bikeId} is checked by another user.`);
        return;
    }
    
    const now = Date.now();
    const mySelfReplaced = loadFromCache('my_self_replaced_bikes', {});
    
    // 自分が現在チェックを入れているかどうか
    const isMyCheck = !!mySelfReplaced[bikeId] && mySelfReplaced[bikeId].action === 'check';
    let action = 'check';
    
    if (isMyCheck) {
        // すでに自分がチェックしている場合は解除 (uncheck)
        action = 'uncheck';
        console.log(`[Self-Replace] Unchecking bike locally: ${bikeId}`);
        
        mySelfReplaced[bikeId] = {
            timestamp: now,
            alert_level: isNaN(alertLevel) ? 0 : alertLevel,
            voltage: voltage ? parseFloat(voltage) : null,
            action: 'uncheck',
            synced: false
        };
        
        // selfReplacedBikes からも削除（ローカルでの即時反映）
        delete selfReplacedBikes[bikeId];
        
        // --- DOMを直接操作して、ポップアップが消えないようにする ---
        if (itemEl) {
            itemEl.classList.remove('self-replaced', 'my-check');
            const badgesCol = itemEl.querySelector('.popup-bike-col-badges');
            if (badgesCol) {
                const stack = badgesCol.querySelector('.replacement-icons-stack');
                if (stack) {
                    const selfIcon = stack.querySelector('[title*="自己申告"]');
                    if (selfIcon) {
                        selfIcon.remove();
                    }
                    // stackが空になったらstack自体も削除
                    if (stack.children.length === 0) {
                        stack.remove();
                    }
                }
            }
        }
    } else {
        // 未チェックの場合、または以前に uncheck していた場合はチェック ON (check)
        action = 'check';
        console.log(`[Self-Replace] Checking bike locally: ${bikeId}`);
        
        mySelfReplaced[bikeId] = {
            timestamp: now,
            alert_level: isNaN(alertLevel) ? 0 : alertLevel,
            voltage: voltage ? parseFloat(voltage) : null,
            action: 'check',
            synced: false
        };
        
        // selfReplacedBikes に追加（ローカルでの即時反映）
        selfReplacedBikes[bikeId] = {
            timestamp: now,
            alert_level: isNaN(alertLevel) ? 0 : alertLevel,
            voltage: voltage ? parseFloat(voltage) : null
        };
        
        // --- DOMを直接操作して、ポップアップが消えないようにする ---
        if (itemEl) {
            itemEl.classList.add('self-replaced', 'my-check');
            const badgesCol = itemEl.querySelector('.popup-bike-col-badges');
            if (badgesCol) {
                let stack = badgesCol.querySelector('.replacement-icons-stack');
                if (!stack) {
                    stack = document.createElement('div');
                    stack.className = 'replacement-icons-stack';
                    badgesCol.appendChild(stack);
                }
                let selfIcon = stack.querySelector('[title*="自己申告"]');
                if (!selfIcon) {
                    selfIcon = document.createElement('span');
                    selfIcon.style.fontSize = '11px';
                    selfIcon.style.lineHeight = '1';
                    selfIcon.style.color = '#22c55e';
                    selfIcon.title = '自己申告バッテリー交換済み (タップで解除)';
                    selfIcon.innerText = '☑';
                    stack.insertBefore(selfIcon, stack.firstChild);
                }
            }
        }
    }
    
    // キャッシュに保存
    saveToCache('my_self_replaced_bikes', mySelfReplaced);
    saveToCache('self_replaced_bikes', selfReplacedBikes);
    
    // サーバーへ非同期送信
    sendSelfReplacementToServer(bikeId, alertLevel, voltage, action);
}

/**
 * サーバーデータとローカルデータをマージし、画面を更新する
 */
function mergeAndApplySelfReplacements(serverData) {
    const localData = loadFromCache('self_replaced_bikes', {});
    const mySelfReplaced = loadFromCache('my_self_replaced_bikes', {});
    const merged = { ...serverData };
    const now = Date.now();
    
    // 1. まずサーバー側のデータから、ローカルで自分が「すでに解除 (uncheck) した」ものを強制除外する
    // (同期済み/未同期にかかわらず、現在ローカルに解除履歴が残っているものはサーバー側でまだ消えていなくても消去)
    for (const bikeId in mySelfReplaced) {
        const myItem = mySelfReplaced[bikeId];
        if (myItem.action === 'uncheck') {
            delete merged[bikeId];
        }
    }
    
    // 2. ローカルで最近（2時間以内）チェックしたもので、まだサーバーに反映されていないものをマージ
    for (const bikeId in localData) {
        const localItem = localData[bikeId];
        if (now - localItem.timestamp <= 7200000 && now - localItem.timestamp >= 0) {
            if (!merged[bikeId] || localItem.timestamp > merged[bikeId].timestamp) {
                // ただし、自分が解除 (uncheck) していないものに限る
                const myItem = mySelfReplaced[bikeId];
                if (!(myItem && myItem.action === 'uncheck')) {
                    merged[bikeId] = localItem;
                }
            }
        }
    }
    
    // 3. 自分の mySelfReplaced のうち、check アクションかつ未同期のものをマージ（サーバーにまだ反映されていないため優先）
    for (const bikeId in mySelfReplaced) {
        const myItem = mySelfReplaced[bikeId];
        if (myItem.action === 'check' && myItem.synced === false) {
            if (now - myItem.timestamp <= 7200000 && now - myItem.timestamp >= 0) {
                merged[bikeId] = {
                    timestamp: myItem.timestamp,
                    alert_level: myItem.alert_level,
                    voltage: myItem.voltage
                };
            }
        }
    }
    
    // 4. クリーンアップ
    for (const bikeId in merged) {
        const item = merged[bikeId];
        if (now - item.timestamp > 7200000 || now - item.timestamp < 0) {
            delete merged[bikeId];
        }
    }
    
    // 保存
    saveToCache('self_replaced_bikes', merged);
    selfReplacedBikes = merged;
}

/**
 * サーバー（またはR2）から自己申告データを取得してマージする
 */
function fetchSelfReplacements() {
    const timestamp = Date.now();
    
    // 未同期データの再送をバックグラウンドで実行
    retryUnsyncedSelfReplacements();
    
    // 開発環境と本番環境でR2かローカルAPIかを切り分ける
    const isLocal = window.isTestMode || 
                    window.location.hostname === 'localhost' || 
                    window.location.hostname === '127.0.0.1' ||
                    window.location.protocol === 'file:';
                    
    const fetchUrl = isLocal 
        ? `http://localhost:5000/api/self-replacement?t=${timestamp}`
        : `https://pub-1c068f2df9ab42a0b9dcc5d112078269.r2.dev/self_replaced_bikes.json?t=${timestamp}`;
        
    console.log(`🌐 自己申告データをフェッチ中: ${fetchUrl}`);
    
    return fetch(fetchUrl)
        .then(response => {
            if (!response.ok) {
                throw new Error("Self-replacement fetch failed");
            }
            return response.json();
        })
        .then(data => {
            mergeAndApplySelfReplacements(data);
            return data;
        })
        .catch(error => {
            console.warn("Warning: 自己申告データの同期に失敗しました（ローカル記憶を使用します）:", error);
            // エラー時はローカルのクリーンアップのみ行う
            cleanupSelfReplacedBikes();
            return null;
        });
}

// ドキュメントクリック時のイベントデリゲーション（車両行クリックの検知）
document.addEventListener('click', function(e) {
    // 交換済モードが有効でない場合は何もしない
    if (!isReplacedModeEnabled) return;
    
    const item = e.target.closest('.popup-bike-item');
    if (!item) return;
    
    // 他のインタラクティブな要素（例えばバッジなどのツールチップがあるスパンなど）がクリックされた場合でも
    // 車両行そのもののクリックとして扱う
    const bikeId = item.getAttribute('data-bike-id');
    const alertLevel = parseInt(item.getAttribute('data-alert-level'), 10);
    const voltage = item.getAttribute('data-voltage');
    
    if (bikeId) {
        toggleSelfReplacement(bikeId, alertLevel, voltage, item);
    }
});
