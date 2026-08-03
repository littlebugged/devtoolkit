// ── AI 人 · Frontend Application ───────────────────────────────────────

(function () {
  'use strict';

  // ── Nickname generation ──────────────────────────────────────────────

  const ADJECTIVES = [
    '快乐的', '好奇的', '神秘的', '懒散的', '认真的', '调皮的',
    '安静的', '活泼的', '温柔的', '酷酷的', '迷糊的', '机灵的',
    'Sleepy', 'Curious', 'Cosmic', 'Neon', 'Zen', 'Pixel',
    'Cyber', 'Fuzzy', 'Bold', 'Calm', 'Witty', 'Quirky',
  ];

  const ANIMALS = [
    '考拉', '企鹅', '柴犬', '猫头鹰', '水豚', '小熊猫',
    '海豚', '狐狸', '树懒', '章鱼', '仓鼠', '羊驼',
    'Panda', 'Lynx', 'Otter', 'Falcon', 'Koala', 'Hedgehog',
    'Orca', 'Fox', 'Owl', 'Lemur', 'Gecko', 'Bison',
  ];

  function randomNickname() {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    return adj + animal;
  }

  function genId() {
    return (
      Date.now().toString(36) + Math.random().toString(36).slice(2, 10)
    );
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Application state ────────────────────────────────────────────────

  const state = {
    clientId: localStorage.getItem('fa_clientId') || genId(),
    nickname: localStorage.getItem('fa_nickname') || randomNickname(),
    role: null,
    ws: null,
    connected: false,
    registered: false,

    // Asker state
    sessionId: localStorage.getItem('fa_sessionId') || null,
    askerMessages: [],
    askerStatus: 'idle', // idle | waiting | matched | changed

    // Responder state
    responderOnline: false,
    responderSessions: [],
    activeSessionId: null,
    responderMessages: {}, // sessionId -> messages[]

    // General
    onlineCount: 0,
    toastTimer: null,
    reconnectTimer: null,
    pingTimer: null,
  };

  localStorage.setItem('fa_clientId', state.clientId);
  localStorage.setItem('fa_nickname', state.nickname);

  // ── WebSocket management ─────────────────────────────────────────────

  function getWsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws';
  }

  function connect() {
    if (state.ws) {
      try { state.ws.close(); } catch (e) {}
    }

    showConnecting();

    const ws = new WebSocket(getWsUrl());
    state.ws = ws;

    ws.onopen = function () {
      state.connected = true;
      hideConnecting();
      // Register with server
      send({
        type: 'register',
        role: state.role,
        clientId: state.clientId,
        nickname: state.nickname,
      });
      // Start heartbeat
      startPing();
    };

    ws.onmessage = function (event) {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        return;
      }
      handleServerMessage(msg);
    };

    ws.onclose = function () {
      state.connected = false;
      state.registered = false;
      stopPing();
      // Reconnect after delay
      if (state.role) {
        scheduleReconnect();
      }
    };

    ws.onerror = function () {
      // onclose will handle reconnect
    };
  }

  function send(msg) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(msg));
    }
  }

  function startPing() {
    stopPing();
    state.pingTimer = setInterval(function () {
      send({ type: 'ping' });
    }, 30000);
  }

  function stopPing() {
    if (state.pingTimer) {
      clearInterval(state.pingTimer);
      state.pingTimer = null;
    }
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) return;
    showConnecting('连接断开，正在重连...');
    state.reconnectTimer = setTimeout(function () {
      state.reconnectTimer = null;
      connect();
    }, 2000);
  }

  // ── Server message handler ───────────────────────────────────────────

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'registered':
        state.registered = true;
        break;

      case 'session_created':
        state.sessionId = msg.sessionId;
        localStorage.setItem('fa_sessionId', msg.sessionId);
        break;

      case 'matched':
        state.askerStatus = 'matched';
        updateAskerStatus();
        break;

      case 'waiting':
        state.askerStatus = 'waiting';
        updateAskerStatus();
        break;

      case 'responder_changed':
        state.askerStatus = 'changed';
        updateAskerStatus();
        // Auto transition to matched after 3s
        setTimeout(function () {
          if (state.askerStatus === 'changed') {
            state.askerStatus = 'matched';
            updateAskerStatus();
          }
        }, 3000);
        break;

      case 'new_message':
        if (state.role === 'asker') {
          state.askerMessages.push(msg.message);
          renderAskerMessages();
        } else if (state.role === 'responder') {
          const sid = msg.sessionId;
          if (!state.responderMessages[sid]) {
            state.responderMessages[sid] = [];
          }
          // Avoid duplicate (responder gets echo of own messages)
          const exists = state.responderMessages[sid].some(
            function (m) { return m.id === msg.message.id; }
          );
          if (!exists) {
            state.responderMessages[sid].push(msg.message);
          }
          if (state.activeSessionId === sid) {
            renderResponderMessages();
          }
        }
        break;

      case 'history':
        if (state.role === 'asker') {
          state.askerMessages = msg.messages;
          renderAskerMessages();
        } else if (state.role === 'responder') {
          state.responderMessages[msg.sessionId] = msg.messages;
          if (state.activeSessionId === msg.sessionId) {
            renderResponderMessages();
          }
        }
        break;

      case 'new_session':
        // Add to sessions if not already there
        if (!state.responderSessions.some(function (s) { return s.id === msg.session.id; })) {
          state.responderSessions.push(msg.session);
        }
        // Load history for this session
        send({ type: 'get_history', sessionId: msg.session.id });
        renderResponderSidebar();
        break;

      case 'session_list':
        state.responderSessions = msg.sessions;
        renderResponderSidebar();
        break;

      case 'responder_status':
        state.responderOnline = msg.online;
        renderResponderHeader();
        break;

      case 'online_count':
        state.onlineCount = msg.count;
        if (state.role === 'asker') {
          renderAskerHeader();
        }
        break;

      case 'error':
        showToast(msg.message);
        break;

      case 'pong':
        // Heartbeat response, nothing to do
        break;
    }
  }

  // ── Toast ────────────────────────────────────────────────────────────

  function showToast(message) {
    // Remove existing toast
    const existing = document.querySelector('.toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);

    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () {
      toast.remove();
    }, 3000);
  }

  // ── Connecting overlay ───────────────────────────────────────────────

  function showConnecting(text) {
    hideConnecting();
    const overlay = document.createElement('div');
    overlay.className = 'connecting-overlay';
    overlay.id = 'connecting-overlay';
    overlay.innerHTML =
      '<div class="connecting-spinner"></div>' +
      '<div class="connecting-text">' + (text || '正在连接...') + '</div>';
    document.body.appendChild(overlay);
  }

  function hideConnecting() {
    const overlay = document.getElementById('connecting-overlay');
    if (overlay) overlay.remove();
  }

  // ── Router ───────────────────────────────────────────────────────────

  function getRoute() {
    const hash = location.hash.replace(/^#\/?/, '');
    if (hash === 'asker') return 'asker';
    if (hash === 'responder') return 'responder';
    return 'home';
  }

  function navigate(route) {
    if (route === 'home') {
      location.hash = '';
    } else {
      location.hash = '/' + route;
    }
  }

  function handleRoute() {
    const route = getRoute();

    if (route === 'home') {
      // Disconnect and reset role
      if (state.ws) {
        try { state.ws.close(); } catch (e) {}
        state.ws = null;
      }
      state.role = null;
      stopPing();
      hideConnecting();
      renderHome();
      return;
    }

    // Connect WebSocket if needed
    if (route === 'asker') {
      state.role = 'asker';
      if (!state.connected) {
        connect();
      }
      renderAsker();
    } else if (route === 'responder') {
      state.role = 'responder';
      if (!state.connected) {
        connect();
      }
      renderResponder();
    }
  }

  window.addEventListener('hashchange', handleRoute);

  // ── Home view ────────────────────────────────────────────────────────

  function renderHome() {
    const app = document.getElementById('app');
    app.innerHTML =
      '<div class="home-view">' +
        '<div class="home-logo">AI</div>' +
        '<h1 class="home-title">AI 人</h1>' +
        '<p class="home-subtitle">对方是真人扮演的「AI」，来逗着玩吧。选一个角色开始。</p>' +
        '<div class="home-cards">' +
          '<a class="home-card" href="#/asker">' +
            '<div class="home-card-icon asker">?</div>' +
            '<div class="home-card-body">' +
              '<div class="home-card-title">我要提问</div>' +
              '<div class="home-card-desc">向「AI 人」提问，等真人回复</div>' +
            '</div>' +
            '<div class="home-card-arrow">›</div>' +
          '</a>' +
          '<a class="home-card" href="#/responder">' +
            '<div class="home-card-icon responder">AI</div>' +
            '<div class="home-card-body">' +
              '<div class="home-card-title">我要扮 AI</div>' +
              '<div class="home-card-desc">假装 AI，回复别人的问题</div>' +
            '</div>' +
            '<div class="home-card-arrow">›</div>' +
          '</a>' +
        '</div>' +
        '<div class="home-footer">娱乐玩法 · 对面是真人 · 请友善交流</div>' +
      '</div>';
  }

  // ── Asker view ───────────────────────────────────────────────────────

  function renderAsker() {
    const app = document.getElementById('app');

    let statusHtml = '';
    if (state.askerStatus === 'waiting') {
      statusHtml = '<div class="status-bar waiting">正在等待 AI 人上线...</div>';
    } else if (state.askerStatus === 'matched') {
      statusHtml = '<div class="status-bar connected">已连接 AI 人</div>';
    } else if (state.askerStatus === 'changed') {
      statusHtml = '<div class="status-bar changed">对接人已更换，正在重新分配...</div>';
    }

    app.innerHTML =
      '<div class="chat-view">' +
        '<div class="chat-header">' +
          '<button class="btn-back" onclick="location.hash=\'\'">‹</button>' +
          '<div class="chat-header-info">' +
            '<div class="chat-header-title">' +
              '<span class="status-dot ' + getStatusDotClass() + '"></span>' +
              '与 AI 人对话' +
            '</div>' +
            '<div class="chat-header-sub">' + getOnlineCountText() + '</div>' +
          '</div>' +
        '</div>' +
        '<div class="notice">对方是真人扮演 AI，仅供娱乐</div>' +
        statusHtml +
        '<div class="nickname-bar">' +
          '<label>昵称</label>' +
          '<input type="text" id="nickname-input" value="' + escapeHtml(state.nickname) + '" maxlength="16" />' +
        '</div>' +
        '<div class="messages" id="messages-container"></div>' +
        '<div class="input-area">' +
          '<textarea id="asker-input" placeholder="输入你的问题..." rows="1" maxlength="2000"></textarea>' +
          '<button class="btn-send" id="asker-send">↑</button>' +
        '</div>' +
      '</div>';

    renderAskerMessages();

    // Bind events
    const input = document.getElementById('asker-input');
    const sendBtn = document.getElementById('asker-send');

    input.addEventListener('input', function () {
      autoResize(this);
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendAskerMessage();
      }
    });

    sendBtn.addEventListener('click', sendAskerMessage);

    // Nickname change
    const nickInput = document.getElementById('nickname-input');
    nickInput.addEventListener('change', function () {
      const val = this.value.trim();
      if (val) {
        state.nickname = val;
        localStorage.setItem('fa_nickname', val);
        // Re-register with new nickname
        send({
          type: 'register',
          role: 'asker',
          clientId: state.clientId,
          nickname: val,
        });
      }
    });

    // Focus input
    setTimeout(function () { input.focus(); }, 100);
  }

  function getStatusDotClass() {
    if (state.askerStatus === 'matched') return 'online';
    if (state.askerStatus === 'waiting') return 'waiting';
    if (state.askerStatus === 'changed') return 'waiting';
    return 'offline';
  }

  function getOnlineCountText() {
    if (state.onlineCount > 0) {
      return state.onlineCount + ' 名 AI 人在线';
    }
    return '暂无 AI 人在线';
  }

  function renderAskerHeader() {
    const titleEl = document.querySelector('.chat-header-title');
    const subEl = document.querySelector('.chat-header-sub');
    if (titleEl) {
      titleEl.innerHTML =
        '<span class="status-dot ' + getStatusDotClass() + '"></span>与 AI 人对话';
    }
    if (subEl) {
      subEl.textContent = getOnlineCountText();
    }
  }

  function updateAskerStatus() {
    // Update header (status dot + online count)
    renderAskerHeader();

    // Update or insert status bar
    var existing = document.querySelector('.status-bar');
    var statusHtml = '';
    if (state.askerStatus === 'waiting') {
      statusHtml = '正在等待 AI 人上线...';
    } else if (state.askerStatus === 'matched') {
      statusHtml = '已连接 AI 人';
    } else if (state.askerStatus === 'changed') {
      statusHtml = '对接人已更换，正在重新分配...';
    }

    if (statusHtml) {
      var cls = 'status-bar ' + state.askerStatus;
      if (existing) {
        existing.className = cls;
        existing.textContent = statusHtml;
      } else {
        var bar = document.createElement('div');
        bar.className = cls;
        bar.textContent = statusHtml;
        // Insert after notice
        var notice = document.querySelector('.notice');
        if (notice && notice.nextSibling) {
          notice.parentNode.insertBefore(bar, notice.nextSibling);
        } else if (notice) {
          notice.parentNode.appendChild(bar);
        }
      }
    } else if (existing) {
      existing.remove();
    }
  }

  function renderAskerMessages() {
    const container = document.getElementById('messages-container');
    if (!container) return;

    if (state.askerMessages.length === 0) {
      container.innerHTML =
        '<div class="empty-state">' +
          '<div class="empty-state-icon">💬</div>' +
          '<div class="empty-state-text">发送一条消息，开始与 AI 人对话</div>' +
        '</div>';
      return;
    }

    let html = '';
    for (var i = 0; i < state.askerMessages.length; i++) {
      var msg = state.askerMessages[i];
      html += formatMessageHtml(msg, 'asker');
    }
    container.innerHTML = html;

    // Scroll to bottom
    container.scrollTop = container.scrollHeight;
  }

  function sendAskerMessage() {
    const input = document.getElementById('asker-input');
    if (!input) return;
    const content = input.value.trim();
    if (!content) return;

    // Use existing session or generate a new one
    const sessionId = state.sessionId || genId();

    send({
      type: 'asker_message',
      sessionId: sessionId,
      content: content,
    });

    input.value = '';
    autoResize(input);
  }

  // ── Responder workbench ──────────────────────────────────────────────

  function renderResponder() {
    const app = document.getElementById('app');

    app.innerHTML =
      '<div class="workbench-view">' +
        '<div class="workbench-header">' +
          '<button class="btn-back" onclick="location.hash=\'\'">‹</button>' +
          '<div class="workbench-header-info">' +
            '<div class="chat-header-title">AI 人工作台</div>' +
            '<div class="chat-header-sub" id="responder-sub">下线中</div>' +
          '</div>' +
          '<div class="online-toggle" id="online-toggle">' +
            '<div class="toggle-switch' + (state.responderOnline ? ' on' : '') + '"></div>' +
            '<span class="toggle-label' + (state.responderOnline ? ' on' : ' off') + '">' +
              (state.responderOnline ? '在线' : '离线') +
            '</span>' +
          '</div>' +
        '</div>' +
        '<div class="workbench-body">' +
          '<div class="session-sidebar" id="session-sidebar">' +
            '<div id="session-list"></div>' +
          '</div>' +
          '<div class="workbench-chat hidden" id="workbench-chat">' +
            '<div class="workbench-chat-header" id="workbench-chat-header"></div>' +
            '<div class="messages" id="responder-messages"></div>' +
            '<div class="input-area">' +
              '<textarea id="responder-input" placeholder="以 AI 口吻回复..." rows="1" maxlength="2000"></textarea>' +
              '<button class="btn-send" id="responder-send">↑</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    renderResponderSidebar();
    renderResponderHeader();

    // Bind online toggle
    document.getElementById('online-toggle').addEventListener('click', function () {
      if (state.responderOnline) {
        send({ type: 'responder_offline' });
      } else {
        send({ type: 'responder_online' });
      }
    });

    // Bind responder input
    const input = document.getElementById('responder-input');
    const sendBtn = document.getElementById('responder-send');

    input.addEventListener('input', function () {
      autoResize(this);
    });

    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendResponderMessage();
      }
    });

    sendBtn.addEventListener('click', sendResponderMessage);
  }

  function renderResponderHeader() {
    const subEl = document.getElementById('responder-sub');
    const toggle = document.getElementById('online-toggle');
    if (!subEl || !toggle) return;

    const switchEl = toggle.querySelector('.toggle-switch');
    const labelEl = toggle.querySelector('.toggle-label');

    if (state.responderOnline) {
      subEl.textContent = '在线接单中';
      if (switchEl) { switchEl.classList.add('on'); }
      if (labelEl) {
        labelEl.textContent = '在线';
        labelEl.classList.add('on');
        labelEl.classList.remove('off');
      }
    } else {
      subEl.textContent = '下线中';
      if (switchEl) { switchEl.classList.remove('on'); }
      if (labelEl) {
        labelEl.textContent = '离线';
        labelEl.classList.add('off');
        labelEl.classList.remove('on');
      }
    }
  }

  function renderResponderSidebar() {
    const listEl = document.getElementById('session-list');
    if (!listEl) return;

    if (state.responderSessions.length === 0) {
      listEl.innerHTML =
        '<div class="session-empty">' +
          (state.responderOnline
            ? '等待提问者到来...'
            : '上线后开始接收提问') +
        '</div>';
      return;
    }

    let html = '';
    for (var i = 0; i < state.responderSessions.length; i++) {
      var s = state.responderSessions[i];
      var isActive = s.id === state.activeSessionId;
      var timeText = s.lastMessageTime ? formatTime(s.lastMessageTime) : '';

      html +=
        '<div class="session-item' + (isActive ? ' active' : '') + '" data-session-id="' + s.id + '">' +
          '<div class="session-item-header">' +
            '<div class="session-item-name">' + escapeHtml(s.askerNickname) + '</div>' +
            '<div class="session-item-time">' + timeText + '</div>' +
          '</div>' +
          '<div class="session-item-preview">' +
            (s.lastMessage ? escapeHtml(s.lastMessage) : '新会话') +
          '</div>' +
          (s.unread > 0
            ? '<div class="session-item-badge">' + s.unread + '</div>'
            : '') +
        '</div>';
    }
    listEl.innerHTML = html;

    // Bind click events
    var items = listEl.querySelectorAll('.session-item');
    items.forEach(function (item) {
      item.addEventListener('click', function () {
        var sid = this.getAttribute('data-session-id');
        selectSession(sid);
      });
    });
  }

  function selectSession(sessionId) {
    state.activeSessionId = sessionId;
    send({ type: 'select_session', sessionId: sessionId });

    // Load messages if not cached
    if (!state.responderMessages[sessionId]) {
      send({ type: 'get_history', sessionId: sessionId });
      state.responderMessages[sessionId] = [];
    }

    // Show chat panel
    var chatPanel = document.getElementById('workbench-chat');
    var sidebar = document.getElementById('session-sidebar');
    if (chatPanel) chatPanel.classList.remove('hidden');
    if (sidebar) sidebar.classList.add('hidden');

    // Update header
    var session = state.responderSessions.find(function (s) { return s.id === sessionId; });
    var headerEl = document.getElementById('workbench-chat-header');
    if (headerEl && session) {
      headerEl.innerHTML =
        '<button class="btn-back" id="back-to-sessions" style="font-size:18px">‹</button>' +
        '<span>与 ' + escapeHtml(session.askerNickname) + ' 对话中</span>';
      var backBtn = document.getElementById('back-to-sessions');
      if (backBtn) {
        backBtn.addEventListener('click', function () {
          state.activeSessionId = null;
          var chatPanel = document.getElementById('workbench-chat');
          var sidebar = document.getElementById('session-sidebar');
          if (chatPanel) chatPanel.classList.add('hidden');
          if (sidebar) sidebar.classList.remove('hidden');
          renderResponderSidebar();
        });
      }
    }

    renderResponderMessages();
    renderResponderSidebar();

    // Focus input
    setTimeout(function () {
      var input = document.getElementById('responder-input');
      if (input) input.focus();
    }, 100);
  }

  function renderResponderMessages() {
    var container = document.getElementById('responder-messages');
    if (!container) return;

    var messages = state.responderMessages[state.activeSessionId] || [];

    if (messages.length === 0) {
      container.innerHTML =
        '<div class="empty-state">' +
          '<div class="empty-state-icon">💬</div>' +
          '<div class="empty-state-text">还没有消息，等待提问者发言</div>' +
        '</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < messages.length; i++) {
      var msg = messages[i];
      // From responder's perspective: asker messages on left, own on right
      var role = msg.role === 'responder' ? 'asker' : 'responder';
      html += formatMessageHtml(msg, role);
    }
    container.innerHTML = html;
    container.scrollTop = container.scrollHeight;
  }

  function sendResponderMessage() {
    var input = document.getElementById('responder-input');
    if (!input) return;
    var content = input.value.trim();
    if (!content || !state.activeSessionId) return;

    send({
      type: 'responder_message',
      sessionId: state.activeSessionId,
      content: content,
    });

    input.value = '';
    autoResize(input);
  }

  // ── Shared render helpers ────────────────────────────────────────────

  function formatMessageHtml(msg, perspective) {
    // perspective: 'asker' = viewing as asker (own messages on right)
    //              'responder' = viewing as responder (own messages on right)
    var cls;
    if (perspective === 'asker') {
      cls = msg.role === 'asker' ? 'asker' : 'responder';
    } else {
      cls = msg.role === 'responder' ? 'asker' : 'responder';
    }

    return (
      '<div class="message ' + cls + '">' +
        '<div class="message-nickname">' + escapeHtml(msg.senderNickname) + '</div>' +
        '<div class="message-bubble">' + escapeHtml(msg.content) + '</div>' +
        '<div class="message-time">' + formatTime(msg.timestamp) + '</div>' +
      '</div>'
    );
  }

  function autoResize(textarea) {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  }

  // ── Init ─────────────────────────────────────────────────────────────

  handleRoute();
})();
