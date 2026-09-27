const config = window.CHUKUIGEUM_CONFIG || {};
const API_URL = String(config.supabaseUrl || '').replace(/\/$/, '');
const API_KEY = String(config.supabaseAnonKey || '');
const REL_COLORS = { 친구: ['#eaf4fb','#2776a8'], 직장: ['#eafaf1','#218c52'], 친척: ['#fef9e7','#987b00'], 지인: ['#f4ecf7','#7d3c98'], 기타: ['#f2f3f4','#586570'] };
const ERROR_MESSAGES = {
  INVALID_INPUT: '입력 내용을 다시 확인해 주세요.',
  ROOM_NOT_FOUND: '방을 찾을 수 없습니다. 방 코드를 확인해 주세요.',
  INVALID_PIN: 'PIN이 올바르지 않습니다.',
  RATE_LIMITED: 'PIN 입력 횟수를 초과했습니다. 10분 후 다시 시도해 주세요.',
  INVALID_SESSION: '입장 정보가 만료되었습니다. PIN을 다시 입력해 주세요.',
  INVALID_MASTER_PIN: '마스터 PIN이 올바르지 않습니다.',
  MASTER_RATE_LIMITED: '마스터 PIN 입력 횟수를 초과했습니다. 10분 후 다시 시도해 주세요.',
  MASTER_NOT_CONFIGURED: '마스터 PIN이 아직 설정되지 않았습니다.',
  INVALID_MASTER_SESSION: '관리 권한이 만료되었습니다. 마스터 PIN을 다시 입력해 주세요.',
  CONFIRMATION_MISMATCH: '방 이름이 변경되었습니다. 목록을 새로고침한 뒤 다시 확인해 주세요.',
  ENTRY_NOT_FOUND: '이 기록은 다른 사람이 삭제했습니다.',
  EDIT_CONFLICT: '다른 사람이 이 기록을 먼저 수정했습니다.'
};
const $ = id => document.getElementById(id);

let accessToken = '';
let room = null;
let rooms = [];
let roomSort = 'date-desc';
let selectedRoomCode = '';
let entries = [];
let editingId = null;
let editingUpdatedAt = null;
let refreshTimer = null;
let syncing = false;
let masterToken = '';

function isConfigured() {
  return /^https:\/\/.+\.supabase\.co$/.test(API_URL) && API_KEY.length > 20;
}

function getDeviceId() {
  const key = 'chukuigeum-device';
  let value = localStorage.getItem(key);
  if (!value) {
    value = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
    localStorage.setItem(key, value);
  }
  return value;
}

