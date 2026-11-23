export const CHAT_PAGE_HTML = String.raw`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <title>Paper Wars — чаты</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#10151c; color:#ecf0f4; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:radial-gradient(circle at 15% 0%,#263342 0,#10151c 48%); }
    button,input,textarea,select { font:inherit; }
    button { border:1px solid #3d4a59; border-radius:10px; padding:10px 14px; color:#f4f6f8; background:#263545; cursor:pointer; }
    button:hover:not(:disabled) { background:#34495e; }
    button:disabled { opacity:.45; cursor:not-allowed; }
    input,textarea,select { width:100%; border:1px solid #3d4a59; border-radius:10px; padding:11px 12px; color:#f4f6f8; background:#111a24; }
    label { display:grid; gap:7px; color:#b9c4cf; font-size:13px; }
    .shell { width:min(980px,calc(100% - 32px)); margin:0 auto; padding:28px 0 42px; }
    .top { display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:22px; }
    .brand { font-weight:800; letter-spacing:.12em; font-size:13px; color:#d4a96b; }
    h1 { margin:7px 0 0; font-size:clamp(25px,5vw,38px); letter-spacing:-.04em; }
    .sub { color:#9eacb9; margin:7px 0 0; }
    .panel { border:1px solid #344250; border-radius:18px; background:rgba(22,31,41,.94); box-shadow:0 20px 60px #0005; }
    .auth { max-width:440px; margin:54px auto; padding:24px; display:grid; gap:16px; }
    .auth h2 { margin:0; font-size:22px; }
    .auth-actions { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    .link { border:0; padding:6px 0; background:transparent; color:#e2b777; text-decoration:underline; }
    .error { min-height:20px; color:#ff9f91; font-size:13px; }
    .chat { overflow:hidden; }
    .chat-head { padding:17px 20px; display:flex; justify-content:space-between; align-items:center; gap:14px; border-bottom:1px solid #344250; }
    .room-title { font-weight:700; font-size:17px; }
    .room-hint { color:#9eacb9; font-size:12px; margin-top:4px; }
    .room-tabs { display:flex; gap:8px; padding:14px 18px 0; }
    .room-tabs button.active { background:#a8763f; border-color:#d3a66d; color:#171b20; font-weight:700; }
    .campaign-picker { width:min(300px,48%); }
    .messages { height:min(58vh,620px); min-height:280px; overflow:auto; display:flex; flex-direction:column; gap:10px; padding:18px; }
    .empty { color:#8796a4; margin:auto; text-align:center; padding:30px 10px; }
    .message { max-width:min(78%,680px); align-self:flex-start; border:1px solid #344250; border-radius:14px 14px 14px 4px; background:#202d3b; padding:10px 13px; white-space:pre-wrap; overflow-wrap:anywhere; }
    .message.mine { align-self:flex-end; background:#344331; border-color:#52664a; border-radius:14px 14px 4px 14px; }
    .message-meta { display:flex; align-items:center; gap:12px; color:#a9b5c0; font-size:11px; margin-bottom:6px; }
    .message-meta strong { color:#e6bd83; font-size:12px; }
    .composer { border-top:1px solid #344250; padding:14px 18px 18px; display:grid; grid-template-columns:1fr auto; gap:10px; align-items:end; }
    .composer textarea { min-height:48px; max-height:140px; resize:vertical; }
    .composer button { min-width:110px; height:48px; }
    .bottom { color:#8493a0; display:flex; justify-content:space-between; gap:12px; font-size:12px; padding:10px 18px 14px; }
    .hidden { display:none !important; }
    @media (max-width:620px) { .shell{width:min(100% - 18px,980px);padding-top:16px}.chat-head{align-items:flex-start;flex-direction:column}.campaign-picker{width:100%}.messages{height:55vh;padding:12px}.message{max-width:92%}.composer{grid-template-columns:1fr}.composer button{width:100%}.room-tabs{padding-inline:12px}.top{align-items:flex-start}.auth{margin:28px auto;padding:18px} }
  </style>
</head>
<body>
  <main class="shell">
    <header class="top">
      <div><div class="brand">PAPER WARS · REBIRTH</div><h1>Связь между державами</h1><p class="sub">Мировой канал и закрытая комната кампании</p></div>
      <button id="logout" class="hidden" type="button">Выйти</button>
    </header>
    <section id="auth-panel" class="panel auth">
      <div><div class="brand">ДОСТУП К ЧАТАМ</div><h2 id="auth-title">Войти в Paper Wars</h2></div>
      <form id="auth-form" style="display:grid;gap:13px">
        <label>Email<input id="email" type="email" autocomplete="username" required maxlength="254"></label>
        <label>Пароль<input id="password" type="password" autocomplete="current-password" required minlength="12" maxlength="1024"></label>
        <div class="auth-actions"><button id="auth-submit" type="submit">Войти</button><button id="auth-mode" class="link" type="button">Создать аккаунт</button></div>
      </form>
      <div id="auth-error" class="error" role="alert"></div>
    </section>
    <section id="chat-panel" class="panel chat hidden">
      <div class="chat-head">
        <div><div class="room-title" id="room-title">Мировой чат</div><div class="room-hint" id="room-hint">Общение всех игроков</div></div>
        <label class="campaign-picker" id="campaign-picker">Текущая кампания<select id="campaign-select"></select></label>
      </div>
      <nav class="room-tabs" aria-label="Каналы">
        <button type="button" class="active" id="world-tab">Мировой чат</button>
        <button type="button" id="campaign-tab" disabled>Чат кампании</button>
      </nav>
      <div id="messages" class="messages" role="log" aria-live="polite"><div class="empty">Загрузка сообщений…</div></div>
      <form id="send-form" class="composer">
        <textarea id="message" placeholder="Написать сообщение…" maxlength="2000" rows="2" required></textarea>
        <button id="send" type="submit">Отправить</button>
      </form>
      <div class="bottom"><span id="status" role="status"></span><span>Enter — отправить · Shift+Enter — новая строка</span></div>
    </section>
  </main>
<script>
(() => {
  'use strict';
  const state = { token: null, register: false, room: 'world', campaignId: null, campaigns: [], requestId: 0, timer: null, sending: false, refreshPromise: null };
  const $ = (id) => document.getElementById(id);
  const authPanel = $('auth-panel');
  const chatPanel = $('chat-panel');
  const authForm = $('auth-form');
  const messages = $('messages');
  const messageInput = $('message');

  function setStatus(value, isError) {
    $('status').textContent = value || '';
    $('status').style.color = isError ? '#ff9f91' : '';
  }
  function showAuth(error) {
    stopPolling();
    state.token = null;
    authPanel.classList.remove('hidden');
    chatPanel.classList.add('hidden');
    $('logout').classList.add('hidden');
    $('auth-error').textContent = error || '';
  }
  function showChat() {
    authPanel.classList.add('hidden');
    chatPanel.classList.remove('hidden');
    $('logout').classList.remove('hidden');
  }
  function refreshAccessToken() {
    if (!state.refreshPromise) {
      state.refreshPromise = (async () => {
        const response = await fetch('/auth/refresh', {
          method: 'POST',
          credentials: 'same-origin',
        });
        const body = await response.json().catch(() => null);
        if (!response.ok || !body || typeof body.accessToken !== 'string') {
          throw new Error('Сессия завершена. Войдите снова.');
        }
        state.token = body.accessToken;
        return state.token;
      })().finally(() => {
        state.refreshPromise = null;
      });
    }
    return state.refreshPromise;
  }
  async function api(path, options, retried) {
    const opts = options || {};
    const headers = new Headers(opts.headers || {});
    if (state.token) headers.set('Authorization', 'Bearer ' + state.token);
    if (opts.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...opts, headers, credentials: 'same-origin' });
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    if (response.status === 401 && state.token && path !== '/auth/refresh' && !retried) {
      try {
        await refreshAccessToken();
        return api(path, opts, true);
      } catch (_) {
        // Preserve the original request error; the caller will return to the login screen.
      }
    }
    if (!response.ok) {
      const error = new Error((body && body.message) || 'Запрос завершился ошибкой.');
      error.status = response.status;
      error.code = body && body.error;
      throw error;
    }
    return body;
  }
  async function refreshSession() {
    await refreshAccessToken();
  }
  function stopPolling() {
    if (state.timer !== null) window.clearInterval(state.timer);
    state.timer = null;
    state.requestId += 1;
  }
  function startPolling() {
    if (state.timer !== null) window.clearInterval(state.timer);
    state.timer = window.setInterval(() => {
      if (!document.hidden) void loadMessages();
    }, 5000);
  }
  function renderMessages(items) {
    messages.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Пока тихо. Напишите первое сообщение.';
      messages.append(empty);
      return;
    }
    for (const item of items) {
      const article = document.createElement('article');
      article.className = 'message' + (item.isMine ? ' mine' : '');
      const meta = document.createElement('div');
      meta.className = 'message-meta';
      const author = document.createElement('strong');
      author.textContent = item.authorLabel;
      const time = document.createElement('time');
      const date = new Date(item.createdAt);
      time.textContent = Number.isNaN(date.getTime()) ? '' : date.toLocaleString('ru-RU', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      meta.append(author, time);
      const content = document.createElement('div');
      content.textContent = item.message;
      article.append(meta, content);
      messages.append(article);
    }
    messages.scrollTop = messages.scrollHeight;
  }
  function updateRoom() {
    const world = state.room === 'world';
    $('world-tab').classList.toggle('active', world);
    $('campaign-tab').classList.toggle('active', !world);
    $('campaign-tab').disabled = state.campaignId === null;
    $('campaign-picker').classList.toggle('hidden', state.campaigns.length === 0);
    $('room-title').textContent = world ? 'Мировой чат' : 'Чат кампании';
    const campaign = state.campaigns.find((item) => item.id === state.campaignId);
    $('room-hint').textContent = world ? 'Общение всех игроков Paper Wars' : (campaign ? campaign.name : 'Текущая кампания');
  }
  async function loadCampaigns() {
    const body = await api('/campaigns');
    state.campaigns = Array.isArray(body.campaigns) ? body.campaigns : [];
    const select = $('campaign-select');
    select.replaceChildren();
    for (const campaign of state.campaigns) {
      const option = document.createElement('option');
      option.value = campaign.id;
      option.textContent = campaign.name;
      select.append(option);
    }
    if (!state.campaigns.some((item) => item.id === state.campaignId)) {
      state.campaignId = state.campaigns[0] ? state.campaigns[0].id : null;
    }
    select.value = state.campaignId || '';
    updateRoom();
  }
  async function loadMessages() {
    if (!state.token) return;
    const room = state.room;
    const campaignId = state.campaignId;
    if (room === 'campaign' && campaignId === null) return;
    const requestId = ++state.requestId;
    try {
      const path = room === 'world' ? '/chat/world' : '/campaigns/' + encodeURIComponent(campaignId) + '/chat';
      const body = await api(path);
      if (requestId !== state.requestId || room !== state.room || campaignId !== state.campaignId) return;
      renderMessages(Array.isArray(body.messages) ? body.messages : []);
      setStatus('', false);
    } catch (error) {
      if (requestId !== state.requestId) return;
      if (error.status === 401) { showAuth('Сессия завершена. Войдите снова.'); return; }
      setStatus(error.status === 403 ? 'Нет доступа к чату этой кампании.' : error.message, true);
    }
  }
  async function submitMessage(event) {
    event.preventDefault();
    if (state.sending || !state.token) return;
    const value = messageInput.value.trim();
    if (!value) return;
    state.sending = true;
    $('send').disabled = true;
    setStatus('', false);
    try {
      const path = state.room === 'world' ? '/chat/world' : '/campaigns/' + encodeURIComponent(state.campaignId) + '/chat';
      await api(path, { method: 'POST', body: JSON.stringify({ message: value }) });
      messageInput.value = '';
      await loadMessages();
    } catch (error) {
      if (error.status === 429) setStatus('Слишком много сообщений. Подождите несколько секунд.', true);
      else if (error.status === 403) setStatus('Вы больше не состоите в этой кампании.', true);
      else if (error.status === 401) showAuth('Сессия завершена. Войдите снова.');
      else setStatus(error.message, true);
    } finally {
      state.sending = false;
      $('send').disabled = false;
      messageInput.focus();
    }
  }
  async function enterChat() {
    try {
      await loadCampaigns();
      state.room = 'world';
      updateRoom();
      showChat();
      await loadMessages();
      startPolling();
    } catch (error) {
      showAuth(error.message || 'Не удалось восстановить сессию.');
    }
  }
  authForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    $('auth-submit').disabled = true;
    $('auth-error').textContent = '';
    try {
      const endpoint = state.register ? '/auth/register' : '/auth/login';
      const body = await api(endpoint, { method: 'POST', body: JSON.stringify({ email: $('email').value, password: $('password').value }) });
      state.token = body.accessToken;
      await enterChat();
    } catch (error) {
      $('auth-error').textContent = error.status === 401 ? 'Неверный email или пароль.' : error.message;
    } finally {
      $('auth-submit').disabled = false;
    }
  });
  $('auth-mode').addEventListener('click', () => {
    state.register = !state.register;
    $('auth-title').textContent = state.register ? 'Создать аккаунт' : 'Войти в Paper Wars';
    $('auth-submit').textContent = state.register ? 'Зарегистрироваться' : 'Войти';
    $('auth-mode').textContent = state.register ? 'У меня уже есть аккаунт' : 'Создать аккаунт';
    $('password').autocomplete = state.register ? 'new-password' : 'current-password';
    $('auth-error').textContent = '';
  });
  $('world-tab').addEventListener('click', () => {
    if (state.room === 'world') return;
    state.room = 'world';
    stopPolling();
    messages.replaceChildren();
    updateRoom();
    void loadMessages();
    startPolling();
  });
  $('campaign-tab').addEventListener('click', () => {
    if (state.campaignId === null || state.room === 'campaign') return;
    state.room = 'campaign';
    stopPolling();
    messages.replaceChildren();
    updateRoom();
    void loadMessages();
    startPolling();
  });
  $('campaign-select').addEventListener('change', () => {
    state.campaignId = $('campaign-select').value || null;
    if (state.room === 'campaign' && state.campaignId === null) state.room = 'world';
    stopPolling();
    updateRoom();
    void loadMessages();
    startPolling();
  });
  $('send-form').addEventListener('submit', submitMessage);
  messageInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $('send-form').requestSubmit();
    }
  });
  $('logout').addEventListener('click', async () => {
    stopPolling();
    try { await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch (_) {}
    showAuth('Вы вышли из системы.');
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && state.token) void loadMessages();
  });
  refreshSession().then(enterChat).catch(() => showAuth('Войдите, чтобы пользоваться чатами.'));
})();
</script>
</body>
</html>`;
