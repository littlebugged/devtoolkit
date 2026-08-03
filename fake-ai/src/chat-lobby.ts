import { DurableObject } from 'cloudflare:workers';
import type {
  ClientMsg,
  ServerMsg,
  ChatMessage,
  SessionSummary,
  Role,
} from './types';

// ── Constants ─────────────────────────────────────────────────────────

const MAX_MESSAGE_LENGTH = 2000;
const MAX_CONCURRENT_SESSIONS = 5; // per responder
const HEARTBEAT_TIMEOUT_MS = 90_000; // 90s without ping = offline
const DATA_RETENTION_DAYS = 7;

// ── Internal state types ──────────────────────────────────────────────

interface ClientState {
  clientId: string;
  nickname: string;
  role: Role;
  ws: WebSocket;
  online: boolean;
  lastPing: number;
  // asker: their current session id
  // responder: set of session ids they're handling
  sessionId?: string;
  responderSessions: Set<string>;
  // unread tracking for responder sessions
  unreadMap: Map<string, number>;
}

interface SessionState {
  id: string;
  askerId: string;
  askerNickname: string;
  responderId: string | null;
  responderNickname: string | null;
  status: 'waiting' | 'active';
  createdAt: number;
}

// ── ChatLobby Durable Object ──────────────────────────────────────────

