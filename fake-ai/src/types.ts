// ── Shared types for the Human-as-AI Chat ──────────────────────────────

export interface Env {
  CHAT_LOBBY: DurableObjectNamespace;
  ASSETS: Fetcher;
}

export type Role = 'asker' | 'responder';

// ── Client → Server messages ──────────────────────────────────────────

export interface RegisterMsg {
  type: 'register';
  role: Role;
  clientId: string;
  nickname: string;
}

export interface AskerMessageMsg {
  type: 'asker_message';
  sessionId: string;
  content: string;
}

export interface ResponderMessageMsg {
  type: 'responder_message';
  sessionId: string;
  content: string;
}

export interface ResponderOnlineMsg {
  type: 'responder_online';
}

export interface ResponderOfflineMsg {
  type: 'responder_offline';
}

export interface GetHistoryMsg {
  type: 'get_history';
  sessionId: string;
}

export interface SelectSessionMsg {
  type: 'select_session';
  sessionId: string;
}

export interface PingMsg {
  type: 'ping';
}

export type ClientMsg =
  | RegisterMsg
  | AskerMessageMsg
  | ResponderMessageMsg
  | ResponderOnlineMsg
  | ResponderOfflineMsg
  | GetHistoryMsg
  | SelectSessionMsg
  | PingMsg;

// ── Server → Client messages ──────────────────────────────────────────

export interface RegisteredMsg {
  type: 'registered';
  clientId: string;
  role: Role;
}

export interface SessionCreatedMsg {
  type: 'session_created';
  sessionId: string;
}

export interface MatchedMsg {
  type: 'matched';
  sessionId: string;
  responderNickname: string;
}

export interface WaitingMsg {
  type: 'waiting';
  sessionId: string;
}

export interface ResponderChangedMsg {
  type: 'responder_changed';
  sessionId: string;
  responderNickname: string;
}

export interface NewMessageMsg {
  type: 'new_message';
  sessionId: string;
  message: ChatMessage;
}

export interface HistoryMsg {
  type: 'history';
  sessionId: string;
  messages: ChatMessage[];
}

export interface NewSessionMsg {
  type: 'new_session';
  session: SessionSummary;
}

export interface SessionListMsg {
  type: 'session_list';
  sessions: SessionSummary[];
}

export interface ResponderStatusMsg {
  type: 'responder_status';
  online: boolean;
}

export interface OnlineCountMsg {
  type: 'online_count';
  count: number;
}

export interface ErrorMsg {
  type: 'error';
  message: string;
}

export interface PongMsg {
  type: 'pong';
}

export type ServerMsg =
  | RegisteredMsg
  | SessionCreatedMsg
  | MatchedMsg
  | WaitingMsg
  | ResponderChangedMsg
  | NewMessageMsg
  | HistoryMsg
  | NewSessionMsg
  | SessionListMsg
  | ResponderStatusMsg
  | OnlineCountMsg
  | ErrorMsg
  | PongMsg;

// ── Data structures ───────────────────────────────────────────────────

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: Role;
  senderNickname: string;
  content: string;
  timestamp: number;
}

export interface SessionSummary {
  id: string;
  askerNickname: string;
  responderNickname: string | null;
  status: 'waiting' | 'active';
  lastMessage: string | null;
  lastMessageTime: number | null;
  unread: number;
}
