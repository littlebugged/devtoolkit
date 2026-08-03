import { ChatLobby } from './chat-lobby';
import type { Env } from './types';

export { ChatLobby };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade — route to the global ChatLobby DO
    if (url.pathname === '/ws') {
      const id = env.CHAT_LOBBY.idFromName('global');
      const stub = env.CHAT_LOBBY.get(id);
      return stub.fetch(request);
    }

    // Everything else is served by the static assets handler (public/)
    // If ASSETS binding exists, delegate; otherwise 404
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  },
};
