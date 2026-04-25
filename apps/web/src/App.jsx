import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";
import {
  clearStoredSession,
  fetchProtectedProfile,
  getActiveSession,
  getAuthConfig,
  initializeAuth,
  signInWithGoogle,
  signOut,
} from "./auth";

const SPORT_STORAGE_KEY = "pe-expo.selected-sport";
const ANSWERS_STORAGE_KEY = "pe-expo.sport-answers";
const EMPTY_PROFILE_STATE = {
  status: "idle",
  data: null,
  error: "",
};

const SPORTS = [
  {
    id: "swimming",
    name: "Swimming",
    description: "Build confidence in the water with a clear path from beginner goals to club-level progress.",
    accent: "is-swimming",
  },
  {
    id: "water-polo",
    name: "Water Polo",
    description: "Grow your game sense, stamina, and pool skills from casual play through competitive performance.",
    accent: "is-waterpolo",
  },
];

const DEFAULT_SPORT_ID = "swimming";

const SPORT_QUESTIONS = {
  swimming: [
    {
      id: "current-level",
      prompt: "What level are you at?",
      options: [
        { id: "A", label: "Beginner" },
        { id: "B", label: "Casual" },
        { id: "C", label: "Regular" },
      ],
    },
    {
      id: "goal-level",
      prompt: "Where do you want to get to?",
      options: [
        { id: "A", label: "Casual" },
        { id: "B", label: "Regular" },
        { id: "C", label: "Club Level" },
      ],
    },
    {
      id: "improvement-area",
      prompt: "Any areas you want to improve?",
      options: [
        { id: "A", label: "No" },
        { id: "B", label: "Stamina" },
        { id: "C", label: "Technique" },
        { id: "D", label: "Lactate" },
      ],
    },
  ],
  "water-polo": [
    {
      id: "current-level",
      prompt: "What level are you at?",
      options: [
        { id: "A", label: "Beginner" },
        { id: "B", label: "Casual" },
        { id: "C", label: "Competitive" },
      ],
    },
    {
      id: "goal-level",
      prompt: "Where do you want to get to?",
      options: [
        { id: "A", label: "Casual" },
        { id: "B", label: "Competitive" },
      ],
    },
    {
      id: "improvement-area",
      prompt: "Any areas you want to improve?",
      options: [
        { id: "A", label: "No" },
        { id: "B", label: "Stamina" },
        { id: "C", label: "Passing" },
        { id: "D", label: "Shooting" },
      ],
    },
  ],
};

