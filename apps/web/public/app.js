(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const state = {
    token: sessionStorage.getItem('pw_access_token') || '',
    user: null,
    profile: null,
    activeScreen: 'auth',
    profileReturnScreen: 'game',
    campaigns: [],
    openCampaigns: [],
    campaign: null,
    refreshPromise: null,
    systems: [],
    librarySystems: [],
    availableSystems: [],
    pending: [],
    countryProfile: null,
    mapOrders: [],
    mapContextMenuCell: null,
    turnStatus: null,
    orderResults: [],
    turnRoomLoading: false,
    turnRoomError: '',
    orderResultsError: '',
    loadedSystemEmblemDataUrl: null,
    buildingIconCache: {},
    principles: [],
    placements: {},
    selectedBuilding: 'factory',
    authMode: 'login',
    toastTimer: null,
    chatModalOpen: false,
    chatScope: 'world',
    chatCampaignId: null,
    chatCampaigns: [],
    chatRequestId: 0,
    chatPollingTimer: null,
    chatNotificationPollingTimer: null,
    chatNotificationPollingBusy: false,
    chatNotificationsPrimed: false,
    chatPreferencesUserId: null,
    chatSeenMessageIds: {},
    chatAlerts: new Set(),
    chatMutedRooms: new Set(),
    chatSending: false,
    adminModeEnabled: false,
    adminUsers: [],
    adminCampaigns: [],
    adminMapPreviousCampaign: null,
    adminMapOpened: false,
    adminCampaignDiscoveries: [],
    adminSelectedCountry: null,
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
    factory:{label:'Фабрика',code:'Ф',required:2,asset:'/assets/buildings/factory.jpg',color:'#5b6570'},
    factory_level_2:{label:'Завод II уровня',code:'Ф²',required:2,asset:'/assets/buildings/factory.jpg',color:'#5b6570'},
    field:{label:'Поле',code:'П',required:2,asset:'/assets/buildings/field.jpg',color:'#6c9344'},
    gold_mine:{label:'Золотая шахта',code:'З',required:1,asset:'/assets/buildings/gold-mark.jpg',color:'#c99722'},
    capital:{label:'Столица',code:'★',required:1,asset:'/assets/buildings/capital.jpg',color:'#6b477d'},
    religious_building:{label:'Церковь',code:'☼',required:1,color:'#9271a8',iconSvg:'<path d="M50 12 78 34v52H22V34Z"/><path d="M50 12v-8M41 4h18M40 86V57h20v29M34 42h32M50 26v10"/> <path d="M16 86h68"/>'},
    science:{label:'Лаборатория',code:'Л',required:1,asset:'/assets/buildings/science.jpg',color:'#4c8298'},
    barracks:{label:'Казармы',code:'К',required:1,asset:'/assets/buildings/barracks.jpg',color:'#9b634d'},
    tower:{label:'Замок / башня',code:'Т',required:1,asset:'/assets/buildings/tower.jpg',color:'#52677f'},
    rice_field:{label:'Рисовое поле',code:'Р',required:1,color:'#4d9b9a',iconSvg:'<path d="M14 78h72M18 64h64M22 50h56"/><path d="M28 66V32m0 13-10-8m10 0 10-8M50 52V18m0 14-10-8m10 3 10-9M72 66V36m0 12-9-8m9 2 9-9"/><path d="M8 84q12-7 24 0t24 0 24 0"/>'},
    field_level_2:{label:'Поле II уровня',code:'П²',required:2,asset:'/assets/buildings/field.jpg',color:'#6c9344'},
    cotton_field:{label:'Хлопковое поле',code:'Х',required:1,color:'#8f9f55',iconSvg:'<path d="M50 88V48m0 22L30 54m20 9 20-18"/><path d="M30 54c-10-10 2-22 12-15 2-13 20-14 23-1 12 0 16 16 5 22-5 3-12 1-15-4-4 6-17 5-25-2Z"/><circle cx="38" cy="46" r="5"/><circle cx="60" cy="45" r="6"/>'},
    textile_workshop:{label:'Ткацкая мастерская',code:'ТМ',required:1,color:'#9a7853',iconSvg:'<path d="M18 18h64v64H18Z"/><path d="M26 28h48M26 72h48M32 28v44m12-44v44m12-44v44m12-44v44"/><path d="M12 40h76M12 60h76"/>'},
    textile_workshop_level_2:{label:'Ткацкая мастерская II уровня',code:'ТМ²',required:3,color:'#9a7853',iconSvg:'<path d="M18 18h64v64H18Z"/><path d="M26 28h48M26 72h48M32 28v44m12-44v44m12-44v44m12-44v44"/><path d="M12 40h76M12 60h76"/><path d="m68 10 5 5 9-9"/>'},
    hunter:{label:'Охотники',code:'О',required:1,color:'#8a694a',iconSvg:'<path d="M18 24q32 54 64 0M18 24l64 52M82 24 18 76"/><path d="m44 49 12-12m-4 12 10-10"/>'},
    fisher:{label:'Рыбаки',code:'Р',required:1,color:'#3d8da7',iconSvg:'<path d="M12 52q24-27 52 0-28 27-52 0Z"/><path d="m64 52 22-17v34Z"/><circle cx="30" cy="48" r="3" fill="#111"/><path d="M50 24q20-6 28-18M72 6l8 1-2 8"/>'},
    greenhouse:{label:'Теплица',code:'Т',required:1,color:'#4b9d55',iconSvg:'<path d="M14 82V42Q50 2 86 42v40Z"/><path d="M50 18v64M28 31v51M72 31v51M18 58h64"/><path d="M40 82V66q10-17 20 0v16"/>'},
    dam:{label:'Дамба',code:'Д',required:1,color:'#287db5',iconSvg:'<path d="M14 24h72v52H14Z"/><path d="m14 24 22 52m0-52 22 52m0-52 22 52"/><path d="M10 84q10-8 20 0t20 0 20 0 20 0"/>'},
  };
  function buildingIconHtml(type,extraClass='') {
    const meta=buildingMeta[type];if(!meta)return '';
    if(meta.asset)return '<img class="building-icon-img '+extraClass+'" data-building-type="'+type+'" src="'+meta.asset+'" alt="'+escapeHtml(meta.label)+'" draggable="false">';
    if(meta.iconSvg)return '<svg class="building-icon-svg '+extraClass+'" viewBox="0 0 100 100" role="img" aria-label="'+escapeHtml(meta.label)+'" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">'+meta.iconSvg+'</svg>';
    return '';
  }
  function drawBuildingMapIcon(ctx, type, x, y, size) {
    const meta = buildingMeta[type];
    if (!meta || size < 1.5) return;

    const insetRatio = type === 'factory' || type === 'tower' ? 0.19 : 0.11;
    const inset = Math.max(0.35, size * insetRatio);
    const inner = Math.max(1, size - inset * 2);
    const left = x + (size - inner) / 2;
    const top = y + (size - inner) / 2;

    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 0.25, y + 0.25, Math.max(0.5, size - 0.5), Math.max(0.5, size - 0.5));
    ctx.clip();

    if (size < 5.5) {
      ctx.fillStyle = meta.color || '#52616b';
      ctx.beginPath();
      ctx.arc(x + size / 2, y + size / 2, Math.max(0.8, size * 0.32), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    let cached = state.buildingIconCache[type];
    if (!cached) {
      const img = new Image();
      cached = { img, ready: false, failed: false };
      img.onload = () => {
        cached.ready = true;
        const canvas = $('#map-canvas');
        if (canvas && !$('#map-modal').classList.contains('hidden')) drawMapCanvas(canvas, false);
      };
      img.onerror = () => {
        cached.failed = true;
        const canvas = $('#map-canvas');
        if (canvas && !$('#map-modal').classList.contains('hidden')) drawMapCanvas(canvas, false);
      };
      const svgSource = meta.iconSvg
        ? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" fill="none" stroke="#17201b" stroke-width="6" stroke-linecap="round" stroke-linejoin="round">' + meta.iconSvg + '</svg>'
        : '';
      img.src = meta.asset || ('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgSource));
      state.buildingIconCache[type] = cached;
    }

    ctx.fillStyle = '#fff';
    ctx.fillRect(left, top, inner, inner);
    if (cached.ready && cached.img.naturalWidth > 0) {
      const ratio = Math.min(inner / cached.img.naturalWidth, inner / cached.img.naturalHeight);
      const width = cached.img.naturalWidth * ratio;
      const height = cached.img.naturalHeight * ratio;
      ctx.globalCompositeOperation = 'multiply';
      ctx.drawImage(cached.img, x + (size - width) / 2, y + (size - height) / 2, width, height);
    } else {
      ctx.fillStyle = '#111';
      ctx.font = '900 ' + Math.max(5, inner * 0.62) + 'px Arial,sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(marker, x + size / 2, y + size / 2 + 0.3);
    }
    ctx.restore();
  }
  async function refreshAccessToken() {
    if (!state.refreshPromise) {
      state.refreshPromise = (async () => {
        const response = await fetch('/auth/refresh', {
          method: 'POST',
          credentials: 'same-origin',
        });
        const data = await response.json().catch(() => null);
        if (!response.ok || !data || typeof data.accessToken !== 'string') {
          const error = new Error(data?.message || 'Сессия завершена. Войди снова.');
          error.status = response.status;
          throw error;
        }
        state.token = data.accessToken;
        sessionStorage.setItem('pw_access_token', state.token);
        return state.token;
      })().finally(() => { state.refreshPromise = null; });
    }
    return state.refreshPromise;
  }

  function userErrorMessage(error) {
    const message = typeof error?.message === 'string' ? error.message.trim() : '';
    return /[А-Яа-яЁё]/.test(message) ? message : 'Произошла ошибка. Попробуйте ещё раз.';
  }

  function russianApiError(data, status) {
    const code = typeof data?.error === 'string' ? data.error : '';
    const messages = {
      INVALID_REQUEST: 'Проверьте введённые данные и попробуйте ещё раз.',
      INVALID_ORDER: 'Приказ заполнен неверно. Проверьте его параметры.',
      INVALID_COUNTRY_SETUP: 'Не удалось создать государство. Проверьте выбранные параметры.',
      UNAUTHENTICATED: 'Сессия завершена или данные для входа неверны. Войдите снова.',
      EMAIL_ALREADY_REGISTERED: 'Аккаунт с этой почтой уже существует.',
      NICKNAME_ALREADY_TAKEN: 'Этот никнейм уже занят.',
      VK_IDENTITY_CONFLICT: 'Этот аккаунт VK ID уже привязан к другому профилю.',
      CAMPAIGN_NOT_FOUND: 'Кампания не найдена.',
      CAMPAIGN_NOT_ACTIVE: 'Эта кампания сейчас неактивна.',
      ORDER_NOT_FOUND: 'Приказ не найден.',
      ORDER_NOT_EDITABLE: 'Этот приказ уже нельзя изменить.',
      NOT_ACTIVE_MEMBER: 'У вас больше нет доступа к этой кампании.',
      NOT_ACTIVE_CAMPAIGN_MEMBER: 'У вас больше нет доступа к этой кампании.',
      COUNTRY_NOT_REGISTERED: 'Сначала зарегистрируйте государство.',
      ACTION_POINTS_EXHAUSTED: 'На этот ход уже использованы все 3 очка действий.',
      ORDERS_ALREADY_LOCKED: 'Приказы уже закрыты. Изменить их нельзя.',
      ORDERS_DEADLINE_PASSED: 'Время приёма приказов закончилось.',
      ORDERS_NOT_READY: 'Ход ещё нельзя завершить: ожидается подтверждение участников.',
      SNAPSHOT_NOT_FOUND: 'Не удалось найти сохранённое состояние мира.',
      NO_ACTIVE_MEMBERS: 'В кампании нет активных участников.',
      TURN_JOB_ALREADY_EXISTS: 'Этот ход уже отправлен на обработку.',
      COUNTRY_SETUP_CONFLICT: 'Это действие конфликтует с текущим состоянием государства или кампании.',
      OFFICIAL_SYSTEM_NOT_AVAILABLE: 'Выбранное учение больше недоступно.',
      SYSTEM_AVAILABILITY_NOT_CONFIGURED: 'Выбор учений временно недоступен.',
      SOCIAL_SYSTEM_NOT_FOUND: 'Учение не найдено.',
      SOCIAL_SYSTEM_ADMIN_REQUIRED: 'Для этого действия нужны права администратора.',
      EMAIL_NOT_VERIFIED: 'Сначала подтвердите адрес электронной почты.',
      VK_ID_NOT_CONFIGURED: 'Вход через VK ID пока не настроен.',
      INTERNAL_SERVER_ERROR: 'На сервере произошла ошибка. Попробуйте ещё раз позже.',
    };
    const serverMessage = typeof data?.message === 'string' ? data.message.trim() : '';
    if (/[А-Яа-яЁё]/.test(serverMessage)) return serverMessage;
    if (messages[code]) return messages[code];
    if (status >= 500) return 'На сервере произошла ошибка. Попробуйте ещё раз позже.';
    if (status === 404) return 'Запрошенные данные не найдены.';
    if (status === 401) return 'Сессия завершена. Войдите снова.';
    if (status === 403) return 'У вас недостаточно прав для этого действия.';
    return 'Не удалось выполнить запрос. Проверьте данные и попробуйте ещё раз.';
  }

  async function request(url, options = {}, retried = false) {
    const headers = new Headers(options.headers || {});
    if (state.token) headers.set('Authorization', `Bearer ${state.token}`);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    let response;
    try {
      response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
    } catch (cause) {
      const error = new Error('Не удалось связаться с сервером. Проверьте подключение и попробуйте ещё раз.');
      error.cause = cause;
      throw error;
    }
    if (response.status === 401 && state.token && !retried &&
        !['/auth/login', '/auth/register', '/auth/refresh', '/auth/resend-verification'].includes(url)) {
      try {
        await refreshAccessToken();
        return request(url, options, true);
      } catch {
        state.token = '';
        sessionStorage.removeItem('pw_access_token');
      }
    }
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
    if (!response.ok) {
      const error = new Error(russianApiError(data, response.status));
      error.status = response.status;
      error.code = data?.error;
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

  function setChatStatus(message, isError = false) {
    const status = $('#chat-status');
    if (!status) return;
    status.textContent = message || '';
    status.classList.toggle('error', isError);
  }

  function formatChatTimestamp(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString('ru-RU', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function renderChatMessages(items) {
    const host = $('#chat-messages');
    if (!host) return;
    host.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'chat-empty-state';
      empty.textContent = 'В этой комнате пока нет сообщений. Начни разговор.';
      host.append(empty);
      return;
    }

    for (const item of items) {
      const article = document.createElement('article');
      article.className = 'chat-message' + (item.isMine ? ' mine' : '');
      const meta = document.createElement('div');
      meta.className = 'chat-message-meta';
      const author = document.createElement('strong');
      author.textContent = item.authorLabel || 'Игрок';
      const time = document.createElement('time');
      const messageDate = new Date(item.createdAt);
      time.dateTime = Number.isNaN(messageDate.getTime()) ? '' : messageDate.toISOString();
      time.textContent = formatChatTimestamp(item.createdAt);
      meta.append(author, time);
      const content = document.createElement('div');
      content.className = 'chat-message-content';
      content.textContent = item.message;
      article.append(meta, content);
      host.append(article);
    }
    host.scrollTop = host.scrollHeight;
  }

  function updateChatRoomHeader() {
    const title = $('#chat-room-title');
    const hint = $('#chat-room-hint');
    if (!title || !hint) return;
    if (state.chatScope === 'world') {
      title.textContent = 'Мировой чат';
      hint.textContent = 'Общение всех игроков Paper Wars';
      return;
    }
    const campaign = state.chatCampaigns.find((item) => item.id === state.chatCampaignId);
    title.textContent = campaign?.name || 'Чат кампании';
    hint.textContent = campaign
      ? 'Кампания · ход ' + String(campaign.currentTurn).padStart(2, '0')
      : 'Закрытый канал участников кампании';
  }

  function chatRoomKey(scope, campaignId = null) {
    return scope === 'world' ? 'world' : 'campaign:' + String(campaignId || '');
  }

  function loadChatPreferences() {
    if (!state.user?.id || state.chatPreferencesUserId === state.user.id) return;
    state.chatPreferencesUserId = state.user.id;
    try {
      const stored = JSON.parse(localStorage.getItem('pw_chat_mutes:' + state.user.id) || '[]');
      state.chatMutedRooms = new Set(Array.isArray(stored) ? stored.filter((item) => typeof item === 'string') : []);
    } catch {
      state.chatMutedRooms = new Set();
    }
    state.chatSeenMessageIds = {};
    state.chatNotificationsPrimed = false;
    state.chatAlerts.clear();
    updateChatAlertButton();
  }

  function saveChatPreferences() {
    if (!state.user?.id) return;
    localStorage.setItem('pw_chat_mutes:' + state.user.id, JSON.stringify([...state.chatMutedRooms]));
  }

  function updateChatAlertButton() {
    const button = $('#chat-open-button');
    if (!button) return;
    const active = state.chatAlerts.size > 0;
    button.classList.toggle('chat-new-message-alert', active);
    button.setAttribute('aria-label', active ? 'Чаты: есть новые сообщения' : 'Чаты');
  }

  function clearChatAlert(roomKey) {
    state.chatAlerts.delete(roomKey);
    updateChatAlertButton();
  }

  function markChatRoomSeen(roomKey, messages) {
    state.chatSeenMessageIds[roomKey] = (messages || []).map((message) => message.id).filter(Boolean);
    clearChatAlert(roomKey);
  }

  function toggleChatRoomMute(roomKey) {
    if (state.chatMutedRooms.has(roomKey)) {
      state.chatMutedRooms.delete(roomKey);
    } else {
      state.chatMutedRooms.add(roomKey);
      clearChatAlert(roomKey);
    }
    saveChatPreferences();
    renderChatRooms();
  }

  function appendChatRoom(host, options) {
    const { scope, campaignId = null, title, subtitle, icon, active, onSelect } = options;
    const roomKey = chatRoomKey(scope, campaignId);
    const entry = document.createElement('div');
    entry.className = 'chat-room-entry';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'chat-room-button';
    button.classList.toggle('active', Boolean(active));
    button.classList.toggle('has-alert', state.chatAlerts.has(roomKey));
    button.setAttribute('data-chat-room-scope', scope);
    if (campaignId) button.dataset.chatCampaignId = campaignId;
    if (active) button.setAttribute('aria-current', 'true');
    const iconNode = document.createElement('span');
    iconNode.className = 'chat-room-icon';
    iconNode.textContent = icon;
    const label = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = title;
    const hint = document.createElement('small');
    hint.textContent = subtitle;
    label.append(name, hint);
    button.append(iconNode, label);
    button.addEventListener('click', () => {
      if (active) {
        clearChatAlert(roomKey);
        return;
      }
      clearChatAlert(roomKey);
      onSelect();
    });

    const muted = state.chatMutedRooms.has(roomKey);
    const mute = document.createElement('button');
    mute.type = 'button';
    mute.className = 'chat-room-mute';
    mute.textContent = muted ? '🔕' : '🔔';
    mute.title = muted ? 'Включить уведомления для этого чата' : 'Отключить уведомления для этого чата';
    mute.setAttribute('aria-label', mute.title);
    mute.setAttribute('aria-pressed', muted ? 'true' : 'false');
    mute.addEventListener('click', () => toggleChatRoomMute(roomKey));
    entry.append(button, mute);
    host.append(entry);
  }

  function renderChatRooms() {
    const host = $('#chat-room-list');
    if (!host) return;
    host.replaceChildren();

    const generalLabel = document.createElement('div');
    generalLabel.className = 'chat-room-section-label';
    generalLabel.textContent = 'ОБЩИЙ КАНАЛ';
    host.append(generalLabel);

    appendChatRoom(host, {
      scope: 'world',
      title: 'Мировой чат',
      subtitle: 'Все игроки Paper Wars',
      icon: '◎',
      active: state.chatScope === 'world',
      onSelect: () => {
        state.chatScope = 'world';
        state.chatCampaignId = null;
        renderChatRooms();
        updateChatRoomHeader();
        void loadChatMessages();
      },
    });

    const campaignLabel = document.createElement('div');
    campaignLabel.className = 'chat-room-section-label';
    campaignLabel.textContent = 'ТВОИ КАМПАНИИ';
    host.append(campaignLabel);

    if (state.chatCampaigns.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'chat-room-empty';
      empty.textContent = 'Ты пока не состоишь ни в одной кампании.';
      host.append(empty);
    }

    for (const campaign of state.chatCampaigns) {
      appendChatRoom(host, {
        scope: 'campaign',
        campaignId: campaign.id,
        title: campaign.name,
        subtitle: 'Ход ' + String(campaign.currentTurn).padStart(2, '0'),
        icon: '⌂',
        active: state.chatScope === 'campaign' && state.chatCampaignId === campaign.id,
        onSelect: () => {
          state.chatScope = 'campaign';
          state.chatCampaignId = campaign.id;
          renderChatRooms();
          updateChatRoomHeader();
          void loadChatMessages();
        },
      });
    }
  }

  async function loadChatMessages() {
    if (!state.chatModalOpen || !state.token) return;
    const scope = state.chatScope;
    const campaignId = state.chatCampaignId;
    if (scope === 'campaign' && !campaignId) return;
    const requestId = ++state.chatRequestId;
    const path = scope === 'world'
      ? '/chat/world'
      : '/campaigns/' + encodeURIComponent(campaignId) + '/chat';
    try {
      const data = await request(path);
      if (
        !state.chatModalOpen ||
        requestId !== state.chatRequestId ||
        scope !== state.chatScope ||
        campaignId !== state.chatCampaignId
      ) return;
      const messages = Array.isArray(data.messages) ? data.messages : [];
      renderChatMessages(messages);
      markChatRoomSeen(chatRoomKey(scope, campaignId), messages);
      setChatStatus('');
    } catch (error) {
      if (!state.chatModalOpen || requestId !== state.chatRequestId) return;
      if (error.status === 401) {
        closeChatModal();
        state.user = null;
        showScreen('auth');
        setMessage('#auth-message', 'Сессия завершена. Войди снова.');
        void initVkOneTap();
        return;
      }
      if (error.status === 403) {
        setChatStatus('Нет доступа к этой кампании. Обнови список комнат.', true);
      } else {
        setChatStatus(userErrorMessage(error) || 'Не удалось загрузить сообщения.', true);
      }
    }
  }

  async function refreshChatCampaigns() {
    const data = await request('/campaigns');
    state.chatCampaigns = Array.isArray(data.campaigns) ? data.campaigns : [];
    if (
      state.chatScope === 'campaign' &&
      !state.chatCampaigns.some((campaign) => campaign.id === state.chatCampaignId)
    ) {
      state.chatScope = 'world';
      state.chatCampaignId = null;
    }
    renderChatRooms();
    updateChatRoomHeader();
  }

  function startChatPolling() {
    if (state.chatPollingTimer !== null) clearInterval(state.chatPollingTimer);
    state.chatPollingTimer = setInterval(() => {
      if (state.chatModalOpen && !document.hidden) void loadChatMessages();
    }, 5000);
  }

  async function pollChatNotifications() {
    if (!state.user?.id || !state.token || state.chatNotificationPollingBusy || document.hidden) return;
    state.chatNotificationPollingBusy = true;
    try {
      const campaignData = await request('/campaigns');
      const campaigns = Array.isArray(campaignData.campaigns) ? campaignData.campaigns : [];
      state.chatCampaigns = campaigns;
      const rooms = [
        { key: 'world', path: '/chat/world' },
        ...campaigns.map((campaign) => ({
          key: chatRoomKey('campaign', campaign.id),
          path: '/campaigns/' + encodeURIComponent(campaign.id) + '/chat',
        })),
      ];
      const results = await Promise.all(rooms.map(async (room) => {
        try {
          const response = await request(room.path);
          return { room, messages: Array.isArray(response.messages) ? response.messages : [] };
        } catch (error) {
          if (error.status === 403 || error.status === 404) return { room, messages: [] };
          throw error;
        }
      }));
      for (const { room, messages } of results) {
        const previous = new Set(state.chatSeenMessageIds[room.key] || []);
        const currentRoom = state.chatModalOpen &&
          chatRoomKey(state.chatScope, state.chatCampaignId) === room.key;
        if (
          state.chatNotificationsPrimed &&
          !currentRoom &&
          !state.chatMutedRooms.has(room.key) &&
          messages.some((message) => message.id && !previous.has(message.id) && !message.isMine)
        ) {
          state.chatAlerts.add(room.key);
        }
        state.chatSeenMessageIds[room.key] = messages.map((message) => message.id).filter(Boolean);
      }
      state.chatNotificationsPrimed = true;
      if (state.chatScope === 'campaign' && !campaigns.some((campaign) => campaign.id === state.chatCampaignId)) {
        state.chatScope = 'world';
        state.chatCampaignId = null;
      }
      updateChatAlertButton();
      if (state.chatModalOpen) renderChatRooms();
    } catch (error) {
      if (error.status === 401) stopChatNotificationPolling();
    } finally {
      state.chatNotificationPollingBusy = false;
    }
  }

  function startChatNotificationPolling() {
    if (state.chatNotificationPollingTimer !== null) return;
    void pollChatNotifications();
    state.chatNotificationPollingTimer = setInterval(() => {
      void pollChatNotifications();
    }, 20000);
  }

  function stopChatNotificationPolling() {
    if (state.chatNotificationPollingTimer !== null) clearInterval(state.chatNotificationPollingTimer);
    state.chatNotificationPollingTimer = null;
    state.chatNotificationsPrimed = false;
    state.chatSeenMessageIds = {};
    state.chatAlerts.clear();
    updateChatAlertButton();
  }

  function closeChatModal() {
    const modal = $('#chat-modal');
    if (!modal || !state.chatModalOpen) return;
    state.chatModalOpen = false;
    state.chatRequestId += 1;
    if (state.chatPollingTimer !== null) clearInterval(state.chatPollingTimer);
    state.chatPollingTimer = null;
    modal.classList.add('hidden');
    document.body.classList.remove('chat-modal-open');
    $('#chat-open-button')?.focus();
  }

  async function openChatModal() {
    if (!state.user || !state.token) return;
    const modal = $('#chat-modal');
    if (!modal) return;
    state.chatModalOpen = true;
    modal.classList.remove('hidden');
    document.body.classList.add('chat-modal-open');
    setChatStatus('');
    const messageHost = $('#chat-messages');
    messageHost.replaceChildren();
    const loading = document.createElement('div');
    loading.className = 'chat-empty-state';
    loading.textContent = 'Подключаемся к комнатам…';
    messageHost.append(loading);
    try {
      await refreshChatCampaigns();
      if (!state.chatModalOpen) return;
      startChatPolling();
      await loadChatMessages();
      $('#chat-message-input').focus();
    } catch (error) {
      if (error.status === 401) {
        closeChatModal();
        state.user = null;
        showScreen('auth');
        setMessage('#auth-message', 'Сессия завершена. Войди снова.');
        void initVkOneTap();
      } else {
        setChatStatus(userErrorMessage(error) || 'Не удалось загрузить список кампаний.', true);
        renderChatRooms();
      }
    }
  }

  async function sendChatMessage(event) {
    event.preventDefault();
    if (state.chatSending || !state.token) return;
    const input = $('#chat-message-input');
    const value = input.value.trim();
    if (!value) return;
    if (state.chatScope === 'campaign' && !state.chatCampaignId) return;
    state.chatSending = true;
    $('#chat-send-button').disabled = true;
    setChatStatus('');
    const path = state.chatScope === 'world'
      ? '/chat/world'
      : '/campaigns/' + encodeURIComponent(state.chatCampaignId) + '/chat';
    try {
      await request(path, {
        method: 'POST',
        body: JSON.stringify({ message: value }),
      });
      input.value = '';
      await loadChatMessages();
    } catch (error) {
      if (error.status === 429) {
        setChatStatus('Слишком много сообщений. Подожди несколько секунд.', true);
      } else if (error.status === 403) {
        setChatStatus('Ты больше не состоишь в этой кампании.', true);
        try {
          await refreshChatCampaigns();
          await loadChatMessages();
        } catch (refreshError) {
          setChatStatus(refreshError.message || 'Не удалось обновить список комнат.', true);
        }
      } else if (error.status === 401) {
        closeChatModal();
        state.user = null;
        showScreen('auth');
        setMessage('#auth-message', 'Сессия завершена. Войди снова.');
        void initVkOneTap();
      } else {
        setChatStatus(userErrorMessage(error) || 'Не удалось отправить сообщение.', true);
      }
    } finally {
      state.chatSending = false;
      $('#chat-send-button').disabled = false;
      if (state.chatModalOpen) input.focus();
    }
  }

  function setMessage(selector, message, success = false) {
    const element = $(selector);
    element.textContent = message;
    element.classList.toggle('success', success);
  }

  const VK_ID_SDK_SOURCES = [
    'https://unpkg.com/@vkid/sdk@2.6.1/dist-sdk/umd/index.js',
    'https://cdn.jsdelivr.net/npm/@vkid/sdk@2.6.1/dist-sdk/umd/index.js',
  ];
  let vkIdSdkPromise = null;

  function loadVkIdSdkScript(source) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      let settled = false;
      const timeoutId = window.setTimeout(() => {
        script.remove();
        finish(reject, new Error('Не удалось загрузить VK ID: превышено время ожидания.'));
      }, 12000);

      function finish(callback, value) {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeoutId);
        callback(value);
      }

      script.async = true;
      script.crossOrigin = 'anonymous';
      script.src = source;
      script.onload = () => {
        if (window.VKIDSDK) {
          finish(resolve, window.VKIDSDK);
        } else {
          finish(reject, new Error('VK ID загрузился некорректно.'));
        }
      };
      script.onerror = () => {
        script.remove();
        finish(reject, new Error('Не удалось загрузить библиотеку VK ID.'));
      };
      document.head.appendChild(script);
    });
  }

  function loadVkIdSdk() {
    if (window.VKIDSDK) return Promise.resolve(window.VKIDSDK);
    if (vkIdSdkPromise) return vkIdSdkPromise;

    vkIdSdkPromise = (async () => {
      for (const source of VK_ID_SDK_SOURCES) {
        try {
          return await loadVkIdSdkScript(source);
        } catch (error) {
          console.warn('VK ID SDK source unavailable; trying the next CDN.', source, error);
        }
      }
      vkIdSdkPromise = null;
      throw new Error('Не удалось загрузить библиотеку VK ID с двух CDN.');
    })();
    return vkIdSdkPromise;
  }

  async function initVkOneTap() {
    const container = $('#vk-one-tap');
    if (!container) return;

    try {
      const sdk = await loadVkIdSdk();
      const config = await request('/auth/vk/one-tap-config', { method: 'POST' });
      if (
        !config ||
        !Number.isSafeInteger(config.appId) ||
        typeof config.redirectUrl !== 'string' ||
        typeof config.state !== 'string' ||
        typeof config.codeVerifier !== 'string'
      ) {
        throw new Error('Сервер вернул неполные настройки VK ID.');
      }

      sdk.Config.init({
        app: config.appId,
        redirectUrl: config.redirectUrl,
        state: config.state,
        codeVerifier: config.codeVerifier,
        mode: sdk.ConfigAuthMode.Redirect,
      });

      const oneTap = new sdk.OneTap();
      oneTap
        .render({ container, fastAuthEnabled: true })
        .on(sdk.WidgetEvents.ERROR, (error) => {
          console.error('VK ID One Tap widget error', error);
          setMessage('#vk-one-tap-message', 'Быстрый вход VK ID недоступен. Используй обычную кнопку ниже.');
        });
    } catch (error) {
      console.error('VK ID One Tap initialization failed', error);
      setMessage(
        '#vk-one-tap-message',
        userErrorMessage(error) || 'Не удалось подготовить быстрый вход VK ID. Используй обычную кнопку ниже.',
      );
    }
  }

  function showScreen(name) {
    state.activeScreen = name;
    $('#auth-screen').classList.toggle('hidden', name !== 'auth');
    $('#game-screen').classList.toggle('hidden', name !== 'game');
    $('#workspace-screen').classList.toggle('hidden', name !== 'workspace');
    $('#profile-screen').classList.toggle('hidden', name !== 'profile');
    $('#profile-button').classList.toggle('hidden', !state.user);
    $('#logout-button').classList.toggle('hidden', !state.user);
    $('#chat-open-button').classList.toggle('hidden', !state.user);
    $('#user-label').classList.toggle('hidden', !state.user);
    $('#user-label').textContent = state.user?.displayName || state.user?.email || '';
  }

  function renderProfile() {
    const profile = state.profile;
    if (!profile) return;
    $('#profile-display-name').value = profile.displayName || '';
    $('#profile-email').value = profile.email || '';
    $('#profile-user-title').textContent = profile.displayName || 'Игрок';
    const initials = String(profile.displayName || 'PW')
      .trim()
      .split(/\s+/u)
      .slice(0, 2)
      .map((part) => Array.from(part)[0] || '')
      .join('')
      .toLocaleUpperCase();
    $('#profile-avatar').textContent = initials || 'PW';
    const emailInput = $('#profile-email');
    emailInput.required = Boolean(profile.email) || !profile.hasVk;
    $('#profile-email-hint').textContent = profile.email
      ? 'Укажи актуальный email: он используется для резервного входа по паролю.'
      : profile.hasVk
        ? 'Email необязателен для входа через VK ID. Добавь его, чтобы включить резервный пароль.'
        : 'Укажи email, чтобы сохранить возможность входа в аккаунт.';
    $('#profile-vk-status').textContent = profile.hasVk ? 'Подключён' : 'Не подключён';
    $('#profile-vk-status').classList.toggle('connected', profile.hasVk);
    $('#profile-link-vk').classList.toggle('hidden', profile.hasVk);
    $('#profile-password-status').textContent = profile.hasPassword
      ? 'Пароль настроен для резервного входа'
      : 'Пароль ещё не установлен';
    $('#profile-password-pill').textContent = profile.hasPassword ? 'Задан' : 'Не задан';
    $('#profile-password-pill').classList.toggle('connected', profile.hasPassword);
    $('#profile-current-password-row').classList.toggle('hidden', !profile.hasPassword);
    $('#profile-current-password').required = profile.hasPassword;
    $('#profile-password-form').classList.toggle('hidden', !profile.email);
    $('#profile-password-unavailable').classList.toggle('hidden', Boolean(profile.email));
    $('#profile-password-title').textContent = profile.hasPassword ? 'Изменить пароль' : 'Установить пароль';
    $('#profile-password-caption').textContent = profile.hasPassword
      ? 'Для смены пароля введи текущий, затем задай новый длиной не менее 12 символов.'
      : 'Задай резервный пароль длиной не менее 12 символов. Текущий пароль не требуется.';
    $('#profile-password-submit').textContent = profile.hasPassword
      ? 'Изменить пароль ↗'
      : 'Установить пароль ↗';
    $('#profile-current-password').value = '';
    $('#profile-new-password').value = '';
    $('#profile-confirm-password').value = '';
    state.adminModeEnabled = profile.adminModeEnabled === true;
    $('#admin-code-panel').classList.toggle('hidden', profile.isAdmin === true);
    $('#admin-tools-panel').classList.toggle('hidden', profile.isAdmin !== true);
    $('#admin-mode-toggle').textContent = state.adminModeEnabled
      ? 'Выключить инструменты администратора'
      : 'Включить инструменты администратора';
    $('#admin-tools-content').classList.toggle('hidden', !state.adminModeEnabled);
    if (profile.isAdmin && state.adminModeEnabled && state.activeScreen === 'profile') {
      void refreshAdminTools();
    }
  }

  async function loadProfile() {
    const data = await request('/auth/profile');
    state.profile = data.profile;
    state.user = {
      id: data.profile.id,
      email: data.profile.email,
      displayName: data.profile.displayName,
    };
    $('#user-label').textContent = state.user.displayName || state.user.email || '';
    renderProfile();
  }

  function isAdminMode() {
    return state.profile?.isAdmin === true && state.adminModeEnabled === true;
  }

  function adminSelectedCampaignId() {
    return $('#admin-campaign-select')?.value || state.campaign?.id || '';
  }

  function renderAdminDiscoveries(discoveries) {
    const host = $('#admin-discoveries-list');
    if (!host) return;
    host.replaceChildren();
    if (!discoveries.length) {
      const empty = document.createElement('div');
      empty.className = 'chat-room-empty';
      empty.textContent = 'Для этой кампании пока нет результатов колонизации.';
      host.append(empty);
      return;
    }
    for (const item of discoveries) {
      const card = document.createElement('article');
      card.className = 'admin-data-card';
      const title = document.createElement('strong');
      const roll = item.d100 === null || item.d100 === undefined ? 'бросок не записан' : 'd100: ' + item.d100;
      title.textContent = roll + ' · ' + (item.type === 'gold' ? 'Золото' : item.type === 'ruins' ? 'Руины' : 'Обычная клетка');
      const detail = document.createElement('span');
      detail.textContent = 'Координаты ' + item.x + ', ' + item.y + ' · ход ' + item.discoveredAtTurn;
      card.append(title, detail);
      host.append(card);
    }
  }

  async function loadAdminDiscoveries() {
    const campaignId = adminSelectedCampaignId();
    const host = $('#admin-discoveries-list');
    if (!host) return;
    if (!campaignId) {
      host.textContent = 'Сначала выбери кампанию.';
      return;
    }
    host.textContent = 'Загрузка результатов…';
    try {
      const data = await request('/admin/campaigns/' + encodeURIComponent(campaignId) + '/discoveries');
      state.adminCampaignDiscoveries = Array.isArray(data.discoveries) ? data.discoveries : [];
      renderAdminDiscoveries(state.adminCampaignDiscoveries);
    } catch (error) {
      host.textContent = userErrorMessage(error);
    }
  }

  function renderAdminCountryCard(country) {
    const hosts = [$('#admin-country-card'), $('#admin-map-country-card')].filter(Boolean);
    for (const host of hosts) {
      host.replaceChildren();
      host.classList.toggle('hidden', !country);
      if (!country) {
        host.textContent = 'Государство не найдено.';
        continue;
      }
      const card = document.createElement('article');
      card.className = 'admin-data-card';
      const heading = document.createElement('div');
      heading.className = 'admin-country-card-heading';
      const title = document.createElement('strong');
      title.textContent = country.name;
      heading.append(title);
      if (host.id === 'admin-map-country-card') {
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'button button-quiet button-small';
        close.textContent = 'Закрыть';
        close.addEventListener('click', () => host.classList.add('hidden'));
        heading.append(close);
      }
      const meta = document.createElement('span');
      meta.textContent = 'Население: ' + country.residentCount + ' · Построек: ' +
        (country.buildings || []).reduce((total, item) => total + Number(item.count || 0), 0);
      const details = document.createElement('span');
      details.textContent = 'Правление: ' + (country.government || 'не указано') +
        ' · Культура: ' + ((country.culture || []).join(', ') || 'не указана');
      const economy = document.createElement('span');
      if (country.economy) {
        const report = country.economy;
        economy.textContent = 'Экономика: доход ' + report.income + ' · содержание ' +
          report.expenses + ' · еда ' + report.food + '/' + report.foodDemand +
          ' · товары ' + report.goods + '/' + report.goodsDemand +
          (report.budgetDeficit ? ' · дефицит бюджета' : '');
      } else {
        economy.textContent = 'Экономика: ожидает первого завершённого хода.';
      }
      const system = document.createElement('div');
      system.className = 'admin-data-card';
      const systemTitle = document.createElement('strong');
      systemTitle.textContent = (country.officialSystem?.type === 'religion' ? 'Официальная религия: ' : 'Официальная идеология: ') +
        (country.officialSystem?.name || 'не указана');
      system.append(systemTitle);
      for (const principle of country.officialSystem?.principles || []) {
        const row = document.createElement('span');
        row.textContent = principle.name + ' — ' + (principle.effect || principle.description || '');
        system.append(row);
      }
      card.append(heading, meta, details, economy, system);
      host.append(card);
    }
  }

  async function loadAdminCountryCard(countryId) {
    const campaignId = state.campaign?.id;
    if (!campaignId || !countryId) return;
    const hosts = [$('#admin-country-card'), $('#admin-map-country-card')].filter(Boolean);
    for (const host of hosts) {
      host.classList.remove('hidden');
      host.textContent = 'Загрузка карточки государства…';
    }
    try {
      const data = await request(
        '/admin/campaigns/' + encodeURIComponent(campaignId) +
        '/countries/' + encodeURIComponent(countryId),
      );
      state.adminSelectedCountry = data.country || null;
      renderAdminCountryCard(state.adminSelectedCountry);
      if (!data.country) showToast('Государство не найдено.', true);
    } catch (error) {
      for (const host of hosts) host.textContent = userErrorMessage(error);
    }
  }

  function renderAdminUsers(users) {
    const host = $('#admin-users-list');
    if (!host) return;
    host.replaceChildren();
    if (!users.length) {
      host.textContent = 'Игроков пока нет.';
      return;
    }
    for (const user of users) {
      const row = document.createElement('div');
      row.className = 'admin-user-row';
      const identity = document.createElement('div');
      const name = document.createElement('strong');
      name.textContent = user.displayName;
      const email = document.createElement('small');
      email.textContent = user.email || 'Без email';
      identity.append(name, email);
      const input = document.createElement('input');
      input.type = 'text';
      input.maxLength = 32;
      input.value = user.displayName;
      input.setAttribute('aria-label', 'Новый никнейм игрока ' + user.displayName);
      const rename = document.createElement('button');
      rename.type = 'button';
      rename.className = 'button button-outline button-small';
      rename.textContent = 'Переименовать';
      rename.addEventListener('click', async () => {
        rename.disabled = true;
        try {
          await request('/admin/users/' + encodeURIComponent(user.id), {
            method: 'PATCH',
            body: JSON.stringify({ displayName: input.value }),
          });
          showToast('Никнейм игрока изменён.');
          await loadAdminUsers();
        } catch (error) {
          showToast(userErrorMessage(error), true);
        } finally {
          rename.disabled = false;
        }
      });
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'button button-outline button-small';
      remove.textContent = 'Удалить аккаунт';
      const protectedUser = user.isAdmin || user.id === state.user?.id || user.status !== 'active';
      remove.disabled = protectedUser;
      remove.title = protectedUser ? 'Аккаунт администратора защищён' : 'Деактивировать аккаунт игрока';
      remove.addEventListener('click', async () => {
        if (!window.confirm('Деактивировать аккаунт игрока «' + user.displayName + '»? Доступ будет закрыт, а никнейм заменён на «Удалённый игрок».')) return;
        remove.disabled = true;
        try {
          await request('/admin/users/' + encodeURIComponent(user.id), { method: 'DELETE' });
          showToast('Аккаунт игрока деактивирован.');
          await loadAdminUsers();
        } catch (error) {
          showToast(userErrorMessage(error), true);
        } finally {
          remove.disabled = false;
        }
      });
      row.append(identity, input, rename, remove);
      host.append(row);
    }
  }

  async function loadAdminUsers() {
    const host = $('#admin-users-list');
    if (!host) return;
    host.textContent = 'Загрузка списка игроков…';
    try {
      const data = await request('/admin/users');
      state.adminUsers = Array.isArray(data.users) ? data.users : [];
      renderAdminUsers(state.adminUsers);
    } catch (error) {
      host.textContent = userErrorMessage(error);
    }
  }

  async function refreshAdminTools() {
    if (!isAdminMode()) return;
    const select = $('#admin-campaign-select');
    const previous = select.value || state.campaign?.id || '';
    try {
      const data = await request('/admin/campaigns');
      state.adminCampaigns = Array.isArray(data.campaigns) ? data.campaigns : [];
      select.replaceChildren();
      for (const campaign of state.adminCampaigns) {
        const option = document.createElement('option');
        option.value = campaign.id;
        option.textContent =
          campaign.name + ' · ход ' + campaign.currentTurn + ' · игроков ' + campaign.playerCount;
        if (campaign.status !== 'active') option.textContent += ' · завершена';
        select.append(option);
      }
      if (previous && [...select.options].some((option) => option.value === previous)) {
        select.value = previous;
      } else if (select.options.length > 0) {
        select.selectedIndex = 0;
      }
    } catch (error) {
      $('#admin-discoveries-list').textContent = userErrorMessage(error);
      return;
    }
    await Promise.all([loadAdminUsers(), loadAdminDiscoveries()]);
  }

  function openAdminCampaignMap() {
    if (!isAdminMode()) return;
    const campaignId = adminSelectedCampaignId();
    const selected = state.adminCampaigns.find((campaign) => campaign.id === campaignId);
    if (!selected) {
      showToast('Сначала выбери кампанию.', true);
      return;
    }
    if (state.campaign?.id !== selected.id) {
      if (!state.adminMapOpened) {
        state.adminMapPreviousCampaign = state.campaign;
        state.adminMapOpened = true;
      }
      state.campaign = {
        id: selected.id,
        name: selected.name,
        status: selected.status,
        currentTurn: selected.currentTurn,
        ordersLocked: selected.ordersLocked,
        countryId: null,
      };
      state.mapOrders = [];
      state.turnStatus = null;
      state.mapView = null;
    }
    state.mapTransform = null;
    showScreen('game');
    openMap();
  }

  async function toggleAdminMode() {
    if (!state.profile?.isAdmin) return;
    const enabled = !state.adminModeEnabled;
    const button = $('#admin-mode-toggle');
    button.disabled = true;
    try {
      await request('/auth/admin-mode', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      });
      await loadProfile();
      showToast(enabled ? 'Административный режим включён.' : 'Административный режим выключен.');
    } catch (error) {
      setMessage('#admin-tools-message', userErrorMessage(error));
    } finally {
      button.disabled = false;
    }
  }

  async function submitAdminCode(event) {
    event.preventDefault();
    const input = $('#admin-code-input');
    const button = $('#admin-code-submit');
    const code = input.value;
    if (!code) return;
    button.disabled = true;
    setMessage('#admin-code-message', '');
    try {
      await request('/auth/admin-code', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      input.value = '';
      await loadProfile();
      setMessage('#admin-code-message', 'Права администратора получены. Инструменты включены.', true);
      showToast('Права администратора активированы.');
    } catch (error) {
      setMessage('#admin-code-message', userErrorMessage(error));
    } finally {
      button.disabled = false;
    }
  }

  async function adminDeleteBuilding(x, y) {
    const campaignId = state.campaign?.id;
    if (!campaignId) return;
    try {
      await request('/admin/campaigns/' + encodeURIComponent(campaignId) + '/buildings', {
        method: 'DELETE',
        body: JSON.stringify({ x, y }),
      });
      await loadCampaignMap();
      await loadTurnRoom();
      await loadMapOrders();
      showToast('Постройка удалена.');
    } catch (error) {
      showToast(userErrorMessage(error), true);
    }
  }

  async function adminDeleteColony(territoryId) {
    const campaignId = state.campaign?.id;
    if (!campaignId || !territoryId) return;
    try {
      await request(
        '/admin/campaigns/' + encodeURIComponent(campaignId) +
        '/colonies/' + encodeURIComponent(territoryId),
        { method: 'DELETE' },
      );
      await loadCampaignMap();
      await loadTurnRoom();
      await loadMapOrders();
      showToast('Колония удалена.');
    } catch (error) {
      showToast(userErrorMessage(error), true);
    }
  }

  async function adminForceEndTurn() {
    const campaignId = adminSelectedCampaignId();
    if (!campaignId) return;
    if (!window.confirm('Принудительно завершить приём приказов и отправить текущий ход на обработку?')) return;
    const button = $('#admin-force-end-turn');
    button.disabled = true;
    try {
      await request('/admin/campaigns/' + encodeURIComponent(campaignId) + '/force-end-turn', {
        method: 'POST',
      });
      showToast('Ход принудительно закрыт и отправлен на обработку.');
      await loadCampaigns();
      await loadTurnRoom();
      await loadMapOrders();
    } catch (error) {
      showToast(userErrorMessage(error), true);
    } finally {
      button.disabled = false;
    }
  }

  async function adminRollbackTurn() {
    const campaignId = adminSelectedCampaignId();
    if (!campaignId) return;
    if (!window.confirm('Откатить последний завершённый ход? Это удалит его результаты и вернёт мир к предыдущему состоянию.')) return;
    const button = $('#admin-rollback-turn');
    button.disabled = true;
    try {
      const data = await request('/admin/campaigns/' + encodeURIComponent(campaignId) + '/rollback', {
        method: 'POST',
      });
      showToast('Ход ' + data.turnNumber + ' отменён. Приказы можно отправить заново.');
      await loadCampaigns();
      await loadCampaignMap();
      await loadTurnRoom();
      await loadMapOrders();
      await loadAdminDiscoveries();
    } catch (error) {
      showToast(userErrorMessage(error), true);
    } finally {
      button.disabled = false;
    }
  }

  async function openProfile() {
    if (!state.user) return false;
    if (state.activeScreen !== 'profile') {
      state.profileReturnScreen = state.activeScreen || (state.campaign ? 'workspace' : 'game');
    }
    showScreen('profile');
    setMessage('#profile-page-message', '');
    try {
      await loadProfile();
      return true;
    } catch (error) {
      setMessage('#profile-page-message', userErrorMessage(error) || 'Не удалось загрузить профиль.');
      return false;
    }
  }

  function closeProfile() {
    const destination = ['game', 'workspace'].includes(state.profileReturnScreen)
      ? state.profileReturnScreen
      : (state.campaign ? 'workspace' : 'game');
    showScreen(destination);
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
      } catch (error) {
        if (error.status !== 401) throw error;
        state.token = '';
        sessionStorage.removeItem('pw_access_token');
      }
    }

    let refreshed;
    try {
      refreshed = await fetch('/auth/refresh', {
        method: 'POST',
        credentials: 'same-origin',
      });
    } catch {
      throw new Error('Не удалось связаться с сервером. Проверь, запущено ли окно «Paper Wars API».');
    }

    if (refreshed.status === 401) return false;
    if (!refreshed.ok) {
      let details = null;
      try { details = await refreshed.json(); } catch { /* Response did not contain JSON. */ }
      throw new Error(details?.message || details?.error || `Сервер вернул HTTP ${refreshed.status} при восстановлении сессии.`);
    }

    const data = await refreshed.json();
    if (!data || typeof data.accessToken !== 'string') {
      throw new Error('Сервер вернул неполный ответ при восстановлении сессии.');
    }
    state.token = data.accessToken;
    sessionStorage.setItem('pw_access_token', state.token);
    const me = await request('/auth/me');
    state.user = me.user;
    return true;
  }

  async function loadCampaigns() {
    const data = await request('/campaigns');
    state.campaigns = data.campaigns || [];
    if (state.chatModalOpen) {
      state.chatCampaigns = state.campaigns;
      if (state.chatScope === 'campaign' &&
          !state.chatCampaigns.some((campaign) => campaign.id === state.chatCampaignId)) {
        state.chatScope = 'world';
        state.chatCampaignId = null;
        void loadChatMessages();
      }
      renderChatRooms();
      updateChatRoomHeader();
    }
    renderCampaigns();
    await loadOpenCampaigns();
    loadChatPreferences();
    startChatNotificationPolling();
  }

  async function loadOpenCampaigns() {
    const host = $('#open-campaign-list');
    if (!host) return;
    const refresh = $('#refresh-open-campaigns');
    if (refresh) refresh.disabled = true;
    try {
      const data = await request('/campaigns/open');
      state.openCampaigns = Array.isArray(data.campaigns) ? data.campaigns : [];
      renderOpenCampaigns();
    } catch (error) {
      host.innerHTML = '<div class="open-campaign-empty">Не удалось загрузить открытые кампании: ' + escapeHtml(userErrorMessage(error)) + '</div>';
    } finally {
      if (refresh) refresh.disabled = false;
    }
  }

  function renderOpenCampaigns() {
    const host = $('#open-campaign-list');
    if (!host) return;
    if (!state.openCampaigns.length) {
      host.innerHTML = '<div class="open-campaign-empty">Сейчас нет открытых кампаний. Создай свой мир или загляни позже.</div>';
      return;
    }
    host.innerHTML = state.openCampaigns.map((campaign) => `
      <article class="open-campaign-card">
        <div>
          <strong>${escapeHtml(campaign.name)}</strong>
          <small>${campaign.mapWidth} × ${campaign.mapHeight} · ХОД ${String(campaign.currentTurn).padStart(2, '0')}</small>
        </div>
        <div class="open-campaign-meta">
          <span>Игроки <b>${campaign.playerCount}/${campaign.maxPlayers}</b></span>
          <span>Ход <b>${campaign.turnDurationHours} ч</b></span>
          <span>Создана <b>${escapeHtml(new Date(campaign.createdAt).toLocaleDateString('ru-RU'))}</b></span>
        </div>
        <button class="button button-outline open-campaign-join" data-open-campaign-id="${escapeHtml(campaign.id)}" type="button">Вступить в кампанию ↗</button>
      </article>`).join('');
    host.querySelectorAll('.open-campaign-join').forEach((button) => {
      button.addEventListener('click', async () => {
        const campaignId = button.dataset.openCampaignId;
        if (!campaignId) return;
        button.disabled = true;
        try {
          await request('/campaigns/' + encodeURIComponent(campaignId) + '/join', { method: 'POST' });
          await loadCampaigns();
          showToast('Ты присоединился к кампании.');
        } catch (error) {
          showToast(userErrorMessage(error), true);
          await loadOpenCampaigns();
        } finally {
          button.disabled = false;
        }
      });
    });
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
      showToast(userErrorMessage(error), true);
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
    state.librarySystems = [];
    state.availableSystems = [];
    state.countryProfile = null;
    state.mapOrders = [];
    state.mapContextMenuCell = null;
    state.turnStatus = null;
    state.orderResults = [];
    state.turnRoomLoading = false;
    state.turnRoomError = '';
    $('#workspace-turn-label').textContent = 'СВЕРКА';
    $('#workspace-turn-number').textContent = 'ХОД ' + String(campaign.currentTurn || 1).padStart(2, '0');
    $('#world-status-value').textContent = 'Загрузка';
    $('#world-turn-value').textContent = String(campaign.currentTurn || 1).padStart(2, '0');
    state.orderResultsError = '';
    state.loadedSystemEmblemDataUrl = null;
    state.placements = {};
    resetFoundedPanels();
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
    if (campaign.countryId) await loadCountryProfile();
    await loadTurnRoom();
    if (campaign.countryId) {
      try { await loadMapOrders(); } catch (error) { showToast('Не удалось загрузить приказы карты: ' + userErrorMessage(error), true); }
    }
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

  function mapAdjacentWaterCount(x, y) {
    let count = 0;
    const width = state.mapView?.width || 0;
    const height = state.mapView?.height || 0;
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        if (offsetX === 0 && offsetY === 0) continue;
        const nextX = x + offsetX;
        const nextY = y + offsetY;
        if (nextX < 0 || nextY < 0 || nextX >= width || nextY >= height) continue;
        if (terrainCodeAt(nextX, nextY) !== 'l') count += 1;
      }
    }
    return count;
  }

  function mapCardinalWaterCount(x, y) {
    const width = state.mapView?.width || 0;
    const height = state.mapView?.height || 0;
    return [[-1, 0], [1, 0], [0, -1], [0, 1]].filter(([dx, dy]) => {
      const nextX = x + dx;
      const nextY = y + dy;
      return nextX >= 0 && nextY >= 0 && nextX < width && nextY < height &&
        terrainCodeAt(nextX, nextY) !== 'l';
    }).length;
  }

  const SCIENCE_REQUIRED_BY_BUILDING = {
    rice_field: 2,
    greenhouse: 2,
    dam: 3,
    field_level_2: 10,
    factory_level_2: 10,
    textile_workshop_level_2: 15,
  };

  function currentScienceLevel() {
    const ownCountry = (state.mapView?.countries || []).find((item) => item.isMine);
    if (ownCountry) {
      return ownCountry.cells.filter((cell) => cell.buildingType === 'science').length;
    }
    return Math.max(0, Number(
      (state.countryProfile?.buildings || []).find((item) => item.type === 'science')?.count || 0
    ));
  }

  function scienceRequirementFor(type) {
    return Number(SCIENCE_REQUIRED_BY_BUILDING[type] || 0);
  }

  const mapBuildingOptions = [
    ['factory', 'Фабрика'],
    ['field', 'Поле'],
    ['rice_field', 'Рисовое поле'],
    ['cotton_field', 'Хлопковое поле'],
    ['textile_workshop', 'Ткацкая мастерская'],
    ['hunter', 'Охотники'],
    ['fisher', 'Рыбаки'],
    ['science', 'Научный центр'],
    ['religious_building', 'Храм'],
    ['barracks', 'Казармы'],
    ['tower', 'Башня'],
  ];

  function isFreeUpgradeOrder(order) {
    return order?.type === 'structure_removal' ||
      (order?.type === 'construction' &&
        ['field_level_2', 'factory_level_2', 'textile_workshop_level_2'].includes(order.payload?.buildingType));
  }

  function mapOrderCoordinates(order) {
    const payload = order?.payload;
    if (!payload || !Number.isSafeInteger(payload.x) || !Number.isSafeInteger(payload.y)) return null;
    return { x: payload.x, y: payload.y };
  }

  function mapOrdersAt(x, y) {
    return state.mapOrders.filter((order) => {
      const point = mapOrderCoordinates(order);
      return point?.x === x && point?.y === y;
    });
  }

  function mapColonizationRegion(centerX, centerY) {
    if (!state.mapView || centerX < 1 || centerY < 1 ||
        centerX >= state.mapView.width - 1 || centerY >= state.mapView.height - 1) return null;
    const cells = [];
    for (let y = centerY - 1; y <= centerY + 1; y += 1) {
      for (let x = centerX - 1; x <= centerX + 1; x += 1) cells.push({ x, y });
    }
    return cells;
  }

  function mapColonizationAvailability(centerX, centerY) {
    const region = mapColonizationRegion(centerX, centerY);
    if (!region) return { allowed: false, reason: 'bounds' };
    const occupiedCoordinates = new Set();
    const ownCoordinates = new Set();
    for (const country of state.mapView.countries || []) {
      for (const cell of country.cells || []) {
        const key = cell.x + ',' + cell.y;
        occupiedCoordinates.add(key);
        if (country.isMine) ownCoordinates.add(key);
      }
    }
    const plannedCoordinates = new Set();
    for (const order of state.mapOrders || []) {
      if (order.type !== 'colonization' || order.status === 'discarded') continue;
      const point = mapOrderCoordinates(order);
      if (!point) continue;
      const plannedRegion = mapColonizationRegion(point.x, point.y);
      if (!plannedRegion) continue;
      for (const cell of plannedRegion) plannedCoordinates.add(cell.x + ',' + cell.y);
    }
    for (const cell of region) {
      const key = cell.x + ',' + cell.y;
      if (occupiedCoordinates.has(key) || plannedCoordinates.has(key)) {
        return { allowed: false, reason: 'overlap' };
      }
    }
    if (!region.some((cell) => mapIsLand(cell.x, cell.y))) {
      return { allowed: false, reason: 'no-land' };
    }
    const adjacentSides = [
      [[centerX - 1, centerY - 2], [centerX, centerY - 2], [centerX + 1, centerY - 2]],
      [[centerX - 1, centerY + 2], [centerX, centerY + 2], [centerX + 1, centerY + 2]],
      [[centerX - 2, centerY - 1], [centerX - 2, centerY], [centerX - 2, centerY + 1]],
      [[centerX + 2, centerY - 1], [centerX + 2, centerY], [centerX + 2, centerY + 1]],
    ];
    const touchesOwnTerritory = adjacentSides.some((side) =>
      side.every(([x, y]) => ownCoordinates.has(x + ',' + y) || plannedCoordinates.has(x + ',' + y)),
    );
    if (!touchesOwnTerritory) return { allowed: false, reason: 'not-adjacent' };
    return { allowed: true, reason: 'available' };
  }

  function mapColonizationMessage(reason) {
    if (reason === 'bounds') return 'Квадрат 3×3 должен полностью находиться в пределах карты.';
    if (reason === 'overlap') return 'Новая колония не должна пересекать существующие или уже запланированные территории.';
    if (reason === 'no-land') return 'В квадрате 3×3 должна быть хотя бы одна свободная клетка суши.';
    if (reason === 'not-adjacent') return 'Колония 3×3 должна полностью примыкать одной стороной из трёх клеток к твоей территории или предыдущей колонии.';
    return 'Эту область нельзя колонизировать.';
  }

  function mapActionCount() {
    return state.mapOrders.filter(
      (order) => order.status !== 'discarded' && !isFreeUpgradeOrder(order),
    ).length;
  }

  function renderMapOrderSummary() {
    const summary = $('#map-order-summary');
    const confirm = $('#confirm-map-orders');
    if (!summary || !confirm) return;
    const activeOrders = state.mapOrders.filter((order) => order.status !== 'discarded');
    const actionCount = activeOrders.filter((order) => !isFreeUpgradeOrder(order)).length;
    const unlimitedActions = isAdminMode();
    const remainingActions = unlimitedActions ? '∞' : Math.max(0, 3 - actionCount);
    const draftCount = activeOrders.filter((order) => order.status !== 'confirmed').length;
    const confirmedCount = activeOrders.length - draftCount;
    const status = state.turnStatus;
    const deadlinePassed = Boolean(status?.deadlineAt &&
      Date.now() >= new Date(status.deadlineAt).getTime());
    summary.hidden = !state.campaign?.countryId;
    summary.textContent = `ОД: ${actionCount}/${unlimitedActions ? '∞' : '3'} · осталось: ${remainingActions} · черновики: ${draftCount} · подтверждено: ${confirmedCount}`;
    confirm.hidden = !state.campaign?.countryId;
    confirm.disabled =
      status?.ordersAccepting !== true || status?.ordersConfirmed === true;
    confirm.textContent = status?.ordersConfirmed
      ? 'Приказы подтверждены'
      : deadlinePassed
        ? 'Ход закрывается автоматически'
        : draftCount > 0
          ? `Подтвердить приказы (${draftCount})`
          : 'Подтвердить ход без приказов';
  }

  async function loadMapOrders() {
    if (!state.campaign?.countryId) {
      state.mapOrders = [];
      renderMapOrderSummary();
      return;
    }
    const campaignId = state.campaign.id;
    const data = await request('/campaigns/' + encodeURIComponent(campaignId) + '/orders/mine');
    if (state.campaign?.id !== campaignId) return;
    state.mapOrders = Array.isArray(data.orders) ? data.orders : [];
    renderMapOrderSummary();
    if (!$('#map-modal').classList.contains('hidden')) drawMapCanvas($('#map-canvas'), false);
  }

  async function createMapOrder(type, payload) {
    if (!state.campaign?.countryId) {
      showToast('Сначала основай государство.', true);
      return;
    }
    if (state.turnStatus?.ordersAccepting !== true) {
      const deadlinePassed = Boolean(state.turnStatus?.deadlineAt &&
        Date.now() >= new Date(state.turnStatus.deadlineAt).getTime());
      showToast(deadlinePassed
        ? 'Срок приёма приказов истёк. Ход закроется автоматически.'
        : 'Приём приказов закрыт. ' + (state.turnRoomError || 'Проверь, завершили ли все участники основание государств.'), true);
      return;
    }
    if (!isAdminMode() && mapActionCount() >= 3) {
      showToast('На этот ход уже использованы все 3 очка действий.', true);
      return;
    }
    if (type === 'colonization') {
      const availability = mapColonizationAvailability(payload.x, payload.y);
      if (!availability.allowed) {
        showToast(mapColonizationMessage(availability.reason), true);
        return;
      }
    }
    const campaignId = state.campaign.id;
    try {
      await request('/campaigns/' + encodeURIComponent(campaignId) + '/orders', {
        method: 'POST',
        body: JSON.stringify({ type, schemaVersion: 1, payload }),
      });
      await loadMapOrders();
      await loadTurnRoom();
      closeMapContextMenu();
      drawMapCanvas($('#map-canvas'), false);
      showToast(type === 'colonization'
        ? 'Приказ колонизации добавлен в список.'
        : type === 'demolition'
          ? 'Приказ на снос добавлен в список.'
          : 'Приказ строительства добавлен в список.');
    } catch (error) {
      showToast(userErrorMessage(error) || 'Не удалось сохранить приказ.', true);
    }
  }

  async function removeMapOrder(orderId) {
    if (!state.campaign || !orderId) return;
    try {
      await request(
        '/campaigns/' + encodeURIComponent(state.campaign.id) + '/orders/' + encodeURIComponent(orderId),
        { method: 'DELETE' },
      );
      await loadMapOrders();
      await loadTurnRoom();
      closeMapContextMenu();
      drawMapCanvas($('#map-canvas'), false);
      showToast('Приказ снят с карты.');
    } catch (error) {
      showToast(userErrorMessage(error) || 'Не удалось снять приказ.', true);
    }
  }

  async function returnMapOrderToDraft(orderId) {
    const order = state.mapOrders.find((item) => item.id === orderId);
    if (!state.campaign || !order || order.status !== 'confirmed') return;
    if (state.turnStatus?.ordersAccepting !== true) {
      showToast('Приказы уже закрыты. Вернуть их в черновик нельзя.', true);
      return;
    }
    try {
      await request(
        '/campaigns/' + encodeURIComponent(state.campaign.id) + '/orders/' + encodeURIComponent(orderId),
        {
          method: 'PATCH',
          body: JSON.stringify({
            type: order.type,
            schemaVersion: order.schemaVersion,
            payload: order.payload,
          }),
        },
      );
      await loadMapOrders();
      await loadTurnRoom();
      closeMapContextMenu();
      drawMapCanvas($('#map-canvas'), false);
      showToast('Приказ возвращён в черновик. Все твои подтверждённые приказы также стали черновиками — подтверди их заново.');
    } catch (error) {
      showToast(userErrorMessage(error) || 'Не удалось вернуть приказ в черновик.', true);
    }
  }

  async function confirmMapOrders() {
    if (!state.campaign || state.turnStatus?.ordersAccepting !== true) return;
    const button = $('#confirm-map-orders');
    button.disabled = true;
    try {
      const result = await request(
        '/campaigns/' + encodeURIComponent(state.campaign.id) + '/orders/confirm',
        { method: 'POST' },
      );
      await loadMapOrders();
      await loadTurnRoom();
      showToast(result.turnQueued
        ? 'Приказы подтверждены. Ход поставлен в очередь на обработку.'
        : 'Приказы подтверждены. Ожидаем остальных участников.');
    } catch (error) {
      showToast(userErrorMessage(error) || 'Не удалось подтвердить приказы.', true);
    } finally {
      renderMapOrderSummary();
    }
  }

  function closeMapContextMenu() {
    const menu = $('#map-context-menu');
    if (menu) {
      menu.classList.add('hidden');
      menu.replaceChildren();
    }
    state.mapContextMenuCell = null;
  }

  function openMapContextMenu(cell, clientX, clientY) {
    const menu = $('#map-context-menu');
    if (!menu || !state.mapView || !cell) return;
    state.mapContextMenuCell = cell;
    const ownCountry = (state.mapView.countries || []).find((country) => country.isMine);
    const ownedCell = ownCountry?.cells.find((item) => item.x === cell.x && item.y === cell.y);
    const anyCountryOwnsCell = (state.mapView.countries || []).some((country) =>
      country.cells.some((item) => item.x === cell.x && item.y === cell.y),
    );
    const isLand = mapIsLand(cell.x, cell.y);
    const existingOrders = mapOrdersAt(cell.x, cell.y);
    const colonizationAvailability = mapColonizationAvailability(cell.x, cell.y);
    const canColonizeRegion = colonizationAvailability.allowed;
    const adminMode = isAdminMode();
    const actionsRemaining = adminMode ? Infinity : Math.max(0, 3 - mapActionCount());
    const countryAtCell = (state.mapView.countries || []).find((country) =>
      country.cells.some((item) => item.x === cell.x && item.y === cell.y),
    );
    const buildingAtCell = countryAtCell?.cells.find(
      (item) => item.x === cell.x && item.y === cell.y && item.buildingType,
    );
    const canFreeUpgrade = Boolean(
      ownedCell &&
      !ownedCell.flooded &&
      ((ownedCell.buildingType === 'field' && ownedCell.structureType !== 'greenhouse') ||
        ownedCell.buildingType === 'factory' ||
        ownedCell.buildingType === 'textile_workshop'),
    );
    const colonyAtCell = (countryAtCell?.territories || []).find((territory) => {
      if (territory.type !== 'colony') return false;
      const minX = territory.centerX - Math.floor(territory.width / 2);
      const minY = territory.centerY - Math.floor(territory.height / 2);
      return cell.x >= minX && cell.x < minX + territory.width &&
        cell.y >= minY && cell.y < minY + territory.height;
    });
    let content = `<header><strong>КЛЕТКА ${cell.x}, ${cell.y}</strong><button type="button" data-map-action="close" aria-label="Закрыть">×</button></header>`;
    content += `<p class="map-context-location">${isLand ? 'Суша' : 'Вода или река'} · ${anyCountryOwnsCell ? (ownedCell ? 'Твоя территория' : 'Чужая территория') : 'Свободная территория'}</p>`;

    if (!state.campaign?.countryId && !adminMode) {
      content += '<button class="map-context-action" type="button" data-map-action="choose-spawn" ' +
        (isLand ? '' : 'disabled') + '>Выбрать центр основания страны</button>';
      content += '<small>Для регистрации государства сначала выбери стартовую территорию 5×5.</small>';
    } else if (existingOrders.length) {
      content += '<div class="map-context-group"><span>ПРИКАЗЫ НА ЭТОЙ КЛЕТКЕ</span>';
      content += existingOrders.map((order) =>
        (order.status === 'confirmed' && state.turnStatus?.ordersAccepting === true
          ? '<button class="map-context-action" type="button" data-map-action="return-order-to-draft" data-order-id="' +
            escapeHtml(order.id) + '">Вернуть в черновик: ' + escapeHtml(orderTypeLabel(order.type)) + '</button>'
          : '') +
        '<button class="map-context-action map-context-remove" type="button" data-map-action="remove-order" data-order-id="' +
        escapeHtml(order.id) + '">Снять: ' + escapeHtml(orderTypeLabel(order.type)) + '</button>',
      ).join('');
      content += '</div>';
    } else if (state.turnStatus?.ordersAccepting !== true) {
      const status = state.turnStatus;
      const deadlinePassed = Boolean(status?.deadlineAt &&
        Date.now() >= new Date(status.deadlineAt).getTime());
      const waitingForSetup = status?.ordersLocked === true &&
        Number(status?.currentTurn || 1) === 1 && !status?.deadlineAt;
      const intakeMessage = waitingForSetup
        ? 'Ожидаем, пока все участники основают государства.'
        : deadlinePassed
          ? 'Срок приёма приказов истёк. Сервер автоматически закроет ход и запустит расчёт.'
          : status?.turnJobStatus === 'pending' || status?.turnJobStatus === 'processing'
            ? 'Ход уже обрабатывается.'
            : 'Приём приказов сейчас закрыт.';
      content += '<p class="map-context-note">' + intakeMessage + '</p>';
    } else if (actionsRemaining === 0 && !canFreeUpgrade) {
      content += '<p class="map-context-note">Все 3 очка действий на этот ход уже использованы.</p>';
    } else if (ownedCell) {
      const canBuild = actionsRemaining > 0 && isLand && !ownedCell.buildingType && Number(ownedCell.population) > 0;
      if (canBuild) {
        content += '<div class="map-context-group"><span>СТРОИТЕЛЬСТВО</span>';
        content += mapBuildingOptions
          .filter(([type]) => type !== 'fisher' || mapAdjacentWaterCount(cell.x, cell.y) > 0)
          .map(([type, label]) => {
            const required = scienceRequirementFor(type);
            const locked = required > currentScienceLevel();
            return '<button class="map-context-action" type="button" data-map-action="construction" data-building-type="' +
              type + '"' + (locked ? ' disabled title="Требуется ' + required + ' науки"' : '') + '>' +
              label + (locked ? ' · Наука ' + required : '') + '</button>';
          }).join('');
        content += '</div>';
      } else {
        content += '<p class="map-context-note">' +
          (ownedCell.buildingType ? 'На клетке уже стоит здание.' : isLand ? 'На клетке нет свободного жителя.' : 'На воде и реках строить нельзя.') +
          '</p>';
      }
      if (actionsRemaining > 0 && isLand && !ownedCell.structureType) {
        content += '<div class="map-context-group"><span>ЗАЩИТА КЛЕТКИ</span>';
        if (['field', 'cotton_field'].includes(ownedCell.buildingType)) {
          content += '<button class="map-context-action" type="button" data-map-action="construction" data-building-type="greenhouse">Построить теплицу</button>';
        }
        if (mapCardinalWaterCount(cell.x, cell.y) > 0) {
          const required = scienceRequirementFor('dam');
          const locked = currentScienceLevel() < required;
          content += '<button class="map-context-action" type="button" data-map-action="construction" data-building-type="dam"' +
            (locked ? ' disabled title="Требуется ' + required + ' науки"' : '') + '>' +
            (locked ? 'Дамба · Наука ' + required : 'Построить дамбу') + '</button>';
        }
        content += '</div>';
      } else if (ownedCell.structureType) {
        const structureLabel = ownedCell.structureType === 'greenhouse' ? 'теплицу' : 'дамбу';
        content += '<button class="map-context-action map-context-remove" type="button" data-map-action="structure-removal">Демонтировать ' +
          structureLabel + '</button><small>Без расхода ОД.</small>';
      }
      if (actionsRemaining > 0 && ownedCell.buildingType &&
          !['capital', 'gold_mine'].includes(ownedCell.buildingType)) {
        content += '<button class="map-context-action map-context-remove" type="button" data-map-action="demolition">Снести: ' +
          escapeHtml(buildingMeta[ownedCell.buildingType]?.label || 'здание') + '</button>';
      }
      if (!ownedCell.flooded && ownedCell.buildingType === 'field' && ownedCell.structureType !== 'greenhouse') {
        const required = scienceRequirementFor('field_level_2');
        const locked = currentScienceLevel() < required;
        content += '<div class="map-context-group"><span>УЛУЧШЕНИЕ БЕЗ ОД</span>';
        content += '<button class="map-context-action" type="button" data-map-action="construction" data-building-type="field_level_2"' +
          (locked ? ' disabled title="Требуется ' + required + ' науки"' : '') + '>' +
          (locked ? 'Поле II · Наука ' + required : 'Улучшить поле до II уровня · бесплатно') + '</button>';
        content += '</div>';
      }
      if (!ownedCell.flooded && ownedCell.buildingType === 'factory') {
        const required = scienceRequirementFor('factory_level_2');
        const locked = currentScienceLevel() < required;
        content += '<div class="map-context-group"><span>УЛУЧШЕНИЕ БЕЗ ОД</span>';
        content += '<button class="map-context-action" type="button" data-map-action="construction" data-building-type="factory_level_2"' +
          (locked ? ' disabled title="Требуется ' + required + ' науки"' : '') + '>' +
          (locked ? 'Завод II · Наука ' + required : 'Улучшить завод до II уровня · бесплатно') + '</button>';
        content += '</div>';
      }
      if (!ownedCell.flooded && ownedCell.buildingType === 'textile_workshop') {
        const required = scienceRequirementFor('textile_workshop_level_2');
        const locked = currentScienceLevel() < required;
        content += '<div class="map-context-group"><span>УЛУЧШЕНИЕ БЕЗ ОД</span>';
        content += '<button class="map-context-action" type="button" data-map-action="construction" data-building-type="textile_workshop_level_2"' +
          (locked ? ' disabled title="Требуется ' + required + ' науки"' : '') + '>' +
          (locked ? 'Мастерская II · Наука ' + required : 'Улучшить мастерскую · бесплатно') + '</button>';
        content += '</div>';
      }
      if (actionsRemaining > 0 && canColonizeRegion) {
        content += '<button class="map-context-action" type="button" data-map-action="colonization">Колонизировать район · 3×3</button>';
        content += '<small>В квадрат 3×3 войдут новые клетки суши и воды. d100 бросается для каждой новой клетки суши.</small>';
      } else {
        content += '<small>' + mapColonizationMessage(colonizationAvailability.reason) + '</small>';
      }
    } else if (canColonizeRegion) {
      content += '<button class="map-context-action" type="button" data-map-action="colonization">Колонизировать район · 3×3</button>';
      content += '<small>В квадрат 3×3 войдут новые клетки суши и воды. d100 бросается для каждой новой клетки суши.</small>';
    } else {
      content += '<p class="map-context-note">' + mapColonizationMessage(colonizationAvailability.reason) + '</p>';
    }

    if (adminMode) {
      content += '<div class="map-context-group"><span>АДМИНИСТРАТОР</span>';
      if (countryAtCell) {
        content += '<button class="map-context-action" type="button" data-map-action="admin-country-card" data-country-id="' +
          escapeHtml(countryAtCell.id) + '">Открыть карточку государства и учения</button>';
      }
      if (buildingAtCell) {
        content += '<button class="map-context-action map-context-remove" type="button" data-map-action="admin-delete-building">Удалить постройку</button>';
      }
      if (colonyAtCell) {
        content += '<button class="map-context-action map-context-remove" type="button" data-map-action="admin-delete-colony" data-territory-id="' +
          escapeHtml(colonyAtCell.id) + '">Удалить эту колонию целиком</button>';
      }
      if (!countryAtCell && !buildingAtCell && !colonyAtCell) {
        content += '<small>На этой клетке нет государства, постройки или колонии.</small>';
      }
      content += '</div>';
    }
    menu.innerHTML = content;
    menu.classList.remove('hidden');
    menu.style.left = Math.max(10, Math.min(clientX, window.innerWidth - 300)) + 'px';
    menu.style.top = Math.max(10, Math.min(clientY, window.innerHeight - 360)) + 'px';
    menu.querySelectorAll('[data-map-action]').forEach((button) => {
      button.addEventListener('click', async () => {
        const action = button.dataset.mapAction;
        if (action === 'close') {
          closeMapContextMenu();
        } else if (action === 'choose-spawn') {
          chooseSpawnCenter(cell.x, cell.y);
          closeMapContextMenu();
        } else if (action === 'construction') {
          await createMapOrder('construction', {
            x: cell.x,
            y: cell.y,
            buildingType: button.dataset.buildingType,
          });
        } else if (action === 'colonization') {
          await createMapOrder('colonization', { x: cell.x, y: cell.y });
        } else if (action === 'demolition') {
          await createMapOrder('demolition', { x: cell.x, y: cell.y });
        } else if (action === 'structure-removal') {
          await createMapOrder('structure_removal', { x: cell.x, y: cell.y });
        } else if (action === 'remove-order') {
          await removeMapOrder(button.dataset.orderId);
        } else if (action === 'return-order-to-draft') {
          await returnMapOrderToDraft(button.dataset.orderId);
        } else if (action === 'admin-country-card') {
          await loadAdminCountryCard(button.dataset.countryId);
        } else if (action === 'admin-delete-building') {
          if (window.confirm('Удалить постройку на этой клетке?')) {
            await adminDeleteBuilding(cell.x, cell.y);
          }
        } else if (action === 'admin-delete-colony') {
          if (window.confirm('Удалить всю колонию и все её клетки?')) {
            await adminDeleteColony(button.dataset.territoryId);
          }
        }
      });
    });
  }

  async function loadCampaignMap() {
    if (!state.campaign) return;
    const data = await request('/campaigns/' + state.campaign.id + '/map');
    state.mapView = data.map;
    const seasonLabel = $('#map-season-label');
    if (seasonLabel) {
      const labels = { spring: 'Весна', summer: 'Лето', autumn: 'Осень', winter: 'Зима' };
      seasonLabel.textContent = (labels[data.map.season] || 'Сезон не определён') +
        ' · год ' + (data.map.year || 1) + ' · ход сезона ' + (data.map.seasonTurn || 1) + '/6';
    }
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
      for (const cell of country.cells) {
        const px = left + cell.x * cellSize;
        const py = top + cell.y * cellSize;
        ctx.fillStyle = mapIsLand(cell.x, cell.y) ? '#ffffff' : '#0876b9';
        ctx.fillRect(px, py, cellSize, cellSize);

        ctx.strokeStyle = '#111111';
        ctx.lineWidth = miniature ? 0.45 : 0.8;
        ctx.strokeRect(px, py, cellSize, cellSize);
      }
      for (const territory of country.territories || []) {
        const minX = territory.centerX - Math.floor(territory.width / 2);
        const minY = territory.centerY - Math.floor(territory.height / 2);
        const countryLabelX = left + (minX + territory.width / 2) * cellSize;
        const countryBorderTop = top + minY * cellSize;
        ctx.strokeStyle = territory.type === 'core' ? '#050505' : '#253b55';
        ctx.lineWidth = territory.type === 'core' ? 3 : 2.2;
        ctx.setLineDash([]);
        ctx.strokeRect(
          left + minX * cellSize + 1,
          countryBorderTop + 1,
          territory.width * cellSize - 2,
          territory.height * cellSize - 2,
        );
        ctx.setLineDash([]);
        if (!miniature && territory.type === 'core') {
          ctx.fillStyle = '#101820';
          ctx.font = 'bold ' + Math.max(10, Math.min(15, cellSize)) + 'px sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(country.name, countryLabelX, Math.max(12, countryBorderTop - 4));
        }
      }
    }
    // Building symbols are rendered after country labels and borders so map text
    // can never cover occupied-cell markers.
    if (!miniature) {
      for (const country of (state.mapView.countries || [])) {
        for (const cell of country.cells || []) {
          const px = left + cell.x * cellSize;
          const py = top + cell.y * cellSize;
          if (cell.buildingType) {
            drawBuildingMapIcon(ctx, cell.buildingType, px, py, cellSize);
          }

        if (!miniature && cell.flooded) {
          const dropSize = Math.max(2.5, cellSize * 0.22);
          const dropX = px + cellSize * 0.14;
          const dropY = py + cellSize * 0.14;
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(dropX + dropSize * 0.5, dropY);
          ctx.bezierCurveTo(
            dropX + dropSize * 0.3, dropY + dropSize * 0.33,
            dropX, dropY + dropSize * 0.62,
            dropX + dropSize * 0.08, dropY + dropSize * 0.78,
          );
          ctx.bezierCurveTo(
            dropX + dropSize * 0.17, dropY + dropSize * 1.12,
            dropX + dropSize * 0.83, dropY + dropSize * 1.12,
            dropX + dropSize * 0.92, dropY + dropSize * 0.78,
          );
          ctx.bezierCurveTo(
            dropX + dropSize, dropY + dropSize * 0.62,
            dropX + dropSize * 0.7, dropY + dropSize * 0.33,
            dropX + dropSize * 0.5, dropY,
          );
          ctx.closePath();
          ctx.fillStyle = '#138bc2';
          ctx.strokeStyle = '#f3fbff';
          ctx.lineWidth = Math.max(0.55, cellSize * 0.025);
          ctx.fill();
          ctx.stroke();
          ctx.restore();
        }
          if (cell.structureType === 'greenhouse' &&
              ['field', 'cotton_field'].includes(cell.buildingType)) {
            ctx.save();
            ctx.strokeStyle = '#2a9b4a';
            ctx.lineWidth = Math.max(1.5, cellSize * 0.075);
            ctx.strokeRect(px + cellSize * 0.08, py + cellSize * 0.08,
              cellSize * 0.84, cellSize * 0.84);
            ctx.restore();
          } else if (cell.structureType === 'dam') {
            const edges = [
              { dx: 0, dy: -1, x1: px, y1: py, x2: px + cellSize, y2: py },
              { dx: 1, dy: 0, x1: px + cellSize, y1: py, x2: px + cellSize, y2: py + cellSize },
              { dx: 0, dy: 1, x1: px, y1: py + cellSize, x2: px + cellSize, y2: py + cellSize },
              { dx: -1, dy: 0, x1: px, y1: py, x2: px, y2: py + cellSize },
            ];
            ctx.save();
            ctx.strokeStyle = '#147ec1';
            ctx.lineWidth = Math.max(2, cellSize * 0.11);
            ctx.lineCap = 'round';
            ctx.beginPath();
            for (const edge of edges) {
              if (!mapIsLand(cell.x + edge.dx, cell.y + edge.dy)) {
                ctx.moveTo(edge.x1, edge.y1);
                ctx.lineTo(edge.x2, edge.y2);
              }
            }
            ctx.stroke();
            ctx.restore();
          }
        }
      }
      for (const order of state.mapOrders || []) {
        const point = mapOrderCoordinates(order);
        if (!point || point.x < 0 || point.y < 0 || point.x >= width || point.y >= height) continue;
        if (order.type === 'colonization') {
          const region = mapColonizationRegion(point.x, point.y);
          if (!region) continue;
          const regionLeft = left + (point.x - 1) * cellSize;
          const regionTop = top + (point.y - 1) * cellSize;
          const regionSize = cellSize * 3;
          const confirmed = order.status === 'confirmed';
          ctx.save();
          ctx.fillStyle = confirmed ? 'rgba(241, 211, 124, 0.08)' : 'rgba(241, 155, 104, 0.08)';
          ctx.strokeStyle = confirmed ? 'rgba(241, 211, 124, 0.82)' : 'rgba(241, 155, 104, 0.82)';
          ctx.lineWidth = Math.max(1.5, cellSize * 0.12);
          ctx.setLineDash(confirmed ? [] : [Math.max(2, cellSize * 0.35), Math.max(1, cellSize * 0.16)]);
          ctx.fillRect(regionLeft, regionTop, regionSize, regionSize);
          ctx.strokeRect(regionLeft + 1, regionTop + 1, regionSize - 2, regionSize - 2);
          ctx.restore();
          continue;
        }
        if (order.type !== 'construction' && order.type !== 'demolition') continue;
        const buildingType = order.payload?.buildingType;
        const px = left + point.x * cellSize;
        const py = top + point.y * cellSize;
        ctx.save();
        ctx.globalAlpha = order.status === 'confirmed' ? 0.58 : 0.34;
        if (order.type === 'demolition') {
          const target = (state.mapView.countries || [])
            .flatMap((item) => item.cells || [])
            .find((item) => item.x === point.x && item.y === point.y);
          if (target?.buildingType) drawBuildingMapIcon(ctx, target.buildingType, px, py, cellSize);
          ctx.strokeStyle = '#c0392b';
          ctx.lineWidth = Math.max(1.5, cellSize * 0.1);
          ctx.setLineDash([Math.max(2, cellSize * 0.2), Math.max(1, cellSize * 0.12)]);
          ctx.strokeRect(px + cellSize * 0.12, py + cellSize * 0.12, cellSize * 0.76, cellSize * 0.76);
        } else if (buildingMeta[buildingType]) {
          drawBuildingMapIcon(ctx, buildingType, px, py, cellSize);
        }
        ctx.restore();
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
    $('#map-selection-label').textContent = isAdminMode() && !state.campaign.countryId
      ? 'Административный просмотр: ПКМ по клетке — карточка государства или инструменты управления.'
      : state.campaign.countryId
        ? 'Зажми ЛКМ для перемещения. ПКМ по клетке — строительство, колонизация или действия администратора.'
        : existingReservation
          ? 'Твоя точка старта зарезервирована: ' + existingReservation.centerX + ', ' + existingReservation.centerY + '. Можно выбрать другое место.'
          : 'Зажми ЛКМ для перемещения. Выбери сушу — будет показана территория 5×5.';
    $('#confirm-spawn').classList.toggle('hidden', Boolean(state.campaign.countryId) || isAdminMode());
    $('#confirm-map-orders').classList.toggle('hidden', !state.campaign.countryId);
    closeMapContextMenu();
    $('#map-modal').classList.remove('hidden');
    Promise.all([
      loadCampaignMap(),
      state.campaign.countryId ? loadMapOrders() : Promise.resolve(),
    ]).then(() => {
      const reservation = (state.mapView?.reservations || []).find((item) => item.isMine);
      if (reservation && !state.mapSelectedCenter) {
        state.mapSelectedCenter = { x: reservation.centerX, y: reservation.centerY };
        $('#confirm-spawn').disabled = false;
      }
      renderMapOrderSummary();
      requestAnimationFrame(() => drawMapCanvas($('#map-canvas'), false));
    }).catch((error) => showToast(userErrorMessage(error), true));
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
      showToast(userErrorMessage(error), true);
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
    if (tab === 'turn') loadTurnRoom();
    if (tab === 'country') {
      resetTerritoryGrid();
      refreshAvailableSystems().catch((error) => setMessage('#country-message', userErrorMessage(error)));
    }
    if (tab === 'admin') loadPending();
  }

  async function loadSystems() {
    if (!state.campaign) return;
    try {
      const [campaignData, libraryData] = await Promise.all([
        request(`/campaigns/${state.campaign.id}/social-systems/mine`),
        request('/social-systems/mine'),
      ]);
      state.systems = campaignData.systems || [];
      state.librarySystems = libraryData.systems || [];
      renderSystems();
      $('#system-count').textContent = String(state.systems.length);
      $('#country-status').textContent = state.campaign.countryId
        ? 'Основано' : (state.systems.length ? 'Готово к основанию' : 'Не основано');
    } catch (error) { setMessage('#system-message', userErrorMessage(error)); }
  }

  function renderSystems() {
    const host = $('#systems-list');
    if (!state.librarySystems.length) {
      host.innerHTML = '<div class="empty-state compact">Личная библиотека пока пуста. Создай первое учение — оно сохранится и будет доступно в других кампаниях.</div>';
      return;
    }
    const currentNames = new Set(state.systems.map((item) => String(item.name).trim().toLocaleLowerCase()));
    host.innerHTML = state.librarySystems.map((system) => {
      const principles = (system.principles || []).map((item) =>
        `<li><strong>${escapeHtml(item.name)}</strong><span>${escapeHtml(item.description)}</span></li>`).join('');
      const exists = currentNames.has(String(system.name).trim().toLocaleLowerCase());
      return `<article class="system-card library-system-card">
        <div class="system-card-top">
          <div><span class="system-type">${system.type === 'religion' ? 'РЕЛИГИЯ' : 'ИДЕОЛОГИЯ'}</span><h3>${escapeHtml(system.name)}</h3></div>
          ${system.emblemDataUrl ? `<img class="system-emblem-thumb" src="${escapeHtml(system.emblemDataUrl)}" alt="">` : ''}
        </div>
        <ul class="principle-summary library-principles">${principles || '<li>Принципы не заданы</li>'}</ul>
        <div class="library-system-meta">${exists ? 'Уже добавлено в эту кампанию' : 'Личная библиотека игрока'}</div>
        <div class="library-system-actions">
          <button class="button button-outline load-system" data-id="${escapeHtml(system.id)}" type="button" ${state.campaign.countryId ? 'disabled' : ''}>Загрузить в редактор</button>
          <button class="button button-primary add-system" data-id="${escapeHtml(system.id)}" type="button" ${state.campaign.countryId ? 'disabled' : ''}>${exists ? 'Перезаписать в кампании' : 'Добавить в кампанию'}</button>
        </div>
      </article>`;
    }).join('');
    $$('.load-system', host).forEach((button) => button.addEventListener('click', () => {
      const system = state.librarySystems.find((item) => item.id === button.dataset.id);
      if (system) loadSystemIntoEditor(system);
    }));
    $$('.add-system', host).forEach((button) => button.addEventListener('click', () => {
      const system = state.librarySystems.find((item) => item.id === button.dataset.id);
      if (system) addSystemToCampaign(system);
    }));
  }

  function loadSystemIntoEditor(system) {
    $('#system-type').value = system.type;
    $('#system-name').value = system.name;
    $('#system-emblem').value = '';
    state.loadedSystemEmblemDataUrl = system.emblemDataUrl || null;
    renderPrincipleCatalog();
    (system.principles || []).forEach((principle) => {
      let input = $$('.principle-check').find((item) => item.dataset.name === principle.name);
      if (!input) {
        const column = $('#principles-list').querySelector('.principle-column.' + principle.polarity);
        if (!column) return;
        const label = document.createElement('label');
        label.className = 'principle-option';
        label.innerHTML = '<input class="principle-check" type="checkbox" data-polarity="' +
          escapeHtml(principle.polarity) + '" data-name="' + escapeHtml(principle.name) +
          '" data-description="' + escapeHtml(principle.description) + '" data-effect="' +
          escapeHtml(principle.effect || '') + '"><span><strong>' + escapeHtml(principle.name) +
          '</strong><small>' + escapeHtml(principle.effect || principle.description) + '</small></span>';
        column.append(label);
        input = $('.principle-check', label);
        input.addEventListener('change', updatePrincipleBalance);
      }
      input.checked = true;
    });
    updatePrincipleBalance();
    setMessage('#system-message', 'Система загружена в редактор. Измени её или сохрани без изменений.', true);
    $('#system-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function addSystemToCampaign(system) {
    try {
      await request('/campaigns/' + state.campaign.id + '/social-systems', {
        method: 'POST',
        body: JSON.stringify({
          type: system.type, name: system.name, principles: system.principles,
          emblemDataUrl: system.emblemDataUrl,
        }),
      });
      await loadSystems();
      $('#official-system-type').value = system.type;
      updateBuildingChoices();
      await refreshAvailableSystems();
      showToast('Система добавлена в текущую кампанию без изменений.');
    } catch (error) { showToast(userErrorMessage(error), true); }
  }

  function resetFoundedPanels() {
    $('#systems-tab-label').textContent = 'Вера и идеология';
    $('#country-tab-label').textContent = 'Основание страны';
    $('#systems-intro').classList.remove('hidden');
    $('#systems-builder').classList.remove('hidden');
    $('#faith-card-host').classList.add('hidden');
    $('#country-intro').classList.remove('hidden');
    $('#country-builder').classList.remove('hidden');
    $('#country-card-host').classList.add('hidden');
    state.mapOrders = [];
    closeMapContextMenu();
  }

  async function loadCountryProfile() {
    if (!state.campaign || !state.campaign.countryId) return;
    try {
      const data = await request('/campaigns/' + state.campaign.id + '/countries/mine');
      state.countryProfile = data.country || null;
      if (state.countryProfile) renderFoundedCards(state.countryProfile);
    } catch (error) { showToast('Не удалось загрузить карточку государства: ' + userErrorMessage(error), true); }
  }

  function formatTurnDate(value) {
    if (!value) return 'Не назначен';
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return '—';
    return new Intl.DateTimeFormat('ru-RU', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  }

  function turnJobLabel(status) {
    const labels = {
      pending: 'В очереди',
      processing: 'Выполняется',
      completed: 'Завершён',
      failed: 'Ошибка обработки',
    };
    return status ? (labels[status] || 'Неизвестное состояние') : 'Не запускался';
  }

  function orderTypeLabel(type) {
    const labels = {
      construction: 'Строительство',
      demolition: 'Снос здания',
      structure_removal: 'Демонтаж мини-сооружения',
      colonization: 'Колонизация',
      movement: 'Перемещение',
      research: 'Исследование',
      diplomacy: 'Дипломатия',
      battle: 'Боевой приказ',
    };
    return labels[type] || type || 'Приказ';
  }

  function renderTurnRoom() {
    const statusHost = $('#turn-status-content');
    const resultsHost = $('#order-results-list');
    const resultsTotal = $('#order-results-total');
    const refreshButton = $('#refresh-turn-room');
    if (!statusHost || !resultsHost || !resultsTotal) return;
    if (refreshButton) refreshButton.disabled = state.turnRoomLoading;

    const status = state.turnStatus;
    renderMapOrderSummary();
    if (status) {
      const turnLabel = String(status.currentTurn).padStart(2, '0');
      const headerStatus = status.status === 'completed'
        ? 'ЗАВЕРШЕНО'
        : (status.turnJobStatus === 'processing'
          ? 'ХОД ОБРАБАТЫВАЕТСЯ'
          : (status.ordersAccepting ? 'ПРИЁМ ОТКРЫТ' : 'ПРИЁМ ЗАКРЫТ'));
      $('#workspace-turn-label').textContent = headerStatus;
      $('#workspace-turn-number').textContent = 'ХОД ' + turnLabel;
      $('#world-status-value').textContent = status.status === 'completed'
        ? 'Завершена'
        : (status.turnJobStatus === 'processing'
          ? 'Обработка'
          : (status.ordersAccepting ? 'Приём приказов' : 'Ожидание'));
      $('#world-turn-value').textContent = turnLabel;
    }
    if (state.turnRoomLoading && !status) {
      statusHost.innerHTML = '<div class="turn-empty"><span class="turn-loading-mark">↻</span><strong>Сверяем состояние мира…</strong><p>Получаем текущий ход и личный статус приказов.</p></div>';
    } else if (state.turnRoomError) {
      statusHost.innerHTML = '<div class="turn-empty turn-empty-error"><strong>Не удалось загрузить состояние хода</strong><p>' + escapeHtml(state.turnRoomError) + '</p></div>';
    } else if (!status) {
      statusHost.innerHTML = '<div class="turn-empty"><strong>Состояние хода пока недоступно</strong><p>Обнови данные, чтобы повторить запрос.</p></div>';
    } else {
      const campaignState = status.status === 'completed'
        ? { label: 'Кампания завершена', tone: 'complete' }
        : { label: 'Кампания активна', tone: 'active' };
      const intakeState = status.ordersAccepting
        ? { label: 'Приём приказов открыт', tone: 'open' }
        : { label: status.ordersLocked ? 'Приём приказов закрыт' : 'Приём приказов приостановлен', tone: 'closed' };
      const ownConfirmation = !status.countryId
        ? 'Государство не основано'
        : (status.ordersConfirmed ? 'Приказы подтверждены' : 'Ожидает подтверждения');
      const turnLabel = String(status.currentTurn).padStart(2, '0');
      statusHost.innerHTML = `
        <div class="turn-status-hero">
          <div class="turn-status-topline">
            <span class="turn-overline">ТЕКУЩИЙ ЦИКЛ</span>
            <span class="turn-state-pill ${campaignState.tone}">${campaignState.label}</span>
          </div>
          <div class="turn-number">ХОД <strong>${escapeHtml(turnLabel)}</strong></div>
          <p>${intakeState.label}. Длительность цикла — ${escapeHtml(status.turnDurationHours)} ч.</p>
          <div class="turn-status-foot">
            <span class="turn-state-pill ${intakeState.tone}">${intakeState.label}</span>
            <span class="turn-state-pill ${status.ordersConfirmed ? 'confirmed' : 'waiting'}">${escapeHtml(ownConfirmation)}</span>
          </div>
        </div>
        <div class="turn-metric-grid">
          <div class="turn-metric"><span>ДЕДЛАЙН</span><strong>${escapeHtml(formatTurnDate(status.deadlineAt))}</strong></div>
          <div class="turn-metric"><span>ОБРАБОТКА ХОДА</span><strong>${escapeHtml(turnJobLabel(status.turnJobStatus))}</strong></div>
          <div class="turn-metric"><span>ВЕРСИЯ СНИМКА</span><strong>${status.snapshotVersion === null ? '—' : escapeHtml(status.snapshotVersion)}</strong></div>
          <div class="turn-metric"><span>ПРОДОЛЖИТЕЛЬНОСТЬ</span><strong>${escapeHtml(status.turnDurationHours)} ч</strong></div>
        </div>`;
    }

    if (!status?.countryId) {
      resultsTotal.textContent = '—';
      resultsHost.innerHTML = '<div class="turn-empty"><strong>Летопись пока пуста</strong><p>Личные исходы появятся после основания государства и завершения первых приказов.</p></div>';
      return;
    }
    if (state.orderResultsError) {
      resultsTotal.textContent = 'Ошибка';
      resultsHost.innerHTML = '<div class="turn-empty turn-empty-error"><strong>Не удалось загрузить летопись</strong><p>' + escapeHtml(state.orderResultsError) + '</p></div>';
      return;
    }
    const results = state.orderResults;
    resultsTotal.textContent = String(results.length);
    if (!results.length) {
      resultsHost.innerHTML = '<div class="turn-empty"><strong>Записей пока нет</strong><p>После обработки приказов здесь появятся их исходы. Содержимое самих приказов и скрытые данные не показываются.</p></div>';
      return;
    }

    const resolutionLabels = { accepted: 'Принят', rejected: 'Отклонён', superseded: 'Заменён' };
    resultsHost.innerHTML = results.map((result) => {
      const tone = result.resolutionStatus === 'accepted' ? 'accepted'
        : result.resolutionStatus === 'rejected' ? 'rejected' : 'superseded';
      const resolutionLabel = resolutionLabels[result.resolutionStatus] || result.resolutionStatus;
      const terminalLabel = result.status === 'discarded' ? 'Снят' : 'Завершён';
      return `
        <article class="order-result-row">
          <div class="order-result-main">
            <strong>${escapeHtml(orderTypeLabel(result.type))}</strong>
            <small>Ход ${escapeHtml(result.turnNumber)} · схема v${escapeHtml(result.schemaVersion)} · ${terminalLabel}</small>
          </div>
          <div class="order-result-outcome">
            <span class="result-state-pill ${tone}">${escapeHtml(resolutionLabel)}</span>
            <code>${escapeHtml(result.resultCode || '—')}</code>
            <time>${escapeHtml(formatTurnDate(result.finalizedAt))}</time>
          </div>
        </article>`;
    }).join('');
  }

  async function loadTurnRoom() {
    if (!state.campaign) return;
    const campaignId = state.campaign.id;
    state.turnRoomLoading = true;
    state.turnRoomError = '';
    state.orderResultsError = '';
    renderTurnRoom();
    try {
      const turnData = await request('/campaigns/' + campaignId + '/turn');
      if (state.campaign?.id !== campaignId) return;
      state.turnStatus = turnData.turn || null;
      if (state.turnStatus?.countryId) {
        try {
          const resultsData = await request('/campaigns/' + campaignId + '/orders/results');
          if (state.campaign?.id !== campaignId) return;
          state.orderResults = Array.isArray(resultsData.results) ? resultsData.results : [];
        } catch (error) {
          state.orderResults = [];
          state.orderResultsError = userErrorMessage(error) || 'Неизвестная ошибка';
        }
      } else {
        state.orderResults = [];
      }
    } catch (error) {
      if (state.campaign?.id !== campaignId) return;
      state.turnStatus = null;
      state.orderResults = [];
      state.turnRoomError = userErrorMessage(error) || 'Неизвестная ошибка';
    } finally {
      if (state.campaign?.id === campaignId) {
        state.turnRoomLoading = false;
        renderTurnRoom();
      }
    }
  }

  const cultureInfo={
    militaristic:['Милитаристская','Военная сила и защита имеют высокий престиж. Влияет на отношение к войне.','<path d="M8 8 32 32M32 8 8 32M5 4l9 9M26 27l8 8"/>'],
    pacifist:['Пацифистская','Предпочтение мирного урегулирования конфликтов.','<path d="M5 22c6-12 17-14 29-9-2 9-10 15-20 15-4 0-7-2-9-6ZM14 20 10 9l10 6"/>'],
    xenophobic:['Ксенофобная','Недоверие к иностранцам и чужим обычаям.','<path d="M20 4 34 10v10c0 8-6 13-14 16C12 33 6 28 6 20V10Z"/>'],
    xenophilic:['Ксенофильная','Открытость к иностранцам, контактам и культурному обмену.','<path d="M4 18h8l5-5 5 4h8l4 5-8 7H15l-7-6H4Z"/>'],
    hierarchical:['Иерархическая','Ранги, статусы и вертикаль власти — основа общественного порядка.','<path d="M5 9h30M9 18h22M13 27h14M17 35h6"/>'],
    egalitarian:['Эгалитарная','Равенство граждан и неприятие наследственных привилегий.','<path d="M20 5v29M8 11h24M10 11 4 23h12ZM30 11l-6 12h12Z"/>'],
    spiritual:['Духовная','Вера, ритуалы и духовные авторитеты влияют на общественные нормы.','<circle cx="20" cy="20" r="8"/><path d="M20 3v5M20 32v5M3 20h5M32 20h5M8 8l4 4M28 28l4 4"/>'],
    rationalist:['Рационалистическая','Престиж науки, аргументации и проверяемых знаний.','<path d="M14 5h12M17 5v10L8 31q-2 4 3 4h18q5 0 3-4l-9-16V5M12 27h16"/>'],
    collectivist:['Коллективистская','Интересы общины и общие цели выше личных.','<circle cx="12" cy="13" r="5"/><circle cx="28" cy="13" r="5"/><path d="M3 34v-6c0-5 4-8 9-8s9 3 9 8v6M19 34v-6c0-5 4-8 9-8s9 3 9 8v6"/>'],
    individualistic:['Индивидуалистическая','Личная автономия и собственный выбор имеют высокий приоритет.','<circle cx="20" cy="11" r="7"/><path d="M7 35v-5c0-8 5-13 13-13s13 5 13 13v5Z"/>'],
    expansionist:['Экспансионистская','Положительное отношение к расширению территории и влияния.','<path d="M4 20h28M23 11l9 9-9 9M20 4v8M20 28v8"/>'],
    isolationist:['Изоляционистская','Предпочтение закрытости и защиты собственных границ.','<path d="M8 5h24v30H8Z"/><path d="M14 12h12M20 12v23M14 22h12"/>']
  };
  const governmentLabels={monarchy:'Монархия',democracy:'Демократия',oligarchy:'Олигархия',dictatorship:'Диктатура',technocracy:'Технократия',ideocracy:'Идеократия',theocracy:'Теократия',fascism:'Фашизм'};
  function cultureSymbols(values){
    if(!values?.length)return '<span class="country-culture-empty">Культура не задана</span>';
    return values.map((key)=>{const v=cultureInfo[key];if(!v)return '';const tip=v[0]+'\nЭффект: '+v[1];return '<button type="button" class="culture-symbol" data-tooltip="'+escapeHtml(tip)+'" title="'+escapeHtml(tip)+'" aria-label="'+escapeHtml(tip)+'"><svg viewBox="0 0 40 40" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">'+v[2]+'</svg></button>';}).join('');
  }
  function estimateCountryEconomy(country) {
    const mapCountry = state.mapView?.countries?.find((item) => item.id === country.id);
    const cells = mapCountry?.cells || [];
    const turnNumber = Math.max(1, Number(state.mapView?.turnNumber || state.turnStatus?.currentTurn || 1));
    const seasonNames = ['spring', 'summer', 'autumn', 'winter'];
    const season = state.mapView?.season || seasonNames[Math.floor(((turnNumber - 1) % 24) / 6)];
    const year = Number(state.mapView?.year || Math.floor((turnNumber - 1) / 24) + 1);
    const seasonTurn = Number(state.mapView?.seasonTurn || ((turnNumber - 1) % 6) + 1);
    const population = cells.length
      ? cells.filter((cell) => !cell.buildingType).length
      : Number(country.residentCount || 0);
    const active = (cell) => cell.flooded !== true || cell.buildingType === 'rice_field';
    const factories = cells.filter((cell) =>
      ['factory', 'factory_level_2'].includes(cell.buildingType));
    const gold = cells.filter((cell) => cell.buildingType === 'gold_mine' && cell.flooded !== true).length;
    const buildingUpkeep = cells.reduce((sum, cell) => {
      if (!cell.buildingType) return sum;
      if (cell.buildingType === 'tower' || cell.buildingType === 'field_level_2' ||
          cell.buildingType === 'factory_level_2') return sum + 2;
      if (cell.buildingType === 'textile_workshop_level_2') return sum + 3;
      return sum + 1;
    }, 0);
    const structureUpkeep = cells.filter((cell) => cell.structureType).length;
    const floodSurcharge = cells.filter((cell) => cell.flooded && cell.buildingType !== 'rice_field').length;
    const expenses = buildingUpkeep + structureUpkeep + floodSurcharge;
    const income = gold * population;
    let food = 0;
    for (const cell of cells) {
      if (!cell.buildingType || !active(cell)) continue;
      const factoryNearby = factories.some((factory) =>
        Math.abs(factory.x - cell.x) <= 1 && Math.abs(factory.y - cell.y) <= 1);
      let output = 0;
      if (cell.buildingType === 'field' || cell.buildingType === 'field_level_2') {
        if (season === 'winter' &&
            !(cell.buildingType === 'field' && cell.structureType === 'greenhouse')) continue;
        output = cell.buildingType === 'field_level_2' ? 15 : 10;
        if (factoryNearby) output /= 2;
      } else if (cell.buildingType === 'rice_field') {
        if (season === 'winter') continue;
        output = cell.flooded ? 15 : mapAdjacentWaterCount(cell.x, cell.y) > 0 ? 10 : 5;
        if (factoryNearby) output /= 2;
      } else if (cell.buildingType === 'hunter') {
        output = season === 'spring' ? 15 : 5;
      } else if (cell.buildingType === 'fisher') {
        output = mapAdjacentWaterCount(cell.x, cell.y) * (season === 'spring' ? 10 : 5);
      }
      food += output;
    }
    const goods = factories.filter(active).reduce(
      (sum, cell) => sum + (cell.buildingType === 'factory_level_2' ? 15 : 10),
      0,
    );
    const activeCotton = cells.filter((cell) =>
      cell.buildingType === 'cotton_field' && active(cell) &&
      (season !== 'winter' || cell.structureType === 'greenhouse')).length;
    let cottonSlots = season === 'winter' ? activeCotton : 0;
    let clothing = 0;
    const workshops = cells.filter((cell) =>
      ['textile_workshop', 'textile_workshop_level_2'].includes(cell.buildingType) && active(cell));
    for (const workshop of workshops) {
      if (cottonSlots < 1) continue;
      cottonSlots -= 1;
      clothing += workshop.buildingType === 'textile_workshop_level_2' ? 20 : 10;
    }
    const floodedCells = cells.filter((cell) => cell.flooded).length;
    return {
      turnNumber, season, year, seasonTurn,
      movementMultiplier: season === 'winter' ? 0.5 : 1,
      population, gold, income, initialBuildingUpkeep: expenses, buildingUpkeep: expenses,
      unitCount: 0, unitUpkeep: 0, budgetDeficit: income < expenses,
      unitMovementAllowed: income >= expenses, expenses,
      unpaidExpenses: Math.max(0, expenses - income), disabledBuildings: [],
      food, foodDemand: population, foodShortage: food < population,
      goods, goodsDemand: population, goodsShortage: goods < population,
      clothing, clothingDemand: season === 'winter' ? population : 0,
      clothingShortage: season === 'winter' && clothing < population,
      unclothedPopulation: season === 'winter' ? Math.max(0, population - clothing) : 0,
      cottonFields: activeCotton, textileWorkshops: workshops.length, floodedCells,
      starvedColonies: 0, fledColonies: 0,
    };
  }

  function renderFoundedCards(country) {
    const faithType = country.officialSystem.type;
    const system = country.officialSystem;
    $('#systems-tab-label').textContent = faithType === 'religion' ? 'Вера' : 'Идеология';
    $('#country-tab-label').textContent = 'Страна';
    $('#systems-intro').classList.add('hidden');
    $('#systems-builder').classList.add('hidden');
    $('#faith-card-host').classList.remove('hidden');
    $('#country-intro').classList.add('hidden');
    $('#country-builder').classList.add('hidden');
    $('#country-card-host').classList.remove('hidden');

    const counts = new Map((country.buildings || []).map((item) => [item.type, item.count]));
    const economy = estimateCountryEconomy(country);
    const reportedEconomy = country.economy || null;
    if (reportedEconomy) {
      economy.disabledBuildings = reportedEconomy.disabledBuildings || [];
      economy.starvedColonies = reportedEconomy.starvedColonies || 0;
      economy.fledColonies = reportedEconomy.fledColonies || 0;
    }
    const economyIncome = String(economy.income);
    const economyExpenses = String(economy.expenses);
    const economyNet = economy.income - economy.expenses;
    const economyStatus = economyNet >= 0
      ? 'Положительный баланс за ход'
      : 'Расходы превышают прибавку';
    const disabledBuildingsLabel = economy?.disabledBuildings?.map((building) =>
      (buildingMeta[building.type]?.label || building.type) + ' (' + building.x + ', ' + building.y + ')',
    ).join(', ') || '';
    const seasonLabels = { spring: 'Весна', summer: 'Лето', autumn: 'Осень', winter: 'Зима' };
    const seasonLabel = seasonLabels[economy.season] || economy.season || '—';
    const populationForCard = economy.population ?? country.residentCount ?? 0;
    const scienceLevel = state.mapView?.countries?.find((item) => item.id === country.id)
      ?.cells.filter((cell) => cell.buildingType === 'science').length ??
      Number(counts.get('science') || 0);
    const principleRows = (system.principles || []).map((principle) =>
      '<li><strong>' + escapeHtml(principle.name) + '</strong>' +
      '<span class="principle-description">' + escapeHtml(principle.description) + '</span>' +
      '<small class="principle-effect">Эффект: ' +
        escapeHtml(principle.effect || 'Игровой эффект не указан.') + '</small>' +
      '<small class="principle-polarity">' +
        (principle.polarity === 'positive' ? 'Положительное' :
          principle.polarity === 'negative' ? 'Отрицательное' : 'Нейтральное') +
      '</small></li>'
    ).join('');
    const faithMetrics = faithType === 'religion'
      ? [['♟', 'Последователи', '—'], ['★', 'Святые места', '—'], ['⌂', 'Храмы', String(counts.get('religious_building') || 0)]]
      : [['♟', 'Последователи', '—'], ['▥', 'Крылья', '—'], ['⌂', 'Центры', '—']];

    $('#faith-card-host').innerHTML =
      '<article class="archive-card faith-doc-card">' +
        '<header class="faith-doc-header">' +
          '<div class="faith-doc-title-block"><div class="archive-card-kicker">' +
            (faithType === 'religion' ? 'ОФИЦИАЛЬНАЯ РЕЛИГИЯ ГОСУДАРСТВА' : 'ГОСУДАРСТВЕННАЯ ИДЕОЛОГИЯ') +
          '</div><h2>' + escapeHtml(system.name) + '</h2></div>' +
          (system.emblemDataUrl
            ? '<img class="faith-doc-emblem" src="' + escapeHtml(system.emblemDataUrl) + '" alt="Символ учения">'
            : '<div class="faith-doc-emblem faith-doc-emblem-placeholder">✦</div>') +
        '</header>' +
        '<div class="faith-doc-content">' +
          '<section class="faith-doc-beliefs"><h3>' +
            (faithType === 'religion' ? 'Верования' : 'Принципы') +
          '</h3><ul>' + (principleRows || '<li><strong>Нет записей</strong><span>Для этой системы ещё не добавлены пункты.</span></li>') + '</ul></section>' +
          '<aside class="faith-doc-authority"><h3>Авторитет</h3>' +
            '<div class="authority-levels">' +
              '<div><span>Величие</span><i class="authority-greatness"></i></div>' +
              '<div><span>Понимание</span><i class="authority-understanding"></i></div>' +
              '<div><span>Безразличие</span><i class="authority-indifference"></i></div>' +
              '<div><span>Избегание</span><i class="authority-avoidance"></i></div>' +
            '</div><small>Значения появятся после запуска соответствующих расчётов симуляции.</small>' +
          '</aside>' +
        '</div>' +
        '<div class="faith-doc-metrics">' +
          faithMetrics.map((metric) =>
            '<div class="faith-doc-metric"><b>' + metric[0] + '</b><span>' + metric[1] +
            '</span><strong>' + escapeHtml(metric[2]) + '</strong></div>'
          ).join('') +
        '</div>' +
        '<section class="faith-doc-notes"><h3>Заметки</h3><p>Заметки системы пока не заполнены.</p></section>' +
        '<footer class="country-doc-footer">Карточка официальной системы · ' +
          (faithType === 'religion' ? 'Религия' : 'Идеология') +
        '</footer>' +
      '</article>';

    const countryStats = [
      ['♟', 'Люди', String(populationForCard)],
      ['⚛', 'Наука', String(scienceLevel)],
      ['♜', 'Замки и башни', String((counts.get('tower') || 0) + (counts.get('barracks') || 0))],
      ['♛', 'Правитель', 'Не назначен'],
    ];
    $('#country-card-host').innerHTML =
      '<article class="archive-card country-doc-card">' +
        '<header class="country-doc-header">' +
          '<div class="country-doc-title"><div class="archive-card-kicker">КАРТОЧКА ГОСУДАРСТВА</div>' +
            '<h2>' + escapeHtml(country.name) + '</h2><i></i></div>' +
          (country.flagDataUrl
            ? '<img class="country-doc-flag" src="' + escapeHtml(country.flagDataUrl) + '" alt="Флаг государства">'
            : '<div class="country-doc-flag country-doc-flag-placeholder">ФЛАГ</div>') +
        '</header>' +
        '<div class="country-doc-top-stats">' +
          countryStats.map((item) =>
            '<div class="country-doc-top-stat"><b>' + item[0] + '</b><span>' + item[1] +
            '</span><strong>' + escapeHtml(item[2]) + '</strong></div>'
          ).join('') +
        '</div>' +
        '<div class="country-doc-middle">' +
          '<section class="country-doc-military"><h3>Военные ресурсы</h3>' +
            '<div><b>⚔</b><span>—</span><span>—</span></div>' +
            '<small>Ресурсы армии пока не рассчитываются симуляцией.</small>' +
          '</section>' +
          '<section class="country-doc-notes"><h3>Заметки государства</h3><p>Заметки пока не добавлены.</p></section>' +
        '</div>' +
        '<h3 class="country-doc-section-title">СЕЗОН И ПОГОДА</h3>' +
        '<div class="country-doc-economy">' +
          '<div><b class="country-doc-income">☀</b><span>Текущий сезон</span><strong>' +
            escapeHtml(seasonLabel) + '</strong><small>' +
            'Год ' + String(economy.year || 1) + ' · ход ' + String(economy.seasonTurn || 1) + '/6' +
          '</small></div>' +
          '<div><b class="country-doc-income">❄</b><span>Тёплая одежда</span><strong>' +
            (economy.season === 'winter' ? String(economy.clothing || 0) + ' / ' + String(economy.clothingDemand || economy.population) : 'Не требуется') +
          '</strong><small>' +
            (economy.season === 'winter'
              ? (economy.clothingShortage ? 'Не хватает одежды для ' + String(economy.unclothedPopulation || 0) + ' жителей' : 'Все жители обеспечены')
              : 'Одежда не накапливается') +
          '</small></div>' +
          '<div><b class="country-doc-income">≈</b><span>Затопленные клетки</span><strong>' +
            String(economy.floodedCells || 0) + '</strong><small>' +
            (economy.movementMultiplier === 0.5 ? 'Зимой скорость войск ×0,5' : 'Обычная скорость передвижения') +
          '</small></div>' +
        '</div>' +
        '<h3 class="country-doc-section-title">ЭКОНОМИКА</h3>' +
        '<div class="country-doc-economy country-doc-finance">' +
          '<div><b class="country-doc-income">↗</b><span>Прибавка</span><strong>+' +
            escapeHtml(economyIncome) + '</strong><small>Золото за ход</small></div>' +
          '<div><b class="country-doc-gold">−</b><span>Расход</span><strong>' +
            escapeHtml(economyExpenses) + '</strong><small>Содержание зданий и сооружений</small></div>' +
          '<div><b class="country-doc-income">Σ</b><span>Итого</span><strong>' +
            (economyNet >= 0 ? '+' : '−') + escapeHtml(String(Math.abs(economyNet))) +
            '</strong><small>' + escapeHtml(economyStatus) + '</small></div>' +
        '</div>' +
        '<h3 class="country-doc-section-title">ПОЛИТИКА</h3>' +
        '<div class="country-doc-government"><b>♜</b><span>' +
          escapeHtml(governmentLabels[country.government] || country.government) +
        '</span></div>' +
        '<div class="country-doc-bottom">' +
          '<section><b class="country-doc-tile-icon">▥</b><strong>Товары</strong><span>' +
            String((counts.get('factory') || 0) + (counts.get('factory_level_2') || 0)) + ' завода</span><small>' +
            String(economy.goods) + ' из ' + String(economy.goodsDemand) + ' жителей · ' +
              (economy.goodsShortage ? 'дефицит' : 'достаточно') + '</small></section>' +
          '<section><b class="country-doc-tile-icon">⌂</b><strong>Продовольствие</strong><span>' +
            String((counts.get('field') || 0) + (counts.get('field_level_2') || 0) + (counts.get('rice_field') || 0)) + ' поля</span><small>' +
            String(economy.food) + ' из ' + String(economy.foodDemand) + ' жителей · ' +
              (economy.foodShortage ? 'дефицит' : 'достаточно') + '</small></section>' +
          '<section><b class="country-doc-tile-icon">♧</b><strong>Тёплая одежда</strong><span>' +
            String((counts.get('textile_workshop') || 0) + (counts.get('textile_workshop_level_2') || 0)) + ' мастерских · ' +
            String(counts.get('cotton_field') || 0) + ' хлопковых полей</span><small>' +
            (economy.season === 'winter'
              ? String(economy.clothing || 0) + ' из ' + String(economy.clothingDemand || economy.population) + ' жителей · ' +
                (economy.clothingShortage ? 'не хватает ' + String(economy.unclothedPopulation || 0) : 'достаточно')
              : 'Производство не накапливается; спрос зимой') + '</small></section>' +
          '<section class="country-doc-faith">' +
            (system.emblemDataUrl
              ? '<img src="' + escapeHtml(system.emblemDataUrl) + '" alt="">'
              : '<b>✦</b>') +
            '<strong>' + (faithType === 'religion' ? 'Вера' : 'Идеология') + '</strong>' +
            '<span>' + escapeHtml(system.name) + '</span></section>' +
          '<section class="country-doc-culture"><strong>Культура</strong>' +
            '<div class="culture-symbols">' + cultureSymbols(country.culture || []) + '</div>' +
          '</section>' +
        '</div>' +
        (economy && (economy.disabledBuildings.length || economy.starvedColonies || economy.fledColonies || economy.floodedCells || economy.clothingShortage)
          ? '<section class="country-doc-inactive-actions" aria-live="polite"><strong>Экономические последствия этого хода</strong><p>' +
            (economy.disabledBuildings.length
              ? 'Отключены: ' + escapeHtml(disabledBuildingsLabel) + '. '
              : '') +
            (economy.starvedColonies
              ? 'Вымерло колоний: ' + escapeHtml(economy.starvedColonies) + '. '
              : '') +
            (economy.fledColonies
              ? 'Покинуто колоний из-за нехватки товаров: ' + escapeHtml(economy.fledColonies) + '. '
              : '') +
            (economy.floodedCells
              ? 'Затоплено клеток: ' + escapeHtml(economy.floodedCells) + '. '
              : '') +
            (economy.clothingShortage
              ? 'Не обеспечено тёплой одеждой жителей: ' + escapeHtml(economy.unclothedPopulation || 0) + '.'
              : '') + '</p></section>'
          : '') +

      '</article>';
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
      button.innerHTML = type ? buildingIconHtml(type) : (isWater ? '≈' : key === '2,2' ? '·' : '');
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
    $('#building-counts').innerHTML = Object.entries(buildingMeta)
      .filter(([type]) => required[type] || extra.includes(type))
      .map(([type, meta]) => `<span class="building-count-item">${buildingIconHtml(type)} ${escapeHtml(meta.label)}: ${counts[type] || 0}/${required[type] || 1}</span>`)
      .join('') + (valid ? '   ✓ ГОТОВО' : '   ·   НЕ ЗАПОЛНЕНО');
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
      host.innerHTML = `<div class="empty-state compact">${error.status === 403 ? 'Этот раздел доступен только назначенным администраторам.' : escapeHtml(userErrorMessage(error))}</div>`;
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
      showToast(userErrorMessage(error), true);
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
      await loadCountryProfile();
      await loadTurnRoom();
      await loadMapOrders();
      activateTab('country');
      buildWorldPreview();
    } catch (error) {
      setMessage('#country-message', userErrorMessage(error) || 'Не удалось создать государство.');
      showToast(userErrorMessage(error) || 'Не удалось создать государство.', true);
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
      const mode = state.authMode;
      const submit = $('#auth-submit');
      submit.disabled = true;
      setMessage('#auth-message', '');

      try {
        const data = await request(mode === 'login' ? '/auth/login' : '/auth/register', {
          method: 'POST',
          body: JSON.stringify({ email, password }),
        });
        if (mode === 'register' && data?.verificationRequired === true) {
          $('#email-verification-actions').classList.remove('hidden');
          setMessage('#auth-message', 'Письмо с подтверждением отправлено на ' + email + '. Открой письмо и подтверди адрес, затем вернись сюда для входа.', true);
          return;
        }
        if (!data || typeof data.accessToken !== 'string' || !data.user) {
          throw new Error('Сервер вернул неполный ответ авторизации.');
        }

        $('#email-verification-actions').classList.add('hidden');
        state.token = data.accessToken;
        sessionStorage.setItem('pw_access_token', state.token);
        state.user = data.user;
        showScreen('game');

        let campaignLoadError = null;
        try {
          await loadCampaigns();
          await loadProfile();
        } catch (error) {
          campaignLoadError = error;
        }
        if (campaignLoadError) {
          showToast('Авторизация прошла успешно, но список кампаний не загрузился: ' + campaignLoadError.message, true);
        } else {
          showToast(mode === 'login' ? 'С возвращением.' : 'Аккаунт создан.');
        }
      } catch (error) {
        let message = userErrorMessage(error) || 'Не удалось выполнить авторизацию.';
        if (error.code === 'EMAIL_NOT_VERIFIED') {
          $('#email-verification-actions').classList.remove('hidden');
          message = 'Сначала подтверди адрес электронной почты. Можно отправить письмо повторно.';
        } else if (error.code === 'UNAUTHENTICATED') {
          message = 'Неверная почта или пароль.';
        } else if (error.code === 'EMAIL_ALREADY_REGISTERED') {
          $('#email-verification-actions').classList.remove('hidden');
          message = 'Аккаунт с этой почтой уже существует. Попробуй войти. Если адрес ещё не подтверждён, можно запросить письмо повторно.';
        } else if (error.code === 'VERIFICATION_EMAIL_FAILED') {
          $('#email-verification-actions').classList.remove('hidden');
          message = 'Аккаунт создан, но письмо не удалось отправить. Проверь настройки почтового сервиса или попробуй отправить письмо повторно позже.';
        } else if (error.code === 'INTERNAL_SERVER_ERROR') {
          message = 'Внутренняя ошибка сервера. Проверь сообщения в окне «Paper Wars API».';
        } else if (error instanceof TypeError) {
          message = 'Не удалось связаться с сервером. Проверь, запущено ли окно «Paper Wars API».';
        }
        setMessage('#auth-message', message);
      } finally {
        submit.disabled = false;
      }
    });

    $('#profile-button').addEventListener('click', () => { void openProfile(); });
    $('#profile-back').addEventListener('click', closeProfile);
    $('#admin-code-form').addEventListener('submit', submitAdminCode);
    $('#admin-mode-toggle').addEventListener('click', toggleAdminMode);
    $('#admin-campaign-select').addEventListener('change', () => { void loadAdminDiscoveries(); });
    $('#admin-open-map').addEventListener('click', openAdminCampaignMap);
    $('#admin-force-end-turn').addEventListener('click', adminForceEndTurn);
    $('#admin-rollback-turn').addEventListener('click', adminRollbackTurn);
    $('#profile-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!state.profile) return;
      const displayName = $('#profile-display-name').value.trim();
      const email = $('#profile-email').value.trim();
      if (!email && (state.profile.email || state.profile.hasPassword || !state.profile.hasVk)) {
        setMessage('#profile-form-message', 'Не удаляй единственный резервный способ входа. Укажи email или сначала подключи VK ID.');
        return;
      }
      const button = $('#profile-save');
      button.disabled = true;
      setMessage('#profile-form-message', '');
      try {
        const data = await request('/auth/profile', {
          method: 'PUT',
          body: JSON.stringify({ displayName, email: email || null }),
        });
        state.profile = data.profile;
        state.user = {
          id: data.profile.id,
          email: data.profile.email,
          displayName: data.profile.displayName,
        };
        $('#user-label').textContent = state.user.displayName || state.user.email || '';
        renderProfile();
        setMessage('#profile-form-message', 'Данные профиля сохранены.', true);
        showToast('Профиль обновлён.');
      } catch (error) {
        const message = error.code === 'EMAIL_ALREADY_REGISTERED'
          ? 'Этот email уже используется другим аккаунтом.'
          : userErrorMessage(error) || 'Не удалось сохранить профиль.';
        setMessage('#profile-form-message', message);
      } finally {
        button.disabled = false;
      }
    });

    $('#profile-password-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!state.profile?.email) {
        setMessage('#profile-password-message', 'Сначала добавь резервный email.');
        return;
      }
      const newPassword = $('#profile-new-password').value;
      const confirmPassword = $('#profile-confirm-password').value;
      if (newPassword.length < 12) {
        setMessage('#profile-password-message', 'Пароль должен содержать не менее 12 символов.');
        return;
      }
      if (newPassword !== confirmPassword) {
        setMessage('#profile-password-message', 'Новые пароли не совпадают.');
        return;
      }
      const button = $('#profile-password-submit');
      button.disabled = true;
      setMessage('#profile-password-message', '');
      try {
        await request('/auth/password', {
          method: 'POST',
          body: JSON.stringify({
            currentPassword: $('#profile-current-password').value,
            newPassword,
          }),
        });
        await loadProfile();
        setMessage('#profile-password-message', 'Резервный пароль сохранён.', true);
        showToast('Настройки пароля обновлены.');
      } catch (error) {
        const message = error.code === 'UNAUTHENTICATED'
          ? 'Текущий пароль указан неверно.'
          : userErrorMessage(error) || 'Не удалось изменить пароль.';
        setMessage('#profile-password-message', message);
      } finally {
        button.disabled = false;
      }
    });

    $('#profile-link-vk').addEventListener('click', async () => {
      const button = $('#profile-link-vk');
      button.disabled = true;
      try {
        const data = await request('/auth/vk/link', { method: 'POST' });
        if (typeof data.authorizationUrl !== 'string') throw new Error('Сервер не вернул адрес привязки VK ID.');
        window.location.assign(data.authorizationUrl);
      } catch (error) {
        showToast(error.code === 'VK_ID_NOT_CONFIGURED'
          ? 'Привязка VK ID пока не настроена на сервере.'
          : userErrorMessage(error) || 'Не удалось начать привязку VK ID.', true);
        button.disabled = false;
      }
    });

    $('#leave-campaign').addEventListener('click', () => {
      if (state.campaign) leaveCampaign(state.campaign.id);
    });

    $('#join-campaign-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const rawCampaignId = $('#join-campaign-id').value.trim();
      const campaignId = rawCampaignId.match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
      )?.[0] || rawCampaignId;
      try {
        await request('/campaigns/' + encodeURIComponent(campaignId) + '/join', { method: 'POST' });
        $('#join-campaign-id').value = '';
        setMessage('#join-campaign-message', 'Ты присоединился к кампании. Она появится в списке миров.', true);
        await loadCampaigns();
        showToast('Подключение к кампании выполнено.');
      } catch (error) {
        setMessage('#join-campaign-message', userErrorMessage(error));
      }
    });

    $('#resend-verification').addEventListener('click', async () => {
      const email = $('#auth-email').value.trim();
      if (!email) {
        setMessage('#auth-message', 'Сначала введи адрес электронной почты.');
        return;
      }
      const button = $('#resend-verification');
      button.disabled = true;
      try {
        await request('/auth/resend-verification', {
          method: 'POST',
          body: JSON.stringify({ email }),
        });
        setMessage('#auth-message', 'Если аккаунт ожидает подтверждения, письмо отправлено. Проверь входящие и папку спама.', true);
      } catch (error) {
        setMessage('#auth-message', userErrorMessage(error));
      } finally {
        button.disabled = false;
      }
    });

    $('#refresh-open-campaigns').addEventListener('click', () => { void loadOpenCampaigns(); });

    $('#chat-open-button').addEventListener('click', () => { void openChatModal(); });
    $('#chat-close-button').addEventListener('click', closeChatModal);
    $('#chat-modal').addEventListener('click', (event) => {
      if (event.target === $('#chat-modal-backdrop') ||
          event.target.classList.contains('chat-modal-backdrop') ||
          event.target === $('#chat-modal')) closeChatModal();
    });
    $('#chat-compose-form').addEventListener('submit', sendChatMessage);
    $('#chat-message-input').addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        $('#chat-compose-form').requestSubmit();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        if (state.chatModalOpen) void loadChatMessages();
        void pollChatNotifications();
      }
    });

    $('#logout-button').addEventListener('click', async () => {
      closeChatModal();
      stopChatNotificationPolling();
      try { await request('/auth/logout', { method: 'POST' }); } catch { /* Session is cleared locally regardless. */ }
      state.token = '';
      state.user = null;
      state.profile = null;
      state.chatPreferencesUserId = null;
      state.adminModeEnabled = false;
      sessionStorage.removeItem('pw_access_token');
      showScreen('auth');
      showToast('Сессия завершена.');
    });

    const clampWorldDimension = (input) => {
      const value = Number(input.value);
      if (Number.isFinite(value) && value > 200) input.value = '200';
    };
    ['#map-width', '#map-height'].forEach((selector) => {
      const input = $(selector);
      input.max = '200';
      input.addEventListener('input', () => clampWorldDimension(input));
      input.addEventListener('change', () => clampWorldDimension(input));
      input.addEventListener('paste', () => requestAnimationFrame(() => clampWorldDimension(input)));
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
        setMessage('#campaign-message', userErrorMessage(error));
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
            emblemDataUrl: (await readOptionalImage('#system-emblem')) || state.loadedSystemEmblemDataUrl,
          }),
        });
        $('#system-name').value = '';
        $('#system-emblem').value = '';
        state.loadedSystemEmblemDataUrl = null;
        $$('.principle-check').forEach((input) => { input.checked = false; });
        updatePrincipleBalance();
        setMessage('#system-message', 'Учение создано и сразу доступно для выбора.', true);
        await loadSystems();
        $('#official-system-type').value = $('#system-type').value;
        updateBuildingChoices();
        await refreshAvailableSystems();
        showToast('Учение сохранено в личной библиотеке и добавлено в кампанию.');
      } catch (error) {
        setMessage('#system-message', userErrorMessage(error));
      }
    });

    $('#refresh-systems').addEventListener('click', loadSystems);
    $('#open-map').addEventListener('click', openMap);
    $('#close-map').addEventListener('click', () => {
      closeMapContextMenu();
      $('#map-modal').classList.add('hidden');
      if (state.adminMapOpened) {
        state.campaign = state.adminMapPreviousCampaign;
        state.adminMapPreviousCampaign = null;
        state.adminMapOpened = false;
        state.mapView = null;
      }
    });
    $('#confirm-spawn').addEventListener('click', confirmSpawn);
    $('#confirm-map-orders').addEventListener('click', confirmMapOrders);
    document.addEventListener('pointerdown', (event) => {
      const menu = $('#map-context-menu');
      if (menu && !menu.contains(event.target) && event.target !== $('#map-canvas')) closeMapContextMenu();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        closeMapContextMenu();
        closeChatModal();
      }
    });
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
      if (!drag || drag.moved) return;
      const cell = mapCellAt(event.clientX, event.clientY);
      if (!cell) return;
      if (state.campaign?.countryId || isAdminMode()) {
        if (event.pointerType === 'touch') openMapContextMenu(cell, event.clientX, event.clientY);
        return;
      }
      chooseSpawnCenter(cell.x, cell.y);
    });
    $('#map-canvas').addEventListener('contextmenu', (event) => {
      if (!state.campaign?.countryId && !isAdminMode()) return;
      event.preventDefault();
      const cell = mapCellAt(event.clientX, event.clientY);
      if (cell) openMapContextMenu(cell, event.clientX, event.clientY);
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
      refreshAvailableSystems().catch((error) => setMessage('#country-message', userErrorMessage(error)));
      renderTerritoryGrid();
    });
    $('#building-type').addEventListener('change', (event) => { state.selectedBuilding = event.target.value; });
    $('#country-form').addEventListener('submit', submitCountry);
    $('#refresh-pending').addEventListener('click', loadPending);
  }

  async function init() {
    const vkLinked = new URLSearchParams(window.location.search).get('vk') === 'linked';
    if (vkLinked) window.history.replaceState({}, document.title, window.location.pathname);
    bindEvents();
    buildWorldPreview();
    renderPrincipleCatalog();
    resetTerritoryGrid();
    updateBuildingChoices();

    try {
      const authenticated = await restoreSession();
      if (!authenticated) {
        showScreen('auth');
        void initVkOneTap();
        return;
      }

      // Authentication is already valid. A campaign-listing failure must not
      // erase the session or send the player back to the welcome screen.
      showScreen('game');
      try {
        await loadCampaigns();
      } catch (error) {
        showToast('Сессия активна, но список кампаний не загрузился: ' + userErrorMessage(error), true);
      }
      try {
        await loadProfile();
      } catch (error) {
        showToast('Сессия активна, но профиль не загрузился: ' + userErrorMessage(error), true);
      }
      if (vkLinked && await openProfile()) {
        setMessage('#profile-page-message', 'Аккаунт VK ID успешно подключён.', true);
      }
    } catch (error) {
      showScreen('auth');
      setMessage('#auth-message', 'Не удалось восстановить сессию: ' + userErrorMessage(error));
    }
  }
  init();
})();
