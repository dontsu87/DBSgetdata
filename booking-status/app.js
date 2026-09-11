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
  function formatDate(value) {
    var date = new Date(value);
    if (Number.isNaN(date.getTime())) return text(value);
    return new Intl.DateTimeFormat('ja-JP', {
      timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(date);
  }
  function addRow(list, label, value) {
    var dt = document.createElement('dt'); dt.textContent = label;
    var dd = document.createElement('dd'); dd.textContent = text(value);
    list.appendChild(dt); list.appendChild(dd);
  }
  function renderBooking(item, index) {
    var box = document.createElement('section'); box.className = 'booking';
    var label = document.createElement('p'); label.className = 'booking-label'; label.textContent = '更新予約 ' + (index + 1);
    var time = document.createElement('p'); time.className = 'booking-time'; time.textContent = formatDate(item.update_reflection_datetime);
    var state = document.createElement('dl'); state.className = 'state';
    addRow(state, '運用状態', item.service_state);
    addRow(state, '公開', yesNo(item.publish_flag));
    addRow(state, '駐輪台数制限', yesNo(item.parking_quantity_limitation_flag));
    if (item.parking_quantity_limitation_flag) addRow(state, '上限', text(item.parking_quantity_limit) + '台');
    box.appendChild(label); box.appendChild(time); box.appendChild(state);
    return box;
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
      var rows = Array.isArray(port.bookings) ? port.bookings : [];
      if (!rows.length) {
        var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '現在、予約投稿はありません。';
        bookings.appendChild(empty);
      } else rows.forEach(function (item, index) { bookings.appendChild(renderBooking(item, index)); });
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
