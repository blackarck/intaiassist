export const config = {
  apiUrl: (import.meta.env.VITE_API_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  msClientId: import.meta.env.VITE_MS_CLIENT_ID ?? "",
  msAuthority: import.meta.env.VITE_MS_AUTHORITY ?? "https://login.microsoftonline.com/common",
  /** Local development only. The backend ignores this unless it runs with DEV_AUTH=1. */
  devUser: import.meta.env.VITE_DEV_USER ?? "",
};
