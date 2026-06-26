import { useEffect, useState } from 'react';
import api from './api';

// Fetch the outbound send mode once and cache it module-wide, so the Header chip and the
// send pages all share one value without each re-fetching. redirect = demo (every send
// goes to the operator's own inbox); live = real donors are emailed.
let cache = null;
let inflight = null;

export function useSendMode() {
  const [mode, setMode] = useState(cache);
  useEffect(() => {
    if (cache) {
      setMode(cache);
      return;
    }
    if (!inflight) {
      inflight = api
        .get('/api/system/send-mode')
        .then((r) => {
          cache = r.data || { mode: 'redirect' };
          return cache;
        })
        .catch(() => ({ mode: 'redirect', redirectTo: '' }));
    }
    let alive = true;
    inflight.then((d) => alive && setMode(d));
    return () => {
      alive = false;
    };
  }, []);
  return mode || { mode: 'redirect', redirectTo: '' };
}

// True only when the app is configured to email real donors. Use to gate a confirm dialog
// before a live send.
export function isLiveSend(send) {
  return (send?.mode || 'redirect') === 'live';
}
