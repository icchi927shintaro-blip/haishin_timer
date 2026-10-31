(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const copy = value => structuredClone(value);
  const sides = ['home', 'away'];
  let draft, confirmed, storageKey, pendingBulk, lastSavedDraft;
  const message = text => { $('roster-message').textContent = text; };
  const normalize = value => String(value).normalize('NFKC').trim();
  const empty = () => ({
    title: '',
    home: { name: 'HOME', shortName: 'HOME', color: '#187fc4', players: [] },
    away: { name: 'AWAY', shortName: 'AWAY', color: '#f5d321', players: [] }
  });

  function toDraft(registration) {
    if (!registration || typeof registration.title !== 'string') throw Error('名簿の形式が不正です');
    const result = { title: registration.title };
    for (const side of sides) {
      const team = registration[side];
      if (!team || typeof team.name !== 'string' || !Array.isArray(team.players) || team.players.length > 100)
        throw Error('チーム情報または選手数が不正です');
      result[side] = { name: team.name, shortName: team.shortName === undefined ? team.name.slice(0, 20) : team.shortName, color: team.color || (side === 'home' ? '#187fc4' : '#f5d321'), players: team.players.map(player => {
        if (!player || !['string', 'number'].includes(typeof player.number) ||
            typeof player.name !== 'string' || typeof player.starter !== 'boolean')
          throw Error('選手情報の形式が不正です');
        return {
          id: typeof player.id === 'string' && player.id ? player.id : crypto.randomUUID(),
          number: String(player.number), name: player.name, position: player.position === undefined ? '' : player.position, starter: player.starter
        };
      }) };
    }
    return result;
  }

  function issues(value) {
    const errors = { home: [], away: [], general: [] };
    if (value.title.length > 120) errors.general.push('大会名は120文字以内です');
    for (const side of sides) {
      const team = value[side], numbers = new Map(), ids = new Set();
      if (typeof team.shortName !== 'string' || !team.shortName.trim() || team.shortName.length > 20) errors.general.push('チーム略称は1〜20文字で入力してください');
      if (!/^#[0-9a-f]{6}$/i.test(team.color)) errors.general.push('チームカラーが不正です');
      if (!team.name.trim() || team.name.length > 80) errors.general.push((side === 'home' ? 'HOME' : 'AWAY') + 'のチーム名を入力してください');
      if (team.players.length > 100) errors.general.push('選手は各チーム100名までです');
      team.players.forEach((player, index) => {
        const row = [];
        const number = normalize(player.number);
        if (!/^\d{1,3}$/.test(number)) row.push('背番号は0〜999の整数');
        if (!player.name.trim() || player.name.length > 80) row.push('選手名を80文字以内で入力');
        if (!['', 'FW', 'MF', 'DF', 'GK'].includes(player.position)) row.push('ポジションはFW/MF/DF/GK');
        if (!player.id || player.id.length > 80 || ids.has(player.id)) row.push('選手IDが重複しています');
        ids.add(player.id);
        errors[side][index] = row;
        if (/^\d{1,3}$/.test(number)) {
          const key = Number(number);
          if (!numbers.has(key)) numbers.set(key, []);
          numbers.get(key).push(index);
        }
      });
      for (const indexes of numbers.values()) if (indexes.length > 1)
        indexes.forEach(index => errors[side][index].push('背番号が重複しています'));
    }
    return errors;
  }

  function validated(value = draft) {
    const errors = issues(value);
    if (errors.general.length || sides.some(side => errors[side].some(row => row.length)))
      throw Error([...errors.general, '登録表のエラーを修正してください'].join('。'));
    const result = copy(value);
    result.title = result.title.trim();
    for (const side of sides) {
      result[side].name = result[side].name.trim();
      result[side].shortName = result[side].shortName.trim();
      result[side].players.forEach(player => {
        player.number = Number(normalize(player.number));
        player.name = player.name.trim();
      });
    }
    return result;
  }

  function status(saved = true) {
    const changed = JSON.stringify(draft) !== JSON.stringify(confirmed);
    $('roster-status').textContent =
      (saved ? '下書き保存済み' : '下書きを保存できません') +
      (changed ? '・未確定の変更があります' : '・確定内容と一致しています') +
      '（HOME ' + draft.home.players.length + '名 / AWAY ' + draft.away.players.length + '名）';
  }

  function persist() {
    try {
      const serialized = JSON.stringify(draft);
      localStorage.setItem(storageKey, serialized); lastSavedDraft = serialized; status();
    }
    catch { status(false); message('下書きを保存できません。ブラウザーの保存容量・設定を確認してください'); }
  }

  function markErrors() {
    const errors = issues(draft);
    for (const side of sides) {
      [...$(side + '-rows').rows].forEach((row, index) => {
        row.querySelector('.row-error').textContent = errors[side][index].join(' / ');
        row.querySelectorAll('input').forEach(input =>
          input.setAttribute('aria-invalid', String(errors[side][index].length > 0)));
      });
    }
  }

  function draw() {
    $('title').value = draft.title;
    $('homeName').value = draft.home.name;
    $('awayName').value = draft.away.name;
    $('homeShortName').value = draft.home.shortName; $('awayShortName').value = draft.away.shortName;
    $('homeColor').value = draft.home.color; $('awayColor').value = draft.away.color;
    for (const side of sides) {
      const body = $(side + '-rows');
      body.replaceChildren();
      draft[side].players.forEach((player, index) => {
        const row = body.insertRow();
        const numberCell = row.insertCell();
        const number = document.createElement('input');
        number.type = 'text'; number.inputMode = 'numeric'; number.maxLength = 3;
        number.value = player.number; number.setAttribute('aria-label', side + ' ' + (index + 1) + '行目 背番号');
        numberCell.append(number);
        const nameCell = row.insertCell();
        const name = document.createElement('input');
        name.value = player.name; name.maxLength = 80;
        name.setAttribute('aria-label', side + ' ' + (index + 1) + '行目 選手名');
        const error = document.createElement('div');
        error.className = 'row-error error';
        nameCell.append(name, error);
        const positionCell = row.insertCell();
        const position = document.createElement('select');
        position.setAttribute('aria-label', side + ' ' + (index + 1) + '行目 ポジション');
        position.add(new Option('未設定', ''));
        for (const value of ['FW', 'MF', 'DF', 'GK']) position.add(new Option(value, value));
        position.value = player.position; positionCell.append(position);
        const roleCell = row.insertCell();
        const role = document.createElement('select');
        role.setAttribute('aria-label', side + ' ' + (index + 1) + '行目 先発・控え');
        role.add(new Option('先発', 'true')); role.add(new Option('控え', 'false'));
        role.value = String(player.starter); roleCell.append(role);
        const deleteCell = row.insertCell();
        const remove = document.createElement('button');
        remove.type = 'button'; remove.textContent = '削除';
        remove.setAttribute('aria-label', side + ' ' + (index + 1) + '行目を削除');
        remove.onclick = () => {
          draft[side].players.splice(index, 1); draw(); persist();
        };
        deleteCell.append(remove);
        const change = () => {
          player.number = number.value; player.name = name.value;
          player.starter = role.value === 'true'; player.position = position.value;
          persist(); markErrors();
        };
        number.oninput = change; name.oninput = change; role.onchange = change; position.onchange = change;
      });
    }
    markErrors(); status();
  }

  // Excelのタブ区切り・引用符・CRLFを扱う。
  function parseTSV(text) {
    const rows = []; let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '"') {
        if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
        else if (quoted || cell === '') quoted = !quoted;
        else cell += char;
      } else if (!quoted && (char === '\t' || char === '\n' || char === '\r')) {
        row.push(cell); cell = '';
        if (char !== '\t') {
          rows.push(row); row = [];
          if (char === '\r' && text[i + 1] === '\n') i++;
        }
      } else cell += char;
    }
    if (quoted) throw Error('引用符が閉じられていません');
    row.push(cell); rows.push(row);
    return rows.filter(cells => cells.some(value => value.trim()));
  }

  function bulkCandidate() {
    const rows = parseTSV($('bulk-text').value);
    if (rows.length && /^(背番号|番号|no\.?|number)$/i.test(normalize(rows[0][0]))) rows.shift();
    if (!rows.length) throw Error('選手の行を貼り付けてください');
    if (rows.length > 100) throw Error('一度に取り込めるのは100名までです');
    const players = rows.map((cells, index) => {
      if (cells.length < 2 || cells.length > 4) throw Error((index + 1) + '行目：背番号・氏名・ポジション・先発／控えの2〜4列をコピーしてください');
      const third = normalize(cells[2] || '').toUpperCase();
      const hasPosition = cells.length === 4 || ['FW', 'MF', 'DF', 'GK'].includes(third);
      const position = hasPosition ? third : '';
      if (!['', 'FW', 'MF', 'DF', 'GK'].includes(position)) throw Error((index + 1) + '行目：ポジションはFW/MF/DF/GKです');
      const role = normalize(hasPosition ? (cells[3] || '') : (cells[2] || '')).toLowerCase();
      const starter = ['先発', 'スタメン', 'true', '1', '○', '〇'].includes(role);
      if (!starter && !['', '控え', 'ベンチ', 'false', '0'].includes(role))
        throw Error((index + 1) + '行目：先発または控えを指定してください');
      return { id: crypto.randomUUID(), number: normalize(cells[0]), name: cells[1].trim(), position, starter };
    });
    const side = $('bulk-team').value, mode = $('bulk-mode').value;
    const candidate = copy(draft);
    candidate[side].players = mode === 'replace' ? players : [...candidate[side].players, ...players];
    // 対象チームだけ検証。もう一方の編集中の空行は取り込みを妨げない。
    const check = issues(candidate);
    const rowErrors = check[side].flatMap((errors, index) => errors.map(error => (index + 1) + '行目：' + error));
    if (candidate[side].players.length > 100 || rowErrors.length)
      throw Error(rowErrors.join('\n') || '選手は各チーム100名までです');
    return { side, mode, players };
  }

  function download(value, filename) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  window.RosterEditor = {
    init(key) {
      storageKey = key + ':roster-draft';
      let broken = false;
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved) { draft = toDraft(JSON.parse(saved)); lastSavedDraft = JSON.stringify(draft); }
      } catch { broken = true; }
      confirmed = toDraft(empty());
      for (const id of ['title', 'homeName', 'awayName', 'homeShortName', 'awayShortName', 'homeColor', 'awayColor']) $(id).oninput = () => {
        draft.title = $('title').value;
        draft.home.name = $('homeName').value; draft.away.name = $('awayName').value;
        draft.home.shortName = $('homeShortName').value; draft.away.shortName = $('awayShortName').value;
        draft.home.color = $('homeColor').value; draft.away.color = $('awayColor').value;
        persist(); markErrors();
      };
      document.querySelectorAll('[data-add]').forEach(button => button.onclick = () => {
        const side = button.dataset.add;
        if (draft[side].players.length >= 100) { message('選手は各チーム100名までです'); return; }
        draft[side].players.push({ id: crypto.randomUUID(), number: '', name: '', position: '', starter: false });
        draw(); persist();
        $(side + '-rows').lastElementChild.querySelector('input').focus();
      });
      $('roster-reset').onclick = () => {
        if (confirm('未確定の編集を破棄し、確定済み名簿に戻しますか？')) {
          draft = copy(confirmed); draw(); persist(); message('');
        }
      };
      const invalidateBulk = () => {
        pendingBulk = null; $('bulk-apply').disabled = true;
        $('bulk-preview').hidden = true;
      };
      ['bulk-text', 'bulk-team', 'bulk-mode'].forEach(id => $(id).addEventListener('input', invalidateBulk));
      $('bulk-check').onclick = () => {
        invalidateBulk();
        try {
          pendingBulk = bulkCandidate();
          $('bulk-preview').textContent =
            (pendingBulk.side === 'home' ? 'HOME' : 'AWAY') + '：' +
            (pendingBulk.mode === 'replace' ? '置き換え' : '追加') + '\n' +
            pendingBulk.players.map(p => p.number + '　' + p.name + '　' + (p.position || '未設定') + '　' + (p.starter ? '先発' : '控え')).join('\n');
          $('bulk-preview').hidden = false; $('bulk-apply').disabled = false; message('');
        } catch (error) { message(error.message); }
      };
      $('bulk-apply').onclick = () => {
        if (!pendingBulk) return;
        try {
          // 確認後に表を編集していても、最新の下書きに対して再検証する。
          const next = bulkCandidate();
          if (next.mode === 'replace' && !confirm('対象チームの下書きを貼り付け内容で置き換えますか？')) return;
          draft[next.side].players = next.mode === 'replace' ? next.players : [...draft[next.side].players, ...next.players];
          draw(); persist(); invalidateBulk(); message('下書きへ取り込みました。確認して「登録を確定」を押してください');
        } catch (error) { message(error.message); }
      };
      $('roster-export').onclick = () => {
        download({ format: 'haishin-roster', version: 1, registration: validated(confirmed) }, 'roster.json');
        message('確定済み名簿を保存します。未確定の編集は含みません');
      };
      $('roster-import').onchange = async event => {
        const file = event.target.files[0]; if (!file) return;
        try {
          if (file.size > 1000000) throw Error('1MB以下のJSONを選択してください');
          const data = JSON.parse((await file.text()).replace(/^\uFEFF/, ''));
          if (data.format && (data.format !== 'haishin-roster' || data.version !== 1))
            throw Error('未対応の名簿ファイルです');
          const next = toDraft(data.registration || data);
          validated(next);
          if (confirm('編集中の名簿をファイルの内容で置き換えますか？時計・得点は変更しません')) {
            draft = next; draw(); persist();
            message('名簿を下書きへ読み込みました。「登録を確定」で反映します');
          }
        } catch (error) { message(error.message); }
        event.target.value = '';
      };
      if (draft) draw();
      if (broken) message('保存済みの下書きを読み込めません。確定済み名簿を表示します');
    },
    receive(registration, force = false) {
      const dirty = draft && JSON.stringify(draft) !== JSON.stringify(confirmed);
      confirmed = toDraft(registration);
      if (!draft || force || !dirty) { draft = copy(confirmed); draw(); persist(); }
      else status();
    },
    flush() {
      if (draft) {
        const serialized = JSON.stringify(draft);
        if (serialized !== lastSavedDraft) {
          localStorage.setItem(storageKey, serialized);
          lastSavedDraft = serialized;
        }
      }
    },
    value() {
      markErrors();
      try { return validated(); }
      catch (error) { message(error.message); throw error; }
    }
  };
})();
