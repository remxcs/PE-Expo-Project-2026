import { useCallback, useEffect, useMemo, useState } from "react";
import "./App.css";
import {
  clearStoredSession,
  fetchSwimmingState,
  fetchQuestionnaireResults,
  fetchProtectedProfile,
  generateSwimmingRecommendation,
  getActiveSession,
  getAuthConfig,
  initializeAuth,
  resetSwimmingSport,
  saveQuestionnaireResults,
  saveSwimmingSession,
  saveSwimmingSessionFeedback,
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

const EMPTY_RESULTS_STATE = {
  status: "idle",
  error: "",
  updatedAt: null,
};

const EMPTY_SWIMMING_STATE = {
  status: "idle",
  error: "",
  successMessage: "",
  sessions: [],
  pendingFeedbackSession: null,
  shouldPromptPendingFeedback: false,
  recommendation: null,
  retryFeedback: "",
  followUpFeedback: "",
  isGenerating: false,
  isSaving: false,
  isSubmittingFeedback: false,
  isResetting: false,
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

function getAnsweredCountForSport(sportId, answersBySport) {
  const sportAnswers = answersBySport[sportId] ?? {};
  const sportQuestions = SPORT_QUESTIONS[sportId] ?? [];
  return sportQuestions.filter((question) => sportAnswers[question.id]).length;
}

function isSportQuestionnaireComplete(sportId, answersBySport) {
  const sportQuestions = SPORT_QUESTIONS[sportId] ?? [];

  if (!sportQuestions.length) {
    return false;
  }

  return getAnsweredCountForSport(sportId, answersBySport) === sportQuestions.length;
}

function supportsSessionRecommendations(sportId) {
  return sportId === "swimming";
}

function formatSessionStatus(status) {
  if (status === "planned") {
    return "Planned";
  }

  if (status === "completed") {
    return "Completed";
  }

  if (status === "skipped") {
    return "Skipped";
  }

  return status;
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
  const [selectedSportId, setSelectedSportId] = useState("");
  const [answersBySport, setAnswersBySport] = useState(() => readStoredAnswers());
  const [savedAnswersBySport, setSavedAnswersBySport] = useState(() => readStoredAnswers());
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);
  const [resultsState, setResultsState] = useState(EMPTY_RESULTS_STATE);
  const [swimmingState, setSwimmingState] = useState(EMPTY_SWIMMING_STATE);

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
  const progressPercentage = selectedQuestions.length > 0 ? (answeredCount / selectedQuestions.length) * 100 : 0;
  const currentQuestion = selectedQuestions[activeQuestionIndex] ?? null;
  const isSelectedSportComplete = selectedSport ? isSportQuestionnaireComplete(selectedSport.id, savedAnswersBySport) : false;
  const isSwimmingDashboardVisible = selectedSport?.id === "swimming" && isSelectedSportComplete;

  const generateInitialSwimmingRecommendation = useCallback(async (accessToken) => {
    setSwimmingState((currentState) => ({
      ...currentState,
      status: "success",
      isGenerating: true,
      error: "",
      successMessage: "Preparing your first Bedrock-powered swim suggestion.",
      recommendation: null,
    }));

    try {
      const response = await generateSwimmingRecommendation("", accessToken);
      setSwimmingState((currentState) => ({
        ...currentState,
        status: "success",
        isGenerating: false,
        recommendation: response?.recommendation ?? null,
        successMessage: "Your first swim suggestion is ready and uses your saved answers plus the swim set library.",
      }));
      return response?.recommendation ?? null;
    } catch (error) {
      setSwimmingState((currentState) => ({
        ...currentState,
        status: "error",
        isGenerating: false,
        error: error instanceof Error ? error.message : "Unable to generate a swim set.",
        successMessage: "",
      }));
      return null;
    }
  }, []);

  const loadSwimmingDashboard = useCallback(async (accessToken, shouldPromptPendingFeedback = false) => {
    if (!accessToken) {
      setSwimmingState(EMPTY_SWIMMING_STATE);
      return null;
    }

      setSwimmingState((currentState) => ({
        ...currentState,
        status: "loading",
        error: "",
        successMessage: "",
      }));

    try {
      const nextState = await fetchSwimmingState(accessToken);
      setSwimmingState((currentState) => ({
        ...currentState,
        status: "success",
        error: "",
        sessions: nextState?.sessions ?? [],
        pendingFeedbackSession: nextState?.pendingFeedbackSession ?? null,
        shouldPromptPendingFeedback,
      }));
      return nextState;
    } catch (error) {
        setSwimmingState((currentState) => ({
          ...currentState,
          status: "error",
          error: error instanceof Error ? error.message : "Unable to load your swimming sessions.",
          successMessage: "",
        }));
      return null;
    }
  }, []);

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
      setResultsState(EMPTY_RESULTS_STATE);
      setSwimmingState(EMPTY_SWIMMING_STATE);

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
        setSavedAnswersBySport({});
        setAuthError("Your session expired and could not be refreshed. Sign in again to continue.");
        return null;
      }

      if (nextSession.accessToken !== activeSession.accessToken) {
        setSession(nextSession);
      }

      const profile = await fetchProtectedProfile(nextSession.accessToken);

      try {
        const results = await fetchQuestionnaireResults(nextSession.accessToken);
        const nextAnswers = results?.answersBySport ?? {};

        setAnswersBySport(nextAnswers);
        setSavedAnswersBySport(nextAnswers);
        writeStoredAnswers(nextAnswers);
        setResultsState({
          status: "success",
          error: "",
          updatedAt: results?.updatedAt ?? null,
        });

        if (isSportQuestionnaireComplete("swimming", nextAnswers)) {
          await loadSwimmingDashboard(nextSession.accessToken, true);
        }
      } catch (error) {
        setResultsState({
          status: "error",
          error: error instanceof Error ? error.message : "Unable to load your saved questionnaire results.",
          updatedAt: null,
        });
      }

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
        setSavedAnswersBySport({});
        setResultsState(EMPTY_RESULTS_STATE);
        setAuthError("Your session expired and could not be refreshed. Sign in again to continue.");
      }

      setProfileState({
        status: "error",
        data: null,
        error: error instanceof Error ? error.message : "The protected /me request failed.",
      });

      return null;
    }
  }, [authConfig.apiBaseUrl, loadSwimmingDashboard]);

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
        setSelectedSportId("");
        window.sessionStorage.removeItem(SPORT_STORAGE_KEY);
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
            setSavedAnswersBySport({});
            setResultsState(EMPTY_RESULTS_STATE);
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
          setSavedAnswersBySport({});
          setResultsState(EMPTY_RESULTS_STATE);
          setAuthError("Your session expired and could not be refreshed. Sign in again to continue.");
          setProfileState(EMPTY_PROFILE_STATE);
        });
    }, 30_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [session]);

  useEffect(() => {
    if (!selectedQuestions.length) {
      return;
    }

    setActiveQuestionIndex((currentIndex) => Math.min(currentIndex, selectedQuestions.length - 1));
  }, [selectedQuestions.length]);

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
    setSavedAnswersBySport({});
    setResultsState(EMPTY_RESULTS_STATE);
    setSwimmingState(EMPTY_SWIMMING_STATE);
    clearLocalSportState();
    signOut();
  }

  function handleSportSelect(sportId) {
    const sportQuestions = SPORT_QUESTIONS[sportId] ?? [];
    const storedResponses = answersBySport[sportId] ?? {};
    const firstUnansweredIndex = sportQuestions.findIndex((question) => !storedResponses[question.id]);
    const nextIndex = firstUnansweredIndex === -1 ? Math.max(sportQuestions.length - 1, 0) : firstUnansweredIndex;

    setSelectedSportId(sportId);
    setActiveQuestionIndex(nextIndex);

    if (sportId === "swimming" && isSportQuestionnaireComplete("swimming", savedAnswersBySport)) {
      void (async () => {
        const nextState = await loadSwimmingDashboard(session?.accessToken);

        if (
          nextState?.questionnaireComplete &&
          !nextState.pendingFeedbackSession &&
          nextState.sessions.length === 0 &&
          !swimmingState.recommendation
        ) {
          await generateInitialSwimmingRecommendation(session?.accessToken);
        }
      })();
    }
  }

  function handleSportBack() {
    setSelectedSportId("");
    setActiveQuestionIndex(0);
  }

  async function handleAnswer(questionId, optionId) {
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
    setResultsState((currentState) => ({
      ...currentState,
      status: "saving",
      error: "",
    }));

    const answeredQuestionIndex = selectedQuestions.findIndex((question) => question.id === questionId);
    const nextQuestionIndex = answeredQuestionIndex + 1;

    if (nextQuestionIndex < selectedQuestions.length) {
      setActiveQuestionIndex(nextQuestionIndex);
    }

    try {
      const savedResults = await saveQuestionnaireResults(nextAnswers);
      const confirmedAnswers = savedResults?.answersBySport ?? nextAnswers;
      setSavedAnswersBySport(confirmedAnswers);
      setAnswersBySport(confirmedAnswers);
      writeStoredAnswers(confirmedAnswers);
      setResultsState({
        status: "success",
        error: "",
        updatedAt: savedResults?.updatedAt ?? new Date().toISOString(),
      });

      const isLastSwimmingQuestion = selectedSport.id === "swimming" &&
        answeredCount + 1 === selectedQuestions.length &&
        !savedAnswersBySport.swimming;

      if (isLastSwimmingQuestion) {
        setActiveQuestionIndex(0);
        setSelectedSportId("swimming");
        await generateInitialSwimmingRecommendation(session?.accessToken);
      }

    } catch (error) {
      setAnswersBySport(savedAnswersBySport);
      writeStoredAnswers(savedAnswersBySport);
      setResultsState({
        status: "error",
        error: error instanceof Error ? error.message : "Unable to save your answers right now.",
        updatedAt: null,
      });
    }
  }

  function handlePreviousQuestion() {
    setActiveQuestionIndex((currentIndex) => Math.max(currentIndex - 1, 0));
  }

  function handleNextQuestion() {
    setActiveQuestionIndex((currentIndex) => Math.min(currentIndex + 1, selectedQuestions.length - 1));
  }

  async function handleGenerateSwimRecommendation() {
    if (swimmingState.pendingFeedbackSession) {
      setSwimmingState((currentState) => ({
        ...currentState,
        error: "Tell us how your last swimming set went before generating another one.",
        successMessage: "",
      }));
      return;
    }

    setSwimmingState((currentState) => ({
      ...currentState,
      isGenerating: true,
      error: "",
      successMessage: "",
    }));

    try {
      const response = await generateSwimmingRecommendation(swimmingState.retryFeedback);
      setSwimmingState((currentState) => ({
        ...currentState,
        isGenerating: false,
        recommendation: response?.recommendation ?? null,
        successMessage: currentState.retryFeedback
          ? "Your next suggestion now reflects the feedback you entered."
          : "Your Bedrock swim suggestion is ready.",
      }));
    } catch (error) {
      setSwimmingState((currentState) => ({
        ...currentState,
        isGenerating: false,
        error: error instanceof Error ? error.message : "Unable to generate a swimming session right now.",
        successMessage: "",
      }));
    }
  }

  async function handleSaveSwimSession() {
    if (!swimmingState.recommendation) {
      return;
    }

    if (swimmingState.pendingFeedbackSession) {
      setSwimmingState((currentState) => ({
        ...currentState,
        error: "Tell us how your current planned swimming session went before saving another one.",
        successMessage: "",
      }));
      return;
    }

    setSwimmingState((currentState) => ({
      ...currentState,
      isSaving: true,
      error: "",
      successMessage: "",
    }));

    try {
      await saveSwimmingSession(swimmingState.recommendation);
      await loadSwimmingDashboard(session?.accessToken, false);
      setSwimmingState((currentState) => ({
        ...currentState,
        isSaving: false,
        recommendation: null,
        retryFeedback: "",
        shouldPromptPendingFeedback: false,
        successMessage: "Swimming set saved. Your follow-up feedback will shape the next recommendation.",
      }));
    } catch (error) {
      setSwimmingState((currentState) => ({
        ...currentState,
        isSaving: false,
        error: error instanceof Error ? error.message : "Unable to save this swimming session.",
        successMessage: "",
      }));
    }
  }

  async function handleSubmitSwimFeedback(outcome) {
    if (!swimmingState.pendingFeedbackSession?.sessionId) {
      return;
    }

    setSwimmingState((currentState) => ({
      ...currentState,
      isSubmittingFeedback: true,
      error: "",
      successMessage: "",
    }));

    try {
      await saveSwimmingSessionFeedback(
        swimmingState.pendingFeedbackSession.sessionId,
        outcome,
        swimmingState.followUpFeedback
      );
      await loadSwimmingDashboard(session?.accessToken, false);
      setSwimmingState((currentState) => ({
        ...currentState,
        isSubmittingFeedback: false,
        followUpFeedback: "",
        shouldPromptPendingFeedback: false,
        successMessage: "Feedback saved. Your next swim suggestion will take it into account.",
      }));
    } catch (error) {
      setSwimmingState((currentState) => ({
        ...currentState,
        isSubmittingFeedback: false,
        error: error instanceof Error ? error.message : "Unable to save your session feedback.",
        successMessage: "",
      }));
    }
  }

  async function handleResetSwimming() {
    const confirmed = window.confirm("Are you sure? This will reset your swimming questions, delete your saved swimming sessions, and forget the feedback used for future swim suggestions.");

    if (!confirmed) {
      return;
    }

    setSwimmingState((currentState) => ({
      ...currentState,
      isResetting: true,
      error: "",
      successMessage: "",
    }));

    try {
      await resetSwimmingSport();
      const nextAnswers = { ...answersBySport };
      delete nextAnswers.swimming;
      setAnswersBySport(nextAnswers);
      setSavedAnswersBySport(nextAnswers);
      writeStoredAnswers(nextAnswers);
      setSelectedSportId("");
      setResultsState((currentState) => ({
        ...currentState,
        updatedAt: new Date().toISOString(),
      }));
      setSwimmingState(EMPTY_SWIMMING_STATE);
    } catch (error) {
      setSwimmingState((currentState) => ({
        ...currentState,
        isResetting: false,
        error: error instanceof Error ? error.message : "Unable to reset swimming right now.",
        successMessage: "",
      }));
    }
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
                ? selectedSport.id === "swimming" && isSelectedSportComplete
                  ? "Review your saved swim sessions, answer follow-up feedback, and generate your next recommendation."
                  : supportsSessionRecommendations(selectedSport.id)
                    ? `Make your ${selectedSport.name.toLowerCase()} choice below. Your space stays private to your account.`
                    : `Save your ${selectedSport.name.toLowerCase()} questionnaire here. Session recommendations are currently available for Swimming only.`
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

      {!selectedSport && swimmingState.pendingFeedbackSession && swimmingState.shouldPromptPendingFeedback ? (
        <section className="session-card is-highlighted">
          <p className="question-number">Follow-up</p>
          <h3>How did your last swim set go?</h3>
          <p className="session-summary">
            {swimmingState.pendingFeedbackSession.recommendation?.title ?? "Your last planned swimming session"}
          </p>
          <textarea
            className="feedback-input"
            value={swimmingState.followUpFeedback}
            onChange={(event) => setSwimmingState((currentState) => ({
              ...currentState,
              followUpFeedback: event.target.value,
            }))}
            placeholder="Add any notes about how it felt, what worked, or what was tough."
          />
          <p className="status-banner is-muted">This feedback is saved with your session history so the next swim suggestion can improve.</p>
          <div className="question-actions">
            <button
              type="button"
              className="secondary-button"
              onClick={() => void handleSubmitSwimFeedback("did-not-do")}
              disabled={swimmingState.isSubmittingFeedback}
            >
              I didn&apos;t do it
            </button>
            <button
              type="button"
              onClick={() => void handleSubmitSwimFeedback("completed")}
              disabled={swimmingState.isSubmittingFeedback}
            >
              {swimmingState.isSubmittingFeedback ? "Saving feedback…" : "It went like this"}
            </button>
          </div>
        </section>
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
                  {sport.id === "swimming" && swimmingState.pendingFeedbackSession
                    ? "Tell us how your last swimming set went"
                    : answersBySport[sport.id]
                      ? supportsSessionRecommendations(sport.id) && isSportQuestionnaireComplete(sport.id, answersBySport)
                        ? "Questionnaire complete. Open your session space."
                        : !supportsSessionRecommendations(sport.id) && isSportQuestionnaireComplete(sport.id, answersBySport)
                          ? "Questionnaire complete. Saved for future recommendations."
                          : `${Object.keys(answersBySport[sport.id]).length} of ${(SPORT_QUESTIONS[sport.id] ?? []).length} questions answered`
                      : "No answers saved yet"}
                </p>
                <button type="button" onClick={() => handleSportSelect(sport.id)}>
                  {sport.id === "swimming" && isSportQuestionnaireComplete(sport.id, answersBySport)
                    ? "Open sessions"
                    : !supportsSessionRecommendations(sport.id) && isSportQuestionnaireComplete(sport.id, answersBySport)
                      ? "Review answers"
                      : `Open ${sport.name}`}
                </button>
              </div>
            </article>
          ))}
        </section>
      ) : isSwimmingDashboardVisible ? (
        <section className={`picker-card ${selectedSport.accent}`}>
          <div className="picker-header">
            <div>
              <p className="sport-kicker">{selectedSport.name}</p>
              <h2>Your session list</h2>
              <p>Generate a swim set, save the one you want to do next, and keep building from your previous sessions.</p>
            </div>
            <div className="button-row">
              <button type="button" className="secondary-button" onClick={handleSportBack}>
                Back to sports
              </button>
            </div>
          </div>

          {swimmingState.status === "loading" ? (
            <p className="status-banner is-muted">Loading your swimming sessions…</p>
          ) : null}

          {swimmingState.pendingFeedbackSession && swimmingState.shouldPromptPendingFeedback ? (
            <section className="session-card is-highlighted">
              <p className="question-number">Follow-up</p>
              <h3>How did your last swim set go?</h3>
              <p className="session-summary">
                {swimmingState.pendingFeedbackSession.recommendation?.title ?? "Your last planned swimming session"}
              </p>
              <textarea
                className="feedback-input"
                value={swimmingState.followUpFeedback}
                onChange={(event) => setSwimmingState((currentState) => ({
                  ...currentState,
                  followUpFeedback: event.target.value,
                }))}
                placeholder="Add any notes about how it felt, what worked, or what was tough."
              />
              <p className="status-banner is-muted">This feedback is saved with your session history so the next swim suggestion can improve.</p>
              <div className="question-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void handleSubmitSwimFeedback("did-not-do")}
                  disabled={swimmingState.isSubmittingFeedback}
                >
                  I didn&apos;t do it
                </button>
                <button
                  type="button"
                  onClick={() => void handleSubmitSwimFeedback("completed")}
                  disabled={swimmingState.isSubmittingFeedback}
                >
                  {swimmingState.isSubmittingFeedback ? "Saving feedback…" : "It went like this"}
                </button>
              </div>
            </section>
          ) : null}

          <section className="session-card">
            <div className="session-card-header">
              <div>
                <p className="question-number">Next suggestion</p>
                <h3>Build a swimming set for me</h3>
              </div>
              <button
                type="button"
                onClick={() => void handleGenerateSwimRecommendation()}
                disabled={swimmingState.isGenerating || swimmingState.isSaving || Boolean(swimmingState.pendingFeedbackSession)}
              >
                {swimmingState.isGenerating ? "Generating…" : swimmingState.recommendation ? "Try again" : "Suggest a swim set"}
              </button>
            </div>

            <textarea
              className="feedback-input"
              value={swimmingState.retryFeedback}
              onChange={(event) => setSwimmingState((currentState) => ({
                ...currentState,
                retryFeedback: event.target.value,
              }))}
              placeholder="Optional feedback for the next suggestion, for example: shorter main set, more technique, less freestyle."
            />
            <p className="status-banner is-muted">This feedback only affects the next generated suggestion. Resetting Swimming forgets saved session feedback as well.</p>

            {swimmingState.recommendation ? (
              <div className="session-plan">
                <div className="session-plan-header">
                  <div>
                    <h3>{swimmingState.recommendation.title}</h3>
                    <p className="session-summary">{swimmingState.recommendation.summary}</p>
                  </div>
                  <div className="session-chip-group">
                    <span className="session-chip">{swimmingState.recommendation.focus}</span>
                    <span className="session-chip">{swimmingState.recommendation.intensity}</span>
                    <span className="session-chip">{swimmingState.recommendation.totalDistance}m</span>
                  </div>
                </div>

                <p className="session-note"><strong>Why this set:</strong> {swimmingState.recommendation.rationale}</p>
                <p className="session-note"><strong>Variety:</strong> {swimmingState.recommendation.variationNote}</p>

                <div className="session-set-list">
                  {swimmingState.recommendation.sets.map((set) => (
                    <article key={set.id} className="session-set-item">
                      <div>
                        <p className="session-set-type">{set.type}</p>
                        <h4>{set.text}</h4>
                      </div>
                      <p>{set.total_distance}m {set.intensity ? `• ${set.intensity}` : ""}</p>
                    </article>
                  ))}
                </div>

                <ul className="session-coach-notes">
                  {swimmingState.recommendation.coachNotes.map((note) => (
                    <li key={note}>{note}</li>
                  ))}
                </ul>

                <div className="question-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setSwimmingState((currentState) => ({
                      ...currentState,
                      recommendation: null,
                    }))}
                    disabled={swimmingState.isSaving}
                  >
                    Clear suggestion
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSaveSwimSession()}
                    disabled={swimmingState.isSaving || Boolean(swimmingState.pendingFeedbackSession)}
                  >
                    {swimmingState.isSaving ? "Saving session…" : "Save as next activity"}
                  </button>
                </div>
              </div>
            ) : (
              <p className="status-banner is-muted">No suggestion yet. Generate one when you&apos;re ready.</p>
            )}
          </section>

          <section className="session-card">
            <div className="session-card-header">
              <div>
                <p className="question-number">History</p>
                <h3>Previous swimming sessions</h3>
              </div>
            </div>

            {swimmingState.sessions.length ? (
              <div className="session-history-list">
                {swimmingState.sessions.map((sessionEntry) => (
                  <article key={sessionEntry.sessionId} className="session-history-item">
                    <div className="session-history-top">
                      <div>
                        <h4>{sessionEntry.recommendation?.title ?? "Swimming session"}</h4>
                        <p>{new Date(sessionEntry.acceptedAt).toLocaleString()}</p>
                      </div>
                      <span className={`session-status is-${sessionEntry.status}`}>{formatSessionStatus(sessionEntry.status)}</span>
                    </div>
                    <p className="session-summary">{sessionEntry.recommendation?.summary}</p>
                    <p className="session-note">{sessionEntry.recommendation?.totalDistance ?? 0}m • {sessionEntry.recommendation?.focus ?? "general"}</p>
                    {sessionEntry.feedbackText ? (
                      <p className="session-note"><strong>Latest feedback:</strong> {sessionEntry.feedbackText}</p>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : (
              <p className="status-banner is-muted">No saved swimming sessions yet. Your first accepted recommendation will appear here.</p>
            )}
          </section>

          {swimmingState.error ? (
            <p className="status-banner is-error">{swimmingState.error}</p>
          ) : null}

          {swimmingState.successMessage ? (
            <p className="status-banner is-success">{swimmingState.successMessage}</p>
          ) : null}

          <div className="reset-row">
            <button
              type="button"
              className="secondary-button is-danger"
              onClick={() => void handleResetSwimming()}
              disabled={swimmingState.isResetting}
            >
              {swimmingState.isResetting ? "Resetting swimming…" : "Reset swimming"}
            </button>
          </div>
        </section>
      ) : (
        <section className={`picker-card ${selectedSport.accent}`}>
          <div className="picker-header">
            <div>
              <p className="sport-kicker">{selectedSport.name}</p>
              <h2>Answer your questions</h2>
              <p>Answer one question at a time. Your responses save automatically as you move through the flow.</p>
            </div>
            <div className="button-row">
              <button type="button" className="secondary-button" onClick={handleSportBack}>
                Back to sports
              </button>
            </div>
          </div>

          {currentQuestion ? (
            <section className="question-card">
              <p className="question-number">
                Q{activeQuestionIndex + 1} of {selectedQuestions.length}
              </p>
              <h3>{currentQuestion.prompt}</h3>

              <div className="choice-grid">
                {currentQuestion.options.map((option) => {
                  const isSelected = selectedResponses[currentQuestion.id] === option.id;

                  return (
                    <button
                      key={option.id}
                      type="button"
                      className={`choice-button ${isSelected ? "is-selected" : ""}`}
                      onClick={() => void handleAnswer(currentQuestion.id, option.id)}
                    >
                      <span>{option.id}</span>
                      <strong>{option.label}</strong>
                    </button>
                  );
                })}
              </div>

              <div className="question-actions">
                <button
                  type="button"
                  className="secondary-button"
                  onClick={handlePreviousQuestion}
                  disabled={activeQuestionIndex === 0}
                >
                  Previous
                </button>
                <button
                  type="button"
                  className="secondary-button"
                  onClick={handleNextQuestion}
                  disabled={activeQuestionIndex === selectedQuestions.length - 1}
                >
                  Next
                </button>
              </div>
            </section>
          ) : null}

          {isQuestionnaireComplete ? (
            <p className="status-banner is-success">
              {supportsSessionRecommendations(selectedSport.id)
                ? `All questions answered for ${selectedSport.name}. Your results are saved to your account.`
                : `All questions answered for ${selectedSport.name}. Your results are saved to your account for future recommendations.`}
            </p>
          ) : (
            <p className="status-banner is-muted">
              {answeredCount} of {selectedQuestions.length} questions answered so far.
            </p>
          )}

          {selectedSport.id === "water-polo" ? (
            <p className="status-banner is-muted">
              Water Polo answers save to your account now. Recommendation sessions are currently available for Swimming only.
            </p>
          ) : null}

          {resultsState.status === "saving" ? (
            <p className="status-banner is-muted">Saving your latest answer…</p>
          ) : null}

          {resultsState.status === "success" && resultsState.updatedAt ? (
            <p className="status-banner is-success">
              Saved to your account at {new Date(resultsState.updatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.
            </p>
          ) : null}

          {resultsState.status === "error" ? (
            <p className="status-banner is-error">{resultsState.error}</p>
          ) : null}

          <div className="progress-dock">
            <p className="progress-label">
              Progress: {answeredCount}/{selectedQuestions.length}
            </p>
            <div className="progress-track" aria-hidden="true">
              <span className="progress-fill" style={{ width: `${progressPercentage}%` }} />
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
