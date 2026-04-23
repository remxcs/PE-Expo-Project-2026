import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";
import {
  clearStoredSession,
  fetchProtectedProfile,
  getAuthConfig,
  initializeAuth,
  signInWithGoogle,
  signOut,
} from "./auth";

const ANSWER_STORAGE_KEY = "pe-expo.answer";
const EMPTY_PROFILE_STATE = {
  status: "idle",
  data: null,
  error: "",
};

function formatExpiration(expiresAt) {
  if (!expiresAt) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(expiresAt));
}

export default function App() {
  const authConfig = useMemo(() => getAuthConfig(), []);
  const [answer, setAnswer] = useState(() => window.sessionStorage.getItem(ANSWER_STORAGE_KEY));
  const [authStatus, setAuthStatus] = useState("loading");
  const [authError, setAuthError] = useState("");
  const [session, setSession] = useState(null);
  const [profileState, setProfileState] = useState(EMPTY_PROFILE_STATE);

  const missingAuthConfig = [];

  if (!authConfig.cognitoDomain) {
    missingAuthConfig.push("VITE_COGNITO_DOMAIN");
  }

  if (!authConfig.cognitoClientId) {
    missingAuthConfig.push("VITE_COGNITO_CLIENT_ID");
  }

  const apiHealthEndpoint = authConfig.apiBaseUrl
    ? `${authConfig.apiBaseUrl}/health`
    : "set VITE_API_BASE_URL to connect the backend scaffold";

  const loadProfile = useCallback(async (accessToken) => {
    if (!authConfig.apiBaseUrl) {
      setProfileState({
        status: "error",
        data: null,
        error: "Set VITE_API_BASE_URL to call the protected /me endpoint.",
      });
      return;
    }

    setProfileState({
      status: "loading",
      data: null,
      error: "",
    });

    try {
      const profile = await fetchProtectedProfile(accessToken);
      setProfileState({
        status: "success",
        data: profile,
        error: "",
      });
    } catch (error) {
      if (error?.status === 401) {
        clearStoredSession();
        setSession(null);
        setAuthStatus("signed_out");
        setAuthError("Your API session is no longer valid. Sign in again to refresh it.");
      }

      setProfileState({
        status: "error",
        data: null,
        error: error instanceof Error ? error.message : "The protected /me request failed.",
      });
    }
  }, [authConfig.apiBaseUrl]);

  useEffect(() => {
    let active = true;

    async function bootstrapAuth() {
      setAuthStatus("loading");

      const result = await initializeAuth();

      if (!active) {
        return;
      }

      setSession(result.session);
      setAuthError(result.error ?? "");
      setAuthStatus(result.session ? "signed_in" : "signed_out");

      if (result.session?.accessToken && authConfig.apiBaseUrl) {
        await loadProfile(result.session.accessToken);
      }
    }

    bootstrapAuth().catch((error) => {
      if (!active) {
        return;
      }

      setSession(null);
      setAuthStatus("signed_out");
      setAuthError(error instanceof Error ? error.message : "Unable to restore your session.");
    });

    return () => {
      active = false;
    };
  }, [authConfig.apiBaseUrl, loadProfile]);

  async function handleLogin() {
    setAuthError("");
    setAuthStatus("redirecting");

    try {
      await signInWithGoogle();
    } catch (error) {
      setAuthStatus("signed_out");
      setAuthError(error instanceof Error ? error.message : "Unable to start sign-in.");
    }
  }

  function handleLogout() {
    setProfileState(EMPTY_PROFILE_STATE);
    setSession(null);
    setAuthStatus("signed_out");
    setAuthError("");
    signOut();
  }

  function saveAnswer(choice) {
    setAnswer(choice);
    window.sessionStorage.setItem(ANSWER_STORAGE_KEY, choice);

    const data = {
      answer: choice,
      time: new Date().toISOString()
    };

    const blob = new Blob(
      [JSON.stringify(data, null, 2)],
      { type: "application/json" }
    );

    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "answer.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="app-shell">
      <header className="page-header">
        <p className="eyebrow">PE Expo frontend</p>
        <h1>Simple Cognito login with a protected API check.</h1>
        <p className="page-subtitle">
          The app now keeps the original answer picker, adds Cognito Hosted UI sign-in with Google,
          restores the session from sessionStorage, and calls <code>/me</code> with the access token.
        </p>
      </header>

      {authError && <p className="status-banner is-error">{authError}</p>}

      <div className="panel-grid">
        <section className="panel">
          <div className="panel-heading">
            <h2>Answer selection</h2>
            <p>The original choice buttons still download an <code>answer.json</code> file.</p>
          </div>

          <div className="choice-grid">
            <button type="button" className="choice-button" onClick={() => saveAnswer("A")}>A</button>
            <button type="button" className="choice-button" onClick={() => saveAnswer("B")}>B</button>
            <button type="button" className="choice-button" onClick={() => saveAnswer("C")}>C</button>
            <button type="button" className="choice-button" onClick={() => saveAnswer("D")}>D</button>
          </div>

          {answer ? (
            <p className="status-banner is-success">Selected: {answer}</p>
          ) : (
            <p className="status-banner is-muted">No answer selected yet.</p>
          )}

          <p className="panel-note">The latest selection is kept in sessionStorage so it survives the Hosted UI redirect.</p>
        </section>

        <section className="panel">
          <div className="panel-heading">
            <h2>Authentication</h2>
            <p>OAuth code flow with PKCE, a Cognito Hosted UI redirect, and a Google identity provider.</p>
          </div>

          {missingAuthConfig.length > 0 ? (
            <div className="callout is-warning">
              Missing auth env vars: {missingAuthConfig.join(", ")}
            </div>
          ) : null}

          <div className="session-summary">
            <span className={`state-pill ${session ? "is-success" : "is-muted"}`}>
              {authStatus === "loading"
                ? "Checking session"
                : authStatus === "redirecting"
                  ? "Redirecting to Cognito"
                  : session
                    ? "Signed in"
                    : "Signed out"}
            </span>

            {session ? (
              <>
                <dl className="session-details">
                  <div>
                    <dt>Token type</dt>
                    <dd>{session.tokenType}</dd>
                  </div>
                  <div>
                    <dt>Expires</dt>
                    <dd>{formatExpiration(session.expiresAt)}</dd>
                  </div>
                </dl>

                <div className="button-row">
                  <button
                    type="button"
                    onClick={() => void loadProfile(session.accessToken)}
                    disabled={profileState.status === "loading"}
                  >
                    {profileState.status === "loading" ? "Loading /me..." : "Refresh /me"}
                  </button>
                  <button type="button" className="secondary-button" onClick={handleLogout}>
                    Sign out
                  </button>
                </div>
              </>
            ) : (
              <div className="button-row">
                <button
                  type="button"
                  onClick={() => void handleLogin()}
                  disabled={missingAuthConfig.length > 0 || authStatus === "redirecting"}
                >
                  {authStatus === "redirecting" ? "Redirecting..." : "Sign in with Google"}
                </button>
              </div>
            )}
          </div>

          <div className="profile-block">
            <div className="profile-header">
              <h3>Protected API request</h3>
              <p>GET <code>/me</code> with <code>Authorization: Bearer &lt;access token&gt;</code>.</p>
            </div>

            {!session ? (
              <p className="status-banner is-muted">Sign in to fetch the protected profile response.</p>
            ) : !authConfig.apiBaseUrl ? (
              <p className="status-banner is-muted">Set <code>VITE_API_BASE_URL</code> to enable the protected request.</p>
            ) : profileState.status === "success" ? (
              <pre className="json-preview">{JSON.stringify(profileState.data, null, 2)}</pre>
            ) : profileState.status === "error" ? (
              <p className="status-banner is-error">{profileState.error}</p>
            ) : profileState.status === "loading" ? (
              <p className="status-banner is-muted">Calling <code>{authConfig.apiBaseUrl}/me</code>...</p>
            ) : (
              <p className="status-banner is-muted">Use the signed-in session to fetch the protected profile response.</p>
            )}
          </div>
        </section>
      </div>

      <footer className="app-footer">
        <p>API health endpoint: {apiHealthEndpoint}</p>
      </footer>
    </main>
  );
}
