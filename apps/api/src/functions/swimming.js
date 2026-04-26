const {
  getUsernameFromEvent,
  loadQuestionnaireResults,
  saveQuestionnaireResults
} = require("./lib/questionnaire-store");
const {
  listSportSessions,
  resetSportSessions,
  saveAcceptedSession,
  updateSessionFeedback
} = require("./lib/swimming-session-store");
const {
  buildSwimmingRecommendation,
  summarizeAnswers
} = require("./lib/swim-recommendation");
const { loadSwimLibrary } = require("./lib/swim-library");

const jsonHeaders = {
  "content-type": "application/json"
};

const userPoolId = process.env.USER_POOL_ID;
const tableName = process.env.SPORTS_ACTIVITY_TABLE_NAME;
const bedrockModelId = process.env.BEDROCK_MODEL_ID;
const SWIMMING_SPORT_ID = "swimming";
const REQUIRED_QUESTION_IDS = ["current-level", "goal-level", "improvement-area"];
const MAX_FEEDBACK_LENGTH = 500;

function sanitizeOptionalText(value, maxLength) {
  if (typeof value !== "string") {
    return "";
  }

  return value.trim().slice(0, maxLength);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeRecommendationForPersistence(recommendation) {
  const librarySetMap = new Map(loadSwimLibrary().map((set) => [set.id, set]));

  if (!isPlainObject(recommendation)) {
    throw new Error("A valid swimming recommendation is required before saving a session.");
  }

  if (!Array.isArray(recommendation.sets) || recommendation.sets.length < 2 || recommendation.sets.length > 5) {
    throw new Error("A valid swimming recommendation is required before saving a session.");
  }

  if (!Array.isArray(recommendation.coachNotes) || recommendation.coachNotes.length < 2 || recommendation.coachNotes.length > 4) {
    throw new Error("Recommendation coach notes are invalid.");
  }

  const sanitizedRecommendation = {
    title: sanitizeOptionalText(recommendation.title, 280),
    summary: sanitizeOptionalText(recommendation.summary, 280),
    focus: sanitizeOptionalText(recommendation.focus, 80),
    intensity: sanitizeOptionalText(recommendation.intensity, 80),
    rationale: sanitizeOptionalText(recommendation.rationale, 280),
    variationNote: sanitizeOptionalText(recommendation.variationNote, 280),
    coachNotes: recommendation.coachNotes.map((note) => sanitizeOptionalText(note, 200)).filter(Boolean),
    totalDistance: Number.isFinite(recommendation.totalDistance) ? recommendation.totalDistance : 0,
    generatedAt: sanitizeOptionalText(recommendation.generatedAt, 80),
    sets: recommendation.sets.map((set) => {
      if (!isPlainObject(set) || typeof set.id !== "string" || !set.id.trim()) {
        throw new Error("Recommendation sets are invalid.");
      }

      const librarySet = librarySetMap.get(set.id.trim());

      if (!librarySet) {
        throw new Error("Recommendation sets are invalid.");
      }

      return {
        id: librarySet.id,
        text: sanitizeOptionalText(librarySet.text, 400),
        type: sanitizeOptionalText(librarySet.type, 80),
        total_distance: Number.isFinite(librarySet.total_distance) ? librarySet.total_distance : 0,
        intensity: sanitizeOptionalText(librarySet.intensity, 80),
        training_focus: Array.isArray(librarySet.training_focus) ? librarySet.training_focus.map((item) => sanitizeOptionalText(item, 80)).filter(Boolean) : []
      };
    })
  };

  if (!sanitizedRecommendation.title || !sanitizedRecommendation.summary || !sanitizedRecommendation.focus || !sanitizedRecommendation.intensity || !sanitizedRecommendation.rationale || !sanitizedRecommendation.variationNote) {
    throw new Error("Recommendation fields are invalid.");
  }

  if (sanitizedRecommendation.coachNotes.length < 2) {
    throw new Error("Recommendation coach notes are invalid.");
  }

  return sanitizedRecommendation;
}

function createResponse(statusCode, body) {
  return {
    statusCode,
    headers: jsonHeaders,
    body: JSON.stringify(body)
  };
}

function parseJsonBody(event) {
  if (!event?.body) {
    return {};
  }

  try {
    return JSON.parse(event.body);
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function isSwimmingQuestionnaireComplete(swimmingAnswers) {
  return REQUIRED_QUESTION_IDS.every((questionId) => typeof swimmingAnswers?.[questionId] === "string" && swimmingAnswers[questionId].trim());
}

async function buildSwimmingState(username) {
  const questionnaireResults = await loadQuestionnaireResults(userPoolId, username);
  const swimmingAnswers = questionnaireResults.answersBySport?.[SWIMMING_SPORT_ID] ?? {};
  const questionnaireComplete = isSwimmingQuestionnaireComplete(swimmingAnswers);
  const sessions = await listSportSessions(tableName, username, SWIMMING_SPORT_ID);
  const pendingFeedbackSession = sessions.find((session) => session.status === "planned") ?? null;

  return {
    questionnaireAnswers: swimmingAnswers,
    questionnaireComplete,
    answerSummary: questionnaireComplete ? summarizeAnswers(swimmingAnswers) : null,
    sessions,
    pendingFeedbackSession
  };
}

async function handleGetState(username) {
  return createResponse(200, await buildSwimmingState(username));
}

async function handleGenerateRecommendation(username, event) {
  const swimState = await buildSwimmingState(username);

  if (!swimState.questionnaireComplete) {
    return createResponse(400, {
      message: "Complete the swimming questionnaire before requesting a recommendation."
    });
  }

  if (swimState.pendingFeedbackSession) {
    return createResponse(409, {
      message: "Submit feedback for your last planned swimming session before generating another one."
    });
  }

  const requestBody = parseJsonBody(event);
  const recommendation = await buildSwimmingRecommendation({
    modelId: bedrockModelId,
    swimmingAnswers: swimState.questionnaireAnswers,
    sessions: swimState.sessions,
    retryFeedback: sanitizeOptionalText(requestBody.feedback, MAX_FEEDBACK_LENGTH)
  });

  return createResponse(200, {
    recommendation
  });
}

async function handleAcceptRecommendation(username, event) {
  const requestBody = parseJsonBody(event);
  const recommendation = sanitizeRecommendationForPersistence(requestBody.recommendation);
  const swimState = await buildSwimmingState(username);

  if (!swimState.questionnaireComplete) {
    return createResponse(400, {
      message: "Complete the swimming questionnaire before saving a session."
    });
  }

  if (swimState.pendingFeedbackSession) {
    return createResponse(409, {
      message: "Submit feedback for your current planned swimming session before saving another one."
    });
  }

  const savedSession = await saveAcceptedSession(
    tableName,
    username,
    SWIMMING_SPORT_ID,
    recommendation,
    swimState.questionnaireAnswers
  );

  return createResponse(200, {
    session: savedSession
  });
}

async function handleSubmitFeedback(username, event) {
  const sessionId = event?.pathParameters?.sessionId;
  const requestBody = parseJsonBody(event);
  const outcome = requestBody.outcome;
  const feedbackText = sanitizeOptionalText(requestBody.feedbackText, MAX_FEEDBACK_LENGTH);

  if (!sessionId) {
    return createResponse(400, {
      message: "Session ID is required."
    });
  }

  if (!["completed", "did-not-do"].includes(outcome)) {
    return createResponse(400, {
      message: "Outcome must be either 'completed' or 'did-not-do'."
    });
  }

  const updatedSession = await updateSessionFeedback(
    tableName,
    username,
    SWIMMING_SPORT_ID,
    sessionId,
    outcome,
    feedbackText
  );

  if (updatedSession.status === "not_found") {
    return createResponse(404, {
      message: "Session not found."
    });
  }

  if (updatedSession.status === "not_pending") {
    return createResponse(409, {
      message: "Only your current planned swimming session can accept follow-up feedback."
    });
  }

  return createResponse(200, {
    session: updatedSession.session
  });
}

async function handleResetSport(username) {
  const questionnaireResults = await loadQuestionnaireResults(userPoolId, username);
  const nextAnswersBySport = { ...(questionnaireResults.answersBySport ?? {}) };
  delete nextAnswersBySport[SWIMMING_SPORT_ID];

  await resetSportSessions(tableName, username, SWIMMING_SPORT_ID);
  await saveQuestionnaireResults(userPoolId, username, nextAnswersBySport, questionnaireResults);

  return createResponse(200, {
    sportId: SWIMMING_SPORT_ID,
    reset: true
  });
}

exports.handler = async (event) => {
  if (!userPoolId || !tableName || !bedrockModelId) {
    return createResponse(500, {
      message: "Swimming service is not configured."
    });
  }

  const username = getUsernameFromEvent(event);

  if (!username) {
    return createResponse(401, {
      message: "Unauthorized"
    });
  }

  const method = event?.requestContext?.http?.method;
  const routeKey = event?.routeKey;

  try {
    if (method === "GET") {
      return await handleGetState(username);
    }

    if (method === "POST" && routeKey?.includes("/sports/swimming/recommendation")) {
      return await handleGenerateRecommendation(username, event);
    }

    if (method === "POST" && routeKey?.includes("/sports/swimming/sessions")) {
      return await handleAcceptRecommendation(username, event);
    }

    if (method === "PUT") {
      return await handleSubmitFeedback(username, event);
    }

    if (method === "DELETE") {
      return await handleResetSport(username);
    }

    return createResponse(405, {
      message: "Method not allowed"
    });
  } catch (error) {
    if (error instanceof Error && (error.message.includes("Request body") || error.message.includes("must be") || error.message.includes("too large") || error.message.includes("valid JSON") || error.message.includes("required before saving") || error.message.includes("invalid") || error.message.includes("before generating another one") || error.message.includes("before saving another one") || error.message.includes("valid swimming recommendation"))) {
      return createResponse(400, {
        message: error.message
      });
    }

    return createResponse(500, {
      message: "Unable to process swimming request."
    });
  }
};
