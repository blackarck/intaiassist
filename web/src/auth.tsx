import { InteractionRequiredAuthError, PublicClientApplication, type AccountInfo } from "@azure/msal-browser";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { setAuthHeader } from "./api";
import { config } from "./config";

const SCOPES = ["openid", "profile", "email"];
const CALENDAR_SCOPES = ["Calendars.Read"];
const msal = config.msClientId
  ? new PublicClientApplication({ auth: { clientId: config.msClientId, authority: config.msAuthority, redirectUri: `${window.location.origin}/redirect.html` }, cache: { cacheLocation: "localStorage" } })
  : undefined;

interface AuthState {
  status: "loading" | "signedOut" | "signedIn";
  name?: string;
  email?: string;
  /** False when no sign-in provider is configured in this build. */
  canSignIn: boolean;
  error?: string;
  /** A Microsoft Graph token for reading the calendar. Asks the person for that permission the first time (needs a click). */
  calendarToken?: () => Promise<string>;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
}
const Ctx = createContext<AuthState | undefined>(undefined);
export const useAuth = () => {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
};

export function AuthProvider({ children }: { children: ReactNode }) {
  const [account, setAccount] = useState<AccountInfo | undefined>();
  const [status, setStatus] = useState<AuthState["status"]>("loading");
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (config.devUser) return void setStatus("signedIn");
    if (!msal) return void setStatus("signedOut");
    msal.initialize().then(() => {
      const a = msal.getAllAccounts()[0];
      setAccount(a);
      setStatus(a ? "signedIn" : "signedOut");
    });
  }, []);

  // The ID token is what the backend verifies. msal returns a fresh one silently while the sign-in session lasts.
  useEffect(() => {
    setAuthHeader(async () => {
      if (config.devUser) return `Dev ${config.devUser}`;
      const acct = account ?? msal?.getAllAccounts()[0];
      if (!msal || !acct) throw new Error("not signed in");
      try {
        return `Bearer ${(await msal.acquireTokenSilent({ scopes: SCOPES, account: acct })).idToken}`;
      } catch (e) {
        if (e instanceof InteractionRequiredAuthError) return `Bearer ${(await msal.acquireTokenPopup({ scopes: SCOPES, account: acct })).idToken}`;
        throw e;
      }
    });
  }, [account]);

  const signIn = useCallback(async () => {
    if (!msal) return;
    setError(undefined);
    try {
      const r = await msal.loginPopup({ scopes: SCOPES, prompt: "select_account" });
      setAccount(r.account);
      setStatus("signedIn");
    } catch (e) {
      const code = (e as { errorCode?: string }).errorCode;
      if (code !== "user_cancelled") setError((e as Error).message);
    }
  }, []);

  const calendarToken = useMemo(() => {
    if (config.devUser || !msal) return undefined;
    return async () => {
      const acct = account ?? msal.getAllAccounts()[0];
      if (!acct) throw new Error("not signed in");
      const req = { scopes: CALENDAR_SCOPES, account: acct };
      try {
        return (await msal.acquireTokenSilent(req)).accessToken;
      } catch (e) {
        if (e instanceof InteractionRequiredAuthError) return (await msal.acquireTokenPopup(req)).accessToken;
        throw e;
      }
    };
  }, [account]);

  const signOut = useCallback(async () => {
    if (config.devUser) return;
    await msal?.logoutPopup({ account }).catch(() => undefined);
    setAccount(undefined);
    setStatus("signedOut");
  }, [account]);

  const value = useMemo<AuthState>(
    () => ({ status, name: config.devUser ? config.devUser.split("@")[0] : account?.name, email: config.devUser || account?.username, canSignIn: !!msal, error, calendarToken, signIn, signOut }),
    [status, account, error, calendarToken, signIn, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
