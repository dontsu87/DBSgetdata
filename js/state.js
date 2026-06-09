// Global Application State Declarations
let map;
let currentPositionMarker;
let currentPositionCircle;

let cachedDashboardData = null;
let markerGroup;
let selectedArea = ""; 
let checkedStatuses = []; 
let checkedHighlightStatuses = []; 

// Initialize highlight statuses
const cachedHighlight = loadFromCache('checked_highlight_statuses', null);
if (cachedHighlight === null) {
    checkedHighlightStatuses = ['AT異常(AT通知受信なし)', 'AT異常(電池なし)', 'AT異常（AT受信通知なし）', 'AT異常（電池なし）'];
    saveToCache('checked_highlight_statuses', checkedHighlightStatuses);
} else {
    if (Array.isArray(cachedHighlight)) {
        checkedHighlightStatuses = cachedHighlight;
    } else {
        checkedHighlightStatuses = [];
    }
}

let unlockedThresholdHours = loadFromCache('unlocked_threshold_hours', 2.0); 
let isPortSelectionMode = loadFromCache('is_port_selection_mode', false);
let selectedPortNames = loadFromCache('selected_port_names', []); 
let isReplacedModeEnabled = loadFromCache('is_replaced_mode_enabled', true);

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
