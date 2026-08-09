/**
 * DBSEXT 名前空間および設定定義
 * モジュール契約 §1, §2 に基づく基盤定義
 */
(function (global) {
  'use strict';

  global.DBSEXT = global.DBSEXT || {};
  var D = global.DBSEXT;

  D.VERSION = '202608092338';

  D.CONFIG = {
    PORTAL_ORIGIN: 'https://mg.docomo-cycle.jp',
    MAP_APP_URL:   'https://dontsu87.github.io/DBSgetdata/',
    GUIDE_URL:     'https://dontsu87.github.io/DBSgetdata/ext/',
    ACCENT:        '#0b5cab',   // 拡張適用中を示す青
    ACCENT_DARK:   '#083f75',
    // マップアプリが知っている全エリア。これらを全部持っていれば ?kanriall を使う
    KNOWN_AREAS: ['金沢', '福井', '小松', '敦賀', '上田千曲広域', '出雲・松江・境港'],
    MARKER_ATTR: 'data-dbsext'   // 冪等ガードに使う body の属性
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);


/**
 * DBSEXT コアモジュール
 * ライフサイクル管理、冪等性制御、DOM変更監視、ログ出力を担当
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  var observer = null;
  var contentCallbacks = [];
  var debounceTimer = null;
  // 自前のDOM操作中は監視を止めるための入れ子カウンタ
  var applying = 0;

  // **自前のUIそのもの**だけを列挙する。
  // ここに `[data-dbsext]`(bodyの適用済みマーカー)や `[data-dbsext-tabled]`
  // (ポータルのテーブルに目印を付けただけのもの)を入れてはいけない。
  // 入れると、その配下で起きるポータル由来の変化まで「自分の変更」と誤判定し、
  // SPA遷移後に table-tools が二度と再適用されなくなる。
  var OWN_UI_SELECTOR = [
    '[data-dbsext-upsell]',
    '[data-dbsext-launcher]',
    '[data-dbsext-launcher-panel]',
    '[data-dbsext-skin]',
    '[data-dbsext-net-status]',
    '[data-dbsext-state-forms]',
    '[data-dbsext-table-columns]',
    '[data-dbsext-beacons-panel]',
    '[data-dbsext-beacons-native-modal]',
    '[data-dbsext-beacons-link]',
    '[data-dbsext-beacons-link-a]'
  ].join(',');

  // **ポータルの要素に付けた「目印」**。自前UIではない。
  //
  // 拡張は自分が作った要素にも、ポータルの既存要素にも `data-dbsext-*` を付ける。
  // 前者は自前UI（その中の変化は自分の仕業）だが、**後者はポータルの要素であり、
  // その中で起きる変化は外部の変化である**。
  //
  // ここを区別せず「`data-dbsext-` で始まる属性があれば自前UI」と判定すると、
  // `.el-table`（`data-dbsext-tabled` / `data-dbsext-wrap` が付く）を対象にした
  // MutationRecord が全部「自分の仕業」になり、**SPAが表を差し替えても
  // table-tools が再適用されない**。過去に同じ性質の欠陥を1件出している
  // （`isDbsextNode` が祖先を遡り、body配下すべてを自前と誤判定していた）。
  // **`data-dbsext-*` 属性の分類表。新しい属性を足したら、必ずここに登録する。**
  //
  //   'own'    … 拡張が作った要素に付ける（その中の変化は自分の仕業）
  //   'mark'   … **ポータルの既存要素**に付ける目印（中の変化は外部の変化）
  //
  // 登録漏れは `verify.mjs` が落とす。分類を間違えると、
  // 「SPAで表が差し替わっても再適用されない」または「自己発火で無限ループ」になる。
  var ATTR_KIND = {
    // --- 自前UI ---
    'data-dbsext-upsell': 'own',
    'data-dbsext-launcher': 'own',
    'data-dbsext-launcher-panel': 'own',
    'data-dbsext-skin': 'own',
    'data-dbsext-net-status': 'own',
    'data-dbsext-loading-mask': 'own',
    'data-dbsext-top-indicator': 'own',
    'data-dbsext-error-banner': 'own',
    'data-dbsext-state-forms': 'own',
    'data-dbsext-table-columns': 'own',
    'data-dbsext-action-toggle': 'own',
    'data-dbsext-sort': 'own',
    'data-dbsext-filter': 'own',
    'data-dbsext-collapse-hint': 'own',
    'data-dbsext-top-scrollbar': 'own',        // 見出しの上に置く横スクロールバー
    'data-dbsext-top-scrollbar-inner': 'own',  // その中身（幅合わせ用）
    'data-dbsext-synced': 'own',               // 同期の登録済み印（自前要素に付く）
    'data-dbsext-beacons-panel': 'own',
    'data-dbsext-beacons-native-modal': 'own',
    'data-dbsext-beacons-area': 'own',
    'data-dbsext-beacons-link': 'own',
    'data-dbsext-beacons-link-a': 'own',
    'data-dbsext-beacons-btn': 'own',
    'data-dbsext-beacons-table': 'own',
    'data-dbsext-beacons-status': 'own',

    // --- ポータル要素に付けた目印（自前UIではない） ---
    'data-dbsext-tabled': 'mark',      // table-tools が .el-table に付ける
    'data-dbsext-wrap': 'mark',        // table-wrap が .el-table に付ける
    'data-dbsext-orig-title': 'mark',  // table-tools が th に控える元の列名
    'data-dbsext-orig-width': 'mark',        // table-columns が col に控える元の幅
    'data-dbsext-orig-table-width': 'mark',  // table-columns が表に控える元の幅
    'data-dbsext-newtab': 'mark',      // ui-tweaks が一覧の a に付ける処理済み印
    'data-dbsext-collapsed': 'mark'    // ui-tweaks が折りたたみ見出しに付ける処理済み印
  };

  function hasOwnAttribute(node) {
    if (!node || node.nodeType !== 1 || !node.attributes) return false;
    for (var i = 0; i < node.attributes.length; i++) {
      var name = node.attributes[i].name;
      // 末尾のハイフンが要る。`data-dbsext`(bodyのマーカー)は自前UIではない
      if (name.indexOf('data-dbsext-') !== 0) continue;
      // ポータル要素に付けた目印は「自前UIである」根拠にならない
      if (ATTR_KIND[name] === 'mark') continue;
      return true;
    }
    return false;
  }

  /** その要素が自前UIの一部か。祖先は自前UIのホストまでしか遡らない。 */
  function isOwnUi(node) {
    if (!node || node.nodeType !== 1) return false;
    if (hasOwnAttribute(node)) return true;
    return typeof node.closest === 'function' && !!node.closest(OWN_UI_SELECTOR);
  }

  /** その変化が自分の仕業か。追加・削除されたノードが全部自前UIなら自分の仕業とみなす。 */
  /**
   * Vue がポータル側の親要素から拡張UIのルートだけを外した場合は外部変化。
   * 拡張自身の同期DOM操作は runSuppressed() が takeRecords() で捨てるため、
   * ここで無視すると、消されたパネルやメニューを再適用できなくなる。
   */
  function isExternallyRemovedOwnRoot(mutation) {
    if (!mutation || isOwnUi(mutation.target)) return false;
    var removed = mutation.removedNodes || [];
    for (var i = 0; i < removed.length; i++) {
      var node = removed[i];
      if (!node || node.nodeType !== 1 || typeof node.hasAttribute !== 'function') continue;
      if (node.hasAttribute('data-dbsext-beacons-panel') ||
          node.hasAttribute('data-dbsext-beacons-link')) {
        return true;
      }
    }
    return false;
  }
  function isOwnMutation(mutation) {
    if (isExternallyRemovedOwnRoot(mutation)) return false;
    if (isOwnUi(mutation.target)) return true;
    var added = mutation.addedNodes || [];
    var removed = mutation.removedNodes || [];
    if (added.length === 0 && removed.length === 0) return false;

    // **要素ノードを1つも見なかったときに「自分の仕業」と言ってはいけない。**
    // テキストノードだけが差し替わる変化（ポータルが textContent を更新した等）は
    // 外部の変化である。ここで true を返すと、その変化を契機にした再適用が走らない。
    var sawElement = false;
    for (var i = 0; i < added.length; i++) {
      if (added[i].nodeType !== 1) continue;
      sawElement = true;
      if (!isOwnUi(added[i])) return false;
    }
    for (var j = 0; j < removed.length; j++) {
      if (removed[j].nodeType !== 1) continue;
      sawElement = true;
      if (!isOwnUi(removed[j])) return false;
    }
    return sawElement;
  }

  /**
   * 自前のDOM操作を包む。
   * 操作中に発生した変化は takeRecords() で捨て、監視ループに戻さない。
   * これが無いと table-tools の並べ替えが自分自身を再発火させ続ける。
   */
  function runSuppressed(name, fn) {
    applying++;
    try {
      fn();
    } catch (e) {
      D.core.log(name + ' エラー: ' + (e && e.message ? e.message : e), true);
    } finally {
      if (observer && typeof observer.takeRecords === 'function') {
        observer.takeRecords();
      }
      applying--;
    }
  }

  D.core = {
    /**
     * 統一ログ出力
     * @param {string} message ログメッセージ
     * @param {boolean} [isError] エラーまたは警告の場合はtrue
     */
    log: function (message, isError) {
      var formatted = '[dbsext] ' + message;
      if (isError) {
        console.warn(formatted);
      } else {
        console.log(formatted);
      }
    },

    /**
     * すでに拡張が適用済みか確認
     * @returns {boolean}
     */
    isApplied: function () {
      if (typeof document === 'undefined' || !document.body) {
        return false;
      }
      return document.body.hasAttribute(D.CONFIG.MARKER_ATTR);
    },

    /**
     * 拡張の起動（冪等）
     */
    boot: function () {
      if (D.core.isApplied()) {
        D.core.log('既に適用済み');
        return;
      }

      if (typeof document !== 'undefined' && document.body) {
        document.body.setAttribute(D.CONFIG.MARKER_ATTR, D.VERSION);
      }

      // 各モジュールの順次適用（失敗しても個別catchで後続を継続）
      var moduleOrder = [
        { name: 'skin', target: function () { return D.skin; } },
        { name: 'stateStore', target: function () { return D.stateStore; } },
        { name: 'stateForms', target: function () { return D.stateForms; } },
        { name: 'netStatus', target: function () { return D.netStatus; } },
        { name: 'tableWrap', target: function () { return D.tableWrap; } },
        { name: 'uiTweaks', target: function () { return D.uiTweaks; } },
        { name: 'upsell', target: function () { return D.upsell; } },
        { name: 'mapLauncher', target: function () { return D.mapLauncher; } },
        { name: 'beacons', target: function () { return D.beacons; } },
        { name: 'tableColumns', target: function () { return D.tableColumns; } },
        { name: 'tableTools', target: function () { return D.tableTools; } }
      ];

      // 先に監視を張ってから適用する。適用中の変化は runSuppressed が捨てる
      D.core.onContentChange(function () {
        if (D.stateForms && typeof D.stateForms.apply === 'function') {
          runSuppressed('stateForms.apply 再適用', function () { D.stateForms.apply(); });
        }
      });
      D.core.onContentChange(function () {
        if (D.netStatus && typeof D.netStatus.apply === 'function') {
          runSuppressed('netStatus.apply 再適用', function () { D.netStatus.apply(); });
        }
      });
      D.core.onContentChange(function () {
        if (D.tableWrap && typeof D.tableWrap.apply === 'function') {
          runSuppressed('tableWrap.apply 再適用', function () { D.tableWrap.apply(); });
        }
      });
      D.core.onContentChange(function () {
        if (D.uiTweaks && typeof D.uiTweaks.apply === 'function') {
          runSuppressed('uiTweaks.apply 再適用', function () { D.uiTweaks.apply(); });
        }
      });
      // body直下の固定要素（消えないはず）だが、冪等なので保険として再適用しておく。
      // 「boot時1回だけ」がボタン消失の原因だったため、同じ落とし穴を残さない。
      D.core.onContentChange(function () {
        if (D.mapLauncher && typeof D.mapLauncher.apply === 'function') {
          runSuppressed('mapLauncher.apply 再適用', function () { D.mapLauncher.apply(); });
        }
        if (D.beacons && typeof D.beacons.apply === 'function') {
          runSuppressed('beacons.apply 再適用', function () { D.beacons.apply(); });
        }
        if (D.upsell && typeof D.upsell.apply === 'function') {
          runSuppressed('upsell.apply 再適用', function () { D.upsell.apply(); });
        }
      });
      D.core.onContentChange(function () {
        if (D.tableColumns && typeof D.tableColumns.apply === 'function') {
          runSuppressed('tableColumns.apply 再適用', function () { D.tableColumns.apply(); });
        }
      });
      D.core.onContentChange(function () {
        if (D.tableTools && typeof D.tableTools.apply === 'function') {
          runSuppressed('tableTools.apply 再適用', function () { D.tableTools.apply(); });
        }
      });

      for (var i = 0; i < moduleOrder.length; i++) {
        var item = moduleOrder[i];
        var mod = item.target();
        if (mod && typeof mod.apply === 'function') {
          (function (name, target) {
            runSuppressed(name + '.apply', function () { target.apply(); });
          })(item.name, mod);
        }
      }
    },

    /**
     * コンテンツ領域の変更監視（200ms デバウンス、自前要素の変化は除外）
     * @param {function} callback
     */
    onContentChange: function (callback) {
      if (typeof callback === 'function') {
        contentCallbacks.push(callback);
      }

      if (observer || typeof MutationObserver === 'undefined' || typeof document === 'undefined' || !document.body) {
        return;
      }

      observer = new MutationObserver(function (mutations) {
        // 自前のDOM操作の最中に来た通知は無視する
        if (applying > 0) {
          return;
        }

        var hasExternalChange = false;
        for (var i = 0; i < mutations.length; i++) {
          if (!isOwnMutation(mutations[i])) {
            hasExternalChange = true;
            break;
          }
        }

        if (!hasExternalChange) {
          return;
        }

        if (debounceTimer) {
          clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(function () {
          debounceTimer = null;
          for (var k = 0; k < contentCallbacks.length; k++) {
            try {
              contentCallbacks[k]();
            } catch (e) {
              D.core.log('onContentChange コールバックエラー: ' + (e && e.message ? e.message : e), true);
            }
          }
        }, 200);
      });

      observer.observe(document.body, { childList: true, subtree: true });
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);


/**
 * DBSEXT 入力状態キャッシュ基盤モジュール
 * localStorage / sessionStorage を用いた状態の安全な保存・復元・管理を担当
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  var SCHEMA_VERSION = 1;
  var KEY_PREFIX = 'dbsext:v' + SCHEMA_VERSION + ':';
  var DEFAULT_TTL_MS = 8 * 60 * 60 * 1000; // 既定は8時間（1営業日想定: 28800000ms）
  var MAX_VALUE_BYTES = 32 * 1024; // 1キーあたり32KB上限

  function getStorage(scope) {
    if (typeof window === 'undefined') return null;
    try {
      if (scope === 'local') {
        return window.localStorage;
      }
      return window.sessionStorage;
    } catch (e) {
      return null;
    }
  }

  /**
   * screen パスの正規化
   * 例: /users/123 -> /users
   */
  function normalizeScreen(screen) {
    if (!screen || typeof screen !== 'string') {
      if (typeof location !== 'undefined' && location.pathname) {
        screen = location.pathname;
      } else {
        screen = '/';
      }
    }
    // 先頭スラッシュを付与
    if (screen.charAt(0) !== '/') {
      screen = '/' + screen;
    }
    // 連続スラッシュを単一化
    screen = screen.replace(/\/+/g, '/');
    // クエリやハッシュを除去
    screen = screen.split('?')[0].split('#')[0];
    // 末尾の数値IDやUUIDセグメントを除去 (/users/123 -> /users)
    screen = screen.replace(/\/([0-9]+|[0-9a-fA-F-]{36})$/, '');
    // 末尾スラッシュ除去（ルート '/' 単体は保持）
    if (screen.length > 1 && screen.charAt(screen.length - 1) === '/') {
      screen = screen.slice(0, -1);
    }
    return screen || '/';
  }

  function buildKey(screen, feature) {
    var normScreen = normalizeScreen(screen);
    return KEY_PREFIX + normScreen + ':' + (feature || '');
  }

  D.stateStore = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    DEFAULT_TTL_MS: DEFAULT_TTL_MS,
    MAX_VALUE_BYTES: MAX_VALUE_BYTES,
    normalizeScreen: normalizeScreen,

    /**
     * 値を保存する
     * @param {string} screen 対象画面パス
     * @param {string} feature 機能・項目名
     * @param {*} value 保存する値
     * @param {Object} [opts] { scope: 'session'|'local', ttlMs: number }
     * @returns {boolean} 保存成功なら true
     */
    save: function (screen, feature, value, opts) {
      opts = opts || {};
      var scope = opts.scope || 'session'; // 既定は session
      var ttlMs = (typeof opts.ttlMs === 'number' && opts.ttlMs > 0) ? opts.ttlMs : DEFAULT_TTL_MS;
      var storage = getStorage(scope);
      if (!storage) return false;

      var key = buildKey(screen, feature);
      var record = {
        v: SCHEMA_VERSION,
        at: Date.now(),
        ttl: ttlMs,
        data: value
      };

      try {
        var json = JSON.stringify(record);
        var size = (typeof Blob !== 'undefined') ? new Blob([json]).size : json.length;
        if (size > MAX_VALUE_BYTES) {
          if (D.core && typeof D.core.log === 'function') {
            D.core.log('stateStore.save: 32KB超過のため保存をスキップしました: ' + key + ' (' + size + ' bytes)', true);
          }
          return false;
        }
        storage.setItem(key, json);
        return true;
      } catch (e) {
        if (D.core && typeof D.core.log === 'function') {
          D.core.log('stateStore.save エラー: ' + (e && e.message ? e.message : e), true);
        }
        return false;
      }
    },

    /**
     * 保存された値を読み出す（期限切れ・版違い・壊れたJSONは null を返し、キーも削除）
     * @param {string} screen 対象画面パス
     * @param {string} feature 機能・項目名
     * @returns {*} 保存された値、または null
     */
    load: function (screen, feature) {
      var key = buildKey(screen, feature);
      var storages = [getStorage('session'), getStorage('local')];

      for (var i = 0; i < storages.length; i++) {
        var storage = storages[i];
        if (!storage) continue;

        try {
          var raw = storage.getItem(key);
          if (raw === null || raw === undefined) continue;

          var obj;
          try {
            obj = JSON.parse(raw);
          } catch (jsonErr) {
            // 壊れたJSONは削除して null
            try { storage.removeItem(key); } catch (e) {}
            continue;
          }

          if (!obj || typeof obj !== 'object') {
            try { storage.removeItem(key); } catch (e) {}
            continue;
          }

          // 版違い判定
          if (obj.v !== SCHEMA_VERSION) {
            try { storage.removeItem(key); } catch (e) {}
            return null;
          }

          // 期限切れ判定
          var now = Date.now();
          var at = typeof obj.at === 'number' ? obj.at : 0;
          var ttl = typeof obj.ttl === 'number' ? obj.ttl : DEFAULT_TTL_MS;
          if (now > at + ttl) {
            try { storage.removeItem(key); } catch (e) {}
            return null;
          }

          return obj.data;
        } catch (e) {
          // ストレージ例外時は null
          return null;
        }
      }
      return null;
    },

    /**
     * 特定の画面・項目の保存内容を削除する
     */
    clear: function (screen, feature) {
      var key = buildKey(screen, feature);
      var storages = [getStorage('session'), getStorage('local')];
      for (var i = 0; i < storages.length; i++) {
        var storage = storages[i];
        if (!storage) continue;
        try {
          storage.removeItem(key);
        } catch (e) {}
      }
    },

    /**
     * dbsext: で始まるすべてのキーを削除する（他人のキーは消さない）
     */
    clearAll: function () {
      var storages = [getStorage('session'), getStorage('local')];
      for (var i = 0; i < storages.length; i++) {
        var storage = storages[i];
        if (!storage) continue;
        try {
          var keysToRemove = [];
          for (var j = 0; j < storage.length; j++) {
            var k = storage.key(j);
            if (k && k.indexOf('dbsext:') === 0) {
              keysToRemove.push(k);
            }
          }
          for (var m = 0; m < keysToRemove.length; m++) {
            storage.removeItem(keysToRemove[m]);
          }
        } catch (e) {}
      }
    },

    /**
     * 保存されている dbsext:* の全一覧を返す
     * @returns {Array<Object>}
     */
    list: function () {
      var result = [];
      var storages = [
        { name: 'session', store: getStorage('session') },
        { name: 'local', store: getStorage('local') }
      ];

      for (var i = 0; i < storages.length; i++) {
        var item = storages[i];
        var storage = item.store;
        if (!storage) continue;
        try {
          for (var j = 0; j < storage.length; j++) {
            var key = storage.key(j);
            if (key && key.indexOf('dbsext:') === 0) {
              var raw = storage.getItem(key);
              var parsed = null;
              try {
                parsed = JSON.parse(raw);
              } catch (e) {}

              var parts = key.split(':');
              var screen = parts[2] || '';
              var feature = parts.slice(3).join(':');

              result.push({
                storage: item.name,
                key: key,
                screen: screen,
                feature: feature,
                v: parsed && parsed.v !== undefined ? parsed.v : null,
                at: parsed && parsed.at !== undefined ? parsed.at : null,
                ttl: parsed && parsed.ttl !== undefined ? parsed.ttl : null,
                data: parsed && parsed.data !== undefined ? parsed.data : null
              });
            }
          }
        } catch (e) {}
      }
      return result;
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);


/**
 * DBSEXT 画面入力宣言表・復元モジュール
 * 各画面の宣言に基づき、エリア選択などの入力状態の自動適用と安全弁UIを提供する
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  var appliedInTab = false;
  var DIALOG_MAX_ATTEMPTS = 30; // 30回 × 50ms = 1.5秒
  var NOTICE_ATTR = 'data-dbsext-state-forms';

  /**
   * ヘッダのエリア選択トリガー要素を取得
   */
  // エリア表示の文言。実測では `エリア未選択` / `6エリア選択中` の2形。
  // **単に「エリア」を含むかで探してはいけない。**
  // サイドバーのメニュー項目 `エリア情報` も `.cursor-pointer` を持っており
  // （実測DOM。`tests/fixtures/mock-portal.html` 参照）、そちらを掴むと
  // **クリックで `/areas` へ画面遷移してしまう**。
  var AREA_LABEL_RE = /エリア(未選択|選択中)/;

  function getHeaderAreaElement() {
    if (typeof document === 'undefined') return null;

    // 1. 実測で確定している具体的なセレクタを最優先で試す
    var exact = document.querySelector('p.col-span-3.cursor-pointer.text-right');
    if (exact && AREA_LABEL_RE.test(exact.textContent || '')) return exact;

    // 2. 退避: 文言が一致するものだけを候補にする。
    //    さらに**リンクを含む/リンクである要素は除く**（メニュー項目は必ず a を持つ）。
    //    候補が複数あるときは、**最も文字数の少ないもの**を採る。
    //    ヘッダ全体を包む大きな div も文言を含んでしまうため、
    //    「最も内側＝最も短い」ものが目的の要素になる。
    var candidates = document.querySelectorAll('.cursor-pointer');
    var best = null;
    var bestLen = Infinity;
    for (var i = 0; i < candidates.length; i++) {
      var el = candidates[i];
      var text = (el.textContent || '').trim();
      if (!AREA_LABEL_RE.test(text)) continue;
      if (el.tagName === 'A') continue;
      if (typeof el.querySelector === 'function' && el.querySelector('a[href]')) continue;
      if (text.length < bestLen) {
        bestLen = text.length;
        best = el;
      }
    }
    return best;
  }

  /**
   * 現在開いているエリア選択ダイアログを取得
   */
  function getVisibleAreaDialog() {
    if (typeof document === 'undefined') return null;
    var dialogs = document.querySelectorAll('[role="dialog"], .el-dialog');
    for (var i = 0; i < dialogs.length; i++) {
      var d = dialogs[i];
      if ((d.textContent || '').indexOf('エリア選択') < 0) continue;
      if (isHiddenElement(d)) continue;
      return d;
    }
    return null;
  }

  /**
   * 隠れている要素か。
   *
   * **ここを緩くしてはいけない。** Element Plus は閉じたダイアログを
   * DOM に残したまま親を `display:none` にする。隠れたダイアログを
   * 「開いている」と誤認すると、**見えていないダイアログのチェックボックスを操作して
   * 「選択」まで押してしまう**（＝利用者の意図しない表示範囲が適用される）。
   */
  function isHiddenElement(el) {
    // 祖先を辿る。`nodeType` の有無に依存しない（親が無くなったら終わり）
    for (var node = el; node; node = node.parentElement) {
      var style = node.style;
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return true;
      if (typeof getComputedStyle === 'function') {
        var cs = getComputedStyle(node);
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return true;
      }
    }
    // レイアウトを持たない＝画面に出ていない（position:fixed は offsetParent が null になるため除く）
    if (typeof el.getBoundingClientRect === 'function') {
      var rect = el.getBoundingClientRect();
      if (rect && rect.width === 0 && rect.height === 0) return true;
    }
    return false;
  }

  /**
   * ダイアログ内でチェックされているエリア名の一覧を取得
   */
  function getCheckedAreaNamesFromDialog(dialog) {
    var names = [];
    if (!dialog) return names;
    var checkboxes = dialog.querySelectorAll('.el-checkbox');
    for (var i = 0; i < checkboxes.length; i++) {
      var cb = checkboxes[i];
      var label = (cb.querySelector('.el-checkbox__label') || cb).textContent.trim();
      if (label === 'すべて選択' || !label) continue;

      var isChecked = cb.classList.contains('is-checked');
      var input = cb.querySelector('input[type="checkbox"]');
      if (input && input.checked) {
        isChecked = true;
      }
      if (isChecked) {
        names.push(label);
      }
    }
    return names;
  }

  /**
   * 通知UIを削除する
   */
  function removeNoticeUI() {
    if (typeof document === 'undefined') return;
    var notices = document.querySelectorAll('[' + NOTICE_ATTR + ']');
    for (var i = 0; i < notices.length; i++) {
      if (notices[i].parentNode) {
        notices[i].parentNode.removeChild(notices[i]); // dbsext:own-ui
      }
    }
  }

  /**
   * 自動適用完了時の通知バーを表示（安全弁 2 & 3）
   */
  function showAutoAppliedNotice(areaNames) {
    if (typeof document === 'undefined' || !document.body) return;
    removeNoticeUI();

    var namesStr = Array.isArray(areaNames) ? areaNames.join(', ') : String(areaNames);

    var container = document.createElement('div');
    container.setAttribute(NOTICE_ATTR, '1');
    // **画面の右上に出す。**
    // 以前は左下（bottom:12px; left:300px）に出していたが、
    // 表や操作の邪魔になると指摘された。右上は情報の通知に使われる定位置で、
    // 表本体にもサイドバーにも重ならない。
    container.style.cssText = [
      'position: fixed',
      'top: 8px',
      'right: 8px',
      'max-width: 40vw',
      'z-index: 2147482990',
      'background-color: #0b5cab',
      'color: #ffffff',
      'padding: 8px 14px',
      'border-radius: 6px',
      'box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25)',
      'font-size: 12px',
      'display: flex',
      'align-items: center',
      'gap: 12px',
      'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
    ].join(';');

    var textSpan = document.createElement('span');
    textSpan.className = 'dbsext-state-notice-text';
    textSpan.textContent = 'エリアを自動で選択しました: ' + namesStr;
    container.appendChild(textSpan);

    // 「エリアを選び直す」ボタン
    var reselectBtn = document.createElement('button');
    reselectBtn.type = 'button';
    reselectBtn.className = 'dbsext-state-reselect-btn';
    reselectBtn.textContent = 'エリアを選び直す';
    reselectBtn.style.cssText = [
      'background: #ffffff',
      'color: #083f75',
      'border: none',
      'border-radius: 4px',
      'padding: 4px 8px',
      'font-size: 11px',
      'font-weight: bold',
      'cursor: pointer'
    ].join(';');
    reselectBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var headerArea = getHeaderAreaElement();
      if (headerArea) {
        headerArea.click();
      }
      removeNoticeUI();
    });
    container.appendChild(reselectBtn);

    // 閉じるボタン
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = [
      'background: none',
      'border: none',
      'color: #ffffff',
      'font-size: 12px',
      'cursor: pointer',
      'padding: 0 4px'
    ].join(';');
    closeBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      removeNoticeUI();
    });
    container.appendChild(closeBtn);

    document.body.appendChild(container);
  }

  /**
   * エリア選択ダイアログを自動操作して保存エリアを適用する
   */
  function restoreAreaSelection(targetAreaNames, callback) {
    if (!targetAreaNames || !Array.isArray(targetAreaNames) || targetAreaNames.length === 0) {
      if (typeof callback === 'function') callback(false);
      return;
    }

    var headerArea = getHeaderAreaElement();
    if (!headerArea) {
      if (typeof callback === 'function') callback(false);
      return;
    }

    // 1. ヘッダのエリア要素をクリックしてダイアログを開く
    headerArea.click();

    // 2. 再帰 setTimeout でダイアログの出現を待つ（上限回数を設定）
    var attempts = 0;
    function pollDialog() {
      attempts++;
      var dialog = getVisibleAreaDialog();
      if (dialog) {
        applyCheckboxesAndSelect(dialog, targetAreaNames, callback);
      } else if (attempts < DIALOG_MAX_ATTEMPTS) {
        setTimeout(pollDialog, 50);
      } else {
        if (typeof callback === 'function') callback(false);
      }
    }

    setTimeout(pollDialog, 50);
  }

  /**
   * ダイアログ内のチェックボックスをクリック操作し、「選択」ボタンを押す
   */
  function applyCheckboxesAndSelect(dialog, targetAreaNames, callback) {
    var checkboxes = dialog.querySelectorAll('.el-checkbox');
    var targetSet = {};
    for (var k = 0; k < targetAreaNames.length; k++) {
      targetSet[targetAreaNames[k]] = true;
    }

    // **保存したエリアが今のダイアログに何件あるかを数える。**
    // 権限エリアの変更やエリア名の改称で、保存値が現在の選択肢に無いことがある。
    // 1件も一致しないまま「選択」を押すと、**空の選択が適用されたうえで
    // 「自動で選択しました」と表示される**（＝静かな不一致）。
    var matched = [];

    for (var i = 0; i < checkboxes.length; i++) {
      var cb = checkboxes[i];
      var label = (cb.querySelector('.el-checkbox__label') || cb).textContent.trim();
      if (label === 'すべて選択' || !label) continue;

      var isChecked = cb.classList.contains('is-checked');
      var input = cb.querySelector('input[type="checkbox"]');
      if (input && input.checked) {
        isChecked = true;
      }

      var shouldBeChecked = !!targetSet[label];
      if (shouldBeChecked) matched.push(label);
      if (shouldBeChecked !== isChecked) {
        // ネイティブ click() で Element Plus の状態を更新
        cb.click();
      }
    }

    // 1件も一致しないなら**何も適用せずに諦める**。
    // 中途半端に適用して成功を名乗るより、黙って元のまま（＝エリア未選択）の方が安全。
    if (matched.length === 0) {
      if (D.core && typeof D.core.log === 'function') {
        D.core.log('エリアの自動適用を中止: 保存したエリアが現在の選択肢に無い', true);
      }
      if (typeof callback === 'function') callback(false);
      return;
    }

    // 4. 「選択」ボタンをクリック（invisible クラスが無いもの）
    var buttons = dialog.querySelectorAll('button');
    var selectBtn = null;
    for (var j = 0; j < buttons.length; j++) {
      var btn = buttons[j];
      var text = (btn.textContent || '').trim();
      if (text === '選択' && !btn.classList.contains('invisible') && btn.style.display !== 'none') {
        selectBtn = btn;
        break;
      }
    }

    if (selectBtn) {
      selectBtn.click();
      // **実際に適用できた分だけを表示する。** 保存値をそのまま並べると、
      // 一部しか一致していないときに利用者が見ている範囲を誤認する。
      showAutoAppliedNotice(matched);
      if (typeof callback === 'function') callback(true);
    } else {
      if (typeof callback === 'function') callback(false);
    }
  }

  // ユーザー自身の手動操作でエリアが選択されたときのキャプチャ監視
  function attachManualCaptureListener() {
    if (typeof document === 'undefined') return;
    if (document.__dbsext_state_forms_listener) return;
    document.__dbsext_state_forms_listener = true;

    document.addEventListener('click', function (e) {
      var target = e.target;
      if (!target) return;
      var btn = (typeof target.closest === 'function') ? target.closest('button') : null;
      if (!btn && target.tagName === 'BUTTON') {
        btn = target;
      }
      if (!btn) return;

      var text = (btn.textContent || '').trim();
      if (text === '選択') {
        var dialog = (typeof btn.closest === 'function') ? btn.closest('[role="dialog"], .el-dialog') : null;
        if (!dialog) {
          dialog = getVisibleAreaDialog();
        }
        if (dialog && (dialog.textContent || '').indexOf('エリア選択') >= 0) {
          var names = getCheckedAreaNamesFromDialog(dialog);
          if (!D.stateStore) return;

          if (names && names.length > 0) {
            if (typeof D.stateStore.save === 'function') {
              D.stateStore.save('/', 'areaSelection', names, { scope: 'local' });
            }
          } else if (typeof D.stateStore.clear === 'function') {
            // **チェックを全部外して「選択」を押した＝「エリアなし」という明示の意思表示。**
            // ここで保存値を消さないと、次回の起動で拡張が古いエリアを
            // 自動適用し、**利用者が自分で解除したはずの範囲が黙って戻る**。
            // 利用者の明示的な操作を、拡張が後から打ち消してはいけない。
            D.stateStore.clear('/', 'areaSelection');
            if (D.core && typeof D.core.log === 'function') {
              D.core.log('エリアが全解除されたため、保存していたエリアを消去した');
            }
          }
          // 自動適用中でなくても、利用者が自分で選び直したら通知は用済み
          removeNoticeUI();
        }
      }
    }, true);
  }

  D.stateForms = {
    DECLARATIONS: [
      {
        screen: '/',
        feature: 'areaSelection',
        scope: 'local',
        label: 'エリア選択',
        capture: function () {
          var dialog = getVisibleAreaDialog();
          if (dialog) {
            return getCheckedAreaNamesFromDialog(dialog);
          }
          if (D.stateStore && typeof D.stateStore.load === 'function') {
            return D.stateStore.load('/', 'areaSelection');
          }
          return null;
        },
        restore: function (value, callback) {
          restoreAreaSelection(value, callback);
        }
      }
    ],

    /**
     * 自動適用（安全弁チェック付き）
     */
    apply: function () {
      attachManualCaptureListener();

      // 安全弁 1: 同じタブで二度自動適用しない
      if (appliedInTab) {
        return;
      }

      // 安全弁 2: 保存されたエリアがあるか（初回は自動適用しない）
      if (!D.stateStore || typeof D.stateStore.load !== 'function') {
        return;
      }
      var savedAreas = D.stateStore.load('/', 'areaSelection');
      if (!savedAreas || !Array.isArray(savedAreas) || savedAreas.length === 0) {
        return;
      }

      // 安全弁 3: 現在のヘッダが「エリア未選択」である（すでに選ばれているなら触らない）
      var headerArea = getHeaderAreaElement();
      if (!headerArea) {
        return;
      }
      var headerText = (headerArea.textContent || '').trim();
      if (headerText.indexOf('エリア未選択') === -1) {
        return;
      }

      // 条件をすべて満たしたため自動適用を実施
      appliedInTab = true;
      restoreAreaSelection(savedAreas);
    },

    _hasAppliedInTab: function () {
      return appliedInTab;
    },
    _resetAppliedInTab: function () {
      appliedInTab = false;
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);


/**
 * DBSEXT 通信ステータスモジュール
 * 通信監視、読み込み中マスク表示、エラー・セッション切れ通知を担当
 *
 * ---------------------------------------------------------------------------
 * **既知の制約: Chrome拡張版（β）およびリモート配信版（USER_SCRIPT world）では、この機能はポータルの通信を捉えられない。**
 *
 * content script および user script は隔離ワールド（ISOLATED / USER_SCRIPT）で動くため、ここで差し替えるのは
 * 「隔離ワールドの `window.fetch` / `XMLHttpRequest`」であって、
 * ポータル本体（Nuxt）が呼ぶ MAIN ワールドの同名APIではない。
 * したがって β（拡張版・リモート配信版）では読み込み中マスク・通信エラー・セッション切れが**出ない**。
 *
 * **ブックマークレット版（α）はページのメインワールドで動くため、正しく機能する。**
 * 現在の配布の主軸は α なので、当面はこの制約を受け入れる。
 *
 * β で有効にするには `manifest.json` の content_scripts を2つに分ける必要がある:
 *   - 隔離ワールド: platform-extension.js（`chrome.*` を使うため MAIN では動かない）
 *   - MAIN ワールド: net-status.js（`"world": "MAIN"` を指定）
 * ただし両ワールドで `DBSEXT` 名前空間が別々になるため、
 * boot の流れと状態の持ち方を設計し直す必要がある。**安易に world を足さないこと。**
 *
 * 出典: 独立監査 T-20260808-AUDIT 指摘5 / T-20260809-REMOTE-AUDIT R-07。HANDOFF.md にも記録済み。
 * ---------------------------------------------------------------------------
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  var LOADING_DELAY_MS = 250;
  var OVERLAY_ATTR = 'data-dbsext-loading-mask';
  var TOP_INDICATOR_ATTR = 'data-dbsext-top-indicator';
  var BANNER_ATTR = 'data-dbsext-error-banner';
  var HOST_ATTR = 'data-dbsext-net-status';

  var activeRequests = 0;
  var silentDepth = 0;
  var delayTimer = null;
  var elapsedTimer = null;
  var requestStartTime = 0;
  var isMaskVisible = false;

  function updateLoadingText(elapsedSec) {
    var text = '読み込み中…';
    if (elapsedSec >= 1) {
      text = '読み込み中… ' + elapsedSec + '秒';
    }

    if (typeof document === 'undefined') return;

    var texts = document.querySelectorAll('[' + HOST_ATTR + '] .dbsext-loading-text');
    for (var i = 0; i < texts.length; i++) {
      texts[i].textContent = text;
    }
  }

  function scheduleElapsedTimer() {
    if (elapsedTimer) {
      clearTimeout(elapsedTimer);
      elapsedTimer = null;
    }
    elapsedTimer = setTimeout(function () {
      elapsedTimer = null;
      if (activeRequests > 0) {
        var elapsedSec = Math.floor((Date.now() - requestStartTime) / 1000);
        updateLoadingText(elapsedSec);
        scheduleElapsedTimer();
      }
    }, 500);
  }

  function createTableOverlay() {
    var overlay = document.createElement('div');
    overlay.setAttribute(OVERLAY_ATTR, '1');
    overlay.setAttribute(HOST_ATTR, '1');
    overlay.style.cssText = [
      'position: absolute',
      'top: 0',
      'left: 0',
      'width: 100%',
      'height: 100%',
      'min-height: 80px',
      'background-color: rgba(255, 255, 255, 0.75)',
      'z-index: 2000',
      'display: flex',
      'flex-direction: column',
      'align-items: center',
      'justify-content: center',
      'pointer-events: auto'
    ].join(';');

    var content = document.createElement('div');
    content.style.cssText = [
      'background: rgba(0, 0, 0, 0.75)',
      'color: #ffffff',
      'padding: 8px 16px',
      'border-radius: 4px',
      'font-size: 13px',
      'font-weight: bold',
      'display: flex',
      'align-items: center',
      'gap: 8px',
      'box-shadow: 0 2px 8px rgba(0,0,0,0.2)'
    ].join(';');

    var textSpan = document.createElement('span');
    textSpan.className = 'dbsext-loading-text';
    textSpan.textContent = '読み込み中…';

    content.appendChild(textSpan);
    overlay.appendChild(content);
    return overlay;
  }

  function createTopIndicator() {
    var indicator = document.createElement('div');
    indicator.setAttribute(TOP_INDICATOR_ATTR, '1');
    indicator.setAttribute(HOST_ATTR, '1');
    indicator.style.cssText = [
      'position: fixed',
      'top: 12px',
      'right: 12px',
      'z-index: 2147483000',
      'background: rgba(0, 0, 0, 0.75)',
      'color: #ffffff',
      'padding: 6px 12px',
      'border-radius: 4px',
      'font-size: 12px',
      'font-weight: bold',
      'box-shadow: 0 2px 8px rgba(0,0,0,0.2)',
      'pointer-events: none'
    ].join(';');

    var textSpan = document.createElement('span');
    textSpan.className = 'dbsext-loading-text';
    textSpan.textContent = '読み込み中…';

    indicator.appendChild(textSpan);
    return indicator;
  }

  function renderMask() {
    if (typeof document === 'undefined' || !document.body) return;

    var tables = document.querySelectorAll('.el-table');
    if (tables && tables.length > 0) {
      for (var i = 0; i < tables.length; i++) {
        var table = tables[i];
        if (!table.querySelector('[' + OVERLAY_ATTR + ']')) {
          var position = (typeof window !== 'undefined' && window.getComputedStyle) ? window.getComputedStyle(table).position : table.style.position;
          if (position !== 'relative' && position !== 'absolute' && position !== 'fixed') {
            table.style.position = 'relative';
          }
          table.appendChild(createTableOverlay());
        }
      }
    } else {
      if (!document.querySelector('[' + TOP_INDICATOR_ATTR + ']')) {
        document.body.appendChild(createTopIndicator());
      }
    }
  }

  function showLoadingUI() {
    isMaskVisible = true;
    renderMask();
    var elapsedSec = Math.floor((Date.now() - requestStartTime) / 1000);
    updateLoadingText(elapsedSec);
  }

  function hideLoadingUI() {
    isMaskVisible = false;
    if (delayTimer) {
      clearTimeout(delayTimer);
      delayTimer = null;
    }
    if (elapsedTimer) {
      clearTimeout(elapsedTimer);
      elapsedTimer = null;
    }

    if (typeof document === 'undefined' || !document.body) return;

    var overlays = document.querySelectorAll('[' + OVERLAY_ATTR + ']');
    for (var i = 0; i < overlays.length; i++) {
      if (overlays[i].parentNode) {
        overlays[i].parentNode.removeChild(overlays[i]); // dbsext:own-ui
      }
    }

    var indicators = document.querySelectorAll('[' + TOP_INDICATOR_ATTR + ']');
    for (var j = 0; j < indicators.length; j++) {
      if (indicators[j].parentNode) {
        indicators[j].parentNode.removeChild(indicators[j]); // dbsext:own-ui
      }
    }
  }

  function onRequestStart() {
    activeRequests++;
    if (activeRequests === 1) {
      requestStartTime = Date.now();
      if (delayTimer) clearTimeout(delayTimer);
      delayTimer = setTimeout(function () {
        delayTimer = null;
        if (activeRequests > 0) {
          showLoadingUI();
          scheduleElapsedTimer();
        }
      }, LOADING_DELAY_MS);
    }
  }

  function onRequestEnd() {
    activeRequests = Math.max(0, activeRequests - 1);
    if (activeRequests === 0) {
      hideLoadingUI();
    }
  }

  function showBanner(message, isAuthError) {
    if (typeof document === 'undefined' || !document.body) return;

    // 既存バナーがあれば更新（同時に1枚まで）
    var existing = document.querySelector('[' + BANNER_ATTR + ']');
    if (existing) {
      var msgSpan = existing.querySelector('.dbsext-banner-text');
      if (msgSpan) msgSpan.textContent = message;
      existing.style.backgroundColor = isAuthError ? '#c0392b' : '#d9534f';
      return;
    }

    var banner = document.createElement('div');
    banner.setAttribute(BANNER_ATTR, '1');
    banner.setAttribute(HOST_ATTR, '1');
    banner.style.cssText = [
      'position: fixed',
      'top: 12px',
      'left: 50%',
      'transform: translateX(-50%)',
      'z-index: 2147483001',
      'background-color: ' + (isAuthError ? '#c0392b' : '#d9534f'),
      'color: #ffffff',
      'padding: 8px 16px',
      'border-radius: 6px',
      'font-size: 13px',
      'font-weight: bold',
      'box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25)',
      'display: flex',
      'align-items: center',
      'gap: 12px'
    ].join(';');

    var textSpan = document.createElement('span');
    textSpan.className = 'dbsext-banner-text';
    textSpan.textContent = message;
    banner.appendChild(textSpan);

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = [
      'background: none',
      'border: none',
      'color: #ffffff',
      'font-size: 14px',
      'font-weight: bold',
      'cursor: pointer',
      'padding: 0 4px',
      'line-height: 1'
    ].join(';');
    closeBtn.addEventListener('click', function () {
      if (banner.parentNode) {
        banner.parentNode.removeChild(banner); // dbsext:own-ui
      }
    });
    banner.appendChild(closeBtn);

    document.body.appendChild(banner);
  }

  function handleResponseStatus(status) {
    if (status === 401 || status === 403) {
      showBanner('ログインが切れました。再度ログインしてください', true);
    } else if (status >= 400) {
      showBanner('通信に失敗しました（HTTP ' + status + '）。再読込してください', false);
    }
  }

  function handleGenericError() {
    showBanner('通信に失敗しました。再読込してください', false);
  }

  /**
   * 中断されただけの通信か。
   *
   * ポータルは「同じエンドポイントへ新しい要求が来たら古い方を中断する」作りになっており、
   * 画面を操作しているだけで AbortError が日常的に発生する。**これは異常ではない。**
   * 利用者が中断した場合（画面遷移など）も同じ。**どちらも警告を出してはいけない。**
   */
  function isAbortError(err) {
    if (!err) return false;
    if (err.name === 'AbortError') return true;
    // 環境によっては DOMException の code だけが手がかりになる
    return err.code === 20;
  }

  function wrapFetch() {
    if (typeof window === 'undefined' || !window.fetch) return;
    if (window.fetch.__dbsext_wrapped) return;

    var origFetch = window.fetch;
    var newFetch = function (input, init) {
      var isSilent = silentDepth > 0;
      if (!isSilent) {
        onRequestStart();
      }

      var promise;
      try {
        promise = origFetch.apply(this, arguments);
      } catch (err) {
        if (!isSilent) {
          onRequestEnd();
          handleGenericError();
        }
        throw err;
      }

      return promise.then(
        function (res) {
          if (!isSilent) {
            onRequestEnd();
            if (res && !res.ok) {
              handleResponseStatus(res.status);
            }
          }
          return res;
        },
        function (err) {
          if (!isSilent) {
            onRequestEnd();
            // **中断は失敗ではない。**
            // ポータルは同じエンドポイントへの重複リクエストを意図的に中断する
            // （実測: AbortError「Request aborted as another request to the same
            //   endpoint was initiated.」が /api/auth/me や /api/areas で常時発生）。
            // これを失敗として扱うと、通信が正常でも
            // **「通信に失敗しました」が出っぱなしになる**（現場から報告された不具合）。
            // XHR 側では abort を除外していたのに、fetch 側で同じ誤りを残していた。
            if (!isAbortError(err)) handleGenericError();
          }
          return Promise.reject(err);
        }
      );
    };

    newFetch.__dbsext_wrapped = true;
    window.fetch = newFetch;
  }

  function wrapXHR() {
    if (typeof XMLHttpRequest === 'undefined' || !XMLHttpRequest.prototype || !XMLHttpRequest.prototype.send) return;
    if (XMLHttpRequest.prototype.send.__dbsext_wrapped) return;

    var origSend = XMLHttpRequest.prototype.send;
    var newSend = function () {
      var xhr = this;
      var isSilent = silentDepth > 0;

      if (!isSilent) {
        onRequestStart();
        // 通信そのものが失敗した場合（回線断・タイムアウト）。
        // **`status === 0` で判定してはいけない。** abort も 0 になるため、
        // ポータルが遷移時にリクエストを中断しただけで
        // 「通信に失敗しました」と出てしまう。`error` / `timeout` だけを拾う。
        var failed = false;
        var onFail = function () { failed = true; };
        xhr.addEventListener('error', onFail);
        xhr.addEventListener('timeout', onFail);

        var onEnd = function () {
          xhr.removeEventListener('loadend', onEnd);
          xhr.removeEventListener('error', onFail);
          xhr.removeEventListener('timeout', onFail);
          onRequestEnd();
          var status = xhr.status;
          if (status === 401 || status === 403) {
            showBanner('ログインが切れました。再度ログインしてください', true);
          } else if (status >= 400) {
            showBanner('通信に失敗しました（HTTP ' + status + '）。再読込してください', false);
          } else if (failed) {
            handleGenericError();
          }
        };
        xhr.addEventListener('loadend', onEnd);

        // **send() が同期的に例外を投げる場合がある**（InvalidStateError など）。
        // そのとき loadend は一度も来ないため、ここで戻さないと
        // カウンタが増えたまま戻らず、**マスクが永久に出っぱなしになる**。
        try {
          return origSend.apply(this, arguments);
        } catch (err) {
          xhr.removeEventListener('loadend', onEnd);
          onRequestEnd();
          handleGenericError();
          throw err;   // ポータルの挙動を変えないよう、例外はそのまま通す
        }
      }

      return origSend.apply(this, arguments);
    };

    newSend.__dbsext_wrapped = true;
    XMLHttpRequest.prototype.send = newSend;
  }

  D.netStatus = {
    LOADING_DELAY_MS: LOADING_DELAY_MS,

    apply: function () {
      wrapFetch();
      wrapXHR();

      if (isMaskVisible && activeRequests > 0) {
        renderMask();
      }
    },

    silent: function (fn) {
      if (typeof fn !== 'function') return;
      silentDepth++;
      try {
        return fn();
      } finally {
        silentDepth--;
      }
    },

    _getActiveRequests: function () {
      return activeRequests;
    },
    _isMaskVisible: function () {
      return isMaskVisible;
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);


/**
 * DBSEXT スキンモジュール
 * 赤色ベースの標準ポータルテーマを拡張適用中の青色テーマへ変更し、
 * コントラスト改善（案A）、日本語フォント明示（案B）、サイドバー縮小（案C）、
 * 行の視認性向上（案E）、先頭列固定（案3）のCSSを document.head の1枚の <style> に集約する。
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  /**
   * WCAG 2.1 AA コントラスト比検証用の宣言表
   * テスト（test_skin_contrast.js）で機械照合する
   */
  var CONTRAST_PAIRS = [
    { name: '表ヘッダ', fg: '#2f3438', bg: '#d9d9d9' },
    { name: 'データなし', fg: '#5a5e66', bg: '#ffffff' },
    { name: '見出し（画面タイトル）', fg: '#303133', bg: '#ffffff' }
  ];

  D.skin = {
    styleId: 'dbsext-skin',
    CONTRAST_PAIRS: CONTRAST_PAIRS,

    /**
     * テーマスタイルを document.head に挿入する（冪等）
     */
    apply: function () {
      if (typeof document === 'undefined' || !document.head) {
        return;
      }

      if (document.getElementById(D.skin.styleId)) {
        return;
      }

      var accent = (D.CONFIG && D.CONFIG.ACCENT) ? D.CONFIG.ACCENT : '#0b5cab';

      var css = [
        ':root {',
        '  --primary: ' + accent + ' !important;',
        '  --el-color-text: ' + accent + ' !important;',
        '  --el-color-primary-hover: ' + accent + ' !important;',
        '  font-family: "BIZ UDPGothic", "Meiryo", "Yu Gothic UI", system-ui, sans-serif !important;',
        '}',
        '',
        'body {',
        '  font-family: "BIZ UDPGothic", "Meiryo", "Yu Gothic UI", system-ui, sans-serif !important;',
        '}',
        '',
        '/* 案B: 表のセル数字を等幅にして縦比較しやすくする */',
        '.el-table th,',
        '.el-table td {',
        '  font-variant-numeric: tabular-nums !important;',
        '}',
        '',
        '/* Tailwind ユーティリティの保険 */',
        '.bg-primary { background-color: ' + accent + ' !important; }',
        '.text-primary { color: ' + accent + ' !important; }',
        '.border-primary { border-color: ' + accent + ' !important; }',
        '',
        '/* 案A: コントラスト改善（実測値に基づく WCAG 2.1 AA 適合） */',
        '/* 表ヘッダ文字色 (WCAG AA 8.91) */',
        'table.el-table__header th,',
        '.el-table__header-wrapper th,',
        '.el-table th {',
        '  color: #2f3438 !important;',
        '  background-color: #d9d9d9 !important;',
        '  font-weight: 600 !important;',
        '  border-bottom: 1px solid #c8ccd4 !important;',
        '}',
        '',
        '/* 「データなし」文字色 (WCAG AA 6.51) */',
        '.el-table__empty-text {',
        '  color: #5a5e66 !important;',
        '  background-color: #ffffff !important;',
        '}',
        '',
        '/* 画面タイトル見出し (WCAG AA 13.02) */',
        'h1.page-title,',
        '.main h1,',
        'main h1 {',
        '  color: #303133 !important;',
        '  font-weight: 600 !important;',
        '}',
        '',
        '/* 表の罫線コントラスト */',
        'table.el-table__header th,',
        'table.el-table__body td,',
        '.el-table td,',
        '.el-table th.is-leaf {',
        '  border-bottom: 1px solid #c8ccd4 !important;',
        '  border-color: #c8ccd4 !important;',
        '}',
        '',
        '/* --- 見出し行を詰める -------------------------------------------------',
        '   自前のソート矢印と絞り込み欄を足すと見出しが高くなる。',
        '   実機では 89px まで伸びており「不必要に広い」と指摘された。',
        '   表は縦にも長いので、**見出しが高いほど一度に見える行数が減る**。',
        '   セルの上下余白を詰めて、増えた分を相殺する。 */',
        'table.el-table__header th {',
        '  padding-top: 4px !important;',
        '  padding-bottom: 4px !important;',
        '  line-height: 1.3 !important;',
        '  vertical-align: top !important;',
        '}',
        'table.el-table__header th .cell {',
        '  line-height: 1.3 !important;',
        '  padding-top: 0 !important;',
        '  padding-bottom: 0 !important;',
        '}',
        '',
        '/* --- 画面分割で使うときの横幅 ------------------------------------------',
        '   ポータルの body には `min-width: 1900px` が入っている。',
        '   **1900px未満の画面では、ページ全体が横スクロールする。**',
        '',
        '   現場では「Windowsキー + →」で画面を左右に分けて使うことがある。',
        '   FHD の半分 = 960px。実測（investigation/out/snap-widths.json）:',
        '',
        '     960px幅・そのまま … 971px が画面外。表を見るには**ページごと**横に送る必要があり、',
        '                          その間サイドバーもヘッダも視界から消える',
        '     960px幅・緩和後   … 画面外 0px。表は自前のスクロール領域（約561px）の中で横に送る',
        '',
        '   ページ全体を送るより、表の中だけを送る方がはるかに扱いやすい。',
        '   先頭列は固定してあり（案3）、横スクロールバーも常時見える（table-wrap.js）ので、',
        '   狭い幅でも「どの車両の行か」を見失わない。',
        '',
        '   **1900px以上の画面には一切影響しない**（メディアクエリが効かないため）。',
        '   FHD全画面が主流という前提を壊さずに、分割して使う人だけが得をする。',
        '------------------------------------------------------------------------ */',
        '@media (max-width: 1899px) {',
        '  body {',
        '    min-width: 0 !important;',
        '  }',
        '}',
        '',
        '/* 案C: サイドバー縮小 (280px -> 180px) */',
        '.sidebar,',
        '.w-\\[280px\\],',
        '[class*="w-[280px]"] {',
        '  width: 180px !important;',
        '  flex: 0 0 180px !important;',
        '  min-width: 180px !important;',
        '  max-width: 180px !important;',
        '}',
        '',
        '.sidebar .menu-item > a,',
        '.sidebar .menu a,',
        '.sidebar a,',
        '[class*="w-[280px]"] a.block.w-full,',
        'a.block.w-full.p-2 {',
        '  font-size: 14px !important;',
        '  padding: 6px 8px !important;',
        '  height: 34px !important;',
        '  line-height: 22px !important;',
        '}',
        '',
        '.sidebar-head,',
        '[class*="w-[280px]"] > div:first-child,',
        '.sidebar .brand {',
        '  font-size: 13px !important;',
        '  padding: 10px 8px !important;',
        '}',
        '',
        '/* 案E: ゼブラとホバー強調 */',
        '.el-table__body tr:nth-child(odd) td {',
        '  background-color: #ffffff !important;',
        '}',
        '.el-table__body tr:nth-child(even) td {',
        '  background-color: #f7f9fc !important;',
        '}',
        '.el-table__body tr:hover td,',
        '.el-table__body tr.hover-row td {',
        '  background-color: #e8f1fb !important;',
        '}',
        '',
        '/* 案3: 先頭列（チェックボックス・車両識別番号）の sticky 固定 */',
        'table.el-table__header th:first-child {',
        '  position: sticky !important;',
        '  left: 0 !important;',
        '  z-index: 5 !important;',
        '  background-color: #d9d9d9 !important;',
        '}',
        'table.el-table__header th:nth-child(2) {',
        '  position: sticky !important;',
        '  left: 44px !important;',
        '  z-index: 5 !important;',
        '  background-color: #d9d9d9 !important;',
        '  box-shadow: 2px 0 4px -2px rgba(0,0,0,0.12);',
        '}',
        'table.el-table__body td:first-child {',
        '  position: sticky !important;',
        '  left: 0 !important;',
        '  z-index: 2 !important;',
        '}',
        'table.el-table__body td:nth-child(2) {',
        '  position: sticky !important;',
        '  left: 44px !important;',
        '  z-index: 2 !important;',
        '  box-shadow: 2px 0 4px -2px rgba(0,0,0,0.12);',
        '}',
        '.el-table__body tr:nth-child(odd) td:first-child,',
        '.el-table__body tr:nth-child(odd) td:nth-child(2) {',
        '  background-color: #ffffff !important;',
        '}',
        '.el-table__body tr:nth-child(even) td:first-child,',
        '.el-table__body tr:nth-child(even) td:nth-child(2) {',
        '  background-color: #f7f9fc !important;',
        '}',
        '.el-table__body tr:hover td:first-child,',
        '.el-table__body tr:hover td:nth-child(2),',
        '.el-table__body tr.hover-row td:first-child,',
        '.el-table__body tr.hover-row td:nth-child(2) {',
        '  background-color: #e8f1fb !important;',
        '}',
        '',
        '/* ポータル標準の車両状態色を、車両識別番号セルだけに残す。',
        '   実機確認（2026-08-09）:',
        '     bg-green = rgb(168, 240, 122) / bg-brown = rgb(197, 149, 107)',
        '     bg-red   = rgb(255, 99, 71)',
        '   行全体の着色はゼブラ表示と競合するため復元せず、sticky な第2列だけへ反映する。 */',
        'table.el-table__body tr.bg-green td:nth-child(2) {',
        '  background-color: rgb(168, 240, 122) !important;',
        '}',
        'table.el-table__body tr.bg-brown td:nth-child(2) {',
        '  background-color: rgb(197, 149, 107) !important;',
        '}',
        'table.el-table__body tr.bg-red td:nth-child(2) {',
        '  background-color: rgb(255, 99, 71) !important;',
        '}',
        '',
        '/* --- ビーコン一覧拡張パネル --------------------------------------------- */',
        '[data-dbsext-beacons-panel] {',
        '  margin: 16px 0;',
        '  padding: 16px;',
        '  background-color: #ffffff !important;',
        '  border: 1px solid #dcdfe6 !important;',
        '  border-radius: 4px !important;',
        '}',
        '[data-dbsext-beacons-panel] h2 {',
        '  font-size: 16px !important;',
        '  font-weight: 600 !important;',
        '  margin: 0 0 12px 0 !important;',
        '  color: #303133 !important;',
        '}',
        '[data-dbsext-beacons-panel] .dbsext-beacons-actions {',
        '  margin-bottom: 12px !important;',
        '  display: flex !important;',
        '  align-items: center !important;',
        '  gap: 12px !important;',
        '}',
        '[data-dbsext-beacons-panel] .dbsext-btn {',
        '  padding: 6px 14px !important;',
        '  background-color: ' + accent + ' !important;',
        '  color: #ffffff !important;',
        '  border: none !important;',
        '  border-radius: 4px !important;',
        '  cursor: pointer !important;',
        '  font-size: 14px !important;',
        '}',
        '[data-dbsext-beacons-panel] .dbsext-btn:disabled {',
        '  background-color: #a0cfff !important;',
        '  cursor: not-allowed !important;',
        '}',
        '[data-dbsext-beacons-panel] .dbsext-beacons-table-wrap {',
        '  overflow: auto !important;',
        '  max-width: 100% !important;',
        '  max-height: 70vh !important;',
        '  margin-top: 12px !important;',
        '}',
        '[data-dbsext-beacons-panel] .dbsext-beacons-warn {',
        '  color: #e6a23c !important;',
        '  background-color: #fdf6ec !important;',
        '  border: 1px solid #faecd8 !important;',
        '  padding: 8px 12px !important;',
        '  border-radius: 4px !important;',
        '  margin-bottom: 12px !important;',
        '  font-size: 13px !important;',
        '}',
        '[data-dbsext-beacons-panel] .dbsext-beacons-error {',
        '  color: #f56c6c !important;',
        '  background-color: #fef0f0 !important;',
        '  border: 1px solid #fde2e2 !important;',
        '  padding: 8px 12px !important;',
        '  border-radius: 4px !important;',
        '  margin-bottom: 12px !important;',
        '  font-size: 13px !important;',
        '}',
        '/* 自作ビーコン表の専用スタイル */',
        '[data-dbsext-beacons-table] {',
        '  width: 100% !important;',
        '  border-collapse: collapse !important;',
        '  min-width: 1100px !important;',
        '  font-size: 14px !important;',
        '}',
        '[data-dbsext-beacons-table] th {',
        '  position: sticky !important;',
        '  top: 0 !important;',
        '  z-index: 3 !important;',
        '  background-color: #d9d9d9 !important;',
        '  color: #2f3438 !important;',
        '  font-weight: 600 !important;',
        '  padding: 8px 12px !important;',
        '  border: 1px solid #c8ccd4 !important;',
        '  text-align: left !important;',
        '  vertical-align: top !important;',
        '}',
        '[data-dbsext-beacons-table] .dbsext-beacons-sort {',
        '  display: block !important;',
        '  width: 100% !important;',
        '  padding: 2px 0 6px !important;',
        '  border: 0 !important;',
        '  background: transparent !important;',
        '  color: #2f3438 !important;',
        '  font: inherit !important;',
        '  font-weight: 600 !important;',
        '  text-align: left !important;',
        '  cursor: pointer !important;',
        '  white-space: nowrap !important;',
        '}',
        '[data-dbsext-beacons-table] .dbsext-beacons-filter {',
        '  display: block !important;',
        '  box-sizing: border-box !important;',
        '  width: 100% !important;',
        '  min-width: 110px !important;',
        '  padding: 5px 7px !important;',
        '  border: 1px solid #a8adb5 !important;',
        '  border-radius: 3px !important;',
        '  background-color: #ffffff !important;',
        '  color: #303133 !important;',
        '  font-size: 13px !important;',
        '}',
        '[data-dbsext-beacons-table] td {',
        '  padding: 8px 12px !important;',
        '  border: 1px solid #c8ccd4 !important;',
        '  font-variant-numeric: tabular-nums !important;',
        '  color: #303133 !important;',
        '}',
        '[data-dbsext-beacons-table] .dbsext-beacons-code-link {',
        '  border: 0 !important;',
        '  padding: 0 !important;',
        '  background: transparent !important;',
        '  color: #2563eb !important;',
        '  font: inherit !important;',
        '  text-decoration: underline !important;',
        '  cursor: pointer !important;',
        '}',
        '[data-dbsext-beacons-table] tr:nth-child(even) td {',
        '  background-color: #f7f9fc !important;',
        '}',
        '[data-dbsext-beacons-table] tr:hover td {',
        '  background-color: #e8f1fb !important;',
        '}',
        '[data-dbsext-beacons-table] .dbsext-beacons-empty {',
        '  padding: 20px 12px !important;',
        '  color: #5a5e66 !important;',
        '  text-align: center !important;',
        '}',
        '[data-dbsext-beacons-native-modal] {',
        '  display: contents !important;',
        '  pointer-events: none !important;',
        '}',
        '[data-dbsext-beacons-native-modal] .dbsext-beacons-native-backdrop {',
        '  position: fixed !important;',
        '  inset: 0 !important;',
        '  z-index: 1400 !important;',
        '  width: 100% !important;',
        '  height: 100% !important;',
        '  border: 0 !important;',
        '  background: rgba(17, 24, 39, 0.58) !important;',
        '  pointer-events: auto !important;',
        '  cursor: default !important;',
        '}',
        '.mb-4.dbsext-beacons-native-modal-open {',
        '  position: fixed !important;',
        '  top: 180px !important;',
        '  right: 4vw !important;',
        '  bottom: auto !important;',
        '  left: 4vw !important;',
        '  z-index: 1401 !important;',
        '  box-sizing: border-box !important;',
        '  max-height: 36vh !important;',
        '  margin: 0 !important;',
        '  padding: 18px !important;',
        '  overflow: auto !important;',
        '  background: #ffffff !important;',
        '  border-radius: 6px !important;',
        '  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.38) !important;',
        '}',
        '[data-dbsext-beacons-native-modal] .dbsext-beacons-native-header {',
        '  position: fixed !important;',
        '  top: 120px !important;',
        '  right: 220px !important;',
        '  left: 4vw !important;',
        '  z-index: 1402 !important;',
        '  display: flex !important;',
        '  align-items: center !important;',
        '  gap: 16px !important;',
        '  min-height: 44px !important;',
        '  padding: 8px 14px !important;',
        '  background: #ffffff !important;',
        '  border-radius: 6px !important;',
        '  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3) !important;',
        '  color: #303133 !important;',
        '  pointer-events: auto !important;',
        '}',
        '[data-dbsext-beacons-native-modal] .dbsext-beacons-native-header span {',
        '  color: #606266 !important;',
        '  font-size: 13px !important;',
        '}',
        '[data-dbsext-beacons-native-modal] .dbsext-beacons-native-close {',
        '  margin-left: auto !important;',
        '  padding: 6px 18px !important;',
        '  border: 1px solid ' + accent + ' !important;',
        '  border-radius: 4px !important;',
        '  background: #ffffff !important;',
        '  color: ' + accent + ' !important;',
        '  cursor: pointer !important;',
        '}'
      ].join('\n');

      var styleEl = document.createElement('style');
      styleEl.id = D.skin.styleId;
      styleEl.setAttribute('data-dbsext-skin', '1');
      styleEl.textContent = css;

      document.head.appendChild(styleEl);
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);


/**
 * DBSEXT テーブル表示モジュール
 *
 * 目的: 一覧の見出し行を固定し、縦に長い表でも列名を見失わないようにする。
 *
 * ---------------------------------------------------------------------------
 * 実機実測でわかった Element Plus の構造（investigation/out/diag-tablewrap.json）
 * ---------------------------------------------------------------------------
 *
 *   div.el-table                     overflow:hidden      scrollW = clientW
 *     div.el-table__header-wrapper   overflow:hidden      scrollW = 3144
 *       table.el-table__header
 *     div.el-table__body-wrapper     overflow:hidden
 *       div.el-scrollbar
 *         div.el-scrollbar__wrap     overflow:auto        scrollW = 3144
 *           table.el-table__body
 *
 * 横スクロールを担っているのは .el-scrollbar__wrap であり、EP が JS で
 * ヘッダ側とスクロール位置を同期している。**ここに手を入れてはいけない。**
 *
 * 以前の実装は .el-table 自体を overflow:auto にし、内側のラッパーの overflow を
 * visible で潰していた。その結果、ヘッダは sticky で追随するのにボディは
 * body-wrapper の幅で止まり、**右へスクロールすると右側が白いまま**になった
 * （2026-08-07 に現場から報告された症状）。
 *
 * したがって現在の実装は、縦方向の高さを制限するだけに絞ってある。
 * EP 純正の .el-scrollbar__wrap が縦にスクロールし、その上にある
 * .el-table__header-wrapper は動かないので、sticky を使わずに見出しが固定される。
 * 横スクロールは EP のまま何も変えない。
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  var SCROLL_CLASS = 'dbsext-scroll';
  var STYLE_ID = 'dbsext-table-wrap-style';
  var MAX_HEIGHT = '62vh';
  var TOP_BAR_ATTR = 'data-dbsext-top-scrollbar';

  function injectStyles() {
    if (typeof document === 'undefined' || !document.head) return;
    if (document.getElementById(STYLE_ID)) return;

    var css = [
      /* 縦の高さだけを制限する。横スクロールと overflow には一切触れない。 */
      '.el-table.' + SCROLL_CLASS + ' .el-scrollbar__wrap {',
      '  max-height: ' + MAX_HEIGHT + ' !important;',
      '}',

      /* 高さ制限が効かない構造（scrollbar が無い版）への保険。こちらも縦だけ。 */
      '.el-table.' + SCROLL_CLASS + ' > .el-table__body-wrapper:not(:has(.el-scrollbar)) {',
      '  max-height: ' + MAX_HEIGHT + ' !important;',
      '  overflow-y: auto;',
      '}',

      /* 見出しを少し目立たせる（固定されていることが分かるように） */
      '.el-table.' + SCROLL_CLASS + ' .el-table__header-wrapper {',
      '  background: #fafafa;',
      '}',

      /* --- 横スクロールバーを常時見えるようにする -----------------------------
         **なぜ今まで実機で出なかったか（2026-08-09 に原因特定）**

         Element Plus は `.el-scrollbar__wrap` に **標準プロパティ
         `scrollbar-width: none`** を指定してネイティブのバーを消している。
         Chrome は**標準プロパティが指定されていると `::-webkit-scrollbar` の
         指定を丸ごと無視する**（本機は Chromium 148。`CSS.supports` で確認済み）。

         そのため `::-webkit-scrollbar { height: 10px }` だけを書いても効かない。
         モックには `scrollbar-width: none` が無かったので、
         **モックでは出るのに実機では出ない**という食い違いになっていた。

         対処: **標準プロパティで上書きする。** webkit 側は古い環境への保険として残す。

         なぜ常時表示が要るか: 画面幅は利用者ごとに違う。
         ポータルの body には `min-width: 1900px` が入っており、
         1900px 未満の画面では**ページ全体が横スクロールする**（実測）。
         狭い画面の利用者にとって、横スクロールは日常的な操作である。
         「自分の画面で収まったから不要」と判断してはいけない。
      ------------------------------------------------------------------------ */
      '.el-table.' + SCROLL_CLASS + ' .el-scrollbar__wrap {',
      '  scrollbar-width: auto !important;',      /* none を打ち消す。これが本命 */
      '  scrollbar-color: #8a9099 #e8e8e8 !important;',  /* つまみ / 溝 */
      '}',
      /* 以下は標準プロパティ非対応の環境向けの保険 */
      '.el-table.' + SCROLL_CLASS + ' .el-scrollbar__wrap::-webkit-scrollbar {',
      '  display: block !important;',
      '  width: 12px;',
      '  height: 12px;',
      '}',
      '.el-table.' + SCROLL_CLASS + ' .el-scrollbar__wrap::-webkit-scrollbar-track {',
      '  background: #e8e8e8;',
      '  border-radius: 5px;',
      '}',
      '.el-table.' + SCROLL_CLASS + ' .el-scrollbar__wrap::-webkit-scrollbar-thumb {',
      '  background: #a0a0a0;',
      '  border-radius: 5px;',
      '  border: 2px solid #e8e8e8;',
      '}',
      '.el-table.' + SCROLL_CLASS + ' .el-scrollbar__wrap::-webkit-scrollbar-thumb:hover {',
      '  background: #707070;',
      '}',
      '.el-table.' + SCROLL_CLASS + ' .el-scrollbar__wrap::-webkit-scrollbar-corner {',
      '  background: #e8e8e8;',
      '}',

      /* 見出しの上に置く操作用の帯。常に見える横スクロールバー */
      '.el-table.' + SCROLL_CLASS + ' .dbsext-top-scrollbar {',
      '  overflow-x: auto;',
      '  overflow-y: hidden;',
      '  scrollbar-width: auto;',
      '  scrollbar-color: #8a9099 #e8e8e8;',
      '}',
      '.el-table.' + SCROLL_CLASS + ' .dbsext-top-scrollbar > div {',
      '  height: 1px;',
      '}',
      '.el-table.' + SCROLL_CLASS + ' .dbsext-top-scrollbar::-webkit-scrollbar {',
      '  display: block !important;',
      '  height: 12px;',
      '}',
      '.el-table.' + SCROLL_CLASS + ' .dbsext-top-scrollbar::-webkit-scrollbar-track {',
      '  background: #e8e8e8;',
      '  border-radius: 6px;',
      '}',
      '.el-table.' + SCROLL_CLASS + ' .dbsext-top-scrollbar::-webkit-scrollbar-thumb {',
      '  background: #8a9099;',
      '  border-radius: 6px;',
      '}',

      /* EP 自前のスクロールバー（細い・hover時のみ）を隠す */
      '.el-table.' + SCROLL_CLASS + ' .el-scrollbar__bar {',
      '  display: none !important;',
      '}'
    ].join('\n');

    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.setAttribute('data-dbsext-skin', '1');
    style.textContent = css;
    document.head.appendChild(style);
  }

  
  // ローディングオーバーレイによるクラス消失を防止

  /**
   * 見出しの**上**に横スクロールバーを置く。
   *
   * 現場からの指摘:
   *   「横スクロールバーが、表の一番下まで到達しないと見えない。常に見えるようにしてほしい。
   *     見出し列の上につけれればいいかも」
   *
   * そのとおりで、EP のスクロールバーは**スクロール領域の下端**にある。
   * 表は縦にも長く高さを 62vh に制限しているため、
   * **縦に一番下まで送らないと横バーが視界に入らない**。
   * 横に隠れた列があること自体に気づけない。
   *
   * 対処: 見出しの上に「操作用の細い帯」を置き、本体と**双方向に同期**させる。
   * 帯の中身は幅を合わせただけの空要素で、これを横に送ると本体も動く。
   *
   * **本体側の overflow には触らない**（触ると右側が描画されなくなる。table-wrap 冒頭の説明）。
   */
  function ensureTopScrollbar(table) {
    if (typeof document === 'undefined') return;

    var wrap = table.querySelector('.el-scrollbar__wrap');
    var headerWrapper = table.querySelector('.el-table__header-wrapper');
    if (!wrap || !headerWrapper || !headerWrapper.parentNode) return;

    var bar = table.querySelector('[' + TOP_BAR_ATTR + ']');
    if (!bar) {
      bar = document.createElement('div');
      bar.setAttribute(TOP_BAR_ATTR, '1');
      bar.className = 'dbsext-top-scrollbar';
      var inner = document.createElement('div');
      inner.setAttribute('data-dbsext-top-scrollbar-inner', '1');
      bar.appendChild(inner);
      headerWrapper.parentNode.insertBefore(bar, headerWrapper);
    }

    var inner2 = bar.firstChild;
    if (!inner2) return;

    // 中身の幅を本体に合わせる（本体が広いときだけ帯が意味を持つ）
    var needed = wrap.scrollWidth;
    if (inner2.style.width !== needed + 'px') inner2.style.width = needed + 'px';
    bar.style.display = (needed > wrap.clientWidth) ? 'block' : 'none';

    // 表示列の切替やSPA再描画で wrap 自体が差し替わることがある。
    // 最初に見つけた wrap をクロージャへ固定すると、以後は古い領域しか動かせない。
    // bar 側から「現在の wrap」を参照し、差し替え後も同じ帯を使い続けられるようにする。
    bar.__dbsextWrap = wrap;
    bar.__dbsextHeaderWrapper = headerWrapper;

    if (!bar.__dbsextScrollHooked) {
      bar.__dbsextScrollHooked = true;
      bar.setAttribute('data-dbsext-synced', '1');
      bar.addEventListener('scroll', function () {
        var currentWrap = bar.__dbsextWrap;
        if (!currentWrap || bar.__dbsextSyncing) return;
        bar.__dbsextSyncing = true;
        currentWrap.scrollLeft = bar.scrollLeft;
        var currentHeader = bar.__dbsextHeaderWrapper;
        if (currentHeader) currentHeader.scrollLeft = bar.scrollLeft;
        bar.__dbsextSyncing = false;
      });
    }

    if (wrap.__dbsextTopBar !== bar) {
      wrap.__dbsextTopBar = bar;
      wrap.addEventListener('scroll', function () {
        if (bar.__dbsextSyncing) return;
        bar.__dbsextSyncing = true;
        bar.scrollLeft = wrap.scrollLeft;
        var currentHeader = bar.__dbsextHeaderWrapper;
        if (currentHeader) currentHeader.scrollLeft = wrap.scrollLeft;
        bar.__dbsextSyncing = false;
      });
    }

    headerWrapper.scrollLeft = wrap.scrollLeft;
  }

  /**
   * 列幅変更後に上部バーを再計測する。
   * CSSの追加・削除は同期的でも、Element Plus が同じターンの後で幅を書き戻すため、
   * 直後と次のタスクの2回測る。
   */
  function refreshTopScrollbar(table) {
    if (!table) return;
    ensureTopScrollbar(table);
    if (typeof setTimeout === 'function') {
      setTimeout(function () { ensureTopScrollbar(table); }, 0);
    }
  }

  function observeTableClass(table) {
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'attributes' && mutation.attributeName === 'class') {
          if (!table.classList.contains(SCROLL_CLASS)) {
            table.classList.add(SCROLL_CLASS);
          }
        }
      });
    });
    
    observer.observe(table, { attributes: true, attributeFilter: ['class'] });
  }

  D.tableWrap = {
    SCROLL_CLASS: SCROLL_CLASS,

    refresh: refreshTopScrollbar,

    apply: function () {
      if (typeof document === 'undefined') return;

      injectStyles();

      var tables = document.querySelectorAll('.el-table');
      if (!tables || tables.length === 0) return;

      for (var t = 0; t < tables.length; t++) {
        var table = tables[t];

        // 幅は列の出し入れやリサイズで変わるので、**毎回**合わせ直す
        refreshTopScrollbar(table);

        if (table.classList.contains(SCROLL_CLASS)) continue;

        var headerTable = table.querySelector('table.el-table__header');
        var bodyTable = table.querySelector('table.el-table__body');
        if (!headerTable || !bodyTable) continue;

        table.classList.add(SCROLL_CLASS);
        observeTableClass(table);
        table.setAttribute('data-dbsext-wrap', '1');
      }
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);


/**
 * DBSEXT UI微調整モジュール
 *
 * - 戻るボタン: 隠さず、「1個前の画面へ戻る」挙動に差し替える
 * - 折りたたみセクション: 操作系は既定で閉じる（表示条件・検索条件等は開いたまま）
 * - ページサイズ: 車両情報 `/vehicles` で最大（1000）を自動選択する
 *
 * 契約（docs/06-module-contract.md §6）の遵守:
 *   setInterval を使わない / ポータルの既存DOMを削除・移動しない /
 *   更新系リクエストを発行しない
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  // ---------------------------------------------------------------------------
  // 画面の判定
  // ---------------------------------------------------------------------------

  /** 車両情報か */
  function isVehiclesPage() {
    return /^\/vehicles(\/|$)/.test(location.pathname);
  }

  /** ユーザ情報か（ここだけは検索前に表示条件を使うため開いておく） */
  function isUsersPage() {
    return /^\/users(\/|$)/.test(location.pathname);
  }

  function log(message, isError) {
    if (D.core && typeof D.core.log === 'function') D.core.log(message, isError);
  }

  // ---------------------------------------------------------------------------
  // 1. 戻るボタン — 「1個前の画面」へ戻す
  //
  // 現場の声:
  //   「お客様情報を見ている際、ひとつ前の情報を見たく『戻る』ボタンを押すと
  //     ユーザ情報の最初の画面に戻ってしまいます」
  //
  // ポータルの「戻る」は決まったルートへ飛ぶ作りになっている。そこで
  // クリックを捕まえて history.back() に置き換える。
  //
  // ただし**無条件に置き換えてはいけない**。適用直後にいきなり押されると、
  // ポータルへ来る前のページ（空タブや別サイト）へ戻ってしまう。
  // そこで「拡張を適用してから何回ポータル内を移動したか」を数え、
  // 戻れる残りがあるときだけ history.back() を使う。0 のときはポータル本来の
  // 動きに任せる（＝今までどおり）。
  // ---------------------------------------------------------------------------

  var depth = 0;          // 適用時点から何歩進んでいるか
  var pendingBack = 0;    // 自分が起こした戻りの数（数え直しを防ぐ）
  var lastHref = '';
  var backHooked = false;

  /** URLの変化を観測して depth を更新する。apply() から毎回呼ばれる */
  function noteNavigation() {
    var href = location.href;
    if (lastHref === '') { lastHref = href; return; }
    if (href === lastHref) return;
    lastHref = href;
    if (pendingBack > 0) {
      pendingBack--;
      if (depth > 0) depth--;
    } else {
      depth++;
    }
  }

  function isBackLabel(el) {
    if (!el || !el.textContent) return false;
    return el.textContent.trim() === '戻る';
  }

  /** クリック可能な祖先のうち「戻る」ボタンを探す */
  function findBackButton(start) {
    var el = start;
    for (var hop = 0; el && hop < 6; hop++) {
      var tag = el.tagName;
      var isClickable = tag === 'BUTTON' || tag === 'A' ||
        (el.getAttribute && el.getAttribute('role') === 'button');
      if (isClickable && isBackLabel(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function hookBackButtons() {
    if (backHooked || typeof document === 'undefined') return;
    backHooked = true;

    // capture フェーズで捕まえる。ポータル自身のハンドラより先に判断するため。
    document.addEventListener('click', function (event) {
      var button = findBackButton(event.target);
      if (!button) return;
      if (depth <= 0) {
        // 戻り先の履歴が無い。ポータル本来の動きに任せる
        log('戻る: 履歴が無いため既定動作にまかせる');
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') {
        event.stopImmediatePropagation();
      }
      pendingBack++;
      log('戻る: 1個前の画面へ戻る（残り ' + depth + '）');
      history.back();
    }, true);
  }

  // ---------------------------------------------------------------------------
  // 1b. 一覧のリンクを別タブで開く
  //
  // 現場の要望:
  //   絞り込んだ表から個別の画面へ飛ぶと、戻ったときに絞り込みが消えている。
  //   一覧はそのまま残し、個別画面は別タブで開きたい。
  //
  // **対象は `<a href>` だけに限る。** 表の中には「メンテナンス」「AT管理」「解錠」
  // 「再配置」といった**操作ボタン**が並んでおり、これらを別タブ化するのは危険であるうえ
  // 意味がない。リンク（画面遷移）とボタン（操作）を混同しない。
  //
  // Vue Router の RouterLink は、要素に `target="_blank"` が付いていると
  // 自前のルーティングを行わずブラウザに任せる。したがって属性を足すだけで、
  // クリックを横取りする必要がない（二重に開く事故も起きない）。
  // ---------------------------------------------------------------------------

  function openRowLinksInNewTab() {
    if (typeof document === 'undefined') return;
    var links = document.querySelectorAll('table.el-table__body tbody td a[href]');
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      if (link.hasAttribute('data-dbsext-newtab')) continue;
      var href = link.getAttribute('href');
      // 同一オリジンの通常リンクだけ。javascript: や外部リンクは触らない
      if (!href || href.charAt(0) !== '/') continue;
      link.setAttribute('data-dbsext-newtab', '1');
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener');
      link.title = (link.title ? link.title + ' / ' : '') + '別タブで開きます（一覧は残ります）';
    }
  }

  // ---------------------------------------------------------------------------
  // 2. 折りたたみセクション — ユーザ情報の表示条件だけ開いておく
  //
  // 現場確認により、ユーザ情報以外は「表示条件」も既定で閉じる。
  // ユーザ情報は検索しないと表が出ないため、入力に必要な表示条件だけ開いておく。
  // ---------------------------------------------------------------------------

  function shouldKeepSectionOpen(headerText) {
    if (!headerText) return false;
    if (!isUsersPage()) return false;
    return headerText.indexOf('表示条件') !== -1 ||
           headerText.indexOf('検索条件') !== -1 ||
           headerText.indexOf('絞り込み条件') !== -1;
  }

  function collapseSections() {
    if (typeof document === 'undefined') return;

    var items = document.querySelectorAll('.el-collapse-item');
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var header = item.querySelector('.el-collapse-item__header');
      if (!header || header.hasAttribute('data-dbsext-collapsed')) continue;
      header.setAttribute('data-dbsext-collapsed', '1');

      var headerText = (header.textContent || '').trim();
      var keepOpen = shouldKeepSectionOpen(headerText);

      // 開閉できることが見て分かるようにヒントを足す
      if (!header.querySelector('[data-dbsext-collapse-hint]')) {
        var hint = document.createElement('span');
        hint.setAttribute('data-dbsext-collapse-hint', '1');
        hint.textContent = '▼';
        hint.style.cssText = 'font-size:11px;opacity:0.5;margin-left:2px';
        header.appendChild(hint);
      }

      // 開いていればネイティブのクリックで閉じる。
      // クラスを直接操作すると Element Plus の内部状態とずれるため不可。
      if (!keepOpen && item.classList.contains('is-active')) {
        header.click();
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 3. ページサイズ最大化（車両情報）
  //
  // Element Plus のサイズ選択は el-select で、ドロップダウンは teleport で
  // body 直下へ描画される。前回の実装が動かなかった原因として次を想定し、
  // すべて潰してある。
  //   - クリック対象が `.el-select` のルートだった（開くのは内側の wrapper/input）
  //   - 待ち時間が短く、teleport 描画前に諦めていた
  //   - document 全体から `.el-select-dropdown__item` を拾い、別のドロップダウンを
  //     掴む可能性があった → **クリック後に現れた・表示されているものだけ**を見る
  //   - 一度失敗すると印を付けて二度と再挑戦しなかった → 成功するまで印を付けない
  // ---------------------------------------------------------------------------

  var TARGET_PAGE_SIZE = 1000;
  var sizeDoneFor = {};   // pathname ごとに一度だけ実行する
  var sizeRunning = false;

  /**
   * ドロップダウンの中身が「表示件数」のものか。
   * **項目が全部ただの数字**であることを条件にする。
   */
  function isSizeDropdown(node) {
    if (!node) return false;
    var items = node.querySelectorAll('.el-select-dropdown__item');
    if (items.length < 2) return false;
    for (var i = 0; i < items.length; i++) {
      if (!/^\d+$/.test((items[i].textContent || '').trim())) return false;
    }
    return true;
  }

  function dropdownById(id) {
    if (!id) return null;
    var el = document.getElementById(id);
    if (!el) return null;
    // popper が dropdown を包んでいる場合と、dropdown 自身が返る場合の両方に対応
    return (typeof el.closest === 'function' && el.closest('.el-select-dropdown')) || el;
  }

  /**
   * 表示件数のドロップダウンを引き当てる。
   *
   * **ここが2回失敗した箇所。** 実測（2026-08-07 `investigation/out/diag-sizes.json`）で分かったこと:
   *
   *   `.el-pagination__sizes` の select は
   *     aria-controls    = el-id-1024-72 → 中身は「更新しない / 15分」← **無関係**
   *     aria-describedby = el-id-1024-76 → 中身は「50 / 100 / 200 / 500」← **正解**
   *
   * Element Plus のこの版では `aria-controls` が隣のセレクタの id を指しており、
   * これを信じると自動更新間隔のドロップダウンを掴んでしまう
   * （実機ログ: `[dbsext] 表示件数を 15分 に変更`）。
   *
   * そこで **id を信用せず、中身で確かめる**。候補を順に試し、
   * 「項目が全部数字」のものだけを採用する。
   */
  function findSizeDropdown(select) {
    var wrapper = select.querySelector('.el-select__wrapper');
    var combobox = select.querySelector('[aria-controls]');
    var candidates = [
      dropdownById(wrapper && wrapper.getAttribute('aria-describedby')),
      dropdownById(combobox && combobox.getAttribute('aria-controls'))
    ];
    for (var i = 0; i < candidates.length; i++) {
      if (isSizeDropdown(candidates[i])) return candidates[i];
    }
    // それでも決まらなければ、画面全体から「数字だけ」のものを探す
    return numericOnlyDropdown();
  }

  /** 開いているか。Element Plus は aria-expanded を更新する */
  function isExpanded(select) {
    var combobox = select.querySelector('[aria-expanded]');
    return !!combobox && combobox.getAttribute('aria-expanded') === 'true';
  }

  /**
   * `aria-controls` が取れない版への退避。
   * **選択肢が全部ただの数字**のドロップダウンだけを候補にする。
   * 実測では他のドロップダウンは「更新しない/15分」「全て表示/閾値以下」「昇順/降順」等で、
   * 数字だけのものはページサイズ（50/100/200/500）に限られていた。
   */
  function numericOnlyDropdown() {
    var list = document.querySelectorAll('.el-select-dropdown');
    for (var i = 0; i < list.length; i++) {
      if (isSizeDropdown(list[i])) return list[i];
    }
    return null;
  }

  /**
   * 1000 があればそれ、無ければ最大値を返す。
   *
   * **選択肢は「数字だけ」のものに限る。** 実機で `\d+` の部分一致にしていたため、
   * 自動更新間隔の「15分」から 15 を拾って選んでしまった
   * （2026-08-07 実測ログ: `[dbsext] 表示件数を 15分 に変更`）。
   */
  function pickLargestOption(dropdown) {
    var items = dropdown.querySelectorAll('.el-select-dropdown__item');
    var best = null;
    var bestValue = -1;
    var exact = null;
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.classList.contains('is-disabled')) continue;
      var text = (item.textContent || '').trim();
      if (!/^\d+$/.test(text)) continue;        // 「15分」「更新しない」は候補にしない
      var value = parseInt(text, 10);
      if (value === TARGET_PAGE_SIZE) exact = item;
      if (value > bestValue) { bestValue = value; best = item; }
    }
    return exact || best;
  }

  function currentPageSize(select) {
    // 実測の構造:
    //   .el-select__selected-item.el-select__input-wrapper.is-hidden > input(value="")
    //   .el-select__selected-item.el-select__placeholder > span "100"   ← 表示中の値はこちら
    // 先に placeholder を見ないと、隠しinputの空値を拾って NaN になる。
    var text = '';
    var display = select.querySelector('.el-select__placeholder');
    if (display) text = display.textContent || '';
    if (!text) {
      var input = select.querySelector('input');
      if (input) text = input.value || input.getAttribute('value') || '';
    }
    var matched = String(text).match(/\d+/);
    return matched ? parseInt(matched[0], 10) : NaN;
  }

  /** el-select を開くための実クリック対象。Element Plus の版差を吸収する */
  function selectTrigger(select) {
    return select.querySelector('.el-select__wrapper') ||
      select.querySelector('.el-input__inner') ||
      select.querySelector('.el-input__wrapper') ||
      select;
  }

  function maximizePageSize() {
    if (typeof document === 'undefined') return;
    if (!isVehiclesPage()) return;
    if (sizeRunning || sizeDoneFor[location.pathname]) return;

    // **`.el-pagination__sizes` の中の select だけを対象にする。**
    // 以前は見つからないとき `pagination.querySelector('.el-select')` へ退避していたが、
    // ページャの中には自動更新間隔など別の select も居るため誤爆した。
    // 見つからないときは何もせず、次の再適用にゆだねる（印を付けないので再挑戦される）。
    var sizesHost = document.querySelector('.el-pagination__sizes');
    if (!sizesHost) return;
    var select = sizesHost.querySelector('.el-select');
    if (!select) return;

    var current = currentPageSize(select);
    if (current >= TARGET_PAGE_SIZE) {
      sizeDoneFor[location.pathname] = true;
      return;
    }

    sizeRunning = true;
    selectTrigger(select).click();

    // teleport + アニメーションを待つ。setInterval は契約で禁止のため再帰 setTimeout。
    var attempts = 0;
    (function waitForDropdown() {
      attempts++;

      // 開いたことを aria-expanded で確認してから中身を読む
      var opened = null;
      if (isExpanded(select)) {
        opened = findSizeDropdown(select);
      }

      if (opened) {
        var option = pickLargestOption(opened);
        if (option) {
          var label = (option.textContent || '').trim();
          option.click();
          sizeDoneFor[location.pathname] = true;
          // 本当に反映されたかを確かめる。掴む相手を間違えると
          // 「選んだのに変わらない」という静かな失敗になるため。
          setTimeout(function () {
            var now = currentPageSize(select);
            if (String(now) === label) {
              log('表示件数を ' + label + ' に変更');
            } else {
              log('表示件数を ' + label + ' に変えたが表示は ' + now + ' のまま', true);
              sizeDoneFor[location.pathname] = false;
            }
          }, 400);
        } else {
          log('表示件数の選択肢（数字のみ）が見つからない', true);
        }
        sizeRunning = false;
        return;
      }

      if (attempts >= 30) {   // 100ms × 30 = 約3秒
        log('表示件数のドロップダウンを特定できない（aria-controls も数字専用も不発）', true);
        sizeRunning = false;
        return;
      }
      setTimeout(waitForDropdown, 100);
    })();
  }

  // ---------------------------------------------------------------------------

  D.uiTweaks = {
    apply: function () {
      if (typeof document === 'undefined' || !document.body) return;
      noteNavigation();
      hookBackButtons();
      openRowLinksInNewTab();
      collapseSections();
      maximizePageSize();
    },

    // 検証用（テストから状態を覗くため）
    _state: function () {
      return { depth: depth, pendingBack: pendingBack, sizeDoneFor: sizeDoneFor };
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);


/**
 * DBSEXT アップセル / 案内パネルモジュール
 * 画面右下に Shadow DOM によるパネルを表示する
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  D.upsell = {
    /**
     * パネルを描画（冪等）
     */
    apply: function () {
      if (typeof document === 'undefined' || !document.body) {
        return;
      }

      if (document.querySelector('[data-dbsext-upsell="1"]')) {
        return;
      }

      var host = document.createElement('div');
      host.setAttribute('data-dbsext-upsell', '1');

      var shadow = host.attachShadow({ mode: 'open' });

      var accent = (D.CONFIG && D.CONFIG.ACCENT) ? D.CONFIG.ACCENT : '#0b5cab';
      var accentDark = (D.CONFIG && D.CONFIG.ACCENT_DARK) ? D.CONFIG.ACCENT_DARK : '#083f75';
      var guideUrl = (D.CONFIG && D.CONFIG.GUIDE_URL) ? D.CONFIG.GUIDE_URL : 'https://dontsu87.github.io/DBSgetdata/ext/';
      var version = D.VERSION || '0.1.0';

      var platform = D.platform || {};
      var isEphemeral = (typeof platform.isEphemeral === 'function') ? platform.isEphemeral() : true;
      var kindText = (platform.kind === 'extension') ? '（拡張版）' : '（ブックマークレット版）';

      var style = document.createElement('style');
      style.textContent = [
        ':host {',
        '  position: fixed;',
        '  right: 8px;',
        /* **右上に置く。** 右下は表やページャに重なって邪魔だと指摘された。
           エリア自動適用の通知（top:8px）と縦に並ばないよう少し下げる。 */
        '  top: 44px;',
        '  z-index: 2147483000;',
        '  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;',
        '}',
        '.panel {',
        '  background-color: ' + accent + ';',
        '  color: #ffffff;',
        '  border-radius: 8px;',
        '  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);',
        '  width: 260px;',
        '  font-size: 12px;',
        '  line-height: 1.4;',
        '  overflow: hidden;',
        '}',
        '.header {',
        '  padding: 8px 12px;',
        '  font-weight: bold;',
        '  cursor: pointer;',
        '  display: flex;',
        '  justify-content: space-between;',
        '  align-items: center;',
        '  user-select: none;',
        '  background-color: ' + accentDark + ';',
        '}',
        '.header-title {',
        '  font-size: 12px;',
        '}',
        '.header-toggle {',
        '  font-size: 10px;',
        '  opacity: 0.8;',
        '}',
        '.body {',
        '  padding: 10px 12px;',
        '  display: flex;',
        '  flex-direction: column;',
        '  gap: 8px;',
        '}',
        '.body.collapsed {',
        '  display: none;',
        '}',
        '.notice {',
        '  font-size: 11px;',
        '  opacity: 0.95;',
        '}',
        '.btn {',
        '  display: block;',
        '  background: #ffffff;',
        '  color: ' + accentDark + ';',
        '  border: none;',
        '  border-radius: 4px;',
        '  padding: 6px 10px;',
        '  font-size: 11px;',
        '  font-weight: bold;',
        '  cursor: pointer;',
        '  text-align: center;',
        '  text-decoration: none;',
        '}',
        '.btn:hover {',
        '  background: #f0f0f0;',
        '}',
        '.link {',
        '  color: #ffffff;',
        '  text-decoration: underline;',
        '  cursor: pointer;',
        '  font-size: 11px;',
        '  text-align: right;',
        '  display: inline-block;',
        '}',
        '.link:hover {',
        '  opacity: 0.8;',
        '}',
        '.store-section {',
        '  border-top: 1px solid rgba(255, 255, 255, 0.2);',
        '  padding-top: 8px;',
        '  display: flex;',
        '  flex-direction: column;',
        '  gap: 6px;',
        '}',
        '.store-title {',
        '  font-weight: bold;',
        '  font-size: 11px;',
        '}',
        '.store-list {',
        '  display: flex;',
        '  flex-direction: column;',
        '  gap: 4px;',
        '  max-height: 120px;',
        '  overflow-y: auto;',
        '}',
        '.store-item {',
        '  background: rgba(0, 0, 0, 0.15);',
        '  border-radius: 4px;',
        '  padding: 4px 6px;',
        '  font-size: 10px;',
        '}',
        '.store-item-label {',
        '  font-weight: bold;',
        '}',
        '.store-item-val {',
        '  word-break: break-all;',
        '  opacity: 0.9;',
        '}',
        '.store-item-date {',
        '  font-size: 9px;',
        '  opacity: 0.75;',
        '}',
        '.store-empty {',
        '  font-size: 10px;',
        '  opacity: 0.8;',
        '}',
        '.store-clear-btn {',
        '  background: #ffffff;',
        '  color: #c0392b;',
        '  border: none;',
        '  border-radius: 4px;',
        '  padding: 4px 8px;',
        '  font-size: 10px;',
        '  font-weight: bold;',
        '  cursor: pointer;',
        '  margin-top: 4px;',
        '}',
        '.store-clear-btn:hover {',
        '  background: #f0f0f0;',
        '}'
      ].join('\n');

      shadow.appendChild(style);

      var panel = document.createElement('div');
      panel.className = 'panel';

      // ヘッダ（折りたたみ操作）
      var header = document.createElement('div');
      header.className = 'header';

      var titleSpan = document.createElement('span');
      titleSpan.className = 'header-title';
      titleSpan.textContent = 'DBS 拡張ステータス';

      var toggleSpan = document.createElement('span');
      toggleSpan.className = 'header-toggle';
      // **既定は畳んだ状態。** 版番号や注意書きを常時出しておく必要はなく、
      // 適用中かどうかは配色で分かる。見出し1行だけにして場所を取らない。
      toggleSpan.textContent = '▼';

      header.appendChild(titleSpan);
      header.appendChild(toggleSpan);
      panel.appendChild(header);

      // パネル本文
      var body = document.createElement('div');
      body.className = 'body';

      // 行1: 拡張適用中 v<VERSION> (形式) または 配信版/保存版/同梱版 (B-2)
      var remoteStatus = (typeof platform.getRemoteStatus === 'function') ? platform.getRemoteStatus() : null;
      var remoteStatusLabel = '';
      if (platform.kind !== 'bookmarklet' && remoteStatus) {
        var sourceText = '不明';
        if (remoteStatus.source === 'remote') {
          sourceText = '配信版';
        } else if (remoteStatus.source === 'saved') {
          sourceText = '保存版';
        } else if (remoteStatus.source === 'fallback') {
          sourceText = '同梱版';
        }
        var verText = remoteStatus.version || version;
        remoteStatusLabel = sourceText + ' ' + verText;
      }

      var row1 = document.createElement('div');
      if (remoteStatusLabel) {
        row1.textContent = '拡張適用中 ' + remoteStatusLabel;
      } else {
        row1.textContent = '拡張適用中 ' + version + kindText;
      }
      body.appendChild(row1);

      if (isEphemeral) {
        // 行2: 再読込注意
        var row2 = document.createElement('div');
        row2.className = 'notice';
        row2.textContent = '画面を再読込したら、もう一度ブックマークを押してください';
        body.appendChild(row2);

        // 行3: Chrome拡張の導入案内ボタン
        var row3 = document.createElement('button');
        row3.className = 'btn';
        row3.type = 'button';
        row3.textContent = '機能充実版（Chrome拡張）の導入はこちら';
        row3.addEventListener('click', function (e) {
          e.stopPropagation();
          if (D.platform && typeof D.platform.openGuide === 'function') {
            D.platform.openGuide(guideUrl);
          }
        });
        body.appendChild(row3);

        // 行4: 更新を確認リンク
        var row4Wrapper = document.createElement('div');
        row4Wrapper.style.textAlign = 'right';
        var row4 = document.createElement('a');
        row4.className = 'link';
        row4.textContent = '更新を確認';
        row4.addEventListener('click', function (e) {
          e.preventDefault();
          e.stopPropagation();
          if (D.platform && typeof D.platform.openGuide === 'function') {
            D.platform.openGuide(guideUrl);
          }
        });
        row4Wrapper.appendChild(row4);
        body.appendChild(row4Wrapper);
      }

      // 保存した情報を見る／消す セクション
      var storeSection = document.createElement('div');
      storeSection.className = 'store-section';

      var storeTitle = document.createElement('div');
      storeTitle.className = 'store-title';
      storeTitle.textContent = '保存した情報（キャッシュ）';
      storeSection.appendChild(storeTitle);

      var storeList = document.createElement('div');
      storeList.className = 'store-list';

      function renderStoreList() {
        while (storeList.firstChild) {
          storeList.removeChild(storeList.firstChild); // dbsext:own-ui
        }

        var items = (D.stateStore && typeof D.stateStore.list === 'function') ? D.stateStore.list() : [];
        if (items.length === 0) {
          var empty = document.createElement('div');
          empty.className = 'store-empty';
          empty.textContent = '保存された情報はありません';
          storeList.appendChild(empty);
          return;
        }

        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          var row = document.createElement('div');
          row.className = 'store-item';

          var label = item.feature;
          if (D.stateForms && D.stateForms.DECLARATIONS) {
            for (var d = 0; d < D.stateForms.DECLARATIONS.length; d++) {
              var dec = D.stateForms.DECLARATIONS[d];
              if (dec.feature === item.feature) {
                label = dec.label || item.feature;
                break;
              }
            }
          }

          var labelEl = document.createElement('div');
          labelEl.className = 'store-item-label';
          labelEl.textContent = label + ' [' + item.storage + ']';
          row.appendChild(labelEl);

          var valEl = document.createElement('div');
          valEl.className = 'store-item-val';
          var valText = Array.isArray(item.data) ? item.data.join(', ') : (typeof item.data === 'object' && item.data !== null ? JSON.stringify(item.data) : String(item.data));
          valEl.textContent = '値: ' + valText;
          row.appendChild(valEl);

          if (item.at) {
            var dateEl = document.createElement('div');
            dateEl.className = 'store-item-date';
            var dObj = new Date(item.at);
            dateEl.textContent = '日時: ' + dObj.toLocaleString();
            row.appendChild(dateEl);
          }

          storeList.appendChild(row);
        }

        var clearBtn = document.createElement('button');
        clearBtn.className = 'store-clear-btn';
        clearBtn.type = 'button';
        clearBtn.textContent = 'すべて消す';
        clearBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          if (D.stateStore && typeof D.stateStore.clearAll === 'function') {
            D.stateStore.clearAll();
            renderStoreList();
          }
        });
        storeList.appendChild(clearBtn);
      }

      renderStoreList();
      storeSection.appendChild(storeList);
      body.appendChild(storeSection);

      panel.appendChild(body);

      // 開閉トグル処理（**既定は畳んだ状態**）
      var isFolded = true;
      body.classList.add('collapsed');
      header.addEventListener('click', function () {
        isFolded = !isFolded;
        if (isFolded) {
          body.classList.add('collapsed');
          toggleSpan.textContent = '▼';
        } else {
          body.classList.remove('collapsed');
          toggleSpan.textContent = '▲';
        }
      });

      shadow.appendChild(panel);
      document.body.appendChild(host);
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);

/**
 * DBSEXT エリア・マップURL構築モジュール
 * エリア取得 API 結果からマップアプリのパラメータ付きURLを生成する
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  D.areas = {
    /**
     * エリアリストからマップアプリのURLを組み立てる（同期・純粋関数）
     *
     * **空・null・エリア名を1つも取り出せない場合は null を返す。**
     * ここで `?kanriall`（全エリア）へ落とすと、権限を確認できていない状態で
     * 全エリアの車両を表示してしまう。マップアプリのデータは公開バケット由来で
     * サーバ側の権限フィルタが無いため、これは表示範囲の逸脱になる。
     * 呼び出し側は null を受けたら手動選択を必須にすること。
     *
     * @param {Array<Object|string>|null} areaList
     * @returns {string|null} マップアプリのURL。組み立てられない場合は null
     */
    buildMapUrl: function (areaList) {
      var baseUrl = (D.CONFIG && D.CONFIG.MAP_APP_URL)
        ? D.CONFIG.MAP_APP_URL
        : 'https://dontsu87.github.io/DBSgetdata/';

      var knownAreas = (D.CONFIG && D.CONFIG.KNOWN_AREAS)
        ? D.CONFIG.KNOWN_AREAS
        : ['金沢', '福井', '小松', '敦賀', '上田千曲広域', '出雲・松江・境港'];

      if (!areaList || !Array.isArray(areaList) || areaList.length === 0) {
        return null;
      }

      // エリア名の抽出と重複除去
      var names = [];
      for (var i = 0; i < areaList.length; i++) {
        var item = areaList[i];
        var name = '';
        if (typeof item === 'string') {
          name = item;
        } else if (item && typeof item.areaName === 'string') {
          name = item.areaName;
        }
        if (name && names.indexOf(name) === -1) {
          names.push(name);
        }
      }

      if (names.length === 0) {
        return null;
      }

      // KNOWN_AREAS を全件含んでいるかチェック
      var hasAllKnown = true;
      for (var j = 0; j < knownAreas.length; j++) {
        if (names.indexOf(knownAreas[j]) === -1) {
          hasAllKnown = false;
          break;
        }
      }

      if (hasAllKnown) {
        return baseUrl + '?kanriall';
      }

      // 順序の正規化（KNOWN_AREASの並び順に揃える）
      names.sort(function (a, b) {
        var idxA = knownAreas.indexOf(a);
        var idxB = knownAreas.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return a.localeCompare(b);
      });

      if (names.length === 1) {
        return baseUrl + '?area=' + encodeURIComponent(names[0]);
      }

      var encodedParams = [];
      for (var k = 0; k < names.length; k++) {
        encodedParams.push(encodeURIComponent(names[k]));
      }

      return baseUrl + '?areas=' + encodedParams.join(',');
    },

    /**
     * D.platform.fetchAreas を呼び出し、エリア情報とURLを返す
     * @returns {Promise<{ok: boolean, areas: Array, url: string, error?: string}>}
     */
    load: function () {
      // 取得できなかったときに全エリアURLへ落とさない（権限未確認で全件を開かない）
      if (!D.platform || typeof D.platform.fetchAreas !== 'function') {
        return Promise.resolve({
          ok: false,
          error: 'D.platform.fetchAreas が利用できません',
          areas: [],
          url: null
        });
      }

      var run = (D.netStatus && D.netStatus.silent) ? D.netStatus.silent : function (f) { return f(); };

      return Promise.resolve()
        .then(function () {
          return run(function () {
            return D.platform.fetchAreas();
          });
        })
        .then(function (areas) {
          var areaArray = Array.isArray(areas) ? areas : [];
          return {
            ok: true,
            areas: areaArray,
            url: D.areas.buildMapUrl(areaArray)
          };
        })
        .catch(function (err) {
          var msg = (err && err.message) ? err.message : String(err);
          return {
            ok: false,
            error: msg,
            areas: [],
            url: null
          };
        });
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);


/**
 * DBSEXT QRコード生成モジュール
 * 外部通信なしで自前で QR コード (Model 2, Error Correction M, Byte Mode) を生成し、
 * canvas 経由で data:image/png;base64 データURLを返す。
 *
 * QRCode for JavaScript
 * Copyright (c) 2009 Kazuhiko Arase
 * Licensed under the MIT license: http://www.opensource.org/licenses/mit-license.php
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  // --- GF(2^8) 定数と計算 ---
  var EXP_TABLE = new Array(256);
  var LOG_TABLE = new Array(256);
  for (var i = 0; i < 8; i++) EXP_TABLE[i] = 1 << i;
  for (var i = 8; i < 256; i++) EXP_TABLE[i] = EXP_TABLE[i - 4] ^ EXP_TABLE[i - 5] ^ EXP_TABLE[i - 6] ^ EXP_TABLE[i - 8];
  for (var i = 0; i < 255; i++) LOG_TABLE[EXP_TABLE[i]] = i;

  var QRMath = {
    glog: function (n) {
      if (n < 1) throw new Error('glog(' + n + ')');
      return LOG_TABLE[n];
    },
    gexp: function (n) {
      while (n < 0) n += 255;
      while (n >= 255) n -= 255;
      return EXP_TABLE[n];
    }
  };

  // --- 多項式演算 ---
  function QRPolynomial(num, shift) {
    var offset = 0;
    while (offset < num.length && num[offset] === 0) offset++;
    this.num = new Array(num.length - offset + shift);
    for (var i = 0; i < num.length - offset; i++) {
      this.num[i] = num[i + offset];
    }
    for (var j = num.length - offset; j < this.num.length; j++) {
      this.num[j] = 0;
    }
  }

  QRPolynomial.prototype = {
    get: function (index) { return this.num[index]; },
    getLength: function () { return this.num.length; },
    multiply: function (e) {
      var num = new Array(this.getLength() + e.getLength() - 1);
      for (var k = 0; k < num.length; k++) num[k] = 0;
      for (var i = 0; i < this.getLength(); i++) {
        for (var j = 0; j < e.getLength(); j++) {
          if (this.get(i) === 0 || e.get(j) === 0) continue;
          num[i + j] ^= QRMath.gexp(QRMath.glog(this.get(i)) + QRMath.glog(e.get(j)));
        }
      }
      return new QRPolynomial(num, 0);
    },
    mod: function (e) {
      if (this.getLength() - e.getLength() < 0) return this;
      var ratio = QRMath.glog(this.get(0)) - QRMath.glog(e.get(0));
      var num = new Array(this.getLength());
      for (var i = 0; i < this.getLength(); i++) num[i] = this.get(i);
      for (var j = 0; j < e.getLength(); j++) {
        if (e.get(j) === 0) continue;
        num[j] ^= QRMath.gexp(QRMath.glog(e.get(j)) + ratio);
      }
      return new QRPolynomial(num, 0).mod(e);
    }
  };

  // --- RSブロック定義（Error Correction M 用 V1~V10） ---
  // 各要素: [RSブロック数, トータルデータコード数, データコード数]
  var RS_BLOCK_TABLE_M = [
    [],
    [1, 26, 16],   // V1
    [1, 44, 28],   // V2
    [1, 70, 44],   // V3
    [2, 50, 32],   // V4
    [2, 67, 43],   // V5
    [4, 43, 27],   // V6
    [4, 49, 31],   // V7
    [2, 61, 38, 2, 62, 39], // V8
    [3, 58, 36, 2, 59, 37], // V9
    [4, 69, 43, 1, 70, 44]  // V10
  ];

  function getRSBlocks(typeNumber) {
    var rsArray = RS_BLOCK_TABLE_M[typeNumber];
    var list = [];
    for (var i = 0; i < rsArray.length; i += 3) {
      var count = rsArray[i];
      var totalCount = rsArray[i + 1];
      var dataCount = rsArray[i + 2];
      for (var j = 0; j < count; j++) {
        list.push({ totalCount: totalCount, dataCount: dataCount });
      }
    }
    return list;
  }

  function getTypeNumberForBytes(dataBytes) {
    for (var v = 1; v <= 10; v++) {
      var rsBlocks = getRSBlocks(v);
      var capacity = 0;
      for (var b = 0; b < rsBlocks.length; b++) {
        capacity += rsBlocks[b].dataCount;
      }
      var headerBits = 4 + (v < 10 ? 8 : 16);
      if (dataBytes.length * 8 + headerBits <= capacity * 8) {
        return v;
      }
    }
    return 0;
  }

  // --- ビットバッファ ---
  function QRBitBuffer() {
    this.buffer = [];
    this.length = 0;
  }
  QRBitBuffer.prototype = {
    put: function (num, length) {
      for (var i = 0; i < length; i++) {
        this.putBit(((num >>> (length - i - 1)) & 1) === 1);
      }
    },
    putBit: function (bit) {
      var bufIndex = Math.floor(this.length / 8);
      if (this.buffer.length <= bufIndex) this.buffer.push(0);
      if (bit) this.buffer[bufIndex] |= (0x80 >>> (this.length % 8));
      this.length++;
    }
  };

  // UTF-8 バイト列変換
  function stringToUtf8Bytes(str) {
    var bytes = [];
    for (var i = 0; i < str.length; i++) {
      var code = str.charCodeAt(i);
      if (code < 0x80) {
        bytes.push(code);
      } else if (code < 0x800) {
        bytes.push(0xc0 | (code >> 6));
        bytes.push(0x80 | (code & 0x3f));
      } else if (code < 0xd800 || code >= 0xe000) {
        bytes.push(0xe0 | (code >> 12));
        bytes.push(0x80 | ((code >> 6) & 0x3f));
        bytes.push(0x80 | (code & 0x3f));
      } else {
        i++;
        var code2 = str.charCodeAt(i);
        var surrogate = 0x10000 + (((code & 0x33f) << 10) | (code2 & 0x3ff));
        bytes.push(0xf0 | (surrogate >> 18));
        bytes.push(0x80 | ((surrogate >> 12) & 0x3f));
        bytes.push(0x80 | ((surrogate >> 6) & 0x3f));
        bytes.push(0x80 | (surrogate & 0x3f));
      }
    }
    return bytes;
  }

  // --- QRモデル構築クラス ---
  function QRCodeModel(typeNumber) {
    this.typeNumber = typeNumber;
    this.moduleCount = typeNumber * 4 + 17;
    this.modules = null;
  }

  QRCodeModel.prototype = {
    isDark: function (row, col) {
      if (this.modules && this.modules[row] && this.modules[row][col] !== null) {
        return this.modules[row][col];
      }
      return false;
    },
    make: function (dataBytes) {
      this.makeImpl(dataBytes, 0); // マスクパターン 0 固定（実用上可読）
    },
    makeImpl: function (dataBytes, maskPattern) {
      this.modules = new Array(this.moduleCount);
      for (var r = 0; r < this.moduleCount; r++) {
        this.modules[r] = new Array(this.moduleCount);
        for (var c = 0; c < this.moduleCount; c++) {
          this.modules[r][c] = null;
        }
      }

      this.setupPositionProbePattern(0, 0);
      this.setupPositionProbePattern(this.moduleCount - 7, 0);
      this.setupPositionProbePattern(0, this.moduleCount - 7);
      this.setupTimingPattern();
      this.setupAlignmentPattern();

      var data = createData(this.typeNumber, dataBytes);
      this.mapData(data, maskPattern);
    },

    setupPositionProbePattern: function (row, col) {
      for (var r = -1; r <= 7; r++) {
        if (row + r <= -1 || this.moduleCount <= row + r) continue;
        for (var c = -1; c <= 7; c++) {
          if (col + c <= -1 || this.moduleCount <= col + c) continue;
          if ((0 <= r && r <= 6 && (c === 0 || c === 6)) ||
              (0 <= c && c <= 6 && (r === 0 || r === 6)) ||
              (2 <= r && r <= 4 && 2 <= c && c <= 4)) {
            this.modules[row + r][col + c] = true;
          } else {
            this.modules[row + r][col + c] = false;
          }
        }
      }
    },

    setupTimingPattern: function () {
      for (var r = 8; r < this.moduleCount - 8; r++) {
        if (this.modules[r][6] !== null) continue;
        this.modules[r][6] = (r % 2 === 0);
      }
      for (var c = 8; c < this.moduleCount - 8; c++) {
        if (this.modules[6][c] !== null) continue;
        this.modules[6][c] = (c % 2 === 0);
      }
    },

    setupAlignmentPattern: function () {
      var pos = getAlignmentPatternPos(this.typeNumber);
      for (var i = 0; i < pos.length; i++) {
        for (var j = 0; j < pos.length; j++) {
          var row = pos[i];
          var col = pos[j];
          if (this.modules[row][col] !== null) continue;
          for (var r = -2; r <= 2; r++) {
            for (var c = -2; c <= 2; c++) {
              if (r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0)) {
                this.modules[row + r][col + c] = true;
              } else {
                this.modules[row + r][col + c] = false;
              }
            }
          }
        }
      }
    },

    mapData: function (data, maskPattern) {
      var inc = -1;
      var row = this.moduleCount - 1;
      var bitIndex = 7;
      var byteIndex = 0;

      for (var col = this.moduleCount - 1; col > 0; col -= 2) {
        if (col === 6) col--;
        while (true) {
          for (var c = 0; c < 2; c++) {
            if (this.modules[row][col - c] === null) {
              var dark = false;
              if (byteIndex < data.length) {
                dark = (((data[byteIndex] >>> bitIndex) & 1) === 1);
              }
              // マスクパターン（Pattern 0: (row + col) % 2 === 0）
              var mask = ((row + (col - c)) % 2 === 0);
              if (mask) dark = !dark;

              this.modules[row][col - c] = dark;
              bitIndex--;
              if (bitIndex === -1) {
                byteIndex++;
                bitIndex = 7;
              }
            }
          }
          row += inc;
          if (row < 0 || this.moduleCount <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    }
  };

  function getAlignmentPatternPos(typeNumber) {
    if (typeNumber === 1) return [];
    if (typeNumber === 2) return [6, 18];
    if (typeNumber === 3) return [6, 22];
    if (typeNumber === 4) return [6, 26];
    if (typeNumber === 5) return [6, 30];
    if (typeNumber === 6) return [6, 34];
    if (typeNumber === 7) return [6, 22, 38];
    if (typeNumber === 8) return [6, 24, 42];
    if (typeNumber === 9) return [6, 26, 46];
    if (typeNumber === 10) return [6, 28, 50];
    return [];
  }

  function createData(typeNumber, dataBytes) {
    var rsBlocks = getRSBlocks(typeNumber);
    var buffer = new QRBitBuffer();

    // 8bit Byte Mode 指示子: 0100
    buffer.put(4, 4);
    // 文字数指示子
    var countLength = (typeNumber < 10) ? 8 : 16;
    buffer.put(dataBytes.length, countLength);

    for (var i = 0; i < dataBytes.length; i++) {
      buffer.put(dataBytes[i], 8);
    }

    var totalDataCount = 0;
    for (var j = 0; j < rsBlocks.length; j++) {
      totalDataCount += rsBlocks[j].dataCount;
    }

    if (buffer.length + 4 <= totalDataCount * 8) {
      buffer.put(0, 4);
    }
    while (buffer.length % 8 !== 0) {
      buffer.putBit(false);
    }

    while (true) {
      if (buffer.length >= totalDataCount * 8) break;
      buffer.put(0xec, 8);
      if (buffer.length >= totalDataCount * 8) break;
      buffer.put(0x11, 8);
    }

    // RS パケットの分割および誤り訂正コード生成
    return createBytes(buffer, rsBlocks);
  }

  function createBytes(buffer, rsBlocks) {
    var offset = 0;
    var maxDcCount = 0;
    var maxEcCount = 0;
    var dcdata = new Array(rsBlocks.length);
    var ecdata = new Array(rsBlocks.length);

    for (var r = 0; r < rsBlocks.length; r++) {
      var dcCount = rsBlocks[r].dataCount;
      var ecCount = rsBlocks[r].totalCount - dcCount;

      maxDcCount = Math.max(maxDcCount, dcCount);
      maxEcCount = Math.max(maxEcCount, ecCount);

      dcdata[r] = new Array(dcCount);
      for (var i = 0; i < dcdata[r].length; i++) {
        dcdata[r][i] = 0xff & buffer.buffer[i + offset];
      }
      offset += dcCount;

      var rsPoly = getErrorCorrectionPolynomial(ecCount);
      var rawPoly = new QRPolynomial(dcdata[r], rsPoly.getLength() - 1);
      var modPoly = rawPoly.mod(rsPoly);

      ecdata[r] = new Array(rsPoly.getLength() - 1);
      for (var j = 0; j < ecdata[r].length; j++) {
        var modIndex = j + modPoly.getLength() - ecdata[r].length;
        ecdata[r][j] = (modIndex >= 0) ? modPoly.get(modIndex) : 0;
      }
    }

    var totalCodeCount = 0;
    for (var k = 0; k < rsBlocks.length; k++) {
      totalCodeCount += rsBlocks[k].totalCount;
    }

    var data = new Array(totalCodeCount);
    var index = 0;

    for (var l = 0; l < maxDcCount; l++) {
      for (var m = 0; m < rsBlocks.length; m++) {
        if (l < dcdata[m].length) {
          data[index++] = dcdata[m][l];
        }
      }
    }

    for (var n = 0; n < maxEcCount; n++) {
      for (var p = 0; p < rsBlocks.length; p++) {
        if (n < ecdata[p].length) {
          data[index++] = ecdata[p][n];
        }
      }
    }

    return data;
  }

  function getErrorCorrectionPolynomial(errorCorrectLength) {
    var a = new QRPolynomial([1], 0);
    for (var i = 0; i < errorCorrectLength; i++) {
      a = a.multiply(new QRPolynomial([1, QRMath.gexp(i)], 0));
    }
    return a;
  }

  // --- D.qr API 実装 ---
  D.qr = {
    /**
     * 指定テキストから生成される QR コードの一辺のモジュール数を返す
     * @param {string} text エンコード対象文字列
     * @returns {number} モジュール数（21, 25, 29...）、失敗時・不正入力時は 0
     */
    moduleCount: function (text) {
      try {
        if (typeof text !== 'string' || text.length === 0) {
          return 0;
        }
        var dataBytes = stringToUtf8Bytes(text);
        var typeNumber = getTypeNumberForBytes(dataBytes);
        if (typeNumber === 0) {
          return 0;
        }
        return typeNumber * 4 + 17;
      } catch (e) {
        return 0;
      }
    },

    /**
     * 指定テキストから QR コードの data:image/png;base64 URL を生成する
     * @param {string} text エンコード対象文字列
     * @param {number} [sizePx] 生成画像サイズ（px、既定: 160）
     * @returns {string|null} 成功時は data URL、失敗・非対応環境時は null
     */
    toDataUrl: function (text, sizePx) {
      try {
        if (typeof text !== 'string' || text.length === 0) {
          return null;
        }

        var targetSize = (typeof sizePx === 'number' && sizePx > 0) ? sizePx : 160;

        if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
          return null;
        }

        var dataBytes = stringToUtf8Bytes(text);

        // バイト数に応じたタイプナンバー選択（V1~V10）
        var typeNumber = getTypeNumberForBytes(dataBytes);
        if (typeNumber === 0) {
          if (D.core && typeof D.core.log === 'function') {
            D.core.log('QR生成に失敗: データ長が最大容量(V10)を超えています');
          }
          return null;
        }

        var qrModel = new QRCodeModel(typeNumber);
        qrModel.make(dataBytes);

        var canvas = document.createElement('canvas');
        if (!canvas || typeof canvas.getContext !== 'function') {
          return null;
        }

        canvas.width = targetSize;
        canvas.height = targetSize;
        var ctx = canvas.getContext('2d');
        if (!ctx) {
          return null;
        }

        var moduleCount = qrModel.moduleCount;
        var cellSize = targetSize / moduleCount;

        if (typeof ctx.fillStyle !== 'undefined') {
          ctx.fillStyle = '#FFFFFF';
        }
        if (typeof ctx.fillRect === 'function') {
          ctx.fillRect(0, 0, targetSize, targetSize);
        }

        if (typeof ctx.fillStyle !== 'undefined') {
          ctx.fillStyle = '#000000';
        }

        for (var r = 0; r < moduleCount; r++) {
          for (var c = 0; c < moduleCount; c++) {
            if (qrModel.isDark(r, c)) {
              if (typeof ctx.fillRect === 'function') {
                ctx.fillRect(c * cellSize, r * cellSize, cellSize, cellSize);
              }
            }
          }
        }

        if (typeof canvas.toDataURL === 'function') {
          var result = canvas.toDataURL('image/png');
          return (typeof result === 'string' && result.length > 0) ? result : null;
        }

        return null;
      } catch (e) {
        if (D.core && typeof D.core.log === 'function') {
          D.core.log('QR生成に失敗: ' + (e && e.message ? e.message : String(e)));
        }
        return null;
      }
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);



/**
 * DBSEXT マップ導線モジュール
 * 左メニューにバッテリーマップ起動ボタンを追加し、画面中央にモーダルパネル（Shadow DOM）を開く
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  var currentPanelHost = null;

  function closePanel() {
    if (currentPanelHost && currentPanelHost.parentNode) {
      currentPanelHost.parentNode.removeChild(currentPanelHost); // dbsext:own-ui
    }
    currentPanelHost = null;
  }

  function createLauncherPanel() {
    closePanel();

    var host = document.createElement('div');
    host.setAttribute('data-dbsext-launcher-panel', '1');
    currentPanelHost = host;

    var shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;

    // オーバーレイ背景
    var overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100vw';
    overlay.style.height = '100vh';
    overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.5)';
    overlay.style.zIndex = '999999';
    overlay.style.display = 'flex';
    overlay.style.alignItems = 'center';
    overlay.style.justifyContent = 'center';
    overlay.style.boxSizing = 'border-box';
    overlay.style.padding = '16px';

    // モーダルカード
    var card = document.createElement('div');
    card.style.backgroundColor = '#ffffff';
    card.style.borderRadius = '8px';
    card.style.padding = '24px';
    card.style.maxWidth = '480px';
    card.style.width = '100%';
    card.style.boxShadow = '0 10px 25px rgba(0, 0, 0, 0.2)';
    card.style.fontFamily = 'sans-serif';
    card.style.color = '#333333';
    card.style.boxSizing = 'border-box';

    // カードクリックでオーバーレイ閉じるイベントを発火させない
    card.addEventListener('click', function (e) {
      e.stopPropagation();
    });

    // オーバーレイのクリックで閉じる
    overlay.addEventListener('click', function () {
      closePanel();
    });

    // ヘッダー
    var header = document.createElement('div');
    header.style.display = 'flex';
    header.style.justifyContent = 'space-between';
    header.style.alignItems = 'center';
    header.style.marginBottom = '16px';

    var title = document.createElement('h3');
    title.textContent = 'バッテリーマップ';
    title.style.margin = '0';
    title.style.fontSize = '18px';
    title.style.fontWeight = 'bold';
    title.style.color = (D.CONFIG && D.CONFIG.ACCENT) || '#0b5cab';

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.style.background = 'none';
    closeBtn.style.border = 'none';
    closeBtn.style.fontSize = '18px';
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.color = '#666666';
    closeBtn.addEventListener('click', closePanel);

    header.appendChild(title);
    header.appendChild(closeBtn);
    card.appendChild(header);

    // エリア表示セクション
    var areaSection = document.createElement('div');
    areaSection.style.marginBottom = '20px';
    areaSection.style.padding = '12px';
    areaSection.style.backgroundColor = '#f5f7fa';
    areaSection.style.borderRadius = '6px';
    areaSection.style.fontSize = '14px';

    var areaText = document.createElement('div');
    areaText.textContent = 'エリアを判定中…';
    areaSection.appendChild(areaText);

    var manualAreaContainer = document.createElement('div');
    manualAreaContainer.style.marginTop = '10px';
    manualAreaContainer.style.display = 'none';
    areaSection.appendChild(manualAreaContainer);

    card.appendChild(areaSection);

    // 表示タイプ3ボタンセクション（横並び）
    var btnContainer = document.createElement('div');
    btnContainer.style.display = 'flex';
    btnContainer.style.gap = '8px';
    btnContainer.style.marginBottom = '20px';

    var tabBtn = document.createElement('button');
    tabBtn.type = 'button';
    tabBtn.textContent = '別タブで開く';
    styleActionButton(tabBtn);

    var splitBtn = document.createElement('button');
    splitBtn.type = 'button';
    splitBtn.textContent = '横に並べて表示';
    styleActionButton(splitBtn);

    var qrBtn = document.createElement('button');
    qrBtn.type = 'button';
    qrBtn.textContent = 'スマホ・タブレットで開く';
    styleActionButton(qrBtn);

    btnContainer.appendChild(tabBtn);
    btnContainer.appendChild(splitBtn);
    btnContainer.appendChild(qrBtn);
    card.appendChild(btnContainer);

    // QR表示セクション
    var qrSection = document.createElement('div');
    qrSection.style.display = 'none';
    qrSection.style.textAlign = 'center';
    qrSection.style.padding = '12px';
    qrSection.style.borderTop = '1px solid #eeeeee';

    var qrImg = document.createElement('img');
    qrImg.style.width = '220px';
    qrImg.style.height = '220px';
    qrImg.style.display = 'block';
    qrImg.style.margin = '0 auto 8px auto';
    qrImg.alt = 'QR Code';

    var qrErrorText = document.createElement('div');
    qrErrorText.style.color = '#d9534f';
    qrErrorText.style.fontSize = '13px';
    qrErrorText.style.marginBottom = '8px';
    qrErrorText.style.display = 'none';

    var urlText = document.createElement('div');
    urlText.style.fontSize = '12px';
    urlText.style.color = '#666666';
    urlText.style.wordBreak = 'break-all';

    qrSection.appendChild(qrImg);
    qrSection.appendChild(qrErrorText);
    qrSection.appendChild(urlText);
    card.appendChild(qrSection);

    overlay.appendChild(card);
    shadow.appendChild(overlay);

    document.body.appendChild(host);

    // Escape キーでのパネル閉じ
    function onKeyDown(e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        closePanel();
        window.removeEventListener('keydown', onKeyDown);
      }
    }
    window.addEventListener('keydown', onKeyDown);

    // 現在のターゲットURL保持
    var currentMapUrl = (D.areas && typeof D.areas.buildMapUrl === 'function')
      ? D.areas.buildMapUrl([])
      : ((D.CONFIG && D.CONFIG.MAP_APP_URL) || 'https://dontsu87.github.io/DBSgetdata/');

    function updateUrlAndQr(url) {
      currentMapUrl = url;

      // url が null＝表示範囲が確定していない。
      // 権限を確認できていない状態で全エリアを開かせないため、3つのボタンを無効にする。
      var ready = typeof url === 'string' && url.length > 0;
      setActionsEnabled(ready);

      if (!ready) {
        urlText.textContent = 'エリアを選ぶとURLが決まります';
        qrImg.style.display = 'none';
        qrErrorText.textContent = 'エリアを選んでください';
        qrErrorText.style.display = 'block';
        return;
      }

      urlText.textContent = url;

      if (D.qr && typeof D.qr.toDataUrl === 'function') {
        var dataUrl = D.qr.toDataUrl(url, 220);
        if (dataUrl) {
          qrImg.src = dataUrl;
          qrImg.style.display = 'block';
          qrErrorText.style.display = 'none';
        } else {
          qrImg.style.display = 'none';
          qrErrorText.textContent = 'QRコードを生成できませんでした';
          qrErrorText.style.display = 'block';
        }
      } else {
        qrImg.style.display = 'none';
        qrErrorText.textContent = 'QRコードを生成できませんでした';
        qrErrorText.style.display = 'block';
      }
    }

    /** 表示範囲が確定していないあいだ、3つのボタンを押せなくする */
    function setActionsEnabled(enabled) {
      var buttons = [tabBtn, splitBtn, qrBtn];
      for (var i = 0; i < buttons.length; i++) {
        buttons[i].disabled = !enabled;
        buttons[i].style.opacity = enabled ? '1' : '0.45';
        buttons[i].style.cursor = enabled ? 'pointer' : 'not-allowed';
        buttons[i].title = enabled ? '' : 'エリアを選ぶと押せます';
      }
    }

    /** URLが未確定なら何もしない（権限未確認で全エリアを開かせない） */
    function hasUrl() {
      return typeof currentMapUrl === 'string' && currentMapUrl.length > 0;
    }

    // ボタンのイベントハンドラ
    tabBtn.addEventListener('click', function () {
      if (!hasUrl()) return;
      if (D.platform && typeof D.platform.openTab === 'function') {
        D.platform.openTab(currentMapUrl);
      }
      closePanel();
    });

    splitBtn.addEventListener('click', function () {
      if (!hasUrl()) return;
      if (D.platform && typeof D.platform.openSplit === 'function') {
        D.platform.openSplit(currentMapUrl);
      }
      closePanel();
    });

    qrBtn.addEventListener('click', function () {
      if (!hasUrl()) return;
      qrSection.style.display = 'block';
    });

    // 非同期でエリア情報をロード
    if (D.areas && typeof D.areas.load === 'function') {
      D.areas.load().then(function (res) {
        if (!currentPanelHost) return; // ロード完了前に閉じた場合

        if (res && res.ok) {
          var targetUrl = res.url || D.areas.buildMapUrl(res.areas);
          if (!targetUrl) {
            // 取得は成功したがエリア名が1つも取れなかった場合も手動選択にする
            showManualAreaSelection();
            return;
          }
          updateUrlAndQr(targetUrl);

          if (targetUrl.indexOf('?kanriall') !== -1) {
            areaText.textContent = '表示範囲: 全エリア';
          } else if (res.areas && res.areas.length > 0) {
            var names = [];
            for (var i = 0; i < res.areas.length; i++) {
              var a = res.areas[i];
              var name = typeof a === 'string' ? a : (a && a.areaName ? a.areaName : '');
              if (name && names.indexOf(name) === -1) {
                names.push(name);
              }
            }
            areaText.textContent = '表示範囲: ' + names.join(', ');
          } else {
            showManualAreaSelection();
          }
        } else {
          showManualAreaSelection();
        }
      }).catch(function () {
        if (currentPanelHost) {
          showManualAreaSelection();
        }
      });
    } else {
      showManualAreaSelection();
    }

    function showManualAreaSelection() {
      areaText.textContent = 'エリアを自動判定できませんでした。手動で選んでください';
      manualAreaContainer.innerHTML = '';
      manualAreaContainer.style.display = 'block';

      var knownAreas = (D.CONFIG && D.CONFIG.KNOWN_AREAS)
        ? D.CONFIG.KNOWN_AREAS
        : ['金沢', '福井', '小松', '敦賀', '上田千曲広域', '出雲・松江・境港'];

      var selectedMap = {};

      var checkboxesDiv = document.createElement('div');
      checkboxesDiv.style.display = 'flex';
      checkboxesDiv.style.flexWrap = 'wrap';
      checkboxesDiv.style.gap = '8px';
      checkboxesDiv.style.marginTop = '8px';

      for (var j = 0; j < knownAreas.length; j++) {
        (function (areaName) {
          var label = document.createElement('label');
          label.style.fontSize = '13px';
          label.style.cursor = 'pointer';
          label.style.display = 'inline-flex';
          label.style.alignItems = 'center';
          label.style.gap = '4px';

          var chk = document.createElement('input');
          chk.type = 'checkbox';
          chk.value = areaName;
          chk.addEventListener('change', function () {
            if (chk.checked) {
              selectedMap[areaName] = true;
            } else {
              delete selectedMap[areaName];
            }
            var selectedList = [];
            for (var k = 0; k < knownAreas.length; k++) {
              if (selectedMap[knownAreas[k]]) {
                selectedList.push(knownAreas[k]);
              }
            }
            var newUrl = D.areas.buildMapUrl(selectedList);
            updateUrlAndQr(newUrl);
          });

          label.appendChild(chk);
          label.appendChild(document.createTextNode(areaName));
          checkboxesDiv.appendChild(label);
        })(knownAreas[j]);
      }

      manualAreaContainer.appendChild(checkboxesDiv);
      // 何も選ばれていない状態では URL を確定させない（buildMapUrl([]) は null を返す）。
      // 全エリアへ落とすと、権限未確認のまま全件を開いてしまう。
      updateUrlAndQr(D.areas.buildMapUrl([]));
    }
  }

  function styleActionButton(btn) {
    btn.style.flex = '1';
    btn.style.padding = '8px 12px';
    btn.style.backgroundColor = '#ffffff';
    btn.style.color = (D.CONFIG && D.CONFIG.ACCENT) || '#0b5cab';
    btn.style.border = '1px solid ' + ((D.CONFIG && D.CONFIG.ACCENT) || '#0b5cab');
    btn.style.borderRadius = '4px';
    btn.style.fontSize = '12px';
    btn.style.fontWeight = 'bold';
    btn.style.cursor = 'pointer';
    btn.style.transition = 'all 0.2s ease';

    btn.addEventListener('mouseenter', function () {
      btn.style.backgroundColor = (D.CONFIG && D.CONFIG.ACCENT) || '#0b5cab';
      btn.style.color = '#ffffff';
    });
    btn.addEventListener('mouseleave', function () {
      btn.style.backgroundColor = '#ffffff';
      btn.style.color = (D.CONFIG && D.CONFIG.ACCENT) || '#0b5cab';
    });
  }

  // ---------------------------------------------------------------------------
  // 起動ボタンは **document.body 直下の固定要素** にする
  //
  // 以前は左メニュー（`a[href="/vehicles"]` から辿ったコンテナ）へ appendChild していたが、
  // **表示されないことがある**と現場から報告があった。原因は次のとおり:
  //
  //   - `core.js` の onContentChange に登録されているのは tableWrap / uiTweaks / tableTools
  //     の3つだけで、**mapLauncher は boot() 時の1回しか走らない**
  //   - Vue が左メニューを再描画すると挿入したボタンは消え、**二度と戻らない**
  //
  // 右下の upsell パネルが消えないのは body 直下にあり Vue の管理外だからである。
  // 同じ作りにすれば、ポータルがどう再描画しても影響を受けない。
  // 位置は人間の指定どおり **左下**（右下の upsell と重ならない）。
  // ---------------------------------------------------------------------------

  var LAUNCHER_ATTR = 'data-dbsext-launcher';

  function buildLauncher() {
    var host = document.createElement('div');
    host.setAttribute(LAUNCHER_ATTR, '1');
    host.style.cssText = [
      'position:fixed',
      'left:12px',
      'bottom:12px',
      'z-index:2147483000',
      'width:auto'
    ].join(';');

    var shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : null;
    var root = shadow || host;

    var accent = (D.CONFIG && D.CONFIG.ACCENT) || '#0b5cab';
    var accentDark = (D.CONFIG && D.CONFIG.ACCENT_DARK) || '#083f75';

    if (shadow) {
      var style = document.createElement('style');
      style.textContent = [
        ':host { all: initial; }',
        'button {',
        '  font: bold 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;',
        '  padding: 12px 18px;',
        '  background: ' + accent + ';',
        '  color: #fff;',
        '  border: none;',
        '  border-radius: 8px;',
        '  cursor: pointer;',
        '  box-shadow: 0 4px 14px rgba(0,0,0,.3);',
        '  white-space: nowrap;',
        '}',
        'button:hover { background: ' + accentDark + '; }'
      ].join('\n');
      root.appendChild(style);
    }

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '🔋 バッテリーマップを開く';
    if (!shadow) {
      // Shadow DOM が使えない環境への退避（ポータルCSSの影響を受けうる）
      btn.style.cssText = 'font:bold 14px system-ui;padding:12px 18px;background:' + accent +
        ';color:#fff;border:none;border-radius:8px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.3)';
    }
    btn.addEventListener('click', function () {
      createLauncherPanel();
    });
    root.appendChild(btn);

    return host;
  }

  D.mapLauncher = {
    apply: function () {
      if (typeof document === 'undefined' || !document.body) return;
      // 冪等。すでに出ていれば何もしない
      if (document.querySelector('[' + LAUNCHER_ATTR + ']')) return;
      document.body.appendChild(buildLauncher());
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);


/**
 * DBSEXT ビーコン一覧モジュール
 * エリア内ポート割当済みビーコンの一覧取得、サイドバーの「ビーコン情報」リンク追加、
 * `/beacons` 画面での拡張所有パネル描画とデータ表示を担当する。
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  var CACHE_TTL_MS = 5 * 60 * 1000; // 5分
  var cacheMap = Object.create(null); // areaId -> { rows, portCount, failedPortCount, timestamp }
  var latestGenerationByArea = Object.create(null);
  var isFetching = false;
  var currentGeneration = 0;
  var activeRequest = null;
  var pendingSidebarNavigation = false;
  var nativePopupState = null;
  var nativeSearchGeneration = 0;

  /**
   * ポータルID（areaId, portId等）の検証
   */
  function isValidPortalId(value) {
    return typeof value === 'string' && value.length >= 1 && value.length <= 256 && /^[A-Za-z0-9:_-]+$/.test(value);
  }

  /**
   * ビーコン種別の日本語変換
   */
  function formatBeaconType(type) {
    if (type === 'BLE_BEACON') return 'BLEビーコン';
    if (type === 'BLE_BEACON_VARIABLE_OUTPUT') return 'BLEビーコン出力可変版';
    if (type === 'WEAK_BEACON') return '微弱ビーコン';
    if (type === 'IOT_BEACON') return 'OMNIビーコン';
    return type || '';
  }

  /**
   * 重複除去: portBeaconId を優先キーとし、無ければ portId + portBeaconUniqueCode
   * Set や Object.create(null) を使用し、衝突を防ぐ長さprefix付きで管理
   */
  function dedupeBeacons(rows) {
    if (!Array.isArray(rows)) return [];
    var seen = Object.create(null);
    var result = [];
    for (var i = 0; i < rows.length; i++) {
      var item = rows[i];
      if (!item) continue;
      var key = null;
      if (item.portBeaconId) {
        var bId = String(item.portBeaconId);
        key = 'id:' + bId.length + ':' + bId;
      } else if (item.portId && item.portBeaconUniqueCode) {
        var pId = String(item.portId);
        var uCode = String(item.portBeaconUniqueCode);
        key = 'fb:' + pId.length + ':' + pId + ':' + uCode.length + ':' + uCode;
      }
      if (!key) {
        result.push(item);
        continue;
      }
      if (!seen[key]) {
        seen[key] = true;
        result.push(item);
      }
    }
    return result;
  }

  /**
   * 並べ替え: ポート識別番号を数値自然順、その後ビーコン識別番号順
   */
  function sortBeacons(rows) {
    return rows.slice().sort(function (a, b) {
      var portA = String(a.portUniqueCode || '');
      var portB = String(b.portUniqueCode || '');
      var cmpPort = portA.localeCompare(portB, undefined, { numeric: true, sensitivity: 'base' });
      if (cmpPort !== 0) return cmpPort;

      var beaconA = String(a.portBeaconUniqueCode || a.portBeaconId || '');
      var beaconB = String(b.portBeaconUniqueCode || b.portBeaconId || '');
      return beaconA.localeCompare(beaconB, undefined, { numeric: true, sensitivity: 'base' });
    });
  }

  /**
   * URLからselected-area-idを取得する（例外安全な検証済みIDのみを返却）
   */
  function getSelectedAreaId() {
    if (typeof location === 'undefined' || !location.search) return null;
    var match = location.search.match(/[?&]selected-area-id=([^&]+)/);
    if (!match) return null;
    try {
      var decoded = decodeURIComponent(match[1]);
      if (isValidPortalId(decoded)) {
        return decoded;
      }
    } catch (e) {
      // 不正な percent encoding など例外時は null
    }
    return null;
  }

  /**
   * パネルがDOMに接続されており、指定areaIdの画面と一致するか検証
   */
  function isPanelConnected(panel, areaId) {
    if (typeof document === 'undefined' || !panel) return false;
    if (typeof panel.isConnected === 'boolean' && !panel.isConnected) return false;
    var root = panel;
    while (root.parentNode) root = root.parentNode;
    if (root !== document) return false;
    return getSelectedAreaId() === areaId;
  }

  /** hrefを読み、ポータル標準のサイドバーリンクを探す。 */
  function findPortalAnchor(pathname) {
    var anchors = document.querySelectorAll('a');
    for (var i = 0; i < anchors.length; i++) {
      if (anchors[i].hasAttribute && anchors[i].hasAttribute('data-dbsext-beacons-link-a')) continue;
      var href = anchors[i].getAttribute('href') || '';
      if (href === pathname || href.indexOf(pathname + '?') === 0) return anchors[i];
    }
    return null;
  }

  /** ポータル標準リンクへ委譲し、Vue Router固有の履歴stateを維持する。 */
  function activateOriginalBeaconAnchor(anchor) {
    if (!anchor || typeof anchor.click !== 'function') return false;
    pendingSidebarNavigation = false;
    global.setTimeout(function () {
      anchor.click();
      global.setTimeout(function () {
        if (D.beacons && typeof D.beacons.apply === 'function') D.beacons.apply();
      }, 0);
    }, 0);
    return true;
  }

  /** ポート情報への標準遷移後、標準ビーコンリンクを1回だけ押す。 */
  function continuePendingSidebarNavigation() {
    if (!pendingSidebarNavigation) return;
    var originalAnchor = findPortalAnchor('/beacons');
    if (originalAnchor) activateOriginalBeaconAnchor(originalAnchor);
  }

  /**
   * 後付けリンクからもポータル標準ルーターだけを使い、ブックマークレットを維持する。
   * 修飾キー付きクリックはブラウザ標準（別タブ等）へ委ねる。
   */
  function bindSidebarNavigation(anchor) {
    if (!anchor || anchor.__dbsextBeaconSpaBound) return;
    anchor.__dbsextBeaconSpaBound = true;

    anchor.addEventListener('click', function (event) {
      if (event && (event.button > 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) {
        return;
      }
      if (event && typeof event.preventDefault === 'function') event.preventDefault();

      if (/^\/beacons(\/|$)/.test(location.pathname)) return;

      var originalAnchor = findPortalAnchor('/beacons');
      if (originalAnchor) {
        activateOriginalBeaconAnchor(originalAnchor);
        return;
      }

      var portAnchor = findPortalAnchor('/ports');
      if (!portAnchor || typeof portAnchor.click !== 'function') return;
      pendingSidebarNavigation = true;
      portAnchor.click();
    });
  }

  /**
   * サイドバーへ「ビーコン情報」リンクを追加・更新
   */
  function injectSidebarMenu() {
    if (typeof document === 'undefined') return;

    var selectedAreaId = getSelectedAreaId();
    var targetHref = '/beacons' + (selectedAreaId ? '?selected-area-id=' + encodeURIComponent(selectedAreaId) : '');
    var isBeaconsPage = /^\/beacons(\/|$)/.test(location.pathname);

    var existing = document.querySelector('[data-dbsext-beacons-link="1"]');

    if (existing) {
      var existingAnchor = existing.querySelector('a') || existing;
      existingAnchor.setAttribute('href', targetHref);
      bindSidebarNavigation(existingAnchor);

      if (isBeaconsPage) {
        existing.classList.add('bg-primary', 'text-white');
        existing.classList.remove('text-primary');
        existingAnchor.classList.add('router-link-active', 'router-link-exact-active');
      } else {
        existing.classList.remove('bg-primary', 'text-white');
        existing.classList.add('text-primary');
        existingAnchor.classList.remove('router-link-active', 'router-link-exact-active');
      }
      continuePendingSidebarNavigation();
      return;
    }

    var portAnchor = document.querySelector('a[href="/ports"], a[href^="/ports?"]');
    if (!portAnchor) return;

    var portItem = (typeof portAnchor.closest === 'function' && portAnchor.closest('.menu > *')) ||
                   portAnchor.parentElement || portAnchor;
    if (!portItem || !portItem.parentNode) return;

    var newItem = portItem.cloneNode(false);
    newItem.setAttribute('data-dbsext-beacons-link', '1');
    if (newItem.removeAttribute) newItem.removeAttribute('id');

    var newAnchor = document.createElement('a');
    newAnchor.setAttribute('data-dbsext-beacons-link-a', '1');
    newAnchor.setAttribute('href', targetHref);
    newAnchor.textContent = 'ビーコン情報';
    bindSidebarNavigation(newAnchor);

    if (portAnchor.className) {
      newAnchor.className = portAnchor.className.replace(/router-link-[^\s]+/g, '').trim();
    }

    if (isBeaconsPage) {
      newItem.classList.add('bg-primary', 'text-white');
      newItem.classList.remove('text-primary');
      newAnchor.classList.add('router-link-active', 'router-link-exact-active');
    } else {
      newItem.classList.remove('bg-primary', 'text-white');
      newItem.classList.add('text-primary');
      newAnchor.classList.remove('router-link-active', 'router-link-exact-active');
    }

    newItem.appendChild(newAnchor);
    portItem.parentNode.insertBefore(newItem, portItem.nextSibling);
    continuePendingSidebarNavigation();
  }

  /**
   * 標準表の直前（新規登録・検索ブロックの後）を優先し、見つからない場合は本文先頭へ戻す。
   */
  function findInsertionPoint() {
    if (typeof document === 'undefined') return null;

    var heading = null;
    var candidates = document.querySelectorAll('p, h1, h2, h3');
    for (var i = 0; i < candidates.length; i++) {
      var txt = (candidates[i].textContent || '').replace(/[\s\u3000]+/g, ' ').trim();
      if (txt === 'ビーコン情報 一覧') {
        heading = candidates[i];
        break;
      }
    }
    if (!heading) return null;

    var portalTable = document.querySelector('.el-table:not([data-dbsext-beacons-table])');
    if (!portalTable) return null;

    // 実画面では標準表が .mb-4 で包まれ、その直前に新規登録・検索ブロックがある。
    // 拡張パネルを .mb-4 の直前へ置けば、新規登録バーを上に残せる。
    var tableSection = portalTable;
    while (tableSection && tableSection !== document.body && tableSection !== document.documentElement) {
      if (tableSection.classList && tableSection.classList.contains('mb-4') && tableSection.parentNode) {
        return { container: tableSection.parentNode, targetSibling: tableSection };
      }
      tableSection = tableSection.parentNode;
    }

    var ancestorsH = [];
    var cur = heading;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      ancestorsH.push(cur);
      cur = cur.parentNode;
    }

    var ancestorsT = [];
    cur = portalTable;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      ancestorsT.push(cur);
      cur = cur.parentNode;
    }

    var mainContainer = null;
    var headingWrapper = null;

    for (var h = 0; h < ancestorsH.length; h++) {
      var nodeH = ancestorsH[h];
      for (var t = 0; t < ancestorsT.length; t++) {
        if (nodeH === ancestorsT[t]) {
          mainContainer = nodeH;
          headingWrapper = (h > 0) ? ancestorsH[h - 1] : heading;
          break;
        }
      }
      if (mainContainer) break;
    }

    if (!mainContainer || mainContainer === document.body || (mainContainer.id && mainContainer.id === '__nuxt')) {
      return null;
    }

    return {
      container: mainContainer,
      targetSibling: headingWrapper ? headingWrapper.nextSibling : null
    };
  }

  /**
   * `/beacons` 画面に拡張所有パネルを描画・更新
   */
  function renderPanel() {
    if (typeof document === 'undefined') return;
    if (nativePopupState && /^\/beacons(\/|$)/.test(location.pathname) &&
        (!isNodeConnected(nativePopupState.section) || !isNodeConnected(nativePopupState.table))) {
      closeNativeTablePopup();
    }
    if (!/^\/beacons(\/|$)/.test(location.pathname)) {
      closeNativeTablePopup();
      var stalePanels = document.querySelectorAll('[data-dbsext-beacons-panel="1"]');
      if (stalePanels.length > 0) {
        currentGeneration++;
        isFetching = false;
        activeRequest = null;
      }
      for (var sp = 0; sp < stalePanels.length; sp++) {
        if (stalePanels[sp].parentNode) {
          stalePanels[sp].parentNode.removeChild(stalePanels[sp]); // dbsext:own-ui
        }
      }
      return;
    }

    var existingPanel = document.querySelector('[data-dbsext-beacons-panel="1"]');
    var selectedAreaId = getSelectedAreaId();

    // Vue が同じURLのまま本文を差し替えると、取得開始時のパネルだけが
    // DOM から外れ、新しいパネルを作り直す場合がある。切断済みパネルの
    // リクエストを現行パネルへ誤って引き継がない。
    if (!existingPanel && activeRequest &&
        !isPanelConnected(activeRequest.panel, activeRequest.areaId)) {
      currentGeneration++;
      isFetching = false;
      activeRequest = null;
    }

    if (existingPanel) {
      var prevArea = existingPanel.getAttribute('data-dbsext-beacons-area');
      var currentAreaAttr = selectedAreaId || '';
      if (prevArea !== currentAreaAttr) {
        existingPanel.__dbsextBeaconAutoArea = null;
        if (selectedAreaId) {
          existingPanel.setAttribute('data-dbsext-beacons-area', selectedAreaId);
        } else {
          existingPanel.removeAttribute('data-dbsext-beacons-area');
        }
        currentGeneration++;
        isFetching = false;
        activeRequest = null;

        var statusDiv = existingPanel.querySelector('[data-dbsext-beacons-status="1"]');
        var tableWrap = existingPanel.querySelector('.dbsext-beacons-table-wrap');
        if (statusDiv) {
          while (statusDiv.firstChild) statusDiv.removeChild(statusDiv.firstChild); // dbsext:own-ui
          statusDiv.textContent = '';
          statusDiv.className = '';
        }
        if (tableWrap) {
          while (tableWrap.firstChild) tableWrap.removeChild(tableWrap.firstChild); // dbsext:own-ui
        }
      }
      updatePanelState(existingPanel, selectedAreaId);
      ensureAutoFetch(existingPanel, selectedAreaId);
      return;
    }

    var insertion = findInsertionPoint();
    if (!insertion || !insertion.container) return;

    var panel = document.createElement('div');
    panel.setAttribute('data-dbsext-beacons-panel', '1');
    if (selectedAreaId) {
      panel.setAttribute('data-dbsext-beacons-area', selectedAreaId);
    }

    var h2 = document.createElement('h2');
    h2.textContent = 'エリア内ビーコン一覧（拡張）';
    panel.appendChild(h2);

    var actionsDiv = document.createElement('div');
    actionsDiv.className = 'dbsext-beacons-actions';

    var btn = document.createElement('button');
    btn.setAttribute('data-dbsext-beacons-btn', '1');
    btn.className = 'dbsext-btn';
    btn.textContent = '再取得';

    btn.addEventListener('click', function () {
      handleFetchClick(panel);
    });

    actionsDiv.appendChild(btn);
    panel.appendChild(actionsDiv);

    var statusDiv = document.createElement('div');
    statusDiv.setAttribute('data-dbsext-beacons-status', '1');
    panel.appendChild(statusDiv);

    var tableWrap = document.createElement('div');
    tableWrap.className = 'dbsext-beacons-table-wrap';
    panel.appendChild(tableWrap);

    if (insertion.targetSibling) {
      insertion.container.insertBefore(panel, insertion.targetSibling);
    } else {
      insertion.container.appendChild(panel);
    }

    updatePanelState(panel, selectedAreaId);
    ensureAutoFetch(panel, selectedAreaId);
  }

  /**
   * パネルのボタン状態と状態メッセージを更新
   */
  function updatePanelState(panel, selectedAreaId) {
    var btn = panel.querySelector('[data-dbsext-beacons-btn="1"]');
    var statusDiv = panel.querySelector('[data-dbsext-beacons-status="1"]');
    if (!btn || !statusDiv) return;

    var panelIsFetching = !!(isFetching && activeRequest &&
      activeRequest.panel === panel && activeRequest.areaId === selectedAreaId);
    if (panelIsFetching) {
      btn.disabled = true;
      btn.textContent = '取得中...';
      return;
    }

    btn.textContent = '再取得';
    if (!selectedAreaId) {
      btn.disabled = true;
      statusDiv.textContent = 'エリアを選択してください';
      statusDiv.className = 'dbsext-beacons-warn';
    } else {
      btn.disabled = false;
      if (statusDiv.textContent === 'エリアを選択してください') {
        statusDiv.textContent = '';
        statusDiv.className = '';
      }
    }
  }

  /**
   * 一覧取得ボタンのクリックハンドラ
   */
  function handleFetchClick(panel) {
    var selectedAreaId = getSelectedAreaId();
    if (!selectedAreaId || isFetching) return;

    currentGeneration++;
    var gen = currentGeneration;
    latestGenerationByArea[selectedAreaId] = gen;
    activeRequest = { generation: gen, areaId: selectedAreaId, panel: panel };

    var statusDiv = panel.querySelector('[data-dbsext-beacons-status="1"]');
    var tableWrap = panel.querySelector('.dbsext-beacons-table-wrap');

    isFetching = true;
    updatePanelState(panel, selectedAreaId);

    var now = Date.now();
    var cached = cacheMap[selectedAreaId];
    if (cached && (now - cached.timestamp < CACHE_TTL_MS)) {
      isFetching = false;
      activeRequest = null;
      if (gen === currentGeneration && isPanelConnected(panel, selectedAreaId)) {
        renderTableData(panel, cached.rows, cached.portCount, cached.failedPortCount);
        updatePanelState(panel, selectedAreaId);
      }
      return;
    }

    if (!D.platform || typeof D.platform.fetchBeaconsByArea !== 'function') {
      isFetching = false;
      activeRequest = null;
      if (gen === currentGeneration && isPanelConnected(panel, selectedAreaId)) {
        statusDiv.textContent = 'D.platform.fetchBeaconsByArea が利用できません';
        statusDiv.className = 'dbsext-beacons-error';
        updatePanelState(panel, selectedAreaId);
      }
      return;
    }

    D.platform.fetchBeaconsByArea(selectedAreaId)
      .then(function (result) {
        var res = result || { rows: [], portCount: 0, failedPortCount: 0 };
        // A1 → B → A2 の順に開始し、A2 より後で古い A1 が完了しても、
        // A2 の新しいキャッシュを上書きさせない。
        if (latestGenerationByArea[selectedAreaId] === gen) {
          cacheMap[selectedAreaId] = {
            rows: res.rows || [],
            portCount: res.portCount || 0,
            failedPortCount: res.failedPortCount || 0,
            timestamp: Date.now()
          };
        }
        if (activeRequest && activeRequest.generation === gen) {
          isFetching = false;
          activeRequest = null;
        }
        if (gen === currentGeneration && isPanelConnected(panel, selectedAreaId)) {
          renderTableData(panel, res.rows || [], res.portCount || 0, res.failedPortCount || 0);
          updatePanelState(panel, selectedAreaId);
        }
      })
      .catch(function (err) {
        if (activeRequest && activeRequest.generation === gen) {
          isFetching = false;
          activeRequest = null;
        }
        if (gen === currentGeneration && isPanelConnected(panel, selectedAreaId)) {
          var msg = (err && err.message) ? err.message : String(err);
          statusDiv.textContent = 'ビーコン一覧の取得に失敗しました: ' + msg;
          statusDiv.className = 'dbsext-beacons-error';
          if (tableWrap) {
            while (tableWrap.firstChild) tableWrap.removeChild(tableWrap.firstChild); // dbsext:own-ui
          }
          updatePanelState(panel, selectedAreaId);
        }
      });
  }

  /**
   * 取得結果データからテーブル・警告の表示を行う（XSS対策: textContent で挿入）
   */
  function renderTableData(panel, rawRows, portCount, failedPortCount) {
    var statusDiv = panel.querySelector('[data-dbsext-beacons-status="1"]');
    var tableWrap = panel.querySelector('.dbsext-beacons-table-wrap');
    if (!statusDiv || !tableWrap) return;

    // 前回の表示をクリア // dbsext:own-ui
    while (statusDiv.firstChild) {
      statusDiv.removeChild(statusDiv.firstChild); // dbsext:own-ui
    }
    while (tableWrap.firstChild) {
      tableWrap.removeChild(tableWrap.firstChild); // dbsext:own-ui
    }

    if (failedPortCount > 0) {
      statusDiv.textContent = '一部のポート（' + failedPortCount + '件）の取得に失敗しました。';
      statusDiv.className = 'dbsext-beacons-warn';
    } else {
      statusDiv.textContent = '';
      statusDiv.className = '';
    }

    var deduped = dedupeBeacons(rawRows);
    var sorted = sortBeacons(deduped);

    if (sorted.length === 0) {
      if (failedPortCount === 0) {
        statusDiv.textContent = '対象エリア内にポート割当済みビーコンはありません。';
        statusDiv.className = '';
      }
      return;
    }

    var table = document.createElement('table');
    table.setAttribute('data-dbsext-beacons-table', '1');

    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    var tbody = document.createElement('tbody');

    var columns = [
      { label: 'ビーコン識別番号', value: function (item) { return item.portBeaconUniqueCode || item.portBeaconId || ''; } },
      { label: 'ビーコン種別', value: function (item) { return formatBeaconType(item.beaconType); } },
      { label: 'ポート識別番号', value: function (item) { return item.portUniqueCode || ''; } },
      { label: 'ポート名', value: function (item) { return item.portNameJa || ''; } },
      { label: 'ビーコン電圧', value: function (item) {
        var val = item.portBeaconElectricVoltage;
        return (val !== null && val !== undefined && val !== '') ? String(val) : 'ー';
      } },
      { label: 'ビーコンバッテリー残量[%]', value: function (item) {
        var val = item.batteryRemainingAmount;
        return (val !== null && val !== undefined && val !== '') ? String(val) : 'ー';
      } },
      { label: '最終受信日時', value: function (item) { return item.lastReceivedTs || ''; } }
    ];
    var filters = [];
    var sortButtons = [];
    var sortColumn = -1;
    var sortDirection = 1;

    function updateSortLabels() {
      for (var i = 0; i < sortButtons.length; i++) {
        var suffix = '';
        if (i === sortColumn) suffix = sortDirection === 1 ? ' ▲' : ' ▼';
        sortButtons[i].textContent = columns[i].label + suffix;
      }
    }

    function renderVisibleRows() {
      while (tbody.firstChild) tbody.removeChild(tbody.firstChild); // dbsext:own-ui

      var indexed = [];
      for (var i = 0; i < sorted.length; i++) {
        var matches = true;
        for (var f = 0; f < columns.length; f++) {
          var needle = String(filters[f].value || '').toLocaleLowerCase();
          if (needle && String(columns[f].value(sorted[i])).toLocaleLowerCase().indexOf(needle) === -1) {
            matches = false;
            break;
          }
        }
        if (matches) indexed.push({ item: sorted[i], originalIndex: i });
      }

      if (sortColumn >= 0) {
        indexed.sort(function (a, b) {
          var valueA = String(columns[sortColumn].value(a.item));
          var valueB = String(columns[sortColumn].value(b.item));
          var cmp = valueA.localeCompare(valueB, undefined, { numeric: true, sensitivity: 'base' });
          if (cmp === 0) cmp = a.originalIndex - b.originalIndex;
          return cmp * sortDirection;
        });
      }

      if (indexed.length === 0) {
        var emptyRow = document.createElement('tr');
        var emptyCell = document.createElement('td');
        emptyCell.setAttribute('colspan', String(columns.length));
        emptyCell.className = 'dbsext-beacons-empty';
        emptyCell.textContent = '絞り込み条件に一致するビーコンはありません。';
        emptyRow.appendChild(emptyCell);
        tbody.appendChild(emptyRow);
        return;
      }

      for (var r = 0; r < indexed.length; r++) {
        var tr = document.createElement('tr');
        for (var c = 0; c < columns.length; c++) {
          var td = document.createElement('td');
          var cellValue = columns[c].value(indexed[r].item);
          if (c === 0 && /^[A-Za-z0-9]{10}$/.test(String(cellValue))) {
            var codeButton = document.createElement('button');
            codeButton.setAttribute('type', 'button');
            codeButton.className = 'dbsext-beacons-code-link';
            codeButton.textContent = cellValue;
            (function (beaconCode) {
              codeButton.addEventListener('click', function () {
                openNativeBeaconPopup(panel, beaconCode);
              });
            })(String(cellValue));
            td.appendChild(codeButton);
          } else {
            td.textContent = cellValue;
          }
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
    }

    for (var h = 0; h < columns.length; h++) {
      (function (columnIndex) {
        var th = document.createElement('th');
        var sortButton = document.createElement('button');
        sortButton.setAttribute('type', 'button');
        sortButton.className = 'dbsext-beacons-sort';
        sortButton.setAttribute('title', 'クリックで並べ替え');
        sortButton.addEventListener('click', function () {
          if (sortColumn === columnIndex) {
            sortDirection = sortDirection * -1;
          } else {
            sortColumn = columnIndex;
            sortDirection = 1;
          }
          updateSortLabels();
          renderVisibleRows();
        });
        sortButtons.push(sortButton);
        th.appendChild(sortButton);

        var filterInput = document.createElement('input');
        filterInput.setAttribute('type', 'text');
        filterInput.className = 'dbsext-beacons-filter';
        filterInput.setAttribute('placeholder', '絞り込み');
        filterInput.setAttribute('aria-label', columns[columnIndex].label + 'で絞り込み');
        filterInput.addEventListener('input', function () {
          renderVisibleRows();
        });
        filters.push(filterInput);
        th.appendChild(filterInput);
        headerRow.appendChild(th);
      })(h);
    }
    updateSortLabels();
    thead.appendChild(headerRow);
    table.appendChild(thead);
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    renderVisibleRows();
  }

  function ensureAutoFetch(panel, selectedAreaId) {
    if (!panel || !selectedAreaId) return;
    if (panel.__dbsextBeaconAutoArea === selectedAreaId) return;
    panel.__dbsextBeaconAutoArea = selectedAreaId;
    handleFetchClick(panel);
  }

  function isNodeConnected(node) {
    var cur = node;
    while (cur) {
      if (cur === document.body || cur === document.documentElement) return true;
      cur = cur.parentNode;
    }
    return false;
  }

  function findNativeTableSection(table) {
    var cur = table;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (cur.classList && cur.classList.contains('mb-4')) return cur;
      cur = cur.parentNode;
    }
    return null;
  }

  function findNativeResult(code) {
    var tables = document.querySelectorAll('.el-table:not([data-dbsext-beacons-table])');
    for (var i = 0; i < tables.length; i++) {
      var cells = tables[i].querySelectorAll('td');
      for (var c = 0; c < cells.length; c++) {
        if (String(cells[c].textContent || '').trim() === code) {
          var section = findNativeTableSection(tables[i]);
          var row = cells[c];
          while (row && row !== tables[i] && String(row.tagName || '').toUpperCase() !== 'TR') {
            row = row.parentNode;
          }
          if (section) return {
            table: tables[i],
            section: section,
            row: row && String(row.tagName || '').toUpperCase() === 'TR' ? row : null,
            cell: cells[c]
          };
        }
      }
    }
    return null;
  }

  function findNativeSearchControls() {
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      if (String(buttons[i].textContent || '').replace(/[\s\u3000]+/g, '').trim() !== '検索') continue;
      var container = buttons[i].parentNode;
      while (container && container !== document.body && container !== document.documentElement) {
        var input = container.querySelector && container.querySelector('input');
        if (input) return { input: input, button: buttons[i] };
        container = container.parentNode;
      }
    }
    return null;
  }

  function setNativeInputValue(input, value) {
    var proto = global.HTMLInputElement && global.HTMLInputElement.prototype;
    var descriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(input, value);
    else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function findNativeCancelButton() {
    if (!nativePopupState || !nativePopupState.section) return null;
    var buttons = nativePopupState.section.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var label = String(buttons[i].textContent || '').replace(/[\s\u3000]+/g, '');
      if (label !== '取消' && label !== 'キャンセル') continue;
      if (buttons[i].disabled || buttons[i].hidden) continue;
      if (typeof buttons[i].getClientRects === 'function' && buttons[i].getClientRects().length === 0) continue;
      if (typeof global.getComputedStyle === 'function') {
        var style = global.getComputedStyle(buttons[i]);
        if (style && (style.display === 'none' || style.visibility === 'hidden')) continue;
      }
      return buttons[i];
    }
    return null;
  }

  function cancelNativeEditIfActive() {
    var cancelButton = findNativeCancelButton();
    if (!cancelButton || typeof cancelButton.click !== 'function') return false;
    cancelButton.click();
    return true;
  }

  function closeNativeTablePopup(cancelPending) {
    if (cancelPending !== false) nativeSearchGeneration++;
    if (!nativePopupState) return;
    cancelNativeEditIfActive();
    if (nativePopupState.section && nativePopupState.section.classList) {
      nativePopupState.section.classList.remove('dbsext-beacons-native-modal-open');
    }
    if (nativePopupState.root && nativePopupState.root.parentNode) {
      nativePopupState.root.parentNode.removeChild(nativePopupState.root); // dbsext:own-ui
    }
    nativePopupState = null;
  }

  function showNativeTablePopup(code, result) {
    closeNativeTablePopup(false);
    var root = document.createElement('div');
    root.setAttribute('data-dbsext-beacons-native-modal', '1');

    var backdrop = document.createElement('button');
    backdrop.setAttribute('type', 'button');
    backdrop.className = 'dbsext-beacons-native-backdrop';
    backdrop.setAttribute('aria-label', '標準ビーコン情報を閉じる');
    backdrop.addEventListener('click', function () { closeNativeTablePopup(); });
    root.appendChild(backdrop);

    var header = document.createElement('div');
    header.className = 'dbsext-beacons-native-header';
    var title = document.createElement('strong');
    title.textContent = '標準ビーコン情報: ' + code;
    header.appendChild(title);
    var note = document.createElement('span');
    note.textContent = '編集・削除はポータル標準の操作です。';
    header.appendChild(note);
    var closeButton = document.createElement('button');
    closeButton.setAttribute('type', 'button');
    closeButton.className = 'dbsext-beacons-native-close';
    closeButton.textContent = '閉じる';
    closeButton.addEventListener('click', function () { closeNativeTablePopup(); });
    header.appendChild(closeButton);
    root.appendChild(header);

    document.body.appendChild(root);
    result.section.classList.add('dbsext-beacons-native-modal-open');
    nativePopupState = { root: root, section: result.section, table: result.table, code: code };
  }

  function waitForNativeResult(code, generation, triggerSearch) {
    var beforeResult = findNativeResult(code);
    if (typeof MutationObserver === 'undefined') {
      triggerSearch();
      var immediate = findNativeResult(code);
      return immediate ? Promise.resolve(immediate) :
        Promise.reject(new Error('標準検索結果を確認できませんでした。'));
    }

    var standardTable = document.querySelector('.el-table:not([data-dbsext-beacons-table])');
    var standardSection = standardTable && findNativeTableSection(standardTable);
    var observedRoot = (standardSection && standardSection.parentNode) || document.body;

    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = null;
      var observer = new MutationObserver(function () {
        if (settled) return;
        if (generation !== nativeSearchGeneration) {
          settled = true;
          observer.disconnect();
          clearTimeout(timer);
          reject(new Error('標準検索が取り消されました。'));
          return;
        }
        var result = findNativeResult(code);
        if (!result) return;
        if (beforeResult && result.table === beforeResult.table &&
            result.row === beforeResult.row && result.cell === beforeResult.cell) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        resolve(result);
      });
      observer.observe(observedRoot, { childList: true, subtree: true, characterData: true });
      timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        observer.disconnect();
        reject(new Error('標準検索結果の表示を8秒以内に確認できませんでした。'));
      }, 8000);

      triggerSearch();
      if (!beforeResult) {
        var immediate = findNativeResult(code);
        if (immediate && !settled) {
          settled = true;
          observer.disconnect();
          clearTimeout(timer);
          resolve(immediate);
        }
      }
    });
  }

  function openNativeBeaconPopup(panel, rawCode) {
    var code = String(rawCode || '').trim();
    var statusDiv = panel.querySelector('[data-dbsext-beacons-status]');
    if (!/^[A-Za-z0-9]{10}$/.test(code)) {
      if (statusDiv) {
        statusDiv.textContent = '標準検索に渡せる10桁のビーコン識別番号ではありません。';
        statusDiv.className = 'dbsext-beacons-error';
      }
      return;
    }

    var controls = findNativeSearchControls();
    if (!controls) {
      if (statusDiv) {
        statusDiv.textContent = 'ポータル標準のビーコン検索欄を確認できませんでした。';
        statusDiv.className = 'dbsext-beacons-error';
      }
      return;
    }

    closeNativeTablePopup();
    var generation = ++nativeSearchGeneration;
    setNativeInputValue(controls.input, code);
    waitForNativeResult(code, generation, function () { controls.button.click(); }).then(function (result) {
      if (generation !== nativeSearchGeneration || !/^\/beacons(\/|$)/.test(location.pathname)) return;
      showNativeTablePopup(code, result);
    }).catch(function (err) {
      if (generation !== nativeSearchGeneration || !statusDiv) return;
      statusDiv.textContent = err && err.message ? err.message : '標準検索結果を表示できませんでした。';
      statusDiv.className = 'dbsext-beacons-error';
    });
  }

  D.beacons = {
    apply: function () {
      if (typeof document === 'undefined' || !document.body) return;
      injectSidebarMenu();
      renderPanel();
    },

    // テスト用の内部状態アクセス
    _clearCache: function () {
      cacheMap = Object.create(null);
      latestGenerationByArea = Object.create(null);
      isFetching = false;
      currentGeneration = 0;
      activeRequest = null;
      pendingSidebarNavigation = false;
      closeNativeTablePopup();
    },
    _getCache: function () {
      return cacheMap;
    },
    _isValidPortalId: isValidPortalId,
    _formatBeaconType: formatBeaconType,
    _dedupeBeacons: dedupeBeacons,
    _sortBeacons: sortBeacons
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);


