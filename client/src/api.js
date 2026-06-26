import axios from 'axios';

// Same-origin in dev (Vite proxy). Set VITE_API_URL for a split deployment.
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '',
  withCredentials: true,
});

export default api;

// ── small shared formatting helpers ──────────────────────────────
export const money = (n) =>
  (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });

export const percent = (n) => `${Math.round((Number(n) || 0) * 100)}%`;
