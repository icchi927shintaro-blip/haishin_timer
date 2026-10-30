(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const control = !!$('enable');
  const params = new URLSearchParams(location.hash.slice(1));
  let room = params.get('room');
  if (!room && control) {
    room = crypto.randomUUID();
    location.hash = new URLSearchParams({ room }).toString();
  }
  const warn = message => {
    if (control) $('message').textContent = message;
    else { $('warning').textContent = message; $('warning').hidden = !message; }
  };
  if (!room || !/^[a-zA-Z0-9_-]{8,80}$/.test(room)) {
    warn('操作画面で作成された、ルームID付きの表示URLを使用してください'); return;
  }
  const key = 'haishin-design-v1:' + room + (control ? ':control' : ':display');
  window.addEventListener('hashchange', () => location.reload());
  const source = crypto.randomUUID();
  const topic = 'haishin-design/v1/' + room + '/state';
  const popupTopic = 'haishin-design/v1/' + room + '/popup';
  const ackTopic = 'haishin-design/v1/' + room + '/popup-ack';
  const fresh = () => ({
    version: 1, updatedAt: 0, source: '', scoreHome: 0, scoreAway: 0,
    clock: { baseMs: 0, startedAt: null, running: false, period: 1 },
    registration: { title: '', home: { name: 'HOME', color: '#187fc4', players: [] }, away: { name: 'AWAY', color: '#f5d321', players: [] } }
  });
  let state = null, active = false, connected = false, ready = false;
  let client, releaseLock;
  const validText = (v, max) => typeof v === 'string' && v.length <= max;
  function validate(s) {
    if (!s || s.version !== 1 || !Number.isSafeInteger(s.updatedAt) || s.updatedAt < 0 ||
      !validText(s.source, 80) || ![s.scoreHome, s.scoreAway].every(n => Number.isInteger(n) && n >= 0 && n <= 999))
      throw Error('試合データの形式が不正です');
    const c = s.clock;
    if (!c || !Number.isFinite(c.baseMs) || c.baseMs < 0 || c.baseMs > 86400000 ||
      typeof c.running !== 'boolean' || ![1, 2].includes(c.period) ||
      !(c.startedAt === null || (Number.isFinite(c.startedAt) && c.startedAt >= 0)) ||
      (c.running && c.startedAt === null)) throw Error('時計データが不正です');
    const r = s.registration;
    if (!r || !validText(r.title, 120)) throw Error('大会名が不正です');
    for (const side of ['home', 'away']) {
      const t = r[side], ids = new Set(), numbers = new Set();
      if (t && t.color !== undefined && !/^#[0-9a-f]{6}$/i.test(t.color)) throw Error('チームカラーが不正です');
      if (!t || !validText(t.name, 80) || !t.name.trim() || !Array.isArray(t.players) || t.players.length > 100)
        throw Error('チーム情報が不正です');
      for (const p of t.players) {
        if (!p || !validText(p.id, 80) || !p.id.trim() || ids.has(p.id) ||
          !validText(p.name, 80) || !p.name.trim() || !Number.isInteger(p.number) ||
          p.number < 0 || p.number > 999 || numbers.has(p.number) || typeof p.starter !== 'boolean')
          throw Error('選手ID・背番号の重複や、選手情報の形式を確認してください');
        ids.add(p.id); numbers.add(p.number);
      }
    }
  }
  const elapsed = s => s.clock.baseMs + (s.clock.running ? Math.max(0, Date.now() - s.clock.startedAt) : 0);
  const timeText = ms => {
    const sec = Math.floor(ms / 1000);
    return String(Math.floor(sec / 60)).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0');
  };
  function buttons() {
    if (!control) return;
    $('enable').disabled = !connected || !ready || active;
    document.querySelectorAll('[data-action], [data-popup]').forEach(b => b.disabled = !connected || !ready || !active);
    $('import').disabled = !connected || !active;
  }
  function registrationForm(force = false) {
    if (control && state) window.RosterEditor.receive(state.registration, force);
  }
  function render() {
    if (control) popupPreview();
    if (!state) return;
    const ms = elapsed(state);
    $('timer').textContent = timeText(ms);
    if (control) {
      $('score').textContent = state.scoreHome + ' - ' + state.scoreAway;
      $('teams').textContent = state.registration.home.name + ' / ' + state.registration.away.name;
      $('phase').textContent = (state.clock.period === 1 ? '前半' : '後半') + '・' + (state.clock.running ? '進行中' : '停止中');
    } else {
      $('score-home').textContent = state.scoreHome; $('score-away').textContent = state.scoreAway;
      paintTeams();
      $('timer-wrapper').classList.toggle('stoppage', ms >= (state.clock.period === 1 ? 2700000 : 5400000));
    }
  }

  function paintTeams() {
    for (const side of ['home', 'away']) {
      const team = state.registration[side];
      const color = team.color || (side === 'home' ? '#187fc4' : '#f5d321');
      $('team-' + side + '-label').textContent = team.name;
      const rgb = [1, 3, 5].map(i => parseInt(color.slice(i, i + 2), 16) / 255);
      const linear = rgb.map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
      const luminance = linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
      document.body.style.setProperty('--' + side + '-color', color);
      document.body.style.setProperty('--' + side + '-text', luminance > 0.179 ? '#111111' : '#ffffff');
    }
  }

  function save(s) { localStorage.setItem(key, JSON.stringify(s)); }
  function yieldControl() {
    active = false;
    if (releaseLock) { releaseLock(); releaseLock = null; }
    buttons();
  }
  function publish() {
    if (!client?.connected || !connected || !ready || !active || !state) return;
    // 選手登録情報は公開ブローカーへ送信しない。
    const wire = { ...state, registration: {
      title: state.registration.title,
      home: { name: state.registration.home.name, color: state.registration.home.color || '#187fc4', players: [] },
      away: { name: state.registration.away.name, color: state.registration.away.color || '#f5d321', players: [] }
    } };
    client.publish(topic, JSON.stringify(wire), { qos: 1, retain: true }, error => {
      if (error) warn('送信を確認できません。接続を確認してください');
    });
  }
  function commit(next) {
    validate(next);
    next.updatedAt = Math.max(Date.now(), (state?.updatedAt || 0) + 1);
    next.source = source;
    save(next); state = next; render(); publish();
  }
  try {
    if (control) window.RosterEditor.init(key);
    const saved = localStorage.getItem(key);
    if (saved) { state = JSON.parse(saved); validate(state); registrationForm(); render(); }
    else { state = fresh(); save(state); registrationForm(); render(); }
  } catch {
    warn('ブラウザー保存を利用できないか、保存データが不正です。別のルームIDで開いてください'); return;
  }
  if (control) {
    $('room').textContent = room;
    $('displayLink').href = './display_design.html#' + new URLSearchParams({ room });
    $('controlLink').href = './control_design.html#' + new URLSearchParams({ room });
    $('enable').onclick = async () => {
      if (active || !ready || !connected) return;
      if (!confirm('ほかの操作画面を閉じ、この画面で操作しますか？')) return;
      if (!navigator.locks) { warn('このブラウザーは操作ロックに未対応です。ChromeまたはEdgeを使用してください'); return; }
      await navigator.locks.request(key, { ifAvailable: true }, async lock => {
        if (!lock) { warn('同じ試合の操作画面が別タブで開いています'); return; }
        try {
          active = true; commit(structuredClone(state || fresh()));
          registrationForm(); warn(''); buttons();
          await new Promise(resolve => { releaseLock = resolve; });
        } catch (error) { yieldControl(); warn(error.message); }
      });
    };
    document.querySelectorAll('[data-action]').forEach(button => button.onclick = () => {
      if (!active || !connected) return;
      const action = button.dataset.action;
      if (['time', 'reset'].includes(action) && !confirm('得点または時間を変更しますか？')) return;
      try {
        const s = structuredClone(state), c = s.clock;
        if (action === 'start' && !c.running) { c.startedAt = Date.now(); c.running = true; }
        if (action === 'stop') { c.baseMs = elapsed(s); c.running = false; c.startedAt = null; }
        if (action === 'time') {
          c.baseMs = Number(button.dataset.seconds) * 1000; c.period = Number(button.dataset.period);
          c.startedAt = c.running ? Date.now() : null;
        }
        if (action === 'score') {
          const field = button.dataset.team === 'home' ? 'scoreHome' : 'scoreAway';
          s[field] = Math.max(0, Math.min(999, s[field] + Number(button.dataset.delta)));
        }
        if (action === 'reset') { s.scoreHome = 0; s.scoreAway = 0; }
        if (action === 'registration') s.registration = window.RosterEditor.value();
        commit(s);
        if (action === 'registration') registrationForm(true);
        warn(action === 'registration' ? '名簿を確定しました' : '保存しました');
      } catch (error) { warn(error.message); }
    });
    $('export').onclick = () => {
      if (!state) { warn('先に試合の操作を開始してください'); return; }
      const url = URL.createObjectURL(new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a'); a.href = url; a.download = 'match-' + room + '.json'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    $('import').onchange = async e => {
      const file = e.target.files[0]; if (!file) return;
      try {
        if (file.size > 1000000) throw Error('1MB以下のJSONを選択してください');
        const next = JSON.parse(await file.text()); validate(next);
        if (!active || !connected) throw Error('先にこの画面で操作を開始してください');
        if (confirm('現在の得点・時計・登録情報をファイルの内容で置き換えますか？')) {
          commit(next); registrationForm(true); warn('復元しました');
        }
      } catch (error) { warn(error.message); }
      e.target.value = '';
    };
    buttons();
  }
  if (!window.mqtt) { warn('通信ライブラリを読み込めません。ネット接続を確認して再読込してください'); return; }
  client = mqtt.connect('wss://broker.hivemq.com:8884/mqtt', {
    reconnectPeriod: 1000, connectTimeout: 10000, keepalive: 15,
    clean: true, queueQoSZero: false, clientId: 'hp-' + source
  });
  client.on('connect', () => {
    client.subscribe([topic, popupTopic, ackTopic], { qos: 1 }, error => {
      if (error || !client.connected) { warn('試合データの受信を開始できません'); return; }
      connected = true;
      if (control) $('status').textContent = '通信サーバー接続済み（OBSの接続確認ではありません）';
      setTimeout(() => { ready = true; buttons(); publish(); }, 1500);
    });
  });
  client.on('message', (t, message) => {
    if (t === popupTopic || t === ackTopic) { receivePopup(t, message); return; }
    if (t !== topic || message.length > 100000) return;
    try {
      const next = JSON.parse(message.toString()); validate(next);
      if (state && next.updatedAt <= state.updatedAt) return;
      if (active && next.source !== source) {
        yieldControl(); warn('別の画面から更新されました。操作を停止しました');
      }
      // MQTTには選手情報がないため、このブラウザーの登録選手を維持。
      if (state) for (const side of ['home', 'away'])
        next.registration[side].players = state.registration[side].players;
      save(next); state = next; render(); registrationForm();
    } catch (error) { warn('受信データを利用できません：' + error.message); }
  });
  function offline() {
    connected = false; ready = false;
    if (control) $('status').textContent = '通信切断・自動再接続中';
    buttons();
  }
  client.on('offline', offline); client.on('close', offline);
  client.on('error', () => { if (control) $('status').textContent = '通信エラー・自動再接続中'; });
  setInterval(() => { render(); publish(); }, 2000);
  setInterval(render, 100);

  // 一時表示は試合状態と分離。retainせず、再接続時にも再生しない。
  let popupTimer, ackTimer, pendingPopup = null, latestPopupAt = 0, lastSentAt = 0;
  const seenPopups = new Set();

  function popupLabel(kind) {
    return { goal: '得点', substitution: '選手交代' }[kind];
  }
  function selectedPlayer(inputId = 'popup-number') {
    if (!state) return null;
    const value = $(inputId).value.trim();
    if (!/^\d{1,3}$/.test(value)) return null;
    return state.registration[$('popup-team').value].players.find(p => p.number === Number(value)) || null;
  }
  function popupPreview() {
    if (!control) return;
    const side = $('popup-team').value;
    const substitution = $('popup-type').value === 'substitution';
    $('goal-input').hidden = substitution;
    $('sub-input').hidden = !substitution;
    $('popup-team').options[0].textContent = state?.registration.home.name || 'HOME';
    $('popup-team').options[1].textContent = state?.registration.away.name || 'AWAY';
    const prefix = (state?.registration[side].name || side.toUpperCase()) + ' / ';
    if (substitution) {
      const out = selectedPlayer('popup-out'), incoming = selectedPlayer('popup-in');
      $('popup-preview').textContent = !out || !incoming
        ? 'OUTとINの背番号を指定してください。確定済み名簿から呼び出します。'
        : out.number === incoming.number
          ? 'OUTとINには別の選手を指定してください。'
          : prefix + 'OUT ' + out.number + ' ' + out.name + ' → IN ' + incoming.number + ' ' + incoming.name;
    } else {
      const player = selectedPlayer();
      $('popup-preview').textContent = player
        ? prefix + player.number + ' ' + player.name + ' / 得点'
        : '得点者の背番号を入力してください。登録のない番号は表示できません。';
    }
  }
  function hidePopup() {
    if (control) return;
    clearTimeout(popupTimer);
    $('popup').classList.remove('visible');
    $('popup').setAttribute('aria-hidden', 'true');
  }
  function sendPopup(hide = false) {
    if (!active || !connected || !ready || !client.connected) return;
    try {
      const now = Math.max(Date.now(), lastSentAt + 1);
      lastSentAt = now;
      const event = { version: 1, id: crypto.randomUUID(), kind: 'hide', createdAt: now, expiresAt: now + 5000 };
      if (!hide) {

        const duration = Number($('popup-duration').value);
        if (![4000, 6000, 8000, 10000].includes(duration)) throw Error('表示時間が不正です');
        const kind = $('popup-type').value;
        if (!popupLabel(kind)) throw Error('表示内容が不正です');
        Object.assign(event, { kind, expiresAt: now + duration, team: state.registration[$('popup-team').value].name });
        const playerData = p => ({ number: p.number, name: p.name });
        if (kind === 'substitution') {
          const out = selectedPlayer('popup-out'), incoming = selectedPlayer('popup-in');
          if (!out || !incoming) throw Error('OUTまたはINの背番号が確定済み名簿にありません');
          if (out.number === incoming.number) throw Error('OUTとINには別の選手を指定してください');
          event.outPlayer = playerData(out); event.inPlayer = playerData(incoming);
        } else {
          const player = selectedPlayer();
          if (!player) throw Error('得点者の背番号が確定済み名簿にありません');
          event.player = playerData(player);
        }
      }
      clearTimeout(ackTimer);
      pendingPopup = event.id;
      $('popup-status').textContent = '送信中…';
      // QoS 0 + queueQoSZero:falseで、切断中の演出を後から送らない。
      client.publish(popupTopic, JSON.stringify(event), { qos: 0, retain: false }, error => {
        if (pendingPopup !== event.id) return;
        if (error) { $('popup-status').textContent = '送信できませんでした。接続を確認してください'; return; }
        $('popup-status').textContent = '送信しました。表示画面の受信を確認中…';
      });
      ackTimer = setTimeout(() => {
        if (pendingPopup === event.id) $('popup-status').textContent = '表示画面の受信を確認できません。同じルームのOBS表示を開いてください';
      }, 5000);
    } catch (error) {
      $('popup-status').textContent = error.message;
    }
  }
  function receivePopup(t, message) {
    if (message.length > 4000) return;
    try {
      const event = JSON.parse(message.toString());
      if (t === ackTopic) {
        if (control && event?.id === pendingPopup) {
          clearTimeout(ackTimer); pendingPopup = null;
          $('popup-status').textContent = '表示画面の受信を確認しました';
        }
        return;
      }
      if (control) return;
      const now = Date.now();
      if (!event || event.version !== 1 || !validText(event.id, 80) || !event.id ||
          !Number.isSafeInteger(event.createdAt) || !Number.isSafeInteger(event.expiresAt) ||
          event.createdAt > now + 5000 || event.expiresAt <= now ||
          event.expiresAt <= event.createdAt || event.expiresAt - event.createdAt > 10000 ||
          event.createdAt < latestPopupAt || seenPopups.has(event.id)) return;

      const playerOK = p => p && validText(p.name, 80) && p.name.trim() &&
        Number.isInteger(p.number) && p.number >= 0 && p.number <= 999;
      if (event.kind !== 'hide') {
        if (!popupLabel(event.kind) || !validText(event.team, 80)) return;
        if (event.kind === 'substitution') {
          if (!playerOK(event.outPlayer) || !playerOK(event.inPlayer) || event.outPlayer.number === event.inPlayer.number) return;
        } else if (!playerOK(event.player)) return;
      }
      latestPopupAt = event.createdAt;
      seenPopups.add(event.id);
      if (seenPopups.size > 100) seenPopups.delete(seenPopups.values().next().value);
      hidePopup();
      if (event.kind !== 'hide') {
        $('popup-type-label').textContent = popupLabel(event.kind);
        $('popup-team-label').textContent = event.team;
        if (event.kind === 'substitution') {
          $('popup-out-number').textContent = event.outPlayer.number;
          $('popup-out-name').textContent = event.outPlayer.name;
          $('popup-in-number').textContent = event.inPlayer.number;
          $('popup-in-name').textContent = event.inPlayer.name;
        } else {
          $('popup-number-label').textContent = event.player.number;
          $('popup-name-label').textContent = event.player.name;
        }
        $('popup').dataset.kind = event.kind;
        // 連続表示でもアニメーションを開始し直す。
        void $('popup').offsetWidth;
        $('popup').classList.add('visible');
        $('popup').setAttribute('aria-hidden', 'false');
        popupTimer = setTimeout(hidePopup, event.expiresAt - Date.now());
      }
      client.publish(ackTopic, JSON.stringify({ id: event.id }), { qos: 0, retain: false });
    } catch {
      // 不正な一時表示イベントは映像へ出さない。
    }
  }
  if (control) {
    ['popup-team', 'popup-number', 'popup-type', 'popup-out', 'popup-in'].forEach(id => $(id).addEventListener('input', popupPreview));
    $('popup-send').onclick = () => sendPopup();
    $('popup-hide').onclick = () => sendPopup(true);
    popupPreview();
  }
})();