/**
 * DBSEXT テーブル列制御モジュール
 *
 * 目的: 車両情報（/vehicles）の横長テーブル問題に対処するため、
 * 普段使われない操作系5列（メンテナンス、AT管理、解錠、再配置、AT一体型車両操作）を
 * 既定で隠し、必要なときだけトグルで表示する。
 *
 * 契約 §6 の遵守:
 * - DOMノードの削除・移動は一切行わない（display: none による表示制御のみ）
 * - 操作ボタン自体には一切介入しない
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  var ACTION_COLUMNS = [
    'メンテナンス',
    'AT管理',
    '解錠',
    '再配置',
    'AT一体型車両操作'
  ];

  var STORAGE_FEATURE = 'showActionCols';
  var UI_CONTAINER_ATTR = 'data-dbsext-table-columns';
  var TOGGLE_INPUT_ATTR = 'data-dbsext-action-toggle';
  var WIDTH_STYLE_ID = 'dbsext-table-columns-width';

  function getScreen() {
    if (typeof location === 'undefined' || !location.pathname) return '';
    return location.pathname;
  }

  function isVehiclesScreen() {
    var path = getScreen();
    // モック等で '/' や空の場合でも、テーブル内に該当操作列が存在すれば適用可能にするか、
    // または /vehicles を基本としつつテスト環境にも配慮
    return path.indexOf('/vehicles') >= 0 || path === '' || path === '/';
  }

  function getStorageKey(screen) {
    return 'dbsext:v1:' + (screen || '/') + ':' + STORAGE_FEATURE;
  }

  function loadToggleState(screen) {
    try {
      if (D.stateStore && typeof D.stateStore.load === 'function') {
        var val = D.stateStore.load(screen, STORAGE_FEATURE);
        if (val !== null && typeof val !== 'undefined') {
          return !!val;
        }
      }
      if (typeof localStorage !== 'undefined') {
        var raw = localStorage.getItem(getStorageKey(screen));
        if (raw !== null) {
          return raw === 'true';
        }
      }
    } catch (e) {}
    return false; // 既定は「隠す」（showActionCols = false）
  }

  function saveToggleState(screen, show) {
    try {
      if (D.stateStore && typeof D.stateStore.save === 'function') {
        D.stateStore.save(screen, STORAGE_FEATURE, show, { scope: 'local' });
      }
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(getStorageKey(screen), show ? 'true' : 'false');
      }
    } catch (e) {}
  }

  /**
   * 列の見出し名を取り出す。
   *
   * **`th.textContent` をそのまま使ってはいけない。**
   * `table-tools` が同じ th にソート矢印（`▲`）と絞り込み入力を**追加する**ため、
   * 見出しの文字列は `メンテナンス ▲` のように汚れる。
   * 素朴に完全一致で比べると**1列も一致せず、列が一つも隠れない**
   * （しかも「対象列なし」として静かに何もしないので気づけない）。
   *
   * `table-tools` は元の列名を `data-dbsext-orig-title` に控えているので、
   * まずそれを使う。無ければ自前UIを除いた文字列を組み立てる。
   * こうしておけば **モジュールの適用順に依存しない**。
   */
  function headerName(th) {
    var orig = th.getAttribute && th.getAttribute('data-dbsext-orig-title');
    if (orig) return String(orig).trim();

    if (typeof th.cloneNode === 'function') {
      var clone = th.cloneNode(true);
      var own = clone.querySelectorAll(
        '[data-dbsext-sort],[data-dbsext-filter],[data-dbsext-collapse-hint]'
      );
      for (var i = 0; i < own.length; i++) {
        if (own[i].parentNode) own[i].parentNode.removeChild(own[i]); // dbsext:own-ui
      }
      return (clone.textContent || '').trim();
    }
    return (th.textContent || '').trim();
  }

  function findActionColumnIndices(headerTable) {
    if (!headerTable) return [];
    var ths = headerTable.querySelectorAll('thead th, tr th');
    var indices = [];
    for (var i = 0; i < ths.length; i++) {
      var text = headerName(ths[i]);
      for (var k = 0; k < ACTION_COLUMNS.length; k++) {
        if (text === ACTION_COLUMNS[k]) {
          indices.push(i);
          break;
        }
      }
    }
    return indices;
  }

  function setColumnVisibility(table, indices, show) {
    if (!table || !indices || indices.length === 0) return;

    var headerTable = table.querySelector('table.el-table__header');
    var bodyTable = table.querySelector('table.el-table__body');

    var displayVal = show ? '' : 'none';
    var colWidthVal = show ? '' : '0px';

    // 1. ヘッダ colgroup & th
    if (headerTable) {
      var headerCols = headerTable.querySelectorAll('colgroup col');
      for (var c = 0; c < indices.length; c++) {
        var idx = indices[c];
        if (headerCols[idx]) {
          headerCols[idx].style.display = displayVal;
          if (!show) {
            if (!headerCols[idx].hasAttribute('data-dbsext-orig-width')) {
              headerCols[idx].setAttribute('data-dbsext-orig-width', headerCols[idx].getAttribute('width') || '');
            }
            headerCols[idx].style.width = colWidthVal;
          } else {
            // **元の値を代入し直してはいけない。**
            // 控えてある値は width 属性（例 "300"）で**単位が無い**ため、
            // `style.width = "300"` は不正な値として無視され、
            // 直前の `0px` が residual として残る。
            // 結果、「操作列を表示」にしても**列が潰れたまま**になり、
            // 中身が折り返して**見出し行が異常に高くなる**（実機で 89px → 272px）。
            // インラインの指定を消せば、元からある width 属性が効く。
            headerCols[idx].style.removeProperty('width');
          }
        }
      }

      var headerRows = headerTable.querySelectorAll('thead tr, tr');
      for (var r = 0; r < headerRows.length; r++) {
        var ths = headerRows[r].children;
        for (var h = 0; h < indices.length; h++) {
          var hIdx = indices[h];
          if (ths[hIdx]) {
            ths[hIdx].style.display = displayVal;
          }
        }
      }
    }

    // 2. ボディ colgroup & td
    if (bodyTable) {
      var bodyCols = bodyTable.querySelectorAll('colgroup col');
      for (var bc = 0; bc < indices.length; bc++) {
        var bIdx = indices[bc];
        if (bodyCols[bIdx]) {
          bodyCols[bIdx].style.display = displayVal;
          if (!show) {
            if (!bodyCols[bIdx].hasAttribute('data-dbsext-orig-width')) {
              bodyCols[bIdx].setAttribute('data-dbsext-orig-width', bodyCols[bIdx].getAttribute('width') || '');
            }
            bodyCols[bIdx].style.width = colWidthVal;
          } else {
            // ヘッダ側と同じ理由。単位の無い値を代入せず、インライン指定を消す
            bodyCols[bIdx].style.removeProperty('width');
          }
        }
      }

      var bodyRows = bodyTable.querySelectorAll('tbody tr');
      for (var br = 0; br < bodyRows.length; br++) {
        var tds = bodyRows[br].children;
        for (var d = 0; d < indices.length; d++) {
          var dIdx = indices[d];
          if (tds[dIdx]) {
            tds[dIdx].style.display = displayVal;
          }
        }
      }
    }

    shrinkTableWidth(headerTable, bodyTable, indices, show);

    // 表示列を戻すと表幅が 1944px → 3144px のように広がる。
    // 上部スクロールバーの中身も同じ幅へ再計測しないと、追加領域へ到達できない。
    if (D.tableWrap && typeof D.tableWrap.refresh === 'function') {
      D.tableWrap.refresh(table);
    }
  }

  /**
   * 隠した列のぶんだけ表の幅を詰める。
   *
   * **列を display:none にしただけでは表は狭くならない。**
   * Element Plus は `table.el-table__header` と `table.el-table__body` の両方に
   * **インラインで `width: 3144px` を固定**している（実機実測 2026-08-09）。
   * そのため列を隠しても幅はそのままで、**空白ができるだけで横スクロール量は減らない**。
   * 「操作列を隠せば横幅が減る」という狙いが、まったく実現していなかった。
   *
   * `width: auto` にすれば器の幅（1621px）まで縮むが、
   * 残る11列の指定幅の合計（約2044px）を下回るため、
   * **`table-layout: fixed` の下で各列が圧縮され、文字が切れる**。
   * 情報が見えなくなるのは本末転倒なので採らない。
   *
   * さらに **EP はウィンドウのリサイズのたびにインライン幅を書き戻す**ため、
   * JS で `style.width` を書いても消される。そこで **`!important` のスタイルシート**で
   * 指定する（`!important` の作者スタイルはインラインスタイルに優先する）。
   *
   * ここでは **元の幅から、隠した列の幅の合計を引く**。
   * 残る列の幅は変わらないので文字は切れない。
   * 横スクロールは残るが、無意味な空白ぶんは確実に減る。
   * （**列幅そのものを詰めるのは案2**。実データでの実測が要るため別途）
   */
  function shrinkTableWidth(headerTable, bodyTable, indices, show) {
    if (typeof document === 'undefined' || !document.head) return;

    var style = document.getElementById(WIDTH_STYLE_ID);

    if (show) {
      if (style && style.parentNode) style.parentNode.removeChild(style); // dbsext:own-ui
      return;
    }

    var base = 0;
    var hidden = 0;
    var cols = headerTable ? headerTable.querySelectorAll('colgroup col') : [];
    for (var i = 0; i < cols.length; i++) {
      var w = parseFloat(
        cols[i].getAttribute('data-dbsext-orig-width') || cols[i].getAttribute('width')
      );
      if (isNaN(w)) continue;
      base += w;
      for (var k = 0; k < indices.length; k++) {
        if (indices[k] === i) { hidden += w; break; }
      }
    }

    if (!(hidden > 0) || !(base - hidden > 0)) return;
    var desired = base - hidden;

    var css =
      'table.el-table__header, table.el-table__body { width: ' + desired + 'px !important; }';

    if (!style) {
      style = document.createElement('style');
      style.id = WIDTH_STYLE_ID;
      // 自前の要素なので own 扱い（core.js の ATTR_KIND 参照）
      style.setAttribute(UI_CONTAINER_ATTR, '1');
      document.head.appendChild(style);
    }
    if (style.textContent !== css) style.textContent = css;
  }

  function ensureToggleUI(table, screen, show, onToggle) {
    if (!table || !table.parentNode) return;

    var existing = table.parentNode.querySelector('[' + UI_CONTAINER_ATTR + ']');
    if (existing) {
      var input = existing.querySelector('[' + TOGGLE_INPUT_ATTR + ']');
      if (input) {
        input.checked = show;
      }
      return;
    }

    var bar = document.createElement('div');
    bar.setAttribute(UI_CONTAINER_ATTR, '1');
    bar.style.cssText = 'display:flex; align-items:center; justify-content:flex-end; padding:4px 8px; margin-bottom:4px; font-size:13px;';

    var label = document.createElement('label');
    label.style.cssText = 'display:inline-flex; align-items:center; cursor:pointer; color:#303133; font-weight:500; user-select:none;';

    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute(TOGGLE_INPUT_ATTR, '1');
    checkbox.checked = show;
    checkbox.style.cssText = 'margin-right:6px; cursor:pointer; accent-color:#0b5cab; width:15px; height:15px;';

    checkbox.addEventListener('change', function () {
      var newState = checkbox.checked;
      saveToggleState(screen, newState);
      if (typeof onToggle === 'function') {
        onToggle(newState);
      }
    });

    var span = document.createElement('span');
    span.textContent = '操作列を表示';

    label.appendChild(checkbox);
    label.appendChild(span);
    bar.appendChild(label);

    table.parentNode.insertBefore(bar, table);
  }

  D.tableColumns = {
    ACTION_COLUMNS: ACTION_COLUMNS,
    STORAGE_FEATURE: STORAGE_FEATURE,

    apply: function () {
      if (typeof document === 'undefined') return;

      var screen = getScreen();
      // /vehicles 以外の明示的な他画面（例: /users, /ports 等）では何もしない
      if (screen && screen !== '/' && screen.indexOf('/vehicles') < 0) {
        return;
      }

      var tables = document.querySelectorAll('.el-table');
      if (!tables || tables.length === 0) return;

      var show = loadToggleState(screen);

      for (var t = 0; t < tables.length; t++) {
        var table = tables[t];
        var headerTable = table.querySelector('table.el-table__header');
        if (!headerTable) continue;

        var indices = findActionColumnIndices(headerTable);
        // 対象列が1つも無ければ何もしない
        if (indices.length === 0) continue;

        (function (tbl, idxs) {
          ensureToggleUI(tbl, screen, show, function (newShow) {
            setColumnVisibility(tbl, idxs, newShow);
          });
          setColumnVisibility(tbl, idxs, show);
        })(table, indices);
      }
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);


/**
 * DBSEXT テーブルツール（並べ替え・絞り込み）モジュール
 * Element Plus el-table のヘッダに操作UIを追加し、並べ替え・絞り込みを行う
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  var tableStates = {};

  function comparePortKeys(keyA, keyB) {
    if (keyA[0] !== keyB[0]) return keyA[0] - keyB[0];
    if (keyA[1] !== keyB[1]) return keyA[1].localeCompare(keyB[1]);
    if (keyA[2] !== keyB[2]) return keyA[2] - keyB[2];
    return keyA[3].localeCompare(keyB[3], undefined, { numeric: true, sensitivity: 'base' });
  }

  function portSortKey(name) {
    if (name === null || name === undefined) {
      return [1, '', 0, ''];
    }
    var str = String(name);
    var trimmed = str.trim();
    var m = trimmed.match(/^\s*([A-Za-z]*)-?(\d+)/);
    if (m) {
      var letters = m[1].toUpperCase();
      var num = Number(m[2]);
      return [0, letters, num, str];
    } else {
      return [1, '', 0, str];
    }
  }

  function hasActiveFilter(state) {
    for (var fCol in state.filterValues) {
      if (state.filterValues[fCol] && state.filterValues[fCol].length > 0) return true;
    }
    return false;
  }

  function rowCheckbox(row) {
    return row && row.querySelector ? row.querySelector('input[type=checkbox]') : null;
  }

  function setRowChecked(row, checked) {
    var input = rowCheckbox(row);
    if (!input || !!input.checked === checked) return;
    // checked を直接書くだけでは Element Plus の選択モデルへ伝わらない。
    // ネイティブ click でポータル自身の変更処理を通す（選択状態だけ。更新通信は発生しない）。
    input.click();
  }

  /** フィルタで非表示になった行を選択対象から外す */
  function deselectHiddenRows(table) {
    var rows = table.querySelectorAll('table.el-table__body tbody tr');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].style.display === 'none') setRowChecked(rows[i], false);
    }
  }

  /**
   * 見出しの全選択を、フィルタで表示中の行だけへ限定する。
   * フィルタ無しではポータル標準の全選択をそのまま使う。
   */
  function hookVisibleSelectAll(table, state) {
    var headerTable = table.querySelector('table.el-table__header');
    if (!headerTable) return;
    var master = headerTable.querySelector('input[type=checkbox]');
    if (!master || master.__dbsextVisibleSelectHooked) return;
    master.__dbsextVisibleSelectHooked = true;

    master.addEventListener('click', function (event) {
      if (!hasActiveFilter(state)) return;

      // 標準処理に任せると非表示行まで選択されるため、フィルタ中だけ横取りする。
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === 'function') event.stopImmediatePropagation();

      var rows = table.querySelectorAll('table.el-table__body tbody tr');
      var visible = [];
      var allVisibleChecked = true;
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].style.display === 'none') continue;
        visible.push(rows[i]);
        var input = rowCheckbox(rows[i]);
        if (!input || !input.checked) allVisibleChecked = false;
      }

      var selectVisible = visible.length > 0 && !allVisibleChecked;
      for (var j = 0; j < rows.length; j++) {
        var shouldCheck = rows[j].style.display !== 'none' && selectVisible;
        setRowChecked(rows[j], shouldCheck);
      }

      // Element Plus は全行基準だと「一部選択」と判定するが、ここでは見えている全行が基準。
      // 実 input の表示だけを最後に合わせる（次のポータル再描画時は再度計算される）。
      if (typeof setTimeout === 'function') {
        setTimeout(function () {
          master.checked = selectVisible;
          master.indeterminate = false;
        }, 0);
      }
    }, true);
  }

  function applyFilterAndSort(table, state, ths) {
    var bodyTable = table.querySelector('table.el-table__body');
    if (!bodyTable) return;

    var tbody = bodyTable.querySelector('tbody');
    if (!tbody) return;

    var trs = bodyTable.querySelectorAll('tbody tr');
    if (trs.length === 0) return;

    var trArray = Array.prototype.slice.call(trs);

    // 1. 絞り込み処理
    var filtering = hasActiveFilter(state);

    for (var i = 0; i < trArray.length; i++) {
      var tr = trArray[i];
      var show = true;
      if (filtering) {
        var cells = tr.children;
        for (var colIdxStr in state.filterValues) {
          var filterVal = state.filterValues[colIdxStr];
          if (filterVal && filterVal.length > 0) {
            var colIdx = Number(colIdxStr);
            var cell = cells[colIdx];
            var cellText = cell ? cell.textContent.trim() : '';
            if (cellText.toLowerCase().indexOf(filterVal.toLowerCase()) === -1) {
              show = false;
              break;
            }
          }
        }
      }
      tr.style.display = show ? '' : 'none';
    }

    // フィルタ変更前に選ばれていた行が隠れた場合も、一括処理の対象へ残さない。
    if (filtering) deselectHiddenRows(table);

    // 2. 並べ替え処理
    if (state.sortColIndex !== null && state.sortColIndex !== undefined) {
      var sortCol = state.sortColIndex;
      var sortOrder = state.sortOrder || 'asc';
      var th = ths[sortCol];
      var colTitle = th ? (th.getAttribute('data-dbsext-orig-title') || th.textContent.trim()) : '';

      var isPortCol = (colTitle === 'ポート名' || colTitle === 'ポート');

      var isAllNumeric = true;
      if (!isPortCol) {
        var validCount = 0;
        for (var j = 0; j < trArray.length; j++) {
          var tdNode = trArray[j].children[sortCol];
          var txt = tdNode ? tdNode.textContent.trim() : '';
          if (txt !== '') {
            validCount++;
            if (isNaN(Number(txt))) {
              isAllNumeric = false;
              break;
            }
          }
        }
        if (validCount === 0) {
          isAllNumeric = false;
        }
      }

      trArray.sort(function (trA, trB) {
        var tdA = trA.children[sortCol];
        var tdB = trB.children[sortCol];
        var textA = tdA ? tdA.textContent.trim() : '';
        var textB = tdB ? tdB.textContent.trim() : '';

        var res = 0;
        if (isPortCol) {
          var keyA = portSortKey(textA);
          var keyB = portSortKey(textB);
          res = comparePortKeys(keyA, keyB);
        } else if (isAllNumeric) {
          var numA = textA === '' ? -Infinity : Number(textA);
          var numB = textB === '' ? -Infinity : Number(textB);
          res = numA - numB;
        } else {
          res = textA.localeCompare(textB, undefined, { numeric: true, sensitivity: 'base' });
        }

        return sortOrder === 'desc' ? -res : res;
      });

      for (var k = 0; k < trArray.length; k++) {
        tbody.appendChild(trArray[k]);
      }
    }
  }

  function updateHeaderUI(ths, state) {
    for (var c = 0; c < ths.length; c++) {
      var th = ths[c];

      // ソート表示更新
      var sortSpan = th.querySelector('[data-dbsext-sort]');
      if (sortSpan) {
        if (state.sortColIndex === c) {
          sortSpan.textContent = state.sortOrder === 'asc' ? ' ▲' : ' ▼';
          sortSpan.style.opacity = '1';
        } else {
          sortSpan.textContent = ' ▲';
          sortSpan.style.opacity = '0.3';
        }
      }

      // 絞り込み入力値同期
      var filterInput = th.querySelector('[data-dbsext-filter]');
      if (filterInput) {
        var savedVal = state.filterValues[c] || '';
        if (filterInput.value !== savedVal) {
          filterInput.value = savedVal;
        }
      }
    }
  }

  D.tableTools = {
    portSortKey: portSortKey,

    // 検証用。DOMを伴うフィルタ／選択連動を実ブラウザ無しでも再現する。
    _applyFilterAndSort: applyFilterAndSort,
    _hookVisibleSelectAll: hookVisibleSelectAll,

    apply: function () {
      if (typeof document === 'undefined') return;

      var tables = document.querySelectorAll('.el-table');
      if (!tables || tables.length === 0) return;

      var pathname = (typeof location !== 'undefined') ? location.pathname : '';

      for (var t = 0; t < tables.length; t++) {
        var table = tables[t];
        var headerTable = table.querySelector('table.el-table__header');
        var bodyTable = table.querySelector('table.el-table__body');
        if (!headerTable || !bodyTable) continue;

        var ths = headerTable.querySelectorAll('thead th, th');
        // **行数は見ない。** 行が0件でも列UIはヘッダに付ける。
        // 「先に絞り込み条件を入れてから検索したい」場面で使えないと不便であり、
        // 実機では検索するまで表が空なので、行を待つと一度もUIが付かない。
        if (ths.length === 0) continue;

        var stateKey = pathname + '#' + t;
        if (!tableStates[stateKey]) {
          tableStates[stateKey] = {
            sortColIndex: null,
            sortOrder: null,
            filterValues: {}
          };

          // 初回既定の並べ替え: ポート名またはポートの列があれば昇順1回
          for (var i = 0; i < ths.length; i++) {
            var title = ths[i].getAttribute('data-dbsext-orig-title') || ths[i].textContent.trim();
            if (title === 'ポート名' || title === 'ポート') {
              tableStates[stateKey].sortColIndex = i;
              tableStates[stateKey].sortOrder = 'asc';
              break;
            }
          }
        }

        var state = tableStates[stateKey];
        hookVisibleSelectAll(table, state);
        var isFirstUIBuild = !table.hasAttribute('data-dbsext-tabled');

        if (isFirstUIBuild) {
          table.setAttribute('data-dbsext-tabled', '1');

          for (var c = 0; c < ths.length; c++) {
            (function (colIndex) {
              var th = ths[colIndex];
              var origTitle = th.textContent.trim();
              th.setAttribute('data-dbsext-orig-title', origTitle);

              // ソートトリガー
              var sortSpan = document.createElement('span');
              sortSpan.setAttribute('data-dbsext-sort', '1');
              sortSpan.style.cursor = 'pointer';
              sortSpan.style.userSelect = 'none';
              sortSpan.style.marginLeft = '4px';
              sortSpan.style.fontSize = '11px';
              sortSpan.textContent = ' ▲';
              sortSpan.style.opacity = '0.3';

              sortSpan.addEventListener('click', function (e) {
                e.stopPropagation();
                if (state.sortColIndex === colIndex) {
                  state.sortOrder = (state.sortOrder === 'asc') ? 'desc' : 'asc';
                } else {
                  state.sortColIndex = colIndex;
                  state.sortOrder = 'asc';
                }
                updateHeaderUI(ths, state);
                applyFilterAndSort(table, state, ths);
              });

              // 絞り込み入力
              //
              // **見出しの高さを増やしすぎないこと。**
              // 実機では自前UIのせいで見出しが 89px まで伸びていた（現場から指摘）。
              // 表は縦にも長いので、見出しが高いほど**一度に見える行数が減る**。
              // 余白と文字を詰め、入力欄の高さを 18px に固定する。
              var filterDiv = document.createElement('div');
              filterDiv.style.marginTop = '2px';
              filterDiv.style.lineHeight = '0';

              var filterInput = document.createElement('input');
              filterInput.type = 'text';
              filterInput.setAttribute('data-dbsext-filter', '1');
              filterInput.placeholder = '絞り込み';
              filterInput.style.width = '100%';
              filterInput.style.height = '18px';
              filterInput.style.lineHeight = '16px';
              filterInput.style.padding = '0 4px';
              filterInput.style.fontSize = '11px';
              filterInput.style.border = '1px solid #c8ccd4';
              filterInput.style.borderRadius = '3px';
              filterInput.style.boxSizing = 'border-box';

              filterInput.addEventListener('click', function (e) {
                e.stopPropagation();
              });
              filterInput.addEventListener('keydown', function (e) {
                e.stopPropagation();
              });
              filterInput.addEventListener('input', function () {
                state.filterValues[colIndex] = filterInput.value;
                applyFilterAndSort(table, state, ths);
              });

              th.appendChild(sortSpan);
              filterDiv.appendChild(filterInput);
              th.appendChild(filterDiv);
            })(c);
          }
        }

        updateHeaderUI(ths, state);
        applyFilterAndSort(table, state, ths);
      }
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
