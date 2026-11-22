(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = {
    token: sessionStorage.getItem('pw_access_token') || '',
    user: null,
    campaigns: [],
    campaign: null,
    systems: [],
    availableSystems: [],
    pending: [],
    principles: [],
    placements: {},
    selectedBuilding: 'factory',
    authMode: 'login',
    toastTimer: null,
  };

  const buildingMeta = {
    factory: { label: 'Фабрика', icon: '🏭', required: 2 },
    field: { label: 'Поле', icon: '🌾', required: 2 },
    gold_mine: { label: 'Золотой рудник', icon: '⛏', required: 1 },
    capital: { label: 'Столица', icon: '★', required: 1 },
    religious_building: { label: 'Храм', icon: '✦', required: 1 },
    science: { label: 'Научный центр', icon: '⚗', required: 1 },
    barracks: { label: 'Казармы', icon: '⚔', required: 1 },
    tower: { label: 'Башня', icon: '♜', required: 1 },
  };

  async function request(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (state.token) headers.set('Authorization', `Bearer ${state.token}`);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
    if (!response.ok) {
      const error = new Error(data?.message || data?.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function showToast(message, isError = false) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.toggle('error', isError);
    toast.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove('show'), 3600);
  }

  function setMessage(selector, message, success = false) {
    const element = $(selector);
    element.textContent = message;
    element.classList.toggle('success', success);
  }

  function showScreen(name) {
    $('#auth-screen').classList.toggle('hidden', name !== 'auth');
    $('#game-screen').classList.toggle('hidden', name !== 'game');
    $('#workspace-screen').classList.toggle('hidden', name !== 'workspace');
    $('#logout-button').classList.toggle('hidden', !state.user);
    $('#user-label').classList.toggle('hidden', !state.user);
    $('#user-label').textContent = state.user?.email || '';
  }

  function authMode(mode) {
    state.authMode = mode;
    $$('.auth-tab').forEach((button) => button.classList.toggle('active', button.dataset.authMode === mode));
    $('#auth-title').textContent = mode === 'login' ? 'Добро пожаловать' : 'Создать аккаунт';
    $('#auth-caption').textContent = mode === 'login' ? 'Войди, чтобы продолжить свою историю.' : 'Зарегистрируйся и создай первый мир.';
    $('#auth-submit').innerHTML = mode === 'login' ? 'Войти в игру <span>↗</span>' : 'Создать аккаунт <span>↗</span>';
    $('#auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    setMessage('#auth-message', '');
  }

  async function restoreSession() {
    if (state.token) {
      try {
        const me = await request('/auth/me');
        state.user = me.user;
        return true;
      } catch {
        state.token = '';
        sessionStorage.removeItem('pw_access_token');
      }
    }
    try {
      const refreshed = await fetch('/auth/refresh', { method: 'POST', credentials: 'same-origin' });
      if (!refreshed.ok) return false;
      const data = await refreshed.json();
      state.token = data.accessToken;
      sessionStorage.setItem('pw_access_token', state.token);
      const me = await request('/auth/me');
      state.user = me.user;
      return true;
    } catch {
      state.token = '';
      sessionStorage.removeItem('pw_access_token');
      return false;
    }
  }

  async function loadCampaigns() {
    const data = await request('/campaigns');
    state.campaigns = data.campaigns || [];
    renderCampaigns();
  }

  function renderCampaigns() {
    $('#campaign-count').textContent = String(state.campaigns.length);
    const host = $('#campaign-list');
    if (!state.campaigns.length) {
      host.innerHTML = '<div class="empty-state"><span class="empty-icon">⌘</span><strong>Пока нет кампаний</strong><p>Создай первую, чтобы начать.</p></div>';
      return;
    }
    host.innerHTML = state.campaigns.map((campaign) => `
      <button class="campaign-card" type="button" data-campaign-id="${escapeHtml(campaign.id)}">
        <span><strong>${escapeHtml(campaign.name)}</strong><small>ХОД ${String(campaign.currentTurn).padStart(2, '0')} · ${campaign.mapWidth || '—'} × ${campaign.mapHeight || '—'} · ${campaign.countryId ? 'ГОСУДАРСТВО ОСНОВАНО' : 'ОЖИДАЕТ ОСНОВАНИЯ'}</small></span>
        <span class="campaign-arrow">↗</span>
      </button>`).join('');
    $$('.campaign-card', host).forEach((button) => button.addEventListener('click', () => {
      const campaign = state.campaigns.find((item) => item.id === button.dataset.campaignId);
      if (campaign) openCampaign(campaign);
    }));
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[char]);
  }

  async function openCampaign(campaign) {
    state.campaign = campaign;
    state.systems = [];
    state.availableSystems = [];
    state.placements = {};
    $('#workspace-title').textContent = campaign.name;
    $('#workspace-meta').textContent = `ID ${campaign.id} · ${campaign.mapWidth} × ${campaign.mapHeight} · ${campaign.rulesetVersion || 'baseline-v1'}`;
    $('#map-size-label').textContent = `${campaign.mapWidth} × ${campaign.mapHeight}`;
    $('#map-size-detail').textContent = `${campaign.mapWidth} × ${campaign.mapHeight}`;
    $('#country-status').textContent = campaign.countryId ? 'Основано' : 'Не основано';
    buildWorldPreview();
    showScreen('workspace');
    activateTab('overview');
    await loadSystems();
  }

  function buildWorldPreview() {
    const grid = $('#world-grid');
    const terrain = [
      '............',
      '..fff.......',
      '.fffff..w...',
      '..ff...ww...',
      '...h..ww....',
      '.....w......',
      '............',
    ];
    grid.innerHTML = '';
    terrain.forEach((row, y) => [...row].forEach((tile, x) => {
      const cell = document.createElement('div');
      cell.className = 'world-tile';
      if (tile === 'f') cell.classList.add('forest');
      if (tile === 'w') cell.classList.add('water');
      if (tile === 'h') cell.classList.add('hill');
      if (x === 5 && y === 3) cell.classList.add('capital');
      grid.append(cell);
    }));
  }

  function activateTab(tab) {
    $$('.workspace-tab').forEach((button) => button.classList.toggle('active', button.dataset.tab === tab));
    $$('.tab-panel').forEach((panel) => panel.classList.toggle('hidden', panel.id !== `tab-${tab}`));
    if (tab === 'systems') loadSystems();
    if (tab === 'country') {
      resetTerritoryGrid();
      refreshAvailableSystems().catch((error) => setMessage('#country-message', error.message));
    }
    if (tab === 'admin') loadPending();
  }

  async function loadSystems() {
    if (!state.campaign) return;
    try {
      const data = await request(`/campaigns/${state.campaign.id}/social-systems/mine`);
      state.systems = data.systems || [];
      renderSystems();
      $('#system-count').textContent = String(state.systems.length);
      const approved = state.systems.filter((system) => system.approvalStatus === 'approved').length;
      if (state.campaign) $('#country-status').textContent = state.campaign.countryId ? 'Основано' : (approved ? 'Готово к основанию' : 'Не основано');
    } catch (error) {
      setMessage('#system-message', error.message);
    }
  }

  function renderSystems() {
    const host = $('#systems-list');
    if (!state.systems.length) {
      host.innerHTML = '<div class="empty-state compact">Системы ещё не созданы. Первая заявка появится здесь.</div>';
      return;
    }
    host.innerHTML = state.systems.map((system) => {
      const status = system.approvalStatus;
      const statusText = status === 'approved' ? 'ОДОБРЕНО' : status === 'rejected' ? 'ОТКЛОНЕНО' : 'НА ПРОВЕРКЕ';
      const principles = (system.principles || []).map((item) => `${escapeHtml(item.name)} · ${item.polarity === 'positive' ? '+' : item.polarity === 'negative' ? '−' : '○'}`).join(' / ');
      return `<article class="system-card">
        <div class="system-card-top"><div><span class="system-type">${system.type === 'religion' ? 'РЕЛИГИЯ' : 'ИДЕОЛОГИЯ'}</span><h3>${escapeHtml(system.name)}</h3></div><span class="status-pill ${status}">${statusText}</span></div>
        <div class="principle-summary">${principles}</div>
        ${system.reviewReason ? `<div class="system-reason">Комментарий: ${escapeHtml(system.reviewReason)}</div>` : ''}
      </article>`;
    }).join('');
  }

  function addPrincipleRow(name = '', description = '', polarity = 'positive') {
    if (state.principles.length >= 10) {
      showToast('Максимум — 10 принципов.', true);
      return;
    }
    const id = crypto.randomUUID();
    state.principles.push(id);
    const row = document.createElement('div');
    row.className = 'principle-row';
    row.dataset.principleId = id;
    row.innerHTML = `
      <label class="field"><span>Название</span><input class="principle-name" maxlength="80" minlength="2" placeholder="Название принципа" value="${escapeHtml(name)}" required></label>
      <label class="field"><span>Полярность</span><select class="principle-polarity"><option value="positive">Позитивный +</option><option value="negative">Негативный −</option><option value="neutral">Нейтральный ○</option></select></label>
      <label class="field principle-description"><span>Описание</span><input class="principle-text" maxlength="2000" placeholder="Кратко опиши принцип" value="${escapeHtml(description)}" required></label>
      <button class="remove-principle" type="button" title="Удалить">×</button>`;
    $('.principle-polarity', row).value = polarity;
    $('.remove-principle', row).addEventListener('click', () => {
      state.principles = state.principles.filter((item) => item !== id);
      row.remove();
    });
    $('#principles-list').append(row);
  }

  async function refreshAvailableSystems() {
    if (!state.campaign) return;
    const type = $('#official-system-type').value;
    const x = Number($('#spawn-x').value);
    const y = Number($('#spawn-y').value);
    if (!Number.isInteger(x) || !Number.isInteger(y)) return;
    const query = new URLSearchParams({ systemType: type, spawnX: String(x), spawnY: String(y) });
    const select = $('#official-system');
    select.innerHTML = '<option value="">Загрузка…</option>';
    const data = await request(`/campaigns/${state.campaign.id}/social-systems/available?${query}`);
    state.availableSystems = data.systems || [];
    if (!state.availableSystems.length) {
      select.innerHTML = '<option value="">Нет доступных одобренных систем</option>';
      return;
    }
    select.innerHTML = '<option value="">Выбери учение…</option>' + state.availableSystems.map((system) =>
      `<option value="${escapeHtml(system.id)}">${escapeHtml(system.name)} · ${system.type === 'religion' ? 'религия' : 'идеология'}</option>`).join('');
  }

  function activeExtraTypes() {
    return $('#official-system-type').value === 'religion'
      ? ['religious_building']
      : ['science', 'barracks', 'tower'];
  }

  function updateBuildingChoices() {
    const select = $('#building-type');
    const extra = activeExtraTypes();
    [...select.options].forEach((option) => {
      const type = option.value;
      const isExtra = ['religious_building', 'science', 'barracks', 'tower'].includes(type);
      option.disabled = isExtra && !extra.includes(type);
    });
    if (select.selectedOptions[0]?.disabled) select.value = extra[0];
    state.selectedBuilding = select.value;
  }

  function resetTerritoryGrid() {
    const host = $('#territory-grid');
    host.innerHTML = '';
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'territory-cell';
        button.dataset.x = String(x);
        button.dataset.y = String(y);
        if (x === 2 && y === 2) button.classList.add('center');
        button.setAttribute('aria-label', `Клетка ${x + 1}, ${y + 1}`);
        button.addEventListener('click', () => {
          const key = `${x},${y}`;
          if (state.placements[key]) delete state.placements[key];
          else {
            if (Object.keys(state.placements).length >= 7) {
              showToast('На территории должно быть ровно семь построек.', true);
              return;
            }
            state.placements[key] = state.selectedBuilding;
          }
          renderTerritoryGrid();
        });
        host.append(button);
      }
    }
    renderTerritoryGrid();
  }

  function renderTerritoryGrid() {
    $$('.territory-cell').forEach((button) => {
      const key = `${button.dataset.x},${button.dataset.y}`;
      const type = state.placements[key];
      button.classList.toggle('occupied', Boolean(type));
      button.innerHTML = type ? `${buildingMeta[type].icon}<small>${buildingMeta[type].label.slice(0, 3)}</small>` : (key === '2,2' ? '·' : '');
      button.title = type ? buildingMeta[type].label : 'Пустая клетка';
    });
    const counts = {};
    Object.values(state.placements).forEach((type) => { counts[type] = (counts[type] || 0) + 1; });
    const required = { factory: 2, field: 2, gold_mine: 1, capital: 1 };
    const extra = activeExtraTypes();
    const extraCount = extra.reduce((sum, type) => sum + (counts[type] || 0), 0);
    const valid = Object.entries(required).every(([type, count]) => counts[type] === count)
      && extraCount === 1 && Object.keys(counts).length === Object.keys(counts).filter((type) => type in required || extra.includes(type)).length
      && Object.keys(state.placements).length === 7;
    $('#building-counts').textContent = Object.entries(buildingMeta)
      .filter(([type]) => required[type] || extra.includes(type))
      .map(([type, meta]) => `${meta.icon} ${meta.label}: ${counts[type] || 0}/${required[type] || 1}`)
      .join('   ·   ') + (valid ? '   ✓ ГОТОВО' : '   ·   НЕ ЗАПОЛНЕНО');
  }

  async function loadPending() {
    if (!state.campaign) return;
    const host = $('#pending-list');
    host.innerHTML = '<div class="empty-state compact">Загружаем заявки…</div>';
    try {
      const data = await request(`/campaigns/${state.campaign.id}/social-systems/pending`);
      state.pending = data.systems || [];
      if (!state.pending.length) {
        host.innerHTML = '<div class="empty-state compact">Нет ожидающих заявок. Если у тебя нет прав модератора, доступ к этому разделу закрыт.</div>';
        return;
      }
      host.innerHTML = state.pending.map((system) => `
        <article class="system-card">
          <div class="system-card-top"><div><span class="system-type">${system.type === 'religion' ? 'РЕЛИГИЯ' : 'ИДЕОЛОГИЯ'}</span><h3>${escapeHtml(system.name)}</h3></div><span class="status-pill pending">НА ПРОВЕРКЕ</span></div>
          <div class="principle-summary">${(system.principles || []).map((item) => `${escapeHtml(item.name)} — ${escapeHtml(item.description)} (${item.polarity})`).join('<br>')}</div>
          <div class="admin-actions"><button class="button button-primary approve-system" data-id="${escapeHtml(system.id)}" type="button">Одобрить</button><button class="button button-outline reject-system" data-id="${escapeHtml(system.id)}" type="button">Отклонить</button></div>
        </article>`).join('');
      $$('.approve-system', host).forEach((button) => button.addEventListener('click', () => reviewSystem(button.dataset.id, 'approve')));
      $$('.reject-system', host).forEach((button) => button.addEventListener('click', () => reviewSystem(button.dataset.id, 'reject')));
    } catch (error) {
      host.innerHTML = `<div class="empty-state compact">${error.status === 403 ? 'Этот раздел доступен только назначенным администраторам.' : escapeHtml(error.message)}</div>`;
    }
  }

  async function reviewSystem(systemId, decision) {
    try {
      await request(`/campaigns/${state.campaign.id}/social-systems/${systemId}/review`, {
        method: 'POST',
        body: JSON.stringify({ decision }),
      });
      showToast(decision === 'approve' ? 'Система одобрена.' : 'Система отклонена.');
      await loadPending();
    } catch (error) {
      showToast(error.message, true);
    }
  }

  async function submitCountry(event) {
    event.preventDefault();
    const counts = Object.values(state.placements).reduce((acc, type) => {
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {});
    const extra = activeExtraTypes();
    const valid = counts.factory === 2 && counts.field === 2 && counts.gold_mine === 1 && counts.capital === 1
      && extra.reduce((sum, type) => sum + (counts[type] || 0), 0) === 1
      && Object.keys(state.placements).length === 7
      && Object.keys(counts).every((type) => ['factory', 'field', 'gold_mine', 'capital', ...extra].includes(type));
    if (!valid) {
      setMessage('#country-message', 'Размести семь построек: 2 фабрики, 2 поля, рудник, столицу и одну особую постройку.');
      return;
    }
    const payload = {
      name: $('#country-name').value.trim(),
      spawnX: Number($('#spawn-x').value),
      spawnY: Number($('#spawn-y').value),
      officialSystemId: $('#official-system').value,
      buildings: Object.entries(state.placements).map(([key, type]) => {
        const [x, y] = key.split(',').map(Number);
        return { type, x, y };
      }),
    };
    if (!payload.officialSystemId) {
      setMessage('#country-message', 'Сначала выбери одобренную официальную систему.');
      return;
    }
    try {
      const data = await request(`/campaigns/${state.campaign.id}/countries`, {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      showToast(`Государство «${data.country.name}» основано!`);
      setMessage('#country-message', `Государство создано. Территория ${data.country.territory.width}×${data.country.territory.height}, жителей: ${data.country.residentCount}.`, true);
      state.campaign.countryId = data.country.id;
      $('#country-status').textContent = 'Основано';
      await loadCampaigns();
    } catch (error) {
      setMessage('#country-message', error.message);
    }
  }

  function bindEvents() {
    $$('.auth-tab').forEach((button) => button.addEventListener('click', () => authMode(button.dataset.authMode)));
    $('#auth-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const email = $('#auth-email').value.trim();
      const password = $('#auth-password').value;
      try {
        const data = await request(state.authMode === 'login' ? '/auth/login' : '/auth/register', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        });
        state.token = data.accessToken;
        sessionStorage.setItem('pw_access_token', state.token);
        state.user = data.user;
        await loadCampaigns();
        showScreen('game');
        showToast(state.authMode === 'login' ? 'С возвращением.' : 'Аккаунт создан.');
      } catch (error) {
        setMessage('#auth-message', error.message === 'UNAUTHENTICATED' ? 'Неверная почта или пароль.' : error.message);
      }
    });

    $('#logout-button').addEventListener('click', async () => {
      try { await request('/auth/logout', { method: 'POST' }); } catch { /* Session is cleared locally regardless. */ }
      state.token = '';
      state.user = null;
      sessionStorage.removeItem('pw_access_token');
      showScreen('auth');
      showToast('Сессия завершена.');
    });

    $('#campaign-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      try {
        const data = await request('/campaigns', {
          method: 'POST',
          body: JSON.stringify({
            name: $('#campaign-name').value.trim(),
            mapWidth: Number($('#map-width').value),
            mapHeight: Number($('#map-height').value),
          }),
        });
        $('#campaign-form').reset();
        $('#map-width').value = '40';
        $('#map-height').value = '30';
        await loadCampaigns();
        showToast(`Кампания «${data.campaign.name}» создана.`);
      } catch (error) {
        setMessage('#campaign-message', error.message);
      }
    });

    $('#back-to-campaigns').addEventListener('click', async () => {
      await loadCampaigns();
      showScreen('game');
    });
    $$('.workspace-tab').forEach((button) => button.addEventListener('click', () => activateTab(button.dataset.tab)));
    $$('[data-go-tab]').forEach((button) => button.addEventListener('click', () => activateTab(button.dataset.goTab)));

    $('#add-principle').addEventListener('click', () => addPrincipleRow());
    $('#system-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const principles = $$('.principle-row').map((row) => ({
        name: $('.principle-name', row).value.trim(),
        description: $('.principle-text', row).value.trim(),
        polarity: $('.principle-polarity', row).value,
      }));
      try {
        await request(`/campaigns/${state.campaign.id}/social-systems`, {
          method: 'POST',
          body: JSON.stringify({
            type: $('#system-type').value,
            name: $('#system-name').value.trim(),
            principles,
          }),
        });
        $('#system-name').value = '';
        $('#principles-list').innerHTML = '';
        state.principles = [];
        addPrincipleRow('', '', 'positive');
        addPrincipleRow('', '', 'positive');
        addPrincipleRow('', '', 'neutral');
        setMessage('#system-message', 'Заявка отправлена. Система появится в списке со статусом «На проверке».', true);
        await loadSystems();
        showToast('Система отправлена на согласование.');
      } catch (error) {
        setMessage('#system-message', error.message);
      }
    });

    $('#refresh-systems').addEventListener('click', loadSystems);
    $('#official-system-type').addEventListener('change', () => {
      updateBuildingChoices();
      refreshAvailableSystems().catch((error) => setMessage('#country-message', error.message));
      renderTerritoryGrid();
    });
    $('#spawn-x').addEventListener('change', () => refreshAvailableSystems().catch((error) => setMessage('#country-message', error.message)));
    $('#spawn-y').addEventListener('change', () => refreshAvailableSystems().catch((error) => setMessage('#country-message', error.message)));
    $('#building-type').addEventListener('change', (event) => { state.selectedBuilding = event.target.value; });
    $('#country-form').addEventListener('submit', submitCountry);
    $('#refresh-pending').addEventListener('click', loadPending);
  }

  async function init() {
    bindEvents();
    buildWorldPreview();
    addPrincipleRow('Взаимопомощь', 'Члены общества поддерживают друг друга.', 'positive');
    addPrincipleRow('Справедливость', 'Закон одинаков для всех жителей.', 'positive');
    addPrincipleRow('Созерцание', 'Каждый волен искать собственный путь.', 'neutral');
    resetTerritoryGrid();
    updateBuildingChoices();

    const authenticated = await restoreSession();
    if (authenticated) {
      try {
        await loadCampaigns();
        showScreen('game');
      } catch {
        state.token = '';
        sessionStorage.removeItem('pw_access_token');
        showScreen('auth');
      }
    } else {
      showScreen('auth');
    }
  }

  init();
})();