function decodeJwtClaims(token) {
  if (!token) {
    return null;
  }

  try {
    const [, payload] = token.split(".");

    if (!payload) {
      return null;
    }

    const normalizedPayload = payload.replace(/-/g, "+").replace(/_/g, "/");
    const json = atob(normalizedPayload);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function isGeneratedUsername(value) {
  return typeof value === "string" && /^Google_\d+$/.test(value);
}

function prettifyEmailName(email) {
  if (!email || !email.includes("@")) {
    return "";
  }

  const localPart = email.split("@")[0];
  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function readStoredAnswers() {
  const rawValue = window.sessionStorage.getItem(ANSWERS_STORAGE_KEY);

  if (!rawValue) {
    return {};
  }

  try {
    return JSON.parse(rawValue);
  } catch {
    window.sessionStorage.removeItem(ANSWERS_STORAGE_KEY);
    return {};
  }
}

function writeStoredAnswers(value) {
  window.sessionStorage.setItem(ANSWERS_STORAGE_KEY, JSON.stringify(value));
}

function buildAnswerDownload(sportName, answers) {
  return {
    sport: sportName,
    answers,
    time: new Date().toISOString(),
  };
}

function downloadAnswerFile(sportName, answers) {
  const data = buildAnswerDownload(sportName, answers);
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const fileName = `${sportName.toLowerCase().replace(/\s+/g, "-")}-answers.json`;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

function buildDisplayName(profile, session) {
  const sessionClaims = decodeJwtClaims(session?.idToken);
  const fullName = profile?.name || sessionClaims?.name;
  const joinedName = [
    profile?.givenName || sessionClaims?.given_name,
    profile?.familyName || sessionClaims?.family_name,
  ].filter(Boolean).join(" ");
  const firstName = profile?.givenName || sessionClaims?.given_name;
  const emailName = prettifyEmailName(profile?.email || sessionClaims?.email);
  const username = profile?.username;

  if (fullName) {
    return fullName;
  }

  if (joinedName) {
    return joinedName;
  }

  if (firstName) {
    return firstName;
  }

  if (emailName) {
    return emailName;
  }

  if (username && !isGeneratedUsername(username)) {
    return username;
  }

  return "Athlete";
}

function getSportById(sportId) {
  return SPORTS.find((sport) => sport.id === sportId) ?? null;
}

function clearLocalSportState() {
  window.sessionStorage.removeItem(SPORT_STORAGE_KEY);
  window.sessionStorage.removeItem(ANSWERS_STORAGE_KEY);
}

export default function App() {
  const authConfig = useMemo(() => getAuthConfig(), []);
  const [authStatus, setAuthStatus] = useState("loading");
  const [authError, setAuthError] = useState("");
  const [session, setSession] = useState(null);
  const [profileState, setProfileState] = useState(EMPTY_PROFILE_STATE);
  const [selectedSportId, setSelectedSportId] = useState(() => window.sessionStorage.getItem(SPORT_STORAGE_KEY) || "");
  const [answersBySport, setAnswersBySport] = useState(() => readStoredAnswers());

  const missingAuthConfig = [];

  if (!authConfig.cognitoDomain) {
    missingAuthConfig.push("VITE_COGNITO_DOMAIN");
  }

  if (!authConfig.cognitoClientId) {
    missingAuthConfig.push("VITE_COGNITO_CLIENT_ID");
  }

  const selectedSport = getSportById(selectedSportId);
  const displayName = buildDisplayName(profileState.data, session);
  const selectedResponses = selectedSport ? answersBySport[selectedSport.id] ?? {} : {};
  const selectedQuestions = selectedSport ? SPORT_QUESTIONS[selectedSport.id] ?? [] : [];
  const answeredCount = selectedQuestions.filter((question) => selectedResponses[question.id]).length;
  const isQuestionnaireComplete = selectedQuestions.length > 0 && answeredCount === selectedQuestions.length;

  const loadProfile = useCallback(async (activeSession) => {
    if (!activeSession?.accessToken) {
      setProfileState(EMPTY_PROFILE_STATE);
      return null;
    }

    if (!authConfig.apiBaseUrl) {
      setProfileState({
        status: "error",
        data: null,
        error: "Set VITE_API_BASE_URL to call the protected /me endpoint.",
      });
      return activeSession;
    }

    setProfileState({
      status: "loading",
      data: null,
      error: "",
    });

    try {
      const nextSession = await getActiveSession();

      if (!nextSession?.accessToken) {
        clearStoredSession();
        clearLocalSportState();
        setSession(null);
        setAuthStatus("signed_out");
        setProfileState(EMPTY_PROFILE_STATE);
        setSelectedSportId("");
        setAnswersBySport({});
        setAuthError("Your session expired and could not be refreshed. Sign in again to continue.");
        return null;
      }

      if (nextSession.accessToken !== activeSession.accessToken) {
        setSession(nextSession);
      }

      const profile = await fetchProtectedProfile(nextSession.accessToken);

      setProfileState({
        status: "success",
        data: profile,
        error: "",
      });

      return nextSession;
    } catch (error) {
      if (error?.status === 401) {
        clearStoredSession();
        clearLocalSportState();
        setSession(null);
        setAuthStatus("signed_out");
        setSelectedSportId("");
        setAnswersBySport({});
        setAuthError("Your session expired and could not be refreshed. Sign in again to continue.");
      }

      setProfileState({
        status: "error",
        data: null,
        error: error instanceof Error ? error.message : "The protected /me request failed.",
      });

      return null;
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

      if (result.session) {
        setSelectedSportId(DEFAULT_SPORT_ID);
        window.sessionStorage.setItem(SPORT_STORAGE_KEY, DEFAULT_SPORT_ID);
      }

      if (result.session?.accessToken) {
        await loadProfile(result.session);
      } else {
        setProfileState(EMPTY_PROFILE_STATE);
      }
    }

    bootstrapAuth().catch((error) => {
      if (!active) {
        return;
      }

      setSession(null);
      setAuthStatus("signed_out");
      setAuthError(error instanceof Error ? error.message : "Unable to restore your session.");
      setProfileState(EMPTY_PROFILE_STATE);
    });

    return () => {
      active = false;
    };
  }, [loadProfile]);

  useEffect(() => {
    if (!session) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      getActiveSession()
        .then((nextSession) => {
          if (!nextSession) {
            clearStoredSession();
            clearLocalSportState();
            setSession(null);
            setAuthStatus("signed_out");
            setSelectedSportId("");
            setAnswersBySport({});
            setAuthError("Your session expired and could not be refreshed. Sign in again to continue.");
            setProfileState(EMPTY_PROFILE_STATE);
            return;
          }

          if (nextSession.accessToken !== session.accessToken || nextSession.expiresAt !== session.expiresAt) {
            setSession(nextSession);
          }
        })
        .catch(() => {
          clearStoredSession();
          clearLocalSportState();
          setSession(null);
          setAuthStatus("signed_out");
          setSelectedSportId("");
          setAnswersBySport({});
          setAuthError("Your session expired and could not be refreshed. Sign in again to continue.");
          setProfileState(EMPTY_PROFILE_STATE);
        });
    }, 30_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [session]);

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
    setSession(null);
    setAuthStatus("signed_out");
    setAuthError("");
    setProfileState(EMPTY_PROFILE_STATE);
    setSelectedSportId("");
    setAnswersBySport({});
    clearLocalSportState();
    signOut();
  }

  function handleSportSelect(sportId) {
    setSelectedSportId(sportId);
    window.sessionStorage.setItem(SPORT_STORAGE_KEY, sportId);
  }

  function handleSportBack() {
    setSelectedSportId("");
    window.sessionStorage.removeItem(SPORT_STORAGE_KEY);
  }

  function handleAnswer(questionId, optionId) {
    if (!selectedSport) {
      return;
    }

    const currentResponses = answersBySport[selectedSport.id] ?? {};
    const nextAnswers = {
      ...answersBySport,
      [selectedSport.id]: {
        ...currentResponses,
        [questionId]: optionId,
      },
    };

    setAnswersBySport(nextAnswers);
    writeStoredAnswers(nextAnswers);
  }

  function handleDownloadAnswers() {
    if (!selectedSport || !isQuestionnaireComplete) {
      return;
    }

    downloadAnswerFile(selectedSport.name, selectedResponses);
  }

  if (authStatus === "loading") {
    return (
      <main className="login-shell">
        <section className="login-card is-loading">
          <div className="orb orb-one" />
          <div className="orb orb-two" />
          <p className="eyebrow">Sports Hub</p>
          <h1>Checking your session…</h1>
          <p className="login-copy">Getting your player space ready.</p>
        </section>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="login-shell">
        <section className="login-card">
          <div className="orb orb-one" />
          <div className="orb orb-two" />
          <div className="hero-badge">Teen sports. One clean hub.</div>
          <p className="eyebrow">Sports Hub</p>
          <h1>Sign in to unlock your sports space.</h1>
          <p className="login-copy">
            Save your own context, jump between sports, and keep your choices tied to your account.
          </p>

          {authError ? <p className="status-banner is-error">{authError}</p> : null}
          {missingAuthConfig.length > 0 ? (
            <div className="callout is-warning">
              Missing auth env vars: {missingAuthConfig.join(", ")}
            </div>
          ) : null}

          <div className="button-row login-actions">
            <button
              type="button"
              className="google-button"
              onClick={() => void handleLogin()}
              disabled={missingAuthConfig.length > 0 || authStatus === "redirecting"}
            >
              {authStatus === "redirecting" ? "Redirecting to Google…" : "Continue with Google"}
            </button>
          </div>

          <div className="feature-grid">
            <article className="feature-card">
              <h2>Your own context</h2>
              <p>Everything stays behind your login so your sports space feels personal from the start.</p>
            </article>
            <article className="feature-card">
              <h2>Fast switch-in</h2>
              <p>Pick your sport, make a call, and keep the flow lightweight on mobile and desktop.</p>
            </article>
            <article className="feature-card">
              <h2>Fresh design</h2>
              <p>Bright colours, clean panels, and a modern layout designed for students and young athletes.</p>
            </article>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <header className="dashboard-header">
        <div>
          <p className="eyebrow">Your Sports</p>
          <h1>{selectedSport ? selectedSport.name : `Welcome back, ${displayName}.`}</h1>
          <p className="page-subtitle">
            {selectedSport
              ? `Make your ${selectedSport.name.toLowerCase()} choice below. Your space stays private to your account.`
              : "Choose a sport to jump straight into your own focused decision space."}
          </p>
        </div>

        <div className="profile-chip">
          <span className="profile-avatar">{displayName.charAt(0).toUpperCase()}</span>
          <div>
            <strong>{displayName}</strong>
            <p>{profileState.data?.email || "Signed in with Google"}</p>
          </div>
          <button type="button" className="secondary-button" onClick={handleLogout}>
            Sign out
          </button>
        </div>
      </header>

      {authError ? <p className="status-banner is-error">{authError}</p> : null}

      {profileState.status === "error" ? (
        <p className="status-banner is-error">{profileState.error}</p>
      ) : null}

      {!selectedSport ? (
        <section className="sports-grid">
          {SPORTS.map((sport) => (
            <article key={sport.id} className={`sport-card ${sport.accent}`}>
              <div className="sport-card-top">
                <span className="sport-kicker">Your Sports</span>
                <h2>{sport.name}</h2>
                <p>{sport.description}</p>
              </div>

              <div className="sport-card-bottom">
                <p className="sport-meta">
                  {answersBySport[sport.id]
                    ? `${Object.keys(answersBySport[sport.id]).length} of ${(SPORT_QUESTIONS[sport.id] ?? []).length} questions answered`
                    : "No answers saved yet"}
                </p>
                <button type="button" onClick={() => handleSportSelect(sport.id)}>
                  Open {sport.name}
                </button>
              </div>
            </article>
          ))}
        </section>
      ) : (
        <section className={`picker-card ${selectedSport.accent}`}>
          <div className="picker-header">
            <div>
              <p className="sport-kicker">{selectedSport.name}</p>
              <h2>Answer your questions</h2>
              <p>Work through each question below. Your responses save automatically for this sport.</p>
            </div>
            <div className="button-row">
              <button
                type="button"
                className="secondary-button"
                onClick={handleDownloadAnswers}
                disabled={!isQuestionnaireComplete}
              >
                Download answers
              </button>
              <button type="button" className="secondary-button" onClick={handleSportBack}>
                Back to sports
              </button>
            </div>
          </div>

          <div className="question-list">
            {selectedQuestions.map((question, index) => (
              <section key={question.id} className="question-card">
                <p className="question-number">Q{index + 1}</p>
                <h3>{question.prompt}</h3>

                <div className="choice-grid">
                  {question.options.map((option) => {
                    const isSelected = selectedResponses[question.id] === option.id;

                    return (
                      <button
                        key={option.id}
                        type="button"
                        className={`choice-button ${isSelected ? "is-selected" : ""}`}
                        onClick={() => handleAnswer(question.id, option.id)}
                      >
                        <span>{option.id}</span>
                        <strong>{option.label}</strong>
                      </button>
                    );
                  })}
                </div>
              </section>
            ))}
          </div>

          {isQuestionnaireComplete ? (
            <p className="status-banner is-success">
              All questions answered for {selectedSport.name}. You can download the saved answers now.
            </p>
          ) : (
            <p className="status-banner is-muted">
              {answeredCount} of {selectedQuestions.length} questions answered so far.
            </p>
          )}
        </section>
      )}
    </main>
  );
}
