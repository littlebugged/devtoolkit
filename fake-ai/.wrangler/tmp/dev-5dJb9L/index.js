var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// .wrangler/tmp/bundle-zg3fF1/strip-cf-connecting-ip-header.js
function stripCfConnectingIPHeader(input, init) {
  const request = new Request(input, init);
  request.headers.delete("CF-Connecting-IP");
  return request;
}
__name(stripCfConnectingIPHeader, "stripCfConnectingIPHeader");
globalThis.fetch = new Proxy(globalThis.fetch, {
  apply(target, thisArg, argArray) {
    return Reflect.apply(target, thisArg, [
      stripCfConnectingIPHeader.apply(null, argArray)
    ]);
  }
});

// src/chat-lobby.ts
import { DurableObject } from "cloudflare:workers";
var MAX_MESSAGE_LENGTH = 2e3;
var MAX_CONCURRENT_SESSIONS = 5;
var HEARTBEAT_TIMEOUT_MS = 9e4;
var DATA_RETENTION_DAYS = 7;
var ChatLobby = class extends DurableObject {
  clients = /* @__PURE__ */ new Map();
  clientsById = /* @__PURE__ */ new Map();
  sessions = /* @__PURE__ */ new Map();
  waitingQueue = [];
  // session ids waiting for a responder
  heartbeatTimer = null;
  // ── Lifecycle ───────────────────────────────────────────────────────
  async fetch(request) {
    const upgrade = request.headers.get("Upgrade");
    if (upgrade !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    this.initDb();
    if (!this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), 3e4);
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    server.addEventListener("message", (event) => {
      this.handleMessage(server, event.data).catch((err) => {
        console.error("Message handler error:", err);
      });
    });
    server.addEventListener("close", () => {
      this.handleDisconnect(server);
    });
    server.addEventListener("error", (err) => {
      console.error("WebSocket error:", err);
      this.handleDisconnect(server);
    });
    return new Response(null, { status: 101, webSocket: client });
  }
  // ── SQLite persistence ──────────────────────────────────────────────
  initDb() {
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
  persistMessage(msg) {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `INSERT INTO messages (id, session_id, role, sender_nickname, content, timestamp)
       VALUES (?, ?, ?, ?, ?, ?)`,
      msg.id,
      msg.sessionId,
      msg.role,
      msg.senderNickname,
      msg.content,
      msg.timestamp
    );
  }
  loadMessages(sessionId) {
    const sql = this.ctx.storage.sql;
    const cursor = sql.exec(
      `SELECT id, session_id, role, sender_nickname, content, timestamp
       FROM messages WHERE session_id = ? ORDER BY timestamp ASC`,
      sessionId
    );
    const messages = [];
    for (const row of cursor) {
      messages.push({
        id: row.id,
        sessionId: row.session_id,
        role: row.role,
        senderNickname: row.sender_nickname,
        content: row.content,
        timestamp: row.timestamp
      });
    }
    return messages;
  }
  persistSession(session) {
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
      Date.now()
    );
  }
  // ── Message handling ────────────────────────────────────────────────
  async handleMessage(ws, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.send(ws, { type: "error", message: "Invalid JSON" });
      return;
    }
    switch (msg.type) {
      case "ping":
        this.send(ws, { type: "pong" });
        break;
      case "register":
        this.handleRegister(ws, msg);
        break;
      case "asker_message":
        this.handleAskerMessage(ws, msg);
        break;
      case "responder_message":
        this.handleResponderMessage(ws, msg);
        break;
      case "responder_online":
        this.handleResponderOnline(ws);
        break;
      case "responder_offline":
        this.handleResponderOffline(ws);
        break;
      case "get_history":
        this.handleGetHistory(ws, msg);
        break;
      case "select_session":
        this.handleSelectSession(ws, msg);
        break;
      default:
        this.send(ws, { type: "error", message: `Unknown message type` });
    }
  }
  // ── Registration ────────────────────────────────────────────────────
  handleRegister(ws, msg) {
    const existing = this.clients.get(ws);
    if (existing) {
      this.removeClient(ws);
    }
    const prev = this.clientsById.get(msg.clientId);
    if (prev) {
      if (prev.ws !== ws) {
        try {
          prev.ws.close();
        } catch {
        }
        this.clients.delete(prev.ws);
      }
    }
    const client = {
      clientId: msg.clientId,
      nickname: msg.nickname,
      role: msg.role,
      ws,
      online: msg.role === "asker",
      // askers are "online" immediately; responders need explicit online
      lastPing: Date.now(),
      responderSessions: prev?.responderSessions ?? /* @__PURE__ */ new Set(),
      unreadMap: prev?.unreadMap ?? /* @__PURE__ */ new Map(),
      sessionId: prev?.sessionId
    };
    this.clients.set(ws, client);
    this.clientsById.set(msg.clientId, client);
    this.send(ws, {
      type: "registered",
      clientId: msg.clientId,
      role: msg.role
    });
    if (msg.role === "responder" && prev?.online) {
      client.online = true;
      this.send(ws, { type: "responder_status", online: true });
      this.processQueue(client);
    }
    if (msg.role === "asker" && client.sessionId) {
      const session = this.sessions.get(client.sessionId);
      if (session) {
        this.send(ws, { type: "session_created", sessionId: session.id });
        if (session.status === "waiting") {
          this.send(ws, { type: "waiting", sessionId: session.id });
        } else if (session.responderNickname) {
          this.send(ws, {
            type: "matched",
            sessionId: session.id,
            responderNickname: session.responderNickname
          });
        }
        const messages = this.loadMessages(session.id);
        this.send(ws, {
          type: "history",
          sessionId: session.id,
          messages
        });
      }
    }
    if (msg.role === "responder" && client.responderSessions.size > 0) {
      this.sendSessionList(client);
    }
    this.broadcastOnlineCount();
  }
  // ── Asker sends message ─────────────────────────────────────────────
  handleAskerMessage(ws, msg) {
    const client = this.clients.get(ws);
    if (!client || client.role !== "asker") {
      this.send(ws, { type: "error", message: "Not registered as asker" });
      return;
    }
    const content = msg.content.trim();
    if (!content)
      return;
    if (content.length > MAX_MESSAGE_LENGTH) {
      this.send(ws, {
        type: "error",
        message: `\u6D88\u606F\u4E0D\u80FD\u8D85\u8FC7 ${MAX_MESSAGE_LENGTH} \u5B57`
      });
      return;
    }
    let session = this.sessions.get(msg.sessionId);
    if (!session) {
      session = {
        id: msg.sessionId,
        askerId: client.clientId,
        askerNickname: client.nickname,
        responderId: null,
        responderNickname: null,
        status: "waiting",
        createdAt: Date.now()
      };
      this.sessions.set(session.id, session);
      client.sessionId = session.id;
      this.persistSession(session);
      this.send(ws, { type: "session_created", sessionId: session.id });
    }
    const chatMsg = {
      id: this.genId(),
      sessionId: session.id,
      role: "asker",
      senderNickname: client.nickname,
      content,
      timestamp: Date.now()
    };
    this.persistMessage(chatMsg);
    if (!session.responderId) {
      const responder = this.pickOnlineResponder();
      if (responder) {
        this.bindSession(session, responder);
        this.send(ws, {
          type: "matched",
          sessionId: session.id,
          responderNickname: responder.nickname
        });
        this.pushToResponder(responder, session, chatMsg);
      } else {
        if (!this.waitingQueue.includes(session.id)) {
          this.waitingQueue.push(session.id);
        }
        this.send(ws, { type: "waiting", sessionId: session.id });
      }
    } else {
      const responder = this.clientsById.get(session.responderId);
      if (responder && responder.online) {
        this.pushToResponder(responder, session, chatMsg);
      } else {
        const newResponder = this.pickOnlineResponder();
        if (newResponder) {
          this.bindSession(session, newResponder);
          this.send(ws, {
            type: "responder_changed",
            sessionId: session.id,
            responderNickname: newResponder.nickname
          });
          this.pushToResponder(newResponder, session, chatMsg);
        } else {
          session.responderId = null;
          session.responderNickname = null;
          session.status = "waiting";
          this.persistSession(session);
          if (!this.waitingQueue.includes(session.id)) {
            this.waitingQueue.push(session.id);
          }
          this.send(ws, { type: "waiting", sessionId: session.id });
        }
      }
    }
  }
  // ── Responder sends message ─────────────────────────────────────────
  handleResponderMessage(ws, msg) {
    const client = this.clients.get(ws);
    if (!client || client.role !== "responder") {
      this.send(ws, { type: "error", message: "Not registered as responder" });
      return;
    }
    const content = msg.content.trim();
    if (!content)
      return;
    if (content.length > MAX_MESSAGE_LENGTH) {
      this.send(ws, {
        type: "error",
        message: `\u6D88\u606F\u4E0D\u80FD\u8D85\u8FC7 ${MAX_MESSAGE_LENGTH} \u5B57`
      });
      return;
    }
    const session = this.sessions.get(msg.sessionId);
    if (!session || session.responderId !== client.clientId) {
      this.send(ws, { type: "error", message: "\u4F1A\u8BDD\u4E0D\u5B58\u5728\u6216\u65E0\u6743\u56DE\u590D" });
      return;
    }
    const chatMsg = {
      id: this.genId(),
      sessionId: session.id,
      role: "responder",
      senderNickname: client.nickname,
      content,
      timestamp: Date.now()
    };
    this.persistMessage(chatMsg);
    const asker = this.clientsById.get(session.askerId);
    if (asker && asker.online) {
      this.send(asker.ws, {
        type: "new_message",
        sessionId: session.id,
        message: chatMsg
      });
    }
    this.send(ws, {
      type: "new_message",
      sessionId: session.id,
      message: chatMsg
    });
    this.sendSessionList(client);
  }
  // ── Responder online/offline ────────────────────────────────────────
  handleResponderOnline(ws) {
    const client = this.clients.get(ws);
    if (!client || client.role !== "responder")
      return;
    client.online = true;
    client.lastPing = Date.now();
    this.send(ws, { type: "responder_status", online: true });
    this.processQueue(client);
    this.broadcastOnlineCount();
  }
  handleResponderOffline(ws) {
    const client = this.clients.get(ws);
    if (!client || client.role !== "responder")
      return;
    client.online = false;
    this.send(ws, { type: "responder_status", online: false });
    this.broadcastOnlineCount();
  }
  // ── History ─────────────────────────────────────────────────────────
  handleGetHistory(ws, msg) {
    const messages = this.loadMessages(msg.sessionId);
    this.send(ws, {
      type: "history",
      sessionId: msg.sessionId,
      messages
    });
  }
  // ── Responder selects a session ─────────────────────────────────────
  handleSelectSession(ws, msg) {
    const client = this.clients.get(ws);
    if (!client || client.role !== "responder")
      return;
    client.unreadMap.set(msg.sessionId, 0);
    this.sendSessionList(client);
  }
  // ── Matching logic ──────────────────────────────────────────────────
  pickOnlineResponder() {
    const candidates = [];
    for (const client of this.clientsById.values()) {
      if (client.role === "responder" && client.online && client.responderSessions.size < MAX_CONCURRENT_SESSIONS) {
        candidates.push(client);
      }
    }
    if (candidates.length === 0)
      return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
  bindSession(session, responder) {
    if (session.responderId) {
      const oldResponder = this.clientsById.get(session.responderId);
      if (oldResponder) {
        oldResponder.responderSessions.delete(session.id);
        this.sendSessionList(oldResponder);
      }
    }
    session.responderId = responder.clientId;
    session.responderNickname = responder.nickname;
    session.status = "active";
    responder.responderSessions.add(session.id);
    this.persistSession(session);
    this.send(responder.ws, {
      type: "new_session",
      session: this.toSessionSummary(session, responder)
    });
    this.sendSessionList(responder);
  }
  processQueue(responder) {
    while (responder.responderSessions.size < MAX_CONCURRENT_SESSIONS && this.waitingQueue.length > 0) {
      const sessionId = this.waitingQueue.shift();
      const session = this.sessions.get(sessionId);
      if (!session)
        continue;
      this.bindSession(session, responder);
      const asker = this.clientsById.get(session.askerId);
      if (asker && asker.online) {
        this.send(asker.ws, {
          type: "matched",
          sessionId: session.id,
          responderNickname: responder.nickname
        });
      }
      const messages = this.loadMessages(session.id);
      this.send(responder.ws, {
        type: "history",
        sessionId: session.id,
        messages
      });
    }
  }
  pushToResponder(responder, session, msg) {
    this.send(responder.ws, {
      type: "new_message",
      sessionId: session.id,
      message: msg
    });
    const currentUnread = responder.unreadMap.get(session.id) ?? 0;
    responder.unreadMap.set(session.id, currentUnread + 1);
    this.sendSessionList(responder);
  }
  // ── Disconnect ──────────────────────────────────────────────────────
  handleDisconnect(ws) {
    const client = this.clients.get(ws);
    if (!client)
      return;
    this.removeClient(ws);
  }
  removeClient(ws) {
    const client = this.clients.get(ws);
    if (!client)
      return;
    this.clients.delete(ws);
    if (client.role === "responder") {
      client.online = false;
      this.broadcastOnlineCount();
    }
    const current = this.clientsById.get(client.clientId);
    if (current && current.ws === ws) {
      client.ws = ws;
      this.clientsById.delete(client.clientId);
    }
  }
  // ── Heartbeat ───────────────────────────────────────────────────────
  checkHeartbeats() {
    const now = Date.now();
    const expired = [];
    for (const [ws, client] of this.clients) {
      if (now - client.lastPing > HEARTBEAT_TIMEOUT_MS) {
        expired.push(ws);
      }
    }
    for (const ws of expired) {
      try {
        ws.close(1001, "Heartbeat timeout");
      } catch {
      }
      this.handleDisconnect(ws);
    }
    this.cleanupOldData();
  }
  cleanupOldData() {
    const cutoff = Date.now() - DATA_RETENTION_DAYS * 24 * 60 * 60 * 1e3;
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM messages WHERE timestamp < ?", cutoff);
    sql.exec("DELETE FROM sessions WHERE updated_at < ?", cutoff);
  }
  // ── Helpers ─────────────────────────────────────────────────────────
  send(ws, msg) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
    }
  }
  broadcastOnlineCount() {
    let count = 0;
    for (const client of this.clientsById.values()) {
      if (client.role === "responder" && client.online)
        count++;
    }
    const msg = { type: "online_count", count };
    for (const client of this.clients.values()) {
      if (client.role === "asker") {
        this.send(client.ws, msg);
      }
    }
  }
  toSessionSummary(session, responder) {
    const sql = this.ctx.storage.sql;
    const cursor = sql.exec(
      `SELECT content, timestamp FROM messages WHERE session_id = ?
       ORDER BY timestamp DESC LIMIT 1`,
      session.id
    );
    let lastMessage = null;
    let lastMessageTime = null;
    for (const row of cursor) {
      lastMessage = row.content;
      lastMessageTime = row.timestamp;
    }
    return {
      id: session.id,
      askerNickname: session.askerNickname,
      responderNickname: session.responderNickname,
      status: session.status,
      lastMessage,
      lastMessageTime,
      unread: responder.unreadMap.get(session.id) ?? 0
    };
  }
  sendSessionList(responder) {
    const summaries = [];
    for (const sessionId of responder.responderSessions) {
      const session = this.sessions.get(sessionId);
      if (session) {
        summaries.push(this.toSessionSummary(session, responder));
      }
    }
    summaries.sort(
      (a, b) => (b.lastMessageTime ?? 0) - (a.lastMessageTime ?? 0)
    );
    this.send(responder.ws, { type: "session_list", sessions: summaries });
  }
  genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }
};
__name(ChatLobby, "ChatLobby");

// src/index.ts
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const id = env.CHAT_LOBBY.idFromName("global");
      const stub = env.CHAT_LOBBY.get(id);
      return stub.fetch(request);
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Not found", { status: 404 });
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-zg3fF1/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = src_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-zg3fF1/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof __Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
__name(__Facade_ScheduledController__, "__Facade_ScheduledController__");
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = (request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    };
    #dispatcher = (type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    };
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  ChatLobby,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
