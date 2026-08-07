document.addEventListener('DOMContentLoaded', () => {
  const statusContainer = document.getElementById('bookmarklet-status-container');
  const bookmarkletLink = document.getElementById('bookmarklet-link');
  const bookmarkletText = document.getElementById('bookmarklet-text');
  const btnCopy = document.getElementById('btn-copy-bookmarklet');
  const copyMessage = document.getElementById('copy-message');
  const versionInfo = document.getElementById('version-info');
  const bookmarkletVersion = document.getElementById('bookmarklet-version');

  fetch('./bookmarklet.txt')
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response.text();
    })
    .then((data) => {
      const code = data.trim();
      if (!code) {
        throw new Error('Empty bookmarklet content');
      }

      // リンクとテキストエリアへの設定
      if (bookmarkletLink) {
        bookmarkletLink.href = code;
        bookmarkletLink.textContent = 'DBS拡張';
      }

      if (bookmarkletText) {
        bookmarkletText.value = code;
      }

      // 版番号の抽出。
      // bookmarklet.txt は javascript: URL としてエンコード済みで空白が %20 になっているため、
      // まずデコードしてから探す。ビルド後の実際の形は `D.VERSION = '0.1.0';`
      // （D は DBSEXT のローカル別名）なので、両方の書き方を拾えるようにする。
      let decoded = code;
      try {
        decoded = decodeURIComponent(code);
      } catch (e) {
        // 不正なエンコードでも版番号が出ないだけで、ページは壊さない
      }
      const versionMatch = decoded.match(/(?:DBSEXT|\bD)\.VERSION\s*=\s*["']([^"']+)["']/);
      if (versionMatch && versionMatch[1] && bookmarkletVersion) {
        bookmarkletVersion.textContent = versionMatch[1];
      } else if (versionInfo) {
        versionInfo.style.display = 'none';
      }

      // コピーボタンの設定
      if (btnCopy && bookmarkletText) {
        btnCopy.addEventListener('click', () => {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(bookmarkletText.value)
              .then(() => {
                if (copyMessage) {
                  copyMessage.textContent = 'クリップボードにコピーしました！';
                  setTimeout(() => {
                    copyMessage.textContent = '';
                  }, 3000);
                }
              })
              .catch(() => {
                fallbackSelectText();
              });
          } else {
            fallbackSelectText();
          }
        });
      }

      function fallbackSelectText() {
        bookmarkletText.focus();
        bookmarkletText.select();
        if (copyMessage) {
          copyMessage.textContent = 'テキストを選択しました。Ctrl+C (Cmd+C) でコピーしてください。';
          setTimeout(() => {
            copyMessage.textContent = '';
          }, 4000);
        }
      }
    })
    .catch(() => {
      // 読み込み失敗時は該当区画にエラーメッセージを表示
      if (statusContainer) {
        statusContainer.innerHTML = '<div class="fallback-message">最新版を準備中です。管理者にお問い合わせください</div>';
      }
    });
});
