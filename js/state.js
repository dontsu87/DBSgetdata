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

const DEFAULT_HIGHLIGHT_STATUSES = ['AT異常全般', 'メンテナンス(手動)'];
const LEGACY_STATUS_ALIASES = {
    'AT異常(AT通知受信なし)': 'AT異常全般',
    'AT異常(電池なし)': 'AT異常全般',
    'メンテナンス(アラート付)': 'メンテナンス(手動)'
};

// Initialize highlight statuses
const cachedHighlight = loadFromCache('checked_highlight_statuses', null);
if (cachedHighlight === null) {
    checkedHighlightStatuses = [...DEFAULT_HIGHLIGHT_STATUSES];
    saveToCache('checked_highlight_statuses', checkedHighlightStatuses);
} else {
    if (Array.isArray(cachedHighlight)) {
        checkedHighlightStatuses = Array.from(new Set(
            cachedHighlight.map(status => LEGACY_STATUS_ALIASES[status] || status)
        ));
        saveToCache('checked_highlight_statuses', checkedHighlightStatuses);
    } else {
        checkedHighlightStatuses = [];
    }
}

let unlockedThresholdHours = loadFromCache('unlocked_threshold_hours', 2.0); 
let isPortSelectionMode = loadFromCache('is_port_selection_mode', false);
let selectedPortNames = loadFromCache('selected_port_names', []); 
let isReplacedModeEnabled = loadFromCache('is_replaced_mode_enabled', true);
let isOutOfPortMarkerActive = loadFromCache('out_of_port_layer_active', false);
let outOfPortMarkerGroup = null;
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
