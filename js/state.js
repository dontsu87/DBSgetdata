// Global Application State Declarations
let map;
let currentPositionMarker;
let currentPositionCircle;

let cachedDashboardData = null;
let markerGroup;
let selectedArea = ""; 
let checkedStatuses = []; 
let checkedHighlightStatuses = []; 
let checkedPrefixes = []; 
let isAllPrefixesChecked = true; 

const DEFAULT_HIGHLIGHT_STATUSES = [
    'AT異常(AT通知受信なし)',
    'AT異常(電圧値閾値未満)',
    'メンテナンス(手動)'
];
const LEGACY_STATUS_ALIASES = {
    'AT異常(電池なし)': 'AT異常(電圧値閾値未満)',
    'AT異常（電池なし）': 'AT異常(電圧値閾値未満)',
    'AT異常（AT通知受信なし）': 'AT異常(AT通知受信なし)',
    'AT異常（AT受信通知なし）': 'AT異常(AT通知受信なし)',
    'メンテナンス(アラート付)': 'メンテナンス(手動)'
};

// Initialize highlight statuses
const cachedHighlight = loadFromCache('checked_highlight_statuses', null);
if (cachedHighlight === null) {
    checkedHighlightStatuses = [...DEFAULT_HIGHLIGHT_STATUSES];
    saveToCache('checked_highlight_statuses', checkedHighlightStatuses);
} else {
    if (Array.isArray(cachedHighlight)) {
        const migrated = [];
        for (const status of cachedHighlight) {
            if (status === 'AT異常全般') {
                migrated.push('AT異常(AT通知受信なし)', 'AT異常(電圧値閾値未満)');
            } else {
                migrated.push(LEGACY_STATUS_ALIASES[status] || status);
            }
        }
        checkedHighlightStatuses = Array.from(new Set(migrated));
        saveToCache('checked_highlight_statuses', checkedHighlightStatuses);
    } else {
        checkedHighlightStatuses = [];
    }
}

let unlockedThresholdHours = loadFromCache('unlocked_threshold_hours', 2.0); 
let isPortSelectionMode = loadFromCache('is_port_selection_mode', false);
let selectedPortNames = loadFromCache('selected_port_names', []); 
let isReplacedModeEnabled = loadFromCache('is_replaced_mode_enabled', true);
let isOutOfPortOnlyMode = loadFromCache('out_of_port_only_mode', false);
let isPositionMismatchMode = loadFromCache('position_mismatch_mode', false);
// サービス再開後の既定はOFF: 停止中・利用者非公開の提供外ポートを隠す。
// 利用者が明示的に保存した設定は尊重し、表示状態リセット時はキー削除によりOFFへ戻る。
let isOutOfServiceVisible = loadFromCache('out_of_service_visible', false);
let isOutOfPortMarkerActive = true; // ポート外自転車の点は常時表示
let outOfPortMarkerGroup = null;
let outOfPortBikeMarkers = {};
let selfReplacedBikes = {}; // { bike_id: { timestamp, alert_level, voltage } }

// User interaction and auto-updating states
let prevStatusesStr = ""; 
let prevAreasStr = ""; 
let isMapInteracting = false; 
let isPendingUpdate = false;  
let pendingUpdateData = null; 
let interactionTimer = null;  
let mapInteractionTimer = null; 
let openPortName = null; 
let isFirstLoad = true;
