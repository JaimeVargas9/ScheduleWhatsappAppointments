import {
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  isLidUser,
  isPnUser,
  jidNormalizedUser,
  type WAMessage,
} from '@whiskeysockets/baileys';

export type OwnIdentity = { pn: string; lid: string | null };

export type Inbound = {
  id: string;
  chatJid: string;
  phone: string;
  fromMe: boolean;
  selfChat: boolean;
  text: string;
};

export const userOf = (jid?: string | null) =>
  jid ? jidNormalizedUser(jid).split('@')[0]!.split(':')[0]! : '';

export function textOf(m: WAMessage): string {
  const msg = m.message?.ephemeralMessage?.message ?? m.message;
  return (
    msg?.conversation ??
    msg?.extendedTextMessage?.text ??
    msg?.imageMessage?.caption ??
    msg?.videoMessage?.caption ??
    ''
  ).trim();
}

export async function normalizeMessage(
  m: WAMessage,
  own: OwnIdentity,
  opts: { type: string; connectedAt: number; lidToPn: (lid: string) => Promise<string | null> },
): Promise<Inbound | { skip: string }> {
  const jid = m.key.remoteJid;
  if (!jid || !m.key.id) return { skip: 'sin_jid' };
  if (isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid) || jid.endsWith('@broadcast'))
    return { skip: 'grupo_estado_difusion' };
  if (opts.type !== 'notify') return { skip: 'historial' };
  if (Number(m.messageTimestamp ?? 0) < opts.connectedAt - 5) return { skip: 'antiguo' };
  const text = textOf(m);
  if (!text) return { skip: 'sin_texto' };

  const chatUser = userOf(jid);
  const selfChat = isLidUser(jid) ? chatUser === own.lid : chatUser === own.pn;
  let phone = chatUser;
  if (selfChat) phone = own.pn;
  else if (isLidUser(jid)) {
    const alt = m.key.remoteJidAlt;
    phone = isPnUser(alt) ? userOf(alt) : userOf((await opts.lidToPn(jid)) ?? jid);
  }
  return { id: m.key.id, chatJid: jid, phone, fromMe: !!m.key.fromMe, selfChat, text };
}
