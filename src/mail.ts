/**
 * Transactional email over SMTP (nodemailer): Gmail with an App Password by
 * default, any SMTP server through SMTP_HOST/PORT. Render's free plan blocks
 * SMTP ports; EC2 allows 465/587 (only port 25 is throttled).
 * Without SMTP_USER/SMTP_PASS, outside production, the message is printed to
 * the log so codes can be read during development; in production it is dropped
 * with an error, never logged, since a code in the log is a code anyone with
 * log access can use.
 */
import type { FastifyBaseLogger } from 'fastify';
import { createTransport, type Transporter } from 'nodemailer';

import { config } from './config.js';

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/** The last emails printed in development, newest last; test/auth.mjs reads its codes here. */
export const devOutbox: Mail[] = [];

export const mailConfigured = () => Boolean(config.smtpUser && config.smtpPass);

let transport: Transporter | null = null;

/** One pooled connection, opened on the first email and reused. */
function smtp(): Transporter {
  transport ??= createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    // 465 is TLS from the first byte; 587 upgrades with STARTTLS, which is then required.
    secure: config.smtpPort === 465,
    requireTLS: config.smtpPort !== 465,
    auth: { user: config.smtpUser, pass: config.smtpPass },
    pool: true,
    maxConnections: 2,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  return transport;
}

/** Fire and forget: the caller answers at once whatever happens here. */
export function sendMail(mail: Mail, log: FastifyBaseLogger): void {
  void deliver(mail, log).catch((err) => log.error({ err, to: redact(mail.to) }, 'Email not sent'));
}

async function deliver(mail: Mail, log: FastifyBaseLogger): Promise<void> {
  if (!mailConfigured()) {
    if (config.production) throw new Error('SMTP_USER / SMTP_PASS are not set');
    log.warn(`[dev mail] to ${mail.to}: ${mail.subject}\n${mail.text}`);
    if (devOutbox.push(mail) > 20) devOutbox.shift();
    return;
  }
  await smtp().sendMail({
    from: { name: config.mailFromName, address: config.mailFrom },
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
  });
}

/** Checks the SMTP login at startup, so a wrong App Password shows in the log at once, not on the first sign-up. */
export async function verifyMail(log: FastifyBaseLogger): Promise<void> {
  if (!mailConfigured()) {
    if (config.production) log.error('SMTP_USER / SMTP_PASS are not set: verification and reset emails will not be sent.');
    return;
  }
  try {
    await smtp().verify();
    log.info(`Email: sending as ${config.mailFrom} through ${config.smtpHost}:${config.smtpPort}`);
  } catch (err) {
    log.error({ err }, `Email: cannot sign in to ${config.smtpHost}:${config.smtpPort}; verification and reset emails will fail`);
  }
}

/** `a***@example.com`: enough to tell addresses apart in a log. */
const redact = (email: string) => email.replace(/^(.).*@/, '$1***@');
