export const VERIFY_EMAIL_PAGE_HTML = String.raw`<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="referrer" content="no-referrer">
  <title>Paper Wars — подтверждение email</title>
  <style>
    :root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#10151c;color:#ecf0f4}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:20px;background:radial-gradient(circle at 15% 0%,#263342 0,#10151c 48%)}
    main{width:min(460px,100%);padding:28px;border:1px solid #344250;border-radius:18px;background:#161f29;box-shadow:0 20px 60px #0005}
    .brand{font-weight:800;letter-spacing:.12em;font-size:13px;color:#d4a96b}h1{font-size:26px;margin:12px 0}p{color:#aebac6;line-height:1.6}
    button,a{display:inline-block;border:1px solid #d3a66d;border-radius:10px;padding:11px 16px;color:#171b20;background:#d3a66d;text-decoration:none;font:inherit;font-weight:700;cursor:pointer}
    .error{color:#ff9f91}.hidden{display:none!important}
  </style>
</head>
<body>
  <main>
    <div class="brand">PAPER WARS · REBIRTH</div>
    <h1 id="title">Подтверждение email</h1>
    <p id="message">Нажмите кнопку, чтобы подтвердить адрес электронной почты и завершить регистрацию.</p>
    <button id="confirm" type="button">Подтвердить email</button>
    <p id="error" class="error" role="alert"></p>
    <a id="login" class="hidden" href="/chat">Перейти к входу</a>
  </main>
<script>
(() => {
  'use strict';
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');
  const sent = params.get('sent') === '1';
  const error = params.get('error');
  const button = document.getElementById('confirm');
  const message = document.getElementById('message');
  const title = document.getElementById('title');
  const login = document.getElementById('login');
  const errorBox = document.getElementById('error');
  if (sent) {
    title.textContent = 'Проверьте почту';
    message.textContent = 'Мы отправили письмо с подтверждением. Откройте его и перейдите по ссылке, чтобы завершить регистрацию.';
    button.classList.add('hidden');
    login.classList.remove('hidden');
    return;
  }
  if (error === 'vk-email-exists') {
    title.textContent = 'Email уже зарегистрирован';
    message.textContent = 'Чтобы не допустить захват аккаунта, мы не привязываем VK автоматически по совпадению адреса. Войдите обычным способом, а затем нажмите «Привязать VK» в чате.';
    button.classList.add('hidden');
    login.classList.remove('hidden');
    return;
  }
  if (error === 'vk-unavailable') {
    title.textContent = 'Вход через VK пока не настроен';
    message.textContent = 'Администратору нужно указать параметры приложения VK ID.';
    button.classList.add('hidden');
    login.classList.remove('hidden');
    return;
  }
  if (error === 'vk-no-email') {
    title.textContent = 'VK не передал email';
    message.textContent = 'Создайте аккаунт по адресу электронной почты или включите выдачу email в настройках согласия VK ID.';
    button.classList.add('hidden');
    login.classList.remove('hidden');
    return;
  }
  if (!token) {
    errorBox.textContent = 'Ссылка отсутствует или повреждена. Запросите новое письмо на странице входа.';
    button.classList.add('hidden');
    login.classList.remove('hidden');
  }
  button.addEventListener('click', async () => {
    button.disabled = true;
    errorBox.textContent = '';
    try {
      const response = await fetch('/auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ token }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error((body && body.message) || 'Ссылка недействительна или устарела.');
      title.textContent = 'Email подтверждён';
      message.textContent = 'Регистрация завершена. Перенаправляем вас в Paper Wars…';
      button.classList.add('hidden');
      window.location.replace('/chat');
    } catch (err) {
      errorBox.textContent = err instanceof Error ? err.message : 'Не удалось подтвердить email.';
      button.disabled = false;
      login.classList.remove('hidden');
    }
  });
})();
</script>
</body>
</html>`;
