const AUTH_SESSION_STORAGE_KEY = "pe-expo.auth.session";
const PKCE_STORAGE_KEY = "pe-expo.auth.pkce";
const OAUTH_SCOPE = "openid profile email";
const EXPIRY_BUFFER_MS = 30_000;

let initializationPromise = null;
let refreshPromise = null;

function normalizeUrl(value) {
  return value?.trim().replace(/\/+$/, "") ?? "";
}

function ensureTrailingSlash(value) {
  return value.endsWith("/") ? value : `${value}/`;
}

function encodeBase64Url(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";

  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });

  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function createRandomString(size = 32) {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

async function createCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return encodeBase64Url(digest);
}

async function parseResponse(response) {
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return response.json();
  }

  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function getRedirectUri() {
  return new URL(window.location.pathname, window.location.origin).toString();
}

function clearCallbackParams() {
  const cleanUrl = `${window.location.pathname}${window.location.hash}` || "/";
  window.history.replaceState({}, document.title, cleanUrl);
}

function readJsonFromStorage(key) {
  const rawValue = window.sessionStorage.getItem(key);

  if (!rawValue) {
    return null;
  }

  try {
    return JSON.parse(rawValue);
  } catch {
    window.sessionStorage.removeItem(key);
    return null;
  }
}

function saveJsonToStorage(key, value) {
  window.sessionStorage.setItem(key, JSON.stringify(value));
}

function createSession(tokenResponse, previousSession = null) {
  const expiresInMs = Number(tokenResponse.expires_in ?? 3600) * 1000;

  return {
    accessToken: tokenResponse.access_token,
    idToken: tokenResponse.id_token ?? previousSession?.idToken ?? "",
    refreshToken: tokenResponse.refresh_token ?? previousSession?.refreshToken ?? "",
    tokenType: tokenResponse.token_type ?? previousSession?.tokenType ?? "Bearer",
    scope: tokenResponse.scope ?? previousSession?.scope ?? OAUTH_SCOPE,
    expiresAt: Date.now() + expiresInMs,
  };
}

function saveSession(tokenResponse, previousSession = null) {
  const session = createSession(tokenResponse, previousSession);
  saveJsonToStorage(AUTH_SESSION_STORAGE_KEY, session);
  return session;
}

function readStoredSession() {
  return readJsonFromStorage(AUTH_SESSION_STORAGE_KEY);
}

function isSessionExpired(session) {
  return !session?.expiresAt || Number(session.expiresAt) <= Date.now() + EXPIRY_BUFFER_MS;
}

function readPkceState() {
  return readJsonFromStorage(PKCE_STORAGE_KEY);
}

function savePkceState(value) {
  saveJsonToStorage(PKCE_STORAGE_KEY, value);
}

function clearPkceState() {
  window.sessionStorage.removeItem(PKCE_STORAGE_KEY);
}

export function clearStoredSession() {
  window.sessionStorage.removeItem(AUTH_SESSION_STORAGE_KEY);
}

export function getAuthConfig() {
  return {
    apiBaseUrl: normalizeUrl(import.meta.env.VITE_API_BASE_URL),
    cognitoDomain: normalizeUrl(import.meta.env.VITE_COGNITO_DOMAIN),
    cognitoClientId: import.meta.env.VITE_COGNITO_CLIENT_ID?.trim() ?? "",
  };
}

function requireAuthConfig() {
  const config = getAuthConfig();

  if (!config.cognitoDomain) {
    throw new Error("Set VITE_COGNITO_DOMAIN to your Cognito Hosted UI domain.");
  }

  if (!config.cognitoClientId) {
    throw new Error("Set VITE_COGNITO_CLIENT_ID to your Cognito app client ID.");
  }

  return config;
}

export function restoreSession() {
  const session = readStoredSession();

  if (!session?.accessToken || !session?.expiresAt) {
    clearStoredSession();
    return null;
  }

  return session;
}

