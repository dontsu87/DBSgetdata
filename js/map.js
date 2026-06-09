// Map Initialization and Render Logic

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
        
        const mapContainer = map.getContainer();
        
        mapContainer.addEventListener('touchstart', function(e) {
            if (e.touches.length !== 1) return; 
            const currentTime = new Date().getTime();
            const tapDelay = currentTime - lastTapTime;
            
            if (tapDelay < 300) {
                isDoubleTapDragging = true;
                startY = e.touches[0].clientY;
                startZoom = map.getZoom();
                e.preventDefault();
            }
            lastTapTime = currentTime;
        }, { passive: false });
        
        mapContainer.addEventListener('touchmove', function(e) {
            if (!isDoubleTapDragging) return;
            if (e.touches.length !== 1) return; 
            e.preventDefault();
            
            const currentY = e.touches[0].clientY;
            const diffY = startY - currentY; 
            const zoomDelta = diffY / 80; 
            let targetZoom = startZoom + zoomDelta;
            targetZoom = Math.max(map.getMinZoom(), Math.min(map.getMaxZoom(), targetZoom));
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
        if (interactionTimer) clearTimeout(interactionTimer);
    });

    map.on('popupclose', function(e) {
        openPortName = null;
        if (interactionTimer) clearTimeout(interactionTimer);
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
            
            const isLevelMatch = checkedLevels.includes(evalAlertLevel);
            const isStatusMatch = bike.status ? targetStatuses.includes(bike.status.trim()) : false;
            const isHighlighted = bike.status ? checkedHighlightStatuses.includes(bike.status.trim()) : false;
            
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
            
            return (isReplaced || isLevelMatch || (isUnlocked && isUnlockedFilterChecked) || isHighlighted) && isStatusMatch;
        });

        let isDrawPort = (isEmptyPort && checkedLevels.includes(-1)) || (!isEmptyPort && matchingBikes.length > 0);

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
            isActuallyEmpty: isEmptyPort || matchingBikes.length === 0,
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
        const isSelected = selectedPortNames.includes(port.port_name);

        let markerIcon;
        let zIndexOrder = 100;
        const hasUnlockedBike = matchingBikes.some(bike => bike.consecutive_use_duration >= thresholdSec);
        const hasHighlightedBike = matchingBikes.some(bike => bike.status && checkedHighlightStatuses.includes(bike.status.trim()));
        
        if (isActuallyEmpty) {
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

            if (hasUnlockedBike) {
                className += ' port-marker-has-unlocked';
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
                if (hasHighlightedBike) {
                    badgesHtml += `<span class="marker-badge-item">${EMOJI_HIGHLIGHT}</span>`;
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

        const legendHtml = isReplacedModeEnabled ? `<span style="font-size: 11px; font-weight: normal; color: #64748b; margin-left: auto;">✅: 交換済み</span>` : '';
        let popupContent = `
            <div class="popup-title" style="display: flex; align-items: center; justify-content: space-between; gap: 8px;">
                <span>${port.port_name}</span>
                ${legendHtml}
            </div>
        `;

        if (isActuallyEmpty) {
            popupContent += `
                <div class="popup-desc">総駐輪台数: ${port.total_bikes}台</div>
                <div class="popup-desc" style="font-weight:bold; color:#64748b; margin-top: 8px;">
                    表示対象の利用可能車両はありません。
                </div>
            `;
        } else {
            const modelCounts = {};
            matchingBikes.forEach(bike => {
                const model = bike.model_name || "その他";
                modelCounts[model] = (modelCounts[model] || 0) + 1;
            });
            const modelCountsStr = Object.entries(modelCounts)
                .map(([model, count]) => `<span class="popup-model-count-item"><span class="popup-model-name">${model}</span><span class="popup-model-count-num">${count}</span></span>`)
                .join("");

            popupContent += `
                <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; gap: 8px;">
                    <div style="display: flex; flex-direction: column; gap: 4px;">
                        <div class="popup-desc" style="margin: 0;">総駐輪台数: ${port.total_bikes}台</div>
                        <div class="popup-desc" style="font-weight:bold; color:#ef4444; margin: 0;">表示対象車両: ${matchingBikes.length}台</div>
                    </div>
                    <div style="display: flex; flex-direction: column; align-items: center; gap: 2px;">
                        <div style="font-size: 8px; font-weight: bold; color: #ef4444; line-height: 1;">表示対象車両（車種別）</div>
                        <div class="popup-model-counts-container">
                            ${modelCountsStr}
                        </div>
                    </div>
                </div>
                <ul class="popup-bike-list">
            `;
            matchingBikes.forEach(bike => {
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
                const bikeHighlightBadge = isBikeHighlighted ? `<span style="font-size: 12px; margin-right: 2px; display: inline-flex; align-items: center;">${EMOJI_HIGHLIGHT}</span>` : '';
                
                let replacementInfo = '';
                if (bike.replaced_at) {
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
                        let displayTime = bike.replaced_at;
                        try {
                            const parts = bike.replaced_at.split(' ');
                            if (parts.length >= 2) {
                                const dateParts = parts[0].split('-');
                                const timeParts = parts[1].split(':');
                                if (dateParts.length >= 3 && timeParts.length >= 2) {
                                    displayTime = `${dateParts[1]}-${dateParts[2]} ${timeParts[0]}:${timeParts[1]}`;
                                }
                            }
                        } catch (e) {
                            displayTime = bike.replaced_at;
                        }
                        const tooltipStr = `交換前: ${bike.replace_original_volt}V -> 交換後: ${bike.replace_increased_volt}V (交換日時: ${bike.replaced_at})`;
                        replacementInfo = `<span style="margin-left: 4px; font-size: 14px; cursor: help; display: inline-block; width: 18px; text-align: center;" title="${tooltipStr}">✅</span>`;
                    }
                }

                popupContent += `
                    <li class="popup-bike-item">
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
                            ${replacementInfo}
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
                    if (summaryPanel && window.innerWidth <= 768) {
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
    allFilteredBikes.forEach(bike => {
        if (bike.consecutive_use_duration >= thresholdSec) {
            unlockedBikesCount++;
        }
    });

    document.getElementById('alert-ports-count').innerText = filteredPortsCount;
    document.getElementById('alert-bikes-count').innerText = filteredBikesCount;

    const unlockedSummaryContainer = document.getElementById('unlocked-summary-container');
    if (unlockedSummaryContainer) {
        const unlockedFilterCheckbox = document.getElementById('unlocked-filter-checkbox');
        const isUnlockedFilterChecked = unlockedFilterCheckbox ? unlockedFilterCheckbox.checked : true;
        if (isUnlockedFilterChecked) {
            document.getElementById('unlocked-bikes-count').innerText = unlockedBikesCount;
            unlockedSummaryContainer.style.display = 'block';
        } else {
            unlockedSummaryContainer.style.display = 'none';
        }
    }

    // 車種マトリクス表の生成
    const tableContainer = document.getElementById('summary-table-container');
    if (allFilteredBikes.length > 0) {
        const unlockedFilterCheckbox = document.getElementById('unlocked-filter-checkbox');
        const isUnlockedFilterChecked = unlockedFilterCheckbox ? unlockedFilterCheckbox.checked : true;
        const uniqueModels = Array.from(new Set(allFilteredBikes.map(b => b.model_name))).sort();
        
        const matrix = {};
        uniqueModels.forEach(m => {
            matrix[m] = { 5: 0, 4: 0, 3: 0, 2: 0, 0: 0, "unlocked": 0 };
        });
        
        allFilteredBikes.forEach(bike => {
            if (matrix[bike.model_name]) {
                matrix[bike.model_name][bike.alert_level]++;
                if (bike.consecutive_use_duration >= thresholdSec) {
                    matrix[bike.model_name]["unlocked"]++;
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
        
        if (isUnlockedFilterChecked) {
            tableHtml += '<th style="color: #f472b6;">未施錠</th>';
        }
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
            
            if (isUnlockedFilterChecked) {
                const count = matrix[model]["unlocked"];
                const hasCountClass = count > 0 ? ' class="count-cell has-count" style="background-color: rgba(219, 39, 119, 0.25); color: #f472b6;"' : '';
                tableHtml += `<td${hasCountClass}>${count}</td>`;
            }
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
        const isMobile = window.innerWidth <= 768;
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
        document.getElementById('basemap-panel').style.right = '15px';
        const statusBtn = document.querySelector('.btn-status');
        if (statusBtn) statusBtn.style.display = 'none';
    } else {
        document.getElementById('status-filter-panel').style.display = '';
        document.getElementById('basemap-panel').style.right = '';
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
