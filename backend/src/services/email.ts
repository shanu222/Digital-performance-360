import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { AppError } from '../lib/http.js';

export interface EmailMessage {
  to: string[];
  subject: string;
  html: string;
  text?: string;
  attachments?: Array<{ filename: string; content: Buffer; contentType?: string }>;
}

export function emailConfigured(): boolean {
  if (env.EMAIL_PROVIDER === 'resend') return Boolean(env.EMAIL_PROVIDER_API_KEY && env.EMAIL_FROM);
  if (env.EMAIL_PROVIDER === 'smtp') return Boolean(env.SMTP_HOST && env.EMAIL_FROM);
  return false;
}

/** Sends through Resend's HTTP API or any SMTP server. Credentials come from env only. */
export async function sendEmail(msg: EmailMessage) {
  if (!emailConfigured()) throw new AppError(409, 'email_not_configured', 'Email delivery is not configured (EMAIL_PROVIDER, EMAIL_FROM and credentials).');
  if (!msg.to.length) throw new AppError(400, 'no_recipients', 'No email recipients configured');

  if (env.EMAIL_PROVIDER === 'resend') {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.EMAIL_PROVIDER_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.EMAIL_FROM,
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        attachments: msg.attachments?.map((a) => ({ filename: a.filename, content: a.content.toString('base64') })),
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Resend error ${res.status}: ${body.slice(0, 300)}`);
    }
    return (await res.json()) as { id: string };
  }

  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
  });
  const info = await transport.sendMail({ from: env.EMAIL_FROM, to: msg.to.join(','), subject: msg.subject, html: msg.html, text: msg.text, attachments: msg.attachments });
  return { id: info.messageId };
}
