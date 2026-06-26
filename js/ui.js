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

    // --- 右パネルのアコーディオン（折りたたみ）制御 ---
    const basemapHeader = document.getElementById('basemap-header-btn');
    const basemapPanel = document.getElementById('basemap-panel');
    const basemapContainer = document.getElementById('basemap-options-container');
    const basemapArrow = basemapHeader.querySelector('.panel-arrow');

    basemapHeader.addEventListener('click', function() {
        if (isMobileLayout()) return; 
        
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
        if (isMobileLayout()) return; 
        
        const isExpanded = statusPanel.classList.toggle('expanded');
        if (isExpanded) {
            statusContainer.style.maxHeight = statusContainer.scrollHeight + 'px';
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
                    'checked_legend_levels', 'selected_worker_mode'
                ];
                keysToRemove.forEach(key => localStorage.removeItem(key));
                window.location.reload();
            }
        });
    }
}

// エリア選択タブの動的初期生成
function initAreaTabs(data) {
    if (!data || !data.ports) return;
    
    let areas = Array.from(new Set(data.ports.map(p => p.area_name))).filter(Boolean);
    const limitAreaParam = getRestrictedArea();
    if (isKindaiMode()) {
        const matchedArea = areas.find(a => a.includes("KNZ"));
        if (matchedArea) {
            areas = [matchedArea];
            selectedArea = matchedArea;
        }
    } else if (limitAreaParam) {
        const matchedArea = areas.find(a => a.toLowerCase().includes(limitAreaParam.toLowerCase()));
        if (matchedArea) {
            areas = [matchedArea];
            selectedArea = matchedArea; 
        }
    }
    
    if (!selectedArea) {
        if (!limitAreaParam && !isKindaiMode()) {
            const cachedArea = loadFromCache('selected_area', '');
            if (cachedArea && areas.includes(cachedArea)) {
                selectedArea = cachedArea;
            }
        }
        if (!selectedArea) {
            selectedArea = areas.find(a => a.includes("KNZ")) || areas[0] || "";
        }
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
        'AT異常(電池なし)',
        'メンテナンス(アラート付)'
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