async function requestToken(body) {
  const { cognitoDomain } = requireAuthConfig();
  const tokenEndpoint = new URL("oauth2/token", ensureTrailingSlash(cognitoDomain));
  const response = await fetch(tokenEndpoint.toString(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  const payload = await parseResponse(response);

  if (!response.ok) {
    const message = typeof payload === "string"
      ? payload
      : payload.error_description || payload.error || "Unable to complete authentication.";

    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return payload;
}

async function exchangeCodeForSession({ code, verifier }) {
  const { cognitoClientId } = requireAuthConfig();
  const payload = await requestToken(new URLSearchParams({
    grant_type: "authorization_code",
    client_id: cognitoClientId,
    code,
    code_verifier: verifier,
    redirect_uri: getRedirectUri(),
  }));

  return saveSession(payload);
}

export async function refreshSession() {
  const storedSession = readStoredSession();

  if (!storedSession?.refreshToken) {
    clearStoredSession();
    return null;
  }

  if (!refreshPromise) {
    refreshPromise = (async () => {
      const { cognitoClientId } = requireAuthConfig();
      const payload = await requestToken(new URLSearchParams({
        grant_type: "refresh_token",
        client_id: cognitoClientId,
        refresh_token: storedSession.refreshToken,
      }));

      return saveSession(payload, storedSession);
    })()
      .catch((error) => {
        clearStoredSession();
        throw error;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  return refreshPromise;
}

export async function getActiveSession() {
  const session = restoreSession();

  if (!session) {
    return null;
  }

  if (!isSessionExpired(session)) {
    return session;
  }

  try {
    return await refreshSession();
  } catch {
    return null;
  }
}

async function initializeAuthInternal() {
  const searchParams = new URLSearchParams(window.location.search);

  if (searchParams.has("error")) {
    const errorMessage = searchParams.get("error_description") || searchParams.get("error") || "Sign-in failed.";
    clearPkceState();
    clearStoredSession();
    clearCallbackParams();
    return { session: null, error: errorMessage };
  }

  if (searchParams.has("code")) {
    const code = searchParams.get("code");
    const incomingState = searchParams.get("state");
    const pkceState = readPkceState();

    clearPkceState();
    clearCallbackParams();

    if (!code || !pkceState?.verifier || !pkceState?.state) {
      clearStoredSession();
      return { session: null, error: "The sign-in flow expired. Please try again." };
    }

    if (!incomingState || incomingState !== pkceState.state) {
      clearStoredSession();
      return { session: null, error: "The returned sign-in state did not match the original request." };
    }

    try {
      const session = await exchangeCodeForSession({
        code,
        verifier: pkceState.verifier,
      });

      return { session, error: null };
    } catch (error) {
      clearStoredSession();
      return {
        session: null,
        error: error instanceof Error ? error.message : "Unable to finish sign-in.",
      };
    }
  }

  const session = await getActiveSession();

  if (!session) {
    return { session: null, error: null };
  }

  return { session, error: null };
}

export function initializeAuth() {
  if (!initializationPromise) {
    initializationPromise = initializeAuthInternal().finally(() => {
      initializationPromise = null;
    });
  }

  return initializationPromise;
}

export async function signInWithGoogle() {
  const { cognitoDomain, cognitoClientId } = requireAuthConfig();
  const verifier = createRandomString(64);
  const challenge = await createCodeChallenge(verifier);
  const state = createRandomString(24);
  const authorizeEndpoint = new URL("oauth2/authorize", ensureTrailingSlash(cognitoDomain));

  savePkceState({ verifier, state });

  authorizeEndpoint.search = new URLSearchParams({
    identity_provider: "Google",
    response_type: "code",
    client_id: cognitoClientId,
    redirect_uri: getRedirectUri(),
    scope: OAUTH_SCOPE,
    state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  }).toString();

  window.location.assign(authorizeEndpoint.toString());
}

export function signOut() {
  const { cognitoDomain, cognitoClientId } = getAuthConfig();
  clearPkceState();
  clearStoredSession();

  if (!cognitoDomain || !cognitoClientId) {
    clearCallbackParams();
    return;
  }

  const logoutEndpoint = new URL("logout", ensureTrailingSlash(cognitoDomain));
  logoutEndpoint.search = new URLSearchParams({
    client_id: cognitoClientId,
    logout_uri: getRedirectUri(),
  }).toString();

  window.location.assign(logoutEndpoint.toString());
}

async function fetchProtectedJson(path, { accessToken, method = "GET", body } = {}) {
  const { apiBaseUrl } = getAuthConfig();

  if (!apiBaseUrl) {
    throw new Error("Set VITE_API_BASE_URL to call the protected API.");
  }

  const session = accessToken ? { accessToken } : await getActiveSession();

  if (!session?.accessToken) {
    throw new Error("No access token is available for the protected request.");
  }

  const endpoint = new URL(path, ensureTrailingSlash(apiBaseUrl));
  const response = await fetch(endpoint.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const payload = await parseResponse(response);

  if (!response.ok) {
    const message = typeof payload === "string"
      ? payload
      : payload.message || payload.error || `The protected request failed with status ${response.status}.`;

    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

export async function fetchProtectedProfile(accessToken) {
  return fetchProtectedJson("me", { accessToken });
}

export async function fetchQuestionnaireResults(accessToken) {
  return fetchProtectedJson("results", { accessToken });
}

export async function saveQuestionnaireResults(answersBySport, accessToken) {
  return fetchProtectedJson("results", {
    accessToken,
    method: "PUT",
    body: {
      answersBySport,
    },
  });
}
