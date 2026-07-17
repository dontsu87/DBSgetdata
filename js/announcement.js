/**
 * お知らせおよびメンテナンス情報の管理モジュール
 */
const AnnouncementManager = {
    config: null,

    async init() {
        try {
            // announcement.jsonをキャッシュバスター付きで取得
            const response = await fetch('announcement.json?t=' + Date.now());
            if (!response.ok) {
                throw new Error('Failed to load announcement config');
            }
            this.config = await response.json();
            this.applyAnnouncements();
            return this.isMaintenanceActive();
        } catch (error) {
            console.error('Error initializing AnnouncementManager:', error);
            return false; // エラー時は安全のため通常稼働とする
        }
    },

    isMaintenanceActive() {
        if (!this.config || !this.config.maintenance) return false;
        
        const maint = this.config.maintenance;
        if (!maint.enabled) return false;
        
        const startTime = new Date(maint.start_time);
        const now = new Date();
        
        return now >= startTime;
    },

    isBannerActive() {
        if (!this.config || !this.config.banner) return false;
        
        const banner = this.config.banner;
        if (!banner.enabled) return false;
        
        const startTime = new Date(banner.start_time);
        const endTime = new Date(banner.end_time);
        const now = new Date();
        
        return now >= startTime && now < endTime;
    },

    applyAnnouncements() {
        const banner = document.getElementById('announcement-banner');
        const textEl = document.getElementById('announcement-banner-text');
        if (!banner || !textEl) return;

        // 1. メンテナンス（休止）モード判定
        // 休止期間中（7/31 21:00〜）は、全画面ブロックは行わず、バナーにて休止メッセージを表示し、機能（作業員表示など）は動かしたままにする
        if (this.isMaintenanceActive()) {
            textEl.textContent = this.config.maintenance.message;
            banner.style.display = 'flex';
            return;
        }

        // 2. 事前周知お知らせバナー判定（本日〜7/31 21:00）
        if (this.isBannerActive()) {
            textEl.textContent = this.config.banner.message;
            banner.style.display = 'flex';
        }
    }
};

window.AnnouncementManager = AnnouncementManager;
