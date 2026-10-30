(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const control = !!$('enable');
  const params = new URLSearchParams(location.hash.slice(1));
  let room = params.get('room');

  // 操作画面をルームIDなしで開くと、新しい試合IDを発行する。
  if (!room && control) {
    room = crypto.randomUUID();
    location.hash = new URLSearchParams({ room }).toString();
  }

  const warn = message => {
    if (control) {
      $('message').textContent = message;
    } else {
      $('warning').textContent = message;
      $('warning').hidden = !message;
    }
  };

  if (!room || !/^[a-zA-Z0-9_-]{8,80}$/.test(room)) {
    warn('操作画面で作成された、ルームID付きの表示URLを使用してください');
    return;
  }

  // 操作用と表示用の保存先を分離する。
  const key =
    'haishin-pages-v1:' +
    room +
    (control ? ':control' : ':display');

  window.addEventListener('hashchange', () => location.reload());

  const source = crypto.randomUUID();
  const topic = 'haishin-pages/v1/' + room + '/state';

  const fresh = () => ({
    version: 1,
    updatedAt: 0,
    source: '',
    scoreHome: 0,
    scoreAway: 0,
    clock: {
      baseMs: 0,
      startedAt: null,
      running: false,
      period: 1
    },
    registration: {
      title: '',
      home: {
        name: 'HOME',
        players: []
      },
      away: {
        name: 'AWAY',
        players: []
      }
    }
  });

  let state = null;
  let active = false;
  let connected = false;
  let ready = false;
  let client;
  let releaseLock;

  const validText = (value, max) =>
    typeof value === 'string' && value.length <= max;

  function validate(s) {
    if (
      !s ||
      s.version !== 1 ||
      !Number.isSafeInteger(s.updatedAt) ||
      s.updatedAt < 0 ||
      !validText(s.source, 80) ||
      ![s.scoreHome, s.scoreAway].every(
        n => Number.isInteger(n) && n >= 0 && n <= 999
      )
    ) {
      throw Error('試合データの形式が不正です');
    }

    const c = s.clock;

    if (
      !c ||
      !Number.isFinite(c.baseMs) ||
      c.baseMs < 0 ||
      c.baseMs > 86400000 ||
      typeof c.running !== 'boolean' ||
      ![1, 2].includes(c.period) ||
      !(
        c.startedAt === null ||
        (
          Number.isFinite(c.startedAt) &&
          c.startedAt >= 0
        )
      ) ||
      (c.running && c.startedAt === null)
    ) {
      throw Error('時計データが不正です');
    }

    const r = s.registration;

    if (!r || !validText(r.title, 120)) {
      throw Error('大会名が不正です');
    }

    for (const side of ['home', 'away']) {
      const team = r[side];
      const ids = new Set();
      const numbers = new Set();

      if (
        !team ||
        !validText(team.name, 80) ||
        !team.name.trim() ||
        !Array.isArray(team.players) ||
        team.players.length > 100
      ) {
        throw Error('チーム情報が不正です');
      }

      for (const player of team.players) {
        if (
          !player ||
          !validText(player.id, 80) ||
          !player.id.trim() ||
          ids.has(player.id) ||
          !validText(player.name, 80) ||
          !player.name.trim() ||
          !Number.isInteger(player.number) ||
          player.number < 0 ||
          player.number > 999 ||
          numbers.has(player.number) ||
          typeof player.starter !== 'boolean'
        ) {
          throw Error(
            '選手ID・背番号の重複や、選手情報の形式を確認してください'
          );
        }

        ids.add(player.id);
        numbers.add(player.number);
      }
    }
  }

  // タイマーの呼出回数ではなく、開始日時から経過時間を計算する。
  const elapsed = s =>
    s.clock.baseMs +
    (
      s.clock.running
        ? Math.max(0, Date.now() - s.clock.startedAt)
        : 0
    );

  const timeText = ms => {
    const seconds = Math.floor(ms / 1000);

    return (
      String(Math.floor(seconds / 60)).padStart(2, '0') +
      ':' +
      String(seconds % 60).padStart(2, '0')
    );
  };

  function buttons() {
    if (!control) return;

    $('enable').disabled = !connected || !ready || active;

    document.querySelectorAll('[data-action]').forEach(button => {
      button.disabled = !connected || !active;
    });

    $('import').disabled = !connected || !active;
  }

  function registrationForm() {
    if (!control || !state) return;

    const r = state.registration;

    $('title').value = r.title;
    $('homeName').value = r.home.name;
    $('awayName').value = r.away.name;

    $('players').value = JSON.stringify(
      {
        home: r.home.players,
        away: r.away.players
      },
      null,
      2
    );
  }

  function render() {
    if (!state) return;

    const ms = elapsed(state);

    $('timer').textContent = timeText(ms);

    if (control) {
      $('score').textContent =
        state.scoreHome + ' - ' + state.scoreAway;

      $('teams').textContent =
        state.registration.home.name +
        ' / ' +
        state.registration.away.name;

      $('phase').textContent =
        (state.clock.period === 1 ? '前半' : '後半') +
        '・' +
        (state.clock.running ? '進行中' : '停止中');
    } else {
      $('score-home').textContent = state.scoreHome;
      $('score-away').textContent = state.scoreAway;

      $('timer-wrapper').classList.toggle(
        'stoppage',
        ms >= (
          state.clock.period === 1
            ? 2700000
            : 5400000
        )
      );
    }
  }

  function save(s) {
    localStorage.setItem(key, JSON.stringify(s));
  }

  function yieldControl() {
    active = false;

    if (releaseLock) {
      releaseLock();
      releaseLock = null;
    }

    buttons();
  }

  function publish() {
    if (
      !client?.connected ||
      !connected ||
      !ready ||
      !active ||
      !state
    ) {
      return;
    }

    // 選手名簿は公開ブローカーへ送信しない。
    const wire = {
      ...state,
      registration: {
        title: state.registration.title,
        home: {
          name: state.registration.home.name,
          players: []
        },
        away: {
          name: state.registration.away.name,
          players: []
        }
      }
    };

    client.publish(
      topic,
      JSON.stringify(wire),
      {
        qos: 1,
        retain: true
      },
      error => {
        if (error) {
          warn('送信を確認できません。接続を確認してください');
        }
      }
    );
  }

  function commit(next) {
    validate(next);

    next.updatedAt = Math.max(
      Date.now(),
      (state?.updatedAt || 0) + 1
    );

    next.source = source;

    // ブラウザーへの保存に成功してから状態を確定する。
    save(next);
    state = next;

    render();
    publish();
  }

  try {
    const saved = localStorage.getItem(key);

    if (saved) {
      state = JSON.parse(saved);
      validate(state);
      registrationForm();
      render();
    } else {
      save(fresh());
    }
  } catch {
    warn(
      'ブラウザー保存を利用できないか、保存データが不正です。' +
      '別のルームIDで開いてください'
    );
    return;
  }

  if (control) {
    $('room').textContent = room;

    $('displayLink').href =
      './display_pages.html#' +
      new URLSearchParams({ room });

    $('controlLink').href =
      './control_pages.html#' +
      new URLSearchParams({ room });

    $('enable').onclick = async () => {
      if (active || !ready || !connected) return;

      if (
        !confirm(
          'ほかの操作画面を閉じ、この画面で操作しますか？'
        )
      ) {
        return;
      }

      if (!navigator.locks) {
        warn(
          'このブラウザーは操作ロックに未対応です。' +
          'ChromeまたはEdgeを使用してください'
        );
        return;
      }

      await navigator.locks.request(
        key,
        { ifAvailable: true },
        async lock => {
          if (!lock) {
            warn('同じ試合の操作画面が別タブで開いています');
            return;
          }

          try {
            active = true;

            commit(
              structuredClone(state || fresh())
            );

            registrationForm();
            warn('');
            buttons();

            await new Promise(resolve => {
              releaseLock = resolve;
            });
          } catch (error) {
            yieldControl();
            warn(error.message);
          }
        }
      );
    };

    document.querySelectorAll('[data-action]').forEach(button => {
      button.onclick = () => {
        if (!active || !connected) return;

        const action = button.dataset.action;

        if (
          ['time', 'reset'].includes(action) &&
          !confirm('得点または時間を変更しますか？')
        ) {
          return;
        }

        try {
          const s = structuredClone(state);
          const c = s.clock;

          if (action === 'start' && !c.running) {
            c.startedAt = Date.now();
            c.running = true;
          }

          if (action === 'stop') {
            c.baseMs = elapsed(s);
            c.running = false;
            c.startedAt = null;
          }

          if (action === 'time') {
            c.baseMs = Number(button.dataset.seconds) * 1000;
            c.period = Number(button.dataset.period);
            c.startedAt = c.running ? Date.now() : null;
          }

          if (action === 'score') {
            const field =
              button.dataset.team === 'home'
                ? 'scoreHome'
                : 'scoreAway';

            s[field] = Math.max(
              0,
              Math.min(
                999,
                s[field] + Number(button.dataset.delta)
              )
            );
          }

          if (action === 'reset') {
            s.scoreHome = 0;
            s.scoreAway = 0;
          }

          if (action === 'registration') {
            const players = JSON.parse($('players').value);

            s.registration = {
              title: $('title').value,
              home: {
                name: $('homeName').value,
                players: players.home
              },
              away: {
                name: $('awayName').value,
                players: players.away
              }
            };
          }

          commit(s);
          warn('保存しました');
        } catch (error) {
          warn(error.message);
        }
      };
    });

    $('export').onclick = () => {
      if (!state) {
        warn('先に試合の操作を開始してください');
        return;
      }

      const url = URL.createObjectURL(
        new Blob(
          [JSON.stringify(state, null, 2)],
          { type: 'application/json' }
        )
      );

      const a = document.createElement('a');

      a.href = url;
      a.download = 'match-' + room + '.json';
      a.click();

      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };

    $('import').onchange = async event => {
      const file = event.target.files[0];

      if (!file) return;

      try {
        if (file.size > 1000000) {
          throw Error('1MB以下のJSONを選択してください');
        }

        const next = JSON.parse(await file.text());

        validate(next);

        if (!active || !connected) {
          throw Error('先にこの画面で操作を開始してください');
        }

        if (
          confirm(
            '現在の得点・時計・登録情報を' +
            'ファイルの内容で置き換えますか？'
          )
        ) {
          commit(next);
          registrationForm();
          warn('復元しました');
        }
      } catch (error) {
        warn(error.message);
      }

      event.target.value = '';
    };

    buttons();
  }

  if (!window.mqtt) {
    warn(
      '通信ライブラリを読み込めません。' +
      'ネット接続を確認して再読込してください'
    );
    return;
  }

  client = mqtt.connect(
    'wss://broker.hivemq.com:8884/mqtt',
    {
      reconnectPeriod: 1000,
      connectTimeout: 10000,
      keepalive: 15,
      clean: true,
      queueQoSZero: false,
      clientId: 'hp-' + source
    }
  );

  client.on('connect', () => {
    client.subscribe(
      topic,
      { qos: 1 },
      error => {
        if (error || !client.connected) {
          warn('試合データの受信を開始できません');
          return;
        }

        connected = true;

        if (control) {
          $('status').textContent =
            '通信サーバー接続済み' +
            '（OBSの接続確認ではありません）';
        }

        // 保存されている最新状態を受信する時間を設ける。
        setTimeout(() => {
          ready = true;
          buttons();
          publish();
        }, 1500);
      }
    );
  });

  client.on('message', (receivedTopic, message) => {
    if (
      receivedTopic !== topic ||
      message.length > 100000
    ) {
      return;
    }

    try {
      const next = JSON.parse(message.toString());

      validate(next);

      if (
        state &&
        next.updatedAt <= state.updatedAt
      ) {
        return;
      }

      if (active && next.source !== source) {
        yieldControl();
        warn('別の画面から更新されました。操作を停止しました');
      }

      // MQTTには名簿がないため、このブラウザーの登録選手を維持。
      if (state) {
        for (const side of ['home', 'away']) {
          next.registration[side].players =
            state.registration[side].players;
        }
      }

      save(next);
      state = next;

      render();
      registrationForm();
    } catch (error) {
      warn('受信データを利用できません：' + error.message);
    }
  });

  function offline() {
    connected = false;
    ready = false;

    if (control) {
      $('status').textContent = '通信切断・自動再接続中';
    }

    buttons();
  }

  client.on('offline', offline);
  client.on('close', offline);

  client.on('error', () => {
    if (control) {
      $('status').textContent = '通信エラー・自動再接続中';
    }
  });

  setInterval(() => {
    render();
    publish();
  }, 2000);

  setInterval(render, 100);
})();
