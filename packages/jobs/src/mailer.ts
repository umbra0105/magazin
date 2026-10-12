import nodemailer from "nodemailer";
import type { MailerConfig } from "@ecom/core";
import type { OutgoingMessage } from "./email-processor";

/**
 * Trimite prin SMTP cu nodemailer. Cu timeouturi explicite (un server SMTP care nu răspunde nu
 * ține joburile agățate). Fără autentificare dacă nu există utilizator (ex. Mailpit în dezvoltare).
 */
export async function sendViaSmtp(config: MailerConfig, message: OutgoingMessage): Promise<void> {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.user && config.password && { auth: { user: config.user, pass: config.password } }),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
  try {
    await transport.sendMail({
      from: { name: message.from.name, address: message.from.address },
      to: message.to,
      ...(message.replyTo && { replyTo: message.replyTo }),
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  } finally {
    transport.close();
  }
}
