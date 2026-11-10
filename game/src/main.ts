import './ui/theme.css';
import './ui/hud.css';
import { parseParams } from './core/params';
import { Game } from './core/Game';

// FEAT-160: the entry point. Where things live and the order a frame runs in: docs/developer-guide.md (Code layout).
new Game(parseParams(location.search)).start().catch((e) => {
  console.error(e);
  const st = document.getElementById('status')!;
  st.style.maxWidth = '720px'; st.style.textAlign = 'center';
  st.textContent = `Error: ${e.message ?? e}`;
});
