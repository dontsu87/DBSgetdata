/**
 * DBSEXT 名前空間および設定定義
 * モジュール契約 §1, §2 に基づく基盤定義
 */
(function (global) {
  'use strict';

  global.DBSEXT = global.DBSEXT || {};
  var D = global.DBSEXT;

  D.VERSION = '202608271635';

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

  var RECONNECT_DELAYS = [50, 150, 400, 1000];
  var reconnectTimer = null;
  var reconnectIndex = 0;
  var isConnecting = false;
  var pageshowRegistered = false;
  var mainWorldDomListening = false;
  // MAIN world の DOM bridge は MutationObserver の通知を100ms後に発火するため、
  // USER_SCRIPT側で行並べ替えを行った直後の「次の1通知」だけを消費する。
  var mainWorldSuppressionUntil = 0;
  var mainWorldSuppressionPending = false;

  function getObserverTarget() {
    if (typeof document === 'undefined') return null;
    var target = document.documentElement || document.body;
    if (!target || target.nodeType !== 1) return null;
    if (target.ownerDocument && target.ownerDocument !== document) return null;
    return target;
  }

  function beginCoreReadiness() {
    if (D && D.netStatus && typeof D.netStatus.beginReadiness === 'function') {
      try { D.netStatus.beginReadiness('core-reapply'); } catch (e) {}
    }
  }

  function endCoreReadiness() {
    if (D && D.netStatus && typeof D.netStatus.endReadiness === 'function') {
      try { D.netStatus.endReadiness('core-reapply'); } catch (e) {}
    }
  }

  function invokeCallbacks() {
    try {
      for (var k = 0; k < contentCallbacks.length; k++) {
        try {
          contentCallbacks[k]();
        } catch (e) {
          D.core.log('onContentChange コールバックエラー: ' + (e && e.message ? e.message : e), true);
        }
      }
    } finally {
      endCoreReadiness();
    }
  }

  function scheduleCallbacksFromMainWorld() {
    if (applying > 0) return;
    if (mainWorldSuppressionPending) {
      if (Date.now() <= mainWorldSuppressionUntil) {
        mainWorldSuppressionPending = false;
        mainWorldSuppressionUntil = 0;
        return;
      }
      mainWorldSuppressionPending = false;
      mainWorldSuppressionUntil = 0;
    }
    beginCoreReadiness();
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () {
      debounceTimer = null;
      invokeCallbacks();
    }, 200);
  }

  function useMainWorldDomBridge() {
    return !!(D && D.platform && D.platform.isUserScript);
  }

  function connectMainWorldDomBridge() {
    if (mainWorldDomListening) return true;
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return false;
    document.addEventListener('dbsext:main-dom-change', scheduleCallbacksFromMainWorld);
    mainWorldDomListening = true;
    return true;
  }

  function stopObserverState() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
      endCoreReadiness();
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (observer) {
      try { observer.disconnect(); } catch (e) {}
      observer = null;
    }
    mainWorldSuppressionPending = false;
    mainWorldSuppressionUntil = 0;
  }

  function tryConnect(isRecoveryAttempt) {
    // USER_SCRIPT world から直接 observe() すると、実DOMでも別レルムNode扱いで
    // TypeErrorになる環境がある。MAIN worldの監視イベントを正本にする。
    if (useMainWorldDomBridge()) {
      var bridgeConnected = connectMainWorldDomBridge();
      if (bridgeConnected && isRecoveryAttempt) {
        beginCoreReadiness();
        invokeCallbacks();
      }
      return bridgeConnected;
    }
    if (observer) return true;
    if (isConnecting) return false;
    if (reconnectTimer && !isRecoveryAttempt) return false;
    isConnecting = true;

    var target = getObserverTarget();
    var candidate = null;
    var success = false;

    if (target && typeof MutationObserver !== 'undefined') {
      try {
        candidate = new MutationObserver(function (mutations) {
          if (applying > 0) return;
          var hasExternalChange = false;
          for (var i = 0; i < mutations.length; i++) {
            if (!isOwnMutation(mutations[i])) {
              hasExternalChange = true;
              break;
            }
          }
          if (!hasExternalChange) return;

          beginCoreReadiness();

          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(function () {
            debounceTimer = null;
            invokeCallbacks();
          }, 200);
        });

        candidate.observe(target, { childList: true, subtree: true });
        observer = candidate;
        success = true;
      } catch (e) {
        if (candidate && typeof candidate.disconnect === 'function') {
          try { candidate.disconnect(); } catch (ex) {}
        }
        candidate = null;
        // **実機で確認された例外への防御。**
        // 「一覧から別タブで開く」で新しいタブを開いたとき、`observe()` が例外を投げることがある
        // （Chromeのプリレンダー/BFCache採用時、別レルムで作られた古いNode参照を渡してしまうと起きる既知の症状と推測）。
        // ここを素通しにすると、その1行の例外だけで拡張カードに「エラー」が付き、以後の再適用が全部止まる。
        // 失敗時は observer を確定させず、後から onContentChange が再び呼ばれれば取り直せるようにしておく。
        D.core.log('onContentChange の監視開始に失敗: ' + (e && e.message ? e.message : e), true);
      }
    } else {
      D.core.log('onContentChange の監視開始に失敗: ターゲット無効または MutationObserver 未サポート', true);
    }

    isConnecting = false;

    if (success) {
      reconnectIndex = 0;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (isRecoveryAttempt) {
        beginCoreReadiness();
        invokeCallbacks();
      }
      return true;
    }

    if (reconnectIndex < RECONNECT_DELAYS.length) {
      var delay = RECONNECT_DELAYS[reconnectIndex];
      reconnectIndex++;
      reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        tryConnect(true);
      }, delay);
    }
    return false;
  }

  function setupPageshowListener() {
    if (pageshowRegistered || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    pageshowRegistered = true;
    window.addEventListener('pageshow', function () {
      stopObserverState();
      reconnectIndex = 0;
      if (useMainWorldDomBridge()) {
        beginCoreReadiness();
        invokeCallbacks();
      } else {
        tryConnect(true);
      }
    });
  }

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
    'data-dbsext-navigation-loading': 'own-root',
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
    'data-dbsext-corporate-invoices-btn': 'own-root',
    'data-dbsext-corporate-invoices-modal': 'own-root',
    // ポート一括操作（契約§6の限定例外。AGENTS.md参照）
    'data-dbsext-port-bulk-panel': 'own-root',

    // --- 自前UIだが入れ物ではないもの ---
    'data-dbsext-skin': 'own-leaf',            // <style> 要素そのもの
    'data-dbsext-action-toggle': 'own-leaf',
    'data-dbsext-autofit-toggle': 'own-leaf',
    'data-dbsext-sort': 'own-leaf',
    'data-dbsext-filter': 'own-leaf',
    'data-dbsext-filter-min': 'own-leaf',      // 数値絞り込みの「以上」
    'data-dbsext-filter-max': 'own-leaf',      // 数値絞り込みの「以下」
    'data-dbsext-filter-select': 'own-leaf',   // 列挙値の絞り込み（プルダウン選択式）
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
    // sort 時に既存のポータル行へ一時付与する印。MAIN world の DOM bridge が
    // 拡張自身の appendChild をポータル変更として誤検知しないようにする。
    'data-dbsext-table-sort-row': 'mark',
    'data-dbsext-wrap': 'mark',        // table-wrap が .el-table に付ける
    'data-dbsext-orig-title': 'mark',  // table-tools が th に控える元の列名
    'data-dbsext-orig-width': 'mark',        // table-columns が col に控える元の幅
    'data-dbsext-orig-table-width': 'mark',  // table-columns が表に控える元の幅
    'data-dbsext-autofit-title': 'mark',     // table-columns が上限列に付けたtitleの印
    'data-dbsext-autofit-orig-title': 'mark', // table-columns が上限列に控える元のtitle
    'data-dbsext-autofit-ellipsis': 'mark',  // table-columns が上限列に付けた省略記号の印
    'data-dbsext-autofit-orig-style': 'mark', // table-columns が上限列に控える元のスタイル
    'data-dbsext-autofit-skipped': 'mark',    // table-columns が多段ヘッダ等でオートフィットを見送った印
    'data-dbsext-newtab': 'mark',      // ui-tweaks が一覧の a に付ける処理済み印
    'data-dbsext-collapsed': 'mark',   // ui-tweaks が折りたたみ見出しに付ける処理済み印
    'data-dbsext-cond-panel': 'mark',  // ui-tweaks が表示条件パネルに付ける（W1-2）
    'data-dbsext-autocollapsed': 'mark', // ui-tweaks が自動畳みのマーク（W1-2）
    'data-dbsext-hidden-back': 'mark',  // ui-tweaks が戻るボタンに付ける（W1-3）
    'data-dbsext-user-summary-th': 'mark', // ui-tweaks が純正表の会員区分・ユーザーIDヘッダに付ける印
    'data-dbsext-user-summary-td': 'mark', // ui-tweaks が純正表の会員区分・ユーザーIDセルに付ける印
    'data-dbsext-user-summary-col': 'mark', // ui-tweaks がcolgroupへ追加する会員区分・ユーザーID列の印
    // 全家族共通の表マーカー（値は portal / custom）。見た目のCSSはすべてこれを見る。
    // **`own` にしてはいけない。** ポータルが描画した表にも付けるため、own に分類すると
    // ポータル表を対象にした変化が全部「自分の仕業」になり、
    // **SPAが表を差し替えても再適用されなくなる**（core の冒頭に書いた事故そのもの）。
    'data-dbsext-table': 'mark',
    // 先頭列にチェックボックスを持つポータル表のマーカー（第2列のsticky指定に使用）
    'data-dbsext-has-selection': 'mark',
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
  function runSuppressed(name, fn, suppressMainWorldEvent) {
    var bridgeSuppressionArmed = suppressMainWorldEvent && useMainWorldDomBridge();
    if (bridgeSuppressionArmed) {
      mainWorldSuppressionPending = true;
      mainWorldSuppressionUntil = Date.now() + 500;
    }
    var completed = false;
    applying++;
    try {
      fn();
      completed = true;
    } catch (e) {
      D.core.log(name + ' エラー: ' + (e && e.message ? e.message : e), true);
    } finally {
      // appendChild が例外で完了しなかった場合は、次の外部bridge通知を
      // sort由来と誤認しないよう抑止フラグを直ちに解除する。
      if (bridgeSuppressionArmed && !completed) {
        mainWorldSuppressionPending = false;
        mainWorldSuppressionUntil = 0;
      }
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
    // SPA遷移・エリア変更時に照会世代と1画面上限を先に更新する。
    { name: 'userSummary', reapply: true, get: function () { return D.userSummary; } },
    { name: 'uiTweaks', reapply: true, get: function () { return D.uiTweaks; } },
    // 車両情報1000件表示（拡張版限定・実ページ遷移方式）。
    // エリア確定を待つ必要があるため reapply:true
    { name: 'vehiclePageSize', reapply: true, get: function () { return D.vehiclePageSize; } },
    { name: 'notificationDefaults', reapply: true, get: function () { return D.notificationDefaults; } },
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
    { name: 'originalView', reapply: true, get: function () { return D.originalView; } },
    { name: 'corporateInvoices', reapply: true, get: function () { return D.corporateInvoices; } }
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
      setupPageshowListener();

      var restartingExhaustedCycle = !observer && !reconnectTimer && !isConnecting &&
        reconnectIndex >= RECONNECT_DELAYS.length;

      if (typeof callback === 'function') {
        contentCallbacks.push(callback);
      }

      if (restartingExhaustedCycle) {
        reconnectIndex = 0;
      }

      // 枯渇後の明示的な再開も recovery である。即時接続に成功した場合も、
      // retry 経由の成功と同様に登録済み callback を正確に1バッチ実行する。
      tryConnect(restartingExhaustedCycle);
    },

    runSuppressed: runSuppressed,

    _getObserver: function () {
      return observer;
    },
    _getReconnectIndex: function () {
      return reconnectIndex;
    },
    _resetStateForTest: function () {
      stopObserverState();
      contentCallbacks = [];
      reconnectIndex = 0;
      isConnecting = false;
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
  var HYDRATION_RETRY_MAX = 3;
  var HYDRATION_RETRY_DELAY_MS = 500;

  // 画面ごとに1回だけ試す。SPA遷移でこの画面へ入り直したときは再び試す
  var lastPath = null;
  var triedOnThisScreen = false;
  var running = false;
  var currentGeneration = 0;
  var pendingTimeouts = [];
  var autoSelectedName = null;
  var autoSelectionGuard = null;
  var hydrationRetryCount = 0;

  function clearAutoSelectionGuard() {
    var guard = autoSelectionGuard;
    autoSelectionGuard = null;
    if (!guard || !guard.select || typeof guard.select.removeEventListener !== 'function') return;
    for (var i = 0; i < guard.events.length; i++) {
      try { guard.select.removeEventListener(guard.events[i], guard.invalidate, true); } catch (e) {}
    }
  }

  function armAutoSelectionGuard(select, gen) {
    clearAutoSelectionGuard();
    var guard = { select: select, generation: gen, valid: true, events: ['click', 'input', 'change'] };
    guard.invalidate = function () { guard.valid = false; };
    if (select && typeof select.addEventListener === 'function') {
      for (var i = 0; i < guard.events.length; i++) {
        try { select.addEventListener(guard.events[i], guard.invalidate, true); } catch (e) {}
      }
    }
    autoSelectionGuard = guard;
  }

  function ownsAutoSelection(select, gen, name) {
    return !!(autoSelectionGuard && autoSelectionGuard.valid &&
      autoSelectionGuard.select === select && autoSelectionGuard.generation === gen &&
      autoSelectedName === name);
  }

  function log(message, isError) {
    if (D && D.core && typeof D.core.log === 'function') {
      D.core.log(message, isError);
    }
  }

  function currentPath() {
    if (typeof location === 'undefined' || !location.pathname) return '';
    return location.pathname.replace(/\/+$/, '') || '/';
  }

  function clearPendingTimeouts() {
    for (var i = 0; i < pendingTimeouts.length; i++) {
      try { clearTimeout(pendingTimeouts[i]); } catch (e) {}
    }
    pendingTimeouts = [];
  }

  function addTimeout(fn, delay) {
    var timerId;
    timerId = setTimeout(function () {
      var idx = pendingTimeouts.indexOf(timerId);
      if (idx >= 0) pendingTimeouts.splice(idx, 1);
      fn();
    }, delay);
    pendingTimeouts.push(timerId);
    return timerId;
  }

  function isNodeConnected(node) {
    if (!node) return false;
    if (typeof node.isConnected === 'boolean') return node.isConnected;
    if (typeof document !== 'undefined') {
      if (document.documentElement && typeof document.documentElement.contains === 'function') {
        return document.documentElement.contains(node);
      }
      if (document.body && typeof document.body.contains === 'function') {
        return document.body.contains(node);
      }
    }
    return true;
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

  function selectedValueText(select) {
    var picked = select.querySelector('.el-select__selected-item, .el-select__tags-text');
    if (picked && (picked.textContent || '').trim()) return (picked.textContent || '').trim();
    var input = select.querySelector('input');
    return input && typeof input.value === 'string' ? input.value.trim() : '';
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

  function finishSuccess(gen) {
    if (gen === currentGeneration) {
      running = false;
      triedOnThisScreen = true;
      clearAutoSelectionGuard();
    }
  }

  function finishFailure(gen, preserveAutoSelection) {
    if (gen === currentGeneration) {
      running = false;
      triedOnThisScreen = false;
      clearPendingTimeouts();
      if (!preserveAutoSelection) {
        autoSelectedName = null;
        clearAutoSelectionGuard();
      }
    }
  }

  function safeClick(node, desc) {
    try {
      if (node && typeof node.click === 'function') {
        node.click();
        return true;
      }
    } catch (e) {
      log('車種情報: ' + desc + 'のクリックに失敗しました: ' + (e && e.message ? e.message : e), true);
      return false;
    }
    log('車種情報: ' + desc + 'のクリック要素が無効です', true);
    return false;
  }

  /** 選択肢リストが開いたあとの処理 */
  function onDropdownReady(gen, select, trigger, dropdown) {
    if (gen !== currentGeneration || currentPath() !== TARGET_PATH) {
      finishFailure(gen);
      return;
    }
    if (!isNodeConnected(select) || !isNodeConnected(trigger) || !isNodeConnected(dropdown)) {
      finishFailure(gen);
      return;
    }

    var options = getSelectableOptions(dropdown);

    if (options.length !== 1) {
      // **開けたままにしない。** 利用者から見て「勝手に何か開いた」状態を残さない
      if (!safeClick(trigger, '選択肢閉じトリガー')) {
        finishFailure(gen);
        return;
      }
      log('車種情報: エリアの選択肢が' + options.length + '件のため自動選択しません');
      finishSuccess(gen);
      return;
    }

    var name = (options[0].textContent || '').trim();
    if (!safeClick(options[0], '選択肢')) {
      finishFailure(gen);
      return;
    }
    autoSelectedName = name;
    armAutoSelectionGuard(select, gen);

    addTimeout(function () {
      if (gen !== currentGeneration || currentPath() !== TARGET_PATH) {
        finishFailure(gen);
        return;
      }
      if (!isNodeConnected(select) || !isNodeConnected(trigger) || !isNodeConnected(dropdown)) {
        finishFailure(gen);
        return;
      }
      if (!ownsAutoSelection(select, gen, name)) {
        finishFailure(gen);
        return;
      }
      var btn = getSearchButton();
      if (!btn || !isNodeConnected(btn)) {
        log('車種情報: 検索ボタンが見つからないため、選択のみで止めました', true);
        finishFailure(gen, true);
        return;
      }
      if (safeClick(btn, '検索ボタン')) {
        log('車種情報: エリア「' + name + '」を選んで検索しました');
        finishSuccess(gen);
      } else {
        finishFailure(gen, true);
      }
    }, AFTER_PICK_MS);
  }

  function openAndPick(gen, select) {
    var before = getVisibleDropdowns();
    var trigger = getTrigger(select);
    if (!trigger || !safeClick(trigger, '開くトリガー')) {
      finishFailure(gen);
      return;
    }

    var attempts = 0;
    function poll() {
      if (gen !== currentGeneration || currentPath() !== TARGET_PATH) {
        finishFailure(gen);
        return;
      }
      if (!isNodeConnected(select) || !isNodeConnected(trigger)) {
        finishFailure(gen);
        return;
      }

      attempts++;
      var now = getVisibleDropdowns();
      var found = null;
      for (var i = 0; i < now.length; i++) {
        if (before.indexOf(now[i]) < 0) { found = now[i]; break; }
      }
      // 既存のリストが再利用されることもある。1つしか見えていないならそれで確定
      if (!found && now.length === 1) found = now[0];

      if (found) {
        onDropdownReady(gen, select, trigger, found);
        return;
      }
      if (attempts < DROPDOWN_MAX_ATTEMPTS) {
        addTimeout(poll, 50);
        return;
      }
      if (hydrationRetryCount < HYDRATION_RETRY_MAX - 1) {
        // 初期水和前のクリックは例外なしで無視されることがある。同じ画面・同じ世代で
        // 有限回だけ待って再試行し、利用者操作や常駐pollにはしない。
        hydrationRetryCount++;
        running = false;
        triedOnThisScreen = false;
        addTimeout(function () {
          if (gen === currentGeneration && currentPath() === TARGET_PATH) D.vehicleKinds.apply();
        }, HYDRATION_RETRY_DELAY_MS);
      } else {
        // 一時的な水和遅延は想定内。有限回すべて失敗した場合だけ警告する。
        log('車種情報: 選択肢が開かなかったため何もしません', true);
        finishFailure(gen);
      }
    }

    addTimeout(poll, 50);
  }

  D.vehicleKinds = {
    apply: function () {
      var path = currentPath();
      if (lastPath !== path) {
        lastPath = path;
        triedOnThisScreen = false;
        currentGeneration++;
        clearPendingTimeouts();
        running = false;
        autoSelectedName = null;
        hydrationRetryCount = 0;
        clearAutoSelectionGuard();
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
        // この世代で拡張自身が選んだ値だけは、直前の検索失敗から再試行する。
        // 利用者が選んだ値や別の値は従来どおり一切自動検索しない。
        if (autoSelectedName && ownsAutoSelection(select, currentGeneration, autoSelectedName)) {
          var retryGen = currentGeneration;
          running = true;
          triedOnThisScreen = true;
          addTimeout(function () {
            if (retryGen !== currentGeneration || currentPath() !== TARGET_PATH || !isNodeConnected(select)) {
              finishFailure(retryGen);
              return;
            }
            if (!ownsAutoSelection(select, retryGen, autoSelectedName)) {
              finishFailure(retryGen);
              return;
            }
            var retryButton = getSearchButton();
            if (!retryButton || !isNodeConnected(retryButton) || !safeClick(retryButton, '検索ボタン')) {
              finishFailure(retryGen, true);
              return;
            }
            log('車種情報: エリア「' + autoSelectedName + '」の検索を再試行しました');
            finishSuccess(retryGen);
          }, AFTER_PICK_MS);
          return;
        }
        triedOnThisScreen = true;
        return;
      }

      // 利用者が自分で選択肢を開いている最中に割り込まない
      if (getVisibleDropdowns().length > 0) return;

      triedOnThisScreen = true;
      running = true;
      openAndPick(currentGeneration, select);
    },

    _reset: function () {
      lastPath = null;
      triedOnThisScreen = false;
      running = false;
      currentGeneration++;
      autoSelectedName = null;
      hydrationRetryCount = 0;
      clearAutoSelectionGuard();
      clearPendingTimeouts();
    },
    _state: function () {
      return { lastPath: lastPath, tried: triedOnThisScreen, running: running, generation: currentGeneration };
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
  var MIN_VISIBLE_MS = 300;
  var HARD_MAX_BUSY_MS = 15000;
  var OVERLAY_ATTR = 'data-dbsext-loading-mask';
  var TOP_INDICATOR_ATTR = 'data-dbsext-top-indicator';
  var BANNER_ATTR = 'data-dbsext-error-banner';
  var HOST_ATTR = 'data-dbsext-net-status';
  var NAV_OVERLAY_ATTR = 'data-dbsext-navigation-loading';
  var BEFORE_NAV_READY_EVENT = 'dbsext:before-navigation-ready';
  var NAV_STORAGE_KEY = 'dbsext:navigation-loading-v2';
  var NAV_PENDING_KEY = 'dbsext:navigation-pending-v2';
  var NAV_MIN_VISIBLE_MS = 2000;

  var activeRequests = 0;
  var readinessMap = {};
  var silentDepth = 0;
  var delayTimer = null;
  var elapsedTimer = null;
  var minVisibleTimer = null;
  var watchdogTimer = null;
  var requestStartTime = 0;
  var uiVisibleStartTime = 0;
  var busyEpisodeStartTime = 0;
  var isMaskVisible = false;
  var mainWorldListening = false;
  var navigationObserver = null;
  var navigationTimer = null;
  var navigationPending = false;
  var navigationVisibleStartTime = 0;
  var navigationMinVisibleTimer = null;
  var navigationPollTimer = null;
  var navigationFinalizeTimer = null;

  function onNavigationStart() {
    navigationPending = true;
    try { sessionStorage.setItem(NAV_PENDING_KEY, '1'); } catch (e) {}
  }

  function onNavigationComplete() {
    navigationPending = false;
    try { sessionStorage.removeItem(NAV_PENDING_KEY); } catch (e) {}
  }

  function navigationTargetReady() {
    if (typeof document === 'undefined' || typeof location === 'undefined') return false;
    if (!navigationPending) return false;
    var params;
    try { params = new URLSearchParams(location.search); } catch (e) { return false; }
    var expected = null;
    if (/^\/vehicles\/?$/.test(location.pathname)) expected = '1000';
    else if (/^\/notifications\/messages\/?$/.test(location.pathname)) expected = '500';
    else return document.readyState === 'complete';
    if (params.get('page-size') !== expected) return false;
    return !!document.querySelector('table.el-table__body tbody tr');
  }

  function finalizeNavigationOverlayRemoval() {
    navigationFinalizeTimer = null;
    if (navigationObserver) { navigationObserver.disconnect(); navigationObserver = null; }
    if (navigationPollTimer) { clearTimeout(navigationPollTimer); navigationPollTimer = null; }
    if (navigationTimer) { clearTimeout(navigationTimer); navigationTimer = null; }
    onNavigationComplete();
    if (typeof document !== 'undefined') {
      var nodes = document.querySelectorAll('[' + NAV_OVERLAY_ATTR + ']');
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].parentNode) nodes[i].parentNode.removeChild(nodes[i]); // dbsext:own-ui
      }
      // document_startで先にマスクしたMAIN worldにも準備完了を知らせる。
      try { document.dispatchEvent(new CustomEvent('dbsext:navigation-ready')); } catch (e) {}
    }
    try { sessionStorage.removeItem(NAV_STORAGE_KEY); } catch (e) {}
  }

  function removeNavigationOverlay() {
    if (navigationVisibleStartTime && Date.now() - navigationVisibleStartTime < NAV_MIN_VISIBLE_MS) {
      if (!navigationMinVisibleTimer) {
        navigationMinVisibleTimer = setTimeout(function () {
          navigationMinVisibleTimer = null;
          // readinessを検出した時点ではnavigationPendingはまだtrueのまま。
          // ここでpending解除を待つと循環条件になり、後続DOM変化がない画面では
          // 20秒ウォッチドッグまでオーバーレイが残るため、準備状態を再判定する。
          checkNavigationReady();
        }, NAV_MIN_VISIBLE_MS - (Date.now() - navigationVisibleStartTime));
      }
      return;
    }
    if (navigationFinalizeTimer) return;
    // 遷移先DOMが完成し、マスクを外す直前の最終調整点。
    // URLだけ先に変わる画面でも、この時点なら表と折りたたみDOMが揃っている。
    if (typeof document !== 'undefined') {
      try { document.dispatchEvent(new CustomEvent(BEFORE_NAV_READY_EVENT)); } catch (e) {}
    }
    // Element Plus/Vueはheader.click()後のclass反映をmicrotaskで行う。
    // 次のtimer taskまでマスクを残し、折りたたみ反映前の一瞬を見せない。
    navigationFinalizeTimer = setTimeout(finalizeNavigationOverlayRemoval, 0);
  }

  function checkNavigationReady() {
    if (navigationTargetReady()) removeNavigationOverlay();
  }

  function pollNavigationReady() {
    navigationPollTimer = null;
    if (!navigationPending) return;
    checkNavigationReady();
    if (navigationPending) navigationPollTimer = setTimeout(pollNavigationReady, 100);
  }

  function showNavigationOverlay(persist) {
    if (typeof document === 'undefined') return;
    // core再適用のたびに最小表示時間をリセットしない。遷移1回につき開始は1回。
    if (!navigationPending) onNavigationStart();
    if (!navigationVisibleStartTime) navigationVisibleStartTime = Date.now();
    if (persist) {
      try { sessionStorage.setItem(NAV_STORAGE_KEY, String(Date.now())); } catch (e) {}
    }
    var root = document.documentElement || document.body;
    if (!root) return;
    if (!document.querySelector('[' + NAV_OVERLAY_ATTR + ']')) {
      var overlay = document.createElement('div');
      overlay.setAttribute(NAV_OVERLAY_ATTR, '1');
      overlay.setAttribute(HOST_ATTR, '1');
      overlay.textContent = '読み込み中…';
      overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(235,238,242,.96);color:#334155;font:600 18px sans-serif;pointer-events:auto;';
      root.appendChild(overlay);
    }
    if (D.platform && D.platform.isUserScript) {
      // USER_SCRIPT worldのDOM参照はobserve()でNode型不一致になる実機がある。
      // MAIN worldの早期マスクと併用し、ここでは有限タイマー内のpollで準備判定する。
      if (!navigationPollTimer) navigationPollTimer = setTimeout(pollNavigationReady, 100);
    } else if (typeof MutationObserver !== 'undefined') {
      if (navigationObserver) { navigationObserver.disconnect(); }
      try {
        navigationObserver = new MutationObserver(checkNavigationReady);
        if (document && typeof document === 'object') {
          navigationObserver.observe(document, { childList: true, subtree: true });
        }
      } catch (e) {
        navigationObserver = null;
        if (D.core && typeof D.core.log === 'function') {
          D.core.log('navigationObserver の監視開始に失敗: ' + (e && e.message ? e.message : e), true);
        }
      }
    }
    if (!navigationTimer) navigationTimer = setTimeout(removeNavigationOverlay, 20000);
  }

  function restoreNavigationOverlay() {
    // すでに同じ遷移の監視中なら、core再適用で時計・overlayを作り直さない。
    if (navigationPending && navigationPollTimer) return;
    try {
      if (sessionStorage.getItem(NAV_PENDING_KEY) === '1') {
        navigationPending = true;
      }
    } catch (e) {}
    var started = 0;
    try { started = Number(sessionStorage.getItem(NAV_STORAGE_KEY) || 0); } catch (e) {}
    if (started && Date.now() - started < 30000) {
      showNavigationOverlay(false);
      // 新ページで navigationPending=true なら、checkNavigationReady() を開始する
      if (navigationPending) {
        setTimeout(checkNavigationReady, 400);
      }
    }
    else if (started) removeNavigationOverlay();
  }

  function getReadinessDepth() {
    var count = 0;
    for (var k in readinessMap) {
      if (Object.prototype.hasOwnProperty.call(readinessMap, k)) count++;
    }
    return count;
  }

  function isBusy() {
    return activeRequests > 0 || getReadinessDepth() > 0;
  }

  function clearWatchdog() {
    if (watchdogTimer) {
      clearTimeout(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function forceResetBusy(reason) {
    activeRequests = 0;
    readinessMap = {};
    busyEpisodeStartTime = 0;
    uiVisibleStartTime = 0;
    clearWatchdog();
    if (delayTimer) { clearTimeout(delayTimer); delayTimer = null; }
    if (minVisibleTimer) { clearTimeout(minVisibleTimer); minVisibleTimer = null; }
    if (D && D.core && typeof D.core.log === 'function') {
      D.core.log('netStatus ハード上限リセット: ' + reason, true);
    }
    hideLoadingUI();
  }

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
      if (isBusy() && isMaskVisible) {
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
    if (minVisibleTimer) {
      clearTimeout(minVisibleTimer);
      minVisibleTimer = null;
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

  function reconcileBusy() {
    if (isBusy()) {
      if (busyEpisodeStartTime === 0) {
        busyEpisodeStartTime = Date.now();
        clearWatchdog();
        watchdogTimer = setTimeout(function () {
          forceResetBusy('busy状態が15秒を超えたため強制作消しました');
        }, HARD_MAX_BUSY_MS);
      }

      if (minVisibleTimer) {
        clearTimeout(minVisibleTimer);
        minVisibleTimer = null;
      }

      if (!isMaskVisible && !delayTimer) {
        requestStartTime = Date.now();
        delayTimer = setTimeout(function () {
          delayTimer = null;
          if (isBusy()) {
            uiVisibleStartTime = Date.now();
            showLoadingUI();
            scheduleElapsedTimer();
          }
        }, LOADING_DELAY_MS);
      }
    } else {
      if (delayTimer) {
        clearTimeout(delayTimer);
        delayTimer = null;
      }

      if (isMaskVisible) {
        var elapsed = Date.now() - uiVisibleStartTime;
        if (elapsed < MIN_VISIBLE_MS) {
          if (!minVisibleTimer) {
            minVisibleTimer = setTimeout(function () {
              minVisibleTimer = null;
              if (!isBusy()) {
                busyEpisodeStartTime = 0;
                clearWatchdog();
                hideLoadingUI();
              }
            }, MIN_VISIBLE_MS - elapsed);
          }
        } else {
          busyEpisodeStartTime = 0;
          clearWatchdog();
          hideLoadingUI();
        }
      } else {
        busyEpisodeStartTime = 0;
        clearWatchdog();
      }
    }
  }

  function onRequestStart() {
    activeRequests++;
    reconcileBusy();
  }

  function onRequestEnd() {
    activeRequests = Math.max(0, activeRequests - 1);
    reconcileBusy();
  }

  function beginReadiness(key) {
    if (typeof key !== 'string' || !key) return;
    readinessMap[key] = true;
    reconcileBusy();
  }

  function endReadiness(key) {
    if (typeof key !== 'string' || !key) return;
    delete readinessMap[key];
    reconcileBusy();
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

  function isPortalUrl(input) {
    var url = '';
    try {
      if (typeof input === 'string') url = input;
      else if (input && typeof input.url === 'string') url = input.url;
      else if (input && typeof input.href === 'string') url = input.href;
    } catch (e) {}
    // XHR send() without a captured open() URL is retained as portal traffic for
    // compatibility with old/mocked implementations. Explicit external URLs are excluded.
    if (!url) return true;
    return url.indexOf('https://mg.docomo-cycle.jp/') === 0 ||
      (url.indexOf('/') === 0 && url.indexOf('//') !== 0);
  }

  function wrapFetch() {
    if (typeof window === 'undefined' || !window.fetch) return;
    if (window.fetch.__dbsext_wrapped) return;

    var origFetch = window.fetch;
    var newFetch = function (input, init) {
      var isSilent = silentDepth > 0 || !isPortalUrl(input);
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
      var isSilent = silentDepth > 0 || !isPortalUrl(xhr.__dbsext_request_url);

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

    if (XMLHttpRequest.prototype.open && !XMLHttpRequest.prototype.open.__dbsext_wrapped) {
      var origOpen = XMLHttpRequest.prototype.open;
      var newOpen = function (method, url) {
        try { this.__dbsext_request_url = String(url || ''); } catch (e) {}
        return origOpen.apply(this, arguments);
      };
      newOpen.__dbsext_wrapped = true;
      XMLHttpRequest.prototype.open = newOpen;
    }
  }

  function queryMainWorldSnapshot() {
    if (typeof document === 'undefined') return;
    try {
      var queryEvt = new CustomEvent('dbsext:main-fetch-query');
      document.dispatchEvent(queryEvt);
    } catch (e) {}
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

    document.addEventListener('dbsext:main-fetch-start', function (e) {
      var detail = (e && e.detail) || {};
      var count = detail.activeRequests;
      if (typeof count === 'number' && isFinite(count) && count >= 0 && Math.floor(count) === count) {
        activeRequests = count;
        reconcileBusy();
      } else {
        onRequestStart();
      }
    });

    document.addEventListener('dbsext:main-fetch-end', function (e) {
      var detail = (e && e.detail) || {};
      var count = detail.activeRequests;
      if (typeof count === 'number' && isFinite(count) && count >= 0 && Math.floor(count) === count) {
        activeRequests = count;
        reconcileBusy();
      } else {
        onRequestEnd();
      }
      var status = detail.status;
      if (status === 401 || status === 403) {
        showBanner('ログインが切れました。再度ログインしてください', true);
      } else if (status >= 400) {
        showBanner('通信に失敗しました（HTTP ' + status + '）。再読込してください', false);
      } else if (detail.error) {
        // 旧版MAIN傍受スクリプトは、画面遷移や重複GETの正常中断も
        // status=0/error=true としか通知しない。原因を識別できない汎用エラーは
        // 赤バナーにせず、判定可能なHTTPステータスだけを通知する。
      }
    });

    document.addEventListener('dbsext:main-fetch-snapshot', function (e) {
      var detail = (e && e.detail) || {};
      var count = detail.activeRequests;
      if (typeof count === 'number' && isFinite(count) && count >= 0 && Math.floor(count) === count) {
        activeRequests = count;
        reconcileBusy();
      }
    });

    queryMainWorldSnapshot();
  }

  D.netStatus = {
    LOADING_DELAY_MS: LOADING_DELAY_MS,

    beginReadiness: beginReadiness,
    endReadiness: endReadiness,

    apply: function () {
      // 拡張版（β）またはリモート配信版: MAIN ワールドからの DOM イベントを購読
      if (D.platform && (D.platform.kind === 'extension' || D.platform.isUserScript)) {
        listenToMainWorldEvents();
      } else {
        // ブックマークレット版（α）: fetch / XHR を直接ラップ
        wrapFetch();
        wrapXHR();
      }

      if (isMaskVisible && isBusy()) {
        renderMask();
      }
      restoreNavigationOverlay();
    },

    beginNavigation: function () {
      showNavigationOverlay(true);
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
    _getReadinessDepth: getReadinessDepth,
    _isMaskVisible: function () {
      return isMaskVisible;
    },
    _forceResetBusy: forceResetBusy,
    _queryMainWorldSnapshot: queryMainWorldSnapshot
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
      headerFg: '#000000',
      cellFg: '#000000',
      rowOdd: '#ffffff',
      rowEven: '#f7f9fc',
      rowHover: '#e8f1fb',
      border: '#c8ccd4',
      fontSize: '14px',
      headerPadY: '4px',
      cellPadY: '6px',
      padX: '12px',
      linkFg: '#2563eb',
      emptyFg: '#000000',
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
      { name: '見出し（画面タイトル）', fg: t.cellFg, bg: t.rowOdd },
      { name: '表セル', fg: t.cellFg, bg: t.rowOdd }
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
      '.dbsext-has-selection [data-dbsext-table="portal"] th:nth-child(2),',
      '[data-dbsext-has-selection] [data-dbsext-table="portal"] th:nth-child(2) {',
      '  position: sticky !important;',
      '  left: 44px !important;',
      '  z-index: ' + t.zHeaderCol + ' !important;',
      '  background-color: ' + t.headerBg + ' !important;',
      '  box-shadow: 2px 0 4px -2px rgba(0,0,0,0.12);',
      '}',
      '.dbsext-has-selection [data-dbsext-table="portal"] td:nth-child(2),',
      '[data-dbsext-has-selection] [data-dbsext-table="portal"] td:nth-child(2) {',
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
      '.dbsext-has-selection [data-dbsext-table="portal"] tbody tr:nth-child(odd) td:nth-child(2),',
      '[data-dbsext-has-selection] [data-dbsext-table="portal"] tbody tr:nth-child(odd) td:nth-child(2) {',
      '  background-color: ' + t.rowOdd + ' !important;',
      '}',
      '[data-dbsext-table] tbody tr:nth-child(even) td:first-child,',
      '.dbsext-has-selection [data-dbsext-table="portal"] tbody tr:nth-child(even) td:nth-child(2),',
      '[data-dbsext-has-selection] [data-dbsext-table="portal"] tbody tr:nth-child(even) td:nth-child(2) {',
      '  background-color: ' + t.rowEven + ' !important;',
      '}',
      '[data-dbsext-table] tbody tr:hover td:first-child,',
      '[data-dbsext-table] tbody tr.hover-row td:first-child,',
      '.dbsext-has-selection [data-dbsext-table="portal"] tbody tr:hover td:nth-child(2),',
      '.dbsext-has-selection [data-dbsext-table="portal"] tbody tr.hover-row td:nth-child(2),',
      '[data-dbsext-has-selection] [data-dbsext-table="portal"] tbody tr:hover td:nth-child(2),',
      '[data-dbsext-has-selection] [data-dbsext-table="portal"] tbody tr.hover-row td:nth-child(2) {',
      '  background-color: ' + t.rowHover + ' !important;',
      '}',
      '',
      '/* --- 右端列の固定（W2: 利用明細列の常時可視化） ------------------------ */',
      '[data-dbsext-table] th.dbsext-sticky-right {',
      '  position: sticky !important;',
      '  right: 0 !important;',
      '  z-index: ' + t.zHeaderCol + ' !important;',
      '  background-color: ' + t.headerBg + ' !important;',
      '  box-shadow: -2px 0 4px -2px rgba(0,0,0,0.12);',
      '}',
      '[data-dbsext-table] td.dbsext-sticky-right {',
      '  position: sticky !important;',
      '  right: 0 !important;',
      '  z-index: ' + t.zBodyCol + ' !important;',
      '  box-shadow: -2px 0 4px -2px rgba(0,0,0,0.12);',
      '}',
      '/* 固定セルは背景が透けると下の行が見えてしまうため、不透明を保つ */',
      '[data-dbsext-table] tbody tr:nth-child(odd) td.dbsext-sticky-right {',
      '  background-color: ' + t.rowOdd + ' !important;',
      '}',
      '[data-dbsext-table] tbody tr:nth-child(even) td.dbsext-sticky-right {',
      '  background-color: ' + t.rowEven + ' !important;',
      '}',
      '[data-dbsext-table] tbody tr:hover td.dbsext-sticky-right,',
      '[data-dbsext-table] tbody tr.hover-row td.dbsext-sticky-right {',
      '  background-color: ' + t.rowHover + ' !important;',
      '}',
      '',
      '/* ポータル標準の車両状態色を、車両識別番号セルだけに残す。',
      '   実機確認（2026-08-09）:',
      '     bg-green = rgb(168, 240, 122) / bg-brown = rgb(197, 149, 107)',
      '     bg-red   = rgb(255, 99, 71)',
      '   行全体の着色はゼブラ表示と競合するため復元せず、sticky な第2列だけへ反映する。',
      '   **自前表に対応する概念が無いため、ここはポータル固有のままでよい。** */',
      '.dbsext-has-selection [data-dbsext-table="portal"] tbody tr.bg-green td:nth-child(2),',
      '[data-dbsext-has-selection] [data-dbsext-table="portal"] tbody tr.bg-green td:nth-child(2) {',
      '  background-color: rgb(168, 240, 122) !important;',
      '}',
      '.dbsext-has-selection [data-dbsext-table="portal"] tbody tr.bg-brown td:nth-child(2),',
      '[data-dbsext-has-selection] [data-dbsext-table="portal"] tbody tr.bg-brown td:nth-child(2) {',
      '  background-color: rgb(197, 149, 107) !important;',
      '}',
      '.dbsext-has-selection [data-dbsext-table="portal"] tbody tr.bg-red td:nth-child(2),',
      '[data-dbsext-has-selection] [data-dbsext-table="portal"] tbody tr.bg-red td:nth-child(2) {',
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
      '[data-dbsext-filter-max],',
      '[data-dbsext-filter-select] {',
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
      '[data-dbsext-filter-select] {',
      '  cursor: pointer !important;',
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
        '/* W1-1: ポータル標準の灰色を黒に上書き。',
        '   実測（docs/17 §8）で `.cell` が #777777 だった。**表の中に限定して**当てる',
        '   （素の `.cell` は表以外の要素にも当たりうるため範囲を絞る）。 */',
        '.el-table .cell {',
        '  color: #000000 !important;',
        '}',
        '.el-table__empty-text {',
        '  color: #000000 !important;',
        '}',
        ':root {',
        '  --el-text-color-regular: #000000 !important;',
        '  --el-text-color-primary: #000000 !important;',
        '  --el-text-color-secondary: #000000 !important;',
        '}',
        '',
        '/* W1-2: 表示条件パネルを1段組化 */',
        '[data-dbsext-cond-panel] > div {',
        '  flex-wrap: wrap !important;',
        '}',
        '[data-dbsext-cond-panel] > div > div {',
        '  flex-basis: 100% !important;',
        '  padding-right: 0 !important;',
        '}',
        '/* W1-2: ラベル（display:contents）の子要素に nowrap を当てる */',
        '[data-dbsext-cond-panel] label > * {',
        '  white-space: nowrap !important;',
        '}',
        '',
        '/* W1-3: 戻るボタンを非表示 */',
        '[data-dbsext-hidden-back="1"] {',
        '  display: none !important;',
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
        '}',
        '',
        '/* --- 車両情報履歴: 既存地図の拡大表示（W4） --- */',
        '.dbsext-history-map-expanded {',
        '  position: fixed !important;',
        '  top: 0 !important;',
        '  left: 0 !important;',
        '  width: 100vw !important;',
        '  height: 100vh !important;',
        '  z-index: 2147483000 !important;',
        '  box-sizing: border-box !important;',
        '  margin: 0 !important;',
        '  background-color: #ffffff !important;',
        '}',
        '.dbsext-history-map-btn-host {',
        '  display: block !important;',
        '  margin-bottom: 8px !important;',
        '}',
        '.dbsext-history-map-btn {',
        '  display: inline-flex !important;',
        '  align-items: center !important;',
        '  gap: 6px !important;',
        '  padding: 6px 14px !important;',
        '  background-color: #ffffff !important;',
        '  color: ' + accent + ' !important;',
        '  border: 1px solid ' + accent + ' !important;',
        '  border-radius: 4px !important;',
        '  font-size: 13px !important;',
        '  font-weight: bold !important;',
        '  cursor: pointer !important;',
        '  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1) !important;',
        '  transition: all 0.2s ease !important;',
        '}',
        '.dbsext-history-map-btn:hover {',
        '  opacity: 0.9 !important;',
        '}',
        '.dbsext-history-map-close-btn {',
        '  position: fixed !important;',
        '  top: 16px !important;',
        '  right: 16px !important;',
        '  z-index: 2147483001 !important;',
        '  padding: 8px 16px !important;',
        '  background-color: #ffffff !important;',
        '  color: #000000 !important;',
        '  border: 1px solid ' + t.border + ' !important;',
        '  border-radius: 6px !important;',
        '  font-size: 14px !important;',
        '  font-weight: bold !important;',
        '  cursor: pointer !important;',
        '  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25) !important;',
        '}',
        '.dbsext-history-map-close-btn:hover {',
        '  opacity: 0.9 !important;',
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
  // 列挙値の列（公開設定など）向け。文字列部分一致だと、選択肢の一方が
  // もう一方の部分文字列になる場合に誤って両方ヒットする（例:「公開」は
  // 「非公開」の部分文字列）。そのためプルダウン選択式は必ず完全一致で絞り込む
  var FILTER_SELECT = 'select';

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

    if (cond.kind === FILTER_SELECT) {
      var selected = String(cond.text == null ? '' : cond.text);
      if (selected === '') return true; // 「すべて」
      var cellValue = cellText === null || cellText === undefined ? '' : String(cellText);
      return cellValue === selected; // **完全一致。** 部分一致にすると列挙値どうしが誤って重なりうる
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
   *   columnLabel   … 列名（絞り込みの種類の判定に使う）
   *   sortMode      … 'indicator'（見出し文字の隣に▲を足す）/ 'button'（見出し全体をボタンに）
   *   onSort        … 並べ替えが押された
   *   onFilter      … 絞り込みが変わった（引数は条件オブジェクト）
   *   filterOptions … 列挙値の配列（例: ['公開','非公開']）を渡すと、文字入力の代わりに
   *                   プルダウン選択式の絞り込みになる（先頭に「すべて」を自動で足す）。
   *                   **列名によらず、渡された時点で選択式が優先される。**
   *                   値の完全一致で絞り込む（部分一致にすると「公開」が「非公開」も
   *                   拾ってしまうため）
   * @returns {object} { sortEl, filterWrap, condition, syncFromState }
   */
  function buildHeaderControls(spec) {
    var columnLabel = spec.columnLabel || '';
    var hasSelectOptions = Array.isArray(spec.filterOptions) && spec.filterOptions.length > 0;
    var kind = hasSelectOptions ? FILTER_SELECT : filterKindFor(columnLabel);
    var condition = { kind: kind, text: '', min: '', max: '' };

    // --- 並べ替え ---
    var sortEl;
    var sortArrowEl; // 'button'モードのときだけ使う（矢印だけを薄く/濃くするため見出し文字と分ける）
    if (spec.sortMode === 'button') {
      sortEl = document.createElement('button');
      sortEl.type = 'button';
      sortEl.className = 'dbsext-th-sort';
      sortEl.title = 'クリックで並べ替え';

      var labelEl = document.createElement('span');
      labelEl.textContent = columnLabel;
      sortEl.appendChild(labelEl);

      // 並べ替えが働いていないときも矢印を薄く表示し、この列が並べ替え可能だと
      // 分かるようにする（'indicator'モードは元から同じ考え方で薄い▲を出していた。
      // 'button'モードだけ、働いたときにしか矢印が出ない仕様になっていたのを揃えた）
      sortArrowEl = document.createElement('span');
      sortArrowEl.className = 'dbsext-th-sort-arrow';
      sortArrowEl.textContent = ' ▲';
      sortArrowEl.style.opacity = '0.3';
      sortEl.appendChild(sortArrowEl);
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

    if (kind === FILTER_SELECT) {
      var select = document.createElement('select');
      select.setAttribute('data-dbsext-filter-select', '1');
      select.title = columnLabel + ' で絞り込み';
      select.addEventListener('click', function (e) { e.stopPropagation(); });
      select.addEventListener('keydown', function (e) { e.stopPropagation(); });

      var allOption = document.createElement('option');
      allOption.value = '';
      allOption.textContent = 'すべて';
      select.appendChild(allOption);

      // 重複は1つにまとめる。表示順は呼び出し側が渡した順のまま
      var seen = Object.create(null);
      for (var oi = 0; oi < spec.filterOptions.length; oi++) {
        var optValue = String(spec.filterOptions[oi]);
        if (seen[optValue]) continue;
        seen[optValue] = true;
        var opt = document.createElement('option');
        opt.value = optValue;
        opt.textContent = optValue;
        select.appendChild(opt);
      }

      select.addEventListener('change', function () { condition.text = select.value; notify(); });
      filterWrap.appendChild(select);
      inputs.push({ key: 'text', el: select });
    } else if (kind === FILTER_NUMBER) {
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
      sortArrowEl: sortArrowEl, // 'button'モードのみ。矢印だけを検証したいテスト用
      filterWrap: filterWrap,
      condition: condition,
      kind: kind,
      /** 状態側の値を入力欄へ反映する（再適用で作り直したときのため） */
      syncFromState: function (saved) {
        if (!saved) return;
        for (var i = 0; i < inputs.length; i++) {
          var key = inputs[i].key;
          var value = saved[key] === undefined || saved[key] === null ? '' : String(saved[key]);
          var el = inputs[i].el;
          if (el) {
            if (typeof document !== 'undefined' && document.activeElement === el) {
              if (el.value !== value) {
                var sStart = el.selectionStart;
                var sEnd = el.selectionEnd;
                el.value = value;
                try {
                  if (typeof sStart === 'number' && typeof sEnd === 'number') {
                    el.setSelectionRange(sStart, sEnd);
                  }
                } catch (e) {}
              }
            } else {
              if (el.value !== value) el.value = value;
            }
          }
          condition[key] = value;
        }
      },
      /** 並べ替えの表示を更新する。**働いていないときも矢印は薄く出す**（この列が
       * 並べ替え可能だと分かるように。indicatorモードは元からこの考え方だった） */
      updateSortIndicator: function (isActive, order) {
        if (spec.sortMode === 'button') {
          sortArrowEl.textContent = isActive ? (order === 'asc' ? ' ▲' : ' ▼') : ' ▲';
          sortArrowEl.style.opacity = isActive ? '1' : '0.3';
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
    FILTER_SELECT: FILTER_SELECT,
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
   *   columns     … [{ label, value(row), render(td, row), filterOptions }]
   *                 render を渡すとセルの中身を自前で作れる（リンク等）。
   *                 filterOptions（例: ['公開','非公開']）を渡すと、その列の
   *                 見出し絞り込みが文字入力ではなくプルダウン選択式になる
   *                 （table-kit.buildHeaderControls参照。完全一致で絞り込む）
   *   tableAttrs  … 表に付ける属性 { 'data-dbsext-beacons-table': '1', ... }
   *   emptyText   … 絞り込み結果が0件のときの文言
   *   initialSort … { columnIndex, direction } 省略時は並べ替えなし
   *   initialState … 既存表をデータ更新で描き直すときの状態（並べ替え・絞り込み）
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
    // データ更新で表を描き直す場合も、利用者が操作中の条件を失わせない。
    // sortColIndex は null/undefined のとき未選択として扱い、条件は後段の
    // 見出しコントロール生成時に各入力へ同期する。
    var initialState = spec.initialState || null;
    if (initialState && typeof initialState.sortColIndex === 'number') {
      state.sortColIndex = initialState.sortColIndex;
      state.sortOrder = initialState.sortOrder === 'desc' ? 'desc' : 'asc';
    }
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
      } else {
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

      // tbodyの再構築が終わった直後に呼ぶフック（省略可）。
      // 2026-08-12独立監査「絞り込み後、port-bulk-actions.jsの見出し一括選択
      // チェックボックスの状態(checked/indeterminate)が古いままになる」への対応。
      // tbody内の行を見て何かを同期したい呼び出し側（見出しチェックボックス等）が
      // 絞り込み・並替のたびに再同期できるようにする
      if (typeof spec.onRefresh === 'function') spec.onRefresh();
    }

    // --- 見出し ---
    for (var h = 0; h < columns.length; h++) {
      (function (columnIndex) {
        var th = document.createElement('th');
        var controls = kit().buildHeaderControls({
          columnLabel: columns[columnIndex].label,
          filterOptions: columns[columnIndex].filterOptions,
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
        if (initialState && initialState.conditions) {
          controls.syncFromState(initialState.conditions[columnIndex]);
        }
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
    // USER_SCRIPT worldではMutationObserverのNode型不一致が起き得る。
    // MAIN worldから通知されるcore再適用でクラスを復元するため直接監視しない。
    if (D.platform && D.platform.isUserScript) return;
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
 * DBSEXT ユーザサマリ・7会員区分ルーティングモジュール
 *
 * 画面内に表示されるユーザ識別番号（userUniqueCode）を安全に会員区分・ユーザーIDへ
 * 解決し、7会員区分に応じた正しいユーザ詳細画面へのリンクURLを提供する。
 *
 * 契約（docs/06-module-contract.md §6）および AGENTS.md 人間決裁例外2 の遵守:
 *   - POST先は完全一致文字列リテラル '/api/users' のみ。
  *   - リクエスト本文キーは実測済み固定ホワイトリスト10種のみ（実行時検証、違反時は即座に中断）。
 *   - 取得結果は完全一致した { userKind, userId } のみ保持し、氏名・電話・メール等は一切保持・ログ出力しない。
  *   - 同時実行上限（最大3並列）、拡張版1000件一覧の一意コード上限（最大1000件）、session cache（TTL 30分、negative cache対応）。
 *   - 世代管理と AbortController による画面遷移時の中断。
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  // ---------------------------------------------------------------------------
  // 7会員区分の定義とルートマッピング
  // ---------------------------------------------------------------------------

  var USER_KINDS = {
    GENERAL: {
      displayName: '一般ユーザ',
      route: 'general', apiValue: 'general'
    },
    CORPORATE_CARD: {
      displayName: '法人カード専用ユーザ',
      route: 'corporate-card', apiValue: 'corporateCard'
    },
    MAAS: {
      displayName: 'MaaSユーザ',
      route: 'maas', apiValue: 'maas'
    },
    MAAS_ONEDAY_PASS: {
      displayName: 'MaaS1日パスユーザ',
      route: 'maas-oneday-pass', apiValue: 'maasOnedayPass'
    },
    CARD_PASS: {
      displayName: '窓口販売パスユーザ',
      route: 'card-pass', apiValue: 'cardPass'
    },
    CONVENIENCE_PASS: {
      displayName: 'コンビニパスユーザ',
      route: 'convenience-pass', apiValue: 'conveniencePass'
    },
    MAINTENANCE: {
      displayName: '集配ユーザ',
      route: 'maintenance', apiValue: 'maintenance'
    }
  };

  // 照会の決定的な順序
  var USER_KIND_ORDER = [
    'GENERAL',
    'CORPORATE_CARD',
    'MAAS',
    'MAAS_ONEDAY_PASS',
    'CARD_PASS',
    'CONVENIENCE_PASS',
    'MAINTENANCE'
  ];

  // 許可されるリクエスト本文キーのホワイトリスト
  var ALLOWED_BODY_KEYS = [
    'areaIds',
    'firstName',
    'includeNeverUsedUsers',
    'mailAddress',
    'phoneNumber',
    'surName',
    'surname',
    'userId',
    'userKind',
    'userUniqueCode'
  ].sort();

  // ---------------------------------------------------------------------------
  // キャッシュと並行制御・世代管理の状態
  // ---------------------------------------------------------------------------

  // cacheMap: userUniqueCode -> { userKind, userId, notFound: boolean, expiry: number }
  var cacheMap = {};
  var CACHE_TTL_MS = 30 * 60 * 1000; // 30分 (session cache)。金沢の段階照会完了前に先頭結果を失効させない。
  var SESSION_CACHE_KEY = 'dbsext:user-summary:v1';
  var sessionCacheLoaded = false;

  // 1画面あたりの自動上限。ブックマークレットは従来どおり30件、
  // 拡張版は1000件一覧の全一意コードを最大1000件まで段階処理する。
  var MAX_AUTO_FETCH_PER_PAGE = 30;
  var MAX_EXTENSION_AUTO_FETCH_PER_PAGE = 1000;
  var pageRequestedCodes = {};

  // 並行度制御（最大3並列）
  var MAX_CONCURRENT_FETCH = 3;
  var activeFetchCount = 0;
  var fetchQueue = []; // [{ task: Function, resolve: Function, reject: Function }]

  // Dedupe (同一コードに対する進行中Promiseの共有)
  var inflightPromises = {};

  // 世代管理と AbortController
  var currentGeneration = 0;
  var activeAbortControllers = [];
  var lastContextKey = null;

  function log(message, isError) {
    if (D.core && typeof D.core.log === 'function') {
      D.core.log('[userSummary] ' + message, isError);
    }
  }

  function getAutoFetchLimit() {
    var platform = D.platform;
    if (platform && (platform.kind === 'extension' || platform.isUserScript)) {
      return MAX_EXTENSION_AUTO_FETCH_PER_PAGE;
    }
    return MAX_AUTO_FETCH_PER_PAGE;
  }

  // ---------------------------------------------------------------------------
  // バリデーション関数群
  // ---------------------------------------------------------------------------

  function isValidUserUniqueCode(code) {
    if (!code || typeof code !== 'string') return false;
    return /^USER:[A-Za-z0-9:_-]{1,256}$/.test(code.trim());
  }

  function isValidUserKind(kind) {
    if (!kind || typeof kind !== 'string') return false;
    return Object.prototype.hasOwnProperty.call(USER_KINDS, kind);
  }

  function isValidAreaId(id) {
    if (!id || typeof id !== 'string') return false;
    return /^AREA:[A-Za-z0-9:_-]{1,256}$/.test(id.trim());
  }

  function validateRequestBodyKeys(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    var keys = Object.keys(body).sort();
    if (keys.length !== ALLOWED_BODY_KEYS.length) return false;
    for (var i = 0; i < keys.length; i++) {
      if (keys[i] !== ALLOWED_BODY_KEYS[i]) return false;
    }
    return true;
  }

  function validateResponseShape(data) {
    if (!data || typeof data !== 'object') return false;
    if (!Array.isArray(data.items)) return false;
    if (!data.pagination || typeof data.pagination !== 'object' || Array.isArray(data.pagination)) return false;
    return true;
  }

  // ---------------------------------------------------------------------------
  // API 通信と最小保持
  // ---------------------------------------------------------------------------

  /**
   * 1つの userKind について POST /api/users を発行し、
   * 完全一致レコード { userKind, userId } があれば返す。
   */
  function fetchUserByKind(userUniqueCode, userKind, selectedAreaId, signal) {
    if (!isValidUserUniqueCode(userUniqueCode) || !USER_KINDS[userKind] || !isValidAreaId(selectedAreaId)) {
      return Promise.resolve(null);
    }

    var bodyPayload = {
      userKind: USER_KINDS[userKind].apiValue,
      userId: '',
      userUniqueCode: userUniqueCode,
      includeNeverUsedUsers: true,
      firstName: '',
      surname: '',
      surName: '',
      mailAddress: '',
      phoneNumber: '',
      areaIds: [selectedAreaId.trim()]
    };

    if (!validateRequestBodyKeys(bodyPayload)) {
      log('不正なリクエスト本文キーを検出したため送信を中止しました', true);
      return Promise.resolve(null);
    }

    return fetch('/api/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify(bodyPayload),
      signal: signal
    })
      .then(function (res) {
        if (!res.ok) {
          throw new Error('HTTP ' + res.status);
        }
        return res.json();
      })
      .then(function (data) {
        if (!validateResponseShape(data)) {
          log('不正なレスポンス構造を検出しました', true);
          return null;
        }

        var items = data.items;
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          if (item && item.userUniqueCode === userUniqueCode && item.userKind === USER_KINDS[userKind].apiValue) {
            // 最小保持の原則: userKind と userId だけを取り出し、他の属性（氏名等）は保持しない
            return {
              userKind: userKind,
              userId: (item.userId !== undefined && item.userId !== null) ? String(item.userId) : ''
            };
          }
        }
        return null; // 一致なし
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') {
          return null;
        }
        log('ユーザ照会エラー (' + userKind + '): ' + (err && err.message ? err.message : err), true);
        return null;
      });
  }

  // ---------------------------------------------------------------------------
  // キューイングと並行度制御（最大3並列）
  // ---------------------------------------------------------------------------

  function pumpQueue() {
    while (activeFetchCount < MAX_CONCURRENT_FETCH && fetchQueue.length > 0) {
      var item = fetchQueue.shift();
      activeFetchCount++;
      (function (taskItem) {
        Promise.resolve().then(taskItem.task)
          .then(function (res) {
            activeFetchCount--;
            pumpQueue();
            taskItem.resolve(res);
          })
          .catch(function (err) {
            activeFetchCount--;
            pumpQueue();
            taskItem.reject(err);
          });
      })(item);
    }
  }

  function enqueueFetch(taskFn) {
    return new Promise(function (resolve, reject) {
      fetchQueue.push({
        task: taskFn,
        resolve: resolve,
        reject: reject
      });
      pumpQueue();
    });
  }

  // ---------------------------------------------------------------------------
  // セッションキャッシュ管理
  // ---------------------------------------------------------------------------

  function getSessionStorage() {
    try {
      return global.sessionStorage || null;
    } catch (e) {
      return null;
    }
  }

  function loadSessionCache() {
    if (sessionCacheLoaded) return;
    sessionCacheLoaded = true;
    var storage = getSessionStorage();
    if (!storage) return;
    try {
      var parsed = JSON.parse(storage.getItem(SESSION_CACHE_KEY) || '{}');
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      var now = Date.now();
      var keys = Object.keys(parsed);
      for (var i = 0; i < keys.length; i++) {
        var code = keys[i];
        var entry = parsed[code];
        if (!isValidUserUniqueCode(code) || !entry || typeof entry !== 'object' ||
            typeof entry.expiry !== 'number' || entry.expiry <= now) continue;
        if (entry.notFound === true) {
          cacheMap[code] = { notFound: true, expiry: entry.expiry };
        } else if (isValidUserKind(entry.userKind) && typeof entry.userId === 'string') {
          cacheMap[code] = {
            userKind: entry.userKind,
            userId: entry.userId,
            notFound: false,
            expiry: entry.expiry
          };
        }
      }
    } catch (e) {}
  }

  function persistSessionCache() {
    var storage = getSessionStorage();
    if (!storage) return;
    try {
      storage.setItem(SESSION_CACHE_KEY, JSON.stringify(cacheMap));
    } catch (e) {}
  }

  function getFromCache(userUniqueCode) {
    loadSessionCache();
    var entry = cacheMap[userUniqueCode];
    if (!entry) return null;
    if (Date.now() > entry.expiry) {
      delete cacheMap[userUniqueCode];
      persistSessionCache();
      return null;
    }
    return entry;
  }

  function putToCache(userUniqueCode, summaryOrNull) {
    var now = Date.now();
    if (summaryOrNull && summaryOrNull.userKind) {
      cacheMap[userUniqueCode] = {
        userKind: summaryOrNull.userKind,
        userId: summaryOrNull.userId || '',
        notFound: false,
        expiry: now + CACHE_TTL_MS
      };
    } else {
      // negative cache
      cacheMap[userUniqueCode] = {
        notFound: true,
        expiry: now + CACHE_TTL_MS
      };
    }
    persistSessionCache();
  }

  function clearCache() {
    cacheMap = {};
    sessionCacheLoaded = true;
    var storage = getSessionStorage();
    try {
      if (storage) storage.removeItem(SESSION_CACHE_KEY);
    } catch (e) {}
  }

  // ---------------------------------------------------------------------------
  // 世代管理と中断
  // ---------------------------------------------------------------------------

  function abortAllPending() {
    for (var i = 0; i < activeAbortControllers.length; i++) {
      try {
        activeAbortControllers[i].abort();
      } catch (e) {}
    }
    activeAbortControllers = [];
    var queued = fetchQueue;
    fetchQueue = [];
    for (var q = 0; q < queued.length; q++) {
      try { queued[q].resolve(null); } catch (e2) {}
    }
    inflightPromises = {};
  }

  function resetGeneration() {
    currentGeneration++;
    abortAllPending();
    pageRequestedCodes = {};
  }

  function getContextKey() {
    var path = (typeof location !== 'undefined' && location.pathname) ? location.pathname : '';
    return path + '|' + (getSelectedAreaId() || '');
  }

  function syncContext() {
    var nextKey = getContextKey();
    if (lastContextKey === null) {
      lastContextKey = nextKey;
      return false;
    }
    if (lastContextKey !== nextKey) {
      lastContextKey = nextKey;
      // areaIds が検索条件に含まれるため、別エリアのpositive/negative cacheを持ち越さない。
      clearCache();
      resetGeneration();
      return true;
    }
    return false;
  }

  function resetForTest() {
    clearCache();
    resetGeneration();
    lastContextKey = null;
  }

  // ---------------------------------------------------------------------------
  // URL 生成・ヘルパー
  // ---------------------------------------------------------------------------

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

  function getUserKindDisplayName(userKind) {
    if (!isValidUserKind(userKind)) return null;
    return USER_KINDS[userKind].displayName;
  }

  function getUserKindRoute(userKind) {
    if (!isValidUserKind(userKind)) return null;
    return USER_KINDS[userKind].route;
  }

  /**
   * 会員区分とユーザ識別番号、エリアIDから詳細画面URLを構築する。
   * 入力が不正または未知区分の場合は null (fail-closed)。
   */
  function buildUserDetailUrl(userKind, userUniqueCode, selectedAreaId) {
    if (!isValidUserKind(userKind) || !isValidUserUniqueCode(userUniqueCode) || !isValidAreaId(selectedAreaId)) {
      return null;
    }
    var route = USER_KINDS[userKind].route;
    return '/users/' + route + '/' + encodeURIComponent(userUniqueCode.trim()) +
      '?selected-area-id=' + encodeURIComponent(selectedAreaId.trim());
  }

  // ---------------------------------------------------------------------------
  // サマリ解決オーケストレーション
  // ---------------------------------------------------------------------------

  /**
   * ユーザ識別番号に対応する会員区分・ユーザーIDを照会する。
   * 7区分を決定的な順序で照会し、最初に見つかった時点で終了する。
   */
  function fetchSummary(userUniqueCode, options) {
    if (!isValidUserUniqueCode(userUniqueCode)) {
      return Promise.resolve(null);
    }
    userUniqueCode = userUniqueCode.trim();
    var selectedAreaId = getSelectedAreaId();
    if (!selectedAreaId) return Promise.resolve(null);

    var cached = getFromCache(userUniqueCode);
    if (cached) {
      if (cached.notFound) return Promise.resolve(null);
      return Promise.resolve({
        userKind: cached.userKind,
        userId: cached.userId
      });
    }

    // 1画面自動上限チェック
    var opts = options || {};
    if (!opts.force) {
      var requestedCount = Object.keys(pageRequestedCodes).length;
      if (!pageRequestedCodes[userUniqueCode]) {
        if (requestedCount >= getAutoFetchLimit()) {
          return Promise.resolve(null); // 上限到達時はスキップ
        }
        pageRequestedCodes[userUniqueCode] = true;
      }
    }

    // Dedupe
    if (inflightPromises[userUniqueCode]) {
      return inflightPromises[userUniqueCode];
    }

    var gen = currentGeneration;
    var abortCtrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    if (abortCtrl) {
      activeAbortControllers.push(abortCtrl);
    }

    var promise = new Promise(function (resolve) {
      var kindIndex = 0;

      function tryNextKind() {
        if (gen !== currentGeneration) {
          resolve(null);
          return;
        }

        if (kindIndex >= USER_KIND_ORDER.length) {
          // 7区分すべて試して一致なし
          putToCache(userUniqueCode, null);
          resolve(null);
          return;
        }

        var kind = USER_KIND_ORDER[kindIndex++];
        var signal = abortCtrl ? abortCtrl.signal : null;

        enqueueFetch(function () {
          if (gen !== currentGeneration || (signal && signal.aborted)) {
            return Promise.resolve(null);
          }
          return fetchUserByKind(userUniqueCode, kind, selectedAreaId, signal);
        }).then(function (result) {
          if (gen !== currentGeneration) {
            resolve(null);
            return;
          }
          if (result && result.userKind) {
            putToCache(userUniqueCode, result);
            resolve(result);
            return;
          }
          // 一致がなければ次の区分へ
          tryNextKind();
        }).catch(function () {
          return tryNextKind();
        });
      }

      tryNextKind();
    }).finally(function () {
      // 旧世代のfinallyが、同じコードで開始済みの新世代Promiseを消さない。
      if (inflightPromises[userUniqueCode] === promise) {
        delete inflightPromises[userUniqueCode];
      }
      if (abortCtrl) {
        var idx = activeAbortControllers.indexOf(abortCtrl);
        if (idx !== -1) activeAbortControllers.splice(idx, 1);
      }
    });

    inflightPromises[userUniqueCode] = promise;
    return promise;
  }

  /**
   * 画面内に現れた userUniqueCode 群を一括照会する
   * (ブックマークレット30件、拡張版1000件。同時実行は常に最大3件)。
   * コールバック callback(code, summaryOrNull) で結果を都度通知。
   */
  function requestSummaries(codes, callback, options) {
    if (!Array.isArray(codes) || codes.length === 0) return;

    var gen = currentGeneration;
    var opts = options || {};

    for (var i = 0; i < codes.length; i++) {
      var code = codes[i];
      if (!isValidUserUniqueCode(code)) continue;
      code = code.trim();

      var cached = getFromCache(code);
      if (cached) {
        if (typeof callback === 'function') {
          try {
            callback(code, cached.notFound ? null : { userKind: cached.userKind, userId: cached.userId });
          } catch (e) {}
        }
        continue;
      }

      (function (targetCode) {
        fetchSummary(targetCode, opts).then(function (result) {
          if (gen === currentGeneration && typeof callback === 'function') {
            try {
              callback(targetCode, result);
            } catch (e) {}
          }
        });
      })(code);
    }
  }

  // ---------------------------------------------------------------------------
  // 公開オブジェクト
  // ---------------------------------------------------------------------------

  D.userSummary = {
    apply: syncContext,
    USER_KINDS: USER_KINDS,
    USER_KIND_ORDER: USER_KIND_ORDER,
    isValidUserUniqueCode: isValidUserUniqueCode,
    isValidUserKind: isValidUserKind,
    isValidAreaId: isValidAreaId,
    getSelectedAreaId: getSelectedAreaId,
    getUserKindDisplayName: getUserKindDisplayName,
    getUserKindRoute: getUserKindRoute,
    buildUserDetailUrl: buildUserDetailUrl,
    fetchSummary: fetchSummary,
    requestSummaries: requestSummaries,
    clearCache: clearCache,
    resetGeneration: resetGeneration,
    syncContext: syncContext,
    resetForTest: resetForTest,
    _resetForTest: resetForTest,
    abortAllPending: abortAllPending,
    _getCacheMap: function () { loadSessionCache(); return cacheMap; },
    _getGeneration: function () { return currentGeneration; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);


/**
 * DBSEXT 金沢エリア法人請求書・利用明細書 一括PDF発行モジュール
 *
 * 目的:
 *   金沢エリア単独選択時のみ、既定様式（利用明細書・請求書(法人会員）.xlsx）に準拠した
 *   「御請求書（頭紙）」および「利用明細書」を全法人一括（および個別）で
 *   ブラウザ印刷・PDF保存可能にする。
 *
 * 契約（docs/06-module-contract.md §6）の遵守:
 *   - 金沢エリア単独選択時のみボタンを表示（fail-closed）。
 *   - POSTは '/api/invoices/corporate/charge-settlement/job' のみ（WRITE_EXCEPTIONS）。
 *   - 生成するDOM要素は自前UI分類に登録し、// dbsext:own-ui を付与。
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  var KANAZAWA_AREA_ID = 'AREA:01KY4M9DXHZ0KR4AY8KF4G16WX-t';
  var BUTTON_ATTR = 'data-dbsext-corporate-invoices-btn';
  var MODAL_ATTR = 'data-dbsext-corporate-invoices-modal';

  function log(msg, isError) {
    if (typeof console === 'undefined') return;
    var fn = isError ? console.error : console.log;
    fn('[DBSEXT:corporate-invoices] ' + msg);
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatMoney(num) {
    var n = Number(num) || 0;
    return n.toLocaleString('ja-JP');
  }

  /**
   * 金沢エリアが単独選択されているかを判定する（fail-closed）
   */
  function isKanazawaAreaSelected() {
    if (typeof location === 'undefined') return false;

    // 1. URLクエリ selected-area-id の確認
    var search = location.search || '';
    if (!search && location.href) {
      var qIdx = location.href.indexOf('?');
      if (qIdx !== -1) {
        search = location.href.substring(qIdx);
        var hIdx = search.indexOf('#');
        if (hIdx !== -1) search = search.substring(0, hIdx);
      }
    }
    var m = /[?&]selected-area-id=([^&#]*)/.exec(search);
    if (m) {
      var aid = decodeURIComponent(m[1] || '');
      if (aid === KANAZAWA_AREA_ID) return true;
      // 他のエリアIDが明示指定されている場合は即座に false
      return false;
    }

    // 2. 画面上のエリア選択表示から判定
    if (typeof document !== 'undefined') {
      var headerSelects = document.querySelectorAll('.el-select, select, header, .el-header');
      for (var i = 0; i < headerSelects.length; i++) {
        var txt = (headerSelects[i].textContent || '').trim();
        if (txt.indexOf('金沢') !== -1) {
          // 他のエリア（福井、小松、敦賀など）が同時に含まれていないか確認
          if (txt.indexOf('福井') === -1 && txt.indexOf('小松') === -1 && txt.indexOf('敦賀') === -1) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * 対象画面（料金精算または法人契約一覧）であるかを判定
   */
  function isEligiblePage() {
    if (typeof location === 'undefined') return false;
    var p = location.pathname || '';
    return p === '/charges-settlements' || p === '/charges-settlements/' ||
           p === '/corporate-clients' || p === '/corporate-clients/';
  }

  /**
   * サービス会社IDを取得する
   */
  function fetchServiceCompanyId() {
    return fetch('/api/service-companies')
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        var items = Array.isArray(data) ? data : (data && data.items ? data.items : []);
        if (items.length > 0 && items[0].serviceCompanyId) {
          return items[0].serviceCompanyId;
        }
        return '';
      })
      .catch(function () {
        return '';
      });
  }

  /**
   * 法人料金精算ジョブを発行し、完了まで待機して金沢法人のレコードを取得する
   */
  function fetchCorporateSettlementRecords(periodFrom, periodTo, serviceCompanyId) {
    var payload = {
      searchPeriodFrom: periodFrom,
      searchPeriodTo: periodTo,
      serviceCompanyId: serviceCompanyId || ''
    };

    return fetch('/api/invoices/corporate/charge-settlement/job', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (res) {
        if (!res.ok) throw new Error('精算ジョブ開始に失敗しました: HTTP ' + res.status);
        return res.json();
      })
      .then(function (jobInfo) {
        var jobId = jobInfo.jobId;
        if (!jobId) throw new Error('ジョブIDが取得できませんでした');

        // ポーリング待機（最大30秒）
        return new Promise(function (resolve, reject) {
          var attempts = 0;
          var maxAttempts = 15;

          function poll() {
            attempts++;
            fetch('/api/invoices/corporate/charge-settlement/job?jobId=' + encodeURIComponent(jobId))
              .then(function (r) { return r.json(); })
              .then(function (result) {
                var status = String(result.status || '').toUpperCase();
                if (status === 'COMPLETED') {
                  var dataList = result.dataList || [];
                  var allRecords = [];
                  for (var i = 0; i < dataList.length; i++) {
                    var recs = dataList[i].records || [];
                    for (var j = 0; j < recs.length; j++) {
                      var rec = recs[j];
                      // 金沢エリアのレコードのみ抽出
                      if (rec.areaName === '金沢' || rec.areaId === KANAZAWA_AREA_ID) {
                        allRecords.push(rec);
                      }
                    }
                  }
                  resolve(allRecords);
                } else if (status === 'FAILED') {
                  reject(new Error(result.error || 'ジョブが失敗しました'));
                } else if (attempts >= maxAttempts) {
                  reject(new Error('ジョブ待機がタイムアウトしました'));
                } else {
                  setTimeout(poll, 2000);
                }
              })
              .catch(reject);
          }

          setTimeout(poll, 1500);
        });
      });
  }

  /**
   * 特定法人の乗車履歴（明細）を取得する
   */
  function fetchCorporateHistories(corporateId, dateFromStr, dateToStr) {
    var url = '/api/corporate-clients/' + encodeURIComponent(corporateId) + '/histories?page=1&pageSize=500' +
      '&searchTargetDateFrom=' + encodeURIComponent(dateFromStr) +
      '&searchTargetDateTo=' + encodeURIComponent(dateToStr);

    return fetch(url)
      .then(function (res) {
        if (!res.ok) return [];
        return res.json();
      })
      .then(function (data) {
        return (data && data.items) ? data.items : [];
      })
      .catch(function () {
        return [];
      });
  }

  /**
   * 印刷プレビュー用HTMLを構築する
   */
  function buildPrintViewHtml(params) {
    var year = params.year;
    var month = params.month;
    var issueDate = params.issueDate;
    var corporations = params.corporations; // Array of { summary, histories }

    var lastDay = new Date(year, month, 0).getDate();
    var periodText = year + '.' + month + '.1～' + year + '.' + month + '.' + lastDay;
    var periodFullText = '（' + year + '年' + month + '月1日～' + year + '年' + month + '月' + lastDay + '日）';
    var itemTitle = '法人利用' + month + '月分';

    var html = [];
    html.push('<!DOCTYPE html>');
    html.push('<html lang="ja">');
    html.push('<head>');
    html.push('<meta charset="utf-8">');
    html.push('<title>シェアサイクルまちのり 法人請求書・利用明細書 (' + year + '年' + month + '月分)</title>');
    html.push('<style>');
    html.push('* { box-sizing: border-box; }');
    html.push('body { margin: 0; padding: 0; font-family: "Meiryo", "Hiragino Kaku Gothic ProN", sans-serif; color: #222; background: #eef2f5; }');

    // 画面専用ツールバー
    html.push('@media screen {');
    html.push('  .no-print-bar { position: sticky; top: 0; left: 0; right: 0; z-index: 10000; background: #1a3a60; color: #fff; padding: 10px 20px; display: flex; align-items: center; justify-content: space-between; box-shadow: 0 2px 8px rgba(0,0,0,0.25); }');
    html.push('  .no-print-bar .title { font-size: 15px; font-weight: bold; }');
    html.push('  .no-print-bar .controls { display: flex; gap: 12px; align-items: center; }');
    html.push('  .no-print-bar select { padding: 6px 12px; font-size: 14px; border-radius: 4px; border: none; }');
    html.push('  .no-print-bar button { padding: 6px 16px; font-size: 14px; font-weight: bold; border-radius: 4px; border: none; cursor: pointer; background: #0088cc; color: white; transition: 0.2s; }');
    html.push('  .no-print-bar button:hover { background: #006699; }');
    html.push('  .sheet-container { display: flex; flex-direction: column; align-items: center; padding: 20px 0; }');
    html.push('  .sheet { background: white; width: 210mm; min-height: 297mm; padding: 18mm 20mm; margin-bottom: 25px; box-shadow: 0 4px 12px rgba(0,0,0,0.15); }');
    html.push('}');

    // 印刷用CSS (A4厳密)
    html.push('@media print {');
    html.push('  @page { size: A4 portrait; margin: 15mm 15mm 15mm 15mm; }');
    html.push('  body { background: white; margin: 0; }');
    html.push('  .no-print-bar { display: none !important; }');
    html.push('  .sheet-container { display: block; padding: 0; }');
    html.push('  .sheet { width: 100%; min-height: auto; padding: 0; margin: 0; page-break-after: always; break-after: page; box-shadow: none; }');
    html.push('  .sheet:last-child { page-break-after: avoid; break-after: avoid; }');
    html.push('}');

    // 請求書・明細書共通スタイル
    html.push('.inv-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; }');
    html.push('.inv-title { font-size: 24px; font-weight: bold; letter-spacing: 4px; text-align: center; border-bottom: 2px solid #333; padding-bottom: 4px; margin-bottom: 25px; }');
    html.push('.inv-to { font-size: 18px; font-weight: bold; border-bottom: 1px solid #333; padding-bottom: 4px; display: inline-block; min-width: 250px; }');
    html.push('.inv-issuer { font-size: 12px; line-height: 1.6; text-align: right; }');
    html.push('.inv-total-box { margin: 20px 0; padding: 10px 15px; border: 2px solid #333; font-size: 16px; font-weight: bold; width: fit-content; min-width: 320px; }');
    html.push('.inv-total-val { font-size: 22px; font-weight: bold; margin-left: 15px; }');
    html.push('table.inv-table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 13px; }');
    html.push('table.inv-table th, table.inv-table td { border: 1px solid #444; padding: 8px 10px; }');
    html.push('table.inv-table th { background: #f2f2f2; text-align: center; font-weight: bold; }');
    html.push('table.inv-table td.num { text-align: right; }');
    html.push('table.inv-table td.center { text-align: center; }');
    html.push('.bank-box { margin-top: 25px; padding: 12px 15px; border: 1px solid #888; font-size: 12px; line-height: 1.8; background: #fafafa; }');
    html.push('.bank-title { font-weight: bold; text-decoration: underline; margin-bottom: 4px; }');
    html.push('.detail-title { font-size: 20px; font-weight: bold; text-align: center; border-bottom: 2px solid #333; padding-bottom: 4px; margin-bottom: 20px; }');
    html.push('.detail-meta { display: flex; justify-content: space-between; margin-bottom: 15px; font-size: 14px; }');
    html.push('table.detail-table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 10px; }');
    html.push('table.detail-table th, table.detail-table td { border: 1px solid #666; padding: 5px 6px; }');
    html.push('table.detail-table th { background: #f0f0f0; text-align: center; }');
    html.push('.note { margin-top: 10px; font-size: 11px; color: #555; }');
    html.push('</style>');
    html.push('</head>');
    html.push('<body>');

    // ツールバー
    html.push('<div class="no-print-bar">');
    html.push('  <div class="title">シェアサイクル まちのり 法人請求書・利用明細書 (' + year + '年' + month + '月分)</div>');
    html.push('  <div class="controls">');
    html.push('    <label>表示対象: <select id="corpFilter">');
    html.push('      <option value="all">全社一括 (' + corporations.length + '社)</option>');
    for (var i = 0; i < corporations.length; i++) {
      var cName = corporations[i].summary.corporateClientName;
      html.push('      <option value="corp-' + i + '">' + escapeHtml(cName) + '</option>');
    }
    html.push('    </select></label>');
    html.push('    <button onclick="window.print()">🖨️ 印刷 (PDF保存)</button>');
    html.push('  </div>');
    html.push('</div>');

    html.push('<div class="sheet-container" id="sheetsWrap">');

    for (var cIdx = 0; cIdx < corporations.length; cIdx++) {
      var corp = corporations[cIdx];
      var s = corp.summary;
      var hList = corp.histories;

      var basic = Number(s.basicCharge) || 0;
      var usage = Number(s.totalUsageAmount) || 0;
      var totalBilling = Number(s.totalBillingAmount) || (basic + usage);
      var users = Number(s.userCount) || 1;

      // 単価・数量・金額
      var basicUnit = users > 0 ? Math.round(basic / users) : basic;
      var subtotal = basic + usage;
      var tax = Math.floor(subtotal * 0.10);
      var grandTotal = subtotal + tax;

      // -------------------------------------------------------------
      // 1. 御請求書（頭紙シート）
      // -------------------------------------------------------------
      html.push('<div class="sheet corp-item" id="sheet-corp-' + cIdx + '-inv">');
      html.push('  <div class="inv-header">');
      html.push('    <div>');
      html.push('      <div class="inv-to">' + escapeHtml(s.corporateClientName) + ' 御中</div>');
      html.push('      <div style="font-size: 13px; margin-top: 15px;">下記の通りご請求申し上げます。</div>');
      html.push('      <div class="inv-total-box">');
      html.push('        請求金額<span class="inv-total-val">￥' + formatMoney(grandTotal) + '-</span> <span style="font-size: 12px; font-weight: normal;">(消費税込)</span>');
      html.push('      </div>');
      html.push('    </div>');
      html.push('    <div class="inv-issuer">');
      html.push('      <div>発行日：' + escapeHtml(issueDate) + '</div>');
      html.push('      <div style="margin-top: 8px;">〒920-0852</div>');
      html.push('      <div>石川県金沢市此花町 3-2 ライブ1ビル 1F</div>');
      html.push('      <div style="font-size: 14px; font-weight: bold; margin: 4px 0;">シェアサイクル まちのり事務局</div>');
      html.push('      <div>TEL: 076-255-1747　FAX: 076-255-1757</div>');
      html.push('      <div style="margin-top: 4px;">登録番号: <strong>T6-2200-0100-5078</strong></div>');
      html.push('      <div style="font-size: 11px; color: #555;">(株式会社日本海コンサルタント)</div>');
      html.push('    </div>');
      html.push('  </div>');

      html.push('  <div class="inv-title">御　請　求　書</div>');

      html.push('  <table class="inv-table">');
      html.push('    <thead>');
      html.push('      <tr>');
      html.push('        <th style="width: 45%;">品　　目</th>');
      html.push('        <th style="width: 15%;">数　量</th>');
      html.push('        <th style="width: 20%;">単　価</th>');
      html.push('        <th style="width: 20%;">金　額</th>');
      html.push('      </tr>');
      html.push('    </thead>');
      html.push('    <tbody>');
      html.push('      <tr>');
      html.push('        <td>' + escapeHtml(itemTitle) + '<br><span style="font-size: 11px; color: #555;">' + escapeHtml(periodFullText) + '</span></td>');
      html.push('        <td class="center">-</td>');
      html.push('        <td class="num">-</td>');
      html.push('        <td class="num">-</td>');
      html.push('      </tr>');
      html.push('      <tr>');
      html.push('        <td>■基本料金</td>');
      html.push('        <td class="center">' + users + '</td>');
      html.push('        <td class="num">' + formatMoney(basicUnit) + '</td>');
      html.push('        <td class="num">' + formatMoney(basic) + '</td>');
      html.push('      </tr>');
      html.push('      <tr>');
      html.push('        <td>■追加料金（利用料金合計）</td>');
      html.push('        <td class="center">1</td>');
      html.push('        <td class="num">' + formatMoney(usage) + '</td>');
      html.push('        <td class="num">' + formatMoney(usage) + '</td>');
      html.push('      </tr>');
      // 空行埋め
      for (var b = 0; b < 3; b++) {
        html.push('      <tr><td>&nbsp;</td><td></td><td></td><td></td></tr>');
      }
      html.push('      <tr>');
      html.push('        <td colspan="3" style="text-align: right; font-weight: bold;">小計</td>');
      html.push('        <td class="num" style="font-weight: bold;">' + formatMoney(subtotal) + '</td>');
      html.push('      </tr>');
      html.push('      <tr>');
      html.push('        <td colspan="3" style="text-align: right;">消費税 (10%)</td>');
      html.push('        <td class="num">' + formatMoney(tax) + '</td>');
      html.push('      </tr>');
      html.push('      <tr>');
      html.push('        <td colspan="3" style="text-align: right; font-weight: bold; background: #fafafa;">合計</td>');
      html.push('        <td class="num" style="font-weight: bold; font-size: 15px; background: #fafafa;">￥' + formatMoney(grandTotal) + '</td>');
      html.push('      </tr>');
      html.push('    </tbody>');
      html.push('  </table>');

      html.push('  <div class="bank-box">');
      html.push('    <div class="bank-title">お振込み先</div>');
      html.push('    <div><strong>北國銀行　増泉支店　普通預金：10073</strong></div>');
      html.push('    <div>口座名義：<strong>(株)日本海コンサルタント</strong></div>');
      html.push('    <div style="margin-top: 4px; font-size: 11px; color: #555;">※恐れ入りますが、振込手数料はお客様のご負担でお願い致します。</div>');
      html.push('  </div>');
      html.push('</div>'); // sheet

      // -------------------------------------------------------------
      // 2. 利用明細書シート
      // -------------------------------------------------------------
      html.push('<div class="sheet corp-item" id="sheet-corp-' + cIdx + '-det">');
      html.push('  <div class="detail-title">利　用　明　細　書</div>');
      html.push('  <div class="detail-meta">');
      html.push('    <div><strong style="font-size: 16px;">' + escapeHtml(s.corporateClientName) + ' 御中</strong></div>');
      html.push('    <div>発行日：' + escapeHtml(issueDate) + '</div>');
      html.push('  </div>');
      html.push('  <div style="font-size: 13px; margin-bottom: 10px;">利用期間：' + escapeHtml(periodText) + '</div>');

      html.push('  <table class="detail-table">');
      html.push('    <thead>');
      html.push('      <tr>');
      html.push('        <th style="width: 5%;">NO.</th>');
      html.push('        <th style="width: 25%;">ユーザーID</th>');
      html.push('        <th style="width: 12%;">利用種別</th>');
      html.push('        <th style="width: 10%;">料金(税抜)</th>');
      html.push('        <th style="width: 18%;">利用開始ポート</th>');
      html.push('        <th style="width: 15%;">利用開始日時</th>');
      html.push('        <th style="width: 18%;">返却終了ポート</th>');
      html.push('        <th style="width: 15%;">返却終了日時</th>');
      html.push('      </tr>');
      html.push('    </thead>');
      html.push('    <tbody>');

      var rowNum = 1;
      // 1行目: 基本料金
      html.push('      <tr>');
      html.push('        <td style="text-align: center;">' + rowNum++ + '</td>');
      html.push('        <td style="text-align: center;">-</td>');
      html.push('        <td>基本料金</td>');
      html.push('        <td style="text-align: right;">' + formatMoney(basic) + '</td>');
      html.push('        <td style="text-align: center;">-</td>');
      html.push('        <td style="text-align: center;">-</td>');
      html.push('        <td style="text-align: center;">-</td>');
      html.push('        <td style="text-align: center;">-</td>');
      html.push('      </tr>');

      // 2行目以降: 乗車明細
      for (var h = 0; h < hList.length; h++) {
        var rec = hList[h];
        var usageObj = rec.usage || {};
        var priceVal = Math.round((Number(rec.taxPrice) || 0) / 1.1); // 税抜

        // 基本料金等のレコードはスキップ（すでに出力済み）
        if (rec.itemName === '月額基本料' || !usageObj.rentalPortName) continue;

        html.push('      <tr>');
        html.push('        <td style="text-align: center;">' + rowNum++ + '</td>');
        html.push('        <td>' + escapeHtml(usageObj.userUniqueCode || '-') + '</td>');
        html.push('        <td>' + escapeHtml(rec.itemName || '利用料金') + '</td>');
        html.push('        <td style="text-align: right;">' + formatMoney(priceVal) + '</td>');
        html.push('        <td>' + escapeHtml(usageObj.rentalPortName || '-') + '</td>');
        html.push('        <td style="font-size: 10px;">' + escapeHtml(usageObj.rentalDateTime || '-') + '</td>');
        html.push('        <td>' + escapeHtml(usageObj.returnPortName || '-') + '</td>');
        html.push('        <td style="font-size: 10px;">' + escapeHtml(usageObj.returnDateTime || '-') + '</td>');
        html.push('      </tr>');
      }

      html.push('    </tbody>');
      html.push('  </table>');
      html.push('  <div class="note">※ 上記金額は、税抜きです。</div>');
      html.push('</div>'); // sheet
    }

    html.push('</div>'); // sheet-container

    // フィルタJS
    html.push('<' + 'script>');
    html.push('document.getElementById("corpFilter").addEventListener("change", function(e) {');
    html.push('  var val = e.target.value;');
    html.push('  var sheets = document.querySelectorAll(".sheet.corp-item");');
    html.push('  sheets.forEach(function(el) {');
    html.push('    if (val === "all") {');
    html.push('      el.style.display = "";');
    html.push('    } else {');
    html.push('      var isMatch = el.id.indexOf(val) !== -1;');
    html.push('      el.style.display = isMatch ? "" : "none";');
    html.push('    }');
    html.push('  });');
    html.push('});');
    html.push('</' + 'script>');

    html.push('</body>');
    html.push('</html>');

    return html.join('\n');
  }

  /**
   * 発行モーダルダイアログの表示
   */
  function showInvoiceModal() {
    if (typeof document === 'undefined') return;

    var existing = document.querySelector('[' + MODAL_ATTR + ']');
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing); // dbsext:own-ui
    }

    var now = new Date();
    // デフォルト前月
    var defYear = now.getFullYear();
    var defMonth = now.getMonth(); // 0-indexed: 先月
    if (defMonth === 0) {
      defMonth = 12;
      defYear--;
    }

    var overlay = document.createElement('div');
    overlay.setAttribute(MODAL_ATTR, '1');
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

    var modal = document.createElement('div');
    modal.style.backgroundColor = '#ffffff';
    modal.style.borderRadius = '8px';
    modal.style.padding = '24px';
    modal.style.maxWidth = '460px';
    modal.style.width = '90%';
    modal.style.boxShadow = '0 10px 25px rgba(0,0,0,0.2)';
    modal.style.fontFamily = 'sans-serif';
    modal.style.color = '#333';

    var title = document.createElement('h3');
    title.textContent = '金沢法人 請求書・利用明細書発行';
    title.style.margin = '0 0 16px 0';
    title.style.fontSize = '18px';
    title.style.color = (D.CONFIG && D.CONFIG.ACCENT) || '#0b5cab';
    modal.appendChild(title);

    var desc = document.createElement('div');
    desc.textContent = '対象年月を選択し、全社一括または個別の印刷プレビュー（PDF出力）を開きます。';
    desc.style.fontSize = '13px';
    desc.style.color = '#666';
    desc.style.marginBottom = '16px';
    modal.appendChild(desc);

    // フォーム
    var formGroup = document.createElement('div');
    formGroup.style.marginBottom = '16px';

    var lbl = document.createElement('label');
    lbl.textContent = '対象年月: ';
    lbl.style.fontSize = '14px';
    lbl.style.fontWeight = 'bold';
    lbl.style.marginRight = '8px';

    var selectYear = document.createElement('select');
    selectYear.style.padding = '6px';
    selectYear.style.marginRight = '6px';
    for (var y = now.getFullYear(); y >= now.getFullYear() - 2; y--) {
      var optY = document.createElement('option');
      optY.value = String(y);
      optY.textContent = y + '年';
      if (y === defYear) optY.selected = true;
      selectYear.appendChild(optY);
    }

    var selectMonth = document.createElement('select');
    selectMonth.style.padding = '6px';
    for (var m = 1; m <= 12; m++) {
      var optM = document.createElement('option');
      optM.value = String(m);
      optM.textContent = m + '月分';
      if (m === defMonth) optM.selected = true;
      selectMonth.appendChild(optM);
    }

    formGroup.appendChild(lbl);
    formGroup.appendChild(selectYear);
    formGroup.appendChild(selectMonth);
    modal.appendChild(formGroup);

    // ステータス表示
    var statusText = document.createElement('div');
    statusText.style.fontSize = '13px';
    statusText.style.color = '#d9534f';
    statusText.style.marginBottom = '16px';
    statusText.style.minHeight = '20px';
    modal.appendChild(statusText);

    // ボタン列
    var btnRow = document.createElement('div');
    btnRow.style.display = 'flex';
    btnRow.style.justifyContent = 'flex-end';
    btnRow.style.gap = '10px';

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = 'キャンセル';
    cancelBtn.style.padding = '8px 16px';
    cancelBtn.style.border = '1px solid #ccc';
    cancelBtn.style.borderRadius = '4px';
    cancelBtn.style.background = '#fff';
    cancelBtn.style.cursor = 'pointer';
    cancelBtn.addEventListener('click', function () {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay); // dbsext:own-ui
    });

    var submitBtn = document.createElement('button');
    submitBtn.type = 'button';
    submitBtn.textContent = 'プレビューを開く';
    submitBtn.style.padding = '8px 20px';
    submitBtn.style.border = 'none';
    submitBtn.style.borderRadius = '4px';
    submitBtn.style.background = (D.CONFIG && D.CONFIG.ACCENT) || '#0b5cab';
    submitBtn.style.color = '#fff';
    submitBtn.style.fontWeight = 'bold';
    submitBtn.style.cursor = 'pointer';

    submitBtn.addEventListener('click', function () {
      var yVal = parseInt(selectYear.value, 10);
      var mVal = parseInt(selectMonth.value, 10);
      var yStr = String(yVal);
      var mStr = String(mVal).padStart(2, '0');
      var lastDayVal = new Date(yVal, mVal, 0).getDate();

      var periodFrom = yStr + mStr + '01';
      var periodTo = yStr + mStr + String(lastDayVal).padStart(2, '0');
      var dateFromDash = yStr + '-' + mStr + '-01';
      var dateToDash = yStr + '-' + mStr + '-' + String(lastDayVal).padStart(2, '0');

      var issueDateStr = yStr + '年' + mVal + '月末日';

      submitBtn.disabled = true;
      submitBtn.style.opacity = '0.6';
      statusText.style.color = '#0b5cab';
      statusText.textContent = '金沢エリアの法人精算データを取得中…';

      fetchServiceCompanyId()
        .then(function (scId) {
          return fetchCorporateSettlementRecords(periodFrom, periodTo, scId);
        })
        .then(function (corps) {
          if (!corps || corps.length === 0) {
            throw new Error(yVal + '年' + mVal + '月の金沢エリア法人データが見つかりませんでした');
          }

          statusText.textContent = '各社の利用明細データを収集中 (0/' + corps.length + ')…';

          var results = [];
          var idx = 0;

          function nextCorp() {
            if (idx >= corps.length) {
              return Promise.resolve(results);
            }
            var cur = corps[idx++];
            statusText.textContent = '各社の利用明細データを収集中 (' + idx + '/' + corps.length + '): ' + cur.corporateClientName + '…';

            return fetchCorporateHistories(cur.corporateId, dateFromDash, dateToDash)
              .then(function (histories) {
                results.push({ summary: cur, histories: histories });
                return nextCorp();
              });
          }

          return nextCorp();
        })
        .then(function (corpDataList) {
          statusText.style.color = '#28a745';
          statusText.textContent = '完了！プレビューウィンドウを開いています…';

          var fullHtml = buildPrintViewHtml({
            year: yVal,
            month: mVal,
            issueDate: issueDateStr,
            corporations: corpDataList
          });

          var win = window.open('', '_blank');
          if (win) {
            win.document.open();
            win.document.write(fullHtml);
            win.document.close();
          } else {
            alert('ポップアップがブロックされました。ブラウザの設定で許可してください。');
          }

          setTimeout(function () {
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay); // dbsext:own-ui
          }, 1000);
        })
        .catch(function (err) {
          submitBtn.disabled = false;
          submitBtn.style.opacity = '1';
          statusText.style.color = '#d9534f';
          statusText.textContent = 'エラー: ' + ((err && err.message) ? err.message : String(err));
          log('請求書発行エラー: ' + err, true);
        });
    });

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(submitBtn);
    modal.appendChild(btnRow);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
  }

  /**
   * ボタンの配置処理
   */
  function mountInvoiceButton() {
    if (typeof document === 'undefined' || !document.body) return;

    // 金沢エリア単独選択時のみ表示
    if (!isKanazawaAreaSelected() || !isEligiblePage()) {
      // 対象外の場合はもし既存ボタンがあれば撤去
      var oldBtn = document.querySelector('[' + BUTTON_ATTR + ']');
      if (oldBtn && oldBtn.parentNode) {
        oldBtn.parentNode.removeChild(oldBtn); // dbsext:own-ui
      }
      return;
    }

    if (document.querySelector('[' + BUTTON_ATTR + ']')) {
      return; // すでに配置済み
    }

    // 操作ボタン領域または画面上部に配置
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute(BUTTON_ATTR, '1');
    btn.textContent = '📄 金沢法人 請求書・明細書発行';
    btn.style.margin = '8px 12px 8px 0';
    btn.style.padding = '8px 16px';
    btn.style.backgroundColor = '#0b5cab';
    btn.style.color = '#ffffff';
    btn.style.border = 'none';
    btn.style.borderRadius = '4px';
    btn.style.fontSize = '14px';
    btn.style.fontWeight = 'bold';
    btn.style.cursor = 'pointer';
    btn.style.boxShadow = '0 2px 4px rgba(0,0,0,0.15)';
    btn.style.transition = 'background-color 0.2s';

    btn.addEventListener('mouseenter', function () {
      btn.style.backgroundColor = '#083f75';
    });
    btn.addEventListener('mouseleave', function () {
      btn.style.backgroundColor = '#0b5cab';
    });
    btn.addEventListener('click', function () {
      showInvoiceModal();
    });

    // 挿入先を探す（料金精算フォーム、操作ボタン群、またはメインエリア上部）
    var targetContainer = document.querySelector('.operation-buttons, .el-form, .action-area, main, .main-content') || document.body;
    if (targetContainer.firstChild) {
      targetContainer.insertBefore(btn, targetContainer.firstChild);
    } else {
      targetContainer.appendChild(btn);
    }
  }

  D.corporateInvoices = {
    apply: function () {
      mountInvoiceButton();
    },
    // テスト・検証用
    _isKanazawaAreaSelected: isKanazawaAreaSelected,
    _buildPrintViewHtml: buildPrintViewHtml,
    _formatMoney: formatMoney,
    _KANAZAWA_AREA_ID: KANAZAWA_AREA_ID
  };

})(typeof globalThis !== 'undefined' ? globalThis : window);


/**
 * DBSEXT UI微調整モジュール
 *
 * - 戻るボタン: 隠さず、「1個前の画面へ戻る」挙動に差し替える
 * - 折りたたみセクション: 操作系は既定で閉じる（表示条件・検索条件等は開いたまま）
 * - ページサイズ: 車両情報 `/vehicles` で最大（1000）を自動選択する
 * - ユーザ識別番号リンク化 & 会員区分・ユーザーID表示 (/vehicles)
 * - ポート選択ドロップダウン並び替え (/vehicle-states)
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
  // 1. 戻るボタン — 非表示にする（W1-3）
  //
  // 決裁: 「1つ前の画面へ戻る」差し替えは、別タブで開く機能で間接的に
  // 対応済みのため削除でよい。戻るボタンは全画面から消す。
  //
  // テキストが「戻る」のボタンに属性を付け、CSSで非表示にする
  // ---------------------------------------------------------------------------

  /** テキストが「戻る」のボタンに印を付ける */
  function markBackButtons() {
    if (typeof document === 'undefined') return;
    var buttons = document.querySelectorAll('button, a, [role="button"]');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      if (btn.textContent && btn.textContent.trim() === '戻る') {
        btn.setAttribute('data-dbsext-hidden-back', '1');
      }
    }
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
  // 1c. ユーザ識別番号のリンク化 & 会員区分・ユーザーID列表示
  //
  // 車両情報 `/vehicles` の一覧で、「ユーザ識別番号」セルの直後に
  // 「会員区分」「ユーザーID」列を表示し、確定した summary に応じた
  // 正しいユーザ詳細画面を別タブで開くリンクを生成する。
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
  var pendingSummaryCodes = {};
  var summaryReapplyScheduled = false;

  function shouldDeferUserSummaryForFullVehicleLoad() {
    if (!D.platform || !(D.platform.kind === 'extension' || D.platform.isUserScript)) return false;
    if (typeof location === 'undefined' || !/^\/vehicles\/?$/.test(location.pathname || '')) return false;
    var match = /[?&]page-size=(\d+)/.exec(location.search || '');
    return !match || parseInt(match[1], 10) < 1000;
  }

  function scheduleUserSummaryReapply() {
    if (summaryReapplyScheduled || typeof setTimeout !== 'function') return;
    summaryReapplyScheduled = true;
    setTimeout(function () {
      summaryReapplyScheduled = false;
      linkifyUserIds();
    }, 0);
  }

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

  function neutralizeAnchor(anchor) {
    if (!anchor) return;
    if (!isUserLinkAnchor(anchor)) {
      anchor._dbsextOrigHref = { has: anchor.hasAttribute('href'), val: anchor.getAttribute('href') };
      anchor._dbsextOrigTarget = { has: anchor.hasAttribute('target'), val: anchor.getAttribute('target') };
      anchor._dbsextOrigRel = { has: anchor.hasAttribute('rel'), val: anchor.getAttribute('rel') };
      anchor._dbsextOrigTitle = { has: anchor.hasAttribute('title'), val: anchor.title || anchor.getAttribute('title') };
      trackedAnchors.push(anchor);
    }
    anchor.removeAttribute('href');
    anchor.removeAttribute('target');
    anchor.removeAttribute('rel');
    anchor.removeAttribute('title');
    anchor.title = '';
  }

  function ensureUserSummaryCols(headerTable, bodyTable, userColumnIndex) {
    if (!headerTable || !bodyTable) return;
    var headerGroups = headerTable.querySelectorAll('colgroup');
    var bodyGroups = bodyTable.querySelectorAll('colgroup');
    if (headerGroups.length !== 1 || bodyGroups.length !== 1) return;

    var headerGroup = headerGroups[0];
    var bodyGroup = bodyGroups[0];
    var headerCols = headerGroup.querySelectorAll('col');
    var bodyCols = bodyGroup.querySelectorAll('col');
    if (headerCols.length !== bodyCols.length || userColumnIndex >= headerCols.length) return;

    var marker = 'data-dbsext-user-summary-col';
    var firstHeader = headerCols[userColumnIndex + 1];
    var secondHeader = headerCols[userColumnIndex + 2];
    var alreadyInserted = firstHeader && secondHeader &&
      firstHeader.getAttribute(marker) === 'kind' && secondHeader.getAttribute(marker) === 'id';
    if (alreadyInserted) return;

    var firstBody = bodyCols[userColumnIndex + 1];
    var secondBody = bodyCols[userColumnIndex + 2];
    if (firstBody && secondBody && firstBody.getAttribute(marker) === 'kind' && secondBody.getAttribute(marker) === 'id') {
      return;
    }

    var kindHeaderCol = document.createElement('col');
    kindHeaderCol.setAttribute(marker, 'kind');
    kindHeaderCol.style.width = '140px';
    kindHeaderCol.style.minWidth = '140px';
    var idHeaderCol = document.createElement('col');
    idHeaderCol.setAttribute(marker, 'id');
    idHeaderCol.style.width = '140px';
    idHeaderCol.style.minWidth = '140px';
    var kindBodyCol = document.createElement('col');
    kindBodyCol.setAttribute(marker, 'kind');
    kindBodyCol.style.width = '140px';
    kindBodyCol.style.minWidth = '140px';
    var idBodyCol = document.createElement('col');
    idBodyCol.setAttribute(marker, 'id');
    idBodyCol.style.width = '140px';
    idBodyCol.style.minWidth = '140px';

    var headerRef = headerCols[userColumnIndex + 1] || null;
    var bodyRef = bodyCols[userColumnIndex + 1] || null;
    headerGroup.insertBefore(idHeaderCol, headerRef);
    headerGroup.insertBefore(kindHeaderCol, idHeaderCol);
    bodyGroup.insertBefore(idBodyCol, bodyRef);
    bodyGroup.insertBefore(kindBodyCol, idBodyCol);
  }

  function linkifyUserIds() {
    if (typeof document === 'undefined') return;

    var getAreaFn = (D.userSummary && typeof D.userSummary.getSelectedAreaId === 'function')
      ? D.userSummary.getSelectedAreaId
      : getSelectedAreaId;
    var areaId = getAreaFn();
    // エリア未選択でも追加2列は表示する。リンクだけを fail-closed にする。
    var isEligible = /^\/vehicles\/?$/.test(location.pathname);

    // 拡張版は vehicle-page-size.js が直後に本物のページ遷移で1000件表示へ開き直す。
    // 遷移前の初期件数へ照会を始めると無駄なPOSTと旧DOM向けcallbackが発生するため待つ。
    if (isEligible && shouldDeferUserSummaryForFullVehicleLoad()) return;

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

        // ヘッダに「会員区分」「ユーザーID」列を挿入（未挿入の場合）
        var userTh = ths[targetColIndex];
        if (userTh && userTh.parentElement) {
          var headerRow = userTh.parentElement;
          var nextHeaderSibling = userTh.nextSibling;
          var hasKindTh = nextHeaderSibling && nextHeaderSibling.hasAttribute && nextHeaderSibling.hasAttribute('data-dbsext-user-summary-th');
          if (!hasKindTh) {
            var kindTh = document.createElement('th');
            kindTh.setAttribute('data-dbsext-user-summary-th', '1');
            kindTh.textContent = '会員区分';
            if (userTh.className) kindTh.className = userTh.className;

            var idTh = document.createElement('th');
            idTh.setAttribute('data-dbsext-user-summary-th', '1');
            idTh.textContent = 'ユーザーID';
            if (userTh.className) idTh.className = userTh.className;

            headerRow.insertBefore(idTh, userTh.nextSibling);
            headerRow.insertBefore(kindTh, idTh);
          }
        }

        // ヘッダ/本文だけでなく、Element Plusのcolgroupにも2列を追加する。
        // これを欠くと後段の列幅制御とsort/filterが元の列位置を参照して崩れる。
        ensureUserSummaryCols(headerTable, bodyTable, targetColIndex);

        var rows = bodyTable.querySelectorAll('tbody tr');
        if (!rows || rows.length === 0) {
          rows = bodyTable.querySelectorAll('tr');
        }

        var codesToQuery = [];
        var cellBindingMap = []; // { cell, anchor, kindTd, idTd, code }

        for (var r = 0; r < rows.length; r++) {
          var row = rows[r];
          var tds = row.children;
          if (!tds || tds.length === 0) {
            tds = row.querySelectorAll('td');
          }
          if (targetColIndex >= tds.length) continue;
          var cell = tds[targetColIndex];

          // 行に「会員区分」「ユーザーID」セルを挿入（未挿入の場合）
          var kindTd = null;
          var idTd = null;
          var nextTdSibling = cell.nextSibling;
          if (nextTdSibling && nextTdSibling.hasAttribute && nextTdSibling.hasAttribute('data-dbsext-user-summary-td')) {
            kindTd = nextTdSibling;
            var afterKind = kindTd.nextSibling;
            if (afterKind && afterKind.hasAttribute && afterKind.hasAttribute('data-dbsext-user-summary-td')) {
              idTd = afterKind;
            }
          }

          if (!kindTd || !idTd) {
            kindTd = document.createElement('td');
            kindTd.setAttribute('data-dbsext-user-summary-td', '1');
            kindTd.textContent = '-';
            if (cell.className) kindTd.className = cell.className;

            idTd = document.createElement('td');
            idTd.setAttribute('data-dbsext-user-summary-td', '1');
            idTd.textContent = '-';
            if (cell.className) idTd.className = cell.className;

            row.insertBefore(idTd, cell.nextSibling);
            row.insertBefore(kindTd, idTd);
          }

          var existingLink = cell.querySelector('a');
          var rawText = existingLink ? existingLink.textContent : cell.textContent;
          var cellUserId = extractUserId(rawText);

          if (!cellUserId) {
            // 純正表示が '-' や空、無効値の場合は照会しない
            kindTd.textContent = '-';
            idTd.textContent = '-';
            if (existingLink && isUserLinkAnchor(existingLink)) {
              cleanupAnchor(existingLink);
            }
            if (isUserLinkCell(cell)) {
              cleanupCell(cell);
            }
            continue;
          }

          cellBindingMap.push({
            cell: cell,
            anchor: existingLink,
            kindTd: kindTd,
            idTd: idTd,
            code: cellUserId
          });

          // 純正の推測リンクもsummary確定までは無効化する。
          if (existingLink) {
            neutralizeAnchor(existingLink);
            if (activeAnchors.indexOf(existingLink) === -1) activeAnchors.push(existingLink);
          }

          if (codesToQuery.indexOf(cellUserId) === -1) {
            codesToQuery.push(cellUserId);
          }
        }

        // summary照会・反映関数
        var applySummaryToBinding = function (binding, summary) {
          var bCell = binding.cell;
          var bAnchor = binding.anchor;
          var bKindTd = binding.kindTd;
          var bIdTd = binding.idTd;
          var bCode = binding.code;

          var currentAnchor = bCell && bCell.querySelector ? bCell.querySelector('a') : null;
          var currentText = currentAnchor ? currentAnchor.textContent : (bCell ? bCell.textContent : '');
          if (!bCell || !(bCell.parentNode || bCell.parentElement) ||
              !bKindTd || !(bKindTd.parentNode || bKindTd.parentElement) ||
              !bIdTd || !(bIdTd.parentNode || bIdTd.parentElement) || extractUserId(currentText) !== bCode ||
              getAreaFn() !== areaId) {
            return false;
          }

          if (summary && summary.userKind) {
            var kindName = (D.userSummary && typeof D.userSummary.getUserKindDisplayName === 'function')
              ? D.userSummary.getUserKindDisplayName(summary.userKind)
              : summary.userKind;
            bKindTd.textContent = kindName || '-';
            bIdTd.textContent = summary.userId || '-';

            var buildUrlFn = (D.userSummary && typeof D.userSummary.buildUserDetailUrl === 'function')
              ? D.userSummary.buildUserDetailUrl
              : function (k, c, a) {
                  return '/users/' + String(k).toLowerCase().replace(/_/g, '-') + '/' + encodeURIComponent(c) + '?selected-area-id=' + encodeURIComponent(a);
                };
            var expectedHref = buildUrlFn(summary.userKind, bCode, areaId);

            if (expectedHref) {
              if (bAnchor) {
                if (isUserLinkCell(bCell)) {
                  cleanupCell(bCell);
                }
                bAnchor.setAttribute('href', expectedHref);
                bAnchor.setAttribute('target', '_blank');
                bAnchor.setAttribute('rel', 'noopener noreferrer');
                bAnchor.title = 'ユーザー詳細を別タブで開きます';
                if (activeAnchors.indexOf(bAnchor) === -1) {
                  activeAnchors.push(bAnchor);
                }
              } else {
                if (!isUserLinkCell(bCell)) {
                  bCell._dbsextOrigRole = { has: bCell.hasAttribute('role'), val: bCell.getAttribute('role') };
                  bCell._dbsextOrigTabindex = { has: bCell.hasAttribute('tabindex'), val: bCell.getAttribute('tabindex') };
                  bCell._dbsextOrigTitle = { has: bCell.hasAttribute('title'), val: bCell.title || bCell.getAttribute('title') };
                  var hasStyle = !!bCell.style;
                  var getPropVal = function (prop) {
                    if (!hasStyle) return '';
                    if (typeof bCell.style.getPropertyValue === 'function') {
                      return bCell.style.getPropertyValue(prop);
                    }
                    var camel = prop === 'text-decoration' ? 'textDecoration' : prop;
                    return bCell.style[camel] || '';
                  };
                  var getPropPrio = function (prop) {
                    if (!hasStyle) return '';
                    if (typeof bCell.style.getPropertyPriority === 'function') {
                      return bCell.style.getPropertyPriority(prop) || '';
                    }
                    return '';
                  };

                  var curVal = getPropVal('cursor');
                  var curPrio = getPropPrio('cursor');
                  bCell._dbsextOrigCursor = {
                    set: curVal !== '' || curPrio !== '',
                    val: curVal,
                    prio: curPrio
                  };

                  var decVal = getPropVal('text-decoration');
                  var decPrio = getPropPrio('text-decoration');
                  bCell._dbsextOrigTextDec = {
                    set: decVal !== '' || decPrio !== '',
                    val: decVal,
                    prio: decPrio
                  };
                  if (trackedCells.indexOf(bCell) === -1) {
                    trackedCells.push(bCell);
                  }
                }
                bCell._dbsextHref = expectedHref;
                bCell.setAttribute('role', 'link');
                bCell.setAttribute('tabindex', '0');
                bCell.title = 'ユーザー詳細を別タブで開きます';
                bCell.style.cursor = 'pointer';
                bCell.style.textDecoration = 'underline';

                if (!bCell._dbsextUserLinkBound) {
                  bCell._dbsextUserLinkBound = true;
                  if (typeof bCell.addEventListener === 'function') {
                    bCell.addEventListener('click', handleUserLinkClick);
                    bCell.addEventListener('keydown', handleUserLinkKeydown);
                  }
                }
                if (activeCells.indexOf(bCell) === -1) {
                  activeCells.push(bCell);
                }
              }
            }
          } else {
            // summary が確定していない（読み込み中）または notFound / 失敗
            bKindTd.textContent = '-';
            bIdTd.textContent = '-';
            // 推測リンクは出さない（確定前・失敗時はリンク解除）
            if (bAnchor) {
              neutralizeAnchor(bAnchor);
              if (activeAnchors.indexOf(bAnchor) === -1) activeAnchors.push(bAnchor);
            }
            if (isUserLinkCell(bCell)) {
              cleanupCell(bCell);
            }
          }
          return true;
        };

        if (D.userSummary && typeof D.userSummary.requestSummaries === 'function') {
          // 初期状態では推測リンクを出さない（一度未確定として処理）
          for (var b = 0; b < cellBindingMap.length; b++) {
            var binding = cellBindingMap[b];
            // キャッシュがあるか同期確認
            var cached = (typeof D.userSummary._getCacheMap === 'function') ? D.userSummary._getCacheMap()[binding.code] : null;
            if (cached && cached.userKind && (!cached.expiry || Date.now() <= cached.expiry)) {
              applySummaryToBinding(binding, cached);
            } else {
              applySummaryToBinding(binding, null);
            }
          }

          var codesToStart = [];
          for (var c = 0; c < codesToQuery.length; c++) {
            if (!pendingSummaryCodes[codesToQuery[c]]) {
              pendingSummaryCodes[codesToQuery[c]] = true;
              codesToStart.push(codesToQuery[c]);
            }
          }

          D.userSummary.requestSummaries(codesToStart, function (resolvedCode, summary) {
            delete pendingSummaryCodes[resolvedCode];
            var applied = false;
            for (var k = 0; k < cellBindingMap.length; k++) {
              if (cellBindingMap[k].code === resolvedCode) {
                applied = applySummaryToBinding(cellBindingMap[k], summary) || applied;
              }
            }
            // 1000件再描画等でcallbackが旧DOMを参照していた場合は、キャッシュから現DOMへ再適用する。
            if (!applied) scheduleUserSummaryReapply();
          });
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

  // ---------------------------------------------------------------------------
  // W1-2: 表示条件パネルの1段組化と検索実行後の自動畳み
  // ---------------------------------------------------------------------------

  var beforeNavigationReadyHooked = false;
  var finalizingNavigation = false;
  var lastNavigationFinalize = null;

  /** 対象パネルに属性を付ける（W1-2） */
  function markConditionPanels() {
    if (typeof document === 'undefined') return;
    var items = document.querySelectorAll('.el-collapse-item');
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var header = item.querySelector('.el-collapse-item__header');
      if (!header) continue;
      var headerText = (header.textContent || '').trim();
      var isCondition = headerText.indexOf('表示条件') !== -1 ||
        headerText.indexOf('検索条件') !== -1 ||
        headerText.indexOf('絞り込み条件') !== -1;
      if (isCondition) {
        var content = item.querySelector('.el-collapse-item__content');
        if (content) {
          content.setAttribute('data-dbsext-cond-panel', '1');
        }
      }
    }
  }

  var searchButtonHooked = false;

  /** 検索ボタンをクリックして、自動畳み印を消す（W1-2） */
  function hookSearchButtons() {
    if (typeof document === 'undefined' || searchButtonHooked) return;
    searchButtonHooked = true;
    document.addEventListener('click', function (event) {
      var btn = event.target;
      if (!btn || (btn.tagName !== 'BUTTON' && btn.getAttribute('role') !== 'button')) return;
      // 検索ボタンか判定：テキストが「検索」で、クラスに el-button--primary を含む
      if ((btn.textContent || '').trim() !== '検索') return;
      if (!btn.classList || !btn.classList.contains('el-button--primary')) return;
      // 検索ボタンなので、次の行出現で1回だけ畳むよう印を消す
      var panels = document.querySelectorAll('[data-dbsext-cond-panel]');
      for (var i = 0; i < panels.length; i++) {
        panels[i].removeAttribute('data-dbsext-autocollapsed');
      }
    }, true);
  }

  /** 表示条件パネルの結果チェック：行が出たら1回だけ畳む（W1-2） */
  function shouldAutoCollapseCondition(condPanel) {
    if (!condPanel) return false;
    // 既に自動で畳んだパネルは、ユーザーが手動で開き直した状態を尊重する。
    if (condPanel.hasAttribute('data-dbsext-autocollapsed')) return false;
    // 車両情報はURL変更後にもDOM差し替えが続くため、通常の再適用では畳まない。
    // 読み込みマスクを外す直前の最終イベントでのみ、完成済みDOMを畳む。
    if (typeof location !== 'undefined' && /^\/vehicles\/?$/.test(location.pathname || '')) {
      var pageSizeMatch = /[?&]page-size=(\d+)/.exec(location.search || '');
      if (!finalizingNavigation || !pageSizeMatch || parseInt(pageSizeMatch[1], 10) < 1000) return false;
      if (!document.querySelector('table.el-table__body tbody tr')) return false;
      condPanel.setAttribute('data-dbsext-autocollapsed', '1');
      return true;
    }
    // 結果表を探す：同じ親（内容エリア）の直後の表
    var parent = condPanel.parentElement;
    if (!parent) return false;
    // 「表示条件」の下には通常「結果表」が来る
    var bodyTable = parent.querySelector('table.el-table__body');
    if (!bodyTable) return false;
    var rows = bodyTable.querySelectorAll('tbody tr');
    if (!rows || rows.length === 0) return false;
    // 行が出た！1回だけ畳む
    condPanel.setAttribute('data-dbsext-autocollapsed', '1');
    return true;
  }

  function shouldKeepSectionOpen(headerText) {
    if (!headerText) return false;
    var isCondition = headerText.indexOf('表示条件') !== -1 ||
      headerText.indexOf('検索条件') !== -1 ||
      headerText.indexOf('絞り込み条件') !== -1;
    // 車種情報は初期状態でエリア選択→検索が必要。先に閉じると
    // vehicle-kinds.js のプルダウン操作と競合するため、結果が出るまで開いておく。
    if (typeof location !== 'undefined' && /^\/areas\/vehicle-kinds\/?$/.test(location.pathname || '') &&
        isCondition && !document.querySelector('table.el-table__body tbody tr')) {
      return true;
    }
    if (!isUsersPage()) return false;
    return isCondition;
  }

  function collapseSections() {
    if (typeof document === 'undefined') return;

    var items = document.querySelectorAll('.el-collapse-item');
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var header = item.querySelector('.el-collapse-item__header');
      if (!header) continue;
      var initialized = header.hasAttribute('data-dbsext-collapsed');
      if (!initialized) header.setAttribute('data-dbsext-collapsed', '1');

      var headerText = (header.textContent || '').trim();
      var keepOpen = shouldKeepSectionOpen(headerText);
      var shouldCollapseNow = !initialized && !keepOpen;
      if (!initialized && keepOpen) {
        // 一時的な状態なのでDOM属性を増やさず、同一ノード上のプロパティで保持する。
        header._dbsextCollapsePending = true;
      } else if (initialized && !keepOpen && header._dbsextCollapsePending) {
        // 自動選択などの前提処理を待っていたパネルは、準備完了時を「初回」とみなす。
        shouldCollapseNow = true;
      }

      // 開閉できることが見て分かるようにヒントを足す
      if (!initialized && !header.querySelector('[data-dbsext-collapse-hint]')) {
        var hint = document.createElement('span');
        hint.setAttribute('data-dbsext-collapse-hint', '1');
        hint.textContent = '▼';
        hint.style.cssText = 'font-size:11px;opacity:0.5;margin-left:2px';
        header.appendChild(hint);
      }

      // W1-2: 条件パネルで、行が出たら1回だけ畳む
      var content = item.querySelector('.el-collapse-item__content');
      if (content && content.hasAttribute('data-dbsext-cond-panel')) {
        if (shouldAutoCollapseCondition(content)) {
          // 行が出た！1回だけ畳む
          keepOpen = false;
          shouldCollapseNow = true;
        } else {
          // まだ行が出ていない、または一度畳んだ後に手動で開かれた。
          keepOpen = true;
          shouldCollapseNow = false;
        }
      }

      // 初回（条件パネルは検索結果が初めて出た時）だけ、ネイティブのクリックで閉じる。
      // 再適用ではユーザーが手動で開いた状態を上書きしない。
      // クラスを直接操作すると Element Plus の内部状態とずれるため不可。
      if (shouldCollapseNow && !keepOpen && item.classList.contains('is-active')) {
        header._dbsextCollapsePending = false;
        header.click();
      }
    }
  }

  function hookBeforeNavigationReady() {
    if (typeof document === 'undefined' || beforeNavigationReadyHooked) return;
    beforeNavigationReadyHooked = true;
    document.addEventListener('dbsext:before-navigation-ready', function () {
      finalizingNavigation = true;
      try {
        markConditionPanels();
        collapseSections();
        var panels = document.querySelectorAll('[data-dbsext-cond-panel]');
        var marked = 0;
        for (var i = 0; i < panels.length; i++) {
          if (panels[i].hasAttribute('data-dbsext-autocollapsed')) marked++;
        }
        lastNavigationFinalize = {
          pathname: typeof location !== 'undefined' ? location.pathname : '',
          search: typeof location !== 'undefined' ? location.search : '',
          rowReady: !!document.querySelector('table.el-table__body tbody tr'),
          conditionPanels: panels.length,
          autoCollapsedPanels: marked
        };
      } finally {
        finalizingNavigation = false;
      }
    });
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
  // W1-4: ポート選択ドロップダウン並び替え (REMARK-M1-TELEPORT)
  // ---------------------------------------------------------------------------

  function findSelectByLabel(labelText) {
    if (typeof document === 'undefined') return null;

    // 1. ラベル要素から探索（W0実測構造: label.contents と .el-form-item が兄弟関係）
    var labels = document.querySelectorAll('label, .el-form-item__label');
    for (var l = 0; l < labels.length; l++) {
      var lbl = labels[l];
      var text = (lbl.textContent || '').trim();
      if (text === labelText || (text.indexOf(labelText) !== -1 && text.indexOf('車両状態') === -1 && text.indexOf('ブロック') === -1)) {
        // 親枠（.flex / 行コンテナなど）から .el-select を探す
        var parent = lbl.parentElement;
        if (parent) {
          var sel = parent.querySelector('.el-select');
          if (sel) return sel;
          // 親の親（2段組枠など）からも探す
          var grand = parent.parentElement;
          if (grand) {
            var grandSel = grand.querySelector('.el-select');
            if (grandSel) return grandSel;
          }
        }
        // 次の兄弟要素から探す
        var sibling = lbl.nextElementSibling;
        while (sibling) {
          if (sibling.classList && sibling.classList.contains('el-select')) return sibling;
          var sibSel = sibling.querySelector ? sibling.querySelector('.el-select') : null;
          if (sibSel) return sibSel;
          sibling = sibling.nextElementSibling;
        }
      }
    }

    // 2. フォールバック: .el-select から探索（従来の .el-form-item 内に label がある場合）
    var selects = document.querySelectorAll('.el-select');
    for (var i = 0; i < selects.length; i++) {
      var select = selects[i];
      var formItem = (typeof select.closest === 'function') ? select.closest('.el-form-item') : null;
      if (!formItem && select.parentElement) {
        var p = select.parentElement;
        while (p) {
          if (p.classList && p.classList.contains('el-form-item')) {
            formItem = p;
            break;
          }
          p = p.parentElement;
        }
      }
      if (formItem) {
        var formLabel = formItem.querySelector('.el-form-item__label');
        if (formLabel && (formLabel.textContent || '').indexOf(labelText) !== -1) {
          return select;
        }
      }
    }
    return null;
  }

  function isDropdownVisible(el) {
    if (!el) return false;
    var curr = el;
    while (curr) {
      if (curr.nodeType && curr.nodeType !== 1) break;
      if (curr.getAttribute && curr.getAttribute('aria-hidden') === 'true') return false;
      if (curr.hasAttribute && curr.hasAttribute('hidden')) return false;
      if (curr.classList) {
        if (curr.classList.contains('is-hidden') ||
            curr.classList.contains('hidden') ||
            curr.classList.contains('el-zoom-in-top-leave-active') ||
            curr.classList.contains('el-zoom-in-top-leave-to') ||
            curr.classList.contains('v-leave-active') ||
            curr.classList.contains('v-leave-to')) {
          return false;
        }
      }
      if (curr.style) {
        if (curr.style.display === 'none') return false;
        if (curr.style.visibility === 'hidden' || curr.style.visibility === 'collapse') return false;
      }
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        try {
          var cs = window.getComputedStyle(curr);
          if (cs) {
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') {
              return false;
            }
          }
        } catch (e) {}
      }
      if (typeof curr.checkVisibility === 'function') {
        try {
          if (!curr.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) {
            return false;
          }
        } catch (e) {}
      }
      if (curr.tagName === 'BODY' || curr.tagName === 'HTML') {
        break;
      }
      curr = curr.parentElement || curr.parentNode;
    }
    return true;
  }

  function isPortDropdown(node) {
    if (!node) return false;
    var dropdown = (node.classList && node.classList.contains('el-select-dropdown')) ? node : (node.querySelector ? node.querySelector('.el-select-dropdown') : null);
    if (!dropdown) return false;

    // 非表示・stale なドロップダウンを堅牢に除外 (REMARK-M1-TELEPORT: computed/visibility/class/ancestors)
    if (!isDropdownVisible(dropdown)) return false;

    if (isSizeDropdown(dropdown)) return false;

    var items = dropdown.querySelectorAll('.el-select-dropdown__item');
    if (items.length === 0) return false;

    // docs/17 実測値（ブロック・車両状態22件）に基づく既知の非ポート選択肢を除外 (REMARK-M1-TELEPORT: fail-closed)
    // 「金沢市役所」のように、ポート名がブロック名の一部を含む場合がある。
    // ブロック固有の候補だけは完全一致で除外し、状態候補は従来どおり部分一致で除外する。
    var forbiddenExact = ['金沢市', '野々市', 'ブロック'];
    var forbiddenWords = [
      'AT未装着', '利用可能', '利用中', '一時駐輪', '予約中', '配置中', '回収中',
      '要回収', 'ポート外乗り捨て', 'メンテナンス', 'AT異常', '故障中', '充電中',
      '返却不可', '更新しない', '車両状態', '状態'
    ];
    for (var i = 0; i < items.length; i++) {
      var txt = (items[i].textContent || '').trim();
      if (forbiddenExact.indexOf(txt) !== -1) return false;
      for (var f = 0; f < forbiddenWords.length; f++) {
        if (txt.indexOf(forbiddenWords[f]) !== -1) {
          return false;
        }
      }
    }
    return true;
  }

  function findPortDropdown(select) {
    if (!select) return null;
    var wrapper = select.querySelector('.el-select__wrapper');
    var combobox = select.querySelector('[aria-controls]');
    var input = select.querySelector('input');
    var selectId = (select.getAttribute && select.getAttribute('id')) || select.id;
    var inputId = input && ((input.getAttribute && input.getAttribute('id')) || input.id);

    var candidates = [
      dropdownById(wrapper && wrapper.getAttribute('aria-describedby')),
      dropdownById(combobox && combobox.getAttribute('aria-controls')),
      dropdownById(select.getAttribute && select.getAttribute('aria-controls')),
      dropdownById(select.getAttribute && select.getAttribute('aria-owns')),
      dropdownById(input && input.getAttribute && input.getAttribute('aria-controls')),
      dropdownById(input && input.getAttribute && input.getAttribute('aria-describedby')),
      dropdownById(input && input.getAttribute && input.getAttribute('aria-owns'))
    ];
    for (var i = 0; i < candidates.length; i++) {
      var cand = candidates[i];
      if (cand && isPortDropdown(cand)) {
        return (cand.classList && cand.classList.contains('el-select-dropdown')) ? cand : (cand.querySelector ? cand.querySelector('.el-select-dropdown') : cand);
      }
    }

    // aria-labelledby による明示的な紐付けを探索
    if (selectId || inputId) {
      var dropdowns = document.querySelectorAll('.el-select-dropdown');
      for (var d = 0; d < dropdowns.length; d++) {
        var dd = dropdowns[d];
        var parent = dd.parentElement || dd;
        var labelledBy = (dd.getAttribute && dd.getAttribute('aria-labelledby')) || (parent.getAttribute && parent.getAttribute('aria-labelledby'));
        if (labelledBy && (labelledBy === selectId || labelledBy === inputId)) {
          if (isPortDropdown(dd)) {
            return dd;
          }
        }
      }
    }

    // 安定した紐付け（aria/id）が存在しない無関係なグローバルドロップダウンは決して拾わない (REMARK-M1-TELEPORT: fail-closed)
    return null;
  }

  function sortPortDropdownItems(select, optionalDropdown) {
    var portSortKey = (D.tableKit && D.tableKit.portSortKey) || (D.tableTools && D.tableTools.portSortKey);
    if (!portSortKey) return false;

    var dropdown = optionalDropdown || findPortDropdown(select);
    if (!dropdown) return false;

    var list = dropdown.querySelector('.el-select-dropdown__list');
    if (!list) return false;

    var items = list.querySelectorAll('.el-select-dropdown__item');
    if (items.length === 0) return false;

    var signatureParts = [];
    for (var s = 0; s < items.length; s++) {
      signatureParts.push((items[s].textContent || '').trim());
    }
    var signature = signatureParts.join('\u0001');

    // 各項目のテキストと sort key を集める
    var itemData = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var text = (item.textContent || '').trim();
      var key = portSortKey(text);
      itemData.push({ element: item, text: text, key: key });
    }

    // sort key で並べ替える（タプル比較）
    itemData.sort(function (a, b) {
      if (a.key[0] !== b.key[0]) return a.key[0] - b.key[0];
      if (a.key[1] !== b.key[1]) return a.key[1].localeCompare(b.key[1]);
      if (a.key[2] !== b.key[2]) return a.key[2] - b.key[2];
      return a.key[3].localeCompare(b.key[3], undefined, { numeric: true, sensitivity: 'base' });
    });

    // style.order で視覚順を変える（DOM 移動なし）
    for (var j = 0; j < itemData.length; j++) {
      itemData[j].element.style.order = j;
    }

    // リストコンテナに display:flex を設定（order を有効にするため）
    if (list.style) {
      list.style.display = 'flex';
      list.style.flexDirection = 'column';
      // テーマ側で display に !important が付く版でも order を有効にする。
      if (typeof list.style.setProperty === 'function') {
        list.style.setProperty('display', 'flex', 'important');
        list.style.setProperty('flex-direction', 'column', 'important');
      }
    }
    for (var k = 0; k < itemData.length; k++) {
      if (itemData[k].element.style && typeof itemData[k].element.style.setProperty === 'function') {
        itemData[k].element.style.setProperty('order', String(k), 'important');
      }
    }

    list._dbsextPortSorted = true;
    list._dbsextPortSortSignature = signature;
    return true;
  }

  var portSortObserver = null;
  var portSortSelect = null;
  var portSortPendingUntil = 0;
  var portSortGeneration = 0;

  function setPortSortSelect(select) {
    if (portSortSelect !== select) {
      portSortGeneration++;
      // select の世代が変わったら、旧画面の open intent を必ず破棄する。
      portSortPendingUntil = 0;
    }
    portSortSelect = select;
  }

  function isNodeConnectedToDocument(node) {
    if (!node || typeof document === 'undefined') return false;
    if (typeof node.isConnected === 'boolean') return node.isConnected;
    if (document.documentElement && typeof document.documentElement.contains === 'function') {
      return document.documentElement.contains(node);
    }
    var current = node;
    while (current) {
      if (current === document.body) return true;
      current = current.parentElement || current.parentNode;
    }
    return false;
  }

  function isPortSortContextValid(select, route, generation) {
    if (typeof location !== 'undefined' && location.pathname !== route) return false;
    if (select !== portSortSelect || generation !== portSortGeneration) return false;
    return isNodeConnectedToDocument(select);
  }

  function isNodeWithin(node, ancestor) {
    var current = node;
    while (current) {
      if (current === ancestor) return true;
      current = current.parentElement || current.parentNode;
    }
    return false;
  }

  function hasPortDropdownSelector(node) {
    if (!node) return false;
    if (node.classList && (node.classList.contains('el-select-dropdown') ||
        node.classList.contains('el-select-dropdown__list') ||
        node.classList.contains('el-select-dropdown__item'))) return true;
    return typeof node.querySelector === 'function' && !!node.querySelector(
      '.el-select-dropdown, .el-select-dropdown__list, .el-select-dropdown__item'
    );
  }

  function portDropdownMutationRelevant(records, dropdown) {
    for (var r = 0; r < records.length; r++) {
      var record = records[r];
      if (isNodeWithin(record.target, dropdown)) return true;
      var added = record.addedNodes || [];
      for (var a = 0; a < added.length; a++) {
        if (isNodeWithin(added[a], dropdown) || hasPortDropdownSelector(added[a])) return true;
      }
    }
    return false;
  }

  function portDropdownNeedsSort(dropdown) {
    if (!dropdown || typeof dropdown.querySelector !== 'function') return false;
    var list = dropdown.querySelector('.el-select-dropdown__list');
    if (!list) return false;
    var items = list.querySelectorAll('.el-select-dropdown__item');
    if (!items || items.length === 0) return false;
    var parts = [];
    for (var i = 0; i < items.length; i++) {
      parts.push((items[i].textContent || '').trim());
    }
    return list._dbsextPortSortSignature !== parts.join('\u0001');
  }

  function ensurePortSortObserver() {
    if (portSortObserver || typeof MutationObserver !== 'function' || typeof document === 'undefined' || !document.body) return;
    portSortObserver = new MutationObserver(function (records) {
      var route = (typeof location !== 'undefined') ? (location.pathname || '') : '';
      if (!/^\/vehicle-states\/?$/.test(route)) {
        portSortPendingUntil = 0;
        return;
      }
      var select = portSortSelect;
      if (!isNodeConnectedToDocument(select)) {
        // 旧画面の open intent を新画面へ引き継がない。新しい select は
        // core の再適用から hookPortSelect() が明示的に登録する。
        setPortSortSelect(null);
        portSortPendingUntil = 0;
        return;
      }
      if (!select) return;
      var generation = portSortGeneration;
      // Teleport の popper/list は click 後に遅れて childList として現れる。
      // 「開いている」または直近の open intent 中だけ試し、他画面には触れない。
      var pending = Date.now() < portSortPendingUntil;
      if (!pending && !isExpanded(select)) return;
      if (!isPortSortContextValid(select, route, generation)) return;
      var dropdown = findPortDropdown(select);
      if (!dropdown || !portDropdownMutationRelevant(records || [], dropdown)) return;
      if (!portDropdownNeedsSort(dropdown)) return;
      if (sortPortDropdownItems(select, dropdown)) {
        portSortPendingUntil = Math.max(portSortPendingUntil, Date.now() + 250);
      }
    });
    portSortObserver.observe(document.body, { childList: true, subtree: true });
  }

  function schedulePortSort(select) {
    var attempts = 0;
    var maxAttempts = 80; // 25ms × 80 = 約2秒。遅いTeleport/160件描画にも追随する。
    setPortSortSelect(select);
    var route = (typeof location !== 'undefined') ? (location.pathname || '') : '';
    var generation = portSortGeneration;
    portSortPendingUntil = Date.now() + 2000;
    ensurePortSortObserver();
    function retry() {
      if (!isPortSortContextValid(select, route, generation)) return;
      attempts++;
      var done = sortPortDropdownItems(select);
      if (!done && attempts < maxAttempts) {
        setTimeout(retry, 25);
      }
    }
    retry();
  }

  function hookPortSelect() {
    if (typeof document === 'undefined') return;
    if (typeof location !== 'undefined' && !/^\/vehicle-states\/?$/.test(location.pathname || '')) return;

    var select = findSelectByLabel('ポート');
    if (!select) return; // DOM未生成時はフック済みにしない（次回再試行）

    var trigger = selectTrigger(select);
    if (!trigger) return;

    // 要素プロパティで冪等化（core ATTR_KIND を汚さない）
    setPortSortSelect(select);
    ensurePortSortObserver();
    if (trigger._dbsextPortHooked) return;
    trigger._dbsextPortHooked = true;

    trigger.addEventListener('click', function () {
      schedulePortSort(select);
    }, true);

    // 既に開いている場合はソート実行
    if (isExpanded(select)) {
      sortPortDropdownItems(select);
    }
  }

  // ---------------------------------------------------------------------------
  // 法人契約情報利用履歴: 500件表示最適化 & 全件ファイル出力（TSV）救済フック
  // ---------------------------------------------------------------------------

  var CORPORATE_HISTORIES_HEADERS = [
    '乗車ID ※乗車識別番号',
    'ユーザ識別番号',
    '料金設定名',
    '請求項目',
    '請求金額',
    '料金合計',
    '貸出料金',
    '延長料金',
    '基本・オプション料金',
    '請求項目追加',
    '更新日時',
    '更新理由',
    '月次決済/都度決済',
    '貸出-ポート名',
    '貸出-日時',
    '返却-ポート名',
    '返却-日時',
    '車両識別番号',
    '返却種別',
    '利用エリア名'
  ];

  function isCorporateClientHistoriesPage() {
    return typeof location !== 'undefined' && /^\/corporate-clients\/[^/]+\/histories(\/|$)/.test(location.pathname || '');
  }

  function getQueryParam(search, key) {
    if (!search) return '';
    var re = new RegExp('[?&]' + key + '=([^&#]*)');
    var m = search.match(re);
    return m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : '';
  }

  function setQueryParam(search, key, value) {
    var s = search ? search.replace(/^\?/, '') : '';
    var parts = s ? s.split('&') : [];
    var replaced = false;
    for (var i = 0; i < parts.length; i++) {
      var pair = parts[i].split('=');
      if (pair[0] === key) {
        parts[i] = key + '=' + encodeURIComponent(value);
        replaced = true;
        break;
      }
    }
    if (!replaced) {
      parts.push(key + '=' + encodeURIComponent(value));
    }
    return '?' + parts.join('&');
  }

  function formatTsvCell(val) {
    if (val == null) return '';
    var s = String(val).replace(/\r\n|\r/g, '\n');
    var hasSpecial = s.indexOf('\t') !== -1 || s.indexOf('\n') !== -1 || s.indexOf('"') !== -1;
    if (s.indexOf('"') !== -1) {
      s = s.replace(/"/g, '""');
    }
    return hasSpecial ? '"' + s + '"' : s;
  }

  function buildTsvText(headers, rows) {
    var lines = [];
    if (headers && headers.length) {
      lines.push(headers.map(formatTsvCell).join('\t'));
    }
    for (var i = 0; i < rows.length; i++) {
      lines.push(rows[i].map(formatTsvCell).join('\t'));
    }
    return '\ufeff' + lines.join('\r\n') + '\r\n';
  }

  function formatTimestamp(d) {
    var date = d || new Date();
    var y = date.getFullYear();
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var day = String(date.getDate()).padStart(2, '0');
    var h = String(date.getHours()).padStart(2, '0');
    var min = String(date.getMinutes()).padStart(2, '0');
    var s = String(date.getSeconds()).padStart(2, '0');
    return '' + y + m + day + h + min + s;
  }

  function triggerDownload(filename, content, mimeType) {
    if (typeof document === 'undefined') return;
    var BlobCtor = typeof Blob !== 'undefined' ? Blob : (typeof window !== 'undefined' && window.Blob ? window.Blob : (typeof globalThis !== 'undefined' && globalThis.Blob ? globalThis.Blob : null));
    var UrlCtor = typeof URL !== 'undefined' ? URL : (typeof window !== 'undefined' && window.URL ? window.URL : (typeof globalThis !== 'undefined' && globalThis.URL ? globalThis.URL : null));
    if (!BlobCtor || !UrlCtor || typeof UrlCtor.createObjectURL !== 'function') {
      return;
    }
    var blob = new BlobCtor([content], { type: mimeType || 'text/tab-separated-values;charset=utf-8' });
    var url = UrlCtor.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) a.parentNode.removeChild(a); // dbsext:own-ui
      if (typeof UrlCtor.revokeObjectURL === 'function') UrlCtor.revokeObjectURL(url);
    }, 100);
  }

  function exportCorporateHistoriesFromDom() {
    if (typeof document === 'undefined') return false;

    // 1. カレンダー以外の el-table__body を探す
    var tables = document.querySelectorAll('table.el-table__body');
    var targetTable = null;
    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];
      if (t.classList.contains('el-date-table')) continue;
      if (t.closest && t.closest('.el-picker-panel, .el-date-picker')) continue;
      targetTable = t;
      break;
    }
    if (!targetTable) {
      targetTable = document.querySelector('.el-table table.el-table__body') ||
                    document.querySelector('.el-table__body-wrapper table');
    }
    if (!targetTable) {
      log('法人契約利用履歴: テーブルが見つかりません', true);
      return false;
    }

    var rows = [];
    var trs = targetTable.querySelectorAll('tr');
    for (var j = 0; j < trs.length; j++) {
      var tr = trs[j];
      if (tr.classList && (tr.classList.contains('el-table__empty-block') || tr.classList.contains('el-table__empty-text'))) {
        continue;
      }
      var tds = tr.querySelectorAll('td');
      if (!tds || tds.length === 0) continue;

      var row = [];
      for (var k = 0; k < tds.length; k++) {
        var cellText = (tds[k].textContent || '').trim();
        row.push(cellText);
      }
      if (row.length > 0) {
        rows.push(row);
      }
    }

    if (rows.length === 0) {
      log('法人契約利用履歴: 行が0件です', true);
      return false;
    }

    var filename = 'CorporateContractInfoUsingHistoryList_' + formatTimestamp() + '.tsv';
    var tsv = buildTsvText(CORPORATE_HISTORIES_HEADERS, rows);
    triggerDownload(filename, tsv, 'text/tab-separated-values;charset=utf-8');
    return true;
  }

  function ensureCorporateHistoriesPageSize() {
    if (typeof location === 'undefined') return;
    if (!isCorporateClientHistoriesPage()) return;
    var search = location.search || '';
    if (search.indexOf('searchTargetDateFrom=') !== -1 && search.indexOf('searchTargetDateTo=') !== -1) {
      var ps = getQueryParam(search, 'page-size');
      if (!ps || parseInt(ps, 10) < 500) {
        var newSearch = setQueryParam(search, 'page-size', '500');
        if (location.search !== newSearch) {
          if (typeof location.replace === 'function') {
            location.replace(location.pathname + newSearch);
          } else {
            location.search = newSearch;
          }
        }
      }
    }
  }

  function hookCorporateHistoriesExport() {
    if (!isCorporateClientHistoriesPage()) return;
    if (typeof document === 'undefined') return;

    // 1. page-size=500 の自動調整
    ensureCorporateHistoriesPageSize();

    // 2. 「検索」ボタンに page-size=500 注入フック
    var buttons = document.querySelectorAll('button, a, [role="button"]');
    for (var i = 0; i < buttons.length; i++) {
      var btn = buttons[i];
      var text = (btn.textContent || '').trim();

      // 検索ボタン: クリック時に page-size=500 を確実に維持
      if (text === '検索' && !btn._dbsextSearchHooked) {
        btn._dbsextSearchHooked = true;
        btn.addEventListener('click', function () {
          setTimeout(function () {
            ensureCorporateHistoriesPageSize();
          }, 300);
        }, false);
      }

      // ファイル出力ボタン: キャプチャフェーズで先回りし、画面の表（500件全件）からTSVを同期出力
      if (text.indexOf('ファイル出力') !== -1 && !btn._dbsextExportHooked) {
        btn._dbsextExportHooked = true;
        btn.addEventListener('click', function (e) {
          if (e) {
            if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
            if (typeof e.preventDefault === 'function') e.preventDefault();
          }
          exportCorporateHistoriesFromDom();
        }, true);
      }
    }
  }


    D.uiTweaks = {
    apply: function () {
      if (typeof document === 'undefined' || !document.body) return;
      markBackButtons();
      linkifyUserIds();
      openRowLinksInNewTab();
      hookBeforeNavigationReady();
      markConditionPanels();
      collapseSections();
      maximizePageSize();
      hookSearchButtons();
      hookPortSelect();  // W1-4
      hookCorporateHistoriesExport();
    },

    // 検証用（テストから状態を覗くため）
    _state: function () {
      return {
        sizeDoneFor: sizeDoneFor,
        lastNavigationFinalize: lastNavigationFinalize,
        exportCorporateHistoriesFromDom: exportCorporateHistoriesFromDom,
        buildTsvText: buildTsvText,
        formatTsvCell: formatTsvCell,
        ensureCorporateHistoriesPageSize: ensureCorporateHistoriesPageSize,
        CORPORATE_HISTORIES_HEADERS: CORPORATE_HISTORIES_HEADERS
      };
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

  function signalNavigationLoading() {
    if (D.netStatus && typeof D.netStatus.beginNavigation === 'function') {
      D.netStatus.beginNavigation();
      return;
    }
    try { document.dispatchEvent(new CustomEvent('dbsext:navigation-loading')); } catch (e) {}
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
      signalNavigationLoading();
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


/** 配信機能を掲載状態4種・500件表示で初期表示する（拡張版限定）。 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;
  var DESIRED_PAGE_SIZE = 500;
  var DESIRED_STATUSES = ['掲載準備中', '未掲載', '掲載中', '掲載準備完了'];
  var triedThisLoad = false;

  function isTargetPage() {
    return typeof location !== 'undefined' && /^\/notifications\/messages\/?$/.test(location.pathname);
  }

  function isExtensionPlatform() {
    return !!(D.platform && (D.platform.kind === 'extension' || D.platform.isUserScript));
  }

  function currentValues(params, key) {
    return params.getAll(key).slice().sort();
  }

  function hasDefaults() {
    if (typeof location === 'undefined') return true;
    var params = new URLSearchParams(location.search);
    var expected = DESIRED_STATUSES.slice().sort();
    return params.get('page') === '1' && params.get('page-size') === String(DESIRED_PAGE_SIZE) &&
      JSON.stringify(currentValues(params, 'publish-statuses')) === JSON.stringify(expected);
  }

  function buildTargetUrl() {
    var params = new URLSearchParams(location.search);
    params.delete('publish-statuses');
    for (var i = 0; i < DESIRED_STATUSES.length; i++) params.append('publish-statuses', DESIRED_STATUSES[i]);
    params.set('page', '1');
    params.set('page-size', String(DESIRED_PAGE_SIZE));
    return location.pathname + '?' + params.toString();
  }

  function signalNavigationLoading() {
    if (D.netStatus && typeof D.netStatus.beginNavigation === 'function') {
      D.netStatus.beginNavigation();
      return;
    }
    try { document.dispatchEvent(new CustomEvent('dbsext:navigation-loading')); } catch (e) {}
  }

  D.notificationDefaults = {
    DESIRED_PAGE_SIZE: DESIRED_PAGE_SIZE,
    DESIRED_STATUSES: DESIRED_STATUSES.slice(),
    apply: function () {
      if (!isExtensionPlatform() || !isTargetPage() || triedThisLoad || hasDefaults()) return;
      triedThisLoad = true;
      var target = buildTargetUrl();
      if (D.core && typeof D.core.log === 'function') D.core.log('配信機能を既定条件で開き直します: ' + target);
      signalNavigationLoading();
      location.replace(target);
    },
    _reset: function () { triedThisLoad = false; },
    _hasDefaults: hasDefaults,
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
      var channelLabel = (typeof DBSEXT_CHANNEL !== 'undefined' && DBSEXT_CHANNEL.label)
        ? ' [' + DBSEXT_CHANNEL.label + ']'
        : '';
      if (remoteStatusLabel) {
        row1.textContent = '拡張適用中' + channelLabel + ' ' + remoteStatusLabel;
      } else {
        row1.textContent = '拡張適用中' + channelLabel + ' ' + version + kindText;
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

  function isOriginalViewActive() {
    if (!D.originalView) return false;
    if (typeof D.originalView.isActive === 'function' && D.originalView.isActive()) return true;
    if (typeof D.originalView._isActive === 'function' && D.originalView._isActive()) return true;
    return false;
  }

  function closePanel() {
    if (currentPanelHost && currentPanelHost.parentNode) {
      currentPanelHost.parentNode.removeChild(currentPanelHost); // dbsext:own-ui
    }
    currentPanelHost = null;
  }

  function createLauncherPanel() {
    closePanel();
    if (isOriginalViewActive()) return;

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

  function isBatteryLauncherPresent() {
    if (typeof document === 'undefined') return false;
    if (typeof document.querySelector === 'function') {
      if (document.querySelector('[' + LAUNCHER_ATTR + '="1"]')) return true;
    }
    if (typeof document.querySelectorAll === 'function') {
      var all = document.querySelectorAll('[' + LAUNCHER_ATTR + ']');
      for (var i = 0; i < all.length; i++) {
        if (all[i].getAttribute(LAUNCHER_ATTR) === '1') return true;
      }
    }
    return false;
  }

  function cleanupBatteryLauncherUI() {
    closePanel();
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    var all = document.querySelectorAll('[' + LAUNCHER_ATTR + ']');
    for (var i = 0; i < all.length; i++) {
      if (all[i].getAttribute(LAUNCHER_ATTR) === '1' && all[i].parentNode) {
        all[i].parentNode.removeChild(all[i]); // dbsext:own-ui
      }
    }
  }

  function insertLauncherIfAbsent() {
    if (typeof document === 'undefined' || !document.body) return;
    if (isOriginalViewActive()) return;
    if (isBatteryLauncherPresent()) return; // 既出（冪等）
    document.body.appendChild(buildLauncher());
  }

  // ===========================================================================
  // 車両情報履歴: 既存地図の拡大表示（W4）
  // ===========================================================================

  var VEHICLE_HISTORIES_PATH_RE = /^\/vehicles\/VHCL:[A-Za-z0-9:_-]{1,256}\/histories\/?$/;
  var HISTORY_EXPECTED_HEADERS = [
    'イベント発生日時',
    '位置情報',
    'イベント',
    'ユーザ識別番号',
    'ポート名',
    '駐輪台数制限',
    '駐輪台数',
    '返却ポート予約数',
    '駐輪台数上限'
  ];
  var COORD_PATTERN_RE = /^N?\s*-?\d+(?:\.\d+)?\s*,\s*-?\d+(?:\.\d+)?$/;

  var HISTORY_MAP_BTN_ATTR = 'data-dbsext-launcher';
  var HISTORY_MAP_BTN_VALUE = 'history-map';
  var HISTORY_MAP_CLOSE_PANEL_ATTR = 'data-dbsext-launcher-panel';
  var HISTORY_MAP_CLOSE_PANEL_VALUE = 'history-map-close';
  var HISTORY_MAP_EXPANDED_CLASS = 'dbsext-history-map-expanded';

  var activeHistoryMapElement = null;
  var activeHistoryMapCloseHost = null;
  var historyKeydownHandler = null;

  function isVehicleHistoriesPath() {
    if (typeof location === 'undefined' || !location.pathname) return false;
    return VEHICLE_HISTORIES_PATH_RE.test(location.pathname);
  }

  function getTableHeaders(table) {
    if (!table) return [];
    var headerRow = table.querySelector('table.el-table__header tr, thead tr, tr');
    if (!headerRow) return [];
    var ths = headerRow.querySelectorAll('th');
    if (!ths || ths.length === 0) return [];
    var headers = [];
    for (var i = 0; i < ths.length; i++) {
      var th = ths[i];
      var text = th.getAttribute('data-dbsext-orig-title') || th.textContent || '';
      headers.push(text.trim());
    }
    return headers;
  }

  function findMatchingHistoryTable() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null;
    var tables = document.querySelectorAll('.el-table, table');
    for (var i = 0; i < tables.length; i++) {
      var table = tables[i];
      var headers = getTableHeaders(table);
      if (headers.length === HISTORY_EXPECTED_HEADERS.length) {
        var match = true;
        for (var j = 0; j < HISTORY_EXPECTED_HEADERS.length; j++) {
          if (headers[j] !== HISTORY_EXPECTED_HEADERS[j]) {
            match = false;
            break;
          }
        }
        if (match) return table;
      }
    }
    return null;
  }

  function hasValidCoordinateLink(table) {
    if (!table || typeof table.querySelectorAll !== 'function') return false;
    // 位置情報列は2列目（index 1）
    var rows = table.querySelectorAll('table.el-table__body tbody tr, tbody tr');
    if (!rows || rows.length === 0) return false;

    var validCoordFound = false;
    for (var i = 0; i < rows.length; i++) {
      var cells = rows[i].querySelectorAll('td');
      if (cells.length > 1) {
        var posCell = cells[1];
        var link = posCell.querySelector('a[href]');
        if (link) {
          var text = (link.textContent || '').trim();
          if (COORD_PATTERN_RE.test(text)) {
            validCoordFound = true;
            break;
          }
        }
      }
    }
    return validCoordFound;
  }

  function isElementVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (typeof document !== 'undefined' && document.body) {
      if (typeof document.body.contains === 'function' && !document.body.contains(el)) {
        return false;
      }
    }
    if (el.style && (el.style.display === 'none' || el.style.visibility === 'hidden' || el.style.opacity === '0')) return false;

    if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
      try {
        var style = window.getComputedStyle(el);
        if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }
      } catch (e) {
        return false;
      }
    }

    // geometry checks: getBoundingClientRect must return finite, positive size, intersecting viewport
    if (typeof el.getBoundingClientRect === 'function') {
      try {
        var rect = el.getBoundingClientRect();
        if (!rect) return false;
        if (!isFinite(rect.width) || !isFinite(rect.height) || !isFinite(rect.top) || !isFinite(rect.bottom) || !isFinite(rect.left) || !isFinite(rect.right)) {
          return false;
        }
        if (rect.width <= 0 || rect.height <= 0) {
          return false;
        }
        var vpWidth = (typeof window !== 'undefined' && window.innerWidth) || (typeof document !== 'undefined' && document.documentElement && document.documentElement.clientWidth) || 0;
        var vpHeight = (typeof window !== 'undefined' && window.innerHeight) || (typeof document !== 'undefined' && document.documentElement && document.documentElement.clientHeight) || 0;
        if (vpWidth > 0 && vpHeight > 0) {
          if (rect.bottom <= 0 || rect.top >= vpHeight || rect.right <= 0 || rect.left >= vpWidth) {
            return false;
          }
        }
      } catch (e) {
        return false;
      }
    }
    if (typeof el.offsetWidth === 'number' && typeof el.offsetHeight === 'number') {
      if (!isFinite(el.offsetWidth) || !isFinite(el.offsetHeight) || el.offsetWidth <= 0 || el.offsetHeight <= 0) {
        return false;
      }
    }

    // 祖先の可視性チェック
    var parent = el.parentElement || el.parentNode;
    while (parent && parent.nodeType === 1) {
      if (parent.style && (parent.style.display === 'none' || parent.style.visibility === 'hidden' || parent.style.opacity === '0')) {
        return false;
      }
      if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
        try {
          var pStyle = window.getComputedStyle(parent);
          if (pStyle && (pStyle.display === 'none' || pStyle.visibility === 'hidden' || pStyle.opacity === '0')) {
            return false;
          }
        } catch (e) {
          return false;
        }
      }
      parent = parent.parentElement || parent.parentNode;
    }

    return true;
  }

  function isExplicitMapElement(el) {
    if (!el || el.nodeType !== 1) return false;
    var className = el.className || '';
    if (typeof className !== 'string') {
      className = el.getAttribute ? (el.getAttribute('class') || '') : '';
    }
    if (/\b(?:leaflet-container|map-container|history-map|gis-map|portal-map)\b/i.test(className)) {
      return true;
    }
    if (el.hasAttribute) {
      if (el.hasAttribute('data-map')) return true;
      var role = el.getAttribute('data-role') || el.getAttribute('role');
      if (role && role.toLowerCase() === 'map') return true;
    }
    return false;
  }

  function findUniqueVisibleMapCandidate() {
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return null;

    var rawCandidates = [];

    // 1. 明確な地図コンテナ（.leaflet-container 等）
    var containers = document.querySelectorAll('.leaflet-container, .map-container, .history-map, .gis-map, .portal-map, [data-map], [data-role="map"]');
    for (var l = 0; l < containers.length; l++) {
      var c = containers[l];
      if (isExplicitMapElement(c) && rawCandidates.indexOf(c) === -1) {
        rawCandidates.push(c);
      }
    }

    // 2. canvas を含むコンテナ:
    //    明確な地図祖先コンテナ（または自身）が存在する場合のみ候補とする（generic canvas parent は禁止）
    var canvases = document.querySelectorAll('canvas');
    for (var ci = 0; ci < canvases.length; ci++) {
      var canvas = canvases[ci];
      var mapAncestor = null;
      if (canvas.closest) {
        mapAncestor = canvas.closest('.leaflet-container, .map-container, .history-map, .gis-map, .portal-map, [data-map], [data-role="map"]');
      } else {
        var cur = canvas.parentElement;
        while (cur && cur.nodeType === 1) {
          if (isExplicitMapElement(cur)) {
            mapAncestor = cur;
            break;
          }
          cur = cur.parentElement || cur.parentNode;
        }
      }

      if (mapAncestor && isExplicitMapElement(mapAncestor)) {
        if (rawCandidates.indexOf(mapAncestor) === -1) {
          rawCandidates.push(mapAncestor);
        }
      } else if (isExplicitMapElement(canvas)) {
        if (rawCandidates.indexOf(canvas) === -1) {
          rawCandidates.push(canvas);
        }
      }
    }

    // 3. iframe 地図:
    //    明確な地図祖先コンテナが存在するか、iframe 自身が地図コンテナである場合のみ候補とする（generic iframe parent は禁止）
    var iframes = document.querySelectorAll('iframe');
    for (var f = 0; f < iframes.length; f++) {
      var iframe = iframes[f];
      var ifrMapAncestor = null;
      if (iframe.closest) {
        ifrMapAncestor = iframe.closest('.leaflet-container, .map-container, .history-map, .gis-map, .portal-map, [data-map], [data-role="map"]');
      } else {
        var pCur = iframe.parentElement;
        while (pCur && pCur.nodeType === 1) {
          if (isExplicitMapElement(pCur)) {
            ifrMapAncestor = pCur;
            break;
          }
          pCur = pCur.parentElement || pCur.parentNode;
        }
      }

      if (ifrMapAncestor && isExplicitMapElement(ifrMapAncestor)) {
        if (rawCandidates.indexOf(ifrMapAncestor) === -1) {
          rawCandidates.push(ifrMapAncestor);
        }
      } else if (isExplicitMapElement(iframe)) {
        if (rawCandidates.indexOf(iframe) === -1) {
          rawCandidates.push(iframe);
        }
      }
    }

    // 重複除去と可視・正寸法・自前UI除外チェック
    var visibleCandidates = [];
    for (var i = 0; i < rawCandidates.length; i++) {
      var item = rawCandidates[i];
      if (item.closest && (item.closest('[' + HISTORY_MAP_CLOSE_PANEL_ATTR + ']') || item.closest('[' + HISTORY_MAP_BTN_ATTR + ']') || item.closest('[' + LAUNCHER_ATTR + ']'))) {
        continue;
      }
      if (isElementVisible(item)) {
        if (visibleCandidates.indexOf(item) === -1) {
          visibleCandidates.push(item);
        }
      }
    }

    if (visibleCandidates.length === 1) {
      return visibleCandidates[0];
    }
    return null;
  }

  function collapseHistoryMap() {
    if (activeHistoryMapElement) {
      if (activeHistoryMapElement.__dbsextExpandedByLauncher) {
        if (activeHistoryMapElement.classList && typeof activeHistoryMapElement.classList.remove === 'function') {
          activeHistoryMapElement.classList.remove(HISTORY_MAP_EXPANDED_CLASS);
        }
        delete activeHistoryMapElement.__dbsextExpandedByLauncher;
      }
      activeHistoryMapElement = null;
    }

    if (activeHistoryMapCloseHost && activeHistoryMapCloseHost.parentNode) {
      activeHistoryMapCloseHost.parentNode.removeChild(activeHistoryMapCloseHost); // dbsext:own-ui
    }
    activeHistoryMapCloseHost = null;

    if (historyKeydownHandler && typeof window !== 'undefined') {
      window.removeEventListener('keydown', historyKeydownHandler);
      historyKeydownHandler = null;
    }

    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try {
        window.dispatchEvent(new Event('resize'));
      } catch (e) {}
    }
  }

  function cleanupHistoryMapUI() {
    collapseHistoryMap();
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    var existingBtns = document.querySelectorAll('[' + HISTORY_MAP_BTN_ATTR + '="' + HISTORY_MAP_BTN_VALUE + '"]');
    for (var i = 0; i < existingBtns.length; i++) {
      if (existingBtns[i].parentNode) {
        existingBtns[i].parentNode.removeChild(existingBtns[i]); // dbsext:own-ui
      }
    }
  }

  function expandHistoryMap(mapElement) {
    if (isOriginalViewActive()) {
      collapseHistoryMap();
      return;
    }

    // Action-time fail-closed 再検証:
    // 1. exact path チェック
    if (!isVehicleHistoriesPath()) {
      cleanupHistoryMapUI();
      return;
    }

    // 2. 履歴テーブル & 座標リンクチェック
    var table = findMatchingHistoryTable();
    if (!table || !hasValidCoordinateLink(table)) {
      cleanupHistoryMapUI();
      return;
    }

    // 3. 現在の有効な地図候補の再検証（非表示化・寸法変更・DOM切断・複数化を検出）
    var validCandidate = findUniqueVisibleMapCandidate();
    if (!validCandidate) {
      cleanupHistoryMapUI();
      return;
    }

    // 4. mapElement が渡された場合、現在の有効候補と一致しているかチェック
    if (mapElement && mapElement !== validCandidate) {
      cleanupHistoryMapUI();
      return;
    }

    var targetElement = validCandidate;
    collapseHistoryMap();

    activeHistoryMapElement = targetElement;
    var hadClass = false;
    if (targetElement.classList && typeof targetElement.classList.contains === 'function') {
      hadClass = targetElement.classList.contains(HISTORY_MAP_EXPANDED_CLASS);
    }
    if (!hadClass) {
      targetElement.__dbsextExpandedByLauncher = true;
      if (targetElement.classList && typeof targetElement.classList.add === 'function') {
        targetElement.classList.add(HISTORY_MAP_EXPANDED_CLASS);
      }
    } else {
      delete targetElement.__dbsextExpandedByLauncher;
    }

    // 閉じる自前ボタン作成
    var closeHost = document.createElement('div');
    closeHost.setAttribute(HISTORY_MAP_CLOSE_PANEL_ATTR, HISTORY_MAP_CLOSE_PANEL_VALUE);

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'dbsext-history-map-close-btn';
    closeBtn.textContent = '✕ 閉じる (Esc)';
    closeBtn.setAttribute('aria-label', '地図を閉じる');
    closeBtn.addEventListener('click', function () {
      collapseHistoryMap();
    });

    closeHost.appendChild(closeBtn);
    activeHistoryMapCloseHost = closeHost;
    document.body.appendChild(closeHost);

    // Escape キー監視
    historyKeydownHandler = function (e) {
      if (e.key === 'Escape' || e.keyCode === 27) {
        collapseHistoryMap();
      }
    };
    if (typeof window !== 'undefined') {
      window.addEventListener('keydown', historyKeydownHandler);
    }

    // リサイズイベント発火（LeafletやCanvasの再描画用）
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try {
        window.dispatchEvent(new Event('resize'));
      } catch (e) {}
    }
  }

  function applyVehicleHistoryMap() {
    if (typeof document === 'undefined' || !document.body) return;

    if (isOriginalViewActive()) {
      cleanupHistoryMapUI();
      return;
    }

    // 1. exact path チェック
    if (!isVehicleHistoriesPath()) {
      cleanupHistoryMapUI();
      return;
    }

    // 2. 9列header完全一致チェック
    var table = findMatchingHistoryTable();
    if (!table) {
      cleanupHistoryMapUI();
      return;
    }

    // 3. 位置情報セルの座標linkチェック
    if (!hasValidCoordinateLink(table)) {
      cleanupHistoryMapUI();
      return;
    }

    // 4. visible map候補が一意であることのチェック
    var mapCandidate = findUniqueVisibleMapCandidate();
    if (!mapCandidate) {
      cleanupHistoryMapUI();
      return;
    }

    // 5. 自前ボタンの挿入（冪等）
    var existingBtn = document.querySelector('[' + HISTORY_MAP_BTN_ATTR + '="' + HISTORY_MAP_BTN_VALUE + '"]');
    if (existingBtn) {
      return;
    }

    var btnHost = document.createElement('div');
    btnHost.setAttribute(HISTORY_MAP_BTN_ATTR, HISTORY_MAP_BTN_VALUE);
    btnHost.className = 'dbsext-history-map-btn-host';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dbsext-history-map-btn';
    btn.textContent = '🗺️ 地図を拡大表示';
    btn.addEventListener('click', function () {
      var currentCandidate = findUniqueVisibleMapCandidate();
      if (!currentCandidate || (mapCandidate && mapCandidate !== currentCandidate)) {
        cleanupHistoryMapUI();
        return;
      }
      expandHistoryMap(currentCandidate);
    });

    btnHost.appendChild(btn);

    if (mapCandidate.parentNode) {
      mapCandidate.parentNode.insertBefore(btnHost, mapCandidate);
    } else if (table.parentNode) {
      table.parentNode.insertBefore(btnHost, table);
    } else {
      document.body.appendChild(btnHost);
    }
  }

  function applyBatteryLauncher() {
    if (typeof document === 'undefined' || !document.body) return;

    if (isOriginalViewActive()) {
      cleanupBatteryLauncherUI();
      return;
    }

    if (isBatteryLauncherPresent()) return; // 既出（冪等）

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
      if (!isOriginalViewActive()) {
        insertLauncherIfAbsent();
      }
      return;
    }

    areaCheckState = 'pending';
    D.areas.load().then(function (res) {
      if (res && res.ok && D.areas.hasKnownArea(res.areas)) {
        areaCheckState = 'supported';
        if (!isOriginalViewActive()) {
          insertLauncherIfAbsent();
        }
      } else if (res && res.ok) {
        // 取得は成功したが、対応エリアが1つも無い
        areaCheckState = 'unsupported';
      } else {
        // 取得失敗（セッション切れ等）。安全側として表示する
        areaCheckState = 'supported';
        if (!isOriginalViewActive()) {
          insertLauncherIfAbsent();
        }
      }
    }).catch(function () {
      areaCheckState = 'supported';
      if (!isOriginalViewActive()) {
        insertLauncherIfAbsent();
      }
    });
  }

  // production original-view のトグル連携（バブリングフェーズで同期連携）
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('click', function (e) {
      var target = e.target;
      if (!target) return;
      var isOrigBtn = false;
      if (target.hasAttribute && (target.hasAttribute('data-dbsext-original-view') || target.hasAttribute('data-dbsext-original-view-btn'))) {
        isOrigBtn = true;
      } else if (target.closest && (target.closest('[data-dbsext-original-view]') || target.closest('[data-dbsext-original-view-btn]'))) {
        isOrigBtn = true;
      }
      if (isOrigBtn) {
        if (isOriginalViewActive()) {
          collapseHistoryMap();
          cleanupHistoryMapUI();
          cleanupBatteryLauncherUI();
        }
      }
    }, false);
  }

  D.mapLauncher = {
    _collapseHistoryMap: collapseHistoryMap,
    _expandHistoryMap: expandHistoryMap,
    _applyVehicleHistoryMap: applyVehicleHistoryMap,
    _cleanupHistoryMapUI: cleanupHistoryMapUI,
    _cleanupBatteryLauncherUI: cleanupBatteryLauncherUI,
    _applyBatteryLauncher: applyBatteryLauncher,

    peekShowAll: function () {
      collapseHistoryMap();
      cleanupHistoryMapUI();
      cleanupBatteryLauncherUI();
    },
    peekRestore: function () {
      applyVehicleHistoryMap();
      applyBatteryLauncher();
    },

    /**
     * 起動ボタンを表示する（冪等・reapply対応）。
     *
     * 1. 車両履歴画面（/vehicles/VHCL:.../histories）では既存地図の拡大表示ボタンを出す
     * 2. 左下固定のバッテリーマップ起動ボタンを出す
     */
    apply: function () {
      if (typeof document === 'undefined' || !document.body) return;

      applyVehicleHistoryMap();
      applyBatteryLauncher();
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
 * DBSEXT 車両個別画面の問題申告一覧モジュール
 *
 * 車両個別画面（`/vehicles/:id`）で純正の問題申告テーブルを非表示にし、
 * 自前の多機能テーブル（並べ替え・絞り込み・部位×事象展開）を表示する。
 *
 * 契約（docs/06-module-contract.md §6）の遵守:
 *   - 読み取り専用（GET /api/vehicles/:id/problems のみ）
 *   - 更新系リクエストは一切発行しない
 *   - setInterval を使わない
 *   - ポータルの既存DOMを削除・移動しない（非表示にするのみ）
 */
(function (global) {
  'use strict';
  var D = global.DBSEXT;

  var PANEL_ATTR = 'data-dbsext-vehicle-problems';
  var TABLE_ATTR = 'data-dbsext-vp-table';

  // キャッシュ: vehicleId -> { rows: Array, timestamp: number }
  var cacheMap = {};
  var CACHE_TTL = 30000; // 30秒

  // 重複fetch防止・世代管理
  var currentGeneration = 0;
  var isFetching = false;
  var currentVehicleId = null;

  /**
   * 車両個別画面かどうかの判定
   * パス例: /vehicles/VEHICLE:019053c7-ef57-7975-bebe-08f335b36aa4
   */
  function getVehicleIdFromUrl() {
    if (typeof location === 'undefined') return null;
    var match = /^\/vehicles\/([A-Za-z0-9:_-]+)\/?$/.exec(location.pathname);
    if (!match) return null;
    var id = match[1];
    if (id === 'list' || id === 'search') return null;
    return id;
  }

  /**
   * 純正の「問題申告」セクションのテーブルを探索
   */
  function findOriginalTable() {
    if (typeof document === 'undefined') return null;
    var headers = document.querySelectorAll('h3, .el-collapse-item__header, .section-title, span, div');
    for (var i = 0; i < headers.length; i++) {
      var h = headers[i];
      if ((h.textContent || '').trim() === '問題申告') {
        var container = h.closest('.el-collapse-item') || h.closest('.section') || h.parentElement;
        if (container) {
          var table = container.querySelector('.el-table');
          if (table) return { container: container, table: table, header: h };
        }
      }
    }
    // フォールバック: 画面内のすべての .el-table から探す
    var tables = document.querySelectorAll('.el-table');
    for (var j = 0; j < tables.length; j++) {
      var t = tables[j];
      var ths = t.querySelectorAll('thead th');
      for (var k = 0; k < ths.length; k++) {
        var text = (ths[k].textContent || '').trim();
        if (text === '問題申告日時' || text === '事象' || text === '部位') {
          return { container: t.parentElement, table: t, header: null };
        }
      }
    }
    return null;
  }

  /**
   * 自前テーブルの挿入先を決定
   */
  function findInsertionPoint() {
    var orig = findOriginalTable();
    if (orig && orig.table) {
      var wrapper = orig.table.parentElement;
      while (wrapper && wrapper !== document.body && !(wrapper.classList && wrapper.classList.contains('mb-4'))) {
        wrapper = wrapper.parentElement;
      }
      if (wrapper && wrapper !== document.body && wrapper.parentElement) {
        return { container: wrapper.parentElement, targetSibling: wrapper };
      }
      return { container: orig.table.parentElement, targetSibling: orig.table };
    }
    if (orig && orig.container) {
      return { container: orig.container, targetSibling: null };
    }
    var main = document.querySelector('.main-content, .el-main, #app');
    if (main) {
      return { container: main, targetSibling: null };
    }
    return null;
  }

  /**
   * 純正テーブルを隠す（DOM削除はしない、display:none のみ）
   */
  function hideOriginalTable() {
    var orig = findOriginalTable();
    if (!orig || !orig.table) return false;
    var wrapper = orig.table.parentElement;
    while (wrapper && wrapper !== document.body && !(wrapper.classList && wrapper.classList.contains('mb-4'))) {
      wrapper = wrapper.parentElement;
    }
    if (wrapper && wrapper !== document.body) {
      wrapper.setAttribute(PANEL_ATTR + '-hidden', '1');
      wrapper.style.display = 'none';
    }
    orig.table.setAttribute(PANEL_ATTR + '-hidden', '1');
    return true;
  }

  /**
   * 純正テーブルを再表示（画面離脱時など）
   */
  function showOriginalTable() {
    var hidden = document.querySelectorAll('[' + PANEL_ATTR + '-hidden="1"]');
    for (var i = 0; i < hidden.length; i++) {
      hidden[i].style.display = '';
      hidden[i].removeAttribute(PANEL_ATTR + '-hidden');
    }
  }

  /**
   * パネルが現在も有効か検証
   */
  function isPanelValid(panel, vehicleId) {
    if (!panel || !panel.parentNode) return false;
    if (panel.getAttribute(PANEL_ATTR + '-vid') !== vehicleId) return false;
    return true;
  }

  /**
   * APIから問題申告データを取得
   */
  function fetchProblems(vehicleId, panel, gen) {
    var statusDiv = panel.querySelector('[' + PANEL_ATTR + '-status]');

    // キャッシュチェック
    var cached = cacheMap[vehicleId];
    if (cached && (Date.now() - cached.timestamp < CACHE_TTL)) {
      renderTable(panel, cached.rows);
      return;
    }

    if (isFetching && currentVehicleId === vehicleId) {
      return;
    }

    isFetching = true;
    currentVehicleId = vehicleId;

    if (statusDiv) {
      statusDiv.textContent = '問題申告データを読み込み中...';
      statusDiv.className = 'dbsext-vp-status';
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

    var areaId = (D.userSummary && typeof D.userSummary.getSelectedAreaId === 'function')
      ? D.userSummary.getSelectedAreaId()
      : null;

    var codesToPreload = [];
    for (var p = 0; p < rows.length; p++) {
      var c = (rows[p].userUniqueCode || '').trim();
      if (c && c !== '-' && codesToPreload.indexOf(c) === -1) {
        codesToPreload.push(c);
      }
    }

    var columns = [
      { label: '問題申告日時',    value: function (r) { return r.problemReportTs; } },
      {
        label: 'ユーザ識別番号',
        value: function (r) { return r.userUniqueCode; },
        render: function (td, r) {
          var code = (r.userUniqueCode || '').trim();
          if (!code || code === '-') {
            td.textContent = '-';
            return;
          }
          td.textContent = code;

          var applyLink = function (summary) {
            if (!(td.parentNode || td.parentElement)) return;
            while (td.firstChild) td.removeChild(td.firstChild); // dbsext:own-ui
            if (summary && summary.userKind) {
              var buildUrlFn = (D.userSummary && typeof D.userSummary.buildUserDetailUrl === 'function')
                ? D.userSummary.buildUserDetailUrl
                : null;
              var href = buildUrlFn ? buildUrlFn(summary.userKind, code, areaId) : null;
              if (href) {
                var a = document.createElement('a');
                a.setAttribute('href', href);
                a.setAttribute('target', '_blank');
                a.setAttribute('rel', 'noopener noreferrer');
                a.textContent = code;
                a.className = 'dbsext-cell-link';
                a.title = 'ユーザー詳細を別タブで開きます';
                td.appendChild(a);
                return;
              }
            }
            td.textContent = code;
          };

          if (D.userSummary) {
            var cache = (typeof D.userSummary._getCacheMap === 'function') ? D.userSummary._getCacheMap()[code] : null;
            if (cache && cache.userKind && (!cache.expiry || Date.now() <= cache.expiry)) {
              applyLink(cache);
            } else {
              D.userSummary.requestSummaries([code], function (resCode, summary) {
                if (resCode === code) {
                  applyLink(summary);
                }
              });
            }
          }
        }
      },
      {
        label: '会員区分',
        value: function (r) { return r._summaryKindName || '-'; },
        render: function (td, r) {
          var code = (r.userUniqueCode || '').trim();
          if (!code || code === '-') {
            td.textContent = '-';
            return;
          }
          td.textContent = '-';

          var applyKind = function (summary) {
            if (!(td.parentNode || td.parentElement)) return;
            if (summary && summary.userKind) {
              var kindName = (D.userSummary && typeof D.userSummary.getUserKindDisplayName === 'function')
                ? D.userSummary.getUserKindDisplayName(summary.userKind)
                : summary.userKind;
              r._summaryKindName = kindName;
              td.textContent = kindName || '-';
            } else {
              td.textContent = '-';
            }
          };

          if (D.userSummary) {
            var cache = (typeof D.userSummary._getCacheMap === 'function') ? D.userSummary._getCacheMap()[code] : null;
            if (cache && cache.userKind && (!cache.expiry || Date.now() <= cache.expiry)) {
              applyKind(cache);
            } else {
              D.userSummary.requestSummaries([code], function (resCode, summary) {
                if (resCode === code) {
                  applyKind(summary);
                }
              });
            }
          }
        }
      },
      {
        label: 'ユーザーID',
        value: function (r) { return r._summaryUserId || '-'; },
        render: function (td, r) {
          var code = (r.userUniqueCode || '').trim();
          if (!code || code === '-') {
            td.textContent = '-';
            return;
          }
          td.textContent = '-';

          var applyId = function (summary) {
            if (!(td.parentNode || td.parentElement)) return;
            if (summary && summary.userId) {
              r._summaryUserId = summary.userId;
              td.textContent = summary.userId;
            } else {
              td.textContent = '-';
            }
          };

          if (D.userSummary) {
            var cache = (typeof D.userSummary._getCacheMap === 'function') ? D.userSummary._getCacheMap()[code] : null;
            if (cache && cache.userKind && (!cache.expiry || Date.now() <= cache.expiry)) {
              applyId(cache);
            } else {
              D.userSummary.requestSummaries([code], function (resCode, summary) {
                if (resCode === code) {
                  applyId(summary);
                }
              });
            }
          }
        }
      },
      { label: '重要度',          value: function (r) { return r.importanceCategory; } },
      { label: '部位',            value: function (r) { return r.partNameJa; } },
      { label: '事象',            value: function (r) { return r.occurrenceNameJa; } },
      { label: '回収状況',        value: function (r) { return r.collectionStatus; } },
      { label: '回収完了日時',    value: function (r) { return r.collectionCompleteExecutionTs; } }
    ];

    if (D.userSummary && codesToPreload.length > 0) {
      D.userSummary.requestSummaries(codesToPreload);
    }

    // 描画・並べ替え・絞り込みは custom-table が担う。
    // 以前はここに約110行の自前実装があり、ビーコン一覧とほぼ同じものだった。
    D.customTable.render({
      container: tableWrap,
      rows: rows,
      columns: columns,
      // 初期表示は「最新申告日時」が先頭になるよう降順にする。
      // ヘッダをクリックした場合は custom-table 側の通常のトグルへ戻る。
      initialSort: { columnIndex: 0, direction: 'desc' },
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
      if (!vehicleId) {
        teardown();
        return;
      }

      var orig = findOriginalTable();
      if (!orig) {
        // 純正テーブルがまだ描画されていない場合は待つ
        return;
      }

      hideOriginalTable();

      var panel = buildPanel(vehicleId);
      if (!panel) return;

      fetchProblems(vehicleId, panel, currentGeneration);
    },

    peekShowAll: function () {
      showOriginalTable();
    },

    peekRestore: function () {
      if (getVehicleIdFromUrl()) hideOriginalTable();
    },

    // テスト用の内部状態アクセス
    _getVehicleIdFromUrl: getVehicleIdFromUrl,
    _findProblemTable: findOriginalTable,
    _getCache: function () { return cacheMap; },
    _clearCache: function () { cacheMap = {}; },
    _resetForTest: function () {
      cacheMap = {};
      currentGeneration = 0;
      isFetching = false;
      currentVehicleId = null;
    }
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
 *   「停止中」「一時休止中」は2026-08-12にPUTでの往復を実測済み（`docs/02-portal-facts.md`§5）。
 *   残り3値（「運用中」「運用中（貸出制限中）」「一時駐輪用」）も2026-08-13、依頼者立ち会いの
 *   もと本機能自体で実際に変更し、ポータル画面上で正しく反映されることを実機確認済み
 * - `publishFlag`（公開・非公開）: `investigation/probe_port_field_mapping.py`
 *   （2026-08-12・非破壊。敦賀エリア8ポートで詳細画面のラジオボタン選択状態と
 *   `GET /api/ports/{id}`の`publishFlag`を突き合わせ）で、**8件すべて`公開`⇔`true`が一致**
 *   することを確認済み。`false`⇔`非公開`の対応は当時サンプルが無く推論（消去法）だったが、
 *   2026-08-13、依頼者立ち会いのもと本機能自体で実際に`非公開`へ変更し、ポータル画面上で
 *   正しく反映されることを実機確認済み（推論どおりの対応で確定）
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
  // ensurePublishFlags()の同時GET数を絞るスロット状態（`platform-page.js`の
  // runWithBeaconPortSlot()と同じ考え方。2026-08-12独立監査「一覧の行数ぶん
  // 無制限に同時発行している」への対応）
  var publishFlagSlotsActive = 0;
  var publishFlagSlotQueue = [];
  var PUBLISH_FLAG_CONCURRENCY = 3;
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
  //
  // 2026-08-13 上記の503対策として一時的に入れていた「欠落時は空配列[]を補う」実装
  // （後述buildUpdatedRecord参照）が、**ビーコンが紐づくポートで紐付けを消す実害が
  // あることを敦賀エリアで確定した**（`investigation/probe_beacon_linked_port_shape.py`。
  // `GET /api/ports/{id}/beacons`でビーコン紐付き済みと確認できた敦賀5ポートすべてで、
  // `GET /api/ports/{id}`の応答に`beaconIds`キーが無かった。つまりこのキーの有無は
  // 「ビーコンの有無」を一切表さず常に省略される。結果採取:
  // `investigation/out/beacon-linked-port-detail-shape.json`）。ビーコンが紐づく
  // ポート（今回確認した敦賀20ポート全数）へ一括操作を行うたび紐付けが消えていた。
  //
  // 2026-08-13 続き: 依頼者提供の実機PUTログ（フェーズ0.5、DevTools記録）と
  // `GET /api/ports/{id}/beacons`応答を突き合わせたところ、実際に送信された
  // `beaconIds`配列の値が、この`/beacons`応答の`portBeaconId`フィールドと
  // **完全一致**することが確認できた（`investigation/probe_beacon_id_field_match.py`）。
  // これにより`fetchPortBeaconIds()`（読み取り専用）で正しい`beaconIds`値そのものを
  // 復元してPUTできるようになった。復元に失敗した場合（応答形式が不正・
  // `portBeaconId`が欠けている等）だけ**推測でPUTせず、その行を失敗扱いにする**
  // （安全側優先。`buildUpdatedRecord()`が例外を投げ、既存の1件失敗時の継続処理に乗る）。
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
   * 対象ポートに紐づくビーコンIDの配列を、実際の紐付けから正しく復元する（読み取り専用）。
   * `beacons.js`/`platform-page.js`のfetchBeaconsByAreaと同じ、ビーコン一覧機能が
   * 既に使っているAPI（`GET /api/ports/{id}/beacons`）。
   *
   * `GET /api/ports/{id}`（`fetchPortDetail`）の応答は`beaconIds`キーを常に省略し、
   * それはビーコンの有無を表さない（2026-08-13 敦賀20ポート全数調査で確認。
   * 上記`REQUIRED_RECORD_KEYS`のコメント参照）。
   *
   * 2026-08-13 依頼者提供の実機PUTログ（フェーズ0.5・敦賀「19.ニューサンピア敦賀」
   * `PORT:01KY4PF9WD29EZHYZPCBFC7ZRW-t`、DevTools記録）で、実際に送信された
   * `beaconIds: ["BECN:01KYWEZ37GJT9ZGK9B8XZQYY8F-t"]` が、この`/beacons`APIの
   * 応答項目の`portBeaconId`フィールドと**完全一致**することを実機で確認した
   * （`investigation/probe_beacon_id_field_match.py`。同じポート・同じ値で照合）。
   * よってこの関数は「紐づきの有無」だけでなく**正しい値そのもの**を復元して返す。
   *
   * 応答が期待した形でない場合（配列でない、`portBeaconId`が空文字/非文字列等）は
   * 例外を投げる。復元できない値を推測で埋めるより、その行を失敗させるほうが安全なため
   * （安全側優先。呼び出し側`processIndex`はこの例外をそのまま伝播させ「失敗」として扱う）。
   */
  function fetchPortBeaconIds(portId) {
    var url = '/api/ports/' + portId + '/beacons';
    return fetch(url, { credentials: 'include' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (body) {
      var items = Array.isArray(body) ? body
        : (body && Array.isArray(body.dataList)) ? body.dataList
        : (body && Array.isArray(body.items)) ? body.items
        : (body && Array.isArray(body.data)) ? body.data
        : null;
      if (!Array.isArray(items)) {
        throw new Error('ビーコン一覧の応答形式が不正です');
      }
      var ids = [];
      for (var i = 0; i < items.length; i++) {
        var id = items[i] && items[i].portBeaconId;
        if (typeof id !== 'string' || !id) {
          throw new Error('ビーコン識別番号の形式が不正です');
        }
        ids.push(id);
      }
      return ids;
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

  /**
   * 表をデータ更新で描き直す場合に、利用者が操作中の状態を引き継ぐ。
   * custom-table は再描画時に state を作り直すため、条件オブジェクトを複製して
   * 次の表へ渡す（元の state を共有すると新旧表のイベントが混線する）。
   */
  function snapshotTableState(result) {
    var state = result && result.state;
    if (!state) return null;
    var snapshot = {
      sortColIndex: state.sortColIndex,
      sortOrder: state.sortOrder,
      conditions: {},
      focus: null
    };
    var conditions = state.conditions || {};
    for (var key in conditions) {
      if (!Object.prototype.hasOwnProperty.call(conditions, key) || !conditions[key]) continue;
      var condition = conditions[key];
      snapshot.conditions[key] = {
        kind: condition.kind,
        text: condition.text,
        min: condition.min,
        max: condition.max
      };
    }
    // 表の再構築でフォーカスが古い入力欄と一緒に失われないよう、
    // 現在操作中の絞り込み欄を列番号・種別・選択範囲で記録する。
    if (typeof document !== 'undefined' && result.table && document.activeElement) {
      var active = document.activeElement;
      var headerRows = result.table.querySelectorAll ? result.table.querySelectorAll('thead tr') : [];
      var headerRow = headerRows && headerRows[0];
      var controls = [
        { selector: '[data-dbsext-filter]', key: 'text' },
        { selector: '[data-dbsext-filter-min]', key: 'min' },
        { selector: '[data-dbsext-filter-max]', key: 'max' },
        { selector: '[data-dbsext-filter-select]', key: 'text' }
      ];
      if (headerRow && headerRow.children) {
        for (var columnIndex = 0; columnIndex < headerRow.children.length; columnIndex++) {
          var th = headerRow.children[columnIndex];
          var node = active;
          var inside = false;
          while (node) {
            if (node === th) { inside = true; break; }
            node = node.parentNode;
          }
          if (!inside) continue;
          for (var ci = 0; ci < controls.length; ci++) {
            var control = th.querySelector ? th.querySelector(controls[ci].selector) : null;
            if (control !== active) continue;
            snapshot.focus = {
              columnIndex: columnIndex,
              key: controls[ci].key,
              selectionStart: typeof active.selectionStart === 'number' ? active.selectionStart : null,
              selectionEnd: typeof active.selectionEnd === 'number' ? active.selectionEnd : null
            };
            break;
          }
          if (snapshot.focus) break;
        }
      }
    }
    return snapshot;
  }

  /** データ更新で表を作り直した後、直前に操作していた絞り込み欄へフォーカスを戻す。 */
  function restoreTableFocus(table, focus) {
    if (!table || !focus || typeof focus.columnIndex !== 'number') return;
    var headerRows = table.querySelectorAll ? table.querySelectorAll('thead tr') : [];
    var headerRow = headerRows && headerRows[0];
    if (!headerRow || !headerRow.children || !headerRow.children[focus.columnIndex]) return;
    var th = headerRow.children[focus.columnIndex];
    var selectorByKey = {
      text: '[data-dbsext-filter]',
      min: '[data-dbsext-filter-min]',
      max: '[data-dbsext-filter-max]'
    };
    // select式はtextキーでも入力欄と衝突しない列定義なので、まずselectを探す。
    var control = th.querySelector ? th.querySelector('[data-dbsext-filter-select]') : null;
    var selector = selectorByKey[focus.key];
    if (!control && selector && th.querySelector) control = th.querySelector(selector);
    if (!control || typeof control.focus !== 'function') return;
    control.focus();
    if (typeof focus.selectionStart === 'number' && typeof focus.selectionEnd === 'number' &&
        typeof control.setSelectionRange === 'function') {
      try { control.setSelectionRange(focus.selectionStart, focus.selectionEnd); } catch (e) {}
    }
  }

  function isCurrentRenderedTable(panel, rows, areaId, generation) {
    return isPortsListPath() && getSelectedAreaId() === areaId &&
      currentGeneration === generation &&
      panel.__dbsextPortBulkRenderedAreaId === areaId &&
      panel.__dbsextPortBulkRenderedRows === rows &&
      panel.__dbsextPortBulkRenderGeneration === generation;
  }

  function renderTable(panel, rows, renderAreaId, renderGeneration) {
    var tableWrap = panel.querySelector('.dbsext-port-bulk-table-wrap');
    if (!tableWrap) return;

    var previousState = snapshotTableState(panel.__dbsextPortBulkTableResult);

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

    var areaId = renderAreaId || getSelectedAreaId();

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
            if (!isCurrentRenderedTable(panel, rows, renderAreaId, renderGeneration)) {
              checkbox.checked = false;
              return;
            }
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
        // 「公開」「非公開」以外の値は無い列挙値のため、絞り込みは文字入力ではなく
        // プルダウン選択式にする（table-kit.js のFILTER_SELECT。完全一致で絞り込む）。
        // PUBLISH_FLAG_OPTIONSのlabelをそのまま使い、表記のずれを防ぐ
        filterOptions: PUBLISH_FLAG_OPTIONS.map(function (o) { return o.label; }),
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
      emptyText: '絞り込み条件に一致するポートはありません。',
      initialState: previousState,
      // 2026-08-12独立監査「絞り込み・並替のたびにtbodyが再構築されるが、見出しの
      // 一括選択チェックボックスのchecked/indeterminateが古いままになる」への対応。
      // custom-table.jsのrefresh()（絞り込み・並替時）のたびにこのコールバックが
      // 呼ばれるので、その場で見出しの見た目を今のtbodyに合わせ直す
      onRefresh: function () { syncSelectAllHeaderCheckbox(panel); }
    });

    panel.__dbsextPortBulkTableResult = result;

    addSelectAllHeaderCheckbox(panel, result && result.table, rows, renderAreaId, renderGeneration);
    restoreTableFocus(result && result.table, previousState && previousState.focus);
  }

  /** 同じデータに対する再適用では表とツールバーを作り直さない。 */
  function renderIfNeeded(panel, areaId, rows) {
    var table = panel.querySelector('[data-dbsext-port-bulk-table]');
    var toolbar = panel.querySelector('.dbsext-port-bulk-toolbar');
    var hasToolbar = toolbar && toolbar.querySelector('.dbsext-port-bulk-exec-btn');
    var sameRender = panel.__dbsextPortBulkRenderedAreaId === areaId &&
      panel.__dbsextPortBulkRenderedRows === rows &&
      panel.__dbsextPortBulkRenderGeneration === currentGeneration;
    if (sameRender && table && hasToolbar) return false;

    var renderGeneration = currentGeneration;
    renderTable(panel, rows, areaId, renderGeneration);
    renderToolbar(panel, rows, areaId, renderGeneration);
    panel.__dbsextPortBulkRenderedAreaId = areaId;
    panel.__dbsextPortBulkRenderedRows = rows;
    panel.__dbsextPortBulkRenderGeneration = renderGeneration;
    return true;
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
  function addSelectAllHeaderCheckbox(panel, table, rows, renderAreaId, renderGeneration) {
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
        if (!isCurrentRenderedTable(panel, rows, renderAreaId, renderGeneration)) {
          checkbox.checked = false;
          checkbox.indeterminate = false;
          return;
        }
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

  function renderToolbar(panel, rows, renderAreaId, renderGeneration) {
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

    // 公開設定は`公開⇔true`(2026-08-12・8件実測)・`非公開⇔false`(2026-08-13・
    // 依頼者立ち会いで本機能自体を使い実測)の両方向とも確認済みのため常に有効。
    // PUBLISH_FLAG_VERIFIED を参照する箇所はここ1箇所だけ
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
      onExecuteClick(panel, rows, serviceSelect.value, publishSelect ? publishSelect.value : NO_CHANGE,
        renderAreaId, renderGeneration);
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

  function onExecuteClick(panel, rows, serviceValue, publishValue, renderAreaId, renderGeneration) {
    // エリア切替直後に、画面から外れた古いツールバーのイベントが遅れて届いても
    // 旧行を確認画面・PUTへ進めない。DOMを消すだけでなく、世代と描画配列も照合する。
    if (!isPortsListPath() || getSelectedAreaId() !== renderAreaId ||
        currentGeneration !== renderGeneration ||
        panel.__dbsextPortBulkRenderedAreaId !== renderAreaId ||
        panel.__dbsextPortBulkRenderedRows !== rows ||
        panel.__dbsextPortBulkRenderGeneration !== renderGeneration) {
      setStatus(panel, 'エリアまたは画面が変わったため実行を取り消しました。選び直してください。', 'error');
      return;
    }
    var targetIds = Object.keys(selectedIds);
    if (targetIds.length === 0) return;

    // **確認画面を開いた時点のエリアを固定する。**
    // 2026-08-12 3回目独立監査「URLだけエリアを変えてapply()が呼ばれる前に
    // 古い確認ボタンを押すと、新エリアのrunAreaIdの下で旧エリアのtargetIdsが
    // 実行されてしまう」への対応。確定クリック時に、ここで固定した値と
    // 現在の状態が一致するかを再確認してから実行を始める（時間差を作らない）
    var confirmAreaId = getSelectedAreaId();
    var confirmGeneration = currentGeneration;

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
      if (!isPortsListPath() || getSelectedAreaId() !== confirmAreaId ||
          currentGeneration !== confirmGeneration) {
        clearNode(confirmBox);
        if (toolbar) toolbar.style.display = '';
        if (tableWrap) tableWrap.style.display = '';
        setStatus(panel, 'エリアまたは画面が変わったため実行を取り消しました。選び直してください。', 'error');
        return;
      }
      startExecution(panel, targetIds, byId, serviceValue, publishValue,
        confirmAreaId, confirmGeneration);
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

  /**
   * `beaconIdsOverride`: `record`に`beaconIds`が無い場合に補う配列。
   * `fetchPortBeaconIds()`で復元した実際の紐付けID配列（`portBeaconId`の配列。
   * ビーコン無しなら`[]`）を渡すこと。配列でない場合（復元できなかった/未実施）は、
   * 推測で埋めず例外を投げる（安全側優先。呼び出し側`processIndex`はこれをキャッチし、
   * その行を失敗扱いにしてPUTしない）。
   * `record`に既に`beaconIds`が配列で含まれる場合はこの判定自体を通らない
   * （そのまま保持されるため呼ばなくてよい。分岐は`processIndex`側にある）。
   */
  function buildUpdatedRecord(record, serviceValue, publishValue, beaconIdsOverride) {
    // **レコード全体を保つ。** 変更したいフィールドだけを上書きし、
    // それ以外は fetchPortDetail() で取得した値をそのまま残す
    var updated = {};
    for (var key in record) {
      if (Object.prototype.hasOwnProperty.call(record, key)) updated[key] = record[key];
    }
    // 2026-08-12 実機再テストで判明: `beaconIds`キーを含まないPUTはHTTP 503になる。
    // 2026-08-13 敦賀20ポート全数の非破壊調査で確定: `GET /api/ports/{id}`は
    // ビーコンの有無に関わらず常にこのキーを省略する（ビーコン紐付き済み5ポートの
    // サンプルすべてでキーが無かった。`investigation/out/beacon-linked-port-detail-shape.json`）。
    // 依頼者提供の実機PUTログとの突き合わせ（`fetchPortBeaconIds()`のコメント参照）で、
    // `GET /api/ports/{id}/beacons`の`portBeaconId`から正しい`beaconIds`値を復元できる
    // ことが確認できたため、その復元値（`beaconIdsOverride`）を使う。復元できなかった
    // 場合（`fetchPortBeaconIds()`が例外を投げた等）は推測で書き込まず、この行自体を失敗させる。
    if (!Array.isArray(updated.beaconIds)) {
      if (Array.isArray(beaconIdsOverride)) {
        updated.beaconIds = beaconIdsOverride;
      } else {
        throw new Error('ビーコン紐付けを安全に復元できないため書き込みを見送りました');
      }
    }
    if (serviceValue !== NO_CHANGE) updated.serviceState = serviceValue;
    if (publishValue !== NO_CHANGE) updated.publishFlag = publishValue === 'true';
    return updated;
  }

  function startExecution(panel, targetIds, byId, serviceValue, publishValue,
    expectedAreaId, expectedGeneration) {
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
    var runGeneration = currentGeneration;
    if (runAreaId !== expectedAreaId || runGeneration !== expectedGeneration) {
      setStatus(panel, 'エリアまたは画面が変わったため実行を取り消しました。選び直してください。', 'error');
      return;
    }
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
      return activeRunToken === myToken && currentGeneration === runGeneration &&
        isPortsListPath() && getSelectedAreaId() === runAreaId;
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
          // `record`に`beaconIds`が既に配列で含まれる場合はそのまま保持されるだけなので、
          // 追加の復元（`fetchPortBeaconIds`）は不要。無い場合だけ、ビーコン紐付けを
          // 誤って消さないよう直前に正しい値を復元する（読み取り専用の追加GETが1回増える）
          if (Array.isArray(record.beaconIds)) {
            var updatedNoFetch = buildUpdatedRecord(record, serviceValue, publishValue, null);
            return putPortDetail(portId, updatedNoFetch);
          }
          return fetchPortBeaconIds(portId).then(function (beaconIds) {
            if (!isRunStillValid()) throw new Error('画面またはエリアが変わったため中断');
            var updated = buildUpdatedRecord(record, serviceValue, publishValue, beaconIds);
            return putPortDetail(portId, updated);
          });
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
  /** 複数の一覧描画を跨いでも、公開設定プリフェッチの同時GET数を最大3件に保つ。
   * `platform-page.js`の`runWithBeaconPortSlot()`と同じ考え方 */
  function runWithPublishFlagSlot(task) {
    return new Promise(function (resolve, reject) {
      function release() {
        publishFlagSlotsActive--;
        var next = publishFlagSlotQueue.shift();
        if (next) next();
      }
      function start() {
        publishFlagSlotsActive++;
        Promise.resolve().then(task).then(function (value) {
          release();
          resolve(value);
        }, function (error) {
          release();
          reject(error);
        });
      }
      if (publishFlagSlotsActive < PUBLISH_FLAG_CONCURRENCY) {
        start();
      } else {
        publishFlagSlotQueue.push(start);
      }
    });
  }

  function ensurePublishFlags(panel, rows, areaId) {
    var now = Date.now();
    for (var i = 0; i < rows.length; i++) {
      (function (row) {
        if (!row || !isValidPortalId(row.portId)) return;
        var entry = publishFlagCache[row.portId];
        if (entry && (now - entry.timestamp < CACHE_TTL_MS)) return; // 十分新しい
        publishFlagCache[row.portId] = { value: entry ? entry.value : null, timestamp: now };
        runWithPublishFlagSlot(function () {
          return fetchPortDetail(row.portId);
        }).then(function (record) {
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
      renderIfNeeded(panel, areaId, cached.rows);
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
      renderIfNeeded(panel, areaId, rows);
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

  /** エリア切替時に、旧エリアの実行結果画面も破棄して新エリアの操作へ戻す。 */
  function forceCloseResults(panel) {
    var resultsBox = panel.querySelector('.dbsext-port-bulk-results');
    if (!resultsBox || resultsBox.style.display === 'none') return;
    clearNode(resultsBox);
    resultsBox.style.display = 'none';
  }

  /** エリア切替時に、旧エリアの行・チェックボックス・実行ボタンを同期的に破棄する。 */
  function clearStaleAreaControls(panel) {
    var toolbar = panel.querySelector('.dbsext-port-bulk-toolbar');
    var tableWrap = panel.querySelector('.dbsext-port-bulk-table-wrap');
    if (toolbar) clearNode(toolbar);
    if (tableWrap) clearNode(tableWrap);
    panel.__dbsextPortBulkRenderedAreaId = null;
    panel.__dbsextPortBulkRenderedRows = null;
    panel.__dbsextPortBulkRenderGeneration = null;
    panel.__dbsextPortBulkTableResult = null;
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
      // 一時的に戻せる（下記 D.portBulkActions 参照）。
      //
      // 2026-08-12独立監査で指摘・2026-08-13対応: 「オリジナル表示」中に`apply()`が
      // 再度呼ばれる（SPA再描画・エリア再選択等）と、`peekShowAll()`で戻したはずの
      // 純正表を無条件でまた隠してしまう回帰があった。`original-view.js`の
      // `isActive()`を見て、オリジナル表示中はここでの再非表示をスキップする
      // （`peekEachModule()`がトグル時に明示的に呼ぶ分だけで表示状態を決める）
      if (!D.originalView || !D.originalView.isActive || !D.originalView.isActive()) {
        setNativeTableHidden(true);
      }

      var areaId = getSelectedAreaId();
      if (!areaId) {
        // エリア未選択に戻った場合も、古い選択・実行・確認画面を持ち越さない
        currentGeneration++;
        activeRunToken++;
        selectedIds = Object.create(null);
        // 同じエリアを再選択したときも、解除前の表・チェック状態を再利用しない。
        // 描画マーカーを無効化して、再選択時に空の選択状態で表を作り直す。
        panel.__dbsextLastAreaId = null;
        panel.__dbsextPortBulkRenderedAreaId = null;
        panel.__dbsextPortBulkRenderedRows = null;
        panel.__dbsextPortBulkRenderGeneration = null;
        panel.__dbsextPortBulkTableResult = null;
        forceCloseConfirm(panel);
        forceCloseResults(panel);
        clearStaleAreaControls(panel);
        setStatus(panel, 'エリアを選択するとポート一覧が表示されます', null);
        return;
      }

      if (panel.__dbsextLastAreaId !== areaId) {
        panel.__dbsextLastAreaId = areaId;
        selectedIds = Object.create(null);
        clearStaleAreaControls(panel);
        currentGeneration++; // 前エリア向けの進行中フェッチを無効化する（早期無効化。完了時も別途直接確認する）
        activeRunToken++; // 前エリア向けの進行中実行を無効化する
        // **旧エリアのポートIDを指したままの確認画面は無条件に破棄する**
        // （2026-08-12再監査「エリア切替後も古い確認画面が実行できる」への対応）
        forceCloseConfirm(panel);
        forceCloseResults(panel);
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
 * DBSEXT テーブル列制御モジュール（静的推奨幅 + 操作列制御）
 *
 * 目的:
 * 1. 車両情報（/vehicles）の横長テーブル問題に対処するため、
 *    操作系5列（メンテナンス、AT管理、解錠、再配置、AT一体型車両操作）を
 *    トグルで隠せるようにする（既定は表示）。
 * 2. デフォルトの一律200px等の広すぎる列幅に対し、画面パスとヘッダ文言の
 *    安定入力に基づき、レイアウト自己帰還のない「静的推奨幅」を CSS !important で
 *    各列・セルへ適用する（既定はON）。
 * 3. 画面レイアウト結果（clientWidth / offsetWidth / scrollWidth / Canvas / getComputedStyle 等）
 *    は一切入力として使用しない。
 * 4. <table> や wrapper 全体の幅は設定せず、Element Plus 自身の表レイアウトに任せる。
 * 5. 多段ヘッダ、未知画面、未知表形状、行数0件では安全に fail-closed (no-op) とする。
 * 6. 操作列は危険な狭幅で上書きせず、静的推奨幅の適用対象から除外する。
 *
 * 契約 §6 の遵守:
 * - DOMノードの削除・移動は一切行わない（display: none による表示制御、および col/th/td style 設定のみ）
 * - 操作ボタン自体には一切介入しない
 * - 通信は一切行わない
 * - setInterval / eval / new Function を使わない
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

  /**
   * 画面パスおよび列名に基づく静的推奨幅テーブル（px）
   * docs/17 実測値および docs/18 教訓に基づく。
   * 操作列は危険な狭幅を強制せず除外。
   * レイアウト読取（clientWidth, offsetWidth, Canvas, getComputedStyle 等）は一切使わない。
   */
  var STATIC_COLUMN_RECOMMENDATIONS = {
    '/users': {
      'ユーザ識別番号': 260,
      'ユーザID': 130,
      '氏名 姓': 90,
      '氏名 名': 90,
      'ユーザ種別': 120,
      'ユーザ登録状態': 110,
      '車両利用状態': 110,
      '最新利用開始日時': 160,
      '決済状態': 90,
      '強制停止状態': 90,
      '利用明細': 90
    },
    '/vehicles': {
      '': 44, // チェックボックス
      '車両識別番号': 140,
      '車両情報': 100,
    '車両状態': 100,
    'ポート名': 200,
    'ユーザ識別番号': 260,
    '会員区分': 140,
    'ユーザーID': 140,
      'AT種別': 90,
      'バッテリー': 90,
      '貸出日時': 160,
      'AT通知受信日時': 160,
      'AT識別番号': 140
    }
  };

  var EXPECTED_USERS_COLUMNS = [
    'ユーザ識別番号',
    'ユーザID',
    '氏名 姓',
    '氏名 名',
    'ユーザ種別',
    'ユーザ登録状態',
    '車両利用状態',
    '最新利用開始日時',
    '決済状態',
    '強制停止状態',
    '利用明細'
  ];

  var EXPECTED_VEHICLES_COLUMNS = [
    '',
    '車両識別番号',
    '車両情報',
    '車両状態',
    'ポート名',
    'ユーザ識別番号',
    'AT種別',
    'バッテリー',
    '貸出日時',
    'AT通知受信日時',
    'メンテナンス',
    'AT管理',
    '解錠',
    '再配置',
    'AT識別番号',
    'AT一体型車両操作'
  ];

  var STORAGE_FEATURE = 'showActionCols';
  var STORAGE_FEATURE_AUTOFIT = 'autoFitCols';
  var FALLBACK_STORAGE_PREFIX = 'dbsext:fallback:table-cols:';
  var UI_CONTAINER_ATTR = 'data-dbsext-table-columns';
  var TOGGLE_INPUT_ATTR = 'data-dbsext-action-toggle';
  var AUTOFIT_TOGGLE_ATTR = 'data-dbsext-autofit-toggle';

  function getScreen() {
    if (typeof location === 'undefined' || !location.pathname) return '';
    return location.pathname;
  }

  function normalizePath(screen) {
    if (!screen || typeof screen !== 'string') {
      if (typeof location !== 'undefined' && location.pathname) {
        screen = location.pathname;
      } else {
        screen = '/';
      }
    }
    if (screen.charAt(0) !== '/') screen = '/' + screen;
    screen = screen.replace(/\/+/g, '/');
    screen = screen.split('?')[0].split('#')[0];
    if (screen.length > 1 && screen.charAt(screen.length - 1) === '/') {
      screen = screen.slice(0, -1);
    }
    return screen || '/';
  }

  function getStaticRecommendations(screen) {
    if (!screen) return null;
    var normScreen = normalizePath(screen).toLowerCase();
    // 一覧ルートのみ厳密に限定（詳細画面 /users/general/... や /vehicles/.../histories 等は null）
    if (normScreen === '/users') {
      return STATIC_COLUMN_RECOMMENDATIONS['/users'];
    }
    if (normScreen === '/vehicles') {
      return STATIC_COLUMN_RECOMMENDATIONS['/vehicles'];
    }
    return null;
  }

  function getFallbackStorageKey(screen, feature) {
    return FALLBACK_STORAGE_PREFIX + normalizePath(screen) + ':' + feature;
  }

  function loadToggleState(screen) {
    try {
      var normScreen = normalizePath(screen);
      var legacyKey = 'dbsext:v1:' + normScreen + ':' + STORAGE_FEATURE;
      var fbKey = getFallbackStorageKey(screen, STORAGE_FEATURE);

      // REMARK-M6-STATE: 1. レガシー生文字列 ('true' / 'false') の救出とマイグレーション
      // stateStore.load より先にチェックし、誤って非オブジェクトとして削除されるのを防ぐ
      if (typeof localStorage !== 'undefined') {
        var legacyRaw = localStorage.getItem(legacyKey);
        if (legacyRaw === 'true' || legacyRaw === 'false') {
          var valLegacy = legacyRaw === 'true';
          if (D.stateStore && typeof D.stateStore.save === 'function') {
            var savedLegacy = false;
            try {
              savedLegacy = D.stateStore.save(screen, STORAGE_FEATURE, valLegacy, { scope: 'local' });
            } catch (e) {
              savedLegacy = false;
            }
            if (savedLegacy === true) {
              try { localStorage.removeItem(fbKey); } catch (e) {}
            } else {
              localStorage.setItem(fbKey, valLegacy ? 'true' : 'false');
              try { localStorage.removeItem(legacyKey); } catch (e) {}
            }
          } else {
            localStorage.setItem(fbKey, valLegacy ? 'true' : 'false');
            try { localStorage.removeItem(legacyKey); } catch (e) {}
          }
          return valLegacy;
        }
      }

      // 2. stateStore の正規レコード読み込み
      if (D.stateStore && typeof D.stateStore.load === 'function') {
        var val = D.stateStore.load(screen, STORAGE_FEATURE);
        if (val !== null && typeof val !== 'undefined') {
          if (typeof localStorage !== 'undefined') {
            try { localStorage.removeItem(fbKey); } catch (e) {}
          }
          return !!val;
        }
      }

      // 3. フォールバックストレージの読み込み
      if (typeof localStorage !== 'undefined') {
        var rawFallback = localStorage.getItem(fbKey);
        if (rawFallback === 'true' || rawFallback === 'false') {
          var valFb = rawFallback === 'true';
          if (D.stateStore && typeof D.stateStore.save === 'function') {
            var savedFb = false;
            try {
              savedFb = D.stateStore.save(screen, STORAGE_FEATURE, valFb, { scope: 'local' });
            } catch (e) {
              savedFb = false;
            }
            if (savedFb === true) {
              try { localStorage.removeItem(fbKey); } catch (e) {}
            }
          }
          return valFb;
        }
      }
    } catch (e) {}
    return true; // 既定は「表示」（showActionCols = true）
  }

  function saveToggleState(screen, show) {
    try {
      var normScreen = normalizePath(screen);
      var fbKey = getFallbackStorageKey(screen, STORAGE_FEATURE);
      var legacyKey = 'dbsext:v1:' + normScreen + ':' + STORAGE_FEATURE;
      var saved = false;
      if (D.stateStore && typeof D.stateStore.save === 'function') {
        try {
          saved = D.stateStore.save(screen, STORAGE_FEATURE, !!show, { scope: 'local' });
        } catch (e) {
          saved = false;
        }
      }
      if (saved === true) {
        if (typeof localStorage !== 'undefined') {
          try { localStorage.removeItem(fbKey); } catch (e) {}
        }
      } else if (typeof localStorage !== 'undefined') {
        localStorage.setItem(fbKey, show ? 'true' : 'false');
        try { localStorage.removeItem(legacyKey); } catch (e) {}
      }
    } catch (e) {}
  }

  function loadAutoFitState(screen) {
    try {
      var normScreen = normalizePath(screen);
      var legacyKey = 'dbsext:v1:' + normScreen + ':' + STORAGE_FEATURE_AUTOFIT;
      var fbKey = getFallbackStorageKey(screen, STORAGE_FEATURE_AUTOFIT);

      // REMARK-M6-STATE: 1. レガシー生文字列 ('true' / 'false') の救出とマイグレーション
      // stateStore.load より先にチェックし、誤って非オブジェクトとして削除されるのを防ぐ
      if (typeof localStorage !== 'undefined') {
        var legacyRaw = localStorage.getItem(legacyKey);
        if (legacyRaw === 'true' || legacyRaw === 'false') {
          var valLegacy = legacyRaw === 'true';
          if (D.stateStore && typeof D.stateStore.save === 'function') {
            var savedLegacy = false;
            try {
              savedLegacy = D.stateStore.save(screen, STORAGE_FEATURE_AUTOFIT, valLegacy, { scope: 'local' });
            } catch (e) {
              savedLegacy = false;
            }
            if (savedLegacy === true) {
              try { localStorage.removeItem(fbKey); } catch (e) {}
            } else {
              localStorage.setItem(fbKey, valLegacy ? 'true' : 'false');
              try { localStorage.removeItem(legacyKey); } catch (e) {}
            }
          } else {
            localStorage.setItem(fbKey, valLegacy ? 'true' : 'false');
            try { localStorage.removeItem(legacyKey); } catch (e) {}
          }
          return valLegacy;
        }
      }

      // 2. stateStore の正規レコード読み込み
      if (D.stateStore && typeof D.stateStore.load === 'function') {
        var val = D.stateStore.load(screen, STORAGE_FEATURE_AUTOFIT);
        if (val !== null && typeof val !== 'undefined') {
          if (typeof localStorage !== 'undefined') {
            try { localStorage.removeItem(fbKey); } catch (e) {}
          }
          return !!val;
        }
      }

      // 3. フォールバックストレージの読み込み
      if (typeof localStorage !== 'undefined') {
        var rawFallback = localStorage.getItem(fbKey);
        if (rawFallback === 'true' || rawFallback === 'false') {
          var valFb = rawFallback === 'true';
          if (D.stateStore && typeof D.stateStore.save === 'function') {
            var savedFb = false;
            try {
              savedFb = D.stateStore.save(screen, STORAGE_FEATURE_AUTOFIT, valFb, { scope: 'local' });
            } catch (e) {
              savedFb = false;
            }
            if (savedFb === true) {
              try { localStorage.removeItem(fbKey); } catch (e) {}
            }
          }
          return valFb;
        }
      }
    } catch (e) {}
    return true; // 既定は有効（静的CSS方式のため安全）
  }

  function saveAutoFitState(screen, enabled) {
    try {
      var normScreen = normalizePath(screen);
      var fbKey = getFallbackStorageKey(screen, STORAGE_FEATURE_AUTOFIT);
      var legacyKey = 'dbsext:v1:' + normScreen + ':' + STORAGE_FEATURE_AUTOFIT;
      var saved = false;
      if (D.stateStore && typeof D.stateStore.save === 'function') {
        try {
          saved = D.stateStore.save(screen, STORAGE_FEATURE_AUTOFIT, !!enabled, { scope: 'local' });
        } catch (e) {
          saved = false;
        }
      }
      if (saved === true) {
        if (typeof localStorage !== 'undefined') {
          try { localStorage.removeItem(fbKey); } catch (e) {}
        }
      } else if (typeof localStorage !== 'undefined') {
        localStorage.setItem(fbKey, enabled ? 'true' : 'false');
        try { localStorage.removeItem(legacyKey); } catch (e) {}
      }
    } catch (e) {}
  }

  /**
   * 列の見出し名を取り出す。
   * table-tools の自前UIが付加されている場合でも元の見出し名を取得する。
   * SPA での DOM 再利用時に古い data-dbsext-orig-title 属性が残っていても、
   * 自前UIを除外した最新の可視テキストを優先して取得する。
   */
  function headerName(th) {
    if (!th) return '';

    if (typeof th.cloneNode === 'function') {
      var clone = th.cloneNode(true);
      var own = clone.querySelectorAll(
        '[data-dbsext-sort],[data-dbsext-filter],[data-dbsext-filter-select],[data-dbsext-filter-min],[data-dbsext-filter-max],[data-dbsext-collapse-hint],.dbsext-th-sort,.dbsext-th-filters,.dbsext-own-ui'
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

  function isMultiRowOrSpanHeader(headerTable) {
    if (!headerTable) return false;
    var thead = headerTable.querySelector('thead');
    var rows = thead ? thead.querySelectorAll('tr') : headerTable.querySelectorAll('tr');
    if (rows.length > 1) return true;
    var ths = headerTable.querySelectorAll('th');
    for (var i = 0; i < ths.length; i++) {
      var th = ths[i];
      var cs = parseInt(th.getAttribute('colspan') || '1', 10);
      var rs = parseInt(th.getAttribute('rowspan') || '1', 10);
      if ((!isNaN(cs) && cs > 1) || (!isNaN(rs) && rs > 1)) {
        return true;
      }
    }
    return false;
  }

  /**
   * チェックボックス要素またはクラスを持つか判定 (REMARK-TABLE-02)
   */
  function hasCheckboxLike(cell) {
    if (!cell) return false;
    if (cell.querySelector && cell.querySelector('input[type="checkbox"], .el-checkbox, .el-checkbox__input')) {
      return true;
    }
    if (cell.classList && (cell.classList.contains('el-table-column--selection') || cell.classList.contains('el-checkbox') || cell.classList.contains('el-checkbox__input'))) {
      return true;
    }
    return false;
  }

  /**
   * 対象テーブルの形状・列構成を厳密に検証する (REMARK-TABLE-02)
   */
  function validateTargetTable(table, screen, headerTable, bodyTable) {
    if (!table || !headerTable || !bodyTable) return false;
    var normScreen = normalizePath(screen).toLowerCase();
    if (normScreen !== '/users' && normScreen !== '/vehicles') {
      return false;
    }

    // 自前テーブルは除外
    if (table.getAttribute('data-dbsext-table') === 'custom' ||
        table.getAttribute('data-dbsext-vp-table') ||
        table.getAttribute('data-dbsext-beacons-table')) {
      return false;
    }

    // header / body の colgroup がそれぞれちょうど1つ存在すること (REMARK-TABLE-02)
    var headerColgroups = headerTable.querySelectorAll('colgroup');
    var bodyColgroups = bodyTable.querySelectorAll('colgroup');
    if (headerColgroups.length !== 1 || bodyColgroups.length !== 1) {
      return false;
    }

    var headerRows = headerTable.querySelectorAll('thead tr, tr');
    if (headerRows.length !== 1) return false;
    var headerThs = headerRows[0].children;
    var colCount = headerThs.length;
    if (colCount === 0) return false;

    var headerCols = headerTable.querySelectorAll('colgroup col');
    var bodyCols = bodyTable.querySelectorAll('colgroup col');
    if (headerCols.length !== colCount || bodyCols.length !== colCount) {
      return false; // colgroup の欠落・不一致・重複
    }

    var allBodyRows = bodyTable.querySelectorAll('tbody tr');
    // 行数0件は未定義・適用対象外として拒否 (REMARK-TABLE-01: 真の no-op)
    if (allBodyRows.length === 0) {
      return false;
    }
    // 全 body 行の列数を検証（途中の行の不一致も拒否）
    for (var r = 0; r < allBodyRows.length; r++) {
      if (allBodyRows[r].children.length !== colCount) {
        return false;
      }
    }

    var headerTitles = [];
    var emptyHeaderCount = 0;
    for (var i = 0; i < colCount; i++) {
      var title = headerName(headerThs[i]);
      headerTitles.push(title);
      if (title === '') {
        emptyHeaderCount++;
      }
    }

    if (normScreen === '/users') {
      if (colCount !== EXPECTED_USERS_COLUMNS.length) return false;
      if (emptyHeaderCount !== 0) return false; // /users はチェックボックス列なし・空見出しなし
      // チェックボックス要素・クラスが header / body に一切存在しないこと
      for (var uTh = 0; uTh < colCount; uTh++) {
        if (hasCheckboxLike(headerThs[uTh])) return false;
      }
      for (var uRow = 0; uRow < allBodyRows.length; uRow++) {
        for (var uTd = 0; uTd < colCount; uTd++) {
          if (hasCheckboxLike(allBodyRows[uRow].children[uTd])) return false;
        }
      }
      // 期待列の照合
      for (var u = 0; u < EXPECTED_USERS_COLUMNS.length; u++) {
        if (headerTitles[u] !== EXPECTED_USERS_COLUMNS[u]) return false;
      }
      return true;
    }

    if (normScreen === '/vehicles') {
      var summaryColumnIndices = [];
      for (var summaryIdx = 0; summaryIdx < colCount; summaryIdx++) {
        if (headerThs[summaryIdx].getAttribute && headerThs[summaryIdx].getAttribute('data-dbsext-user-summary-th') === '1') {
          summaryColumnIndices.push(summaryIdx);
        }
      }
      if (summaryColumnIndices.length !== 0 && summaryColumnIndices.length !== 2) return false;
      if (summaryColumnIndices.length === 2) {
        var userIndex = headerTitles.indexOf('ユーザ識別番号');
        if (summaryColumnIndices[0] !== userIndex + 1 || summaryColumnIndices[1] !== userIndex + 2) return false;
        if (headerTitles[summaryColumnIndices[0]] !== '会員区分' || headerTitles[summaryColumnIndices[1]] !== 'ユーザーID') return false;
        for (var summaryRow = 0; summaryRow < allBodyRows.length; summaryRow++) {
          for (var summaryCol = 0; summaryCol < summaryColumnIndices.length; summaryCol++) {
            var summaryCell = allBodyRows[summaryRow].children[summaryColumnIndices[summaryCol]];
            if (!summaryCell || !summaryCell.getAttribute || summaryCell.getAttribute('data-dbsext-user-summary-td') !== '1') return false;
          }
        }
      }
      if (colCount !== EXPECTED_VEHICLES_COLUMNS.length + summaryColumnIndices.length) return false;
      if (emptyHeaderCount !== 1 || headerTitles[0] !== '') return false; // /vehicles は先頭にチェックボックス1列のみ空見出し
      var firstThCb = hasCheckboxLike(headerThs[0]);
      if (!firstThCb) return false;
      // 全ての body 行の先頭列に実チェックボックスが存在すること (REMARK-TABLE-02)
      for (var vRow0 = 0; vRow0 < allBodyRows.length; vRow0++) {
        if (!hasCheckboxLike(allBodyRows[vRow0].children[0])) {
          return false;
        }
      }
      // 2列目以降にチェックボックスが存在しないこと (REMARK-TABLE-02)
      for (var vTh = 1; vTh < colCount; vTh++) {
        if (hasCheckboxLike(headerThs[vTh])) return false;
      }
      for (var vRow = 0; vRow < allBodyRows.length; vRow++) {
        for (var vTd = 1; vTd < colCount; vTd++) {
          if (hasCheckboxLike(allBodyRows[vRow].children[vTd])) return false;
        }
      }
      // 期待列の照合
      var expectedIndex = 1;
      for (var v = 1; v < EXPECTED_VEHICLES_COLUMNS.length; v++) {
        while (summaryColumnIndices.indexOf(expectedIndex) !== -1) expectedIndex++;
        if (headerTitles[expectedIndex] !== EXPECTED_VEHICLES_COLUMNS[v]) return false;
        expectedIndex++;
      }
      return true;
    }

    return false;
  }

  function getRecommendedColWidth(screen, colIndex, headerTitle) {
    var recs = getStaticRecommendations(screen);
    if (!recs) return null;
    if (headerTitle && typeof recs[headerTitle] === 'number') {
      return recs[headerTitle];
    }
    if (colIndex === 0 && typeof recs[''] === 'number') {
      return recs[''];
    }
    return null;
  }

  /**
   * 明示された幅だけを安全に数値化する。
   * clientWidth / offsetWidth / getComputedStyle 等のレイアウト測定APIは一切使用しない。
   * 300junk や 300% は元幅として採用せず、読めない場合は null（fail-closed）にする。
   */
  function parseExplicitWidth(value, allowUnitless) {
    if (typeof value === 'number') {
      return isFinite(value) && value > 0 ? value : null;
    }
    if (value === undefined || value === null) return null;
    var text = String(value).trim();
    var match = /^([0-9]+(?:\.[0-9]+)?)(px)?$/i.exec(text);
    if (!match || (!match[2] && !allowUnitless)) return null;
    var number = Number(match[1]);
    return isFinite(number) && number > 0 ? number : null;
  }

  function readExplicitWidth(el) {
    if (!el) return null;

    if (el._dbsextOrigStyles && el._dbsextOrigStyles['width']) {
      var backedUp = parseExplicitWidth(el._dbsextOrigStyles['width'].val, false);
      if (backedUp !== null) return backedUp;
    }

    if (typeof el.getAttribute === 'function') {
      var originalAttr = parseExplicitWidth(el.getAttribute('data-dbsext-orig-width'), true);
      if (originalAttr !== null) return originalAttr;

      // HTML の width 属性は単位なし数値または px を受け入れる。% は除外する。
      var widthAttr = parseExplicitWidth(el.getAttribute('width'), true);
      if (widthAttr !== null) return widthAttr;
    }

    if (el.style) {
      var styleWidth = '';
      if (typeof el.style.getPropertyValue === 'function') {
        styleWidth = el.style.getPropertyValue('width') || '';
      } else {
        styleWidth = el.style.width || '';
      }
      var explicitStyle = parseExplicitWidth(styleWidth, false);
      if (explicitStyle !== null) return explicitStyle;
    }

    return null;
  }

  /**
   * col または th から明示された元幅（px数値）を読む。
   * col を優先し、列幅が無い場合だけ th の明示幅へフォールバックする。
   */
  function getExplicitColWidth(col, th) {
    var colWidth = readExplicitWidth(col);
    return colWidth !== null ? colWidth : readExplicitWidth(th);
  }

  function backupOriginalStyle(el, prop) {
    if (!el || !el.style) return;
    if (!el._dbsextOrigStyles) el._dbsextOrigStyles = {};
    if (el._dbsextOrigStyles[prop] === undefined) {
      var val = '';
      var prio = '';
      if (typeof el.style.getPropertyValue === 'function') {
        val = el.style.getPropertyValue(prop) || '';
      } else {
        var camel = prop === 'min-width' ? 'minWidth' : (prop === 'max-width' ? 'maxWidth' : prop);
        val = el.style[camel] || '';
      }
      if (typeof el.style.getPropertyPriority === 'function') {
        prio = el.style.getPropertyPriority(prop) || '';
      }
      el._dbsextOrigStyles[prop] = { val: val, prio: prio };
    }
  }

  function restoreOriginalStyle(el, prop) {
    if (!el || !el.style || !el._dbsextOrigStyles) return;
    var orig = el._dbsextOrigStyles[prop];
    if (orig) {
      if (orig.val) {
        if (typeof el.style.setProperty === 'function') {
          el.style.setProperty(prop, orig.val, orig.prio);
        } else {
          var camel = prop === 'min-width' ? 'minWidth' : (prop === 'max-width' ? 'maxWidth' : prop);
          el.style[camel] = orig.val;
        }
      } else {
        if (typeof el.style.removeProperty === 'function') {
          el.style.removeProperty(prop);
        } else {
          var cName = prop === 'min-width' ? 'minWidth' : (prop === 'max-width' ? 'maxWidth' : prop);
          delete el.style[cName];
        }
      }
      delete el._dbsextOrigStyles[prop];
    }
  }

  function restoreWidthStyles(el) {
    if (!el) return;
    restoreOriginalStyle(el, 'width');
    restoreOriginalStyle(el, 'min-width');
    restoreOriginalStyle(el, 'max-width');
  }

  /**
   * 推奨幅を、対象要素自身の明示元幅が推奨値より大きい場合だけ適用する。
   * 要素自身の元幅が不明、同値、または小さい場合は元スタイルへ戻すため、
   * どの要素にも幅を広げる書き込みをしない。
   */
  function applyShrinkOnlyWidth(el, targetWidth, inheritedColumnWidth) {
    if (!el || !el.style || !(targetWidth > 0)) return;
    var explicitWidth = readExplicitWidth(el);
    // th/td に個別の幅指定が無い場合は、同じ列の col 幅を元幅として扱う。
    // 逆に col 幅も不明なら fail-closed とし、要素へ幅を書き込まない。
    if (explicitWidth === null && inheritedColumnWidth !== null && inheritedColumnWidth !== undefined) {
      explicitWidth = inheritedColumnWidth;
    }
    if (explicitWidth === null || explicitWidth <= targetWidth) {
      restoreWidthStyles(el);
      return;
    }

    var widthString = targetWidth + 'px';
    backupOriginalStyle(el, 'width');
    backupOriginalStyle(el, 'min-width');
    backupOriginalStyle(el, 'max-width');
    el.style.setProperty('width', widthString, 'important');
    el.style.setProperty('min-width', widthString, 'important');
    el.style.setProperty('max-width', widthString, 'important');
  }

  /**
   * 単一テーブルの列幅・操作列表示の適用（静的CSS方式・表全体幅設定なし・真のno-op・縮小専用）
   */
  function applyTableWidths(table, actionIndices, showActionCols, autoFitEnabled) {
    if (!table) return;

    var headerTable = table.querySelector('table.el-table__header');
    var bodyTable = table.querySelector('table.el-table__body');
    if (!headerTable || !bodyTable) return;

    var screen = getScreen();
    var isMultiHeader = isMultiRowOrSpanHeader(headerTable);
    if (isMultiHeader) return;

    var isValidTarget = validateTargetTable(table, screen, headerTable, bodyTable);
    var hasExistingStaticWidths = !!table._dbsextStaticWidthsApplied;
    var allBodyRows = bodyTable.querySelectorAll('tbody tr');
    var isRowCountValid = allBodyRows.length > 0;

    // 未知表・不正形状・0行・未適用表には一切触らない（真の no-op: REMARK-TABLE-01）
    if (!isValidTarget) {
      return;
    }

    var headerCols = headerTable.querySelectorAll('colgroup col');
    var bodyCols = bodyTable.querySelectorAll('colgroup col');
    var headerRows = headerTable.querySelectorAll('thead tr, tr');
    var headerThs = headerRows.length > 0 ? headerRows[0].children : [];
    var colCount = headerCols.length;
    if (colCount === 0) return;

    var canApplyStaticWidths = autoFitEnabled && isValidTarget && isRowCountValid;

    // 1. 操作列の表示/非表示 (display: none) および旧オートフィット幅の安全な解除 (REMARK-M2-MIGRATION)
    if (isValidTarget) {
      var isActionHidden = function (idx) {
        if (showActionCols) return false;
        for (var k = 0; k < actionIndices.length; k++) {
          if (actionIndices[k] === idx) return true;
        }
        return false;
      };

      for (var i = 0; i < colCount; i++) {
        var isActionCol = false;
        for (var a = 0; a < actionIndices.length; a++) {
          if (actionIndices[a] === i) {
            isActionCol = true;
            break;
          }
        }

        var hidden = isActionHidden(i);

        if (headerCols[i]) {
          if (hidden) {
            headerCols[i].style.setProperty('display', 'none', 'important');
          } else if (headerCols[i].style && headerCols[i].style.display === 'none') {
            headerCols[i].style.removeProperty('display');
          }
          // REMARK-M2-MIGRATION: 由来が判定できる旧オートフィットの幅のみを復元・解除
          if (isActionCol && !hidden) {
            if (headerCols[i].hasAttribute && headerCols[i].hasAttribute('data-dbsext-orig-width')) {
              var origW = headerCols[i].getAttribute('data-dbsext-orig-width');
              if (origW) {
                headerCols[i].setAttribute('width', origW);
                if (headerCols[i].style) headerCols[i].style.width = origW;
              } else {
                headerCols[i].removeAttribute('width');
                if (headerCols[i].style) headerCols[i].style.removeProperty('width');
              }
              headerCols[i].removeAttribute('data-dbsext-orig-width');
            } else if (headerCols[i].hasAttribute && headerCols[i].hasAttribute('data-dbsext-autofit-orig-style')) {
              headerCols[i].removeAttribute('width');
              if (headerCols[i].style) headerCols[i].style.removeProperty('width');
              headerCols[i].removeAttribute('data-dbsext-autofit-orig-style');
            }
          }
        }

        if (bodyCols[i]) {
          if (hidden) {
            bodyCols[i].style.setProperty('display', 'none', 'important');
          } else if (bodyCols[i].style && bodyCols[i].style.display === 'none') {
            bodyCols[i].style.removeProperty('display');
          }
          if (isActionCol && !hidden) {
            if (bodyCols[i].hasAttribute && bodyCols[i].hasAttribute('data-dbsext-orig-width')) {
              var origBw = bodyCols[i].getAttribute('data-dbsext-orig-width');
              if (origBw) {
                bodyCols[i].setAttribute('width', origBw);
                if (bodyCols[i].style) bodyCols[i].style.width = origBw;
              } else {
                bodyCols[i].removeAttribute('width');
                if (bodyCols[i].style) bodyCols[i].style.removeProperty('width');
              }
              bodyCols[i].removeAttribute('data-dbsext-orig-width');
            } else if (bodyCols[i].hasAttribute && bodyCols[i].hasAttribute('data-dbsext-autofit-orig-style')) {
              bodyCols[i].removeAttribute('width');
              if (bodyCols[i].style) bodyCols[i].style.removeProperty('width');
              bodyCols[i].removeAttribute('data-dbsext-autofit-orig-style');
            }
          }
        }

        if (headerThs[i]) {
          if (hidden) {
            headerThs[i].style.setProperty('display', 'none', 'important');
          } else if (headerThs[i].style && headerThs[i].style.display === 'none') {
            headerThs[i].style.removeProperty('display');
          }
        }

        for (var vr = 0; vr < allBodyRows.length; vr++) {
          var td = allBodyRows[vr].children[i];
          if (td) {
            if (hidden) {
              td.style.setProperty('display', 'none', 'important');
            } else if (td.style && td.style.display === 'none') {
              td.style.removeProperty('display');
            }
          }
        }
      }
    }

    // 2. 静的推奨幅の適用（明示された元幅より狭める場合のみ縮小）または元値復元
    if (canApplyStaticWidths) {
      table._dbsextStaticWidthsApplied = true;

      for (var c = 0; c < colCount; c++) {
        if (actionIndices.indexOf(c) !== -1 && !showActionCols) {
          continue;
        }

        var th = headerThs[c];
        var thTitle = headerName(th);
        var targetWidth = getRecommendedColWidth(screen, c, thTitle);
        // 推奨値は各要素自身の明示元幅と比較する。col だけでなく body col / th / td
        // も個別に判定し、元幅が推奨値以下の要素を targetWidth へ広げない。
        if (targetWidth !== null && targetWidth > 0) {
          var headerColumnWidth = getExplicitColWidth(headerCols[c], th);
          var bodyColumnWidth = readExplicitWidth(bodyCols[c]);
          var isUserSummaryCol = headerCols[c] && headerCols[c].getAttribute &&
            headerCols[c].getAttribute('data-dbsext-user-summary-col');
          // user-summaryが追加したcolは専用の固定幅を持つため、既存表向けの
          // shrink-only復元処理で幅を消さない。
          if (!isUserSummaryCol) {
            applyShrinkOnlyWidth(headerCols[c], targetWidth);
            applyShrinkOnlyWidth(bodyCols[c], targetWidth);
          }
          applyShrinkOnlyWidth(th, targetWidth, headerColumnWidth);
          for (var cellIdx = 0; cellIdx < allBodyRows.length; cellIdx++) {
            applyShrinkOnlyWidth(allBodyRows[cellIdx].children[c], targetWidth, bodyColumnWidth);
          }
        }
      }
    } else if (hasExistingStaticWidths && !autoFitEnabled) {
      // 過去に本モジュールが適用した表で、推奨幅がOFFにされた場合のみ元値へ復元 (REMARK-TABLE-01)
      table._dbsextStaticWidthsApplied = false;

      for (var rIdx = 0; rIdx < colCount; rIdx++) {
        if (headerCols[rIdx]) {
          restoreOriginalStyle(headerCols[rIdx], 'width');
          restoreOriginalStyle(headerCols[rIdx], 'min-width');
          restoreOriginalStyle(headerCols[rIdx], 'max-width');
        }
        if (bodyCols[rIdx]) {
          restoreOriginalStyle(bodyCols[rIdx], 'width');
          restoreOriginalStyle(bodyCols[rIdx], 'min-width');
          restoreOriginalStyle(bodyCols[rIdx], 'max-width');
        }
        if (headerThs[rIdx]) {
          restoreOriginalStyle(headerThs[rIdx], 'width');
          restoreOriginalStyle(headerThs[rIdx], 'min-width');
          restoreOriginalStyle(headerThs[rIdx], 'max-width');
        }
        for (var clrIdxAll = 0; clrIdxAll < allBodyRows.length; clrIdxAll++) {
          var clrTdAll = allBodyRows[clrIdxAll].children[rIdx];
          if (clrTdAll) {
            restoreOriginalStyle(clrTdAll, 'width');
            restoreOriginalStyle(clrTdAll, 'min-width');
            restoreOriginalStyle(clrTdAll, 'max-width');
          }
        }
      }
    }
  }

  function findExistingToggleUI(table) {
    if (!table) return null;
    if (table._dbsextToggleUI && table._dbsextToggleUI.parentNode) {
      return table._dbsextToggleUI;
    }
    if (table.previousElementSibling && table.previousElementSibling.hasAttribute && table.previousElementSibling.hasAttribute(UI_CONTAINER_ATTR)) {
      return table.previousElementSibling;
    }
    if (table.parentNode && table.parentNode.children) {
      var children = table.parentNode.children;
      var idx = children.indexOf ? children.indexOf(table) : -1;
      if (idx === -1) {
        for (var c = 0; c < children.length; c++) {
          if (children[c] === table) { idx = c; break; }
        }
      }
      if (idx > 0 && children[idx - 1].hasAttribute && children[idx - 1].hasAttribute(UI_CONTAINER_ATTR)) {
        return children[idx - 1];
      }
    }
    return null;
  }

  /**
   * 表上部にトグルバー（操作列たたむ / 推奨列幅）を設置
   */
  function ensureToggleUI(table, showActionCols, autoFitEnabled, hasActionCols, isTargetScreen) {
    if (!table || !table.parentNode) return;

    var existing = findExistingToggleUI(table);
    if (existing) {
      var actionInput = existing.querySelector('[' + TOGGLE_INPUT_ATTR + ']');
      if (actionInput) {
        actionInput.checked = !showActionCols; // チェック = たたむ
      }
      var autoFitInput = existing.querySelector('[' + AUTOFIT_TOGGLE_ATTR + ']');
      if (autoFitInput) {
        autoFitInput.checked = !!autoFitEnabled;
      }
      return;
    }

    // 対象画面でない、かつ操作列もない場合はトグルバー自体を不要とする
    if (!isTargetScreen && !hasActionCols) return;

    var bar = document.createElement('div');
    bar.setAttribute(UI_CONTAINER_ATTR, '1');
    bar.style.cssText =
      'display:flex; align-items:center; justify-content:flex-end; gap:16px; padding:4px 8px; margin-bottom:4px; font-size:13px;';

    // 1. 推奨列幅トグル（対象画面のみ表示）
    if (isTargetScreen) {
      var autoFitLabel = document.createElement('label');
      autoFitLabel.style.cssText =
        'display:inline-flex; align-items:center; cursor:pointer; color:#303133; font-weight:500; user-select:none;';

      var autoFitCheckbox = document.createElement('input');
      autoFitCheckbox.type = 'checkbox';
      autoFitCheckbox.setAttribute(AUTOFIT_TOGGLE_ATTR, '1');
      autoFitCheckbox.checked = !!autoFitEnabled;
      autoFitCheckbox.style.cssText =
        'margin-right:6px; cursor:pointer; accent-color:#0b5cab; width:15px; height:15px;';

      autoFitCheckbox.addEventListener('change', function () {
        var currentScreen = getScreen();
        var newAutoFit = autoFitCheckbox.checked;
        saveAutoFitState(currentScreen, newAutoFit);
        var currentShow = loadToggleState(currentScreen);
        reapplyCurrentScreen(currentShow, newAutoFit);
      });

      var autoFitSpan = document.createElement('span');
      autoFitSpan.textContent = '推奨列幅';

      autoFitLabel.appendChild(autoFitCheckbox);
      autoFitLabel.appendChild(autoFitSpan);
      bar.appendChild(autoFitLabel);
    }

    // 2. 操作列トグル（操作列がある場合のみ表示）
    if (hasActionCols) {
      var actionLabel = document.createElement('label');
      actionLabel.style.cssText =
        'display:inline-flex; align-items:center; cursor:pointer; color:#303133; font-weight:500; user-select:none;';

      var actionCheckbox = document.createElement('input');
      actionCheckbox.type = 'checkbox';
      actionCheckbox.setAttribute(TOGGLE_INPUT_ATTR, '1');
      actionCheckbox.checked = !showActionCols; // チェック = たたむ
      actionCheckbox.style.cssText =
        'margin-right:6px; cursor:pointer; accent-color:#0b5cab; width:15px; height:15px;';

      actionCheckbox.addEventListener('change', function () {
        var currentScreen = getScreen();
        var newShow = !actionCheckbox.checked;
        saveToggleState(currentScreen, newShow);
        var currentAutoFit = loadAutoFitState(currentScreen);
        reapplyCurrentScreen(newShow, currentAutoFit);
      });

      var actionSpan = document.createElement('span');
      actionSpan.textContent = '操作列をたたむ';

      actionLabel.appendChild(actionCheckbox);
      actionLabel.appendChild(actionSpan);
      bar.appendChild(actionLabel);
    }

    table._dbsextToggleUI = bar;
    table.parentNode.insertBefore(bar, table);
  }

  /**
   * 拡張が付与した dbsext-sticky-right クラスを安全に除去する。
   * ポータル自身が最初から持っていたクラスは触らず、拡張自身が付与した要素（所有権記録）のみ除去する。
   * 未知の表（一度も sticky を付与していない表）に対しては DOM を一切触らない（真の no-op: REMARK-W2R2-02）。
   */
  function cleanupStickyRight(table) {
    if (!table) return;
    if (table._dbsextStickyOwnedElements) {
      var owned = table._dbsextStickyOwnedElements;
      for (var i = 0; i < owned.length; i++) {
        var el = owned[i];
        if (el && el.classList && typeof el.classList.remove === 'function') {
          el.classList.remove('dbsext-sticky-right');
        }
      }
    }
    delete table._dbsextStickyOwnedElements;
    delete table._dbsextStickyElements;
    delete table._dbsextStickyApplied;
  }

  function clearSelectionMarker(table) {
    if (!table) return;
    if (table.classList && typeof table.classList.remove === 'function') {
      table.classList.remove('dbsext-has-selection');
    }
    if (typeof table.removeAttribute === 'function') {
      table.removeAttribute('data-dbsext-has-selection');
    }
  }

  function setSelectionMarker(table, hasSelectionCol) {
    if (!table) return;
    if (hasSelectionCol) {
      if (table.classList && typeof table.classList.add === 'function') {
        table.classList.add('dbsext-has-selection');
      }
      if (typeof table.setAttribute === 'function') {
        table.setAttribute('data-dbsext-has-selection', '1');
      }
    } else {
      clearSelectionMarker(table);
    }
  }

  function processSingleTable(table, show, fit) {
    if (!table) return;
    if (table.getAttribute('data-dbsext-table') === 'custom' ||
        table.getAttribute('data-dbsext-vp-table') ||
        table.getAttribute('data-dbsext-beacons-table')) {
      clearSelectionMarker(table);
      return;
    }

    var headerTable = table.querySelector('table.el-table__header');
    var bodyTable = table.querySelector('table.el-table__body');
    if (!headerTable || !bodyTable) {
      clearSelectionMarker(table);
      cleanupStickyRight(table);
      return;
    }

    var screen = getScreen();
    var isMultiHeader = isMultiRowOrSpanHeader(headerTable);
    if (isMultiHeader) {
      clearSelectionMarker(table);
      cleanupStickyRight(table);
      return;
    }

    var isValidTarget = validateTargetTable(table, screen, headerTable, bodyTable);
    // 未知表・不正形状・0行・多段ヘッダのテーブルに対しては DOM / UI / refresh を一切触らない（真の no-op: REMARK-TABLE-01）
    // ただし過去に拡張が class を付与していた場合は、自前 sticky class のみ安全にクリーンアップする (REMARK-W2R2-02)
    if (!isValidTarget) {
      clearSelectionMarker(table);
      cleanupStickyRight(table);
      return;
    }

    var actionIndices = findActionColumnIndices(headerTable);
    var hasActionCols = actionIndices.length > 0;

    ensureToggleUI(
      table,
      show,
      fit,
      hasActionCols,
      true
    );

    var existingUI = findExistingToggleUI(table);
    if (existingUI) {
      var aIn = existingUI.querySelector('[' + TOGGLE_INPUT_ATTR + ']');
      if (aIn) aIn.checked = !show;
      var afIn = existingUI.querySelector('[' + AUTOFIT_TOGGLE_ATTR + ']');
      if (afIn) afIn.checked = !!fit;
    }

    var headerRows = headerTable.querySelectorAll('thead tr, tr');
    var firstTh = (headerRows.length > 0 && headerRows[0].children.length > 0) ? headerRows[0].children[0] : null;
    var hasSelectionCol = hasCheckboxLike(firstTh);
    setSelectionMarker(table, hasSelectionCol);

    applyTableWidths(table, actionIndices, show, fit);
    applyStickyRight(table, screen, headerTable, bodyTable);

    // 実際に幅や操作列の変更・復元を行ったテーブルに対してのみ refresh を呼ぶ (REMARK-TABLE-01)
    if (D.tableWrap && typeof D.tableWrap.refresh === 'function') {
      D.tableWrap.refresh(table);
    }
  }

  /**
   * /users 画面で「利用明細」列を右端 sticky に設定する自前クラスを付与 (W2)
   */
  function applyStickyRight(table, screen, headerTable, bodyTable) {
    if (!table) return;
    if (!headerTable || !bodyTable) {
      cleanupStickyRight(table);
      return;
    }
    var normScreen = normalizePath(screen).toLowerCase();
    if (normScreen !== '/users') {
      cleanupStickyRight(table);
      return;
    }

    var headerRows = headerTable.querySelectorAll('thead tr, tr');
    if (headerRows.length !== 1) {
      cleanupStickyRight(table);
      return;
    }
    var headerThs = headerRows[0].children;
    var colCount = headerThs.length;
    if (colCount === 0) {
      cleanupStickyRight(table);
      return;
    }

    var matchIndices = [];
    for (var i = 0; i < colCount; i++) {
      if (headerName(headerThs[i]) === '利用明細') {
        matchIndices.push(i);
      }
    }

    // 見出し「利用明細」が一意でない場合は cleanup して no-op (fail-closed)
    if (matchIndices.length !== 1) {
      cleanupStickyRight(table);
      return;
    }
    var stickyIdx = matchIndices[0];

    var allBodyRows = bodyTable.querySelectorAll('tbody tr');
    if (allBodyRows.length === 0) {
      cleanupStickyRight(table);
      return;
    }

    // headerTh および全 body 行の同 index cell が存在することを検証
    if (!headerThs[stickyIdx]) {
      cleanupStickyRight(table);
      return;
    }
    for (var r = 0; r < allBodyRows.length; r++) {
      if (!allBodyRows[r].children || !allBodyRows[r].children[stickyIdx]) {
        cleanupStickyRight(table);
        return;
      }
    }

    var targetElements = [];
    targetElements.push(headerThs[stickyIdx]);
    for (var br = 0; br < allBodyRows.length; br++) {
      targetElements.push(allBodyRows[br].children[stickyIdx]);
    }

    // 以前拡張が付与した要素 (owned) のうち、今回対象外となった要素があれば class 除去
    var previousOwned = table._dbsextStickyOwnedElements || [];
    var nextOwned = [];
    for (var o = 0; o < previousOwned.length; o++) {
      var oldEl = previousOwned[o];
      if (targetElements.indexOf(oldEl) === -1) {
        if (oldEl && oldEl.classList && typeof oldEl.classList.remove === 'function') {
          oldEl.classList.remove('dbsext-sticky-right');
        }
      } else {
        nextOwned.push(oldEl);
      }
    }

    // 今回の対象要素に class 付与（元から class を持っていた要素は owned に含めず、持っていなかった要素のみ add して owned に記録）
    for (var t = 0; t < targetElements.length; t++) {
      var targetEl = targetElements[t];
      if (targetEl && targetEl.classList) {
        if (!targetEl.classList.contains('dbsext-sticky-right')) {
          if (typeof targetEl.classList.add === 'function') {
            targetEl.classList.add('dbsext-sticky-right');
          }
          nextOwned.push(targetEl);
        }
      }
    }

    table._dbsextStickyOwnedElements = nextOwned;
    table._dbsextStickyElements = targetElements;
    table._dbsextStickyApplied = true;
  }

  function reapplyCurrentScreen(overrideShow, overrideAutoFit) {
    if (typeof document === 'undefined') return;
    var currentScreen = getScreen();
    var show = (typeof overrideShow === 'boolean') ? overrideShow : loadToggleState(currentScreen);
    var fit = (typeof overrideAutoFit === 'boolean') ? overrideAutoFit : loadAutoFitState(currentScreen);

    var tables = document.querySelectorAll('.el-table');
    if (!tables || tables.length === 0) return;

    for (var t = 0; t < tables.length; t++) {
      processSingleTable(tables[t], show, fit);
    }
  }

  var isApplying = false;

  D.tableColumns = {
    ACTION_COLUMNS: ACTION_COLUMNS,
    STATIC_COLUMN_RECOMMENDATIONS: STATIC_COLUMN_RECOMMENDATIONS,
    STORAGE_FEATURE: STORAGE_FEATURE,
    STORAGE_FEATURE_AUTOFIT: STORAGE_FEATURE_AUTOFIT,

    apply: function () {
      if (typeof document === 'undefined') return;
      if (isApplying) return;
      isApplying = true;

      try {
        var screen = getScreen();
        var tables = document.querySelectorAll('.el-table');
        if (!tables || tables.length === 0) return;

        var showActionCols = loadToggleState(screen);
        var autoFitEnabled = loadAutoFitState(screen);

        for (var t = 0; t < tables.length; t++) {
          processSingleTable(tables[t], showActionCols, autoFitEnabled);
        }
      } finally {
        isApplying = false;
      }
    },

    /**
     * 「オリジナルに戻す」表示専用。保存済みの表示設定は変えず、
     * 一時的に全列表示・静的列幅OFFの純正状態へ戻す。
     */
    peekShowAll: function () {
      if (typeof document === 'undefined') return;
      var tables = document.querySelectorAll ? document.querySelectorAll('.el-table') : [];
      for (var i = 0; i < tables.length; i++) {
        var table = tables[i];
        if (table.getAttribute('data-dbsext-table') === 'custom' ||
            table.getAttribute('data-dbsext-vp-table') ||
            table.getAttribute('data-dbsext-beacons-table')) {
          continue;
        }
        var headerTable = table.querySelector('table.el-table__header');
        var actionIndices = findActionColumnIndices(headerTable);
        applyTableWidths(table, actionIndices, true, false);
      }
    },

    /** 「オリジナルに戻す」を解除し、保存済みの最新表示設定へ戻す */
    peekRestore: function () {
      reapplyCurrentScreen();
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
  var SORT_ROW_ATTR = 'data-dbsext-table-sort-row';

  function kit() {
    return D.tableKit;
  }

  function hasActiveFilter(state) {
    return kit().hasAnyCondition(state.conditions);
  }

  function rowCheckbox(row) {
    return row && row.querySelector ? row.querySelector('input[type=checkbox]') : null;
  }

  function isVehicleSelectionHeader(pathname, colIndex, th) {
    if (!/^\/vehicles\/?$/.test(pathname || '') || colIndex !== 0 || !th || typeof th.querySelector !== 'function') {
      return false;
    }
    return !!th.querySelector('input[type=checkbox], .el-checkbox, .el-checkbox__input');
  }

  function removeOwnedHeaderControls(th, state, colIndex) {
    var controls = th && th.__dbsextControls;
    if (controls) {
      var owned = [controls.sortEl, controls.filterWrap];
      for (var i = 0; i < owned.length; i++) {
        var node = owned[i];
        if (node && node.parentNode === th && typeof th.removeChild === 'function') {
          th.removeChild(node); // dbsext:own-ui
        }
      }
      th.__dbsextControls = null;
    }
    if (state && state.conditions) state.conditions[colIndex] = null;
    if (state && state.sortColIndex === colIndex) {
      state.sortColIndex = null;
      state.sortOrder = null;
    }
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

  function runSuppressed(fn) {
    if (D.core && typeof D.core.runSuppressed === 'function') {
      D.core.runSuppressed('table-tools', fn);
    } else {
      fn();
    }
  }

  /**
   * USER_SCRIPT 経路では、ポータル側の MAIN world が childList を監視している。
   * 既存の tr を appendChild で並べ替える操作は通常の拡張UIではないため、
   * appendChild の MutationRecord が bridge の「ポータル変更」判定に入らないよう
   * 行へ一時的な mark 属性を付ける。
   *
   * 属性は MutationObserver の childList/characterData 監視対象外なので、0ms後に
   * 外しても通知を増やさない。MutationObserver のコールバックは現在のJSスタック
   * 後に実行されるため、コールバックが addedNodes を検査する時点では印が残る。
   */
  function appendSortedRows(tbody, trArray) {
    var marked = [];
    for (var i = 0; i < trArray.length; i++) {
      var row = trArray[i];
      if (!row || typeof row.setAttribute !== 'function') continue;
      var alreadyMarked = typeof row.hasAttribute === 'function' && row.hasAttribute(SORT_ROW_ATTR);
      if (!alreadyMarked) {
        row.setAttribute(SORT_ROW_ATTR, '1');
        marked.push(row);
      }
    }

    var appendRows = function () {
      for (var k = 0; k < trArray.length; k++) {
        tbody.appendChild(trArray[k]);
      }
      return true;
    };

    try {
      if (D.core && typeof D.core.runSuppressed === 'function') {
        // MAIN world bridge の次回通知を、今回の appendChild 移動分として消費する。
        D.core.runSuppressed('table-tools-sort', appendRows, true);
      } else {
        appendRows();
      }
    } finally {
      var clearMarks = function () {
        for (var m = 0; m < marked.length; m++) {
          var markedRow = marked[m];
          if (markedRow && typeof markedRow.removeAttribute === 'function') {
            markedRow.removeAttribute(SORT_ROW_ATTR);
          }
        }
      };
      if (marked.length > 0 && typeof setTimeout === 'function') {
        setTimeout(clearMarks, 0);
      } else {
        clearMarks();
      }
    }
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

      var currentTrs = tbody.children;
      var needsReorder = false;
      for (var cIdx = 0; cIdx < trArray.length; cIdx++) {
        if (currentTrs[cIdx] !== trArray[cIdx]) {
          needsReorder = true;
          break;
        }
      }
      if (needsReorder) {
        appendSortedRows(tbody, trArray);
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

  function buildPortalHeaderControls(table, state, ths, colIndex, targetTh) {
    var origTitle = targetTh.getAttribute('data-dbsext-orig-title') || targetTh.textContent.trim();
    targetTh.setAttribute('data-dbsext-orig-title', origTitle);

    return kit().buildHeaderControls({
      columnLabel: origTitle,
      sortMode: 'indicator',
      onSort: function () {
        runSuppressed(function () {
          if (state.sortColIndex === colIndex) {
            state.sortOrder = (state.sortOrder === 'asc') ? 'desc' : 'asc';
          } else {
            state.sortColIndex = colIndex;
            state.sortOrder = 'asc';
          }
          updateHeaderUI(ths, state);
          applyFilterAndSort(table, state, ths);
        });
      },
      onFilter: function (condition) {
        runSuppressed(function () {
          state.conditions[colIndex] = condition;
          applyFilterAndSort(table, state, ths);
        });
      }
    });
  }

  /**
   * 表ごとの初回並び替えを決める。
   *
   * 問題申告一覧は「最新申告日時」を初期状態から降順にする。ポート列を
   * 持つ表は従来どおりポート名の昇順、それ以外は未ソートのままにする。
   * 見出しの文言はポータルの版によって単位・補足が付くことがあるため、
   * 完全一致ではなく特徴語で判定する。
   */
  function defaultSortForHeaders(ths) {
    for (var i = 0; i < ths.length; i++) {
      var problemTitle = ths[i].getAttribute('data-dbsext-orig-title') || ths[i].textContent.trim();
      if (problemTitle.indexOf('最新申告日時') !== -1 || problemTitle.indexOf('問題申告日時') !== -1) {
        return { sortColIndex: i, sortOrder: 'desc' };
      }
    }
    for (var j = 0; j < ths.length; j++) {
      var portTitle = ths[j].getAttribute('data-dbsext-orig-title') || ths[j].textContent.trim();
      if (kit().isPortColumn(portTitle)) {
        return { sortColIndex: j, sortOrder: 'asc' };
      }
    }
    return { sortColIndex: null, sortOrder: null };
  }

  D.tableTools = {
    // 互換のため残す。実装は table-kit にある（自前表からも同じ順序を使うため）
    portSortKey: function (name) { return kit().portSortKey(name); },

    // 検証用。DOMを伴うフィルタ／選択連動を実ブラウザ無しでも再現する。
    _applyFilterAndSort: applyFilterAndSort,
    _hookVisibleSelectAll: hookVisibleSelectAll,
    _defaultSortForHeaders: defaultSortForHeaders,
    _isVehicleSelectionHeader: isVehicleSelectionHeader,

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

          // 問題申告日時は最新を先頭、それ以外のポート表はポート名を昇順。
          var defaultSort = defaultSortForHeaders(ths);
          tableStates[stateKey].sortColIndex = defaultSort.sortColIndex;
          tableStates[stateKey].sortOrder = defaultSort.sortOrder;
        }

        var state = tableStates[stateKey];
        hookVisibleSelectAll(table, state);

        if (!table.hasAttribute('data-dbsext-tabled')) {
          table.setAttribute('data-dbsext-tabled', '1');
        }

        for (var c = 0; c < ths.length; c++) {
          var thNode = ths[c];
          // 車両情報の先頭列は純正の行選択チェックボックス専用。
          // 絞り込み入力・並べ替えUIは意味がなくヘッダ高だけを増やすため付けない。
          // 旧remote bundleが既に付けていた場合も、純正checkboxを残して拡張UIだけ除去する。
          if (isVehicleSelectionHeader(pathname, c, thNode)) {
            removeOwnedHeaderControls(thNode, state, c);
            continue;
          }
          var existingControls = thNode.__dbsextControls;
          if (existingControls) {
            var sortAttached = existingControls.sortEl && existingControls.sortEl.parentNode === thNode;
            var filterAttached = existingControls.filterWrap && existingControls.filterWrap.parentNode === thNode;
            if (sortAttached && filterAttached) continue;

            // 部分再描画で片方だけ外れた場合は、残っている側をDOMから外さない。
            // 入力欄が残っていれば、その要素・フォーカス・選択範囲を保ったまま
            // 欠落した sort または filter だけを補充する。
            if (sortAttached || filterAttached) {
              var replacement = buildPortalHeaderControls(table, state, ths, c, thNode);
              if (!sortAttached) {
                thNode.appendChild(replacement.sortEl);
                existingControls.sortEl = replacement.sortEl;
                existingControls.updateSortIndicator = replacement.updateSortIndicator;
              }
              if (!filterAttached) {
                thNode.appendChild(replacement.filterWrap);
                existingControls.filterWrap = replacement.filterWrap;
                existingControls.syncFromState = replacement.syncFromState;
                existingControls.condition = replacement.condition;
                if (!state.conditions[c]) {
                  state.conditions[c] = replacement.condition;
                } else {
                  replacement.syncFromState(state.conditions[c]);
                }
              }
              thNode.__dbsextControls = existingControls;
              continue;
            }

            thNode.__dbsextControls = null;
          }
          (function (colIndex, targetTh) {
            var controls = buildPortalHeaderControls(table, state, ths, colIndex, targetTh);

            // 既定の条件を状態側にも置いておく（種類だけ先に決まる）
            if (!state.conditions[colIndex]) {
              state.conditions[colIndex] = controls.condition;
            } else {
              controls.syncFromState(state.conditions[colIndex]);
            }

            targetTh.__dbsextControls = controls;
            targetTh.appendChild(controls.sortEl);
            targetTh.appendChild(controls.filterWrap);
          })(c, thNode);
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

    /**
     * 現在「オリジナル表示」中かどうか。他モジュールが自分の定期再適用処理
     * （`core.js`の`reapplyAll()`から`apply()`のたびに走る処理）を、オリジナル
     * 表示中はスキップするために使う（例: `port-bulk-actions.js`が`apply()`のたびに
     * ポータル純正表を無条件で再び隠し、`peekShowAll()`で戻したはずの表示を
     * 次の再適用で壊してしまう回帰への対応。2026-08-12独立監査指摘）。
     */
    isActive: function () { return active; },

    // テスト・診断用
    _isActive: function () { return active; },
    _reset: function () { active = false; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : window);

