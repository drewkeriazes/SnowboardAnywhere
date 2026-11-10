import './ui/theme.css';
import { main } from './core/Game';

main().catch((e) => {
  console.error(e);
  const st = document.getElementById('status')!;
  st.style.maxWidth = '720px'; st.style.textAlign = 'center';
  st.textContent = `Error: ${e.message ?? e}`;
});