export class ChatLobby extends DurableObject {
  private clients = new Map<WebSocket, ClientState>();
  private clientsById = new Map<string, ClientState>();
  private sessions = new Map<string, SessionState>();
  private waitingQueue: string[] = []; // session ids waiting for a responder
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // ── Lifecycle ───────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get('Upgrade');
    if (upgrade !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    // Init SQLite tables (idempotent)
    this.initDb();

    // Start heartbeat checker
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), 30_000);
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    server.accept();

    server.addEventListener('message', (event) => {
      this.handleMessage(server, event.data as string).catch((err) => {
        console.error('Message handler error:', err);
      });
    });

    server.addEventListener('close', () => {
      this.handleDisconnect(server);
    });

    server.addEventListener('error', (err) => {
      console.error('WebSocket error:', err);
      this.handleDisconnect(server);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // ── SQLite persistence ──────────────────────────────────────────────

  private initDb(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        sender_nickname TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `);
    sql.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_session
      ON messages (session_id, timestamp)
    `);
    sql.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        asker_id TEXT NOT NULL,
        asker_nickname TEXT NOT NULL,
        responder_id TEXT,
        responder_nickname TEXT,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  private persistMessage(msg: ChatMessage): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `INSERT INTO messages (id, session_id, role, sender_nickname, content, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      msg.id,
      msg.sessionId,
      msg.role,
      msg.senderNickname,
      msg.content,
      msg.timestamp,
    );
  }

  private loadMessages(sessionId: string): ChatMessage[] {
    const sql = this.ctx.storage.sql;
    const cursor = sql.exec(
      `SELECT id, session_id, role, sender_nickname, content, timestamp
       FROM messages WHERE session_id = ? ORDER BY timestamp ASC`,
      sessionId,
    );
    const messages: ChatMessage[] = [];
    for (const row of cursor) {
      messages.push({
        id: row.id as string,
        sessionId: row.session_id as string,
        role: row.role as Role,
        senderNickname: row.sender_nickname as string,
        content: row.content as string,
        timestamp: row.timestamp as number,
      });
    }
    return messages;
  }

  private persistSession(session: SessionState): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `INSERT OR REPLACE INTO sessions
       (id, asker_id, asker_nickname, responder_id, responder_nickname, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      session.id,
      session.askerId,
      session.askerNickname,
      session.responderId,
      session.responderNickname,
      session.status,
      session.createdAt,
      Date.now(),
    );
  }

  // ── Message handling ────────────────────────────────────────────────

  private async handleMessage(ws: WebSocket, raw: string): Promise<void> {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw) as ClientMsg;
    } catch {
      this.send(ws, { type: 'error', message: 'Invalid JSON' });
      return;
    }

    switch (msg.type) {
      case 'ping':
        this.send(ws, { type: 'pong' });
        break;

      case 'register':
        this.handleRegister(ws, msg);
        break;

      case 'asker_message':
        this.handleAskerMessage(ws, msg);
        break;

      case 'responder_message':
        this.handleResponderMessage(ws, msg);
        break;

      case 'responder_online':
        this.handleResponderOnline(ws);
        break;

      case 'responder_offline':
        this.handleResponderOffline(ws);
        break;

      case 'get_history':
        this.handleGetHistory(ws, msg);
        break;

      case 'select_session':
        this.handleSelectSession(ws, msg);
        break;

      default:
        this.send(ws, { type: 'error', message: `Unknown message type` });
    }
  }

  // ── Registration ────────────────────────────────────────────────────

  private handleRegister(
    ws: WebSocket,
    msg: { role: Role; clientId: string; nickname: string },
  ): void {
    // If this ws already has a client, clean up first
    const existing = this.clients.get(ws);
    if (existing) {
      this.removeClient(ws);
    }

    // If clientId already registered (reconnect), update ws
    const prev = this.clientsById.get(msg.clientId);
    if (prev) {
      // Close old connection
      if (prev.ws !== ws) {
        try {
          prev.ws.close();
        } catch {
          // ignore
        }
        this.clients.delete(prev.ws);
      }
    }

    const client: ClientState = {
      clientId: msg.clientId,
      nickname: msg.nickname,
      role: msg.role,
      ws,
      online: msg.role === 'asker', // askers are "online" immediately; responders need explicit online
      lastPing: Date.now(),
      responderSessions: prev?.responderSessions ?? new Set(),
      unreadMap: prev?.unreadMap ?? new Map(),
      sessionId: prev?.sessionId,
    };

    this.clients.set(ws, client);
    this.clientsById.set(msg.clientId, client);

    this.send(ws, {
      type: 'registered',
      clientId: msg.clientId,
      role: msg.role,
    });

    // If responder reconnects and was online, restore online state
    if (msg.role === 'responder' && prev?.online) {
      client.online = true;
      this.send(ws, { type: 'responder_status', online: true });
      this.processQueue(client);
    }

    // If asker reconnects and had a session, send session info
    if (msg.role === 'asker' && client.sessionId) {
      const session = this.sessions.get(client.sessionId);
      if (session) {
        this.send(ws, { type: 'session_created', sessionId: session.id });
        if (session.status === 'waiting') {
          this.send(ws, { type: 'waiting', sessionId: session.id });
        } else if (session.responderNickname) {
          this.send(ws, {
            type: 'matched',
            sessionId: session.id,
            responderNickname: session.responderNickname,
          });
        }
        // Send history
        const messages = this.loadMessages(session.id);
        this.send(ws, {
          type: 'history',
          sessionId: session.id,
          messages,
        });
      }
    }

    // If responder reconnects, send their session list
    if (msg.role === 'responder' && client.responderSessions.size > 0) {
      this.sendSessionList(client);
    }

    this.broadcastOnlineCount();
  }

  // ── Asker sends message ─────────────────────────────────────────────

  private handleAskerMessage(
    ws: WebSocket,
    msg: { sessionId: string; content: string },
  ): void {
    const client = this.clients.get(ws);
    if (!client || client.role !== 'asker') {
      this.send(ws, { type: 'error', message: 'Not registered as asker' });
      return;
    }

    const content = msg.content.trim();
    if (!content) return;
    if (content.length > MAX_MESSAGE_LENGTH) {
      this.send(ws, {
        type: 'error',
        message: `消息不能超过 ${MAX_MESSAGE_LENGTH} 字`,
      });
      return;
    }

    let session = this.sessions.get(msg.sessionId);

    // Create new session if needed
    if (!session) {
      session = {
        id: msg.sessionId,
        askerId: client.clientId,
        askerNickname: client.nickname,
        responderId: null,
        responderNickname: null,
        status: 'waiting',
        createdAt: Date.now(),
      };
      this.sessions.set(session.id, session);
      client.sessionId = session.id;
      this.persistSession(session);
      this.send(ws, { type: 'session_created', sessionId: session.id });
    }

    // Create and persist the message
    const chatMsg: ChatMessage = {
      id: this.genId(),
      sessionId: session.id,
      role: 'asker',
      senderNickname: client.nickname,
      content,
      timestamp: Date.now(),
    };
    this.persistMessage(chatMsg);

    // Try to match / route
    if (!session.responderId) {
      // First question or previously unmatched
      const responder = this.pickOnlineResponder();
      if (responder) {
        this.bindSession(session, responder);
        this.send(ws, {
          type: 'matched',
          sessionId: session.id,
          responderNickname: responder.nickname,
        });
        this.pushToResponder(responder, session, chatMsg);
      } else {
        // No responder available, enqueue
        if (!this.waitingQueue.includes(session.id)) {
          this.waitingQueue.push(session.id);
        }
        this.send(ws, { type: 'waiting', sessionId: session.id });
      }
    } else {
      // Session already has a responder — check if still online
      const responder = this.clientsById.get(session.responderId);
      if (responder && responder.online) {
        // Sticky: same responder
        this.pushToResponder(responder, session, chatMsg);
      } else {
        // Responder offline — reassign
        const newResponder = this.pickOnlineResponder();
        if (newResponder) {
          this.bindSession(session, newResponder);
          this.send(ws, {
            type: 'responder_changed',
            sessionId: session.id,
            responderNickname: newResponder.nickname,
          });
          this.pushToResponder(newResponder, session, chatMsg);
        } else {
          // No one available, enqueue
          session.responderId = null;
          session.responderNickname = null;
          session.status = 'waiting';
          this.persistSession(session);
          if (!this.waitingQueue.includes(session.id)) {
            this.waitingQueue.push(session.id);
          }
          this.send(ws, { type: 'waiting', sessionId: session.id });
        }
      }
    }
  }

  // ── Responder sends message ─────────────────────────────────────────

  private handleResponderMessage(
    ws: WebSocket,
    msg: { sessionId: string; content: string },
  ): void {
    const client = this.clients.get(ws);
    if (!client || client.role !== 'responder') {
      this.send(ws, { type: 'error', message: 'Not registered as responder' });
      return;
    }

    const content = msg.content.trim();
    if (!content) return;
    if (content.length > MAX_MESSAGE_LENGTH) {
      this.send(ws, {
        type: 'error',
        message: `消息不能超过 ${MAX_MESSAGE_LENGTH} 字`,
      });
      return;
    }

    const session = this.sessions.get(msg.sessionId);
    if (!session || session.responderId !== client.clientId) {
      this.send(ws, { type: 'error', message: '会话不存在或无权回复' });
      return;
    }

    const chatMsg: ChatMessage = {
      id: this.genId(),
      sessionId: session.id,
      role: 'responder',
      senderNickname: client.nickname,
      content,
      timestamp: Date.now(),
    };
    this.persistMessage(chatMsg);

    // Push to asker
    const asker = this.clientsById.get(session.askerId);
    if (asker && asker.online) {
      this.send(asker.ws, {
        type: 'new_message',
        sessionId: session.id,
        message: chatMsg,
      });
    }
    // MVP: if asker offline, message is persisted but not pushed (no offline delivery)

    // Confirm to responder (echo back)
    this.send(ws, {
      type: 'new_message',
      sessionId: session.id,
      message: chatMsg,
    });

    // Update session list for responder (last message preview)
    this.sendSessionList(client);
  }

  // ── Responder online/offline ────────────────────────────────────────

  private handleResponderOnline(ws: WebSocket): void {
    const client = this.clients.get(ws);
    if (!client || client.role !== 'responder') return;

    client.online = true;
    client.lastPing = Date.now();
    this.send(ws, { type: 'responder_status', online: true });

    // Process waiting queue
    this.processQueue(client);
    this.broadcastOnlineCount();
  }

  private handleResponderOffline(ws: WebSocket): void {
    const client = this.clients.get(ws);
    if (!client || client.role !== 'responder') return;

    client.online = false;
    this.send(ws, { type: 'responder_status', online: false });
    this.broadcastOnlineCount();
  }

  // ── History ─────────────────────────────────────────────────────────

  private handleGetHistory(
    ws: WebSocket,
    msg: { sessionId: string },
  ): void {
    const messages = this.loadMessages(msg.sessionId);
    this.send(ws, {
      type: 'history',
      sessionId: msg.sessionId,
      messages,
    });
  }

  // ── Responder selects a session ─────────────────────────────────────

  private handleSelectSession(
    ws: WebSocket,
    msg: { sessionId: string },
  ): void {
    const client = this.clients.get(ws);
    if (!client || client.role !== 'responder') return;

    // Clear unread for this session
    client.unreadMap.set(msg.sessionId, 0);
    this.sendSessionList(client);
  }

  // ── Matching logic ──────────────────────────────────────────────────

  private pickOnlineResponder(): ClientState | null {
    const candidates: ClientState[] = [];
    for (const client of this.clientsById.values()) {
      if (
        client.role === 'responder' &&
        client.online &&
        client.responderSessions.size < MAX_CONCURRENT_SESSIONS
      ) {
        candidates.push(client);
      }
    }
    if (candidates.length === 0) return null;
    // Random selection
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  private bindSession(
    session: SessionState,
    responder: ClientState,
  ): void {
    // Remove from old responder's set if reassigning
    if (session.responderId) {
      const oldResponder = this.clientsById.get(session.responderId);
      if (oldResponder) {
        oldResponder.responderSessions.delete(session.id);
        this.sendSessionList(oldResponder);
      }
    }

    session.responderId = responder.clientId;
    session.responderNickname = responder.nickname;
    session.status = 'active';
    responder.responderSessions.add(session.id);
    this.persistSession(session);

    // Notify responder of new session
    this.send(responder.ws, {
      type: 'new_session',
      session: this.toSessionSummary(session, responder),
    });
    this.sendSessionList(responder);
  }

  private processQueue(responder: ClientState): void {
    while (
      responder.responderSessions.size < MAX_CONCURRENT_SESSIONS &&
      this.waitingQueue.length > 0
    ) {
      const sessionId = this.waitingQueue.shift()!;
      const session = this.sessions.get(sessionId);
      if (!session) continue;

      this.bindSession(session, responder);

      // Notify asker they've been matched
      const asker = this.clientsById.get(session.askerId);
      if (asker && asker.online) {
        this.send(asker.ws, {
          type: 'matched',
          sessionId: session.id,
          responderNickname: responder.nickname,
        });
      }

      // Push all pending messages to responder
      const messages = this.loadMessages(session.id);
      this.send(responder.ws, {
        type: 'history',
        sessionId: session.id,
        messages,
      });
    }
  }

  private pushToResponder(
    responder: ClientState,
    session: SessionState,
    msg: ChatMessage,
  ): void {
    this.send(responder.ws, {
      type: 'new_message',
      sessionId: session.id,
      message: msg,
    });

    // Increment unread if responder isn't viewing this session
    const currentUnread = responder.unreadMap.get(session.id) ?? 0;
    responder.unreadMap.set(session.id, currentUnread + 1);
    this.sendSessionList(responder);
  }

  // ── Disconnect ──────────────────────────────────────────────────────

  private handleDisconnect(ws: WebSocket): void {
    const client = this.clients.get(ws);
    if (!client) return;
    this.removeClient(ws);
  }

  private removeClient(ws: WebSocket): void {
    const client = this.clients.get(ws);
    if (!client) return;

    this.clients.delete(ws);

    if (client.role === 'responder') {
      client.online = false;
      // Sessions remain bound for stickiness, but responder is offline
      // Asker follow-ups will trigger reassignment
      this.broadcastOnlineCount();
    }

    // Only remove from clientsById if this is the current connection
    const current = this.clientsById.get(client.clientId);
    if (current && current.ws === ws) {
      // Keep the clientById entry so reconnect can restore state,
      // but mark as disconnected
      client.ws = ws; // keep reference for cleanup
      // Actually, we should remove it so reconnect creates fresh
      this.clientsById.delete(client.clientId);
    }
  }

  // ── Heartbeat ───────────────────────────────────────────────────────

  private checkHeartbeats(): void {
    const now = Date.now();
    const expired: WebSocket[] = [];

    for (const [ws, client] of this.clients) {
      if (now - client.lastPing > HEARTBEAT_TIMEOUT_MS) {
        expired.push(ws);
      }
    }

    for (const ws of expired) {
      try {
        ws.close(1001, 'Heartbeat timeout');
      } catch {
        // ignore
      }
      this.handleDisconnect(ws);
    }

    // Clean up old data (lazy)
    this.cleanupOldData();
  }

  private cleanupOldData(): void {
    const cutoff = Date.now() - DATA_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const sql = this.ctx.storage.sql;
    sql.exec('DELETE FROM messages WHERE timestamp < ?', cutoff);
    sql.exec('DELETE FROM sessions WHERE updated_at < ?', cutoff);
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private send(ws: WebSocket, msg: ServerMsg): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // connection might be closed
    }
  }

  private broadcastOnlineCount(): void {
    let count = 0;
    for (const client of this.clientsById.values()) {
      if (client.role === 'responder' && client.online) count++;
    }
    const msg: ServerMsg = { type: 'online_count', count };
    for (const client of this.clients.values()) {
      if (client.role === 'asker') {
        this.send(client.ws, msg);
      }
    }
  }

  private toSessionSummary(
    session: SessionState,
    responder: ClientState,
  ): SessionSummary {
    // Get last message from DB
    const sql = this.ctx.storage.sql;
    const cursor = sql.exec(
      `SELECT content, timestamp FROM messages WHERE session_id = ?
       ORDER BY timestamp DESC LIMIT 1`,
      session.id,
    );
    let lastMessage: string | null = null;
    let lastMessageTime: number | null = null;
    for (const row of cursor) {
      lastMessage = row.content as string;
      lastMessageTime = row.timestamp as number;
    }

    return {
      id: session.id,
      askerNickname: session.askerNickname,
      responderNickname: session.responderNickname,
      status: session.status,
      lastMessage,
      lastMessageTime,
      unread: responder.unreadMap.get(session.id) ?? 0,
    };
  }

  private sendSessionList(responder: ClientState): void {
    const summaries: SessionSummary[] = [];
    for (const sessionId of responder.responderSessions) {
      const session = this.sessions.get(sessionId);
      if (session) {
        summaries.push(this.toSessionSummary(session, responder));
      }
    }
    // Sort by last message time descending
    summaries.sort(
      (a, b) => (b.lastMessageTime ?? 0) - (a.lastMessageTime ?? 0),
    );
    this.send(responder.ws, { type: 'session_list', sessions: summaries });
  }

  private genId(): string {
    return (
      Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
    );
  }
}
