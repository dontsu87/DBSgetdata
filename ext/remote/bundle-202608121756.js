/**
 * DBSEXT 名前空間および設定定義
 * モジュール契約 §1, §2 に基づく基盤定義
 */
(function (global) {
  'use strict';

  global.DBSEXT = global.DBSEXT || {};
  var D = global.DBSEXT;

  D.VERSION = '202608121756';

  D.CONFIG = {
    PORTAL_ORIGIN: 'https://mg.docomo-cycle.jp',
    MAP_APP_URL:   'https://dontsu87.github.io/DBSgetdata/',
    GUIDE_URL:     'https://dontsu87.github.io/DBSgetdata/ext/',
    ACCENT:        '#0b5cab',   // 拡張適用中を示す青
    ACCENT_DARK:   '#083f75',
    // マップアプリが知っている全エリア（コードと名前）
    KNOWN_AREAS: ['金沢', '福井', '小松', '敦賀', '上田千曲広域', '出雲・松江・境港'],
    KNOWN_AREA_CODES: ['FKI', 'KMT', 'KNZ', 'SNN', 'SPS', 'TRG'],
    // エリアコード → 日本語名（手動選択UI用）
    AREA_CODE_TO_NAME: { FKI: '福井', KMT: '小松', KNZ: '金沢', SNN: '上田千曲広域', SPS: '出雲・松江・境港', TRG: '敦賀' },
    NAME_TO_CODE: { '福井': 'FKI', '小松': 'KMT', '金沢': 'KNZ', '上田千曲広域': 'SNN', '出雲・松江・境港': 'SPS', '敦賀': 'TRG' },
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

  // **`data-dbsext-*` 属性の分類表。新しい属性を足したら、必ずここに登録する。**
  //
  //   'own-root' … 拡張が作った**入れ物**。中に注釈の無い子孫（tbody/tr/td 等）を持つ。
  //                `closest()` の対象になる（＝子孫の変化も自分の仕業と判定できる）
  //   'own-leaf' … 拡張が作った要素だが、中に自前の子孫構造を持たない（印・入力欄など）
  //   'mark'     … **ポータルの既存要素**に付ける目印（中の変化は外部の変化）
  //
  // 分類を間違えると、
  // 「SPAで表が差し替わっても再適用されない」または「自己発火で無限ループ」になる。
  //
  // ここを区別せず「`data-dbsext-` で始まる属性があれば自前UI」と判定すると、
  // `.el-table`（`data-dbsext-tabled` / `data-dbsext-wrap` が付く）を対象にした
  // MutationRecord が全部「自分の仕業」になり、**SPAが表を差し替えても
  // table-tools が再適用されない**。過去に同じ性質の欠陥を1件出している
  // （`isDbsextNode` が祖先を遡り、body配下すべてを自前と誤判定していた）。
  //
  // 逆に **`own-root` の登録を忘れると**、その入れ物の中で自分が起こした変化が
  // 「外部の変化」と誤判定され、**キーを1文字打つたびに全モジュールの再適用が走る**。
  // 実際に `data-dbsext-vehicle-problems` でこれが起きていた（2026-08-10 実測で検出）。
  // 原因は、この表と `OWN_UI_SELECTOR` を**手で二重管理**していたこと。
  // そこで **`OWN_UI_SELECTOR` はこの表から生成する**（下）。もう片方だけ直すことはできない。
  var ATTR_KIND = {
    // --- 自前UIの入れ物（closest の対象） ---
    'data-dbsext-upsell': 'own-root',
    'data-dbsext-launcher': 'own-root',
    'data-dbsext-launcher-panel': 'own-root',
    'data-dbsext-net-status': 'own-root',
    'data-dbsext-loading-mask': 'own-root',
    'data-dbsext-top-indicator': 'own-root',
    'data-dbsext-error-banner': 'own-root',
    'data-dbsext-state-forms': 'own-root',
    'data-dbsext-table-columns': 'own-root',
    'data-dbsext-top-scrollbar': 'own-root',   // 見出しの上に置く横スクロールバー
    'data-dbsext-beacons-panel': 'own-root',
    // **ポータルの標準表を包む**入れ物。中身はポータルのDOMだが、
    // モーダル表示中はこちらが主導権を持つため own として扱う（従来からの挙動）。
    'data-dbsext-beacons-native-modal': 'own-root',
    'data-dbsext-beacons-link': 'own-root',
    'data-dbsext-beacons-table': 'own-root',
    'data-dbsext-beacons-status': 'own-root',
    'data-dbsext-vehicle-problems': 'own-root',
    'data-dbsext-vp-table': 'own-root',
    // 「オリジナルに戻す」トグルボタン。own-root にする理由: 自前UI一括非表示の際、
    // このボタン自身とその中身だけは closest() で除外して常に見えるようにする
    'data-dbsext-original-view': 'own-root',
    // ポート一括操作（契約§6の限定例外。AGENTS.md参照）
    'data-dbsext-port-bulk-panel': 'own-root',

    // --- 自前UIだが入れ物ではないもの ---
    'data-dbsext-skin': 'own-leaf',            // <style> 要素そのもの
    'data-dbsext-action-toggle': 'own-leaf',
    'data-dbsext-sort': 'own-leaf',
    'data-dbsext-filter': 'own-leaf',
    'data-dbsext-filter-min': 'own-leaf',      // 数値絞り込みの「以上」
    'data-dbsext-filter-max': 'own-leaf',      // 数値絞り込みの「以下」
    'data-dbsext-collapse-hint': 'own-leaf',
    'data-dbsext-top-scrollbar-inner': 'own-leaf',
    'data-dbsext-synced': 'own-leaf',          // 同期の登録済み印（自前要素に付く）
    'data-dbsext-beacons-area': 'own-leaf',
    'data-dbsext-beacons-link-a': 'own-leaf',
    'data-dbsext-beacons-btn': 'own-leaf',
    'data-dbsext-original-view-btn': 'own-leaf',
    'data-dbsext-port-bulk-table': 'own-leaf',

    // --- ポータル要素に付けた目印（自前UIではない） ---
    'data-dbsext-tabled': 'mark',      // table-tools が .el-table に付ける
    'data-dbsext-wrap': 'mark',        // table-wrap が .el-table に付ける
    'data-dbsext-orig-title': 'mark',  // table-tools が th に控える元の列名
    'data-dbsext-orig-width': 'mark',        // table-columns が col に控える元の幅
    'data-dbsext-orig-table-width': 'mark',  // table-columns が表に控える元の幅
    'data-dbsext-newtab': 'mark',      // ui-tweaks が一覧の a に付ける処理済み印
    'data-dbsext-collapsed': 'mark',   // ui-tweaks が折りたたみ見出しに付ける処理済み印
    // 全家族共通の表マーカー（値は portal / custom）。見た目のCSSはすべてこれを見る。
    // **`own` にしてはいけない。** ポータルが描画した表にも付けるため、own に分類すると
    // ポータル表を対象にした変化が全部「自分の仕業」になり、
    // **SPAが表を差し替えても再適用されなくなる**（core の冒頭に書いた事故そのもの）。
    'data-dbsext-table': 'mark',
    // 自前表を包むスクロール領域。自前UIにしか付かないが、
    // 中身（自前表）は own-root を持つので closest の対象にする必要は無い。
    'data-dbsext-table-scroll': 'own-leaf',
    // 配信版（user script）が document_start で documentElement に置く合図。
    // **ポータルの要素に付ける印**なので own ではない。
    // これを own に分類すると、documentElement を対象にした変化が
    // すべて「自分の仕業」として捨てられる。
    'data-dbsext-remote-claim': 'mark'
  };

  // **`ATTR_KIND` から生成する。手で書かない。**
  // ここに `[data-dbsext]`(bodyの適用済みマーカー)や `[data-dbsext-tabled]`
  // (ポータルのテーブルに目印を付けただけのもの)が入ってはいけない。
  // 入ると、その配下で起きるポータル由来の変化まで「自分の変更」と誤判定し、
  // SPA遷移後に table-tools が二度と再適用されなくなる。
  var OWN_UI_SELECTOR = (function () {
    var list = [];
    for (var name in ATTR_KIND) {
      if (ATTR_KIND[name] === 'own-root') list.push('[' + name + ']');
    }
    return list.join(',');
  })();

  // 自前UI**全部**（root + leaf）を指すセレクタ。
  // 「オリジナルに戻す」表示（original-view.js）が、拡張の作った要素を
  // 一括で隠すために使う。ここも `ATTR_KIND` から生成し、手書きの一覧を作らない。
  var OWN_UI_SELECTOR_ALL = (function () {
    var list = [];
    for (var name in ATTR_KIND) {
      if (ATTR_KIND[name] === 'own-root' || ATTR_KIND[name] === 'own-leaf') list.push('[' + name + ']');
    }
    return list.join(',');
  })();

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

  // 適用の順序と、変化のたびに再適用するかどうか。
  //
  // **モジュールを1本足すときに直すのは、ここ1行と `module-order.mjs` だけ。**
  // 以前は「この一覧」と「onContentChange の登録」を別々に書いていたため、
  // 片方に足し忘れると **SPA遷移で二度と再適用されない**（しかも初回は動くので
  // 気づけない）という壊れ方をした。両方をこの表から導く。
  //
  //   reapply: true  … ポータルの再描画で消える／画面ごとに要否が変わる
  //   reapply: false … 一度きりでよい（head へのCSS挿入、保存領域の初期化）
  var MODULES = [
    { name: 'skin', reapply: false, get: function () { return D.skin; } },
    { name: 'stateStore', reapply: false, get: function () { return D.stateStore; } },
    { name: 'stateForms', reapply: true, get: function () { return D.stateForms; } },
    // 車種情報はSPA遷移で入る画面。boot時には存在しない
    { name: 'vehicleKinds', reapply: true, get: function () { return D.vehicleKinds; } },
    { name: 'netStatus', reapply: true, get: function () { return D.netStatus; } },
    { name: 'tableWrap', reapply: true, get: function () { return D.tableWrap; } },
    { name: 'uiTweaks', reapply: true, get: function () { return D.uiTweaks; } },
    // 車両情報1000件表示（拡張版限定・実ページ遷移方式）。
    // エリア確定を待つ必要があるため reapply:true
    { name: 'vehiclePageSize', reapply: true, get: function () { return D.vehiclePageSize; } },
    // body直下の固定要素（消えないはず）だが、冪等なので保険として再適用する。
    // 「boot時1回だけ」がボタン消失の原因だったため、同じ落とし穴を残さない。
    { name: 'upsell', reapply: true, get: function () { return D.upsell; } },
    { name: 'mapLauncher', reapply: true, get: function () { return D.mapLauncher; } },
    { name: 'beacons', reapply: true, get: function () { return D.beacons; } },
    { name: 'vehicleProblems', reapply: true, get: function () { return D.vehicleProblems; } },
    // 契約§6の限定例外（AGENTS.md参照）。/ports 限定。ポータル再描画のたびに
    // 再確認が必要（エリア切替・SPA遷移で一覧が変わるため）reapply:true
    { name: 'portBulkActions', reapply: true, get: function () { return D.portBulkActions; } },
    { name: 'tableColumns', reapply: true, get: function () { return D.tableColumns; } },
    { name: 'tableTools', reapply: true, get: function () { return D.tableTools; } },
    // 「オリジナルに戻す」トグルボタン。body直下の固定要素
    { name: 'originalView', reapply: true, get: function () { return D.originalView; } }
  ];

  function applyOne(entry, label) {
    var mod = entry.get();
    if (!mod || typeof mod.apply !== 'function') return;
    runSuppressed(entry.name + '.apply' + label, function () { mod.apply(); });
  }

  D.core = {
    // 「オリジナルに戻す」表示（original-view.js）が使う。自前UI全部を指すセレクタ
    OWN_UI_SELECTOR_ALL: OWN_UI_SELECTOR_ALL,

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
     *
     * **この判定は、ブックマークレット（α）と拡張（β）が同じページに
     * 重なった場合の安全装置としても働く。** 実測で確認済み（2026-08-10、
     * `tests/test_bookmarklet_over_extension.js`）。
     *
     * ブックマークレットはページのMAINワールドで、拡張はISOLATED/USER_SCRIPT
     * ワールドで動く。`window.DBSEXT` はワールドごとに別物だが、
     * **`document`（DOM）だけは共有される。** この関数が見ているのは
     * `document.body` の属性であり、どちらの世界から呼んでも同じ答えになる。
     *
     * そのため「拡張が適用済みの画面でブックマークレットを押す」
     * （またはその逆）としても、後から来た側は `boot()` の入口で即座に
     * 戻り、モジュールの `apply()` は一切呼ばれない
     * （各モジュール自身の冪等性チェックに頼らず、ここで止まる）。
     * 先着した側の版（`D.VERSION`）を上書きすることもない。
     *
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

      // **先に監視を張ってから適用する。** 適用中の変化は runSuppressed が捨てる。
      // 再適用は表の順序どおりに回す（適用順に依存する組み合わせがあるため）。
      D.core.onContentChange(function () {
        for (var r = 0; r < MODULES.length; r++) {
          if (MODULES[r].reapply) applyOne(MODULES[r], ' 再適用');
        }
      });

      for (var i = 0; i < MODULES.length; i++) {
        applyOne(MODULES[i], '');
      }
    },

    /**
     * reapply:true の全モジュールを、待たずにいますぐ再適用する。
     *
     * 通常はポータルのDOM変化を200msデバウンスで検知してから再適用するが、
     * 「オリジナルに戻す」を解除した直後のように、**変化のきっかけがDOM変異
     * ではなく自分の操作**である場面では、次の変化を待たずに即座に元へ戻したい。
     */
    reapplyAll: function () {
      for (var r = 0; r < MODULES.length; r++) {
        if (MODULES[r].reapply) applyOne(MODULES[r], ' reapplyAll');
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

      var newObserver = new MutationObserver(function (mutations) {
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

      // **実機で確認された例外への防御。**
      // 「一覧から別タブで開く」で新しいタブを開いたとき、`document.body` は
      // 真値（above のガードを通る）なのに `observe()` が
      // 「Failed to execute 'observe' on 'MutationObserver': parameter 1 is not
      // of type 'Node'」を投げることがある（Chromeのプリレンダー/BFCache採用時、
      // 別レルムで作られた古いNode参照を渡してしまうと起きる既知の症状と推測）。
      // ここを素通しにすると、その1行の例外だけで拡張カードに「エラー」が付き、
      // 以後の再適用が全部止まる。**監視だけを諦め、直前までに済んだ初期適用
      // （skinやtable-wrap等）はそのまま活かす。** 失敗時は observer を確定させず、
      // 後から onContentChange が再び呼ばれれば取り直せるようにしておく。
      try {
        newObserver.observe(document.body, { childList: true, subtree: true });
      } catch (e) {
        D.core.log('onContentChange の監視開始に失敗: ' + (e && e.message ? e.message : e), true);
        return;
      }

      observer = newObserver;
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

      // 安全弁 0: **トップ画面でしか自動適用しない**
      //
      // エリアを適用するとポータルが再描画され、**トップ画面へ戻される**。
      // 一覧から「別タブで開く」で個別画面を開いた場合、そのタブはエリア未選択なので
      // 自動適用が走り、**利用者が開こうとした画面が消えてトップに飛ばされる**
      // （現場から報告された実害。ポート情報→ポート識別番号で再現）。
      //
      // 通常ポータルを開いたときの入口はトップ画面なので、そこだけで適用すれば足りる。
      // SPA内で一覧へ移動する頃には、すでに適用済みになっている。
      //
      // **利用者が明示的に開いた画面を、拡張が勝手に別の画面へ移してはいけない。**
      if (typeof location !== 'undefined' && location.pathname &&
          location.pathname !== '/' && location.pathname !== '') {
        return;
      }

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
 * 車種情報画面（/areas/vehicle-kinds）の初期表示
 *
 * この画面は開いた直後だと**何も表示されていない**。エリアを選んで「検索」を
 * 押して初めて中身が出る。エリアの選択肢が1つしかない利用者にとって、この
 * 操作は毎回同じ結果にしかならないため、拡張が代わりに済ませておく。
 *
 * ---------------------------------------------------------------------------
 * **選択肢がちょうど1つのときだけ**自動で選ぶ
 * ---------------------------------------------------------------------------
 * 2つ以上あるなら、どれを選ぶかは利用者の意思である。拡張が勝手に決めると
 * 「自分が選んだつもりのない範囲」を見せることになり、しかも画面上は
 * ふつうに検索済みに見えるため**間違いに気づけない**。
 * だから複数あるときは何もせず、開いた選択肢も**閉じて元の見た目に戻す**。
 *
 * 押すのは「検索」だけである。解錠・再配置・メンテナンス等の操作系には
 * 一切触れない（契約§6）。検索は読み取りであり、画面の状態も変えない。
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  var TARGET_PATH = '/areas/vehicle-kinds';
  var DROPDOWN_MAX_ATTEMPTS = 30; // 30回 × 50ms = 1.5秒
  var AFTER_PICK_MS = 50;

  // 画面ごとに1回だけ試す。SPA遷移でこの画面へ入り直したときは再び試す
  var lastPath = null;
  var triedOnThisScreen = false;
  var running = false;

  function log(message, isError) {
    if (D && D.core && typeof D.core.log === 'function') {
      D.core.log(message, isError);
    }
  }

  function currentPath() {
    if (typeof location === 'undefined' || !location.pathname) return '';
    return location.pathname.replace(/\/+$/, '') || '/';
  }

  /**
   * 隠れている要素か。
   *
   * Element Plus は閉じた選択肢リストを DOM に残したまま隠す。
   * 隠れたリストを「開いている」と誤認すると、**見えていない選択肢を
   * クリックしてしまう**（＝利用者の意図しないエリアが適用される）。
   */
  function isHiddenElement(el) {
    for (var node = el; node; node = node.parentElement) {
      var style = node.style;
      if (style && (style.display === 'none' || style.visibility === 'hidden')) return true;
      if (typeof getComputedStyle === 'function') {
        var cs = getComputedStyle(node);
        if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return true;
      }
    }
    if (typeof el.getBoundingClientRect === 'function') {
      var rect = el.getBoundingClientRect();
      if (rect && rect.width === 0 && rect.height === 0) return true;
    }
    return false;
  }

  function visibleAll(selector) {
    if (typeof document === 'undefined') return [];
    var nodes = document.querySelectorAll(selector);
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      if (!isHiddenElement(nodes[i])) out.push(nodes[i]);
    }
    return out;
  }

  /** 開いている選択肢リスト（Element Plus は body 直下へ出す） */
  function getVisibleDropdowns() {
    return visibleAll('.el-select-dropdown');
  }

  function labelTextOf(select) {
    var item = (typeof select.closest === 'function') ? select.closest('.el-form-item') : null;
    if (!item) return '';
    var label = item.querySelector('.el-form-item__label');
    return label ? (label.textContent || '').trim() : '';
  }

  /**
   * エリアの選択欄を取る。
   *
   * 実測ではこの画面の選択欄は1つだけである。**複数見えたときは、
   * エリアだと確信できるものが無い限り触らない。**別の条件欄を勝手に
   * 変えるくらいなら、何もしない方がよい。
   */
  function getAreaSelect() {
    var selects = visibleAll('.el-select');
    if (selects.length === 0) return null;
    if (selects.length === 1) return selects[0];
    for (var i = 0; i < selects.length; i++) {
      if (labelTextOf(selects[i]).indexOf('エリア') >= 0) return selects[i];
    }
    return null;
  }

  function getTrigger(select) {
    return select.querySelector('.el-select__wrapper') ||
      select.querySelector('.el-input__wrapper') ||
      select.querySelector('input') ||
      select;
  }

  /** すでに何か選ばれているか（利用者が選んだものを上書きしない） */
  function hasSelectedValue(select) {
    var picked = select.querySelector('.el-select__selected-item, .el-select__tags-text');
    if (picked && (picked.textContent || '').trim()) return true;
    var input = select.querySelector('input');
    if (input && typeof input.value === 'string' && input.value.trim()) return true;
    return false;
  }

  /** 選べる選択肢だけを返す（無効・非表示は除く） */
  function getSelectableOptions(dropdown) {
    var items = dropdown.querySelectorAll('.el-select-dropdown__item');
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (item.classList && item.classList.contains('is-disabled')) continue;
      if (isHiddenElement(item)) continue;
      out.push(item);
    }
    return out;
  }

  function getSearchButton() {
    if (typeof document === 'undefined') return null;
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if ((btn.textContent || '').trim() !== '検索') continue;
      if (btn.disabled) continue;
      if (isHiddenElement(btn)) continue;
      return btn;
    }
    return null;
  }

  /** すでに検索済み（表が出ている）なら触らない */
  function alreadySearched() {
    if (typeof document === 'undefined') return false;
    var tables = document.querySelectorAll('.el-table');
    for (var i = 0; i < tables.length; i++) {
      if (tables[i].querySelectorAll('tbody tr').length > 0) return true;
    }
    return false;
  }

  function finish() {
    running = false;
  }

  /** 選択肢リストが開いたあとの処理 */
  function onDropdownReady(trigger, dropdown) {
    var options = getSelectableOptions(dropdown);

    if (options.length !== 1) {
      // **開けたままにしない。** 利用者から見て「勝手に何か開いた」状態を残さない
      trigger.click();
      log('車種情報: エリアの選択肢が' + options.length + '件のため自動選択しません');
      finish();
      return;
    }

    var name = (options[0].textContent || '').trim();
    options[0].click();

    setTimeout(function () {
      var btn = getSearchButton();
      if (!btn) {
        log('車種情報: 検索ボタンが見つからないため、選択のみで止めました', true);
        finish();
        return;
      }
      btn.click();
      log('車種情報: エリア「' + name + '」を選んで検索しました');
      finish();
    }, AFTER_PICK_MS);
  }

  function openAndPick(select) {
    var before = getVisibleDropdowns();
    var trigger = getTrigger(select);
    trigger.click();

    var attempts = 0;
    function poll() {
      attempts++;
      var now = getVisibleDropdowns();
      var found = null;
      for (var i = 0; i < now.length; i++) {
        if (before.indexOf(now[i]) < 0) { found = now[i]; break; }
      }
      // 既存のリストが再利用されることもある。1つしか見えていないならそれで確定
      if (!found && now.length === 1) found = now[0];

      if (found) {
        onDropdownReady(trigger, found);
        return;
      }
      if (attempts < DROPDOWN_MAX_ATTEMPTS) {
        setTimeout(poll, 50);
        return;
      }
      log('車種情報: 選択肢が開かなかったため何もしません', true);
      finish();
    }

    setTimeout(poll, 50);
  }

  D.vehicleKinds = {
    apply: function () {
      var path = currentPath();
      if (lastPath !== path) {
        lastPath = path;
        triedOnThisScreen = false;
      }
      if (path !== TARGET_PATH) return;
      if (triedOnThisScreen || running) return;
      if (typeof document === 'undefined' || !document.body) return;

      // すでに結果が出ているなら用は無い
      if (alreadySearched()) {
        triedOnThisScreen = true;
        return;
      }

      var select = getAreaSelect();
      // まだ描画されていないだけかもしれない。次の変化で改めて試す
      if (!select) return;

      if (hasSelectedValue(select)) {
        triedOnThisScreen = true;
        return;
      }

      // 利用者が自分で選択肢を開いている最中に割り込まない
      if (getVisibleDropdowns().length > 0) return;

      triedOnThisScreen = true;
      running = true;
      openAndPick(select);
    },

    _reset: function () {
      lastPath = null;
      triedOnThisScreen = false;
      running = false;
    },
    _state: function () {
      return { lastPath: lastPath, tried: triedOnThisScreen, running: running };
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);


/**
 * DBSEXT 通信ステータスモジュール
 * 通信監視、読み込み中マスク表示、エラー・セッション切れ通知を担当
 *
 * ---------------------------------------------------------------------------
 * **拡張版（β）・リモート配信版での動作方式:**
 *
 * 拡張の content script / user script は隔離ワールド（ISOLATED / USER_SCRIPT）で動くため、
 * このモジュールが直接ポータル本体（MAIN ワールド）の fetch / XHR を捕捉することはできない。
 * 代わりに、MAIN ワールドに注入された傍受スクリプト（net-status-main.js）が
 * fetch / XHR をラップして DOM カスタムイベント（`dbsext:main-fetch-start` /
 * `dbsext:main-fetch-end`）を発火し、このモジュールはそれを購読する。
 *
 * ブックマークレット版（α）はページの MAIN ワールドで動くため、
 * 従来どおり fetch / XHR を直接ラップして機能する。
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
  var mainWorldListening = false;

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

  /**
   * MAIN ワールドの傍受スクリプト（net-status-main.js）が発火する
   * DOM カスタムイベントを購読する。
   * 拡張版（β）およびリモート配信版で使われる。
   */
  function listenToMainWorldEvents() {
    if (mainWorldListening) return;
    if (typeof document === 'undefined') return;
    mainWorldListening = true;

    document.addEventListener('dbsext:main-fetch-start', function () {
      onRequestStart();
    });

    document.addEventListener('dbsext:main-fetch-end', function (e) {
      onRequestEnd();
      var detail = (e && e.detail) || {};
      var status = detail.status;
      if (status === 401 || status === 403) {
        showBanner('ログインが切れました。再度ログインしてください', true);
      } else if (status >= 400) {
        showBanner('通信に失敗しました（HTTP ' + status + '）。再読込してください', false);
      } else if (detail.error) {
        handleGenericError();
      }
    });
  }

  D.netStatus = {
    LOADING_DELAY_MS: LOADING_DELAY_MS,

    apply: function () {
      // 拡張版（β）またはリモート配信版: MAIN ワールドからの DOM イベントを購読
      if (D.platform && (D.platform.kind === 'extension' || D.platform.isUserScript)) {
        listenToMainWorldEvents();
      } else {
        // ブックマークレット版（α）: fetch / XHR を直接ラップ
        wrapFetch();
        wrapXHR();
      }

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
  /**
   * 表の見た目の値。**表に関する色・寸法はここだけで決める。**
   *
   * 以前は家族ごと（ポータル表 / ビーコン一覧 / 問題申告一覧）にCSSを書いていたため、
   * 同じ「自前表」なのに見た目が食い違っていた（2026-08-10 実測）:
   *   見出し背景 #d9d9d9(灰) vs accent(青) / 文字 14px vs 13px / z-index 3 vs 2 …
   * 片方を直してももう片方へ伝播しないので、値を1箇所へ集約した。
   *
   * 値の選び方: **すでに根拠のある方**を採った。
   *   headerBg/headerFg … WCAG AA 8.91 を実測済み（CONTRAST_PAIRS）。青×白ではなくこちら
   *   headerPadY 4px    … 見出しが 89px まで伸びて「一度に見える行数が減る」と指摘された分
   *   fontSize 14px     … Element Plus の既定。ポータル表の見た目を動かさずに済む
   */
  function tableTokens(accent) {
    return {
      accent: accent,
      headerBg: '#d9d9d9',
      headerFg: '#2f3438',
      cellFg: '#303133',
      rowOdd: '#ffffff',
      rowEven: '#f7f9fc',
      rowHover: '#e8f1fb',
      border: '#c8ccd4',
      fontSize: '14px',
      headerPadY: '4px',
      cellPadY: '6px',
      padX: '12px',
      linkFg: '#2563eb',
      emptyFg: '#5a5e66',
      // 先頭列固定の重なり順。操作列のボタン等に負けず、
      // ビーコンのネイティブモーダル(1400番台)より十分低い値
      zHeaderCol: 20,
      zBodyCol: 15,
      zStickyHeader: 10
    };
  }

  var CONTRAST_PAIRS = (function () {
    var t = tableTokens('#0b5cab');
    return [
      { name: '表ヘッダ', fg: t.headerFg, bg: t.headerBg },
      { name: 'データなし', fg: t.emptyFg, bg: t.rowOdd },
      { name: '見出し（画面タイトル）', fg: t.cellFg, bg: t.rowOdd }
    ];
  })();

  /**
   * 全家族に共通の表スタイル。
   *
   * 目印 `data-dbsext-table` は3家族すべての `<table>` に付く。
   *   "portal" … ポータルが描画した表（ヘッダ表とボディ表の2枚）
   *   "custom" … 拡張が描画した表（ビーコン一覧 / 問題申告一覧）
   *
   * **家族による違いは、この関数の中で属性値によって分岐させる。**
   * 別ブロックに切り出すと、また食い違いが始まる。
   */
  function tableCss(t) {
    return [
      '/* === 表の共通スタイル（全家族） ================================== */',
      '[data-dbsext-table] {',
      '  font-size: ' + t.fontSize + ' !important;',
      '  font-variant-numeric: tabular-nums !important;',
      '}',
      '',
      '/* 見出し: 固定 ＋ コントラスト（WCAG AA 8.91）＋ 高さを詰める。',
      '   自前のソート矢印と絞り込み欄を足すと見出しが高くなる。実機では 89px まで',
      '   伸びて「不必要に広い」と指摘された。表は縦にも長いので、',
      '   **見出しが高いほど一度に見える行数が減る**。 */',
      '[data-dbsext-table] th {',
      '  position: sticky !important;',
      '  top: 0 !important;',
      '  z-index: ' + t.zStickyHeader + ' !important;',
      '  color: ' + t.headerFg + ' !important;',
      '  background-color: ' + t.headerBg + ' !important;',
      '  font-weight: 600 !important;',
      '  padding-top: ' + t.headerPadY + ' !important;',
      '  padding-bottom: ' + t.headerPadY + ' !important;',
      '  line-height: 1.3 !important;',
      '  vertical-align: top !important;',
      '  text-align: left !important;',
      '  border-bottom: 1px solid ' + t.border + ' !important;',
      '  border-color: ' + t.border + ' !important;',
      '}',
      '[data-dbsext-table] th .cell {',
      '  line-height: 1.3 !important;',
      '  padding-top: 0 !important;',
      '  padding-bottom: 0 !important;',
      '}',
      '',
      '/* 横余白は家族で違う。**ポータル表には足さない。**',
      '   ポータルの th/td は内側に `.cell` を持ち、そちらが横余白を持っている。',
      '   ここで足すと二重になり、ただでさえ横に長い表がさらに広がる。 */',
      '[data-dbsext-table="custom"] th,',
      '[data-dbsext-table="custom"] td {',
      '  padding-left: ' + t.padX + ' !important;',
      '  padding-right: ' + t.padX + ' !important;',
      '}',
      '[data-dbsext-table="custom"] {',
      '  width: 100% !important;',
      '  border-collapse: collapse !important;',
      '  background-color: ' + t.rowOdd + ' !important;',
      '}',
      '[data-dbsext-table="custom"] td {',
      '  padding-top: ' + t.cellPadY + ' !important;',
      '  padding-bottom: ' + t.cellPadY + ' !important;',
      '  color: ' + t.cellFg + ' !important;',
      '  border: 1px solid ' + t.border + ' !important;',
      '}',
      '[data-dbsext-table="portal"] td {',
      '  border-bottom: 1px solid ' + t.border + ' !important;',
      '  border-color: ' + t.border + ' !important;',
      '}',
      '',
      '/* ゼブラとホバー（案E）。全家族で同じ配色にする */',
      '[data-dbsext-table] tbody tr:nth-child(odd) td {',
      '  background-color: ' + t.rowOdd + ' !important;',
      '}',
      '[data-dbsext-table] tbody tr:nth-child(even) td {',
      '  background-color: ' + t.rowEven + ' !important;',
      '}',
      '[data-dbsext-table] tbody tr:hover td,',
      '[data-dbsext-table] tbody tr.hover-row td {',
      '  background-color: ' + t.rowHover + ' !important;',
      '}',
      '',
      '/* --- 先頭列の固定（案3） ------------------------------------------',
      '   z-index は意図して高めにしてある（2026-08-10）。',
      '   車両情報以外の表（操作列を隠す機能が無く、常に幅広い操作ボタン列が並ぶ）で、',
      '   横スクロール中に先頭列が操作列の裏へ回り込んで見えなくなる報告があった。',
      '   `position: static` な通常セルは本来スタッキング文脈を作らないはずだが、',
      '   操作列のボタン/ドロップダウンがEP側で独自の position+z-index を持つ場合に',
      '   先頭列が負ける。表内で確実に勝つ値まで引き上げてある。',
      '',
      '   **固定する列数は家族で違う。** ポータル表は先頭がチェックボックス列(44px)で、',
      '   識別番号は2列目にある。自前表にチェックボックス列は無いので1列だけ固定する。 */',
      '[data-dbsext-table] th:first-child {',
      '  position: sticky !important;',
      '  left: 0 !important;',
      '  z-index: ' + t.zHeaderCol + ' !important;',
      '  background-color: ' + t.headerBg + ' !important;',
      '}',
      '[data-dbsext-table] td:first-child {',
      '  position: sticky !important;',
      '  left: 0 !important;',
      '  z-index: ' + t.zBodyCol + ' !important;',
      '}',
      '[data-dbsext-table="portal"] th:nth-child(2) {',
      '  position: sticky !important;',
      '  left: 44px !important;',
      '  z-index: ' + t.zHeaderCol + ' !important;',
      '  background-color: ' + t.headerBg + ' !important;',
      '  box-shadow: 2px 0 4px -2px rgba(0,0,0,0.12);',
      '}',
      '[data-dbsext-table="portal"] td:nth-child(2) {',
      '  position: sticky !important;',
      '  left: 44px !important;',
      '  z-index: ' + t.zBodyCol + ' !important;',
      '  box-shadow: 2px 0 4px -2px rgba(0,0,0,0.12);',
      '}',
      '[data-dbsext-table="custom"] td:first-child {',
      '  box-shadow: 2px 0 4px -2px rgba(0,0,0,0.12);',
      '}',
      '/* 固定セルは背景が透けると下の行が見えてしまうため、不透明を保つ */',
      '[data-dbsext-table] tbody tr:nth-child(odd) td:first-child,',
      '[data-dbsext-table="portal"] tbody tr:nth-child(odd) td:nth-child(2) {',
      '  background-color: ' + t.rowOdd + ' !important;',
      '}',
      '[data-dbsext-table] tbody tr:nth-child(even) td:first-child,',
      '[data-dbsext-table="portal"] tbody tr:nth-child(even) td:nth-child(2) {',
      '  background-color: ' + t.rowEven + ' !important;',
      '}',
      '[data-dbsext-table] tbody tr:hover td:first-child,',
      '[data-dbsext-table] tbody tr.hover-row td:first-child,',
      '[data-dbsext-table="portal"] tbody tr:hover td:nth-child(2),',
      '[data-dbsext-table="portal"] tbody tr.hover-row td:nth-child(2) {',
      '  background-color: ' + t.rowHover + ' !important;',
      '}',
      '',
      '/* ポータル標準の車両状態色を、車両識別番号セルだけに残す。',
      '   実機確認（2026-08-09）:',
      '     bg-green = rgb(168, 240, 122) / bg-brown = rgb(197, 149, 107)',
      '     bg-red   = rgb(255, 99, 71)',
      '   行全体の着色はゼブラ表示と競合するため復元せず、sticky な第2列だけへ反映する。',
      '   **自前表に対応する概念が無いため、ここはポータル固有のままでよい。** */',
      '[data-dbsext-table="portal"] tbody tr.bg-green td:nth-child(2) {',
      '  background-color: rgb(168, 240, 122) !important;',
      '}',
      '[data-dbsext-table="portal"] tbody tr.bg-brown td:nth-child(2) {',
      '  background-color: rgb(197, 149, 107) !important;',
      '}',
      '[data-dbsext-table="portal"] tbody tr.bg-red td:nth-child(2) {',
      '  background-color: rgb(255, 99, 71) !important;',
      '}',
      '',
      '/* === 見出しの操作UI（並べ替え・絞り込み）========================',
      '   ポータル表も自前表も**同じ見た目**にする。',
      '   以前は table-tools がインラインstyleで、自前表がCSSクラスで',
      '   別々に指定しており、同じ機能なのに見た目が違っていた。 */',
      '[data-dbsext-sort] {',
      '  display: inline-block !important;',
      '  margin-left: 4px !important;',
      '  font-size: 11px !important;',
      '  cursor: pointer !important;',
      '  user-select: none !important;',
      '  color: ' + t.headerFg + ' !important;',
      '}',
      '.dbsext-th-sort {',
      '  display: block !important;',
      '  width: 100% !important;',
      '  padding: 0 0 4px !important;',
      '  border: 0 !important;',
      '  background: transparent !important;',
      '  color: ' + t.headerFg + ' !important;',
      '  font: inherit !important;',
      '  font-weight: 600 !important;',
      '  text-align: left !important;',
      '  cursor: pointer !important;',
      '  white-space: nowrap !important;',
      '}',
      '.dbsext-th-filters {',
      '  display: flex !important;',
      '  gap: 3px !important;',
      '  margin-top: 2px !important;',
      '  line-height: 0 !important;',
      '}',
      '[data-dbsext-filter],',
      '[data-dbsext-filter-min],',
      '[data-dbsext-filter-max] {',
      '  box-sizing: border-box !important;',
      '  width: 100% !important;',
      '  min-width: 0 !important;',
      '  height: 18px !important;',
      '  padding: 0 4px !important;',
      '  border: 1px solid ' + t.border + ' !important;',
      '  border-radius: 3px !important;',
      '  background-color: ' + t.rowOdd + ' !important;',
      '  color: ' + t.cellFg + ' !important;',
      '  font-size: 11px !important;',
      '  line-height: 16px !important;',
      '}',
      '.dbsext-cell-link {',
      '  border: 0 !important;',
      '  padding: 0 !important;',
      '  background: transparent !important;',
      '  color: ' + t.linkFg + ' !important;',
      '  font: inherit !important;',
      '  text-decoration: underline !important;',
      '  cursor: pointer !important;',
      '}',
      '.dbsext-table-empty {',
      '  padding: 20px 12px !important;',
      '  color: ' + t.emptyFg + ' !important;',
      '  text-align: center !important;',
      '  background-color: ' + t.rowOdd + ' !important;',
      '}',
      '/* 表を包むスクロール領域（自前表用）。ポータル表は table-wrap.js が担当 */',
      '[data-dbsext-table-scroll] {',
      '  overflow: auto !important;',
      '  max-width: 100% !important;',
      '  max-height: 70vh !important;',
      '}'
    ];
  }

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
      var t = tableTokens(accent);

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
        '/* 「データなし」文字色 (WCAG AA 6.51) */',
        '.el-table__empty-text {',
        '  color: ' + t.emptyFg + ' !important;',
        '  background-color: ' + t.rowOdd + ' !important;',
        '}',
        '',
        '/* 画面タイトル見出し (WCAG AA 13.02) */',
        'h1.page-title,',
        '.main h1,',
        'main h1 {',
        '  color: ' + t.cellFg + ' !important;',
        '  font-weight: 600 !important;',
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
        // ===================================================================
        // 表の共通スタイル。**表の見た目はここだけで決める。**
        // ===================================================================
      ].concat(tableCss(t)).concat([
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
        '/* スクロールと見た目は共通側（[data-dbsext-table-scroll]）が持つ。',
        '   ここは配置だけ。 */',
        '[data-dbsext-beacons-panel] .dbsext-beacons-table-wrap {',
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
        '/* ビーコン一覧の表は横に長いので、最低幅だけ与える。',
        '   色・余白・固定などの見た目は共通側（[data-dbsext-table]）が持つ。 */',
        '[data-dbsext-beacons-table] {',
        '  min-width: 1100px !important;',
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
        '}',
        '',
        '/* --- vehicle-problems 自前テーブル --- */',
        '[data-dbsext-vehicle-problems] {',
        '  margin: 16px 0 !important;',
        '}',
        '[data-dbsext-vehicle-problems] .dbsext-vp-header {',
        '  display: flex !important;',
        '  align-items: center !important;',
        '  gap: 16px !important;',
        '  margin-bottom: 8px !important;',
        '}',
        '[data-dbsext-vehicle-problems] .dbsext-vp-header h3 {',
        '  margin: 0 !important;',
        '  font-size: 16px !important;',
        '  font-weight: bold !important;',
        '}',
        '[data-dbsext-vehicle-problems] .dbsext-vp-status {',
        '  font-size: 12px !important;',
        '  color: #666 !important;',
        '}',
        '[data-dbsext-vehicle-problems] .dbsext-vp-error {',
        '  font-size: 12px !important;',
        '  color: #d9534f !important;',
        '}',
        '/* スクロールと見た目は共通側が持つ。ここは枠線と高さの好みだけ。 */',
        '[data-dbsext-vehicle-problems] .dbsext-vp-table-wrap {',
        '  max-height: 60vh !important;',
        '  border: 1px solid ' + t.border + ' !important;',
        '}',
        '',
        '/* --- ポート一括操作（契約§6の限定例外。AGENTS.md参照） --- */',
        '.dbsext-port-bulk-panel {',
        '  margin: 16px 0 !important;',
        '  padding: 12px !important;',
        '  border: 1px solid ' + accent + ' !important;',
        '  border-radius: 6px !important;',
        '}',
        '.dbsext-port-bulk-panel h2 {',
        '  margin: 0 0 8px !important;',
        '  font-size: 15px !important;',
        '  font-weight: bold !important;',
        '  color: ' + accent + ' !important;',
        '}',
        '.dbsext-port-bulk-panel h3 {',
        '  margin: 0 0 8px !important;',
        '  font-size: 13px !important;',
        '}',
        '.dbsext-port-bulk-status {',
        '  font-size: 12px !important;',
        '  color: #666 !important;',
        '  margin-bottom: 6px !important;',
        '}',
        '.dbsext-port-bulk-status--error {',
        '  color: #d9534f !important;',
        '}',
        '.dbsext-port-bulk-toolbar {',
        '  display: flex !important;',
        '  align-items: center !important;',
        '  gap: 10px !important;',
        '  flex-wrap: wrap !important;',
        '  margin-bottom: 10px !important;',
        '}',
        '.dbsext-port-bulk-count {',
        '  font-size: 12px !important;',
        '  color: #333 !important;',
        '}',
        '.dbsext-port-bulk-table-wrap {',
        '  max-height: 55vh !important;',
        '  border: 1px solid ' + t.border + ' !important;',
        '}',
        '.dbsext-port-bulk-confirm-targets {',
        '  max-height: 30vh !important;',
        '  overflow: auto !important;',
        '  margin: 0 0 10px !important;',
        '  padding-left: 20px !important;',
        '}',
        '.dbsext-port-bulk-confirm-buttons {',
        '  display: flex !important;',
        '  gap: 10px !important;',
        '}',
        '.dbsext-port-bulk-result-list {',
        '  max-height: 40vh !important;',
        '  overflow: auto !important;',
        '  list-style: none !important;',
        '  margin: 8px 0 !important;',
        '  padding: 0 !important;',
        '}',
        '.dbsext-port-bulk-result-item {',
        '  font-size: 12px !important;',
        '  padding: 2px 0 !important;',
        '}',
        '.dbsext-port-bulk-result-item--failed {',
        '  color: #d9534f !important;',
        '}',
        '.dbsext-port-bulk-result-item--skipped {',
        '  color: #999 !important;',
        '}',
        '.dbsext-port-bulk-checkbox {',
        '  cursor: pointer !important;',
        '  width: 15px !important;',
        '  height: 15px !important;',
        '  accent-color: ' + accent + ' !important;',
        '}',
        '[data-dbsext-port-bulk-panel] .dbsext-btn {',
        '  padding: 6px 14px !important;',
        '  background-color: ' + accent + ' !important;',
        '  color: #ffffff !important;',
        '  border: none !important;',
        '  border-radius: 4px !important;',
        '  cursor: pointer !important;',
        '  font-size: 13px !important;',
        '}',
        '[data-dbsext-port-bulk-panel] .dbsext-btn:disabled {',
        '  background-color: #a0cfff !important;',
        '  cursor: not-allowed !important;',
        '}',
        '[data-dbsext-port-bulk-panel] .dbsext-btn--plain {',
        '  background-color: #ffffff !important;',
        '  color: ' + accent + ' !important;',
        '  border: 1px solid ' + accent + ' !important;',
        '}'
      ]).join('\n');

      var styleEl = document.createElement('style');
      styleEl.id = D.skin.styleId;
      styleEl.setAttribute('data-dbsext-skin', '1');
      styleEl.textContent = css;

      document.head.appendChild(styleEl);
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);


/**
 * DBSEXT 表の共通コア（table-kit）
 *
 * ---------------------------------------------------------------------------
 * なぜ「共通の基底クラス」ではなく「共通コア＋アダプタ」なのか
 * ---------------------------------------------------------------------------
 * 表は2種類あり、**行の持ち主が違う**。
 *
 *   ポータル表 … ポータルが描画済みの <tr>。行の中に **Vueのイベントハンドラを持つ
 *                 操作ボタン**（解錠・再配置・メンテナンス）が入っている。
 *                 並べ替えは appendChild で並べ直す。絞り込みは display:none。
 *   自前表     … 配列データから拡張が描画する。並べ替え・絞り込みは再描画。
 *
 * ポータル表を「再描画」にすると操作ボタンのVueハンドラが壊れる。
 * これは契約§6「ポータルの既存DOMを削除・移動しない」に正面から反する
 * （`tests/test_table_columns.js` が `btn.customProp === 'unmodified'` で検証済み）。
 *
 * したがって**行をどう動かすかは共有できない**。共有するのはここに置いた4つだけ:
 *
 *   1. compare()            … 並び順の決め方（自然順・数値・ポート名の特別扱い）
 *   2. matchesFilter()      … 絞り込みの判定（文字列 / 数値の範囲）
 *   3. buildHeaderControls()… 見出しの操作UI（同じマークアップ・同じCSS）
 *   4. createState()        … 状態の持ち方
 *
 * これで「同じ改修がすべての表へ伝播する」ことと、
 * 「ポータルDOMを壊さない」ことを両立させる。
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  // ---------------------------------------------------------------------------
  // 絞り込みの種類
  //
  // **列によって、文字列の部分一致より「以上・以下」の方が役に立つ。**
  // 電圧やバッテリー残量は「3.5V以下だけ見たい」という使い方をする。
  // ここを1箇所の宣言表にしておけば、現場からの要望に応じて
  // **1行足すだけ**で切り替えられる。
  // ---------------------------------------------------------------------------

  var FILTER_TEXT = 'text';
  var FILTER_NUMBER = 'number';

  /**
   * 列名 → 絞り込みの種類。**ここが唯一の宣言場所。**
   *
   * 判定は「完全一致」ではなく「見出しがこの語を含むか」で行う。
   * 実際の見出しは `ビーコンバッテリー残量[%]` のように単位や修飾が付くため、
   * 完全一致にすると**1列も一致せず、静かに文字列絞り込みのままになる**
   * （table-columns で同じ失敗を1度している）。
   *
   * 追加するときは、**部分一致で他の列を巻き込まないか**を確かめること。
   * 例: `残量` は良いが `量` だけにすると `交通量` のような列まで数値扱いになる。
   */
  var NUMERIC_COLUMN_HINTS = [
    '電圧',
    'バッテリー',
    '残量',
    '台数',
    'ラック数'
  ];

  /** 見出し名から絞り込みの種類を決める */
  function filterKindFor(columnLabel) {
    var label = String(columnLabel == null ? '' : columnLabel);
    for (var i = 0; i < NUMERIC_COLUMN_HINTS.length; i++) {
      if (label.indexOf(NUMERIC_COLUMN_HINTS[i]) >= 0) return FILTER_NUMBER;
    }
    return FILTER_TEXT;
  }

  /**
   * セルの文字列から数値を取り出す。
   *
   * 実データには単位や記号が混ざる（`3.9V` / `80%` / `1,200`）。
   * また値が無い行は `ー` や空文字で表される。
   * **取り出せなければ null を返す。0 と混同してはいけない。**
   */
  function toNumber(text) {
    if (text === null || text === undefined) return null;
    if (typeof text === 'number') return isFinite(text) ? text : null;
    var cleaned = String(text).replace(/,/g, '');
    var m = cleaned.match(/-?\d+(?:\.\d+)?/);
    if (!m) return null;
    var n = Number(m[0]);
    return isFinite(n) ? n : null;
  }

  // ---------------------------------------------------------------------------
  // 並び順
  // ---------------------------------------------------------------------------

  /**
   * ポート名の並び順キー。`A-12` のような英字＋番号を、
   * 英字→数値の順で自然に並べる。数値部分を持たないものは後ろへ。
   */
  function portSortKey(name) {
    if (name === null || name === undefined) return [1, '', 0, ''];
    var str = String(name);
    var m = str.trim().match(/^\s*([A-Za-z]*)-?(\d+)/);
    if (m) return [0, m[1].toUpperCase(), Number(m[2]), str];
    return [1, '', 0, str];
  }

  function comparePortKeys(a, b) {
    if (a[0] !== b[0]) return a[0] - b[0];
    if (a[1] !== b[1]) return a[1].localeCompare(b[1]);
    if (a[2] !== b[2]) return a[2] - b[2];
    return a[3].localeCompare(b[3], undefined, { numeric: true, sensitivity: 'base' });
  }

  function isPortColumn(label) {
    return label === 'ポート名' || label === 'ポート';
  }

  /**
   * 2つのセル値を比べる。
   *
   * @param {string} a
   * @param {string} b
   * @param {object} [opts] columnLabel … 列名（ポート名の特別扱いに使う）
   *                        numeric     … 数値として比べる（列全体が数値のとき）
   */
  function compare(a, b, opts) {
    var options = opts || {};
    var textA = a === null || a === undefined ? '' : String(a).trim();
    var textB = b === null || b === undefined ? '' : String(b).trim();

    if (isPortColumn(options.columnLabel)) {
      return comparePortKeys(portSortKey(textA), portSortKey(textB));
    }
    if (options.numeric) {
      // 空欄は一番小さいものとして扱う（並べたときに端へ寄る）
      var numA = textA === '' ? -Infinity : Number(textA);
      var numB = textB === '' ? -Infinity : Number(textB);
      if (!isFinite(numA)) numA = -Infinity;
      if (!isFinite(numB)) numB = -Infinity;
      return numA - numB;
    }
    return textA.localeCompare(textB, undefined, { numeric: true, sensitivity: 'base' });
  }

  /** 列の値がすべて数値として扱えるか（空欄は無視。1つも値が無ければ false） */
  function isNumericColumn(values) {
    var seen = 0;
    for (var i = 0; i < values.length; i++) {
      var text = values[i] === null || values[i] === undefined ? '' : String(values[i]).trim();
      if (text === '') continue;
      seen++;
      if (isNaN(Number(text))) return false;
    }
    return seen > 0;
  }

  // ---------------------------------------------------------------------------
  // 絞り込みの判定
  // ---------------------------------------------------------------------------

  /**
   * 1セルが絞り込み条件に合うか。
   *
   * @param {string} cellText セルの表示文字列
   * @param {object} cond     { kind, text } または { kind, min, max }
   * @returns {boolean}
   */
  function matchesFilter(cellText, cond) {
    if (!cond) return true;

    if (cond.kind === FILTER_NUMBER) {
      var hasMin = cond.min !== '' && cond.min !== null && cond.min !== undefined;
      var hasMax = cond.max !== '' && cond.max !== null && cond.max !== undefined;
      if (!hasMin && !hasMax) return true;

      var value = toNumber(cellText);
      // **値が無い行は、範囲を指定した時点で対象外。**
      // `ー`（電圧なし）は「3.5以上」を満たしようがない。
      // ここで通すと、絞り込んだのに空の行が並んで意味をなさなくなる。
      if (value === null) return false;

      if (hasMin) {
        var min = toNumber(cond.min);
        if (min !== null && value < min) return false;
      }
      if (hasMax) {
        var max = toNumber(cond.max);
        if (max !== null && value > max) return false;
      }
      return true;
    }

    var needle = String(cond.text == null ? '' : cond.text);
    if (needle === '') return true;
    var hay = cellText === null || cellText === undefined ? '' : String(cellText);
    return hay.toLocaleLowerCase().indexOf(needle.toLocaleLowerCase()) >= 0;
  }

  /** 条件が1つでも入っているか */
  function hasAnyCondition(conditions) {
    for (var key in conditions) {
      var cond = conditions[key];
      if (!cond) continue;
      if (cond.kind === FILTER_NUMBER) {
        if ((cond.min !== '' && cond.min != null) || (cond.max !== '' && cond.max != null)) return true;
      } else if (cond.text) {
        return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // 状態
  // ---------------------------------------------------------------------------

  function createState() {
    return {
      sortColIndex: null,
      sortOrder: null,      // 'asc' | 'desc'
      conditions: {}        // 列番号 -> { kind, text } / { kind, min, max }
    };
  }

  function conditionFor(state, colIndex, columnLabel) {
    if (!state.conditions[colIndex]) {
      state.conditions[colIndex] = { kind: filterKindFor(columnLabel), text: '', min: '', max: '' };
    }
    return state.conditions[colIndex];
  }

  // ---------------------------------------------------------------------------
  // 見出しの操作UI
  // ---------------------------------------------------------------------------

  function makeInput(attrName, placeholder, title) {
    var input = document.createElement('input');
    input.type = 'text';
    input.setAttribute(attrName, '1');
    input.placeholder = placeholder;
    if (title) input.title = title;
    // クリックやキー操作がポータルの並べ替え等へ伝わらないようにする
    input.addEventListener('click', function (e) { e.stopPropagation(); });
    input.addEventListener('keydown', function (e) { e.stopPropagation(); });
    return input;
  }

  /**
   * 見出しへ「並べ替え」と「絞り込み」を足す。**全家族で同じものを使う。**
   *
   * 見た目はCSS（skin.js）が持つ。ここではマークアップと配線だけ。
   *
   * @param {object} spec
   *   columnLabel … 列名（絞り込みの種類の判定に使う）
   *   sortMode    … 'indicator'（見出し文字の隣に▲を足す）/ 'button'（見出し全体をボタンに）
   *   onSort      … 並べ替えが押された
   *   onFilter    … 絞り込みが変わった（引数は条件オブジェクト）
   * @returns {object} { sortEl, filterWrap, condition, syncFromState }
   */
  function buildHeaderControls(spec) {
    var columnLabel = spec.columnLabel || '';
    var kind = filterKindFor(columnLabel);
    var condition = { kind: kind, text: '', min: '', max: '' };

    // --- 並べ替え ---
    var sortEl;
    if (spec.sortMode === 'button') {
      sortEl = document.createElement('button');
      sortEl.type = 'button';
      sortEl.className = 'dbsext-th-sort';
      sortEl.title = 'クリックで並べ替え';
      sortEl.textContent = columnLabel;
    } else {
      sortEl = document.createElement('span');
      sortEl.setAttribute('data-dbsext-sort', '1');
      sortEl.textContent = ' ▲';
      sortEl.style.opacity = '0.3';
    }
    sortEl.addEventListener('click', function (e) {
      e.stopPropagation();
      if (typeof spec.onSort === 'function') spec.onSort();
    });

    // --- 絞り込み ---
    var filterWrap = document.createElement('div');
    filterWrap.className = 'dbsext-th-filters';

    var inputs = [];
    function notify() {
      if (typeof spec.onFilter === 'function') spec.onFilter(condition);
    }

    if (kind === FILTER_NUMBER) {
      // 「以上」「以下」の2欄。**空欄は「制限なし」**
      var minInput = makeInput('data-dbsext-filter-min', '以上', columnLabel + ' がこの値以上');
      var maxInput = makeInput('data-dbsext-filter-max', '以下', columnLabel + ' がこの値以下');
      minInput.addEventListener('input', function () { condition.min = minInput.value; notify(); });
      maxInput.addEventListener('input', function () { condition.max = maxInput.value; notify(); });
      filterWrap.appendChild(minInput);
      filterWrap.appendChild(maxInput);
      inputs.push({ key: 'min', el: minInput }, { key: 'max', el: maxInput });
    } else {
      var textInput = makeInput('data-dbsext-filter', '絞り込み', columnLabel + ' で絞り込み');
      textInput.addEventListener('input', function () { condition.text = textInput.value; notify(); });
      filterWrap.appendChild(textInput);
      inputs.push({ key: 'text', el: textInput });
    }

    return {
      sortEl: sortEl,
      filterWrap: filterWrap,
      condition: condition,
      kind: kind,
      /** 状態側の値を入力欄へ反映する（再適用で作り直したときのため） */
      syncFromState: function (saved) {
        if (!saved) return;
        for (var i = 0; i < inputs.length; i++) {
          var key = inputs[i].key;
          var value = saved[key] === undefined || saved[key] === null ? '' : String(saved[key]);
          if (inputs[i].el.value !== value) inputs[i].el.value = value;
          condition[key] = value;
        }
      },
      /** 並べ替えの表示を更新する（indicator のときだけ意味がある） */
      updateSortIndicator: function (isActive, order) {
        if (spec.sortMode === 'button') {
          sortEl.textContent = columnLabel + (isActive ? (order === 'asc' ? ' ▲' : ' ▼') : '');
          return;
        }
        sortEl.textContent = isActive ? (order === 'asc' ? ' ▲' : ' ▼') : ' ▲';
        sortEl.style.opacity = isActive ? '1' : '0.3';
      }
    };
  }

  D.tableKit = {
    FILTER_TEXT: FILTER_TEXT,
    FILTER_NUMBER: FILTER_NUMBER,
    NUMERIC_COLUMN_HINTS: NUMERIC_COLUMN_HINTS,

    filterKindFor: filterKindFor,
    toNumber: toNumber,
    compare: compare,
    isNumericColumn: isNumericColumn,
    isPortColumn: isPortColumn,
    portSortKey: portSortKey,
    matchesFilter: matchesFilter,
    hasAnyCondition: hasAnyCondition,
    createState: createState,
    conditionFor: conditionFor,
    buildHeaderControls: buildHeaderControls
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);


/**
 * DBSEXT 自前表（データ駆動）のアダプタ
 *
 * 配列データと列定義から表を描く。並べ替え・絞り込みは**再描画**で行う。
 * 判定ロジック（並び順・絞り込み・見出しUI）は `table-kit` が持つ。
 *
 * ---------------------------------------------------------------------------
 * なぜ切り出したか
 * ---------------------------------------------------------------------------
 * ビーコン一覧と問題申告一覧（拡張）が**112行中87行まで同じコード**を持っていた
 * （2026-08-10 実測）。差分は「セルをリンクにするかどうか」と空表の文言だけ。
 * その結果、片方だけ直した改修が伝播せず、**同じ「自前表」なのに見た目が
 * 食い違っていた**（見出しが灰と青、文字が14pxと13px…）。
 *
 * ここに1つ置き、違いは**列定義のセルレンダラ**として渡す。
 *
 * **ポータル表には使えない。** あちらは行の中にVueのイベントハンドラを持つ
 * 操作ボタンがあり、再描画すると壊れる（契約§6）。ポータル表は table-tools。
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  function kit() {
    return D.tableKit;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild); // dbsext:own-ui
  }

  /**
   * 表を描いて container へ入れる。
   *
   * @param {object} spec
   *   container   … 描画先（中身は消して作り直す）
   *   rows        … データ配列
   *   columns     … [{ label, value(row), render(td, row) }]
   *                 render を渡すとセルの中身を自前で作れる（リンク等）
   *   tableAttrs  … 表に付ける属性 { 'data-dbsext-beacons-table': '1', ... }
   *   emptyText   … 絞り込み結果が0件のときの文言
   *   initialSort … { columnIndex, direction } 省略時は並べ替えなし
   * @returns {object} { table, refresh }
   */
  function render(spec) {
    var container = spec.container;
    var rows = spec.rows || [];
    var columns = spec.columns || [];
    if (!container) return null;

    clear(container);

    var table = document.createElement('table');
    // **全家族共通の目印。見た目のCSSはすべてこれを見る（skin.js の tableCss）。**
    // これが無いと、ヘッダ固定もゼブラも横スクロールも一切効かない。
    table.setAttribute('data-dbsext-table', 'custom');
    if (spec.tableAttrs) {
      for (var attr in spec.tableAttrs) {
        table.setAttribute(attr, spec.tableAttrs[attr]);
      }
    }

    var thead = document.createElement('thead');
    var headerRow = document.createElement('tr');
    var tbody = document.createElement('tbody');

    var state = kit().createState();
    if (spec.initialSort && typeof spec.initialSort.columnIndex === 'number') {
      state.sortColIndex = spec.initialSort.columnIndex;
      state.sortOrder = spec.initialSort.direction === 'desc' ? 'desc' : 'asc';
    }

    var controlsByColumn = [];

    function valueOf(column, row) {
      var v = column.value ? column.value(row) : '';
      return v === null || v === undefined ? '' : String(v);
    }

    function updateSortIndicators() {
      for (var i = 0; i < controlsByColumn.length; i++) {
        controlsByColumn[i].updateSortIndicator(state.sortColIndex === i, state.sortOrder);
      }
    }

    function refresh() {
      clear(tbody);

      // --- 絞り込み ---
      var kept = [];
      for (var i = 0; i < rows.length; i++) {
        var ok = true;
        for (var c = 0; c < columns.length; c++) {
          if (!kit().matchesFilter(valueOf(columns[c], rows[i]), state.conditions[c])) {
            ok = false;
            break;
          }
        }
        if (ok) kept.push({ row: rows[i], originalIndex: i });
      }

      // --- 並べ替え ---
      if (state.sortColIndex !== null && state.sortColIndex !== undefined) {
        var col = columns[state.sortColIndex];
        if (col) {
          var values = [];
          for (var v = 0; v < kept.length; v++) values.push(valueOf(col, kept[v].row));
          var opts = {
            columnLabel: col.label,
            numeric: !kit().isPortColumn(col.label) && kit().isNumericColumn(values)
          };
          var direction = state.sortOrder === 'desc' ? -1 : 1;
          kept.sort(function (a, b) {
            var cmp = kit().compare(valueOf(col, a.row), valueOf(col, b.row), opts);
            // **同じ値のときは元の並びを保つ。** ここを入れないと、
            // 再描画のたびに同値の行が入れ替わって見える
            if (cmp === 0) return a.originalIndex - b.originalIndex;
            return cmp * direction;
          });
        }
      }

      if (kept.length === 0) {
        var emptyRow = document.createElement('tr');
        var emptyCell = document.createElement('td');
        emptyCell.setAttribute('colspan', String(columns.length));
        emptyCell.className = 'dbsext-table-empty';
        emptyCell.textContent = spec.emptyText || '条件に一致する行はありません。';
        emptyRow.appendChild(emptyCell);
        tbody.appendChild(emptyRow);
        return;
      }

      for (var r = 0; r < kept.length; r++) {
        var tr = document.createElement('tr');
        for (var k = 0; k < columns.length; k++) {
          var td = document.createElement('td');
          if (typeof columns[k].render === 'function') {
            // セルの中身を自前で作る（リンク・ボタン等）
            columns[k].render(td, kept[r].row);
          } else {
            // **必ず textContent。** APIの文字列からHTMLを作らない
            td.textContent = valueOf(columns[k], kept[r].row);
          }
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
    }

    // --- 見出し ---
    for (var h = 0; h < columns.length; h++) {
      (function (columnIndex) {
        var th = document.createElement('th');
        var controls = kit().buildHeaderControls({
          columnLabel: columns[columnIndex].label,
          sortMode: 'button',
          onSort: function () {
            if (state.sortColIndex === columnIndex) {
              state.sortOrder = state.sortOrder === 'asc' ? 'desc' : 'asc';
            } else {
              state.sortColIndex = columnIndex;
              state.sortOrder = 'asc';
            }
            updateSortIndicators();
            refresh();
          },
          onFilter: function (condition) {
            state.conditions[columnIndex] = condition;
            refresh();
          }
        });
        state.conditions[columnIndex] = controls.condition;
        controlsByColumn.push(controls);
        th.appendChild(controls.sortEl);
        th.appendChild(controls.filterWrap);
        headerRow.appendChild(th);
      })(h);
    }

    updateSortIndicators();
    thead.appendChild(headerRow);
    table.appendChild(thead);
    table.appendChild(tbody);
    container.appendChild(table);
    refresh();

    return { table: table, refresh: refresh, state: state };
  }

  D.customTable = {
    render: render
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

      /* --- 自前表のスクロール領域にも同じバーを出す --------------------------
         従来ここは `.el-table` 起点だけで書かれていたため、
         **ビーコン一覧・問題申告一覧（拡張）には横スクロールバーが付いていなかった**。
         自前表は `[data-dbsext-table-scroll]` を持つ（skin.js が overflow を与える）。
         同じ配色・同じ太さにして、どの表でも操作感を揃える。
      ---------------------------------------------------------------------- */
      '[data-dbsext-table-scroll] {',
      '  scrollbar-width: auto !important;',
      '  scrollbar-color: #8a9099 #e8e8e8 !important;',
      '}',
      '[data-dbsext-table-scroll]::-webkit-scrollbar {',
      '  display: block !important;',
      '  width: 12px;',
      '  height: 12px;',
      '}',
      '[data-dbsext-table-scroll]::-webkit-scrollbar-track {',
      '  background: #e8e8e8;',
      '  border-radius: 5px;',
      '}',
      '[data-dbsext-table-scroll]::-webkit-scrollbar-thumb {',
      '  background: #a0a0a0;',
      '  border-radius: 5px;',
      '  border: 2px solid #e8e8e8;',
      '}',
      '[data-dbsext-table-scroll]::-webkit-scrollbar-thumb:hover {',
      '  background: #707070;',
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

    // core.js と同じ理由の防御（別タブで開いたときに実機で確認された例外）。
    // ここが失敗しても致命的ではない。すでに SCROLL_CLASS は付与済みなので
    // 見た目はそのまま出る。**クラス監視だけを諦める。**
    try {
      observer.observe(table, { attributes: true, attributeFilter: ['class'] });
    } catch (e) {
      if (D.core && typeof D.core.log === 'function') {
        D.core.log('table-wrap: クラス監視の開始に失敗: ' + (e && e.message ? e.message : e), true);
      }
    }
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

        var headerTable = table.querySelector('table.el-table__header');
        var bodyTable = table.querySelector('table.el-table__body');

        // **全家族に共通の目印。見た目のCSSはすべてこれを見る（skin.js）。**
        // ポータルの表は見出しとボディが別々の <table> なので、両方に付ける。
        //
        // **毎回付け直す。** SPAは外側の `.el-table` を残したまま内側の <table> だけを
        // 差し替えることがある。「初回だけ」にすると、差し替え後の表から目印が消え、
        // **その表だけ見た目が素に戻る**（この種の取りこぼしは過去に何度も出している）。
        //
        // **見出し表・ボディ表だけでなく、配下の <table> をすべて対象にする。**
        // 集約前のCSSは `.el-table th` という総当たりも持っていた。
        // 固定列版（`.el-table__fixed-*`）やフッタ表が現れたとき、
        // 2枚だけを見ていると**その表だけ配色が素に戻る**。
        var innerTables = table.querySelectorAll('table');
        for (var n = 0; n < innerTables.length; n++) {
          innerTables[n].setAttribute('data-dbsext-table', 'portal');
        }

        if (table.classList.contains(SCROLL_CLASS)) continue;
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
      if (link.hasAttribute('data-dbsext-newtab') || isUserLinkAnchor(link)) continue;
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
  // 1c. ユーザ識別番号のリンク化
  //
  // 車両情報 `/vehicles` の一覧で、「ユーザ識別番号」セルの値をクリックすると
  // 対応するユーザ詳細画面を別タブで開く。
  // ---------------------------------------------------------------------------

  function isValidUserId(id) {
    if (!id || typeof id !== 'string') return false;
    return /^USER:[A-Za-z0-9:_-]{1,256}$/.test(id);
  }

  function extractUserId(text) {
    if (!text || typeof text !== 'string') return null;
    var trimmed = text.trim();
    return isValidUserId(trimmed) ? trimmed : null;
  }

  function isValidAreaId(id) {
    if (!id || typeof id !== 'string') return false;
    return /^AREA:[A-Za-z0-9:_-]{1,256}$/.test(id);
  }

  function getSelectedAreaId() {
    if (typeof location === 'undefined') return null;
    var search = location.search;
    if (!search && location.href) {
      var qIdx = location.href.indexOf('?');
      if (qIdx !== -1) {
        search = location.href.substring(qIdx);
        var hIdx = search.indexOf('#');
        if (hIdx !== -1) search = search.substring(0, hIdx);
      }
    }
    if (!search) return null;
    var match = /[?&]selected-area-id=([^&#]*)/.exec(search);
    if (!match) return null;
    var decoded = '';
    try {
      decoded = decodeURIComponent(match[1]);
    } catch (e) {
      return null;
    }
    return isValidAreaId(decoded) ? decoded : null;
  }

  function getHeaderTitle(th) {
    if (!th) return '';
    if (th.hasAttribute && th.hasAttribute('data-dbsext-orig-title')) {
      return th.getAttribute('data-dbsext-orig-title');
    }
    var fullText = (th.textContent || '').trim();
    if (th.querySelectorAll) {
      var customEls = th.querySelectorAll('[data-dbsext-collapse-hint], [data-dbsext-sort], [data-dbsext-filter]');
      if (customEls.length > 0) {
        var customText = '';
        for (var i = 0; i < customEls.length; i++) {
          customText += customEls[i].textContent || '';
        }
        if (customText) {
          fullText = fullText.replace(customText.trim(), '').trim();
        }
      }
    }
    return fullText;
  }

  function openUserLink(href) {
    if (!href) return;
    var targetWindow = typeof window !== 'undefined' ? window : global;
    if (targetWindow && typeof targetWindow.open === 'function') {
      var win = targetWindow.open(href, '_blank', 'noopener,noreferrer');
      if (win) {
        try { win.opener = null; } catch (e) {}
      }
    }
  }

  function handleUserLinkClick(event) {
    var href = event.currentTarget ? event.currentTarget._dbsextHref : null;
    if (!href) return;
    if (typeof event.preventDefault === 'function') event.preventDefault();
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    openUserLink(href);
  }

  function handleUserLinkKeydown(event) {
    if (event.key === 'Enter' || event.keyCode === 13) {
      var href = event.currentTarget ? event.currentTarget._dbsextHref : null;
      if (!href) return;
      if (typeof event.preventDefault === 'function') event.preventDefault();
      if (typeof event.stopPropagation === 'function') event.stopPropagation();
      openUserLink(href);
    }
  }

  var trackedCells = [];
  var trackedAnchors = [];

  function isUserLinkCell(el) {
    return !!el && trackedCells.indexOf(el) !== -1;
  }

  function isUserLinkAnchor(el) {
    return !!el && trackedAnchors.indexOf(el) !== -1;
  }

  function cleanupCell(cell) {
    if (!cell || !isUserLinkCell(cell)) return;

    delete cell._dbsextHref;
    if (cell._dbsextUserLinkBound) {
      cell._dbsextUserLinkBound = false;
      if (typeof cell.removeEventListener === 'function') {
        cell.removeEventListener('click', handleUserLinkClick);
        cell.removeEventListener('keydown', handleUserLinkKeydown);
      }
    }

    if (cell._dbsextOrigRole) {
      if (cell._dbsextOrigRole.has) {
        cell.setAttribute('role', cell._dbsextOrigRole.val);
      } else {
        cell.removeAttribute('role');
      }
      delete cell._dbsextOrigRole;
    } else {
      cell.removeAttribute('role');
    }

    if (cell._dbsextOrigTabindex) {
      if (cell._dbsextOrigTabindex.has) {
        cell.setAttribute('tabindex', cell._dbsextOrigTabindex.val);
      } else {
        cell.removeAttribute('tabindex');
      }
      delete cell._dbsextOrigTabindex;
    } else {
      cell.removeAttribute('tabindex');
    }

    if (cell._dbsextOrigTitle) {
      if (cell._dbsextOrigTitle.has) {
        cell.setAttribute('title', cell._dbsextOrigTitle.val);
        cell.title = cell._dbsextOrigTitle.val;
      } else {
        cell.removeAttribute('title');
        cell.title = '';
      }
      delete cell._dbsextOrigTitle;
    } else {
      cell.removeAttribute('title');
      cell.title = '';
    }

    if (cell.style) {
      if (cell._dbsextOrigCursor) {
        if (cell._dbsextOrigCursor.set) {
          if (typeof cell.style.setProperty === 'function') {
            cell.style.setProperty('cursor', cell._dbsextOrigCursor.val, cell._dbsextOrigCursor.prio || '');
          } else {
            cell.style.cursor = cell._dbsextOrigCursor.val;
          }
        } else {
          if (typeof cell.style.removeProperty === 'function') {
            cell.style.removeProperty('cursor');
          }
          cell.style.cursor = '';
        }
        delete cell._dbsextOrigCursor;
      } else {
        if (typeof cell.style.removeProperty === 'function') {
          cell.style.removeProperty('cursor');
        }
        cell.style.cursor = '';
      }

      if (cell._dbsextOrigTextDec) {
        if (cell._dbsextOrigTextDec.set) {
          if (typeof cell.style.setProperty === 'function') {
            cell.style.setProperty('text-decoration', cell._dbsextOrigTextDec.val, cell._dbsextOrigTextDec.prio || '');
          } else {
            cell.style.textDecoration = cell._dbsextOrigTextDec.val;
          }
        } else {
          if (typeof cell.style.removeProperty === 'function') {
            cell.style.removeProperty('text-decoration');
          }
          cell.style.textDecoration = '';
        }
        delete cell._dbsextOrigTextDec;
      } else {
        if (typeof cell.style.removeProperty === 'function') {
          cell.style.removeProperty('text-decoration');
        }
        cell.style.textDecoration = '';
      }
    }

    var idx = trackedCells.indexOf(cell);
    if (idx !== -1) {
      trackedCells.splice(idx, 1);
    }
  }

  function cleanupAnchor(anchor) {
    if (!anchor || !isUserLinkAnchor(anchor)) return;

    if (anchor._dbsextOrigHref) {
      if (anchor._dbsextOrigHref.has) {
        anchor.setAttribute('href', anchor._dbsextOrigHref.val);
      } else {
        anchor.removeAttribute('href');
      }
      delete anchor._dbsextOrigHref;
    }

    if (anchor._dbsextOrigTarget) {
      if (anchor._dbsextOrigTarget.has) {
        anchor.setAttribute('target', anchor._dbsextOrigTarget.val);
      } else {
        anchor.removeAttribute('target');
      }
      delete anchor._dbsextOrigTarget;
    }

    if (anchor._dbsextOrigRel) {
      if (anchor._dbsextOrigRel.has) {
        anchor.setAttribute('rel', anchor._dbsextOrigRel.val);
      } else {
        anchor.removeAttribute('rel');
      }
      delete anchor._dbsextOrigRel;
    }

    if (anchor._dbsextOrigTitle) {
      if (anchor._dbsextOrigTitle.has) {
        anchor.setAttribute('title', anchor._dbsextOrigTitle.val);
        anchor.title = anchor._dbsextOrigTitle.val;
      } else {
        anchor.removeAttribute('title');
        anchor.title = '';
      }
      delete anchor._dbsextOrigTitle;
    }

    delete anchor._dbsextCleaned;

    var idx = trackedAnchors.indexOf(anchor);
    if (idx !== -1) {
      trackedAnchors.splice(idx, 1);
    }
  }

  function linkifyUserIds() {
    if (typeof document === 'undefined') return;

    var areaId = getSelectedAreaId();
    var isEligible = isVehiclesPage() && !!areaId;

    var activeCells = [];
    var activeAnchors = [];

    if (isEligible) {
      var tables = document.querySelectorAll('.el-table');
      for (var t = 0; t < tables.length; t++) {
        var container = tables[t];
        var headerTable = container.querySelector('table.el-table__header');
        var bodyTable = container.querySelector('table.el-table__body');

        if (!headerTable && container.classList && container.classList.contains('el-table__header')) {
          headerTable = container;
        }
        if (!bodyTable && container.classList && container.classList.contains('el-table__body')) {
          bodyTable = container;
        }

        if (!headerTable || !bodyTable) continue;

        var ths = headerTable.querySelectorAll('th');
        var targetColIndex = -1;
        for (var i = 0; i < ths.length; i++) {
          if (getHeaderTitle(ths[i]) === 'ユーザ識別番号') {
            targetColIndex = i;
            break;
          }
        }

        if (targetColIndex === -1) continue;

        var rows = bodyTable.querySelectorAll('tbody tr');
        if (!rows || rows.length === 0) {
          rows = bodyTable.querySelectorAll('tr');
        }
        for (var r = 0; r < rows.length; r++) {
          var row = rows[r];
          var tds = row.children;
          if (!tds || tds.length === 0) {
            tds = row.querySelectorAll('td');
          }
          if (targetColIndex >= tds.length) continue;
          var cell = tds[targetColIndex];

          var existingLink = cell.querySelector('a');
          if (existingLink) {
            var linkUserId = extractUserId(existingLink.textContent);
            if (linkUserId) {
              if (isUserLinkCell(cell)) {
                cleanupCell(cell);
              }
              delete existingLink._dbsextCleaned;
              if (!isUserLinkAnchor(existingLink)) {
                existingLink._dbsextOrigHref = { has: existingLink.hasAttribute('href'), val: existingLink.getAttribute('href') };
                existingLink._dbsextOrigTarget = { has: existingLink.hasAttribute('target'), val: existingLink.getAttribute('target') };
                existingLink._dbsextOrigRel = { has: existingLink.hasAttribute('rel'), val: existingLink.getAttribute('rel') };
                existingLink._dbsextOrigTitle = { has: existingLink.hasAttribute('title'), val: existingLink.title || existingLink.getAttribute('title') };
                if (trackedAnchors.indexOf(existingLink) === -1) {
                  trackedAnchors.push(existingLink);
                }
              }
              var expectedHref = '/users/general/' + encodeURIComponent(linkUserId) + '?selected-area-id=' + encodeURIComponent(areaId);
              existingLink.setAttribute('href', expectedHref);
              existingLink.setAttribute('target', '_blank');
              existingLink.setAttribute('rel', 'noopener noreferrer');
              existingLink.title = 'ユーザー詳細を別タブで開きます';
              if (activeAnchors.indexOf(existingLink) === -1) {
                activeAnchors.push(existingLink);
              }
            }
          } else {
            var cellUserId = extractUserId(cell.textContent);
            if (cellUserId) {
              if (!isUserLinkCell(cell)) {
                cell._dbsextOrigRole = { has: cell.hasAttribute('role'), val: cell.getAttribute('role') };
                cell._dbsextOrigTabindex = { has: cell.hasAttribute('tabindex'), val: cell.getAttribute('tabindex') };
                cell._dbsextOrigTitle = { has: cell.hasAttribute('title'), val: cell.title || cell.getAttribute('title') };
                var hasStyle = !!cell.style;
                var getPropVal = function (prop) {
                  if (!hasStyle) return '';
                  if (typeof cell.style.getPropertyValue === 'function') {
                    return cell.style.getPropertyValue(prop);
                  }
                  var camel = prop === 'text-decoration' ? 'textDecoration' : prop;
                  return cell.style[camel] || '';
                };
                var getPropPrio = function (prop) {
                  if (!hasStyle) return '';
                  if (typeof cell.style.getPropertyPriority === 'function') {
                    return cell.style.getPropertyPriority(prop) || '';
                  }
                  return '';
                };

                var curVal = getPropVal('cursor');
                var curPrio = getPropPrio('cursor');
                cell._dbsextOrigCursor = {
                  set: curVal !== '' || curPrio !== '',
                  val: curVal,
                  prio: curPrio
                };

                var decVal = getPropVal('text-decoration');
                var decPrio = getPropPrio('text-decoration');
                cell._dbsextOrigTextDec = {
                  set: decVal !== '' || decPrio !== '',
                  val: decVal,
                  prio: decPrio
                };
                if (trackedCells.indexOf(cell) === -1) {
                  trackedCells.push(cell);
                }
              }
              var href = '/users/general/' + encodeURIComponent(cellUserId) + '?selected-area-id=' + encodeURIComponent(areaId);
              cell._dbsextHref = href;
              cell.setAttribute('role', 'link');
              cell.setAttribute('tabindex', '0');
              cell.title = 'ユーザー詳細を別タブで開きます';
              cell.style.cursor = 'pointer';
              cell.style.textDecoration = 'underline';

              if (!cell._dbsextUserLinkBound) {
                cell._dbsextUserLinkBound = true;
                if (typeof cell.addEventListener === 'function') {
                  cell.addEventListener('click', handleUserLinkClick);
                  cell.addEventListener('keydown', handleUserLinkKeydown);
                }
              }
              if (activeCells.indexOf(cell) === -1) {
                activeCells.push(cell);
              }
            }
          }
        }
      }
    }

    for (var m = trackedCells.length - 1; m >= 0; m--) {
      var trackedCell = trackedCells[m];
      if (activeCells.indexOf(trackedCell) === -1) {
        cleanupCell(trackedCell);
      }
    }
    for (var n = trackedAnchors.length - 1; n >= 0; n--) {
      var trackedAnchor = trackedAnchors[n];
      if (activeAnchors.indexOf(trackedAnchor) === -1) {
        cleanupAnchor(trackedAnchor);
      }
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
    // 拡張版では vehicle-pagesize.js が「1000件表示（実ページ遷移方式）」を
    // 別途担う。ここでのドロップダウン操作（最大500）は**ブックマークレット版
    // 専用の代替手段**として残す。両方を同時に走らせると、ドロップダウンを
    // 500へ変えている最中に vehicle-pagesize.js が遷移を起こす、といった
    // 競合の余地が生まれるため、拡張版ではここを止める。
    if (D.platform && (D.platform.kind === 'extension' || D.platform.isUserScript)) return;
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
      linkifyUserIds();
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
 * DBSEXT 車両情報 1000台デフォルトモード
 *
 * **Chrome拡張版（同梱版・配信版）専用機能。ブックマークレット版では動かさない。**
 *
 * ---------------------------------------------------------------------------
 * 経緯（2026-08-10 実機実測で確定）
 * ---------------------------------------------------------------------------
 * 過去2回、別の方式が失敗している。
 *
 *   1. `history.pushState`/`replaceState` で `page-size=1000` をURLへ注入する方式
 *      → **URLは変わるがポータルは読まない**（表示は100のまま）。実機で確定済み（B-1）。
 *   2. 上記を踏まえドロップダウンを実際に操作する方式に戻したが、
 *      選択肢は `50/100/200/500` の4つしかなく、**1000は選べない**。
 *
 * **今回わかったこと**: `history.pushState` ではなく**本物のページ遷移**
 * （`location.href`/`location.replace`）で `?page-size=1000` を含んだ状態で
 * `/vehicles` を開くと、ポータルは実際に1000件表示で応答する
 * （実機スクリーンショットで確認。ページャに「1000」と表示され、779件が
 * 1ページに収まった）。**ただし遷移後に「検索」ボタンを押し直すと、
 * ページサイズが100へ戻ってしまう**ため、遷移した状態をそのまま使い、
 * 拡張側から検索ボタンを押してはいけない。
 *
 * 当時この方式を試したのはブックマークレット版のみで、
 * **本物のページ遷移＝ブックマークレットが失われる**ため、実用にならなかった。
 * 今は拡張機能自体が毎ページロードで確実に再注入されるため、
 * 「遷移し直す」ことを機能の前提にできる。
 *
 * ---------------------------------------------------------------------------
 * 発火条件（暴走・無限リロードを防ぐための歯止め）
 * ---------------------------------------------------------------------------
 *   - `/vehicles` にいる
 *   - URLに `page-size` が**まだ十分な値で入っていない**（初回訪問、または
 *     利用者が明示的にドロップダウンで小さい値へ変えた直後ではない状態）
 *   - **エリアが選択済み**（未選択のまま遷移しても意味がなく、
 *     「未選択」表示のままリロードを繰り返す事故を避ける）
 *   - 同じ読み込みの中で一度試したら、たとえ失敗しても**再挑戦しない**
 *     （エリア未選択が続く限り待ち、選択されたら初めて1回だけ遷移する）
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  var DESIRED_PAGE_SIZE = 1000;
  var AREA_LABEL_RE = /エリア(未選択|選択中)/;

  var triedThisLoad = false;

  function isVehiclesPage() {
    return typeof location !== 'undefined' && /^\/vehicles(\/|$)/.test(location.pathname);
  }

  /**
   * 現在のURLが「すでに十分なpage-sizeを持っている」か。
   * 利用者がドロップダウンで500等へ手動で変えたときも、
   * ポータルはURLへ書き戻す（実測）ため、この判定だけで両立できる。
   */
  function hasSufficientPageSize() {
    if (typeof location === 'undefined') return true;
    var m = location.search.match(/[?&]page-size=(\d+)/);
    if (!m) return false;
    return parseInt(m[1], 10) >= DESIRED_PAGE_SIZE;
  }

  /** state-forms.js と同じ判定（重複を避けるため揃えてある） */
  function getHeaderAreaElement() {
    if (typeof document === 'undefined') return null;
    var exact = document.querySelector('p.col-span-3.cursor-pointer.text-right');
    if (exact && AREA_LABEL_RE.test(exact.textContent || '')) return exact;

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

  function isAreaSelected() {
    var el = getHeaderAreaElement();
    if (!el) return false;
    var text = (el.textContent || '').trim();
    return text.indexOf('未選択') === -1 && AREA_LABEL_RE.test(text);
  }

  /** 既存のクエリを保った上で page-size と page を差し替えたURLを組み立てる */
  function buildTargetUrl() {
    var params = new URLSearchParams(location.search);
    params.set('page-size', String(DESIRED_PAGE_SIZE));
    params.set('page', '1');
    var query = params.toString();
    return location.pathname + (query ? '?' + query : '');
  }

  function isExtensionPlatform() {
    return !!(D.platform && (D.platform.kind === 'extension' || D.platform.isUserScript));
  }

  D.vehiclePageSize = {
    DESIRED_PAGE_SIZE: DESIRED_PAGE_SIZE,

    apply: function () {
      if (typeof document === 'undefined' || typeof location === 'undefined') return;
      if (!isExtensionPlatform()) return;   // ブックマークレット版では何もしない
      if (!isVehiclesPage()) return;
      if (triedThisLoad) return;
      if (hasSufficientPageSize()) return;
      if (!isAreaSelected()) return;        // エリアが決まるまで待つ（次の再適用で再確認）

      triedThisLoad = true;
      var target = buildTargetUrl();
      if (D.core && typeof D.core.log === 'function') {
        D.core.log('車両情報を1000件表示で開き直します: ' + target);
      }
      // 履歴を汚さない（戻るボタンで page-size=100 の状態へ戻らせない）
      location.replace(target);
    },

    // テスト用
    _reset: function () { triedThisLoad = false; },
    _hasTriedThisLoad: function () { return triedThisLoad; },
    _hasSufficientPageSize: hasSufficientPageSize,
    _isAreaSelected: isAreaSelected,
    _buildTargetUrl: buildTargetUrl
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

  /**
   * エリアリストから、コードの重複除去済み配列を抽出する（areaCode優先、
   * 無ければ areaName からの逆引き、それも無ければ生の文字列をそのまま使う）。
   * buildMapUrl と hasKnownArea の両方で使う共通ロジック。
   * @param {Array<Object|string>|null} areaList
   * @returns {Array<string>}
   */
  function extractAreaCodes(areaList) {
    var nameToCode = (D.CONFIG && D.CONFIG.NAME_TO_CODE)
      ? D.CONFIG.NAME_TO_CODE
      : { '福井': 'FKI', '小松': 'KMT', '金沢': 'KNZ', '上田千曲広域': 'SNN', '出雲・松江・境港': 'SPS', '敦賀': 'TRG' };

    if (!areaList || !Array.isArray(areaList)) {
      return [];
    }

    var codes = [];
    for (var i = 0; i < areaList.length; i++) {
      var item = areaList[i];
      var code = '';
      if (typeof item === 'string') {
        // 文字列が渡された場合: コードそのものか、名前からコードへ逆引き
        code = nameToCode[item] || item;
      } else if (item && typeof item.areaCode === 'string' && item.areaCode.length > 0) {
        code = item.areaCode;
      } else if (item && typeof item.areaName === 'string') {
        code = nameToCode[item.areaName] || item.areaName;
      }
      if (code && codes.indexOf(code) === -1) {
        codes.push(code);
      }
    }
    return codes;
  }

  // load() の結果をページ内で使い回す（同一セッション中の重複GETを避ける）。
  // ポータルAPIへの繰り返しポーリングをしない方針のため、1ページで1回のみ取得する。
  var loadPromise = null;

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

      var knownCodes = (D.CONFIG && D.CONFIG.KNOWN_AREA_CODES)
        ? D.CONFIG.KNOWN_AREA_CODES
        : ['FKI', 'KMT', 'KNZ', 'SNN', 'SPS', 'TRG'];

      // コードは3文字のASCIIなので encodeURIComponent 不要 → QRコードがシンプルになる
      var codes = extractAreaCodes(areaList);

      if (codes.length === 0) {
        return null;
      }

      // knownCodes を全件含んでいるかチェック
      var hasAllKnown = true;
      for (var j = 0; j < knownCodes.length; j++) {
        if (codes.indexOf(knownCodes[j]) === -1) {
          hasAllKnown = false;
          break;
        }
      }

      if (hasAllKnown) {
        return baseUrl + '?kanriall';
      }

      // 順序の正規化（knownCodesの並び順に揃える）
      codes.sort(function (a, b) {
        var idxA = knownCodes.indexOf(a);
        var idxB = knownCodes.indexOf(b);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return a.localeCompare(b);
      });

      if (codes.length === 1) {
        return baseUrl + '?area=' + codes[0];
      }

      return baseUrl + '?areas=' + codes.join(',');
    },

    /**
     * ログイン中アカウントが選択できるエリアの中に、バッテリーマップが
     * 対応しているエリア（KNOWN_AREA_CODES）が1つでもあるかを判定する。
     * 起動ボタンの表示可否に使う（対応エリアが1つも無いアカウントには
     * ボタン自体を出さない）。
     * @param {Array<Object|string>|null} areaList
     * @returns {boolean}
     */
    hasKnownArea: function (areaList) {
      var knownCodes = (D.CONFIG && D.CONFIG.KNOWN_AREA_CODES)
        ? D.CONFIG.KNOWN_AREA_CODES
        : ['FKI', 'KMT', 'KNZ', 'SNN', 'SPS', 'TRG'];
      var codes = extractAreaCodes(areaList);
      for (var i = 0; i < codes.length; i++) {
        if (knownCodes.indexOf(codes[i]) !== -1) {
          return true;
        }
      }
      return false;
    },

    /**
     * D.platform.fetchAreas を呼び出し、エリア情報とURLを返す。
     * 同一ページ内での2回目以降の呼び出しは、直前の結果（進行中のPromiseを
     * 含む）をそのまま返す（重複GETを避けるため）。
     * @returns {Promise<{ok: boolean, areas: Array, url: string, error?: string}>}
     */
    load: function () {
      if (loadPromise) {
        return loadPromise;
      }

      // 取得できなかったときに全エリアURLへ落とさない（権限未確認で全件を開かない）
      if (!D.platform || typeof D.platform.fetchAreas !== 'function') {
        loadPromise = Promise.resolve({
          ok: false,
          error: 'D.platform.fetchAreas が利用できません',
          areas: [],
          url: null
        });
        return loadPromise;
      }

      var run = (D.netStatus && D.netStatus.silent) ? D.netStatus.silent : function (f) { return f(); };

      loadPromise = Promise.resolve()
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
          // 失敗時はキャッシュせず、次回のload()で再取得できるようにする
          loadPromise = null;
          return {
            ok: false,
            error: msg,
            areas: [],
            url: null
          };
        });

      return loadPromise;
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

  // ログイン中アカウントの対象エリア確認の進行状況。
  //   null        … 未確認（次の apply() で確認を開始する）
  //   'pending'   … 確認中（D.areas.load() の完了待ち）
  //   'supported' … 対応エリアあり、または確認不能につき安全側でボタンを出す
  //   'unsupported' … 対応エリアが1つも無いことを確認済み、ボタンを出さない
  var areaCheckState = null;

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
            var codeToName2 = (D.CONFIG && D.CONFIG.AREA_CODE_TO_NAME) ? D.CONFIG.AREA_CODE_TO_NAME : {};
            var displayNames = [];
            for (var ni = 0; ni < names.length; ni++) {
              var cn = codeToName2[names[ni]];
              displayNames.push(cn ? names[ni] + ' ' + cn : names[ni]);
            }
            areaText.textContent = '表示範囲: ' + displayNames.join(', ');
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

      var knownCodes = (D.CONFIG && D.CONFIG.KNOWN_AREA_CODES)
        ? D.CONFIG.KNOWN_AREA_CODES
        : ['FKI', 'KMT', 'KNZ', 'SNN', 'SPS', 'TRG'];
      var codeToName = (D.CONFIG && D.CONFIG.AREA_CODE_TO_NAME)
        ? D.CONFIG.AREA_CODE_TO_NAME
        : { FKI: '福井', KMT: '小松', KNZ: '金沢', SNN: '上田千曲広域', SPS: '出雲・松江・境港', TRG: '敦賀' };

      var selectedMap = {};

      var checkboxesDiv = document.createElement('div');
      checkboxesDiv.style.display = 'flex';
      checkboxesDiv.style.flexWrap = 'wrap';
      checkboxesDiv.style.gap = '8px';
      checkboxesDiv.style.marginTop = '8px';

      for (var j = 0; j < knownCodes.length; j++) {
        (function (areaCode) {
          var label = document.createElement('label');
          label.style.fontSize = '13px';
          label.style.cursor = 'pointer';
          label.style.display = 'inline-flex';
          label.style.alignItems = 'center';
          label.style.gap = '4px';

          var chk = document.createElement('input');
          chk.type = 'checkbox';
          chk.value = areaCode;
          chk.addEventListener('change', function () {
            if (chk.checked) {
              selectedMap[areaCode] = true;
            } else {
              delete selectedMap[areaCode];
            }
            var selectedList = [];
            for (var k = 0; k < knownCodes.length; k++) {
              if (selectedMap[knownCodes[k]]) {
                selectedList.push(knownCodes[k]);
              }
            }
            var newUrl = D.areas.buildMapUrl(selectedList);
            updateUrlAndQr(newUrl);
          });

          label.appendChild(chk);
          var displayName = (codeToName[areaCode] || areaCode);
          label.appendChild(document.createTextNode(areaCode + ' ' + displayName));
          checkboxesDiv.appendChild(label);
        })(knownCodes[j]);
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

  function insertLauncherIfAbsent() {
    if (typeof document === 'undefined' || !document.body) return;
    if (document.querySelector('[' + LAUNCHER_ATTR + ']')) return; // 既出（冪等）
    document.body.appendChild(buildLauncher());
  }

  D.mapLauncher = {
    /**
     * 起動ボタンを表示する（冪等・reapply対応）。
     *
     * **ログイン中アカウントの選択可能エリアに、バッテリーマップの対応エリア
     * （KNOWN_AREA_CODES）が1つも含まれない場合はボタン自体を出さない。**
     * 対応外エリア専用アカウントに「押しても使えないボタン」を見せないため。
     *
     * エリア確認は D.areas.load()（GET /api/areas、ページ内1回のみ）の完了を
     * 待ってから初めてボタンを挿入する。取得に失敗した場合は安全側として
     * 通常どおり表示する（false-negativeでボタンを失うより、確認できない
     * 状態で出しておく方を優先）。apply() は reapply:true でSPA遷移のたびに
     * 呼ばれるため、判定結果は状態フラグに保持し、GETは1回しか発行しない。
     */
    apply: function () {
      if (typeof document === 'undefined' || !document.body) return;
      if (document.querySelector('[' + LAUNCHER_ATTR + ']')) return; // 既出（冪等）

      if (areaCheckState === 'supported') {
        insertLauncherIfAbsent();
        return;
      }
      if (areaCheckState === 'unsupported' || areaCheckState === 'pending') {
        return; // 対象外確定、または前回のapply()で確認開始済み・結果待ち
      }

      // areaCheckState === null: 初回。確認を開始する
      if (!D.areas || typeof D.areas.load !== 'function' || typeof D.areas.hasKnownArea !== 'function') {
        // areasモジュールが無い異常系は、従来どおり表示する
        areaCheckState = 'supported';
        insertLauncherIfAbsent();
        return;
      }

      areaCheckState = 'pending';
      D.areas.load().then(function (res) {
        if (res && res.ok && D.areas.hasKnownArea(res.areas)) {
          areaCheckState = 'supported';
          insertLauncherIfAbsent();
        } else if (res && res.ok) {
          // 取得は成功したが、対応エリアが1つも無い
          areaCheckState = 'unsupported';
        } else {
          // 取得失敗（セッション切れ等）。安全側として表示する
          areaCheckState = 'supported';
          insertLauncherIfAbsent();
        }
      }).catch(function () {
        areaCheckState = 'supported';
        insertLauncherIfAbsent();
      });
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
    // 横スクロールバーの見た目は table-wrap.js が共通で与える
    tableWrap.setAttribute('data-dbsext-table-scroll', '1');
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

    var columns = [
      {
        label: 'ビーコン識別番号',
        value: function (item) { return item.portBeaconUniqueCode || item.portBeaconId || ''; },
        render: function (td, item) {
          var code = String(item.portBeaconUniqueCode || item.portBeaconId || '');
          // 10桁の識別番号だけ、ポータル標準検索を開くボタンにする
          if (!/^[A-Za-z0-9]{10}$/.test(code)) {
            td.textContent = code;
            return;
          }
          var codeButton = document.createElement('button');
          codeButton.setAttribute('type', 'button');
          codeButton.className = 'dbsext-cell-link';
          codeButton.textContent = code;
          codeButton.addEventListener('click', function () {
            openNativeBeaconPopup(panel, code);
          });
          td.appendChild(codeButton);
        }
      },
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

    // 描画・並べ替え・絞り込みは custom-table が担う。
    // 以前はここに約110行の自前実装があり、問題申告一覧とほぼ同じものだった
    // （112行中87行が同一。片方だけ直した改修が伝播せず見た目が食い違っていた）。
    //
    // 電圧・バッテリー残量の列は、共通コアの宣言表により
    // **「以上・以下」の数値絞り込み**になる。
    D.customTable.render({
      container: tableWrap,
      rows: sorted,
      columns: columns,
      tableAttrs: { 'data-dbsext-beacons-table': '1' },
      emptyText: '絞り込み条件に一致するビーコンはありません。'
    });
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
      // core.js と同じ理由の防御（実機で確認された例外）。
      // ここは Promise の executor 内なので、素通しにすると呼び出し元に
      // 例外ではなく **rejectとして** 伝わる方が自然（呼び出し元は catch している）。
      try {
        observer.observe(observedRoot, { childList: true, subtree: true, characterData: true });
      } catch (e) {
        reject(new Error('標準検索結果の監視を開始できませんでした: ' + (e && e.message ? e.message : e)));
        return;
      }
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
 * DBSEXT 車両詳細問題申告モジュール
 *
 * /vehicles/{vehicleId} 画面で、ポータル標準の問題申告表を非表示にし、
 * API レスポンスの problemOccurrences を1行1件に展開した
 * 自前テーブルに差し替える。
 *
 * 自前テーブルの機能:
 *   - ヘッダ固定（sticky）
 *   - 列ごとの文字列フィルタ
 *   - 列ごとの昇順／降順並び替え
 *   - 画面表示時に自動取得
 *
 * 安全性:
 *   - ポータルへの書き込み・更新系リクエストは一切発行しない
 *   - 元の表は display:none で隠すのみ（DOMから除去しない）
 *   - 自前UIは data-dbsext-vehicle-problems 属性で識別
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  var CACHE_TTL_MS = 2 * 60 * 1000; // 2分
  var PROBLEM_HEADER_SIGNATURE = '問題申告日時'; // 見出し判定用の特徴語
  var PANEL_ATTR = 'data-dbsext-vehicle-problems';
  var TABLE_ATTR = 'data-dbsext-vp-table';

  var cacheMap = Object.create(null); // vehicleId -> { rows, timestamp }
  var isFetching = false;
  var currentVehicleId = null;
  var currentGeneration = 0;
  var activeGeneration = 0;

  /**
   * URLから車両IDを取得
   */
  function getVehicleIdFromUrl() {
    if (typeof location === 'undefined') return null;
    var m = location.pathname.match(/^\/vehicles\/([A-Za-z0-9:_-]+)$/);
    return m ? m[1] : null;
  }

  /**
   * 問題申告の表を探す（見出しに「問題申告日時」を含む .el-table）
   */
  function findProblemTable() {
    if (typeof document === 'undefined') return null;
    var tables = document.querySelectorAll('.el-table');
    for (var i = 0; i < tables.length; i++) {
      var hdr = tables[i].querySelector('table.el-table__header');
      if (!hdr) continue;
      var ths = hdr.querySelectorAll('thead th');
      for (var j = 0; j < ths.length; j++) {
        if ((ths[j].textContent || '').indexOf(PROBLEM_HEADER_SIGNATURE) !== -1) {
          return tables[i];
        }
      }
    }
    return null;
  }

  /**
   * 表の祖先で、非表示にしても画面レイアウトを壊さない適切なラッパーを探す
   */
  function findTableWrapper(table) {
    if (!table) return null;
    // .el-table の親をたどり、適切な区切りを探す
    var cur = table.parentNode;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      // Element Plus のテーブルは通常 mb-4 などのクラスを持つラッパー内
      if (cur.classList && (cur.classList.contains('mb-4') || cur.classList.contains('py-4'))) {
        return cur;
      }
      // .el-table の直接の親がなければ el-table 自身を返す
      if (cur === table.parentNode && cur.childNodes.length === 1) {
        cur = cur.parentNode;
        continue;
      }
      cur = cur.parentNode;
    }
    return table;
  }

  /**
   * 元の表を非表示にする
   */
  function hideOriginalTable() {
    var table = findProblemTable();
    if (!table) return false;
    if (table.hasAttribute(PANEL_ATTR + '-hidden')) return true; // 既に非表示

    var wrapper = findTableWrapper(table);
    if (wrapper) {
      wrapper.setAttribute(PANEL_ATTR + '-hidden', '1');
      wrapper.style.display = 'none';
    }
    table.setAttribute(PANEL_ATTR + '-hidden', '1');
    return true;
  }

  /**
   * 元の表を再表示する
   */
  function showOriginalTable() {
    var hidden = document.querySelectorAll('[' + PANEL_ATTR + '-hidden="1"]');
    for (var i = 0; i < hidden.length; i++) {
      hidden[i].style.display = '';
      hidden[i].removeAttribute(PANEL_ATTR + '-hidden');
    }
  }

  /**
   * 自前パネルの挿入位置を探す（元の表の wrapper の後）
   */
  function findInsertionPoint() {
    var table = findProblemTable();
    if (!table) return null;
    var wrapper = findTableWrapper(table);
    if (wrapper && wrapper.parentNode) {
      return { container: wrapper.parentNode, targetSibling: wrapper.nextSibling };
    }
    if (table.parentNode) {
      return { container: table.parentNode, targetSibling: table.nextSibling };
    }
    return null;
  }

  /**
   * 自前パネルが既にDOMに存在し、かつ現在の車両IDと一致しているか
   */
  function isPanelValid(panel, vehicleId) {
    if (!panel || !vehicleId) return false;
    if (typeof panel.isConnected === 'boolean' && !panel.isConnected) return false;
    var root = panel;
    while (root.parentNode) root = root.parentNode;
    if (root !== document) return false;
    return panel.getAttribute(PANEL_ATTR + '-vid') === vehicleId;
  }

  /**
   * データ取得と表示
   */
  function fetchAndRender(panel, vehicleId) {
    if (!vehicleId || isFetching) return;

    currentGeneration++;
    var gen = currentGeneration;
    activeGeneration = gen;
    isFetching = true;
    currentVehicleId = vehicleId;

    var statusDiv = panel.querySelector('[' + PANEL_ATTR + '-status]');
    if (statusDiv) {
      statusDiv.textContent = '読み込み中…';
      statusDiv.className = 'dbsext-vp-status';
    }

    // キャッシュ確認
    var now = Date.now();
    var cached = cacheMap[vehicleId];
    if (cached && (now - cached.timestamp < CACHE_TTL_MS)) {
      isFetching = false;
      currentVehicleId = null;
      if (gen === currentGeneration && isPanelValid(panel, vehicleId)) {
        renderTable(panel, cached.rows);
      }
      return;
    }

    // APIから取得
    var url = '/api/vehicles/' + vehicleId + '/problems';
    fetch(url, { credentials: 'include' })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (items) {
        if (!Array.isArray(items)) items = [];
        // problemOccurrences を展開してフラットな行配列にする
        var rows = [];
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          var occs = item.problemOccurrences || [];
          for (var j = 0; j < occs.length; j++) {
            rows.push({
              problemReportTs: item.problemReportTs || '',
              userUniqueCode: item.userUniqueCode || '',
              importanceCategory: occs[j].importanceCategory || '',
              partNameJa: occs[j].partNameJa || '',
              partCode: occs[j].partCode || '',
              occurrenceNameJa: occs[j].occurrenceNameJa || '',
              occurrenceCode: occs[j].occurrenceCode || '',
              collectionStatus: item.collectionStatus || '',
              collectionCompleteExecutionTs: item.collectionCompleteExecutionTs || ''
            });
          }
        }

        cacheMap[vehicleId] = { rows: rows, timestamp: Date.now() };

        if (gen === currentGeneration && isPanelValid(panel, vehicleId)) {
          isFetching = false;
          currentVehicleId = null;
          renderTable(panel, rows);
        } else {
          isFetching = false;
          currentVehicleId = null;
        }
      })
      .catch(function (err) {
        if (gen === currentGeneration && isPanelValid(panel, vehicleId)) {
          isFetching = false;
          currentVehicleId = null;
          if (statusDiv) {
            statusDiv.textContent = '問題申告の取得に失敗しました: ' + (err && err.message ? err.message : String(err));
            statusDiv.className = 'dbsext-vp-error';
          }
        } else {
          isFetching = false;
          currentVehicleId = null;
        }
      });
  }

  /**
   * テーブルを描画
   */
  function renderTable(panel, rows) {
    var statusDiv = panel.querySelector('[' + PANEL_ATTR + '-status]');
    var tableWrap = panel.querySelector('[' + PANEL_ATTR + '-wrap]');
    if (!tableWrap) return;

    // 前回の表示をクリア
    while (tableWrap.firstChild) tableWrap.removeChild(tableWrap.firstChild); // dbsext:own-ui

    if (!rows || rows.length === 0) {
      if (statusDiv) {
        statusDiv.textContent = 'この車両の問題申告はありません。';
        statusDiv.className = 'dbsext-vp-status';
      }
      return;
    }

    if (statusDiv) {
      statusDiv.textContent = '全 ' + rows.length + ' 件（部位×事象を展開）';
      statusDiv.className = 'dbsext-vp-status';
    }

    var columns = [
      { label: '問題申告日時',    value: function (r) { return r.problemReportTs; } },
      {
        label: 'ユーザ識別番号',
        value: function (r) { return r.userUniqueCode; },
        render: function (td, r) {
          var a = document.createElement('a');
          a.setAttribute('href', '/users/' + (r.userUniqueCode || ''));
          a.textContent = r.userUniqueCode || '';
          a.className = 'dbsext-cell-link';
          td.appendChild(a);
        }
      },
      { label: '重要度',          value: function (r) { return r.importanceCategory; } },
      { label: '部位',            value: function (r) { return r.partNameJa; } },
      { label: '事象',            value: function (r) { return r.occurrenceNameJa; } },
      { label: '回収状況',        value: function (r) { return r.collectionStatus; } },
      { label: '回収完了日時',    value: function (r) { return r.collectionCompleteExecutionTs; } }
    ];

    // 描画・並べ替え・絞り込みは custom-table が担う。
    // 以前はここに約110行の自前実装があり、ビーコン一覧とほぼ同じものだった。
    D.customTable.render({
      container: tableWrap,
      rows: rows,
      columns: columns,
      tableAttrs: (function () { var a = {}; a[TABLE_ATTR] = '1'; return a; })(),
      emptyText: '絞り込み条件に一致する申告はありません。'
    });
  }

  /**
   * 自前パネルを構築
   */
  function buildPanel(vehicleId) {
    if (typeof document === 'undefined') return null;

    var existing = document.querySelector('[' + PANEL_ATTR + '="1"]');
    if (existing) {
      // 車両が変わったら破棄して作り直す
      if (existing.getAttribute(PANEL_ATTR + '-vid') !== vehicleId) {
        if (existing.parentNode) existing.parentNode.removeChild(existing); // dbsext:own-ui
        currentGeneration++;
        isFetching = false;
        currentVehicleId = null;
      } else {
        return existing;
      }
    }

    var insertion = findInsertionPoint();
    if (!insertion || !insertion.container) return null;

    var panel = document.createElement('div');
    panel.setAttribute(PANEL_ATTR, '1');
    panel.setAttribute(PANEL_ATTR + '-vid', vehicleId);

    var header = document.createElement('div');
    header.className = 'dbsext-vp-header';

    var h2 = document.createElement('h3');
    h2.textContent = '問題申告一覧（拡張）';
    header.appendChild(h2);

    var statusDiv = document.createElement('div');
    statusDiv.setAttribute(PANEL_ATTR + '-status', '1');
    header.appendChild(statusDiv);

    panel.appendChild(header);

    var tableWrap = document.createElement('div');
    tableWrap.setAttribute(PANEL_ATTR + '-wrap', '1');
    tableWrap.className = 'dbsext-vp-table-wrap';
    // 横スクロールバーの見た目は table-wrap.js が共通で与える
    tableWrap.setAttribute('data-dbsext-table-scroll', '1');
    panel.appendChild(tableWrap);

    if (insertion.targetSibling) {
      insertion.container.insertBefore(panel, insertion.targetSibling);
    } else {
      insertion.container.appendChild(panel);
    }

    return panel;
  }

  /**
   * 画面離脱時の後片付け
   */
  function teardown() {
    showOriginalTable();
    var panel = document.querySelector('[' + PANEL_ATTR + '="1"]');
    if (panel && panel.parentNode) {
      panel.parentNode.removeChild(panel); // dbsext:own-ui
    }
    currentGeneration++;
    isFetching = false;
    currentVehicleId = null;
  }

  D.vehicleProblems = {
    apply: function () {
      if (typeof document === 'undefined' || !document.body) return;

      var vehicleId = getVehicleIdFromUrl();

      // 車両詳細画面以外では元の表を表示し自前パネルを撤去
      if (!vehicleId) {
        var panel = document.querySelector('[' + PANEL_ATTR + '="1"]');
        if (panel) teardown();
        return;
      }

      // 車両詳細画面: 元の表を隠し自前パネルを表示
      if (!hideOriginalTable()) return; // 表が見つからなければ何もしない

      var panel = buildPanel(vehicleId);
      if (!panel) return;

      fetchAndRender(panel, vehicleId);
    },

    /**
     * 「オリジナルに戻す」表示専用。自前パネルは（own-root として）別途隠れる前提で、
     * 隠していたポータル標準の表だけを一時的に見せる。
     */
    peekShowAll: function () {
      showOriginalTable();
    },

    /** 「オリジナルに戻す」を解除し、標準の表を再び隠して自前パネルへ戻す */
    peekRestore: function () {
      if (getVehicleIdFromUrl()) hideOriginalTable();
    },

    // テスト用
    _clearCache: function () {
      cacheMap = Object.create(null);
      currentGeneration++;
      isFetching = false;
      currentVehicleId = null;
    },
    _getVehicleIdFromUrl: getVehicleIdFromUrl,
    _findProblemTable: findProblemTable
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);

/**
 * DBSEXT ポート情報 一括操作モジュール
 *
 * `/ports` 限定。選択した複数ポートに対し、運用状態の変更をまとめて実行する。
 *
 * ---------------------------------------------------------------------------
 * これは契約§6の原則に対する明示的な例外である
 * ---------------------------------------------------------------------------
 * 他の全モジュールは読み取り専用（GET）に徹しているが、このモジュールだけは
 * `PUT /api/ports/{portId}` を発行する。2026-08-12 人間決裁により、実機での
 * 検証（`docs/02-portal-facts.md` §5「フェーズ0.5 実施結果」）を踏まえた
 * 限定的な例外として認められている。詳細は `AGENTS.md` 禁止事項1の例外条項、
 * `docs/06-module-contract.md` §6の例外条項を参照。
 *
 * **この例外は本ファイルの書き込み先（`/api/ports/{portId}` へのPUT）に限定される。**
 * 他のいかなるエンドポイントへの更新系リクエストも許可されない。
 *
 * ---------------------------------------------------------------------------
 * 最重要の安全ルール: レコード全体を送り返す方式である
 * ---------------------------------------------------------------------------
 * 実機確認の結果、`PUT /api/ports/{portId}` は**レコード全体**を要求する
 * （部分更新ではない）。ポート名・住所・緯度経度・シェアリング設定・
 * ビーコン紐付け配列まで、画面に出ている・出ていないに関わらず全項目を
 * 含めて送り返す必要がある。
 *
 * そのため、**対象ポートごとに実行の直前で必ず`GET /api/ports/{portId}`から
 * 最新のレコードを取得し直し、変更したい項目以外は一切書き換えずに
 * そのまま`PUT`で送り返す。** 選択時に読み込んだ一覧のキャッシュや、
 * 他のポートを処理している間に古くなったデータを使い回してはいけない。
 * さもないと、意図しない項目（シェアリング設定・予約数・ビーコン紐付け等）
 * を静かに壊す恐れがある。取得した応答が本当に完全なレコードかも検証する
 * （`isValidPortDetailRecord()`。2026-08-12 独立監査で「形を検証していない」と
 * 指摘され対応した）。
 *
 * ---------------------------------------------------------------------------
 * 変更対象フィールドの確度について
 * ---------------------------------------------------------------------------
 * - `serviceState`（運用状態）: `investigation/probe_service_state_options.py`
 *   （2026-08-12・非破壊。ドロップダウンを開いて選択肢を読むだけで何も選ばず閉じた）で
 *   全選択肢を確認済み: 「運用中」「運用中（貸出制限中）」「一時駐輪用」「一時休止中」「停止中」。
 *   このうち「停止中」「一時休止中」は実際にPUTでの往復も実測済み（`docs/02-portal-facts.md`§5）
 * - `publishFlag`（公開・非公開）: `investigation/probe_port_field_mapping.py`
 *   （2026-08-12・非破壊。敦賀エリア8ポートで詳細画面のラジオボタン選択状態と
 *   `GET /api/ports/{id}`の`publishFlag`を突き合わせ）で、**8件すべて`公開`⇔`true`が一致**
 *   することを確認済み。ただしサンプルに`非公開`の実例が無く、`false`⇔`非公開`の対応は
 *   推論（消去法）であり実測ではない。以上の根拠により`PUBLISH_FLAG_VERIFIED`をtrueにした
 *
 * ---------------------------------------------------------------------------
 * 実行中の画面・エリア変更に対する安全装置（2026-08-12 独立監査で指摘・対応）
 * ---------------------------------------------------------------------------
 * 逐次実行は複数秒〜数十秒かかりうる。その間に利用者が `/ports` から離れたり
 * 別エリアを選び直したりした場合、**古い対象への書き込みを続けてはいけない。**
 * `activeRunToken` で「今有効な実行」を1つに絞り、各行の処理直前・直後に
 * 画面パス・選択中エリア・トークンの一致を再確認する（`isRunStillValid()`）。
 * 不一致になった時点で、実行中の1件だけ完了させ、以降は「中断」と同じ扱いで
 * スキップする。
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  var PANEL_ATTR = 'data-dbsext-port-bulk-panel';
  var PACE_MS = 700; // 行間の意図的な待機。タイトループにしない
  var CACHE_TTL_MS = 60 * 1000; // 1分。一覧の再取得負荷を抑えるだけの短いキャッシュ

  // 運用状態の選択肢。実機のドロップダウンを非破壊で読んで確認済み（上記コメント参照）
  var SERVICE_STATE_OPTIONS = ['運用中', '運用中（貸出制限中）', '一時駐輪用', '一時休止中', '停止中'];
  // 公開設定の選択肢。true=公開 / false=非公開（上記コメント参照。非公開側は推論）
  var PUBLISH_FLAG_OPTIONS = [
    { label: '公開', value: true },
    { label: '非公開', value: false }
  ];
  // 2026-08-12: 実機の非破壊調査（上記コメント参照）で公開⇔trueの対応を確認できたため有効化
  var PUBLISH_FLAG_VERIFIED = true;
  var NO_CHANGE = '__no_change__';

  var cacheByArea = Object.create(null); // areaId -> { rows, timestamp }
  // portId -> { value: boolean|null, timestamp }。表示専用（書き込み判定には使わない。
  // 書き込み直前は必ず startExecution() が別途 fetchPortDetail() で取り直す）
  var publishFlagCache = Object.create(null);
  var selectedIds = Object.create(null); // portId -> true
  var currentGeneration = 0; // 画面/エリアの世代（エリア切替・離脱のたびに進める。早期無効化用）
  var listFetchSeq = 0; // 一覧取得の通し番号（フェッチ開始のたびに進める。追い越し検知用）
  var activeRunToken = 0; // 逐次実行の世代（実行開始のたびに進める）
  var runState = null; // { aborted, results, total, token }

  // ---------------------------------------------------------------------------
  // ヘルパ
  // ---------------------------------------------------------------------------

  function isValidPortalId(value) {
    return typeof value === 'string' && value.length >= 1 && value.length <= 256 && /^[A-Za-z0-9:_-]+$/.test(value);
  }

  /** `beacons.js` と同じ手法。URLの `selected-area-id` を読む */
  function getSelectedAreaId() {
    if (typeof location === 'undefined' || !location.search) return null;
    var match = location.search.match(/[?&]selected-area-id=([^&]+)/);
    if (!match) return null;
    try {
      var decoded = decodeURIComponent(match[1]);
      if (isValidPortalId(decoded)) return decoded;
    } catch (e) {
      // 不正な percent encoding
    }
    return null;
  }

  function isPortsListPath() {
    return typeof location !== 'undefined' && location.pathname === '/ports';
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild); // dbsext:own-ui
  }

  // 実機確認済みのレコード全項目（敦賀「19.ニューサンピア敦賀」でのPUTボディ実測。
  // `docs/02-portal-facts.md` §5参照）。**この一覧が唯一の宣言場所。**
  // 2026-08-12 3回目独立監査「3項目しか見ておらず不完全な応答でもPUTしてしまう」
  // への対応。欠けていれば「不完全」として弾き、その行は失敗扱いにする（PUTしない）。
  // 実機の別ポートで未知のフィールドが増減する可能性はあるが、
  // **未知の欠落を検出できない方が実害（他項目の消失）が大きいため、判定は厳しめに倒す。**
  //
  // 2026-08-12 本番配信後の実機テストで「ポート詳細の応答形式が不正です」により
  // 全件失敗（`investigation/probe_port_detail_shape.py`で `GET /api/ports/{id}` を
  // 2ポート実測して確認）。**`beaconIds` は `GET` 応答に一度も含まれないキーだった。**
  // 手動PUT実測（§5）で観測した「PUTボディにbeaconIdsが含まれる」事実は、ポータル
  // 純正のVueアプリが別経路（このGETとは別のAPI）から補って送信しているためと見られ、
  // `GET`をそのまま返す本機能では最初から取得できない値だった。よって必須項目から外す。
  // `buildUpdatedRecord()` は `record` に存在するキーだけをコピーするため、
  // `beaconIds` を必須から外しても「無いものを勝手に空配列として送る」動作にはならず、
  // 実際のGET応答をそのまま返す（＝このキー自体を含まないPUTボディになる）。
  // 残る未確認点: ビーコンが紐づいているポートに対してこのPUTがビーコン紐付けへ
  // 影響しないかは未検証（今回サンプルの2ポートはいずれも`beaconIds`欄自体が無かった）。
  var REQUIRED_RECORD_KEYS = [
    'portUniqueCode', 'portNameJa', 'portNameEn', 'portBusinessType',
    'affiliationAreaId', 'affiliationBlockId', 'serviceState', 'publishFlag',
    'location', 'globalLocationLatitude', 'globalLocationLongitude',
    'portAddressPostCode', 'portAddressPrefecture', 'portAddressMunicipalities',
    'portAddressBuilding', 'businessHoursStartTime', 'businessHoursEndTime',
    'businessHoursNote', 'portImageId', 'directionsComment', 'note',
    'sharingSetting', 'portRange', 'rackCount', 'parkingQuantityLimitationFlag',
    'portAppropriateVehicleQuantity', 'parkingQuantity', 'returnReservationQuantity',
    'lastReceivedTs', 'returnableVehicleQuantity',
    'portSharedBys', 'portSharingTos', 'landownerSettlements'
  ];
  var REQUIRED_ARRAY_KEYS = ['portSharedBys', 'portSharingTos', 'landownerSettlements'];

  /**
   * `GET /api/ports/{id}` の応答が本当に完全なレコードかを確認する。
   * 2026-08-12 独立監査（1回目・3回目）「形を検証せずPUTしている」「3項目しか
   * 見ておらず不完全な応答でも通る」への対応。ポートIDそのものはレコード本文に
   * 含まれない仕様（実機確認済み）のため、一致確認はできないが、既知の
   * 必須フィールド**全項目**の存在・型を確かめる。
   */
  function isValidPortDetailRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
    for (var i = 0; i < REQUIRED_RECORD_KEYS.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(record, REQUIRED_RECORD_KEYS[i])) return false;
    }
    if (typeof record.serviceState !== 'string') return false;
    if (typeof record.publishFlag !== 'boolean') return false;
    for (var j = 0; j < REQUIRED_ARRAY_KEYS.length; j++) {
      if (!Array.isArray(record[REQUIRED_ARRAY_KEYS[j]])) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // API呼び出し
  // ---------------------------------------------------------------------------

  /** 一覧取得（読み取り専用）。areaId/portIdはポータル自身が発行するID形式（コロン込み）で、
   * 実機確認済みのURLはコロンをエンコードしない形だったため、ここでも合わせる */
  function fetchPortsList(areaId) {
    var url = '/api/ports/bulk?areaIds=' + areaId;
    return fetch(url, { credentials: 'include' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (items) {
      return Array.isArray(items) ? items : [];
    });
  }

  /**
   * 対象ポートの最新レコードを取得（読み取り専用）。実行の直前に毎回呼ぶこと。
   * 応答の形も検証する（不正なら例外を投げ、呼び出し側で「失敗」として扱う）。
   */
  function fetchPortDetail(portId) {
    var url = '/api/ports/' + portId;
    return fetch(url, { credentials: 'include' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (record) {
      if (!isValidPortDetailRecord(record)) {
        throw new Error('ポート詳細の応答形式が不正です');
      }
      return record;
    });
  }

  /**
   * レコード全体を送り返す。**唯一の書き込みエンドポイント。**
   * `record` は直前の `fetchPortDetail` の結果をそのまま使い、
   * 変更したいフィールドだけを書き換えたものであること。
   */
  function putPortDetail(portId, record) {
    var url = '/api/ports/' + portId;
    return fetch(url, {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record)
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res;
    });
  }

  // ---------------------------------------------------------------------------
  // パネル構築
  // ---------------------------------------------------------------------------

  function ensurePanel() {
    var existing = document.querySelector('[' + PANEL_ATTR + ']');
    if (existing) return existing;

    var insertion = findInsertionPoint();
    if (!insertion) return null;

    var panel = document.createElement('div');
    panel.setAttribute(PANEL_ATTR, '1');
    panel.className = 'dbsext-port-bulk-panel';

    var heading = document.createElement('h2');
    heading.textContent = 'ポート一括操作（拡張）';
    panel.appendChild(heading);

    var status = document.createElement('div');
    status.className = 'dbsext-port-bulk-status';
    panel.appendChild(status);

    var toolbar = document.createElement('div');
    toolbar.className = 'dbsext-port-bulk-toolbar';
    panel.appendChild(toolbar);

    var tableWrap = document.createElement('div');
    tableWrap.className = 'dbsext-port-bulk-table-wrap';
    tableWrap.setAttribute('data-dbsext-table-scroll', '1');
    panel.appendChild(tableWrap);

    var confirmBox = document.createElement('div');
    confirmBox.className = 'dbsext-port-bulk-confirm';
    confirmBox.style.display = 'none';
    panel.appendChild(confirmBox);

    var resultsBox = document.createElement('div');
    resultsBox.className = 'dbsext-port-bulk-results';
    resultsBox.style.display = 'none';
    panel.appendChild(resultsBox);

    if (insertion.targetSibling) {
      insertion.container.insertBefore(panel, insertion.targetSibling);
    } else {
      insertion.container.appendChild(panel);
    }

    return panel;
  }

  /** ポータル標準の表の直前に置く（`beacons.js` の `findInsertionPoint` と同じ考え方） */
  function findInsertionPoint() {
    var portalTable = document.querySelector('.el-table:not([data-dbsext-port-bulk-table])');
    if (!portalTable) {
      // 表がまだ描画されていない場合は本文の適当な位置に足す
      var main = document.querySelector('main') || document.body;
      return main ? { container: main, targetSibling: main.firstChild } : null;
    }
    var section = portalTable;
    while (section && section !== document.body && section !== document.documentElement) {
      if (section.classList && section.classList.contains('mb-4') && section.parentNode) {
        return { container: section.parentNode, targetSibling: section };
      }
      section = section.parentNode;
    }
    return portalTable.parentNode ? { container: portalTable.parentNode, targetSibling: portalTable } : null;
  }

  /**
   * ポータル純正の`.el-table`を表示/非表示にする（依頼1対応）。
   * 削除・移動はしない（契約§6）。`display`を切り替えるだけ。
   * SPA再描画で純正表のDOMノードが作り直される場合に備え、毎回その場で探し直す。
   */
  function setNativeTableHidden(hidden) {
    var t = document.querySelector('.el-table:not([data-dbsext-port-bulk-table])');
    if (t) t.style.display = hidden ? 'none' : '';
    return t;
  }

  function setStatus(panel, text, kind) {
    var status = panel.querySelector('.dbsext-port-bulk-status');
    if (!status) return;
    status.textContent = text || '';
    status.className = 'dbsext-port-bulk-status' + (kind ? ' dbsext-port-bulk-status--' + kind : '');
  }

  // ---------------------------------------------------------------------------
  // 表の描画（自前表。custom-table アダプタを使う）
  // ---------------------------------------------------------------------------

  function renderTable(panel, rows) {
    var tableWrap = panel.querySelector('.dbsext-port-bulk-table-wrap');
    if (!tableWrap) return;

    // **一覧が入れ替わるたびに選択状態を今の行に合わせる。**
    // 2026-08-12 独立監査「古い選択IDを実行対象にできる」への対応。
    // 一覧から消えた・識別番号が不正な行の選択は残さない
    var validIds = Object.create(null);
    for (var r = 0; r < rows.length; r++) {
      if (rows[r] && isValidPortalId(rows[r].portId)) validIds[rows[r].portId] = true;
    }
    for (var key in selectedIds) {
      if (!validIds[key]) delete selectedIds[key];
    }

    var areaId = getSelectedAreaId();

    var columns = [
      {
        label: '選択',
        value: function (row) { return selectedIds[row.portId] ? '1' : '0'; },
        render: function (td, row) {
          // 識別番号が不正な行は選択させない（そのまま書き込みURLへ連結されるため）
          if (!isValidPortalId(row.portId)) {
            td.textContent = '（識別番号不正）';
            return;
          }
          var checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.className = 'dbsext-port-bulk-checkbox';
          // 見出しの「一括選択」チェックボックスが、表示中の行を辿るための目印。
          // data-dbsext-* ではない自前の属性なので ATTR_KIND への登録は不要
          checkbox.setAttribute('data-port-id', row.portId);
          checkbox.checked = !!selectedIds[row.portId];
          checkbox.addEventListener('change', function () {
            if (checkbox.checked) selectedIds[row.portId] = true;
            else delete selectedIds[row.portId];
            updateToolbar(panel);
            syncSelectAllHeaderCheckbox(panel);
          });
          td.appendChild(checkbox);
        }
      },
      {
        label: 'ポート識別番号',
        value: function (row) { return row.portUniqueCode != null ? String(row.portUniqueCode) : ''; },
        render: function (td, row) {
          var text = row.portUniqueCode != null ? String(row.portUniqueCode) : '';
          // オリジナルの一覧行と同様、個別編集画面をタブ開きにする（依頼2対応）。
          // 識別番号が不正な行はリンク化しない（URLへそのまま連結されるため）
          if (!isValidPortalId(row.portId)) {
            td.textContent = text;
            return;
          }
          var a = document.createElement('a');
          a.className = 'dbsext-cell-link';
          a.setAttribute('href', '/ports/' + row.portId + (areaId ? '?selected-area-id=' + areaId : ''));
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener');
          a.textContent = text;
          td.appendChild(a);
        }
      },
      { label: 'ポート名', value: function (row) { return row.portNameJa || ''; } },
      { label: '運用状態', value: function (row) { return row.serviceState || ''; } },
      {
        // 一覧API（GET /api/ports/bulk）にはpublishFlagが含まれない（実機確認済み。
        // investigation/probe_port_list_shape.py）ため、この列は行ごとに個別GETした
        // 結果（publishFlagCache）を表示する。ensurePublishFlags()が非同期で埋める
        label: '公開設定',
        value: function (row) {
          var entry = publishFlagCache[row.portId];
          if (!entry || entry.value === null || entry.value === undefined) return '';
          return entry.value ? '公開' : '非公開';
        },
        render: function (td, row) {
          td.setAttribute('data-publish-cell-port-id', row.portId);
          var entry = publishFlagCache[row.portId];
          if (!entry) { td.textContent = '取得中…'; return; }
          if (entry.value === null || entry.value === undefined) { td.textContent = '不明'; return; }
          td.textContent = entry.value ? '公開' : '非公開';
        }
      }
    ];

    var result = D.customTable.render({
      container: tableWrap,
      rows: rows,
      columns: columns,
      tableAttrs: { 'data-dbsext-port-bulk-table': '1' },
      emptyText: '絞り込み条件に一致するポートはありません。'
    });

    addSelectAllHeaderCheckbox(panel, result && result.table);
  }

  /**
   * 選択列の見出しに「表示中の行を一括選択/解除」するチェックボックスを追加する（依頼5対応）。
   * オリジナルの車両情報表（ポータル純正）の見出しチェックボックスと同じ考え方。
   *
   * 自前表(`custom-table.js`)は絞り込みで非該当行を**tbodyから完全に取り除く**方式のため、
   * 「その時点でtbodyに存在する行」＝「絞り込み後に見えている行」となる。よって
   * ハンドラは、tbody内に今ある `.dbsext-port-bulk-checkbox` の `data-port-id` を
   * 一括で選択/解除するだけでよい（`table-tools.js`の`hookVisibleSelectAll()`と
   * 同じ考え方だが、ポータル純正のVue状態を経由しない自前チェックボックスのため
   * `.checked`を直接書き換えてよい）。
   */
  function addSelectAllHeaderCheckbox(panel, table) {
    if (!table) return;
    var headerRow = table.querySelector('thead tr');
    if (!headerRow || !headerRow.children[0]) return;
    var th = headerRow.children[0];

    var checkbox = th.querySelector('.dbsext-port-bulk-select-all');
    if (!checkbox) {
      checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'dbsext-port-bulk-select-all';
      checkbox.title = '表示中の行をすべて選択／解除';
      checkbox.addEventListener('click', function (e) { e.stopPropagation(); });
      checkbox.addEventListener('change', function () {
        var tbody = table.querySelector('tbody');
        var rowCheckboxes = tbody ? tbody.querySelectorAll('.dbsext-port-bulk-checkbox') : [];
        var shouldSelect = checkbox.checked;
        for (var i = 0; i < rowCheckboxes.length; i++) {
          var cb = rowCheckboxes[i];
          var pid = cb.getAttribute('data-port-id');
          if (!pid) continue;
          cb.checked = shouldSelect;
          if (shouldSelect) selectedIds[pid] = true;
          else delete selectedIds[pid];
        }
        updateToolbar(panel);
      });
      th.insertBefore(checkbox, th.firstChild);
    }
    syncSelectAllHeaderCheckbox(panel);
  }

  /** 見出しチェックボックスの見た目を、今の選択状態（全選択/一部選択/未選択）に合わせる */
  function syncSelectAllHeaderCheckbox(panel) {
    var tableWrap = panel.querySelector('.dbsext-port-bulk-table-wrap');
    var headerCheckbox = tableWrap && tableWrap.querySelector('.dbsext-port-bulk-select-all');
    if (!headerCheckbox) return;
    var rowCheckboxes = tableWrap.querySelectorAll('.dbsext-port-bulk-checkbox');
    var total = rowCheckboxes.length;
    var checkedCount = 0;
    for (var i = 0; i < total; i++) {
      if (rowCheckboxes[i].checked) checkedCount++;
    }
    headerCheckbox.checked = total > 0 && checkedCount === total;
    headerCheckbox.indeterminate = checkedCount > 0 && checkedCount < total;
  }

  // ---------------------------------------------------------------------------
  // ツールバー（選択件数・操作選択・実行ボタン）
  // ---------------------------------------------------------------------------

  function buildOptionEl(value, label) {
    var opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    return opt;
  }

  function renderToolbar(panel, rows) {
    var toolbar = panel.querySelector('.dbsext-port-bulk-toolbar');
    if (!toolbar) return;
    clearNode(toolbar);

    var countLabel = document.createElement('span');
    countLabel.className = 'dbsext-port-bulk-count';
    toolbar.appendChild(countLabel);

    var serviceSelect = document.createElement('select');
    serviceSelect.className = 'dbsext-port-bulk-service-select';
    serviceSelect.appendChild(buildOptionEl(NO_CHANGE, '運用状態を変更しない'));
    for (var i = 0; i < SERVICE_STATE_OPTIONS.length; i++) {
      serviceSelect.appendChild(buildOptionEl(SERVICE_STATE_OPTIONS[i], '運用状態を「' + SERVICE_STATE_OPTIONS[i] + '」にする'));
    }
    toolbar.appendChild(serviceSelect);

    // **公開設定は実機未検証のため、確認が済むまでUIを出さない**
    // （2026-08-12 独立監査の指摘）。PUBLISH_FLAG_VERIFIED を参照する箇所は
    // ここ1箇所だけなので、検証後は true にするだけで有効化できる
    var publishSelect = null;
    if (PUBLISH_FLAG_VERIFIED) {
      publishSelect = document.createElement('select');
      publishSelect.className = 'dbsext-port-bulk-publish-select';
      publishSelect.appendChild(buildOptionEl(NO_CHANGE, '公開設定を変更しない'));
      for (var j = 0; j < PUBLISH_FLAG_OPTIONS.length; j++) {
        publishSelect.appendChild(buildOptionEl(String(PUBLISH_FLAG_OPTIONS[j].value), '「' + PUBLISH_FLAG_OPTIONS[j].label + '」にする'));
      }
      toolbar.appendChild(publishSelect);
      publishSelect.addEventListener('change', function () { updateToolbar(panel); });
    } else {
      var note = document.createElement('span');
      note.className = 'dbsext-port-bulk-unverified-note';
      note.textContent = '公開設定の一括変更は実機検証が済むまで提供していません';
      toolbar.appendChild(note);
    }

    var execBtn = document.createElement('button');
    execBtn.type = 'button';
    execBtn.className = 'dbsext-btn dbsext-port-bulk-exec-btn';
    execBtn.textContent = '実行';
    execBtn.addEventListener('click', function () {
      onExecuteClick(panel, rows, serviceSelect.value, publishSelect ? publishSelect.value : NO_CHANGE);
    });
    toolbar.appendChild(execBtn);

    serviceSelect.addEventListener('change', function () { updateToolbar(panel); });

    updateToolbar(panel);
  }

  function updateToolbar(panel) {
    var toolbar = panel.querySelector('.dbsext-port-bulk-toolbar');
    if (!toolbar) return;
    var countLabel = toolbar.querySelector('.dbsext-port-bulk-count');
    var execBtn = toolbar.querySelector('.dbsext-port-bulk-exec-btn');
    var serviceSelect = toolbar.querySelector('.dbsext-port-bulk-service-select');
    var publishSelect = toolbar.querySelector('.dbsext-port-bulk-publish-select');

    var count = Object.keys(selectedIds).length;
    if (countLabel) countLabel.textContent = count + '件選択中';

    if (execBtn) {
      var hasAction = !!(serviceSelect && serviceSelect.value !== NO_CHANGE) ||
        !!(publishSelect && publishSelect.value !== NO_CHANGE);
      execBtn.disabled = count === 0 || !hasAction;
    }
  }

  // ---------------------------------------------------------------------------
  // 確認画面
  // ---------------------------------------------------------------------------

  function describeChanges(serviceValue, publishValue) {
    var lines = [];
    if (serviceValue !== NO_CHANGE) lines.push('運用状態 → 「' + serviceValue + '」');
    if (publishValue !== NO_CHANGE) {
      var label = publishValue === 'true' ? '公開' : '非公開';
      lines.push('公開設定 → 「' + label + '」');
    }
    return lines;
  }

  function onExecuteClick(panel, rows, serviceValue, publishValue) {
    var targetIds = Object.keys(selectedIds);
    if (targetIds.length === 0) return;

    // **確認画面を開いた時点のエリアを固定する。**
    // 2026-08-12 3回目独立監査「URLだけエリアを変えてapply()が呼ばれる前に
    // 古い確認ボタンを押すと、新エリアのrunAreaIdの下で旧エリアのtargetIdsが
    // 実行されてしまう」への対応。確定クリック時に、ここで固定した値と
    // 現在の状態が一致するかを再確認してから実行を始める（時間差を作らない）
    var confirmAreaId = getSelectedAreaId();

    var byId = Object.create(null);
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && rows[i].portId) byId[rows[i].portId] = rows[i];
    }

    var toolbar = panel.querySelector('.dbsext-port-bulk-toolbar');
    var tableWrap = panel.querySelector('.dbsext-port-bulk-table-wrap');
    var confirmBox = panel.querySelector('.dbsext-port-bulk-confirm');
    if (!confirmBox) return;

    clearNode(confirmBox);

    var title = document.createElement('h3');
    title.textContent = '次の内容で実行します。よろしいですか？';
    confirmBox.appendChild(title);

    var changeList = document.createElement('ul');
    var changes = describeChanges(serviceValue, publishValue);
    for (var c = 0; c < changes.length; c++) {
      var li = document.createElement('li');
      li.textContent = changes[c];
      changeList.appendChild(li);
    }
    confirmBox.appendChild(changeList);

    var targetLabel = document.createElement('p');
    targetLabel.textContent = '対象（' + targetIds.length + '件）:';
    confirmBox.appendChild(targetLabel);

    var targetList = document.createElement('ul');
    targetList.className = 'dbsext-port-bulk-confirm-targets';
    for (var t = 0; t < targetIds.length; t++) {
      var row = byId[targetIds[t]];
      var tli = document.createElement('li');
      tli.textContent = row ? row.portNameJa || targetIds[t] : targetIds[t];
      targetList.appendChild(tli);
    }
    confirmBox.appendChild(targetList);

    var btnRow = document.createElement('div');
    btnRow.className = 'dbsext-port-bulk-confirm-buttons';

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'dbsext-btn dbsext-btn--plain';
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.addEventListener('click', function () {
      confirmBox.style.display = 'none';
      if (toolbar) toolbar.style.display = '';
      if (tableWrap) tableWrap.style.display = '';
    });
    btnRow.appendChild(cancelBtn);

    var confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'dbsext-btn';
    confirmBtn.textContent = '確定して実行';
    confirmBtn.addEventListener('click', function () {
      confirmBox.style.display = 'none';
      // **確定の瞬間に、確認画面を開いたときと同じエリア・同じ画面かを再確認する。**
      // 2026-08-12 3回目独立監査への対応。apply()の定期チェックを待たず、
      // この場でその場で確認することで「apply()がまだ呼ばれていない一瞬」の
      // 隙間を無くす
      if (!isPortsListPath() || getSelectedAreaId() !== confirmAreaId) {
        clearNode(confirmBox);
        if (toolbar) toolbar.style.display = '';
        if (tableWrap) tableWrap.style.display = '';
        setStatus(panel, 'エリアまたは画面が変わったため実行を取り消しました。選び直してください。', 'error');
        return;
      }
      startExecution(panel, targetIds, byId, serviceValue, publishValue);
    });
    btnRow.appendChild(confirmBtn);

    confirmBox.appendChild(btnRow);

    confirmBox.style.display = '';
    if (toolbar) toolbar.style.display = 'none';
    if (tableWrap) tableWrap.style.display = 'none';
  }

  // ---------------------------------------------------------------------------
  // 逐次実行エンジン
  // ---------------------------------------------------------------------------

  function buildUpdatedRecord(record, serviceValue, publishValue) {
    // **レコード全体を保つ。** 変更したいフィールドだけを上書きし、
    // それ以外は fetchPortDetail() で取得した値をそのまま残す
    var updated = {};
    for (var key in record) {
      if (Object.prototype.hasOwnProperty.call(record, key)) updated[key] = record[key];
    }
    // 2026-08-12 実機再テストで判明: `beaconIds`キーを含まないPUTはHTTP 503になる
    // （ビーコンが無い2ポートで再現）。一方 `GET /api/ports/{id}` はビーコンが無い
    // ポートではこのキー自体を返さない（サーバ側が空配列を省略して返す実装と推定）。
    // よって、GET応答に無かった場合は「ビーコン無し」を表す空配列を補って送る。
    // **未検証点**: ビーコンが紐づくポートでもGETがこのキーを省略するのかは未確認
    // （今回実測できた2ポートはいずれもビーコン無し）。もし紐づくポートでも省略されるなら
    // この既定値がビーコン紐付けを消してしまう恐れがある。ビーコン紐付けのあるポートで
    // 一括操作する前に実機確認を推奨する（HANDOFF.md参照）。
    if (!Array.isArray(updated.beaconIds)) updated.beaconIds = [];
    if (serviceValue !== NO_CHANGE) updated.serviceState = serviceValue;
    if (publishValue !== NO_CHANGE) updated.publishFlag = publishValue === 'true';
    return updated;
  }

  function startExecution(panel, targetIds, byId, serviceValue, publishValue) {
    // **実行開始時点の画面・エリアを固定する。** 以後、各行の処理直前・直後に
    // これと食い違っていないかを確認する（2026-08-12 独立監査「画面・エリア
    // 切替後も一括書き込みが継続する」への対応）
    //
    // **重要**: 有効性判定は必ず `myToken`（このクロージャ自身のトークン）を
    // `activeRunToken` と比べる。グローバルな `runState.token` を見てはいけない
    // （2026-08-12 再監査で指摘: 旧実行の非同期コールバックが、その時点の
    // グローバル`runState`がたまたま自己無矛盾に見えることをもって
    // 「自分は現役」と誤判定し、新しい実行の状態を破壊しうる欠陥があった）。
    // 同様に、グローバル`runState`を書き換えるのも「自分がまだ現役の実行」の
    // ときだけに限る（`runState === myRunState` を確認してから）。
    var runAreaId = getSelectedAreaId();
    var myToken = ++activeRunToken;
    var myRunState = { aborted: false, results: [], total: targetIds.length, token: myToken };
    runState = myRunState;

    var resultsBox = panel.querySelector('.dbsext-port-bulk-results');
    if (!resultsBox) return;
    clearNode(resultsBox);
    resultsBox.style.display = '';

    var progressHeading = document.createElement('h3');
    progressHeading.className = 'dbsext-port-bulk-progress-heading';
    resultsBox.appendChild(progressHeading);

    var abortBtn = document.createElement('button');
    abortBtn.type = 'button';
    abortBtn.className = 'dbsext-btn dbsext-btn--plain dbsext-port-bulk-abort-btn';
    abortBtn.textContent = '中断';
    abortBtn.addEventListener('click', function () {
      myRunState.aborted = true;
      abortBtn.disabled = true;
      abortBtn.textContent = '中断を受け付けました（実行中の1件は完了します）';
    });
    resultsBox.appendChild(abortBtn);

    var resultList = document.createElement('ul');
    resultList.className = 'dbsext-port-bulk-result-list';
    resultsBox.appendChild(resultList);

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'dbsext-btn dbsext-port-bulk-close-btn';
    closeBtn.textContent = '閉じる';
    closeBtn.style.display = 'none';
    closeBtn.addEventListener('click', function () {
      resultsBox.style.display = 'none';
      var toolbar = panel.querySelector('.dbsext-port-bulk-toolbar');
      var tableWrap = panel.querySelector('.dbsext-port-bulk-table-wrap');
      if (toolbar) toolbar.style.display = '';
      if (tableWrap) tableWrap.style.display = '';
      // 変更を反映するため一覧を再取得する
      var areaId = getSelectedAreaId();
      if (areaId) {
        delete cacheByArea[areaId];
        loadAndRender(panel, areaId, true);
      }
    });
    resultsBox.appendChild(closeBtn);

    function addResultRow(label, kind, detail) {
      var li = document.createElement('li');
      li.className = 'dbsext-port-bulk-result-item dbsext-port-bulk-result-item--' + kind;
      li.textContent = (kind === 'success' ? '✅ ' : kind === 'failed' ? '❌ ' : '⏭ ') +
        label + (detail ? '（' + detail + '）' : '');
      resultList.appendChild(li);
    }

    function updateProgressHeading(doneCount) {
      progressHeading.textContent = '実行中… ' + doneCount + ' / ' + targetIds.length + '件';
    }

    /**
     * 今もこの実行が「現役」か。
     * **必ず`myToken`と`activeRunToken`を比べる**（グローバル`runState.token`ではない）。
     */
    function isRunStillValid() {
      return activeRunToken === myToken && isPortsListPath() && getSelectedAreaId() === runAreaId;
    }

    function skipRemaining(fromIndex, reason) {
      for (var s = fromIndex; s < targetIds.length; s++) {
        var skippedRow = byId[targetIds[s]];
        var skippedLabel = skippedRow ? (skippedRow.portNameJa || targetIds[s]) : targetIds[s];
        myRunState.results.push({ portId: targetIds[s], kind: 'skipped' });
        addResultRow(skippedLabel, 'skipped', reason);
      }
      finish();
    }

    function finish() {
      abortBtn.style.display = 'none';
      closeBtn.style.display = '';
      progressHeading.textContent = '完了しました（' + targetIds.length + '件中 ' +
        myRunState.results.filter(function (r) { return r.kind === 'success'; }).length + '件成功）';
      // **自分がまだ現役の実行のときだけ**グローバル状態を書き換える。
      // 既に新しい実行に取って代わられている場合、その状態を壊してはいけない
      if (runState === myRunState) {
        runState = null;
        selectedIds = Object.create(null);
      }
    }

    function processIndex(index) {
      if (index >= targetIds.length) {
        finish();
        return;
      }

      updateProgressHeading(index);

      if (!isRunStillValid()) {
        skipRemaining(index, '画面またはエリアが変わったため中断');
        return;
      }

      if (myRunState.aborted) {
        skipRemaining(index, '中断のためスキップ');
        return;
      }

      var portId = targetIds[index];
      var row = byId[portId];
      var label = row ? (row.portNameJa || portId) : portId;

      fetchPortDetail(portId)
        .then(function (record) {
          // 取得完了までの間に画面/エリアが変わっていたら、このポートへは書き込まない
          if (!isRunStillValid()) throw new Error('画面またはエリアが変わったため中断');
          var updated = buildUpdatedRecord(record, serviceValue, publishValue);
          return putPortDetail(portId, updated);
        })
        .then(function () {
          myRunState.results.push({ portId: portId, kind: 'success' });
          addResultRow(label, 'success', null);
        })
        .catch(function (err) {
          var msg = err && err.message ? err.message : String(err);
          myRunState.results.push({ portId: portId, kind: 'failed', detail: msg });
          addResultRow(label, 'failed', msg);
        })
        .then(function () {
          // 行間に意図的な待機を入れる（タイトループにしない。setIntervalは使わない）
          global.setTimeout(function () {
            if (!isRunStillValid()) { skipRemaining(index + 1, '画面またはエリアが変わったため中断'); return; }
            processIndex(index + 1);
          }, PACE_MS);
        });
    }

    processIndex(0);
  }

  // ---------------------------------------------------------------------------
  // 取得と描画のとりまとめ
  // ---------------------------------------------------------------------------

  /**
   * 表示専用の「公開設定」列を埋めるため、一覧に出ている行のうち未取得/古いものだけ
   * `GET /api/ports/{id}`（読み取り専用）で個別に取得する。1件ずつのGETが直前で
   * 完結しないと次の書き込みに進まない実行エンジン（processIndex）とは無関係の、
   * 表示だけの並行フェッチ。失敗しても「不明」と表示するだけで実行系には影響しない。
   */
  function ensurePublishFlags(panel, rows, areaId) {
    var now = Date.now();
    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        if (!row || !isValidPortalId(row.portId)) return;
        var entry = publishFlagCache[row.portId];
        if (entry && (now - entry.timestamp < CACHE_TTL_MS)) return; // 十分新しい
        publishFlagCache[row.portId] = { value: entry ? entry.value : null, timestamp: now };
        fetchPortDetail(row.portId).then(function (record) {
          publishFlagCache[row.portId] = { value: record.publishFlag, timestamp: Date.now() };
        }).catch(function () {
          publishFlagCache[row.portId] = { value: null, timestamp: Date.now() };
        }).then(function () {
          // 画面/エリアが変わっていたら、もう存在しないDOMに触らない
          if (!isPortsListPath() || getSelectedAreaId() !== areaId) return;
          var td = panel.querySelector('td[data-publish-cell-port-id="' + row.portId + '"]');
          if (!td) return;
          var e = publishFlagCache[row.portId];
          td.textContent = (e.value === null || e.value === undefined) ? '不明' : (e.value ? '公開' : '非公開');
        });
      })(rows[i]);
    }
  }

  function loadAndRender(panel, areaId, forceRefresh) {
    var now = Date.now();
    var cached = cacheByArea[areaId];
    if (!forceRefresh && cached && (now - cached.timestamp < CACHE_TTL_MS)) {
      renderTable(panel, cached.rows);
      renderToolbar(panel, cached.rows);
      setStatus(panel, '', null);
      ensurePublishFlags(panel, cached.rows, areaId);
      return;
    }

    // **フェッチを開始するたびに専用の通し番号を振る。**
    // 2026-08-12 再監査「同一世代で複数フェッチが走ると古い応答が上書きしうる」への対応。
    // `apply()`側の世代（currentGeneration）による早期無効化に加え、
    // 「このフェッチより後に始まったフェッチがあるか」を直接見る
    var seq = ++listFetchSeq;
    setStatus(panel, '読み込み中…', null);

    fetchPortsList(areaId).then(function (rows) {
      // 2026-08-12 再監査「エリア変更後、apply()が世代を進める前に旧応答が返る競合」への対応。
      // 世代番号だけに頼らず、**完了した時点の実際の画面状態**を直接確認する
      if (seq !== listFetchSeq) return; // 後発のフェッチに追い越された
      if (!isPortsListPath() || getSelectedAreaId() !== areaId) return; // 画面/エリアが変わった
      cacheByArea[areaId] = { rows: rows, timestamp: Date.now() };
      renderTable(panel, rows);
      renderToolbar(panel, rows);
      setStatus(panel, '', null);
      ensurePublishFlags(panel, rows, areaId);
    }).catch(function (err) {
      if (seq !== listFetchSeq) return;
      if (!isPortsListPath() || getSelectedAreaId() !== areaId) return;
      var msg = err && err.message ? err.message : String(err);
      setStatus(panel, 'ポート一覧の取得に失敗しました: ' + msg, 'error');
    });
  }

  /** 開いている確認画面を強制的に閉じ、選択画面（ツールバー・表）へ戻す。
   * エリア切替・エリア未選択に戻ったときに呼ぶ（2026-08-12再監査「エリア切替後も
   * 古い確認画面が実行できる」への対応。確認画面のtargetIdsは旧エリアのポートを
   * 指したままになるため、切替後は無条件に破棄する） */
  function forceCloseConfirm(panel) {
    var confirmBox = panel.querySelector('.dbsext-port-bulk-confirm');
    if (!confirmBox || confirmBox.style.display === 'none') return;
    clearNode(confirmBox);
    confirmBox.style.display = 'none';
    var toolbar = panel.querySelector('.dbsext-port-bulk-toolbar');
    var tableWrap = panel.querySelector('.dbsext-port-bulk-table-wrap');
    if (toolbar) toolbar.style.display = '';
    if (tableWrap) tableWrap.style.display = '';
  }

  // ---------------------------------------------------------------------------
  D.portBulkActions = {
    apply: function () {
      if (typeof document === 'undefined' || !document.body) return;

      if (!isPortsListPath()) {
        var stale = document.querySelector('[' + PANEL_ATTR + ']');
        if (stale && stale.parentNode) {
          currentGeneration++;
          activeRunToken++; // 進行中の実行があれば次の行から自動的に中断扱いになる
          setNativeTableHidden(false); // 隠していたポータル純正表を必ず元に戻す
          stale.parentNode.removeChild(stale); // dbsext:own-ui
        }
        return;
      }

      var panel = ensurePanel();
      if (!panel) return;

      // **一括操作表を出している間は、同じ内容のポータル純正表を隠す（依頼1対応）。**
      // 削除・移動はしない。「オリジナル表示」トグルから peekShowAll/peekRestore 経由で
      // 一時的に戻せる（下記 D.portBulkActions 参照）
      setNativeTableHidden(true);

      var areaId = getSelectedAreaId();
      if (!areaId) {
        // エリア未選択に戻った場合も、古い選択・実行・確認画面を持ち越さない
        currentGeneration++;
        activeRunToken++;
        selectedIds = Object.create(null);
        forceCloseConfirm(panel);
        setStatus(panel, 'エリアを選択するとポート一覧が表示されます', null);
        return;
      }

      if (panel.__dbsextLastAreaId !== areaId) {
        panel.__dbsextLastAreaId = areaId;
        selectedIds = Object.create(null);
        currentGeneration++; // 前エリア向けの進行中フェッチを無効化する（早期無効化。完了時も別途直接確認する）
        activeRunToken++; // 前エリア向けの進行中実行を無効化する
        // **旧エリアのポートIDを指したままの確認画面は無条件に破棄する**
        // （2026-08-12再監査「エリア切替後も古い確認画面が実行できる」への対応）
        forceCloseConfirm(panel);
      }

      // 実行中・確認中は表を再取得して差し替えない
      var confirmBox = panel.querySelector('.dbsext-port-bulk-confirm');
      var resultsBox = panel.querySelector('.dbsext-port-bulk-results');
      if ((confirmBox && confirmBox.style.display !== 'none') ||
          (resultsBox && resultsBox.style.display !== 'none')) {
        return;
      }

      loadAndRender(panel, areaId, false);
    },

    /**
     * 「オリジナルに戻す」表示専用（`original-view.js`から呼ばれる）。
     * この機能が隠しているポータル純正表を一時的に見せる／戻す。
     */
    peekShowAll: function () {
      if (typeof document === 'undefined') return;
      setNativeTableHidden(false);
    },
    peekRestore: function () {
      if (typeof document === 'undefined') return;
      if (isPortsListPath() && document.querySelector('[' + PANEL_ATTR + ']')) {
        setNativeTableHidden(true);
      }
    },

    // テスト用
    _resetForTests: function () {
      cacheByArea = Object.create(null);
      selectedIds = Object.create(null);
      currentGeneration = 0;
      activeRunToken = 0;
      runState = null;
      setNativeTableHidden(false);
      var stale = (typeof document !== 'undefined') && document.querySelector('[' + PANEL_ATTR + ']');
      if (stale && stale.parentNode) stale.parentNode.removeChild(stale); // dbsext:own-ui
    },
    _getSelectedIds: function () { return selectedIds; },
    _buildUpdatedRecord: buildUpdatedRecord,
    _isValidPortalId: isValidPortalId,
    _isValidPortDetailRecord: isValidPortDetailRecord,
    NO_CHANGE: NO_CHANGE,
    SERVICE_STATE_OPTIONS: SERVICE_STATE_OPTIONS,
    PUBLISH_FLAG_OPTIONS: PUBLISH_FLAG_OPTIONS,
    PUBLISH_FLAG_VERIFIED: PUBLISH_FLAG_VERIFIED
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);


/**
 * DBSEXT テーブル列制御モジュール
 *
 * 目的: 車両情報（/vehicles）の横長テーブル問題に対処するため、
 * 普段使われない操作系5列（メンテナンス、AT管理、解錠、再配置、AT一体型車両操作）を
 * トグルで隠せるようにする。
 *
 * **既定は「表示」、チェックで「たたむ」（2026-08-10 変更）。**
 * 当初は既定で隠す方式だったが、操作列がいきなり無いのは分かりにくいという
 * 判断から反転した。状態は画面ごとに記憶する（stateStore / localStorage）ので、
 * 一度「たたむ」を選べば次回以降もその状態で開く。
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
    return true; // 既定は「表示」（showActionCols = true）。たたむ操作は利用者の明示選択
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

  /**
   * チェックボックスは「たたむ」の意味で出す（既定は表示のため）。
   * `checked` と保存する `show` は**逆**になる。ここを混同すると、
   * チェックを入れたのに列が消えない／消したのに戻らない、という
   * 見た目と逆の動きになる。
   */
  function ensureToggleUI(table, screen, show, onToggle) {
    if (!table || !table.parentNode) return;

    var existing = table.parentNode.querySelector('[' + UI_CONTAINER_ATTR + ']');
    if (existing) {
      var input = existing.querySelector('[' + TOGGLE_INPUT_ATTR + ']');
      if (input) {
        input.checked = !show;
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
    checkbox.checked = !show; // チェック = たたむ（非表示）
    checkbox.style.cssText = 'margin-right:6px; cursor:pointer; accent-color:#0b5cab; width:15px; height:15px;';

    checkbox.addEventListener('change', function () {
      var newShow = !checkbox.checked; // チェックONで「たたむ」= show:false
      saveToggleState(screen, newShow);
      if (typeof onToggle === 'function') {
        onToggle(newShow);
      }
    });

    var span = document.createElement('span');
    span.textContent = '操作列をたたむ';

    label.appendChild(checkbox);
    label.appendChild(span);
    bar.appendChild(label);

    table.parentNode.insertBefore(bar, table);
  }

  // 「オリジナルに戻す」表示中に、apply() が対象にした表と列を覚えておく。
  // 保存済み設定（localStorage）には一切触れない一時的な表示切替のためだけに使う。
  var lastProcessed = [];

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
      lastProcessed = [];

      for (var t = 0; t < tables.length; t++) {
        var table = tables[t];
        var headerTable = table.querySelector('table.el-table__header');
        if (!headerTable) continue;

        var indices = findActionColumnIndices(headerTable);
        // 対象列が1つも無ければ何もしない
        if (indices.length === 0) continue;

        lastProcessed.push({ table: table, indices: indices, savedShow: show });

        (function (tbl, idxs) {
          ensureToggleUI(tbl, screen, show, function (newShow) {
            setColumnVisibility(tbl, idxs, newShow);
          });
          setColumnVisibility(tbl, idxs, show);
        })(table, indices);
      }
    },

    /**
     * 「オリジナルに戻す」表示専用。保存済みの表示設定は変えず、
     * 一時的に全列を表示する（"たたむ" を選んでいても、覗いている間だけ戻す）。
     */
    peekShowAll: function () {
      for (var i = 0; i < lastProcessed.length; i++) {
        setColumnVisibility(lastProcessed[i].table, lastProcessed[i].indices, true);
      }
    },

    /** 「オリジナルに戻す」を解除し、保存済みの表示設定へ戻す */
    peekRestore: function () {
      for (var i = 0; i < lastProcessed.length; i++) {
        setColumnVisibility(lastProcessed[i].table, lastProcessed[i].indices, lastProcessed[i].savedShow);
      }
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);


/**
 * DBSEXT テーブルツール（並べ替え・絞り込み）モジュール
 *
 * **ポータル表むけのアダプタである。** 判定ロジック（並び順・絞り込み・見出しUI）は
 * `table-kit` が持ち、ここは「ポータルのDOMをどう動かすか」だけを担う。
 *
 *   並べ替え … 既存の <tr> を appendChild で並べ直す
 *   絞り込み … display:none で隠す
 *
 * **行を作り直してはいけない。** 行の中にはポータル（Vue）のイベントハンドラを持つ
 * 操作ボタン（解錠・再配置・メンテナンス）が入っており、作り直すと壊れる。
 * 契約§6「ポータルの既存DOMを削除・移動しない」。
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  var tableStates = {};
  // 「オリジナルに戻す」表示中に、apply() が対象にした表を覚えておく
  var lastProcessed = [];

  function kit() {
    return D.tableKit;
  }

  function hasActiveFilter(state) {
    return kit().hasAnyCondition(state.conditions);
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

    // 1. 絞り込み処理（判定は table-kit。文字列 / 数値の範囲を同じ入口で扱う）
    var filtering = hasActiveFilter(state);

    for (var i = 0; i < trArray.length; i++) {
      var tr = trArray[i];
      var show = true;
      if (filtering) {
        var cells = tr.children;
        for (var colIdxStr in state.conditions) {
          var cond = state.conditions[colIdxStr];
          if (!cond) continue;
          var colIdx = Number(colIdxStr);
          var cell = cells[colIdx];
          var cellText = cell ? cell.textContent.trim() : '';
          if (!kit().matchesFilter(cellText, cond)) {
            show = false;
            break;
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

      // 列全体が数値なら数値として並べる。判定も比較も table-kit に任せる
      var columnValues = [];
      for (var j = 0; j < trArray.length; j++) {
        var tdNode = trArray[j].children[sortCol];
        columnValues.push(tdNode ? tdNode.textContent.trim() : '');
      }
      var sortOpts = {
        columnLabel: colTitle,
        numeric: !kit().isPortColumn(colTitle) && kit().isNumericColumn(columnValues)
      };

      trArray.sort(function (trA, trB) {
        var tdA = trA.children[sortCol];
        var tdB = trB.children[sortCol];
        var res = kit().compare(
          tdA ? tdA.textContent.trim() : '',
          tdB ? tdB.textContent.trim() : '',
          sortOpts
        );
        return sortOrder === 'desc' ? -res : res;
      });

      for (var k = 0; k < trArray.length; k++) {
        tbody.appendChild(trArray[k]);
      }
    }
  }

  function updateHeaderUI(ths, state) {
    for (var c = 0; c < ths.length; c++) {
      var controls = ths[c].__dbsextControls;
      if (!controls) continue;
      controls.updateSortIndicator(state.sortColIndex === c, state.sortOrder);
      controls.syncFromState(state.conditions[c]);
    }
  }

  D.tableTools = {
    // 互換のため残す。実装は table-kit にある（自前表からも同じ順序を使うため）
    portSortKey: function (name) { return kit().portSortKey(name); },

    // 検証用。DOMを伴うフィルタ／選択連動を実ブラウザ無しでも再現する。
    _applyFilterAndSort: applyFilterAndSort,
    _hookVisibleSelectAll: hookVisibleSelectAll,

    apply: function () {
      if (typeof document === 'undefined') return;

      var tables = document.querySelectorAll('.el-table');
      if (!tables || tables.length === 0) return;

      var pathname = (typeof location !== 'undefined') ? location.pathname : '';
      lastProcessed = [];

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
          tableStates[stateKey] = kit().createState();

          // 初回既定の並べ替え: ポート名またはポートの列があれば昇順1回
          for (var i = 0; i < ths.length; i++) {
            var title = ths[i].getAttribute('data-dbsext-orig-title') || ths[i].textContent.trim();
            if (kit().isPortColumn(title)) {
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

              // 見出しの操作UIは table-kit が作る。**自前表とまったく同じもの**を使う。
              // 見た目もCSS（skin.js）側で共通化してあるので、
              // ここでインラインstyleを書き足さないこと。
              //
              // 列によっては、文字列の部分一致より「以上・以下」の方が役に立つ
              // （電圧・バッテリー残量など）。どの列を数値扱いにするかは
              // table-kit の NUMERIC_COLUMN_HINTS に集約してある。
              var controls = kit().buildHeaderControls({
                columnLabel: origTitle,
                sortMode: 'indicator',
                onSort: function () {
                  if (state.sortColIndex === colIndex) {
                    state.sortOrder = (state.sortOrder === 'asc') ? 'desc' : 'asc';
                  } else {
                    state.sortColIndex = colIndex;
                    state.sortOrder = 'asc';
                  }
                  updateHeaderUI(ths, state);
                  applyFilterAndSort(table, state, ths);
                },
                onFilter: function (condition) {
                  state.conditions[colIndex] = condition;
                  applyFilterAndSort(table, state, ths);
                }
              });

              // 既定の条件を状態側にも置いておく（種類だけ先に決まる）
              if (!state.conditions[colIndex]) {
                state.conditions[colIndex] = controls.condition;
              } else {
                controls.syncFromState(state.conditions[colIndex]);
              }

              th.__dbsextControls = controls;
              th.appendChild(controls.sortEl);
              th.appendChild(controls.filterWrap);
            })(c);
          }
        }

        updateHeaderUI(ths, state);
        applyFilterAndSort(table, state, ths);
        lastProcessed.push({ table: table, state: state, ths: ths });
      }
    },

    /**
     * 「オリジナルに戻す」表示専用。並べ替え・絞り込みの**設定は変えず**、
     * 絞り込みで隠れている行だけを一時的にすべて見せる。
     */
    peekShowAll: function () {
      for (var i = 0; i < lastProcessed.length; i++) {
        var rows = lastProcessed[i].table.querySelectorAll('table.el-table__body tbody tr');
        for (var r = 0; r < rows.length; r++) rows[r].style.display = '';
      }
    },

    /** 「オリジナルに戻す」を解除し、保存済みの並べ替え・絞り込みへ戻す */
    peekRestore: function () {
      for (var i = 0; i < lastProcessed.length; i++) {
        applyFilterAndSort(lastProcessed[i].table, lastProcessed[i].state, lastProcessed[i].ths);
      }
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);


/**
 * DBSEXT 「オリジナルに戻す」トグル
 *
 * なんらかの事情で拡張を適用していない素のポータル画面を見たい利用者のために、
 * 拡張の見た目・追加UIを**一時的に**丸ごと隠すボタンを用意する。
 *
 * ---------------------------------------------------------------------------
 * 設計方針
 * ---------------------------------------------------------------------------
 * ポータルのDOMは一切削除・移動しない（契約§6）。やることは2つだけ:
 *
 *   1. 拡張が挿入した <style> を無効化する（sticky・配色・サイドバー幅などが消える）
 *   2. 拡張が作った要素（own-root / own-leaf、`core.js` の ATTR_KIND から機械的に
 *      導く）を一括で非表示にする
 *
 * さらに、拡張が**隠していたポータル本来の表示**（車両詳細の標準表、たたんだ操作列、
 * 絞り込みで隠れた行）は、隠す側のモジュール自身に「覗く／戻す」を持たせてある
 * （`vehicleProblems.peekShowAll/peekRestore` 等）。ここから呼ぶだけで、
 * **保存済みの利用者設定（列のたたみ状態など）には一切触れない**。
 *
 * 状態は保存しない。**ページを開き直せば必ず拡張適用に戻る。**
 * 「オフにしたことを忘れて、拡張が壊れたと思われる」事故を避けるため。
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  var HOST_ATTR = 'data-dbsext-original-view';
  var BTN_ATTR = 'data-dbsext-original-view-btn';
  var STYLE_IDS = ['dbsext-skin', 'dbsext-table-wrap-style', 'dbsext-table-columns-width'];

  var active = false;

  function setStylesEnabled(enabled) {
    if (typeof document === 'undefined') return;
    for (var i = 0; i < STYLE_IDS.length; i++) {
      var el = document.getElementById(STYLE_IDS[i]);
      if (el) el.disabled = !enabled;
    }
  }

  /** 自前UI（root+leaf）を一括で隠す／戻す。トグルボタン自身は対象から外す */
  function setOwnUiHidden(hidden) {
    if (typeof document === 'undefined' || !D.core || !D.core.OWN_UI_SELECTOR_ALL) return;
    var nodes = document.querySelectorAll(D.core.OWN_UI_SELECTOR_ALL);
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      // トグルボタン自身（とその中身）は常に見えている必要がある
      if (typeof node.closest === 'function' && node.closest('[' + HOST_ATTR + ']')) continue;
      node.style.display = hidden ? 'none' : '';
    }
  }

  /** 拡張が隠している「本来ポータルに見えるはずのもの」を覗く／戻す */
  function peekEachModule(show) {
    var method = show ? 'peekShowAll' : 'peekRestore';
    var targets = [D.vehicleProblems, D.tableColumns, D.tableTools, D.portBulkActions];
    for (var i = 0; i < targets.length; i++) {
      var mod = targets[i];
      if (mod && typeof mod[method] === 'function') {
        try { mod[method](); } catch (e) {
          D.core.log('original-view: ' + method + ' 失敗: ' + (e && e.message ? e.message : e), true);
        }
      }
    }
  }

  function updateButtonLabel(btn) {
    btn.textContent = active ? '拡張表示に戻す' : 'オリジナル表示';
    btn.title = active
      ? 'クリックすると拡張の見た目・追加機能に戻ります'
      : 'クリックすると拡張の変更前（素のポータル）を一時的に見られます';
  }

  function toggle(btn) {
    active = !active;
    setStylesEnabled(!active);
    setOwnUiHidden(active);
    peekEachModule(active);

    if (!active) {
      // オフに戻した直後は、次のDOM変化を待たずに拡張側の表示を即座に復元する
      // （並べ替え・絞り込みの再適用、固定ボタン類の再配置など）
      if (D.core && typeof D.core.reapplyAll === 'function') {
        D.core.reapplyAll();
      }
    }

    updateButtonLabel(btn);
  }

  function ensureButton() {
    if (typeof document === 'undefined' || !document.body) return;
    if (document.querySelector('[' + HOST_ATTR + ']')) return;

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute(HOST_ATTR, '1');
    btn.setAttribute(BTN_ATTR, '1');
    btn.style.cssText = [
      'position: fixed',
      'right: 12px',
      'bottom: 12px',
      'z-index: 2147483000',
      'background: rgba(0, 0, 0, 0.75)',
      'color: #ffffff',
      'border: none',
      'border-radius: 20px',
      'padding: 8px 16px',
      'font-size: 12px',
      'font-weight: bold',
      'cursor: pointer',
      'box-shadow: 0 2px 8px rgba(0,0,0,0.25)'
    ].join(';');

    updateButtonLabel(btn);
    btn.addEventListener('click', function () { toggle(btn); });
    document.body.appendChild(btn);
  }

  D.originalView = {
    apply: function () {
      ensureButton();
    },

    // テスト・診断用
    _isActive: function () { return active; },
    _reset: function () { active = false; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);
