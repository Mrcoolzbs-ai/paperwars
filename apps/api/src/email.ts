export interface VerificationEmailSender {
  sendVerificationEmail(email: string, verificationUrl: string): Promise<void>;
}

export interface ResendEmailSenderOptions {
  readonly apiKey: string;
  readonly from: string;
  readonly fetcher?: typeof fetch;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function createResendEmailSender(
  options: ResendEmailSenderOptions,
): VerificationEmailSender {
  const fetcher = options.fetcher ?? fetch;
  return {
    async sendVerificationEmail(email, verificationUrl) {
      const safeUrl = escapeHtml(verificationUrl);
      const response = await fetcher('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: options.from,
          to: [email],
          subject: 'Подтвердите адрес электронной почты — Paper Wars',
          text: `Чтобы подтвердить адрес электронной почты, откройте ссылку: ${verificationUrl}\n\nСсылка действует 24 часа. Если вы не создавали аккаунт Paper Wars, просто проигнорируйте это письмо.`,
          html: `<!doctype html><html lang="ru"><body style="font-family:Arial,sans-serif;color:#1c2732"><h1>Добро пожаловать в Paper Wars</h1><p>Подтвердите адрес электронной почты, чтобы завершить регистрацию.</p><p><a href="${safeUrl}">Подтвердить email</a></p><p>Ссылка действует 24 часа. Если вы не создавали аккаунт Paper Wars, проигнорируйте письмо.</p></body></html>`,
        }),
      });
      if (!response.ok) {
        // Do not include provider response bodies, which can contain recipient metadata.
        throw new Error(`Resend rejected the verification email (HTTP ${response.status})`);
      }
    },
  };
}

export function createConsoleEmailSender(log: (message: string) => void): VerificationEmailSender {
  return {
    async sendVerificationEmail(email, verificationUrl) {
      log(`[email verification] ${email}: ${verificationUrl}`);
    },
  };
}
