// UI Control, DOM Building, and Filter Sync Logic

function initUIComponents() {
    const unlockedThresholdInput = document.getElementById('unlocked-threshold-input');
    const unlockedFilterCheckbox = document.getElementById('unlocked-filter-checkbox');
    const unlockedFilterLabel = document.getElementById('unlocked-filter-label');

    if (unlockedThresholdInput) {
        unlockedThresholdInput.value = unlockedThresholdHours.toFixed(1);
        
        unlockedThresholdInput.addEventListener('change', function() {
            let val = parseFloat(unlockedThresholdInput.value);
            if (isNaN(val) || val <= 0) {
                val = 2.0;
                unlockedThresholdInput.value = "2.0";
            }
            unlockedThresholdHours = val;
            saveToCache('unlocked_threshold_hours', val);
            if (unlockedFilterLabel) {
                unlockedFilterLabel.innerText = `${EMOJI_UNLOCKED} 未施錠未返却 (${unlockedThresholdHours.toFixed(1)}時間以上)`;
            }
            updateFilterAndRender(false);
        });

        // --- 交換済表示モード (交換済考慮) トグルスイッチ制御 ---
        isReplacedModeEnabled = loadFromCache('is_replaced_mode_enabled', true);
        const replacedModeCheckbox = document.getElementById('replaced-mode-checkbox');
        const replacedToggleText = document.querySelector('.replaced-toggle-text');

        if (replacedModeCheckbox) {
            replacedModeCheckbox.checked = isReplacedModeEnabled;
            updateReplacedToggleUI(isReplacedModeEnabled);

            replacedModeCheckbox.addEventListener('change', function() {
                isReplacedModeEnabled = replacedModeCheckbox.checked;
                saveToCache('is_replaced_mode_enabled', isReplacedModeEnabled);
                updateReplacedToggleUI(isReplacedModeEnabled);
                console.log("Replaced Mode Enabled:", isReplacedModeEnabled);
                updateFilterAndRender(false);
            });
        }

        function updateReplacedToggleUI(enabled) {
            if (replacedToggleText) {
                replacedToggleText.innerText = enabled ? '交換済 ON' : '交換済 OFF';
            }
        }
        
        unlockedThresholdInput.addEventListener('input', function() {
            let val = parseFloat(unlockedThresholdInput.value);
            if (!isNaN(val) && val > 0) {
                unlockedThresholdHours = val;
                saveToCache('unlocked_threshold_hours', val);
                if (unlockedFilterLabel) {
                    unlockedFilterLabel.innerText = `${EMOJI_UNLOCKED} 未施錠未返却 (${unlockedThresholdHours.toFixed(1)}時間以上)`;
                }
                updateFilterAndRender(false);
            }
        });
    }

    if (unlockedFilterCheckbox) {
        const isUnlockedFilterChecked = loadFromCache('unlocked_filter_enabled', true);
        unlockedFilterCheckbox.checked = isUnlockedFilterChecked;

        unlockedFilterCheckbox.addEventListener('change', function() {
            saveToCache('unlocked_filter_enabled', unlockedFilterCheckbox.checked);
            updateFilterAndRender(false);
        });
    }

    if (unlockedFilterLabel) {
        unlockedFilterLabel.innerText = `${EMOJI_UNLOCKED} 未施錠未返却 (${unlockedThresholdHours.toFixed(1)}時間以上)`;
    }

    // --- ポート位置不整合モードトグル ---
    const positionMismatchCheckbox = document.getElementById('position-mismatch-checkbox');
    const positionMismatchText = document.querySelector('.position-mismatch-text');
    if (positionMismatchCheckbox) {
        positionMismatchCheckbox.checked = isPositionMismatchMode;
        updatePositionMismatchToggleUI(isPositionMismatchMode);
        positionMismatchCheckbox.addEventListener('change', function() {
            isPositionMismatchMode = positionMismatchCheckbox.checked;
            saveToCache('position_mismatch_mode', isPositionMismatchMode);
            updatePositionMismatchToggleUI(isPositionMismatchMode);
            updateFilterAndRender(false);
            updateOutOfPortCount(cachedDashboardData);
        });
    }

    function updatePositionMismatchToggleUI(enabled) {
        if (positionMismatchText) {
            positionMismatchText.innerText = enabled ? '位置不整合抽出 ON' : '位置不整合抽出 OFF';
        }
    }
    // --- 右パネルのアコーディオン（折りたたみ）制御 ---
    const basemapHeader = document.getElementById('basemap-header-btn');
    const basemapPanel = document.getElementById('basemap-panel');
    const basemapContainer = document.getElementById('basemap-options-container');
    const basemapArrow = basemapHeader.querySelector('.panel-arrow');

    basemapHeader.addEventListener('click', function() {
        if (isMobileLayout()) return; 
        
        const isExpanded = basemapPanel.classList.toggle('expanded');
        if (isExpanded) {
            const panelRect = basemapPanel.getBoundingClientRect();
            const availableHeight = window.innerHeight - panelRect.top - 130;
            basemapContainer.style.maxHeight = Math.max(100, Math.min(basemapContainer.scrollHeight, availableHeight)) + 'px';
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
        if (isMobileLayout()) return; 
        
        const isExpanded = statusPanel.classList.toggle('expanded');
        if (isExpanded) {
            const panelRect = statusPanel.getBoundingClientRect();
            const availableHeight = window.innerHeight - panelRect.top - 130;
            statusContainer.style.maxHeight = Math.max(150, Math.min(statusContainer.scrollHeight, availableHeight)) + 'px';
            statusArrow.style.transform = 'rotate(180deg)';
        } else {
            statusContainer.style.maxHeight = '0px';
            statusArrow.style.transform = 'rotate(0deg)';
        }
    });

    window.addEventListener('resize', function() {
        if (isMobileLayout()) {
            basemapContainer.style.maxHeight = '';
            statusContainer.style.maxHeight = '';
            basemapArrow.style.transform = '';
            statusArrow.style.transform = '';
        } else {
            if (!basemapPanel.classList.contains('expanded')) {
                basemapContainer.style.maxHeight = '0px';
                basemapArrow.style.transform = 'rotate(0deg)';
            } else {
                const panelRect = basemapPanel.getBoundingClientRect();
                const availableHeight = window.innerHeight - panelRect.top - 130;
                basemapContainer.style.maxHeight = Math.max(100, Math.min(basemapContainer.scrollHeight, availableHeight)) + 'px';
                basemapArrow.style.transform = 'rotate(180deg)';
            }
            
            if (!statusPanel.classList.contains('expanded')) {
                statusContainer.style.maxHeight = '0px';
                statusArrow.style.transform = 'rotate(0deg)';
            } else {
                const panelRect = statusPanel.getBoundingClientRect();
                const availableHeight = window.innerHeight - panelRect.top - 130;
                statusContainer.style.maxHeight = Math.max(150, Math.min(statusContainer.scrollHeight, availableHeight)) + 'px';
                statusArrow.style.transform = 'rotate(180deg)';
            }
        }
    });

    // --- ポート選択モード トグルスイッチ制御 ---
    const selectionModeCheckbox = document.getElementById('selection-mode-checkbox');
    const selectionToggleText = document.querySelector('.selection-toggle-text');

    if (selectionModeCheckbox) {
        selectionModeCheckbox.checked = isPortSelectionMode;
        if (selectionToggleText) {
            selectionToggleText.innerText = isPortSelectionMode ? '選択モード ON' : '選択モード OFF';
        }

        selectionModeCheckbox.addEventListener('change', function() {
            isPortSelectionMode = selectionModeCheckbox.checked;
            saveToCache('is_port_selection_mode', isPortSelectionMode);
            if (selectionToggleText) {
                selectionToggleText.innerText = isPortSelectionMode ? '選択モード ON' : '選択モード OFF';
            }
            console.log("Port Selection Mode:", isPortSelectionMode);
            
            if (!isPortSelectionMode) {
                const selectedContainer = document.getElementById('selected-ports-container');
                if (selectedContainer) {
                    selectedContainer.style.display = 'none';
                }
            }
            
            updateFilterAndRender(false);
        });
    }

    // 凡例のチェックボックス変更時に再描画を連動
    document.querySelectorAll('.legend-filter').forEach(checkbox => {
        checkbox.addEventListener('change', () => {
            const checkedLevels = Array.from(document.querySelectorAll('.legend-filter:checked'))
                                       .map(el => parseInt(el.value));
            saveToCache('checked_legend_levels', checkedLevels);
            updateFilterAndRender(true);
        });
    });

    // ビューの初期状態リセット処理
    const resetViewBtn = document.getElementById('reset-view-btn');
    if (resetViewBtn) {
        resetViewBtn.addEventListener('click', function() {
            if (confirm('表示状態（フィルターや地図位置など）を初期状態に戻しますか？')) {
                const keysToRemove = [
                    'map_center_lat', 'map_center_lng', 'map_zoom',
                    'selected_basemap', 'selected_area', 'checked_statuses', 'checked_highlight_statuses',
                    'unlocked_threshold_hours', 'unlocked_filter_enabled',
                    'is_port_selection_mode', 'selected_port_names',
                    'checked_legend_levels', 'selected_worker_mode',
                    'out_of_port_only_mode', 'out_of_port_layer_active', 'position_mismatch_mode',
                    'out_of_service_visible'
                ];
                keysToRemove.forEach(key => localStorage.removeItem(key));
                for (let i = localStorage.length - 1; i >= 0; i--) {
                    const key = localStorage.key(i);
                    if (key && key.startsWith('checked_prefixes_')) {
                        localStorage.removeItem(key);
                    }
                }
                window.location.reload();
            }
        });
    }

    // --- ポート外専用モードトグルスイッチ ---
    const outOfPortOnlyCheckbox = document.getElementById('out-of-port-only-checkbox');
    if (outOfPortOnlyCheckbox) {
        outOfPortOnlyCheckbox.checked = isOutOfPortOnlyMode;
        updateOutOfPortOnlyBtnUI(isOutOfPortOnlyMode);

        outOfPortOnlyCheckbox.addEventListener('change', function() {
            isOutOfPortOnlyMode = outOfPortOnlyCheckbox.checked;
            saveToCache('out_of_port_only_mode', isOutOfPortOnlyMode);
            updateOutOfPortOnlyBtnUI(isOutOfPortOnlyMode);
            updateFilterAndRender(false);
        });
    }

    // --- 提供外ポート表示トグルスイッチ ---
    const outOfServiceCheckbox = document.getElementById('out-of-service-checkbox');
    if (outOfServiceCheckbox) {
        outOfServiceCheckbox.checked = isOutOfServiceVisible;
        updateOutOfServiceToggleUI(isOutOfServiceVisible);

        outOfServiceCheckbox.addEventListener('change', function() {
            isOutOfServiceVisible = outOfServiceCheckbox.checked;
            saveToCache('out_of_service_visible', isOutOfServiceVisible);
            updateOutOfServiceToggleUI(isOutOfServiceVisible);
            updateFilterAndRender(false);
        });
    }

    // --- ポート外車両バブルボタン（タップでリスト表示モーダルを開く） ---
    const outOfPortBtn = document.getElementById('out-of-port-btn');
    const outOfPortModal = document.getElementById('out-of-port-modal');
    const closeOutOfPortModalBtn = document.getElementById('close-out-of-port-modal-btn');

    if (outOfPortBtn) {
        outOfPortBtn.addEventListener('click', function() {
            showOutOfPortModal(cachedDashboardData);
        });
    }

    if (closeOutOfPortModalBtn && outOfPortModal) {
        closeOutOfPortModalBtn.addEventListener('click', function() {
            outOfPortModal.style.display = 'none';
        });
        
        // モーダルの外側をクリックしたら閉じる
        outOfPortModal.addEventListener('click', function(e) {
            if (e.target === outOfPortModal) {
                outOfPortModal.style.display = 'none';
            }
        });
    }
}

// エリア選択タブの動的初期生成
function initAreaTabs(data) {
    if (!data || !data.ports) return;
    
    let areas = Array.from(new Set(data.ports.map(p => normalizeAreaName(p.area_name)))).filter(Boolean);
    const limitAreaParam = getRestrictedArea();
    const limitAreasParam = getRestrictedAreas();

    // 自動更新中の選択値や旧端末キャッシュを、現行エリア名へ移行する。
    selectedArea = findMatchingArea(areas, selectedArea);

    if (isKindaiMode()) {
        const matchedArea = findMatchingArea(areas, DEFAULT_AREA_NAME);
        if (matchedArea) {
            areas = [matchedArea];
            selectedArea = matchedArea;
        }
    } else if (limitAreasParam) {
        const matched = limitAreasParam
            .map(requested => findMatchingArea(areas, requested))
            .filter(Boolean);
        const unique = Array.from(new Set(matched));
        if (unique.length) {
            areas = unique;
            selectedArea = findMatchingArea(areas, selectedArea) || areas[0];
        }
    } else if (limitAreaParam) {
        const matchedArea = findMatchingArea(areas, limitAreaParam);
        if (matchedArea) {
            areas = [matchedArea];
            selectedArea = matchedArea; 
        }
    }
    
    if (!selectedArea) {
        if (!limitAreaParam && !limitAreasParam && !isKindaiMode()) {
            const cachedArea = loadFromCache('selected_area', '');
            const matchedCachedArea = findMatchingArea(areas, cachedArea);
            if (matchedCachedArea) {
                selectedArea = matchedCachedArea;
            }
        }
        if (!selectedArea) {
            selectedArea = findMatchingArea(areas, DEFAULT_AREA_NAME) || areas[0] || "";
        }
    }
    if (selectedArea) {
        saveToCache('selected_area', selectedArea);
    }

    const currentAreasStr = areas.sort().join(',');
    const tabsContainer = document.getElementById('area-tabs');

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
    
    if (areas.length <= 1) {
        tabsContainer.style.display = 'none';
    } else {
        tabsContainer.style.display = 'flex';
    }
    
    areas.forEach(area => {
        const btn = document.createElement('button');
        btn.className = 'area-tab' + (area === selectedArea ? ' active' : '');
        btn.setAttribute('data-area', area);
        btn.innerText = area.replace(/_/g, ' ');
        
        btn.addEventListener('click', () => {
            document.querySelectorAll('.area-tab').forEach(t => t.classList.remove('active'));
            btn.classList.add('active');
            selectedArea = area;
            saveToCache('selected_area', area);
            updatePrefixFilterUI(cachedDashboardData);
            updateFilterAndRender();
        });
        
        tabsContainer.appendChild(btn);
    });
}

// 車両状態 (Status) フィルターの動的初期生成
function initStatusFilter(data) {
    if (!data || !data.ports) return;

    const restrictedStatus = getRestrictedStatus();

    if (restrictedStatus) {
        checkedStatuses = [restrictedStatus];
        const statusPanel = document.getElementById('status-filter-panel');
        if (statusPanel) statusPanel.style.display = 'none';
        
        const statusBtn = document.querySelector('.btn-status');
        if (statusBtn) statusBtn.style.display = 'none';
        return; 
    }

    const statuses = new Set();
    data.ports.forEach(port => {
        port.bikes.forEach(bike => {
            if (bike.status) {
                statuses.add(bike.status.trim());
            }
        });
    });

    // 特定の重要なステータスは、実データに一切含まれていなくても常にフィルターに表示させる
    const alwaysVisibleStatuses = [
        'AT異常(AT通知受信なし)',
        'AT異常(電圧値閾値未満)',
        'メンテナンス(手動)'
    ];
    alwaysVisibleStatuses.forEach(s => statuses.add(s));

    const sortedStatuses = Array.from(statuses).sort();
    const currentStatusesStr = sortedStatuses.join(',');

    const selectAllBtn = document.getElementById('status-select-all');
    if (selectAllBtn) {
        selectAllBtn.onclick = function() {
            checkedStatuses = [...sortedStatuses];
            document.querySelectorAll('.status-filter').forEach(cb => {
                cb.checked = true;
            });
            saveToCache('checked_statuses', checkedStatuses);
            updateFilterAndRender();
        };
    }
    const deselectAllBtn = document.getElementById('status-deselect-all');
    if (deselectAllBtn) {
        deselectAllBtn.onclick = function() {
            checkedStatuses = [];
            checkedHighlightStatuses = [];
            document.querySelectorAll('.status-filter').forEach(cb => {
                cb.checked = false;
            });
            document.querySelectorAll('.status-highlight').forEach(cb => {
                cb.checked = false;
            });
            saveToCache('checked_statuses', checkedStatuses);
            saveToCache('checked_highlight_statuses', checkedHighlightStatuses);
            updateFilterAndRender();
        };
    }

    if (checkedStatuses.length === 0) {
        const cachedStatuses = loadFromCache('checked_statuses', null);
        if (Array.isArray(cachedStatuses)) {
            checkedStatuses = cachedStatuses.filter(s => sortedStatuses.includes(s));
            if (checkedStatuses.length === 0) {
                checkedStatuses = [...sortedStatuses];
            }
        } else {
            checkedStatuses = [...sortedStatuses];
        }
    } else {
        const newStatuses = sortedStatuses.filter(s => !checkedStatuses.includes(s) && !prevStatusesStr.split(',').includes(s));
        checkedStatuses = checkedStatuses.filter(s => sortedStatuses.includes(s)).concat(newStatuses);
    }

    if (currentStatusesStr === prevStatusesStr) {
        const container = document.getElementById('status-checkboxes-container');
        if (container) {
            const checkboxes = container.querySelectorAll('.status-filter');
            checkboxes.forEach(cb => {
                cb.checked = checkedStatuses.includes(cb.value);
            });
            const highlights = container.querySelectorAll('.status-highlight');
            highlights.forEach(cb => {
                cb.checked = checkedHighlightStatuses.includes(cb.value);
            });
        }
        return;
    }

    prevStatusesStr = currentStatusesStr;
    const container = document.getElementById('status-checkboxes-container');
    container.innerHTML = '';

    sortedStatuses.forEach(status => {
        const wrapper = document.createElement('div');
        wrapper.className = 'status-filter-item-wrapper';
        wrapper.style.display = 'flex';
        wrapper.style.justifyContent = 'space-between';
        wrapper.style.alignItems = 'center';
        wrapper.style.padding = '4px 12px';
        
        const isChecked = checkedStatuses.includes(status);
        const isHighlighted = checkedHighlightStatuses.includes(status);
        
        let color = 'yellow';
        if (status.startsWith('AT異常')) {
            color = 'red';
        } else if (status.startsWith('メンテナンス')) {
            color = 'brown';
        }
        const badgeHtml = getHighlightBadgeSvg(color, 12);
        
        wrapper.innerHTML = `
            <label style="display: flex; align-items: center; gap: 8px; margin: 0; cursor: pointer; flex: 1;">
                <input type="checkbox" class="status-filter" value="${status}" ${isChecked ? 'checked' : ''}>
                <span><b>${status}</b></span>
            </label>
            <label style="display: flex; align-items: center; gap: 4px; font-size: 11px; color: #cbd5e1; cursor: pointer; margin: 0; user-select: none;">
                <input type="checkbox" class="status-highlight" value="${status}" ${isHighlighted ? 'checked' : ''}>
                <span>強調 ${badgeHtml}</span>
            </label>
        `;

        const checkbox = wrapper.querySelector('.status-filter');
        checkbox.addEventListener('change', function() {
            if (checkbox.checked) {
                if (!checkedStatuses.includes(status)) {
                    checkedStatuses.push(status);
                }
            } else {
                checkedStatuses = checkedStatuses.filter(s => s !== status);
                if (checkedHighlightStatuses.includes(status)) {
                    checkedHighlightStatuses = checkedHighlightStatuses.filter(s => s !== status);
                    saveToCache('checked_highlight_statuses', checkedHighlightStatuses);
                    const highlightCheckbox = wrapper.querySelector('.status-highlight');
                    if (highlightCheckbox) {
                        highlightCheckbox.checked = false;
                    }
                }
            }
            saveToCache('checked_statuses', checkedStatuses);
            updateFilterAndRender();
        });

        const highlightCheckbox = wrapper.querySelector('.status-highlight');
        highlightCheckbox.addEventListener('change', function() {
            if (highlightCheckbox.checked) {
                if (!checkedHighlightStatuses.includes(status)) {
                    checkedHighlightStatuses.push(status);
                }
                if (!checkedStatuses.includes(status)) {
                    checkedStatuses.push(status);
                    saveToCache('checked_statuses', checkedStatuses);
                    const filterCheckbox = wrapper.querySelector('.status-filter');
                    if (filterCheckbox) {
                        filterCheckbox.checked = true;
                    }
                }
            } else {
                checkedHighlightStatuses = checkedHighlightStatuses.filter(s => s !== status);
            }
            saveToCache('checked_highlight_statuses', checkedHighlightStatuses);
            updateFilterAndRender();
        });

        container.appendChild(wrapper);
    });
}

// 車両コード (接頭辞) フィルターの動的生成
function updatePrefixFilterUI(data) {
    const container = document.getElementById('prefix-filter-container');
    const checkboxesContainer = document.getElementById('prefix-checkboxes');
    
    updateOutOfPortCount(data);
    
    if (!container || !checkboxesContainer) return;

    if (!data || !data.ports || !selectedArea) {
        container.style.display = 'none';
        checkedPrefixes = [];
        return;
    }

    const targetArea = normalizeAreaName(selectedArea);
    const prefixes = new Set();
    data.ports.forEach(port => {
        if (port.bikes) {
            port.bikes.forEach(bike => {
                const bikeArea = normalizeAreaName(bike.area_name || port.area_name);
                if (bikeArea === targetArea && bike.bike_id) {
                    const prefix = extractBikePrefix(bike.bike_id);
                    if (prefix) {
                        prefixes.add(prefix);
                    }
                }
            });
        }
    });
    const sortedPrefixes = Array.from(prefixes).sort();

    // プレフィックスが2種類以上ある場合のみフィルターを表示する
    if (sortedPrefixes.length <= 1) {
        container.style.display = 'none';
        checkedPrefixes = []; // フィルターは適用しない (全表示)
        isAllPrefixesChecked = true;
        return;
    }

    container.style.display = 'flex';
    
    // エリアごとの選択状態をキャッシュから読み込み
    const cachedChecked = loadFromCache('checked_prefixes_' + selectedArea, null);
    
    if (Array.isArray(cachedChecked)) {
        checkedPrefixes = cachedChecked.filter(p => sortedPrefixes.includes(p));
        if (cachedChecked.length > 0 && checkedPrefixes.length === 0) {
            checkedPrefixes = [...sortedPrefixes];
        }
    } else {
        checkedPrefixes = [...sortedPrefixes];
    }

    isAllPrefixesChecked = (checkedPrefixes.length === sortedPrefixes.length);

    checkboxesContainer.innerHTML = '';

    sortedPrefixes.forEach(prefix => {
        const label = document.createElement('label');
        label.className = 'status-filter-item';
        label.style.cssText = 'display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; border: 1px solid #475569; border-radius: 4px; background-color: #1e293b; color: #cbd5e1; cursor: pointer; font-size: 11px; margin: 0;';
        
        const isChecked = checkedPrefixes.includes(prefix);
        
        label.innerHTML = `
            <input type="checkbox" class="prefix-filter" value="${prefix}" ${isChecked ? 'checked' : ''} style="margin: 0;">
            <span style="font-weight: bold;">${prefix}</span>
        `;
        
        const checkbox = label.querySelector('input');
        checkbox.addEventListener('change', function() {
            if (checkbox.checked) {
                if (!checkedPrefixes.includes(prefix)) {
                    checkedPrefixes.push(prefix);
                }
            } else {
                checkedPrefixes = checkedPrefixes.filter(p => p !== prefix);
            }
            isAllPrefixesChecked = (checkedPrefixes.length === sortedPrefixes.length);
            saveToCache('checked_prefixes_' + selectedArea, checkedPrefixes);
            updateFilterAndRender(false);
        });

        checkboxesContainer.appendChild(label);
    });
}

// ポート外車両モーダルの生成と表示
function showOutOfPortModal(data) {
    data = preparePositionMismatchData(filterPortsByServiceState(data));
    const modal = document.getElementById('out-of-port-modal');
    const areaNameSpan = document.getElementById('out-of-port-area-name');
    const listBody = document.getElementById('out-of-port-list-body');
    const emptyMsg = document.getElementById('out-of-port-empty-msg');
    const tableContainer = document.querySelector('#out-of-port-modal .modal-table-container');
    
    if (!modal || !listBody || !emptyMsg) return;
    
    // エリア名表示をセット
    let readableAreaName = '不明';
    if (selectedArea) {
        const parts = selectedArea.split('_');
        readableAreaName = parts.length > 1 ? parts[1] : selectedArea;
    }
    if (areaNameSpan) {
        areaNameSpan.innerText = readableAreaName;
    }
    
    // リストの初期化
    listBody.innerHTML = '';
    
    // GPS位置のないポート（port.has_gps === false）から車両を抽出
    const outOfPortBikes = [];
    const targetArea = normalizeAreaName(selectedArea);
    if (data && data.ports) {
        data.ports.forEach(port => {
            if (port.has_gps === false || port.lat === null || port.lon === null || (port.port_name && port.port_name.includes('ポート外'))) {
                if (port.bikes) {
                    port.bikes.forEach(bike => {
                        const bikeArea = normalizeAreaName(bike.area_name || port.area_name);
                        if (bikeArea === targetArea) {
                            // 車両コード（接頭辞）フィルター判定
                            if (!isAllPrefixesChecked && bike.bike_id) {
                                const isPrefixMatch = matchesBikePrefix(
                                    bike.bike_id,
                                    checkedPrefixes,
                                    isAllPrefixesChecked
                                );
                                if (!isPrefixMatch) return;
                            }

                            outOfPortBikes.push({
                                bike_id: bike.bike_id,
                                port_name: bike.mismatch_source_port || port.port_name || 'ポート外',
                                displayed_port_name: bike.mismatch_source_port || bike.displayed_port_name || '',
                                nearest_port_name: bike.nearest_port_name || null,
                                nearest_port_distance_m: (typeof bike.nearest_port_distance_m === 'number') ? bike.nearest_port_distance_m : null,
                                voltage: bike.voltage,
                                alert_level: bike.alert_level,
                                alert_level_name: bike.alert_level_name,
                                status: bike.status,
                                at_time: bike.at_time || '',
                                gps_datetime: bike.gps_datetime || '',
                                position_mismatch: !!bike.port_position_mismatch
                            });
                        }
                    });
                }
            }
        });
    }
    
    // 車体番号でソート (自然順)
    outOfPortBikes.sort((a, b) => (a.bike_id || '').localeCompare(b.bike_id || '', undefined, { numeric: true, sensitivity: 'base' }));
    
    if (outOfPortBikes.length === 0) {
        emptyMsg.style.display = 'block';
        if (tableContainer) tableContainer.style.display = 'none';
    } else {
        emptyMsg.style.display = 'none';
        if (tableContainer) tableContainer.style.display = 'block';
        
        outOfPortBikes.forEach(bike => {
            const tr = document.createElement('tr');
            tr.dataset.bikeId = bike.bike_id || '';
            tr.style.cursor = 'pointer';
            tr.title = '地図上の車両位置へ移動';
            tr.addEventListener('click', function() {
                focusOutOfPortBike(bike.bike_id);
            });
            if (bike.position_mismatch) {
                tr.style.background = '#fee2e2';
                tr.style.color = '#991b1b';
                tr.style.fontWeight = 'bold';
                tr.style.borderLeft = '5px solid #dc2626';
            }
            
            // 車体番号 td
            const tdBikeId = document.createElement('td');
            tdBikeId.style.fontWeight = 'bold';
            tdBikeId.style.textAlign = 'center';
            tdBikeId.innerText = bike.bike_id;
            tr.appendChild(tdBikeId);
            
            // データ上のポート位置 td
            const tdPortPos = document.createElement('td');
            tdPortPos.style.textAlign = 'center';
            if (bike.position_mismatch) {
                const mismatchLabel = document.createElement('span');
                mismatchLabel.style.color = '#dc2626';
                mismatchLabel.style.fontWeight = 'bold';
                mismatchLabel.innerText = bike.displayed_port_name
                    ? '⚠️位置不整合（表示上のポート: ' + bike.displayed_port_name + '）'
                    : '⚠️位置不整合';
                tdPortPos.appendChild(mismatchLabel);
                tdPortPos.appendChild(document.createElement('br'));

                const nearestText = bike.nearest_port_name
                    ? '実際の最寄りポート: ' + bike.nearest_port_name + '（約' + Math.round(bike.nearest_port_distance_m) + 'm）'
                    : '実際の最寄りポート: 100m以内になし';
                tdPortPos.appendChild(document.createTextNode(nearestText));
            } else {
                tdPortPos.appendChild(document.createTextNode(bike.port_name));
            }
            tr.appendChild(tdPortPos);
            
            // バッテリー残量 td (電圧値 + 警告バッジ)
            const tdVolt = document.createElement('td');
            tdVolt.style.textAlign = 'center';
            
            const voltText = bike.voltage !== null ? `${bike.voltage.toFixed(1)}V` : '--V';
            let badgeClass = 'unknown';
            if (bike.alert_level === 5) badgeClass = 'at-error';
            else if (bike.alert_level === 4) badgeClass = 'strong';
            else if (bike.alert_level === 0) badgeClass = 'normal';
            else badgeClass = 'unknown';
            
            const badgeSpan = document.createElement('span');
            badgeSpan.className = `modal-badge ${badgeClass}`;
            badgeSpan.style.marginLeft = '8px';
            badgeSpan.innerText = bike.alert_level_name || '正常';
            
            tdVolt.appendChild(document.createTextNode(voltText));
            tdVolt.appendChild(badgeSpan);
            tr.appendChild(tdVolt);
            
            // 車両状態 td
            const tdStatus = document.createElement('td');
            tdStatus.style.textAlign = 'center';
            tdStatus.innerText = bike.status;
            tr.appendChild(tdStatus);
            
            // GPS測位 td
            const tdAtTime = document.createElement('td');
            tdAtTime.style.textAlign = 'center';
            tdAtTime.style.fontSize = '10px';
            var atInfo = formatAtTime(bike.gps_datetime || bike.at_time);
            tdAtTime.innerText = atInfo.text;
            if (atInfo.stale) {
                tdAtTime.style.color = '#dc2626';
                tdAtTime.style.fontWeight = 'bold';
            }
            tr.appendChild(tdAtTime);
            
            listBody.appendChild(tr);
        });
    }
    
    // モーダルを表示
    modal.style.display = 'flex';
}

// ポート外（位置情報なし）車両数のカウント更新およびUI状態同期
function updateOutOfPortCount(data) {
    data = preparePositionMismatchData(filterPortsByServiceState(data));
    const countEl = document.getElementById('out-of-port-count');
    updateOutOfPortBtnUI(isOutOfPortMarkerActive);
    if (!countEl) return;
    
    let count = 0;
    if (data && data.ports && selectedArea) {
        data.ports.forEach(port => {
            if (port.has_gps === false || port.lat === null || port.lon === null) {
                if (port.bikes) {
                    port.bikes.forEach(bike => {
                        if (normalizeAreaName(bike.area_name || port.area_name) === normalizeAreaName(selectedArea)) {
                            count++;
                        }
                    });
                }
            }
        });
    }
    countEl.innerText = count;
}

function updateOutOfPortBtnUI(active) {
    const btn = document.getElementById('out-of-port-btn');
    if (btn) {
        btn.classList.toggle('active', !!active);
    }
}

function updateOutOfPortOnlyBtnUI(enabled) {
    const textSpan = document.querySelector('.out-of-port-only-toggle-text');
    if (textSpan) {
        textSpan.textContent = enabled ? 'ポート外専用 ON' : 'ポート外専用 OFF';
    }
}

function updateOutOfServiceToggleUI(enabled) {
    const textSpan = document.querySelector('.out-of-service-toggle-text');
    if (textSpan) {
        textSpan.textContent = enabled ? '提供外 ON' : '提供外 OFF';
    }
}
