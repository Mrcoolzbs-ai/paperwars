export const GAME_PAGE_HTML = String.raw`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#111820">
  <meta name="referrer" content="same-origin">
  <title>Paper Wars: Rebirth — стратегия</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0d141b;color:#edf1f3;font-synthesis:none}
    *{box-sizing:border-box}
    body{margin:0;min-height:100vh;background:radial-gradient(ellipse at 15% -10%,#34485b 0,transparent 38%),radial-gradient(ellipse at 100% 15%,#453722 0,transparent 30%),#0d141b}
    button,input{font:inherit}
    button{cursor:pointer}
    button:disabled{cursor:not-allowed;opacity:.55}
    .shell{width:min(1120px,calc(100% - 32px));margin:0 auto;padding:28px 0 52px}
    .topbar{display:flex;align-items:center;justify-content:space-between;gap:18px;margin-bottom:34px}
    .brand{display:flex;align-items:center;gap:13px}
    .sigil{width:44px;height:44px;display:grid;place-items:center;border:1px solid #b98f55;border-radius:12px;background:linear-gradient(145deg,#314354,#17232d);color:#e2bd7d;font-size:22px;box-shadow:inset 0 0 18px #d1a66b16}
    .brand-name{font-size:14px;letter-spacing:.19em;font-weight:850;color:#e6c48e}
    .brand-sub{margin-top:3px;font-size:11px;letter-spacing:.14em;color:#8796a3}
    .top-actions{display:flex;align-items:center;gap:12px}
    .user-label{font-size:13px;color:#aab7c1;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .hero{display:grid;grid-template-columns:minmax(0,1.12fr) minmax(280px,.88fr);gap:24px;align-items:stretch;margin-bottom:26px}
    .hero-copy,.hero-art,.panel{border:1px solid #344453;border-radius:18px;background:linear-gradient(145deg,#19252fef,#111a22f5);box-shadow:0 18px 50px #0003}
    .hero-copy{padding:34px}
    .eyebrow{color:#d0a96e;font-size:11px;letter-spacing:.2em;font-weight:800;text-transform:uppercase}
    h1{margin:14px 0 13px;font-size:clamp(30px,5vw,48px);line-height:1.06;letter-spacing:-.035em}
    .hero-copy p{max-width:620px;color:#aab7c1;line-height:1.7;margin:0}
    .hero-art{min-height:220px;position:relative;overflow:hidden;display:grid;place-items:center;background:radial-gradient(ellipse at center,#44515b 0,#202d36 34%,#111820 75%)}
    .compass{width:176px;height:176px;border:1px solid #b98f5577;border-radius:50%;display:grid;place-items:center;position:relative;transform:rotate(-12deg);box-shadow:0 0 0 15px #b98f5508,0 0 0 32px #b98f5505}
    .compass:before,.compass:after{content:"";position:absolute;background:#c4a16b88}
    .compass:before{width:1px;height:210px}
    .compass:after{height:1px;width:210px}
    .compass-center{width:104px;height:104px;border:1px solid #d2b17a;border-radius:50%;display:grid;place-items:center;color:#e5c38b;font-size:47px;background:#16212a;z-index:1}
    .compass-label{position:absolute;bottom:18px;color:#d3b17a;font-size:10px;letter-spacing:.24em}
    .panel{padding:24px}
    .auth-wrap{max-width:480px;margin:30px auto}
    .panel h2{font-size:21px;margin:0 0 7px}
    .muted{color:#9fadb8;font-size:13px;line-height:1.6}
    .form-grid{display:grid;gap:14px;margin-top:20px}
    label{display:grid;gap:7px;color:#c2cbd1;font-size:13px}
    input{width:100%;min-height:44px;padding:10px 12px;border:1px solid #40515f;border-radius:10px;background:#0f171e;color:#edf1f3;outline:none}
    input:focus{border-color:#d0a96e;box-shadow:0 0 0 3px #d0a96e20}
    .actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
    .btn{border:1px solid #c59b62;border-radius:10px;padding:11px 16px;background:linear-gradient(180deg,#e0bd83,#bd8e52);color:#1b1d20;font-weight:800}
    .btn.secondary{background:#253440;border-color:#435461;color:#dce3e8}
    .btn.ghost{background:transparent;border-color:#465662;color:#c2ccd3}
    .link-button{border:0;background:transparent;padding:8px 2px;color:#d9b77e;font-size:13px}
    .error{min-height:19px;color:#ff9b8d;font-size:13px}
    .success{color:#a7d2ad;font-size:13px;line-height:1.5}
    .hidden{display:none!important}
    .section-heading{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin:34px 0 16px}
    .section-heading h2{margin:0;font-size:24px}
    .section-heading p{margin:5px 0 0;color:#91a0ad;font-size:13px}
    .workspace{display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:18px;align-items:start}
    .campaign-panel{min-height:270px}
    .campaign-list{display:grid;gap:10px;margin-top:17px}
    .campaign-card{display:flex;justify-content:space-between;align-items:center;gap:14px;padding:16px;border:1px solid #394a57;border-radius:13px;background:#111b23}
    .campaign-card h3{font-size:15px;margin:0 0 6px}
    .campaign-card p{font-size:12px;color:#91a0ad;margin:0}
    .campaign-card button{flex:0 0 auto}
    .status-pill{display:inline-flex;align-items:center;gap:6px;border:1px solid #485b63;border-radius:999px;padding:4px 8px;color:#b8c9c1;font-size:10px;white-space:nowrap}
    .status-pill:before{content:"";width:6px;height:6px;border-radius:50%;background:#8ac39a}
    .aside-card{background:linear-gradient(155deg,#252f35,#151e25);border:1px solid #49525a;border-radius:16px;padding:20px}
    .aside-card h3{margin:0 0 10px;font-size:16px}
    .aside-card p{font-size:13px;line-height:1.6;color:#aab7c1;margin:0}
    .progress-list{display:grid;gap:12px;margin-top:18px}
    .progress-item{display:flex;gap:11px;align-items:center;color:#9caab4;font-size:12px}
    .progress-dot{width:24px;height:24px;border:1px solid #53616b;border-radius:50%;display:grid;place-items:center;color:#d4b27a;font-size:11px;flex:0 0 auto}
    .detail{margin-top:18px}
    .detail-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:18px 0}
    .metric{padding:13px;border:1px solid #394a57;border-radius:11px;background:#111a22}
    .metric strong{display:block;font-size:18px;color:#e2c18a}
    .metric span{display:block;margin-top:4px;color:#8f9eaa;font-size:11px}
    .notice{padding:14px;border-left:3px solid #c59b62;border-radius:0 9px 9px 0;background:#c59b6212;color:#bdc8d0;font-size:13px;line-height:1.6}
    .empty{margin-top:17px;padding:28px 18px;border:1px dashed #485965;border-radius:13px;text-align:center;color:#97a6b1;font-size:13px;line-height:1.6}
    .footer{margin-top:34px;padding-top:18px;border-top:1px solid #2e3b46;color:#70808d;font-size:11px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
    @media(max-width:800px){.hero{grid-template-columns:1fr}.hero-art{min-height:180px}.workspace{grid-template-columns:1fr}.hero-copy{padding:27px}}
    @media(max-width:520px){.shell{width:min(100% - 22px,1120px);padding-top:17px}.topbar{margin-bottom:22px}.brand-name{font-size:12px}.user-label{max-width:125px}.hero-copy{padding:22px}.panel{padding:18px}.section-heading{align-items:flex-start;flex-direction:column}.campaign-card{align-items:flex-start;flex-direction:column}.campaign-card button{width:100%}.detail-grid{grid-template-columns:1fr 1fr}}
  </style>
</head>
<body>
  <main class="shell">
    <header class="topbar">
      <div class="brand">
        <div class="sigil" aria-hidden="true">♜</div>
        <div><div class="brand-name">PAPER WARS</div><div class="brand-sub">REBIRTH · GRAND STRATEGY</div></div>
      </div>
      <div class="top-actions">
        <span class="user-label hidden" id="user-label"></span>
        <button class="btn ghost hidden" id="logout" type="button">Выйти</button>
      </div>
    </header>

    <section class="hero">
      <div class="hero-copy">
        <div class="eyebrow">Многопользовательская стратегия</div>
        <h1>История пишется<br>твоими решениями.</h1>
        <p>Создавай государства, заключай союзы и меняй ход истории. Начни с кампании — подготовка мира и регистрация государства станут следующим шагом развития игры.</p>
      </div>
      <div class="hero-art" aria-label="Компас на фоне карты">
        <div class="compass"><div class="compass-center">♜</div><div class="compass-label">REBUILD THE WORLD</div></div>
      </div>
    </section>

    <section class="panel auth-wrap" id="auth-view">
      <div class="eyebrow">Доступ к миру</div>
      <h2 id="auth-title">Войти в Paper Wars</h2>
      <p class="muted" id="auth-description">Войди в аккаунт, чтобы продолжить кампанию или создать новую.</p>
      <form id="auth-form" class="form-grid">
        <label>Email<input id="email" type="email" autocomplete="username" required maxlength="254"></label>
        <label>Пароль<input id="password" type="password" autocomplete="current-password" required minlength="12" maxlength="1024"></label>
        <div class="actions">
          <button class="btn" id="auth-submit" type="submit">Войти</button>
          <button class="link-button" id="auth-switch" type="button">Создать аккаунт</button>
        </div>
      </form>
      <div id="verification-note" class="notice hidden" role="status"></div>
      <div id="auth-error" class="error" role="alert"></div>
    </section>

    <section id="game-view" class="hidden">
      <div class="section-heading">
        <div><div class="eyebrow">Командный центр</div><h2>Твои кампании</h2><p>Выбери существующий мир или создай новую кампанию.</p></div>
        <span class="status-pill">Сервер подключён</span>
      </div>
      <div class="workspace">
        <section class="panel campaign-panel">
          <div class="eyebrow">Миры и партии</div>
          <h2>Кампании</h2>
          <div id="campaign-list" class="campaign-list"><div class="empty">Загружаем кампании…</div></div>
          <section id="campaign-detail" class="detail hidden">
            <div class="section-heading">
              <div><div class="eyebrow">Карточка кампании</div><h2 id="detail-name">Кампания</h2></div>
              <button class="btn ghost" type="button" id="close-detail">Свернуть</button>
            </div>
            <div class="detail-grid">
              <div class="metric"><strong id="detail-turn">1</strong><span>Текущий ход</span></div>
              <div class="metric"><strong id="detail-status">Активна</strong><span>Статус кампании</span></div>
              <div class="metric"><strong id="detail-membership">Участник</strong><span>Твой статус</span></div>
            </div>
            <div class="notice" id="detail-notice">Кампания создана на сервере. Регистрация государств, генерация карты, приказы и обработка ходов ещё не подключены — это следующий игровой этап.</div>
          </section>
        </section>
        <aside class="aside-card">
          <div class="eyebrow">Новый мир</div>
          <h3>Начать кампанию</h3>
          <p>Дай миру название. Настройки карты и регистрация государств появятся в следующем этапе запуска игрового процесса.</p>
          <form id="campaign-form" class="form-grid">
            <label>Название кампании<input id="campaign-name" type="text" required minlength="2" maxlength="80" placeholder="Например, Новая Европа"></label>
            <button class="btn" id="campaign-submit" type="submit">Создать кампанию</button>
          </form>
          <div id="campaign-error" class="error" role="alert"></div>
          <div id="campaign-success" class="success" role="status"></div>
          <div class="progress-list" aria-label="Этапы разработки игры">
            <div class="progress-item"><span class="progress-dot">1</span><span>Аккаунт и кампании</span></div>
            <div class="progress-item"><span class="progress-dot">2</span><span>Карта и государства</span></div>
            <div class="progress-item"><span class="progress-dot">3</span><span>Приказы и ход</span></div>
            <div class="progress-item"><span class="progress-dot">4</span><span>Дипломатия и развитие</span></div>
          </div>
        </aside>
      </div>
    </section>

    <footer class="footer"><span>Paper Wars: Rebirth · ранняя сборка</span><span id="connection-state">Подключение к серверу…</span></footer>
  </main>
<script>
(() => {
  "use strict";
  const state = { token: null, register: false, campaigns: [], selectedCampaignId: null, refreshPromise: null };
  const $ = (id) => document.getElementById(id);
  const authView = $("auth-view");
  const gameView = $("game-view");

  function setConnection(message, failed) {
    $("connection-state").textContent = message;
    $("connection-state").style.color = failed ? "#ff9b8d" : "";
  }
  function setAuthError(message) { $("auth-error").textContent = message || ""; }
  function showAuth() {
    authView.classList.remove("hidden");
    gameView.classList.add("hidden");
    $("logout").classList.add("hidden");
    $("user-label").classList.add("hidden");
  }
  function showGame(email) {
    authView.classList.add("hidden");
    gameView.classList.remove("hidden");
    $("logout").classList.remove("hidden");
    $("user-label").classList.remove("hidden");
    $("user-label").textContent = email || "Игрок";
  }
  async function refreshAccessToken() {
    if (!state.refreshPromise) {
      state.refreshPromise = (async () => {
        const response = await fetch("/auth/refresh", { method: "POST", credentials: "same-origin" });
        const body = await response.json().catch(() => null);
        if (!response.ok || !body || typeof body.accessToken !== "string") {
          throw new Error("Сессия завершена. Войдите снова.");
        }
        state.token = body.accessToken;
        return body;
      })().finally(() => { state.refreshPromise = null; });
    }
    return state.refreshPromise;
  }
  async function api(path, options, retried) {
    const opts = options || {};
    const headers = new Headers(opts.headers || {});
    if (state.token) headers.set("Authorization", "Bearer " + state.token);
    if (opts.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await fetch(path, { ...opts, headers, credentials: "same-origin" });
    const body = response.status === 204 ? null : await response.json().catch(() => null);
    if (response.status === 401 && state.token && path !== "/auth/refresh" && !retried) {
      try {
        await refreshAccessToken();
        return api(path, opts, true);
      } catch (_) {
        state.token = null;
      }
    }
    if (!response.ok) {
      const error = new Error((body && body.message) || "Запрос завершился ошибкой.");
      error.status = response.status;
      error.code = body && body.error;
      throw error;
    }
    return body;
  }
  function renderCampaigns() {
    const list = $("campaign-list");
    list.replaceChildren();
    if (!state.campaigns.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "Пока нет кампаний. Создай первую — она появится здесь.";
      list.append(empty);
      return;
    }
    for (const campaign of state.campaigns) {
      const card = document.createElement("article");
      card.className = "campaign-card";
      const info = document.createElement("div");
      const name = document.createElement("h3");
      name.textContent = campaign.name;
      const meta = document.createElement("p");
      const date = new Date(campaign.createdAt);
      const dateText = Number.isNaN(date.getTime()) ? "" : " · " + date.toLocaleDateString("ru-RU");
      meta.textContent = "Ход " + campaign.currentTurn + " · " + (campaign.countryId ? "государство зарегистрировано" : "ожидает регистрации государства") + dateText;
      info.append(name, meta);
      const button = document.createElement("button");
      button.className = "btn secondary";
      button.type = "button";
      button.textContent = "Открыть";
      button.addEventListener("click", () => openCampaign(campaign.id));
      card.append(info, button);
      list.append(card);
    }
  }
  function openCampaign(id) {
    const campaign = state.campaigns.find((item) => item.id === id);
    if (!campaign) return;
    state.selectedCampaignId = id;
    $("detail-name").textContent = campaign.name;
    $("detail-turn").textContent = String(campaign.currentTurn);
    $("detail-status").textContent = campaign.status === "active" ? "Активна" : campaign.status;
    $("detail-membership").textContent = campaign.memberStatus === "active" ? "Участник" : campaign.memberStatus;
    $("detail-notice").textContent = campaign.countryId
      ? "В этой кампании уже зарегистрировано государство. Игровой экран подключается следующим этапом."
      : "Кампания создана на сервере. Регистрация государства, генерация карты, приказы и обработка ходов ещё не подключены — это следующий игровой этап.";
    $("campaign-detail").classList.remove("hidden");
    $("campaign-detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  async function loadCampaigns() {
    const body = await api("/campaigns");
    state.campaigns = Array.isArray(body.campaigns) ? body.campaigns : [];
    renderCampaigns();
    setConnection("Соединение с сервером установлено", false);
    if (state.selectedCampaignId && state.campaigns.some((item) => item.id === state.selectedCampaignId)) {
      openCampaign(state.selectedCampaignId);
    } else {
      $("campaign-detail").classList.add("hidden");
      state.selectedCampaignId = null;
    }
  }
  async function enterGame(email) {
    showGame(email);
    try {
      await loadCampaigns();
    } catch (error) {
      if (error.status === 401) {
        state.token = null;
        showAuth();
      } else {
        setConnection(error.message, true);
      }
    }
  }
  function setAuthMode(register) {
    state.register = register;
    $("auth-title").textContent = register ? "Создать аккаунт" : "Войти в Paper Wars";
    $("auth-description").textContent = register
      ? "Регистрация требует подтверждения адреса электронной почты."
      : "Войди в аккаунт, чтобы продолжить кампанию или создать новую.";
    $("auth-submit").textContent = register ? "Зарегистрироваться" : "Войти";
    $("auth-switch").textContent = register ? "У меня уже есть аккаунт" : "Создать аккаунт";
    $("password").autocomplete = register ? "new-password" : "current-password";
    $("verification-note").classList.add("hidden");
    setAuthError("");
  }
  $("auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("auth-submit").disabled = true;
    setAuthError("");
    try {
      const endpoint = state.register ? "/auth/register" : "/auth/login";
      const body = await api(endpoint, {
        method: "POST",
        body: JSON.stringify({ email: $("email").value, password: $("password").value })
      });
      if (body && body.verificationRequired === true) {
        $("verification-note").textContent = "Письмо с подтверждением отправлено на " + $("email").value + ". Открой ссылку из письма, затем вернись на эту страницу и войди.";
        $("verification-note").classList.remove("hidden");
        return;
      }
      state.token = body.accessToken;
      await enterGame(body.user && body.user.email);
    } catch (error) {
      if (error.code === "EMAIL_NOT_VERIFIED") {
        $("verification-note").textContent = "Сначала подтверди адрес электронной почты. На странице входа в чат можно запросить письмо повторно.";
        $("verification-note").classList.remove("hidden");
      } else {
        setAuthError(error.status === 401 ? "Неверный email или пароль." : error.message);
      }
    } finally {
      $("auth-submit").disabled = false;
    }
  });
  $("auth-switch").addEventListener("click", () => setAuthMode(!state.register));
  $("campaign-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const name = $("campaign-name").value.trim();
    if (name.length < 2 || name.length > 80) return;
    $("campaign-submit").disabled = true;
    $("campaign-error").textContent = "";
    $("campaign-success").textContent = "";
    try {
      const body = await api("/campaigns", { method: "POST", body: JSON.stringify({ name }) });
      $("campaign-name").value = "";
      $("campaign-success").textContent = "Кампания создана. Она добавлена в твой список.";
      await loadCampaigns();
      if (body && body.campaign && body.campaign.id) openCampaign(body.campaign.id);
    } catch (error) {
      if (error.status === 401) {
        state.token = null;
        showAuth();
      } else {
        $("campaign-error").textContent = error.message || "Не удалось создать кампанию.";
      }
    } finally {
      $("campaign-submit").disabled = false;
    }
  });
  $("close-detail").addEventListener("click", () => $("campaign-detail").classList.add("hidden"));
  $("logout").addEventListener("click", async () => {
    try { await fetch("/auth/logout", { method: "POST", credentials: "same-origin" }); } catch (_) { /* local logout still applies */ }
    state.token = null;
    state.campaigns = [];
    state.selectedCampaignId = null;
    $("campaign-list").replaceChildren();
    showAuth();
    setConnection("Вы вышли из аккаунта", false);
  });
  async function bootstrap() {
    setConnection("Проверяем соединение…", false);
    try {
      const body = await refreshAccessToken();
      await enterGame(body.user && body.user.email);
    } catch (_) {
      showAuth();
      setConnection("Сервер Paper Wars доступен", false);
    }
  }
  $("auth-switch").addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setAuthMode(!state.register);
    }
  });
  bootstrap();
})();
</script>
</body>
</html>`;
