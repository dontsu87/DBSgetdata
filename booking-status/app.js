(function () {
  'use strict';

  var STATUS_URL = 'https://pub-1c068f2df9ab42a0b9dcc5d112078269.r2.dev/port_booking_status.json';
  var portsRoot = document.getElementById('ports');
  var message = document.getElementById('message');
  var updatedAt = document.getElementById('updated-at');
  var refresh = document.getElementById('refresh');
  var template = document.getElementById('port-template');

  function text(value) { return value == null || value === '' ? '—' : String(value); }
  function yesNo(value) { return value === true ? '有効' : value === false ? '無効' : '—'; }
  function reflectionStatus(value) {
    return ({ reflected: '予約一致（反映済み）', queued: '登録待ち', missing: '未反映', mismatch: '不一致' })[value] || '—';
  }
  function formatDate(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return text(value);
    return new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
  }
  function addCell(row, value) {
    var cell = document.createElement('td'); cell.textContent = text(value); row.appendChild(cell);
  }
  function renderTable(rows) {
    var wrap = document.createElement('div'); wrap.className = 'schedule-wrap';
    var table = document.createElement('table'); var head = document.createElement('tr');
    ['更新日時', '運用状態', '公開', '駐輪台数制限', '反映状況'].forEach(function (label) {
      var th = document.createElement('th'); th.textContent = label; head.appendChild(th);
    });
    var thead = document.createElement('thead'); thead.appendChild(head); table.appendChild(thead);
    var tbody = document.createElement('tbody');
    rows.forEach(function (item) {
      var row = document.createElement('tr');
      addCell(row, formatDate(item.update_reflection_datetime));
      addCell(row, item.service_state);
      addCell(row, item.publish_flag ? '公開' : '非公開');
      addCell(row, item.parking_quantity_limitation_flag ? '有効（上限' + text(item.parking_quantity_limit) + '台）' : '無効');
      addCell(row, reflectionStatus(item.reflection_status));
      tbody.appendChild(row);
    });
    table.appendChild(tbody); wrap.appendChild(table); return wrap;
  }
  function render(data) {
    portsRoot.textContent = '';
    var ports = data && Array.isArray(data.ports) ? data.ports : [];
    updatedAt.textContent = '最終確認: ' + formatDate(data && data.updated_at);
    message.textContent = ports.length ? '' : '表示対象のポートはありません。';
    ports.forEach(function (port) {
      var card = template.content.firstElementChild.cloneNode(true);
      card.querySelector('h2').textContent = text(port.name);
      var health = card.querySelector('.health');
      var healthy = port.status === 'in_sync' || port.status === 'created';
      health.textContent = healthy ? '予約一致' : '要確認';
      if (!healthy) health.classList.add('attention');
      var bookings = card.querySelector('.bookings');
      var rows = Array.isArray(port.schedule) ? port.schedule : (Array.isArray(port.bookings) ? port.bookings : []);
      if (!rows.length) {
        var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '現在、予約投稿はありません。';
        bookings.appendChild(empty);
      } else bookings.appendChild(renderTable(rows));
      portsRoot.appendChild(card);
    });
  }
  function load() {
    refresh.disabled = true; message.className = 'message'; message.textContent = '最新情報を取得しています…';
    return fetch(STATUS_URL + '?t=' + Date.now(), { cache: 'no-store' })
      .then(function (response) { if (!response.ok) throw new Error('HTTP ' + response.status); return response.json(); })
      .then(render)
      .catch(function () { message.className = 'message error'; message.textContent = '予約情報を取得できませんでした。時間をおいて再読み込みしてください。'; })
      .finally(function () { refresh.disabled = false; });
  }
  refresh.addEventListener('click', load);
  load();
}());