async function rpc(name, params) {
  const response = await fetch(`${API_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: API_KEY, Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(params)
  });
  if (!response.ok) throw new Error('NETWORK_ERROR');
  return response.json();
}

function messageFor(error) {
  const code = typeof error === 'string' ? error : error?.message;
  return ERROR_MESSAGES[code] || '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  if (busy) {
    button.dataset.label = button.textContent;
    button.dataset.busyLabel = label;
    button.textContent = label;
  } else if (button.dataset.label) {
    if (button.textContent === button.dataset.busyLabel) button.textContent = button.dataset.label;
    delete button.dataset.label;
    delete button.dataset.busyLabel;
  }
}

function setView(name) {
  $('loadingView').hidden = name !== 'loading';
  $('lobbyView').hidden = name !== 'lobby';
  $('roomView').hidden = name !== 'room';
  $('roomHeader').hidden = name !== 'room';
}

function selectTab(name) {
  const joining = name === 'join';
  const creating = name === 'create';
  $('joinForm').hidden = !joining;
  $('createForm').hidden = !creating;
  $('masterPanel').hidden = name !== 'master';
  $('joinTab').classList.toggle('active', joining);
  $('createTab').classList.toggle('active', creating);
  $('masterTab').classList.toggle('active', name === 'master');
  $('joinTab').setAttribute('aria-selected', String(joining));
  $('createTab').setAttribute('aria-selected', String(creating));
  $('masterTab').setAttribute('aria-selected', String(name === 'master'));
  if (joining) {
    if (selectedRoomCode) $('joinPin').focus();
  } else if (creating) {
    $('roomTitleInput').focus();
  } else if (masterToken) {
    renderMasterRooms();
  } else {
    $('masterPin').focus();
  }
}

function showLobby(tab = 'join') {
  setView('lobby');
  $('setupNotice').hidden = isConfigured();
  $('lobbyContent').hidden = !isConfigured();
  selectTab(tab);
  if (tab === 'join' || tab === 'master') loadRooms();
}

function sessionKey(code) { return `chukuigeum-session-${code}`; }

function updateRoomUrl(code) {
  const url = new URL(location.href);
  url.searchParams.set('room', code);
  history.replaceState(null, '', url);
}

function clearRoomUrl() {
  const url = new URL(location.href);
  url.searchParams.delete('room');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
}

function openRoom(data, token) {
  accessToken = token;
  room = data.room;
  entries = Array.isArray(data.entries) ? data.entries : [];
  localStorage.setItem(sessionKey(room.code), token);
  updateRoomUrl(room.code);
  $('headerRoomTitle').textContent = room.title;
  document.title = `${room.title} · 축의금 관리`;
  resetEntryForm();
  render();
  setView('room');
  startRoomSync();
}

function renderRoomList() {
  const list = $('roomList');
  list.replaceChildren();
  if (!rooms.length) {
    const empty = document.createElement('div');
    empty.className = 'room-list-empty';
    empty.textContent = '아직 개설된 결혼식이 없습니다. 새 방을 만들어 주세요.';
    list.append(empty);
    return;
  }

  const sortedRooms = [...rooms].sort((a, b) => {
    const byName = a.title.localeCompare(b.title, 'ko');
    const byDate = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (roomSort === 'name-asc') return byName || a.code.localeCompare(b.code);
    if (roomSort === 'name-desc') return -byName || a.code.localeCompare(b.code);
    if (roomSort === 'date-asc') return byDate || a.code.localeCompare(b.code);
    return -byDate || a.code.localeCompare(b.code);
  });
  sortedRooms.forEach(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'room-list-item';
    button.classList.toggle('active', item.code === selectedRoomCode);
    button.dataset.roomCode = item.code;
    const title = document.createElement('span');
    title.className = 'room-list-title';
    title.textContent = item.title;
    const date = document.createElement('span');
    date.className = 'room-list-date';
    date.textContent = new Date(item.createdAt).toLocaleDateString('ko-KR');
    button.append(title, date);
    list.append(button);
  });
}

function renderMasterRooms() {
  const list = $('masterRoomList');
  list.replaceChildren();
  if (!rooms.length) {
    const empty = document.createElement('div');
    empty.className = 'room-list-empty';
    empty.textContent = '관리할 결혼식 방이 없습니다.';
    list.append(empty);
    return;
  }
  rooms.forEach(item => {
    const row = document.createElement('div');
    row.className = 'master-room-item';
    row.dataset.roomCode = item.code;
    const label = document.createElement('label');
    label.textContent = `${item.title} 이름 수정`;
    const input = document.createElement('input');
    input.className = 'master-room-title-input';
    input.value = item.title;
    input.maxLength = 60;
    input.setAttribute('aria-label', `${item.title} 새 이름`);
    const pinFields = document.createElement('div');
    pinFields.className = 'master-pin-fields';
    const newPin = document.createElement('input');
    newPin.className = 'master-new-pin';
    newPin.type = 'password';
    newPin.inputMode = 'numeric';
    newPin.maxLength = 4;
    newPin.placeholder = '새 PIN 4자리';
    newPin.autocomplete = 'new-password';
    newPin.setAttribute('aria-label', `${item.title} 새 PIN 4자리`);
    const confirmPin = document.createElement('input');
    confirmPin.className = 'master-confirm-pin';
    confirmPin.type = 'password';
    confirmPin.inputMode = 'numeric';
    confirmPin.maxLength = 4;
    confirmPin.placeholder = '새 PIN 확인';
    confirmPin.autocomplete = 'new-password';
    confirmPin.setAttribute('aria-label', `${item.title} 새 PIN 확인`);
    pinFields.append(newPin, confirmPin);
    const actions = document.createElement('div');
    actions.className = 'master-room-actions';
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'secondary-btn';
    save.dataset.masterAction = 'rename';
    save.textContent = '이름 저장';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary-btn danger-btn';
    remove.dataset.masterAction = 'delete';
    remove.textContent = '방 삭제';
    const changePin = document.createElement('button');
    changePin.type = 'button';
    changePin.className = 'secondary-btn master-pin-save';
    changePin.dataset.masterAction = 'change-pin';
    changePin.textContent = 'PIN 변경';
    actions.append(save, remove);
    row.append(label, input, actions, pinFields, changePin);
    list.append(row);
  });
}

async function loadRooms() {
  if (!isConfigured()) return;
  try {
    const data = await rpc('list_rooms', {});
    if (!data.ok) throw new Error(data.error);
    rooms = Array.isArray(data.rooms) ? data.rooms : [];
    renderRoomList();
    if (masterToken) renderMasterRooms();
    if (selectedRoomCode) {
      const selected = rooms.find(item => item.code === selectedRoomCode);
      if (selected) {
        $('selectedRoomTitle').textContent = selected.title;
        $('roomPinPanel').hidden = false;
      }
    }
  } catch (error) {
    $('roomList').innerHTML = '<div class="room-list-empty">방 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</div>';
  }
}

function selectRoom(code, focusPin = true) {
  const selected = rooms.find(item => item.code === code);
  if (!selected) return;
  selectedRoomCode = code;
  $('selectedRoomTitle').textContent = selected.title;
  $('roomPinPanel').hidden = false;
  $('joinMessage').textContent = '';
  renderRoomList();
  updateRoomUrl(code);
  if (focusPin) $('joinPin').focus();
}

function clearRoomSelection() {
  selectedRoomCode = '';
  $('joinPin').value = '';
  $('joinMessage').textContent = '';
  $('roomPinPanel').hidden = true;
  clearRoomUrl();
  renderRoomList();
}

function startRoomSync() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(async () => {
    if (!room || syncing || document.hidden) return;
    syncing = true;
    try {
      const data = await rpc('get_room', { p_access_token: accessToken });
      if (data.ok) {
        room = data.room;
        $('headerRoomTitle').textContent = room.title;
        document.title = `${room.title} · 축의금 관리`;
        entries = Array.isArray(data.entries) ? data.entries : [];
        render();
      } else if (data.error === 'INVALID_SESSION') {
        await leaveRoom(false);
        $('joinMessage').textContent = '방이 삭제되었거나 입장 정보가 만료되었습니다.';
      }
    } catch (_) {
      // 일시적인 네트워크 오류는 다음 동기화에서 다시 시도합니다.
    } finally { syncing = false; }
  }, 8000);
}

async function joinRoom(event) {
  event.preventDefault();
  const code = selectedRoomCode;
  const pin = $('joinPin').value.trim();
  if (!code) { $('joinMessage').textContent = '입장할 결혼식을 선택해 주세요.'; return; }
  if (!/^\d{4}$/.test(pin)) { $('joinMessage').textContent = '숫자 4자리 PIN을 입력해 주세요.'; return; }
  setBusy($('joinBtn'), true, '확인 중…');
  try {
    const data = await rpc('join_room', { p_room_code: code, p_pin: pin, p_attempt_key: getDeviceId() });
    if (!data.ok) throw new Error(data.error);
    $('joinPin').value = '';
    $('joinMessage').textContent = '';
    openRoom(data, data.accessToken);
  } catch (error) { $('joinMessage').textContent = messageFor(error); }
  finally { setBusy($('joinBtn'), false); }
}

async function createRoom(event) {
  event.preventDefault();
  const title = $('roomTitleInput').value.trim();
  const pin = $('createPin').value.trim();
  if (!title) { $('createMessage').textContent = '결혼식 이름을 입력해 주세요.'; return; }
  if (!/^\d{4}$/.test(pin)) { $('createMessage').textContent = '숫자 4자리 PIN을 입력해 주세요.'; return; }
  if (pin !== $('confirmPin').value.trim()) { $('createMessage').textContent = 'PIN 확인 값이 일치하지 않습니다.'; return; }
  setBusy($('createBtn'), true, '만드는 중…');
  try {
    const data = await rpc('create_room', { p_title: title, p_pin: pin });
    if (!data.ok) throw new Error(data.error);
    $('createForm').reset();
    $('createMessage').textContent = '';
    openRoom(data, data.accessToken);
  } catch (error) { $('createMessage').textContent = messageFor(error); }
  finally { setBusy($('createBtn'), false); }
}

async function masterLogin(event) {
  event.preventDefault();
  const pin = $('masterPin').value.trim();
  if (!/^[0-9]{4,12}$/.test(pin)) {
    $('masterLoginMessage').textContent = '숫자 4~12자리 마스터 PIN을 입력해 주세요.';
    return;
  }
  setBusy($('masterLoginBtn'), true, '확인 중…');
  try {
    const data = await rpc('master_login', { p_pin: pin });
    if (!data.ok) throw new Error(data.error);
    masterToken = data.masterToken;
    $('masterPin').value = '';
    $('masterLoginMessage').textContent = '';
    $('masterLoginForm').hidden = true;
    $('masterContent').hidden = false;
    await loadRooms();
  } catch (error) { $('masterLoginMessage').textContent = messageFor(error); }
  finally { setBusy($('masterLoginBtn'), false); }
}

function masterLogout(revoke = true) {
  const oldToken = masterToken;
  masterToken = '';
  $('masterLoginForm').hidden = false;
  $('masterContent').hidden = true;
  $('masterPin').value = '';
  $('masterMessage').textContent = '';
  if (revoke && oldToken) rpc('master_logout', { p_master_token: oldToken }).catch(() => {});
}

function handleMasterError(error) {
  if (error?.message === 'INVALID_MASTER_SESSION') {
    masterLogout(false);
    $('masterLoginMessage').textContent = messageFor(error);
  } else {
    $('masterMessage').textContent = messageFor(error);
  }
}

async function masterRenameRoom(row, button) {
  const code = row.dataset.roomCode;
  const title = row.querySelector('.master-room-title-input').value.trim();
  if (!title || title.length > 60) {
    $('masterMessage').textContent = '결혼식 이름을 1~60자로 입력해 주세요.';
    return;
  }
  setBusy(button, true, '저장 중…');
  try {
    const data = await rpc('master_rename_room', { p_master_token: masterToken, p_room_code: code, p_title: title });
    if (!data.ok) throw new Error(data.error);
    rooms = rooms.map(item => item.code === code ? data.room : item);
    renderRoomList();
    renderMasterRooms();
    if (selectedRoomCode === code) $('selectedRoomTitle').textContent = title;
    $('masterMessage').textContent = '결혼식 이름을 변경했습니다.';
  } catch (error) { handleMasterError(error); }
  finally { setBusy(button, false); }
}

async function masterChangeRoomPin(row, button) {
  const code = row.dataset.roomCode;
  const pinInput = row.querySelector('.master-new-pin');
  const confirmInput = row.querySelector('.master-confirm-pin');
  const pin = pinInput.value;
  if (!/^[0-9]{4}$/.test(pin)) {
    $('masterMessage').textContent = '새 PIN을 숫자 4자리로 입력해 주세요.';
    return;
  }
  if (pin !== confirmInput.value) {
    $('masterMessage').textContent = '새 PIN 확인 값이 일치하지 않습니다.';
    return;
  }
  setBusy(button, true, '변경 중…');
  try {
    const data = await rpc('master_change_room_pin', { p_master_token: masterToken, p_room_code: code, p_new_pin: pin });
    if (!data.ok) throw new Error(data.error);
    pinInput.value = '';
    confirmInput.value = '';
    localStorage.removeItem(sessionKey(code));
    $('masterMessage').textContent = '방 PIN을 변경했습니다. 기존 접속은 종료되며 새 PIN으로 다시 입장해야 합니다.';
  } catch (error) { handleMasterError(error); }
  finally { setBusy(button, false); }
}

async function masterDeleteRoom(row, button) {
  const code = row.dataset.roomCode;
  const item = rooms.find(roomItem => roomItem.code === code);
  if (!item) return;
  const answer = prompt(`“${item.title}” 방과 모든 축의금 기록을 삭제합니다. 계속하려면 방 이름을 그대로 입력해 주세요.`);
  if (answer === null) return;
  if (answer !== item.title) {
    $('masterMessage').textContent = '방 이름이 일치하지 않아 삭제하지 않았습니다.';
    return;
  }
  setBusy(button, true, '삭제 중…');
  try {
    const data = await rpc('master_delete_room', { p_master_token: masterToken, p_room_code: code, p_confirm_title: item.title });
    if (!data.ok) throw new Error(data.error);
    rooms = rooms.filter(roomItem => roomItem.code !== code);
    localStorage.removeItem(sessionKey(code));
    if (selectedRoomCode === code) clearRoomSelection();
    renderRoomList();
    renderMasterRooms();
    $('masterMessage').textContent = `“${item.title}” 방을 삭제했습니다.`;
  } catch (error) { handleMasterError(error); }
  finally { setBusy(button, false); }
}

async function restoreSession(code) {
  const token = localStorage.getItem(sessionKey(code));
  if (!token) { selectedRoomCode = code; showLobby('join'); return; }
  try {
    const data = await rpc('get_room', { p_access_token: token });
    if (!data.ok) throw new Error(data.error);
    openRoom(data, token);
  } catch (error) {
    localStorage.removeItem(sessionKey(code));
    selectedRoomCode = code;
    $('joinMessage').textContent = messageFor(error);
    showLobby('join');
  }
}

async function leaveRoom(revoke = true) {
  const oldCode = room?.code;
  const oldToken = accessToken;
  clearInterval(refreshTimer);
  refreshTimer = null;
  accessToken = ''; room = null; entries = []; editingId = null;
  if (oldCode) localStorage.removeItem(sessionKey(oldCode));
  clearRoomUrl();
  document.title = '축의금 관리';
  selectedRoomCode = '';
  showLobby('join');
  if (revoke && oldToken) rpc('leave_room', { p_access_token: oldToken }).catch(() => {});
}

function formatWon(value) { return Math.round(Number(value) || 0).toLocaleString('ko-KR') + '원'; }
function formatDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return value || '';
  const [year, month, day] = value.split('-').map(Number);
  return `${year}. ${month}. ${day}.`;
}
function filteredEntries() {
  const rel = $('filterRel').value;
  const search = $('searchInput').value.trim().toLocaleLowerCase('ko-KR');
  return entries.filter(item => (!rel || item.relation === rel) && (!search || item.name.toLocaleLowerCase('ko-KR').includes(search)));
}

function resetEntryForm() {
  editingId = null;
  editingUpdatedAt = null;
  $('entryForm').reset();
  $('formMessage').textContent = '';
  $('submitBtn').textContent = '추가';
  $('formTitle').textContent = '하객 추가';
  $('editNotice').classList.remove('active');
}

async function refreshEntries() {
  const data = await rpc('get_room', { p_access_token: accessToken });
  if (!data.ok) throw new Error(data.error);
  entries = Array.isArray(data.entries) ? data.entries : [];
  render();
}

async function submitEntry(event) {
  event.preventDefault();
  const name = $('nameInput').value.trim();
  const amount = Number($('amountInput').value);
  const relation = $('relInput').value;
  if (!name) { $('formMessage').textContent = '이름을 입력해 주세요.'; $('nameInput').focus(); return; }
  if (!Number.isSafeInteger(amount) || amount <= 0) { $('formMessage').textContent = '0원보다 큰 금액을 입력해 주세요.'; $('amountInput').focus(); return; }
  setBusy($('submitBtn'), true, '저장 중…');
  try {
    const functionName = editingId ? 'update_entry' : 'add_entry';
    const params = { p_access_token: accessToken, p_name: name, p_amount: amount, p_relation: relation };
    if (editingId) {
      params.p_entry_id = editingId;
      params.p_expected_updated_at = editingUpdatedAt;
    } else {
      params.p_allow_duplicate = false;
    }
    let data = await rpc(functionName, params);
    if (!editingId && !data.ok && data.error === 'DUPLICATE_NAME') {
      if (!confirm(`“${name}” 이름의 기록이 이미 있습니다. 동명이인 또는 별도 기록이 맞으면 추가할까요?`)) return;
      data = await rpc('add_entry', { ...params, p_allow_duplicate: true });
    }
    if (!data.ok && (data.error === 'EDIT_CONFLICT' || data.error === 'ENTRY_NOT_FOUND')) {
      try { await refreshEntries(); } catch (_) { /* 다음 자동 동기화에서 재시도합니다. */ }
      $('formMessage').textContent = `${messageFor(data.error)} 최신 목록을 확인하고 수정을 취소한 뒤 다시 시작해 주세요. 현재 입력은 유지됩니다.`;
      return;
    }
    if (!data.ok) throw new Error(data.error);
    if (editingId) entries = entries.map(item => item.id === editingId ? data.entry : item);
    else entries.unshift(data.entry);
    resetEntryForm(); render(); $('nameInput').focus();
  } catch (error) { $('formMessage').textContent = messageFor(error); }
  finally { setBusy($('submitBtn'), false); }
}

function startEdit(id) {
  const item = entries.find(entry => entry.id === id);
  if (!item) return;
  editingId = id;
  editingUpdatedAt = item.updatedAt;
  $('nameInput').value = item.name;
  $('amountInput').value = item.amount;
  $('relInput').value = item.relation;
  $('formTitle').textContent = '기록 수정';
  $('submitBtn').textContent = '저장';
  $('editName').textContent = item.name;
  $('editNotice').classList.add('active');
  $('formMessage').textContent = '';
  $('nameInput').focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteEntry(id) {
  const item = entries.find(entry => entry.id === id);
  if (!item || !confirm(`${item.name}님의 기록을 삭제할까요?`)) return;
  try {
    const data = await rpc('delete_entry', {
      p_access_token: accessToken, p_entry_id: id, p_expected_updated_at: item.updatedAt
    });
    if (!data.ok && (data.error === 'EDIT_CONFLICT' || data.error === 'ENTRY_NOT_FOUND')) {
      try { await refreshEntries(); } catch (_) { /* 다음 자동 동기화에서 재시도합니다. */ }
      $('formMessage').textContent = `${messageFor(data.error)} 최신 목록을 확인한 뒤 다시 시도해 주세요.`;
      return;
    }
    if (!data.ok) throw new Error(data.error);
    entries = entries.filter(entry => entry.id !== id);
    if (editingId === id) resetEntryForm();
    render();
  } catch (error) { $('formMessage').textContent = messageFor(error); }
}

function makeCell(text, className, label) {
  const cell = document.createElement('td');
  cell.textContent = text;
  cell.dataset.label = label;
  if (className) cell.className = className;
  return cell;
}

function render() {
  const list = filteredEntries();
  const total = entries.reduce((sum, item) => sum + Number(item.amount), 0);
  $('totalAmount').textContent = formatWon(total);
  $('totalGuests').textContent = entries.length.toLocaleString('ko-KR') + '명';
  $('avgAmount').textContent = formatWon(entries.length ? total / entries.length : 0);
  const isFiltered = Boolean($('filterRel').value || $('searchInput').value.trim());
  $('resultSummary').textContent = isFiltered
    ? `검색 결과 ${list.length}명 · ${formatWon(list.reduce((sum, item) => sum + Number(item.amount), 0))}`
    : entries.length ? `전체 ${entries.length}명의 기록` : '등록된 하객이 없습니다.';

  const container = $('tableContainer');
  container.replaceChildren();
  if (!list.length) {
    const empty = document.createElement('div'); empty.className = 'empty-state';
    const icon = document.createElement('div'); icon.className = 'empty-icon'; icon.textContent = isFiltered ? '🔎' : '💌';
    const title = document.createElement('p'); title.className = 'empty-title'; title.textContent = isFiltered ? '검색 결과가 없어요' : '첫 하객을 등록해 보세요';
    const copy = document.createElement('p'); copy.className = 'empty-copy'; copy.textContent = isFiltered ? '검색어나 관계 필터를 바꿔 보세요.' : '위 입력란에서 이름과 금액을 기록할 수 있어요.';
    empty.append(icon, title, copy); container.append(empty); return;
  }

  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>날짜</th><th>이름</th><th>관계</th><th style="text-align:right">금액</th><th><span class="sr-only">관리</span></th></tr></thead>';
  const body = document.createElement('tbody');
  list.forEach(item => {
    const row = document.createElement('tr');
    row.append(makeCell(formatDate(item.giftedOn), '', '날짜'), makeCell(item.name, 'name-cell', '이름'));
    const relCell = document.createElement('td'); relCell.dataset.label = '관계';
    const badge = document.createElement('span'); badge.className = 'rel-badge'; badge.textContent = item.relation;
    const colors = REL_COLORS[item.relation] || REL_COLORS.기타; badge.style.background = colors[0]; badge.style.color = colors[1]; relCell.append(badge);
    row.append(relCell, makeCell(formatWon(item.amount), 'amount-cell', '금액'));
    const actions = document.createElement('td'); actions.className = 'actions-cell'; actions.dataset.label = '관리';
    const edit = document.createElement('button'); edit.className = 'icon-btn'; edit.type = 'button'; edit.textContent = '수정'; edit.dataset.action = 'edit'; edit.dataset.id = item.id;
    const remove = document.createElement('button'); remove.className = 'icon-btn'; remove.type = 'button'; remove.textContent = '삭제'; remove.dataset.action = 'delete'; remove.dataset.id = item.id;
    actions.append(edit, remove); row.append(actions); body.append(row);
  });
  table.append(body); container.append(table);
}

function csvValue(value) { return `"${String(value).replaceAll('"', '""')}"`; }
function exportCSV() {
  if (!entries.length) { $('formMessage').textContent = '저장할 데이터가 없습니다.'; return; }
  const lines = [['날짜','이름','관계','금액'], ...entries.map(item => [item.giftedOn,item.name,item.relation,item.amount])];
  const blob = new Blob(['\ufeff' + lines.map(row => row.map(csvValue).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${room.title.replace(/[\\/:*?"<>|]/g, '_')}_${new Date().toISOString().slice(0,10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

async function copyShareLink() {
  const url = new URL(location.href); url.searchParams.set('room', room.code);
  try {
    await navigator.clipboard.writeText(url.toString());
    $('shareBtn').textContent = '복사됨';
    setTimeout(() => { $('shareBtn').textContent = '링크 복사'; }, 1400);
  } catch { prompt('아래 링크를 복사해 주세요.', url.toString()); }
}

function bindEvents() {
  $('joinTab').addEventListener('click', () => selectTab('join'));
  $('roomSort').addEventListener('change', event => {
    roomSort = event.target.value;
    renderRoomList();
  });
  $('createTab').addEventListener('click', () => selectTab('create'));
  $('masterTab').addEventListener('click', () => { selectTab('master'); loadRooms(); });
  $('joinForm').addEventListener('submit', joinRoom);
  $('roomList').addEventListener('click', event => {
    const button = event.target.closest('[data-room-code]');
    if (button) selectRoom(button.dataset.roomCode);
  });
  $('changeRoomBtn').addEventListener('click', clearRoomSelection);
  $('createForm').addEventListener('submit', createRoom);
  $('masterLoginForm').addEventListener('submit', masterLogin);
  $('masterLogoutBtn').addEventListener('click', () => masterLogout(true));
  $('masterRoomList').addEventListener('click', event => {
    const button = event.target.closest('[data-master-action]');
    const row = button?.closest('[data-room-code]');
    if (!row) return;
    $('masterMessage').textContent = '';
    if (button.dataset.masterAction === 'rename') masterRenameRoom(row, button);
    else if (button.dataset.masterAction === 'change-pin') masterChangeRoomPin(row, button);
    else masterDeleteRoom(row, button);
  });
  $('masterRoomList').addEventListener('input', event => {
    if (event.target.matches('.master-new-pin, .master-confirm-pin')) {
      event.target.value = event.target.value.replace(/\D/g, '').slice(0, 4);
    }
  });
  $('entryForm').addEventListener('submit', submitEntry);
  $('cancelEditBtn').addEventListener('click', resetEntryForm);
  $('shareBtn').addEventListener('click', copyShareLink);
  $('leaveBtn').addEventListener('click', () => leaveRoom(true));
  $('homeBtn').addEventListener('click', () => room ? leaveRoom(true) : showLobby('join'));
  document.querySelectorAll('.pin-input').forEach(input => input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, input.id === 'masterPin' ? 12 : 4); }));
  document.querySelectorAll('.quick-btn').forEach(button => button.addEventListener('click', () => { $('amountInput').value = button.dataset.amount; $('amountInput').focus(); }));
  $('filterRel').addEventListener('change', render);
  $('searchInput').addEventListener('input', render);
  $('exportBtn').addEventListener('click', exportCSV);
  $('tableContainer').addEventListener('click', event => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    button.dataset.action === 'edit' ? startEdit(button.dataset.id) : deleteEntry(button.dataset.id);
  });
}

async function boot() {
  bindEvents();
  if (!isConfigured()) { showLobby('create'); return; }
  await loadRooms();
  const code = new URL(location.href).searchParams.get('room')?.trim().toUpperCase();
  if (code && /^[A-Z0-9]{6}$/.test(code)) await restoreSession(code);
  else showLobby('join');
}

boot();
