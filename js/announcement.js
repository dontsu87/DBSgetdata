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
        // 1. メンテナンスモード判定
        if (this.isMaintenanceActive()) {
            const overlay = document.getElementById('maintenance-overlay');
            const messageEl = document.getElementById('maintenance-message');
            if (overlay && messageEl) {
                messageEl.textContent = this.config.maintenance.message;
                overlay.style.display = 'flex';
                // app-containerを非表示にして操作を防ぐ
                const appContainer = document.getElementById('app-container');
                if (appContainer) {
                    appContainer.style.display = 'none';
                }
            }
            return;
        }

        // 2. お知らせバナー判定
        if (this.isBannerActive()) {
            const banner = document.getElementById('announcement-banner');
            const textEl = document.getElementById('announcement-banner-text');
            if (banner && textEl) {
                textEl.textContent = this.config.banner.message;
                banner.style.display = 'flex';
            }
        }
    }
};

window.AnnouncementManager = AnnouncementManager;
