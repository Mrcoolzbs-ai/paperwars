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
    mapView: null,
    mapSelectedCenter: null,
    mapTransform: null,
    mapLayout: null,
    mapDrag: null,
  };

  const principleCatalog = {
    religion: {
      positive: [
        ['Милосердие','Помощь больным, бедным и попавшим в беду.','Снижает недовольство населения на 5%'],
        ['Общинная взаимопомощь','Верующие обязаны поддерживать соседей и общину.','Увеличивает продовольственное снабжение на 5%'],
        ['Священное гостеприимство','Путники и переселенцы получают защиту.','Повышает приток населения на 5%'],
        ['Благотворительность','Храмы собирают средства для общественных нужд.','Снижает расходы на содержание зданий на 1 монету за ход'],
        ['Единство общин','Общие обряды укрепляют чувство принадлежности.','Повышает стабильность государства на 5 пунктов'],
        ['Защита слабых','Запрещено притеснять детей, стариков и беззащитных.','Снижает риск беспорядков на 10%'],
        ['Священное образование','Знания и грамотность считаются добродетелью.','Ускоряет научное развитие на 5%'],
        ['Уважение к жизни','Жизнь человека имеет особую ценность.','Снижает потери населения от кризисов на 5%'],
        ['Труд как служение','Честный труд считается общественным долгом.','Повышает производство товаров на 5%'],
        ['Мир между общинами','Споры следует решать переговорами.','Снижает напряжённость с соседями на 5%']
      ],
      neutral: [
        ['Аскетизм','Последователи избегают роскоши и излишеств.','Не даёт числового бонуса или штрафа'],
        ['Священные тексты','Учение опирается на письменные каноны.','Не даёт числового бонуса или штрафа'],
        ['Праздничный календарь','Год разделён на религиозные праздники.','Не даёт числового бонуса или штрафа'],
        ['Паломничество','Верующие посещают памятные места.','Не даёт числового бонуса или штрафа'],
        ['Местные святыни','Почитаются места, связанные с историей общины.','Не даёт числового бонуса или штрафа'],
        ['Молитвенные собрания','Община регулярно собирается для молитвы.','Не даёт числового бонуса или штрафа'],
        ['Хранители традиций','Обряды передаются между поколениями.','Не даёт числового бонуса или штрафа'],
        ['Многообразие обрядов','Допускаются разные местные формы богослужения.','Не даёт числового бонуса или штрафа'],
        ['Погребальные обычаи','Покойных провожают установленным ритуалом.','Не даёт числового бонуса или штрафа'],
        ['Сезонные церемонии','Обряды связаны со сменой времён года.','Не даёт числового бонуса или штрафа']
      ],
      negative: [
        ['Религиозная десятина','Каждая семья отдаёт часть дохода храмам.','Повышает расходы населения на 5%'],
        ['Запрет ереси','Отклонение от официального учения карается.','Повышает риск протестов на 5%'],
        ['Закрытые духовные сословия','Высокие религиозные должности доступны узкому кругу.','Снижает социальную мобильность на 10%'],
        ['Изоляция неверных','Не рекомендуется общаться с иными верованиями.','Ухудшает отношения с соседями другой веры на 5%'],
        ['Догматизм','Толкование священных текстов не подлежит пересмотру.','Снижает научное развитие на 5%'],
        ['Принудительное обращение','Власть поддерживает обращение силой.','Повышает риск восстаний на 10%'],
        ['Культ мученичества','Жертвенность и страдание прославляются.','Увеличивает потери населения в конфликтах на 5%'],
        ['Запрет роскоши','Частное потребление и украшения ограничиваются.','Снижает производство товаров на 5%'],
        ['Священная война','Война может объявляться религиозным долгом.','Повышает мобилизацию на 5%, ухудшает дипломатию на 5%'],
        ['Суровые религиозные наказания','Нарушение норм карается взысканиями.','Снижает стабильность на 5 пунктов']
      ]
    },
    ideology: {
      positive: [
        ['Равенство перед законом','Закон применяется одинаково ко всем гражданам.','Снижает внутреннее недовольство на 5%'],
        ['Общественные инвестиции','Государство вкладывает ресурсы в инфраструктуру.','Повышает эффективность инфраструктуры на 5%'],
        ['Свобода исследований','Учёные могут проверять устоявшиеся взгляды.','Ускоряет исследования на 10%'],
        ['Профессиональная служба','Должности занимают по компетенции.','Повышает эффективность управления на 5%'],
        ['Социальная защита','Государство поддерживает уязвимые группы.','Снижает потери населения в кризисах на 5%'],
        ['Гражданское участие','Жители участвуют в местных решениях.','Повышает стабильность на 5 пунктов'],
        ['Открытая торговля','Обмен с другими государствами поощряется.','Повышает доход от торговли на 5%'],
        ['Экологическая ответственность','Ресурсы используются с расчётом на будущее.','Снижает истощение ресурсов на 5%'],
        ['Образование для всех','Базовое обучение доступно каждому жителю.','Ускоряет исследования на 5%'],
        ['Мирное сосуществование','Различия взглядов не являются поводом для преследования.','Снижает дипломатическое напряжение на 5%']
      ],
      neutral: [
        ['Конституционная традиция','Основной закон фиксирует устройство государства.','Не даёт числового бонуса или штрафа'],
        ['Местное самоуправление','Регионы сохраняют собственные советы.','Не даёт числового бонуса или штрафа'],
        ['Смешанная экономика','Частные и общественные предприятия сосуществуют.','Не даёт числового бонуса или штрафа'],
        ['Светский характер власти','Органы государства отделены от религии.','Не даёт числового бонуса или штрафа'],
        ['Наследие предков','Исторические обычаи сохраняются в обществе.','Не даёт числового бонуса или штрафа'],
        ['Гражданский кодекс','Повседневные отношения регулируются единым кодексом.','Не даёт числового бонуса или штрафа'],
        ['Коллегиальное руководство','Решения обсуждаются советом должностных лиц.','Не даёт числового бонуса или штрафа'],
        ['Национальная символика','Символы подчёркивают общую историю.','Не даёт числового бонуса или штрафа'],
        ['Обязательная перепись','Население и имущество регулярно учитываются.','Не даёт числового бонуса или штрафа'],
        ['Региональные языки','Местные языки получают культурное признание.','Не даёт числового бонуса или штрафа']
      ],
      negative: [
        ['Цензура прессы','Критика власти и официальной линии ограничивается.','Уменьшает распространение недовольства, но снижает стабильность на 5 пунктов'],
        ['Монополия правящей партии','Политическая конкуренция запрещена.','Повышает управляемость на 5%, риск протестов на 5%'],
        ['Принудительный труд','Государство назначает обязательные работы.','Снижает расходы строительства на 5%, счастье на 10%'],
        ['Классовые привилегии','Права зависят от социального положения.','Снижает мобильность населения на 10%'],
        ['Политические репрессии','Оппоненты власти преследуются государством.','Повышает недовольство на 10%'],
        ['Милитаризация общества','Военная подготовка становится обязательной нормой.','Повышает мобилизационный резерв на 10%, производство ниже на 5%'],
        ['Экономический протекционизм','Импорт ограничивается ради внутренних производителей.','Внутреннее производство +5%, торговый доход −10%'],
        ['Культ лидера','Личность правителя ставится выше институтов.','Лояльность +5%, стабильность при смене власти −10%'],
        ['Принудительная ассимиляция','Меньшинства обязаны отказаться от традиций.','Повышает риск мятежей на 10%'],
        ['Экспансионизм','Расширение территории считается постоянной целью.','Стоимость захвата −5%, отношения с соседями −10%']
      ]
    }
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

  async function leaveCampaign(campaignId) {
    const campaign = state.campaigns.find((item) => item.id === campaignId);
    if (!campaign || !window.confirm('Покинуть кампанию «' + campaign.name + '»? Она исчезнет из твоего списка.')) return;
    try {
      await request('/campaigns/' + campaignId + '/leave', { method: 'DELETE' });
      const wasOpen = state.campaign?.id === campaignId;
      if (wasOpen) state.campaign = null;
      await loadCampaigns();
      if (wasOpen) showScreen('game');
      showToast('Ты покинул кампанию. Она удалена из твоего списка.');
    } catch (error) {
      showToast(error.message, true);
    }
  }

  function renderCampaigns() {
    $('#campaign-count').textContent = String(state.campaigns.length);
    const host = $('#campaign-list');
    if (!state.campaigns.length) {
      host.innerHTML = '<div class="empty-state"><span class="empty-icon">⌘</span><strong>Пока нет кампаний</strong><p>Создай первую, чтобы начать.</p></div>';
      return;
    }
    host.innerHTML = state.campaigns.map((campaign) => `
      <article class="campaign-card">
        <button class="campaign-open" type="button" data-campaign-id="${escapeHtml(campaign.id)}">
          <span><strong>${escapeHtml(campaign.name)}</strong><small>ХОД ${String(campaign.currentTurn).padStart(2, '0')} · ${campaign.mapWidth || '—'} × ${campaign.mapHeight || '—'} · ${campaign.countryId ? 'ГОСУДАРСТВО ОСНОВАНО' : 'ОЖИДАЕТ ОСНОВАНИЯ'}</small></span>
          <span class="campaign-arrow">↗</span>
        </button>
        <div class="campaign-card-meta">
          <span>Игроки <strong>${campaign.playerCount}/${campaign.maxPlayers}</strong></span>
          <span>SEED <code>${escapeHtml(campaign.mapSeed)}</code></span>
          <button class="campaign-leave" data-campaign-id="${escapeHtml(campaign.id)}" type="button">Покинуть</button>
        </div>
      </article>`).join('');
    Array.from(host.querySelectorAll('.campaign-open')).forEach((button) => button.addEventListener('click', () => {
      const campaign = state.campaigns.find((item) => item.id === button.dataset.campaignId);
      if (campaign) openCampaign(campaign);
    }));
    Array.from(host.querySelectorAll('.campaign-leave')).forEach((button) => button.addEventListener('click', () => {
      leaveCampaign(button.dataset.campaignId);
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
    $('#workspace-meta').textContent = `ID ${campaign.id} · ${campaign.mapWidth} × ${campaign.mapHeight} · ${campaign.rulesetVersion || 'baseline-v1'} · SEED ${campaign.mapSeed}`;
    $('#map-size-label').textContent = campaign.mapWidth + ' × ' + campaign.mapHeight;
    $('#map-size-detail').textContent = `${campaign.mapWidth} × ${campaign.mapHeight}`;
    $('#map-seed-detail').textContent = campaign.mapSeed;
    $('#player-count-chip').textContent = 'Игроки ' + campaign.playerCount + '/' + campaign.maxPlayers;
    $('#player-count-detail').textContent = campaign.playerCount + '/' + campaign.maxPlayers;
    $('#country-status').textContent = campaign.countryId ? 'Основано' : 'Не основано';
    state.mapView = null;
    await loadCampaignMap();
    showScreen('workspace');
    requestAnimationFrame(buildWorldPreview);
    activateTab('overview');
    await loadSystems();
    if (!campaign.countryId) {
      const reservation = (state.mapView?.reservations || []).find((item) => item.isMine);
      if (reservation) {
        activateTab('systems');
        await refreshAvailableSystems();
      } else {
        openMap();
      }
    }
  }

  function terrainCodeAt(x, y) {
    if (!state.mapView || x < 0 || y < 0 || x >= state.mapView.width || y >= state.mapView.height) return 'w';
    return state.mapView.terrain[y * state.mapView.width + x] || 'w';
  }

  function mapIsLand(x, y) {
    return terrainCodeAt(x, y) === 'l';
  }

  async function loadCampaignMap() {
    if (!state.campaign) return;
    const data = await request('/campaigns/' + state.campaign.id + '/map');
    state.mapView = data.map;
    buildWorldPreview();
    renderTerritoryGrid();
    if (!$('#map-modal').classList.contains('hidden')) drawMapCanvas($('#map-canvas'), false);
  }

  function countryColor(id) {
    const colors = ['#e7d6a8','#c7d9b9','#d7c1db','#b9d8df','#e0c6b5','#c9c9e6','#d7d7b4'];
    let hash = 0;
    for (let i = 0; i < id.length; i += 1) hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
    return colors[Math.abs(hash) % colors.length];
  }

  function drawMapCanvas(canvas, miniature) {
    if (!canvas || !state.mapView) return;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = '#0876b9';
    ctx.fillRect(0, 0, rect.width, rect.height);
    const width = state.mapView.width;
    const height = state.mapView.height;
    let cellSize, left, top;
    if (miniature) {
      cellSize = Math.max(1, Math.min(12, (rect.width - 12) / width, (rect.height - 12) / height));
      left = (rect.width - cellSize * width) / 2;
      top = (rect.height - cellSize * height) / 2;
    } else {
      if (!state.mapTransform) {
        const fit = Math.min((rect.width - 36) / width, (rect.height - 36) / height);
        state.mapTransform = { zoom: Math.max(1, fit / 8), x: 18, y: 18 };
      }
      cellSize = Math.max(2, Math.min(36, 8 * state.mapTransform.zoom));
      left = state.mapTransform.x;
      top = state.mapTransform.y;
      if (left + cellSize * width < 20) left = 20 - cellSize * width;
      if (top + cellSize * height < 20) top = 20 - cellSize * height;
      state.mapTransform.x = left;
      state.mapTransform.y = top;
    }
    state.mapLayout = { left, top, cellSize };
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const px = left + x * cellSize;
        const py = top + y * cellSize;
        ctx.fillStyle = mapIsLand(x, y) ? '#ffffff' : '#0876b9';
        ctx.fillRect(px, py, cellSize, cellSize);
        ctx.strokeStyle = '#111111';
        ctx.lineWidth = miniature ? 0.35 : 0.8;
        ctx.strokeRect(px, py, cellSize, cellSize);
      }
    }
    for (const country of (state.mapView.countries || [])) {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const cell of country.cells) {
        minX = Math.min(minX, cell.x); minY = Math.min(minY, cell.y);
        maxX = Math.max(maxX, cell.x); maxY = Math.max(maxY, cell.y);
        const px = left + cell.x * cellSize;
        const py = top + cell.y * cellSize;
        ctx.fillStyle = mapIsLand(cell.x, cell.y) ? '#ffffff' : '#0876b9';
        ctx.fillRect(px, py, cellSize, cellSize);
        ctx.strokeStyle = '#111111';
        ctx.lineWidth = miniature ? 0.45 : 0.8;
        ctx.strokeRect(px, py, cellSize, cellSize);
      }
      if (!miniature && country.cells.length) {
        ctx.strokeStyle = '#050505';
        ctx.lineWidth = 3;
        ctx.strokeRect(left + minX * cellSize + 1, top + minY * cellSize + 1,
          (maxX - minX + 1) * cellSize - 2, (maxY - minY + 1) * cellSize - 2);
        ctx.fillStyle = '#101820';
        ctx.font = 'bold ' + Math.max(10, Math.min(15, cellSize)) + 'px sans-serif';
        ctx.fillText(country.name, left + ((minX + maxX + 1) / 2) * cellSize,
          top + ((minY + maxY + 1) / 2) * cellSize);
      }
    }
    for (const reservation of (state.mapView.reservations || [])) {
      ctx.save();
      ctx.setLineDash([5, 3]);
      ctx.strokeStyle = reservation.isMine ? '#13833c' : '#b07a16';
      ctx.lineWidth = miniature ? 1 : 2.4;
      ctx.strokeRect(left + (reservation.centerX - 2) * cellSize + 1, top + (reservation.centerY - 2) * cellSize + 1, cellSize * 5 - 2, cellSize * 5 - 2);
      ctx.restore();
    }
    if (!miniature && state.mapSelectedCenter) {
      const x = left + (state.mapSelectedCenter.x - 2) * cellSize;
      const y = top + (state.mapSelectedCenter.y - 2) * cellSize;
      ctx.strokeStyle = '#cf941e';
      ctx.lineWidth = 3;
      ctx.strokeRect(x + 1, y + 1, cellSize * 5 - 2, cellSize * 5 - 2);
    }
  }

  function buildWorldPreview() {
    drawMapCanvas($('#world-grid'), true);
  }

  function openMap() {
    if (!state.campaign) return;
    const existingReservation = (state.mapView?.reservations || []).find((item) => item.isMine);
    state.mapSelectedCenter = existingReservation
      ? { x: existingReservation.centerX, y: existingReservation.centerY }
      : null;
    state.mapTransform = null;
    $('#confirm-spawn').disabled = !state.mapSelectedCenter;
    $('#map-selection-label').textContent = state.campaign.countryId
      ? 'Государство уже основано. Перетаскивай карту и смотри территории игроков.'
      : existingReservation
        ? 'Твоя точка старта зарезервирована: ' + existingReservation.centerX + ', ' + existingReservation.centerY + '. Можно выбрать другое место.'
        : 'Зажми ЛКМ для перемещения. Выбери сушу — будет показана территория 5×5.';
    $('#confirm-spawn').classList.toggle('hidden', Boolean(state.campaign.countryId));
    $('#map-modal').classList.remove('hidden');
    loadCampaignMap().then(() => {
      const reservation = (state.mapView?.reservations || []).find((item) => item.isMine);
      if (reservation && !state.mapSelectedCenter) {
        state.mapSelectedCenter = { x: reservation.centerX, y: reservation.centerY };
        $('#confirm-spawn').disabled = false;
      }
      requestAnimationFrame(() => drawMapCanvas($('#map-canvas'), false));
    }).catch((error) => showToast(error.message, true));
    requestAnimationFrame(() => drawMapCanvas($('#map-canvas'), false));
  }

  function mapCellAt(clientX, clientY) {
    if (!state.mapLayout) return null;
    const rect = $('#map-canvas').getBoundingClientRect();
    const x = Math.floor((clientX - rect.left - state.mapLayout.left) / state.mapLayout.cellSize);
    const y = Math.floor((clientY - rect.top - state.mapLayout.top) / state.mapLayout.cellSize);
    if (x < 0 || y < 0 || x >= state.mapView.width || y >= state.mapView.height) return null;
    return { x, y };
  }

  function chooseSpawnCenter(x, y) {
    if (x < 2 || y < 2 || x + 2 >= state.mapView.width || y + 2 >= state.mapView.height) {
      showToast('Оставь отступ не менее двух клеток от края карты.', true);
      return;
    }
    let landCells = 0;
    for (let yy = y - 2; yy <= y + 2; yy += 1) {
      for (let xx = x - 2; xx <= x + 2; xx += 1) {
        if (mapIsLand(xx, yy)) landCells += 1;
      }
    }
    if (landCells < 7) {
      showToast('В территории 5×5 должно быть не менее семи клеток суши.', true);
      return;
    }
    const occupied = new Set();
    for (const country of (state.mapView.countries || [])) for (const cell of country.cells) occupied.add(cell.x + ',' + cell.y);
    for (let yy = y - 2; yy <= y + 2; yy += 1) for (let xx = x - 2; xx <= x + 2; xx += 1) {
      if (occupied.has(xx + ',' + yy)) { showToast('Эта территория пересекается с государством другого игрока.', true); return; }
    }
    for (const reservation of (state.mapView.reservations || [])) {
      if (!reservation.isMine && Math.abs(reservation.centerX - x) <= 4 && Math.abs(reservation.centerY - y) <= 4) {
        showToast('Эта область пересекается с точкой спавна другого игрока.', true);
        return;
      }
    }
    state.mapSelectedCenter = { x, y };
    $('#confirm-spawn').disabled = false;
    $('#map-selection-label').textContent = 'Предпросмотр границ: центр ' + x + ', ' + y + ' · территория 5×5 · 25 клеток.';
    drawMapCanvas($('#map-canvas'), false);
  }

  async function confirmSpawn() {
    if (!state.mapSelectedCenter || !state.campaign) return;
    const center = state.mapSelectedCenter;
    try {
      await request('/campaigns/' + state.campaign.id + '/spawn-reservation', {
        method: 'PUT', body: JSON.stringify({ centerX: center.x, centerY: center.y }),
      });
      await loadCampaignMap();
      $('#map-selection-label').textContent = 'Точка зарезервирована. Теперь выбери или создай религию / идеологию.';
      showToast('Точка старта зарезервирована.');
      $('#map-modal').classList.add('hidden');
      activateTab('systems');
      await refreshAvailableSystems();
    } catch (error) {
      showToast(error.message, true);
    }
  }

  function renderPrincipleCatalog() {
    const catalog = principleCatalog[$('#system-type').value];
    $('#principles-list').innerHTML = ['positive','neutral','negative'].map((polarity) => {
      const title = polarity === 'positive' ? 'ПОЗИТИВНЫЕ' : polarity === 'neutral' ? 'НЕЙТРАЛЬНЫЕ' : 'НЕГАТИВНЫЕ';
      const items = catalog[polarity].map((item) => {
        const tip = escapeHtml(item[1] + '\nИгровой эффект: ' + item[2]);
        return '<label class="principle-option" title="' + tip + '"><input class="principle-check" type="checkbox" data-polarity="' + polarity + '" data-name="' + escapeHtml(item[0]) + '" data-description="' + escapeHtml(item[1]) + '" data-effect="' + escapeHtml(item[2]) + '"><span><strong>' + escapeHtml(item[0]) + '</strong><small>' + escapeHtml(item[2]) + '</small></span></label>';
      }).join('');
      return '<section class="principle-column ' + polarity + '"><h3>' + title + '</h3>' + items + '</section>';
    }).join('');
    $$('.principle-check').forEach((input) => input.addEventListener('change', updatePrincipleBalance));
    updatePrincipleBalance();
  }

  function updatePrincipleBalance() {
    const checked = $$('.principle-check:checked');
    const count = (polarity) => checked.filter((input) => input.dataset.polarity === polarity).length;
    const positive = count('positive');
    const neutral = count('neutral');
    const negative = count('negative');
    const total = checked.length;
    const valid = total > 0 && total <= 10 && positive <= 2 + negative;
    $$('.principle-check:not(:checked)').forEach((input) => { input.disabled = total >= 10; });
    $('#principle-balance').textContent = 'Позитивные: ' + positive + ' · Нейтральные: ' + neutral + ' · Негативные: ' + negative + ' · Всего: ' + total + '/10' + (valid ? ' · Баланс соблюдён' : ' · Нужен баланс (каждый позитивный после второго покрывается негативным)');
    $('#principle-balance').classList.toggle('invalid', !valid);
    return valid;
  }

  async function readOptionalImage(selector) {
    const file = $(selector)?.files?.[0];
    if (!file) return null;
    if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 512 * 1024) {
      throw new Error('Изображение должно быть PNG, JPEG или WebP и не больше 512 КБ.');
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('Не удалось прочитать файл изображения.'));
      reader.readAsDataURL(file);
    });
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
    const reservation = (state.mapView?.reservations || []).find((item) => item.isMine);
    if (!reservation) return;
    const x = reservation.centerX;
    const y = reservation.centerY;
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
            const reservation = (state.mapView?.reservations || []).find((item) => item.isMine);
            if (!reservation) {
              showToast('Сначала зарезервируй территорию на карте.', true);
              openMap();
              return;
            }
            const globalX = reservation.centerX - 2 + x;
            const globalY = reservation.centerY - 2 + y;
            if (!mapIsLand(globalX, globalY)) {
              showToast('Стартовые здания можно размещать только на суше.', true);
              return;
            }
            if (Object.keys(state.placements).length >= 7) {
              showToast('На территории доступно ровно семь стартовых построек.', true);
              return;
            }
            const usedOfType = Object.values(state.placements).filter((type) => type === state.selectedBuilding).length;
            const specialTypes = activeExtraTypes();
            const usedSpecial = Object.values(state.placements).filter((type) => specialTypes.includes(type)).length;
            if (usedOfType >= buildingMeta[state.selectedBuilding].required || (specialTypes.includes(state.selectedBuilding) && usedSpecial >= 1)) {
              showToast('Больше построек этого типа в стартовом наборе не предусмотрено.', true);
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
      const localX = Number(button.dataset.x);
      const localY = Number(button.dataset.y);
      const type = state.placements[key];
      const reservation = (state.mapView?.reservations || []).find((item) => item.isMine);
      const isWater = Boolean(reservation && !mapIsLand(reservation.centerX - 2 + localX, reservation.centerY - 2 + localY));
      button.classList.toggle('occupied', Boolean(type));
      button.classList.toggle('water-cell', isWater);
      button.disabled = isWater && !type;
      button.innerHTML = type ? `${buildingMeta[type].icon}<small>${buildingMeta[type].label.slice(0, 3)}</small>` : (isWater ? '≈' : key === '2,2' ? '·' : '');
      button.title = type ? buildingMeta[type].label : isWater ? 'Вода — здесь нельзя размещать здания' : 'Суша — свободная клетка';
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
    const reservation = (state.mapView?.reservations || []).find((item) => item.isMine);
    if (!reservation) {
      setMessage('#country-message', 'Сначала зарезервируй место на карте.');
      openMap();
      return;
    }
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
    if (!$('#official-system').value) {
      setMessage('#country-message', 'Сначала выбери доступную религию или идеологию.');
      return;
    }
    const submitButton = $('#country-form button[type="submit"]');
    submitButton.disabled = true;
    try {
      const payload = {
        name: $('#country-name').value.trim(),
        culture: $$('#culture-list input:checked').map((input) => input.value),
        government: $('#government').value,
        flagDataUrl: await readOptionalImage('#country-flag'),
        spawnX: reservation.centerX,
        spawnY: reservation.centerY,
        officialSystemId: $('#official-system').value,
        buildings: Object.entries(state.placements).map(([key, type]) => {
          const [x, y] = key.split(',').map(Number);
          return { type, x, y };
        }),
      };
      const data = await request('/campaigns/' + state.campaign.id + '/countries', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      showToast('Государство «' + data.country.name + '» основано!');
      setMessage('#country-message', 'Государство создано. Территория 5×5, жителей: ' + data.country.residentCount + '.', true);
      state.campaign.countryId = data.country.id;
      $('#country-status').textContent = 'Основано';
      await loadCampaignMap();
      await loadCampaigns();
      buildWorldPreview();
    } catch (error) {
      setMessage('#country-message', error.message || 'Не удалось создать государство.');
      showToast(error.message || 'Не удалось создать государство.', true);
    } finally {
      submitButton.disabled = false;
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

    $('#leave-campaign').addEventListener('click', () => {
      if (state.campaign) leaveCampaign(state.campaign.id);
    });

    $('#join-campaign-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const campaignId = $('#join-campaign-id').value.trim();
      try {
        await request('/campaigns/' + encodeURIComponent(campaignId) + '/join', { method: 'POST' });
        $('#join-campaign-id').value = '';
        setMessage('#join-campaign-message', 'Ты присоединился к кампании. Она появится в списке миров.', true);
        await loadCampaigns();
        showToast('Подключение к кампании выполнено.');
      } catch (error) {
        setMessage('#join-campaign-message', error.message);
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
            turnDurationHours: Number($('#turn-duration-hours').value),
            mapSeed: $('#map-seed').value.trim(),
          }),
        });
        $('#campaign-form').reset();
        $('#map-width').value = '80';
        $('#map-height').value = '60';
        $('#map-seed').value = '';
        $('#turn-duration-hours').value = '24';
        await loadCampaigns();
        showToast('Кампания «' + data.campaign.name + '» создана · seed ' + data.campaign.mapSeed + ' · слотов ' + data.campaign.maxPlayers + '.');
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

    $('#system-type').addEventListener('change', renderPrincipleCatalog);
    $('#system-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!updatePrincipleBalance()) {
        setMessage('#system-message', 'Выбери от 1 до 10 пунктов и соблюдай баланс позитивных и негативных.');
        return;
      }
      const principles = $$('.principle-check:checked').map((input) => ({
        name: input.dataset.name,
        description: input.dataset.description,
        effect: input.dataset.effect,
        polarity: input.dataset.polarity,
      }));
      try {
        await request('/campaigns/' + state.campaign.id + '/social-systems', {
          method: 'POST',
          body: JSON.stringify({
            type: $('#system-type').value,
            name: $('#system-name').value.trim(),
            principles,
            emblemDataUrl: await readOptionalImage('#system-emblem'),
          }),
        });
        $('#system-name').value = '';
        $('#system-emblem').value = '';
        $$('.principle-check').forEach((input) => { input.checked = false; });
        updatePrincipleBalance();
        setMessage('#system-message', 'Учение создано и сразу доступно для выбора.', true);
        await loadSystems();
        $('#official-system-type').value = $('#system-type').value;
        updateBuildingChoices();
        await refreshAvailableSystems();
        showToast('Учение создано. Согласование не требуется.');
      } catch (error) {
        setMessage('#system-message', error.message);
      }
    });

    $('#refresh-systems').addEventListener('click', loadSystems);
    $('#open-map').addEventListener('click', openMap);
    $('#close-map').addEventListener('click', () => $('#map-modal').classList.add('hidden'));
    $('#confirm-spawn').addEventListener('click', confirmSpawn);
    window.addEventListener('resize', () => {
      drawMapCanvas($('#world-grid'), true);
      if (!$('#map-modal').classList.contains('hidden')) drawMapCanvas($('#map-canvas'), false);
    });
    $('#map-canvas').addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || !state.mapTransform) return;
      state.mapDrag = { x: event.clientX, y: event.clientY, originX: state.mapTransform.x, originY: state.mapTransform.y, moved: false };
      $('#map-canvas').setPointerCapture(event.pointerId);
    });
    $('#map-canvas').addEventListener('pointermove', (event) => {
      if (!state.mapDrag) return;
      const dx = event.clientX - state.mapDrag.x;
      const dy = event.clientY - state.mapDrag.y;
      if (Math.abs(dx) + Math.abs(dy) > 4) state.mapDrag.moved = true;
      if (state.mapDrag.moved) {
        state.mapTransform.x = state.mapDrag.originX + dx;
        state.mapTransform.y = state.mapDrag.originY + dy;
        drawMapCanvas($('#map-canvas'), false);
      }
    });
    $('#map-canvas').addEventListener('pointerup', (event) => {
      const drag = state.mapDrag;
      state.mapDrag = null;
      if (!drag || drag.moved || state.campaign?.countryId) return;
      const cell = mapCellAt(event.clientX, event.clientY);
      if (cell) chooseSpawnCenter(cell.x, cell.y);
    });
    $('#map-canvas').addEventListener('wheel', (event) => {
      event.preventDefault();
      if (!state.mapTransform) return;
      state.mapTransform.zoom = Math.max(0.35, Math.min(5, state.mapTransform.zoom * (event.deltaY < 0 ? 1.12 : 0.89)));
      drawMapCanvas($('#map-canvas'), false);
    }, { passive: false });
    const cultureOpposites = [
      ['militaristic','pacifist'], ['xenophobic','xenophilic'],
      ['hierarchical','egalitarian'], ['spiritual','rationalist'],
      ['collectivist','individualistic'], ['expansionist','isolationist'],
    ];
    const syncCultureOptions = () => {
      const chosen = new Set(Array.from(document.querySelectorAll('#culture-list input:checked'), (input) => input.value));
      Array.from(document.querySelectorAll('#culture-list input')).forEach((input) => {
        const opposite = cultureOpposites.find((pair) => pair.includes(input.value))?.find((value) => value !== input.value);
        input.disabled = (!input.checked && chosen.size >= 5) || Boolean(opposite && chosen.has(opposite));
      });
    };
    $('#culture-list').addEventListener('change', (event) => {
      const selected = Array.from(document.querySelectorAll('#culture-list input:checked'));
      if (selected.length > 5 && event.target.checked) {
        event.target.checked = false;
        showToast('Можно выбрать не более пяти культурных характеристик.', true);
      }
      syncCultureOptions();
    });
    syncCultureOptions();
    $('#official-system-type').addEventListener('change', () => {
      updateBuildingChoices();
      refreshAvailableSystems().catch((error) => setMessage('#country-message', error.message));
      renderTerritoryGrid();
    });
    $('#building-type').addEventListener('change', (event) => { state.selectedBuilding = event.target.value; });
    $('#country-form').addEventListener('submit', submitCountry);
    $('#refresh-pending').addEventListener('click', loadPending);
  }

  async function init() {
    bindEvents();
    buildWorldPreview();
    renderPrincipleCatalog();
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
