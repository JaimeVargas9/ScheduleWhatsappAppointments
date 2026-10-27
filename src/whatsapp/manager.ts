import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Boom } from '@hapi/boom';
import makeWASocket, {
  Browsers,
  DisconnectReason,
  generateMessageIDV2,
  isJidBroadcast,
  isJidGroup,
  isJidNewsletter,
  useMultiFileAuthState,
  type WASocket,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { addLog } from '../db/repos.js';
import type { TenantConfig } from '../tenants/schema.js';
import { log } from '../util/log.js';
import { handleInbound, type PipelineDeps, type Transport } from './inbound.js';
import { normalizeMessage, userOf, type OwnIdentity } from './jid.js';

export type WaStatus = 'desconectado' | 'conectando' | 'esperando_qr' | 'conectado' | 'sesion_cerrada';

type Session = {
  sock?: WASocket;
  status: WaStatus;
  qr: string | null;
  own: OwnIdentity | null;
  connectedAt: number;
  retries: number;
  stopped: boolean;
  needsRescan: boolean;
  timer?: NodeJS.Timeout;
};

export class SessionManager {
  private sessions = new Map<string, Session>();

  constructor(
    private deps: PipelineDeps & { sessionsDir: string; getTenant: (id: string) => TenantConfig | undefined },
  ) {}

  async sync(tenants: TenantConfig[]): Promise<void> {
    for (const t of tenants) {
      if (t.activo && !this.sessions.has(t.id)) await this.start(t.id);
      if (!t.activo && this.sessions.has(t.id)) this.stop(t.id);
    }
  }

  async status(tenantId: string) {
    const s = this.sessions.get(tenantId);
    if (!s) return { status: 'desconectado' as WaStatus, qr: null, phone: null, needsRescan: false };
    return {
      status: s.status,
      qr: s.qr ? await QRCode.toDataURL(s.qr, { margin: 1, width: 320 }) : null,
      phone: s.own?.pn ?? null,
      needsRescan: s.needsRescan,
    };
  }

  transport(tenantId: string): Transport | undefined {
    const sock = this.sessions.get(tenantId)?.sock;
    if (!sock) return undefined;
    return {
      newMessageId: () => generateMessageIDV2(sock.user?.id),
      sendText: async (jid, text, messageId) => {
        await sock.sendMessage(jid, { text }, { messageId });
      },
      typing: (jid, on) => sock.sendPresenceUpdate(on ? 'composing' : 'paused', jid),
    };
  }

  stop(tenantId: string): void {
    const s = this.sessions.get(tenantId);
    if (!s) return;
    s.stopped = true;
    clearTimeout(s.timer);
    s.sock?.end(undefined);
    this.sessions.delete(tenantId);
  }

  async logout(tenantId: string): Promise<void> {
    const s = this.sessions.get(tenantId);
    if (s?.sock && s.status === 'conectado') await s.sock.logout().catch(() => undefined);
    this.stop(tenantId);
    rmSync(join(this.deps.sessionsDir, tenantId), { recursive: true, force: true });
    await this.start(tenantId);
  }

  async start(tenantId: string): Promise<void> {
    const existing = this.sessions.get(tenantId);
    const s: Session = existing ?? {
      status: 'conectando',
      qr: null,
      own: null,
      connectedAt: 0,
      retries: 0,
      stopped: false,
      needsRescan: false,
    };
    this.sessions.set(tenantId, s);
    s.status = 'conectando';

    const dir = join(this.deps.sessionsDir, tenantId);
    const { state, saveCreds } = await useMultiFileAuthState(dir);
    const sock = makeWASocket({
      auth: state,
      logger: log.child({ wa: tenantId }, { level: 'error' }),
      browser: Browsers.windows('Desktop'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldIgnoreJid: (jid) => !!(isJidGroup(jid) || isJidBroadcast(jid) || isJidNewsletter(jid)),
      getMessage: async () => undefined,
    });
    s.sock = sock;
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (s.stopped) return;
      if (qr) {
        s.qr = qr;
        s.status = 'esperando_qr';
        log.info(
          { tenant: tenantId },
          'Nuevo QR de WhatsApp: escanéalo desde el panel (WhatsApp → Dispositivos vinculados)',
        );
      }
      if (connection === 'open') {
        s.status = 'conectado';
        s.qr = null;
        s.retries = 0;
        s.needsRescan = false;
        s.connectedAt = Math.floor(Date.now() / 1000);
        s.own = { pn: userOf(sock.user?.id), lid: sock.user?.lid ? userOf(sock.user.lid) : null };
        log.info({ tenant: tenantId }, 'WhatsApp conectado');
        addLog(this.deps.db, 'info', 'whatsapp_conectado', tenantId);
      }
      if (connection === 'close') {
        const code = (lastDisconnect?.error as Boom | undefined)?.output?.statusCode;
        s.sock = undefined;
        if (code === DisconnectReason.loggedOut) {
          s.status = 'sesion_cerrada';
          s.needsRescan = true;
          rmSync(dir, { recursive: true, force: true });
          log.warn(
            { tenant: tenantId },
            '⚠️  La sesión de WhatsApp se ha cerrado o ha caducado. Vuelve a escanear el QR desde el panel.',
          );
          addLog(this.deps.db, 'warn', 'whatsapp_sesion_cerrada', tenantId);
        } else {
          s.status = s.needsRescan ? 'sesion_cerrada' : 'desconectado';
        }
        const waitingForScan = code === DisconnectReason.timedOut && !s.own;
        const delay =
          code === DisconnectReason.restartRequired
            ? 0
            : waitingForScan
              ? 2000
              : Math.min(60_000, 1000 * 2 ** s.retries++);
        log.info({ tenant: tenantId, code, delay }, 'WhatsApp desconectado; reconectando');
        s.timer = setTimeout(() => {
          if (!s.stopped)
            this.start(tenantId).catch((e) => log.error({ err: (e as Error).message }, 'Reconexión fallida'));
        }, delay);
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const m of messages) {
        if (!s.own) continue;
        const tenant = this.deps.getTenant(tenantId);
        if (!tenant) continue;
        const n = await normalizeMessage(m, s.own, {
          type,
          connectedAt: s.connectedAt,
          lidToPn: (lid) => sock.signalRepository.lidMapping.getPNForLID(lid),
        });
        if ('skip' in n) continue;
        const transport = this.transport(tenantId);
        if (!transport) continue;
        handleInbound(this.deps, tenant, n, transport)
          .then((outcome) => log.debug({ tenant: tenantId, outcome }, 'Mensaje procesado'))
          .catch((e) => log.error({ err: (e as Error).message }, 'Error inesperado procesando mensaje'));
      }
    });
  }
}
